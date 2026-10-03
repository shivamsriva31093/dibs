// Reads a repository for the interface index: all of it when a repository is
// registered, the files of one change when the change lands, and, for a review,
// what a submission does to interfaces and what it is built on.
//
// Everything is read through the repository host one directory or file at a
// time, and each one only once.

import type { BlobReader } from "../diff";
import { isTreeEntry, readTreeOrThrow, type Change, type TreeReader } from "../git/changes";
import type { TreeEntry } from "../git/objects";
import type { InterfaceReport } from "../types";
import { diffInterfaces } from "./diff";
import { extract, isIndexable, type Extracted } from "./extract";
import { fileDigest, indexFile, type IndexedFile } from "./file";
import { importCandidates } from "./resolve";
import { signatureHash } from "./signature";

export interface RepoReader extends TreeReader, BlobReader {}

const FILE_MODES = ["100644", "100755"];
// A file with a zero byte near its start is taken to be binary, as git does.
const BINARY_PROBE_BYTES = 8000;
// How far a name is followed through files that pass it on.
const MAX_HOPS = 6;
// The most files read when a whole repository is indexed in one go.
const MAX_FILES = 400;

const isFile = (entry: TreeEntry) => FILE_MODES.includes(entry.mode.padStart(6, "0"));
const byPath = <T extends { path: string }>(a: T, b: T) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

// One tree, with every directory read at most once.
class TreeView {
  private readonly trees = new Map<string, Promise<Map<string, TreeEntry>>>();
  private readonly texts = new Map<string, Promise<string | null>>();
  private readonly extractions = new Map<string, Promise<Extracted | null>>();

  constructor(
    private readonly repo: RepoReader,
    private readonly root: string,
  ) {}

  private children(oid: string): Promise<Map<string, TreeEntry>> {
    let pending = this.trees.get(oid);
    if (pending === undefined) {
      pending = readTreeOrThrow(this.repo, oid);
      this.trees.set(oid, pending);
    }
    return pending;
  }

  // The id of the file at a path, or null if no file is there.
  async file(path: string): Promise<string | null> {
    const segments = path.split("/");
    let tree = this.root;
    for (const [index, segment] of segments.entries()) {
      const entry = (await this.children(tree)).get(segment);
      if (entry === undefined) {
        return null;
      }
      if (index === segments.length - 1) {
        return isFile(entry) ? entry.oid : null;
      }
      if (!isTreeEntry(entry)) {
        return null;
      }
      tree = entry.oid;
    }
    return null;
  }

  // Every file of the tree, in order of path.
  async files(): Promise<{ path: string; oid: string }[]> {
    const found: { path: string; oid: string }[] = [];
    const walk = async (oid: string, prefix: string): Promise<void> => {
      for (const entry of (await this.children(oid)).values()) {
        if (isTreeEntry(entry)) {
          await walk(entry.oid, `${prefix}${entry.name}/`);
        } else if (isFile(entry)) {
          found.push({ path: `${prefix}${entry.name}`, oid: entry.oid });
        }
      }
    };
    await walk(this.root, "");
    return found.sort(byPath);
  }

  // The text of a file dibs can read for the index, or null if it is not one.
  text(path: string, oid: string): Promise<string | null> {
    let pending = this.texts.get(oid);
    if (pending === undefined) {
      pending = this.repo.readBlob(oid).then((bytes) => {
        if (bytes === null || !isIndexable(path, bytes.length) || bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
          return null;
        }
        return new TextDecoder().decode(bytes);
      });
      this.texts.set(oid, pending);
    }
    return pending;
  }

  // What the file at a path offers and uses, or null if there is no such file or dibs cannot read it.
  extracted(path: string): Promise<Extracted | null> {
    let pending = this.extractions.get(path);
    if (pending === undefined) {
      pending = (async () => {
        const oid = isIndexable(path, 0) ? await this.file(path) : null;
        const text = oid === null ? null : await this.text(path, oid);
        return text === null ? null : extract(path, text);
      })();
      this.extractions.set(path, pending);
    }
    return pending;
  }

  // The file an import means, or null if it means none of this tree.
  async resolve(fromPath: string, specifier: string): Promise<string | null> {
    for (const candidate of importCandidates(fromPath, specifier)) {
      if ((await this.file(candidate)) !== null) {
        return candidate;
      }
    }
    return null;
  }

  // The index record of a file, or null if it is not a file dibs can read.
  async record(path: string, exists?: (path: string) => boolean): Promise<IndexedFile | null> {
    const oid = isIndexable(path, 0) ? await this.file(path) : null;
    const text = oid === null ? null : await this.text(path, oid);
    const extracted = text === null ? null : await this.extracted(path);
    if (text === null || extracted === null) {
      return null;
    }
    let known = exists;
    if (known === undefined) {
      // Only the paths an import could mean are looked up, so a large tree is not read for one file.
      const there = new Set<string>();
      for (const used of extracted.imports) {
        const target = await this.resolve(path, used.specifier);
        if (target !== null) {
          there.add(target);
        }
      }
      known = (candidate) => there.has(candidate);
    }
    return indexFile(path, text, known);
  }

  // Where a name used from a file is declared, and its signature there. The signature is null
  // when the name cannot be found.
  async origin(path: string, name: string, hops = 0, seen = new Set<string>()): Promise<{ path: string; name: string; signature: string | null }> {
    const nowhere = { path, name, signature: null };
    const key = `${path}\0${name}`;
    if (hops > MAX_HOPS || seen.has(key)) {
      return nowhere;
    }
    seen.add(key);
    const extracted = await this.extracted(path);
    if (extracted === null) {
      return nowhere;
    }
    const own = extracted.interfaces.find((entry) => entry.name === name);
    if (own !== undefined) {
      if (own.from !== undefined && own.from.name !== "*") {
        const source = await this.resolve(path, own.from.specifier);
        if (source !== null) {
          return this.origin(source, own.from.name, hops + 1, seen);
        }
      }
      return { path, name, signature: own.signature };
    }
    for (const passed of extracted.imports) {
      if (passed.via !== "reexport" || !passed.names.includes("*")) {
        continue;
      }
      const source = await this.resolve(path, passed.specifier);
      const found = source === null ? null : await this.origin(source, name, hops + 1, seen);
      if (found !== null && found.signature !== null) {
        return found;
      }
    }
    return nowhere;
  }

  // One hash over all the interfaces of a file, or null if dibs cannot read it.
  async digest(path: string): Promise<string | null> {
    const extracted = await this.extracted(path);
    if (extracted === null) {
      return null;
    }
    const hashed = await Promise.all(
      extracted.interfaces.map(async (entry) => ({ name: entry.name, hash: await signatureHash(entry.signature) })),
    );
    return fileDigest(hashed);
  }
}

// Reads a whole tree for the index, up to a number of files.
export async function indexTree(
  repo: RepoReader,
  rootTree: string,
  options: { maxFiles?: number } = {},
): Promise<{ files: IndexedFile[]; total: number; skipped: number }> {
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const view = new TreeView(repo, rootTree);
  const all = await view.files();
  const paths = new Set(all.map((file) => file.path));
  const candidates = all.filter((file) => isIndexable(file.path, 0));

  const files: IndexedFile[] = [];
  let read = 0;
  for (; read < candidates.length && files.length < maxFiles; read++) {
    const record = await view.record(candidates[read]!.path, (path) => paths.has(path));
    if (record !== null) {
      files.push(record);
    }
  }
  return { files, total: all.length, skipped: candidates.length - read };
}

// Reads some paths of a tree for the index. A path that is not a file dibs can read there is
// reported as removed, so that the index forgets what it held for it.
export async function indexPaths(repo: RepoReader, rootTree: string, paths: string[]): Promise<{ files: IndexedFile[]; removed: string[] }> {
  const view = new TreeView(repo, rootTree);
  const files: IndexedFile[] = [];
  const removed: string[] = [];
  for (const path of paths) {
    const record = await view.record(path);
    if (record === null) {
      removed.push(path);
    } else {
      files.push(record);
    }
  }
  return { files, removed };
}

// What a submission does to interfaces, and what it is built on. `relies` is what the task's
// scope already says it relies on; what the changed files use is added to it. Every hash is
// taken at the base, because that is the code the submission was written against.
export async function interfaceReport(
  repo: RepoReader,
  baseTree: string,
  headTree: string,
  changes: Change[],
  relies: string[],
): Promise<InterfaceReport> {
  const base = new TreeView(repo, baseTree);
  const head = new TreeView(repo, headTree);
  const changedPaths = changes.map((change) => change.path);
  const isChanged = new Set(changedPaths);

  const changed: InterfaceReport["changed"] = [];
  const uses: { path: string; name: string }[] = [];
  for (const change of changes) {
    if (!isIndexable(change.path, 0)) {
      continue;
    }
    const before = change.base === null ? null : await base.extracted(change.path);
    const after = change.head === null ? null : await head.extracted(change.path);
    for (const difference of diffInterfaces(before, after)) {
      changed.push({ path: change.path, ...difference });
    }
    for (const used of after?.imports ?? []) {
      const target = await head.resolve(change.path, used.specifier);
      if (target !== null) {
        uses.push(...used.names.map((name) => ({ path: target, name })));
      }
    }
  }

  const relied = new Map<string, string | null>();
  // A whole file is compared by one hash over its interfaces; one interface by the hash of its signature.
  const rely = async (path: string, name: string | null): Promise<void> => {
    if (name === null || name === "*") {
      if (!isChanged.has(path) && !path.endsWith("/")) {
        relied.set(path, await base.digest(path));
      }
      return;
    }
    const origin = await base.origin(path, name);
    if (!isChanged.has(origin.path)) {
      relied.set(`${origin.path}#${origin.name}`, origin.signature === null ? null : await signatureHash(origin.signature));
    }
  };
  for (const used of uses) {
    await rely(used.path, used.name);
  }
  for (const target of relies) {
    const hash = target.indexOf("#");
    if (target.startsWith("route:")) {
      continue;
    }
    await rely(hash === -1 ? target : target.slice(0, hash), hash === -1 ? null : target.slice(hash + 1));
  }

  return {
    changedPaths,
    changed: changed.sort((a, b) => byPath(a, b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    relied: [...relied.entries()].map(([target, hash]) => ({ target, hash })).sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0)),
  };
}
