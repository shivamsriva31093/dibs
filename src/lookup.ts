// Lets the reviewer look at the repository as it is at a submitted commit: read
// one file, or find a piece of text across the files. Everything is read through
// the repository host, one directory or file at a time and each one only once,
// and every answer is plain text that can be handed to a model as it is.

import type { BlobReader } from "./diff";
import { TREE_MODE, type TreeEntry } from "./git/objects";
import type { TreeReader } from "./git/changes";

export interface RepoLookup {
  readFile(path: string): Promise<string>;
  search(text: string): Promise<string>;
}

export interface LookupLimits {
  // The most of one file that is returned.
  maxFileBytes: number;
  // The most matching lines a search returns.
  maxHits: number;
  // The most files a search reads.
  maxFilesSearched: number;
}

const DEFAULT_LIMITS: LookupLimits = { maxFileBytes: 60_000, maxHits: 60, maxFilesSearched: 400 };
const GITLINK_MODE = "160000";
const MAX_LINE_LENGTH = 240;
// A file with a zero byte near its start is taken to be binary, as git does.
const BINARY_PROBE_BYTES = 8000;

type File = { bytes: Uint8Array; binary: boolean };

const byName = (a: TreeEntry, b: TreeEntry) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const isTree = (entry: TreeEntry) => entry.mode === TREE_MODE;
const listing = (entries: TreeEntry[]) => entries.map((entry) => (isTree(entry) ? `${entry.name}/` : entry.name)).join(", ");

function numbered(text: string): string {
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.map((line, index) => `${index + 1}\t${line}`).join("\n");
}

export function repoLookup(repo: TreeReader & BlobReader, rootTree: string, limits: Partial<LookupLimits> = {}): RepoLookup {
  const { maxFileBytes, maxHits, maxFilesSearched } = { ...DEFAULT_LIMITS, ...limits };
  const trees = new Map<string, Promise<TreeEntry[]>>();
  const files = new Map<string, Promise<File | null>>();
  const decoder = new TextDecoder();

  const children = (oid: string): Promise<TreeEntry[]> => {
    let pending = trees.get(oid);
    if (pending === undefined) {
      pending = repo.readTree(oid).then((entries) => [...(entries ?? [])].sort(byName));
      trees.set(oid, pending);
    }
    return pending;
  };

  const file = (oid: string): Promise<File | null> => {
    let pending = files.get(oid);
    if (pending === undefined) {
      pending = repo
        .readBlob(oid)
        .then((bytes) => (bytes === null ? null : { bytes, binary: bytes.subarray(0, BINARY_PROBE_BYTES).includes(0) }));
      files.set(oid, pending);
    }
    return pending;
  };

  // Every file of the repository, in path order.
  const allFiles = async (): Promise<{ path: string; oid: string }[]> => {
    const found: { path: string; oid: string }[] = [];
    const walk = async (oid: string, prefix: string): Promise<void> => {
      for (const entry of await children(oid)) {
        if (isTree(entry)) {
          await walk(entry.oid, `${prefix}${entry.name}/`);
        } else if (entry.mode !== GITLINK_MODE) {
          found.push({ path: `${prefix}${entry.name}`, oid: entry.oid });
        }
      }
    };
    await walk(rootTree, "");
    return found;
  };

  return {
    async readFile(given) {
      const path = given
        .trim()
        .replace(/^\.?\/+/, "")
        .replace(/\/+$/, "");
      const segments = path === "" ? [] : path.split("/");

      let entries = await children(rootTree);
      let within = "";
      for (const [index, segment] of segments.entries()) {
        const entry = entries.find((candidate) => candidate.name === segment);
        const last = index === segments.length - 1;
        if (entry === undefined || (!last && !isTree(entry)) || entry.mode === GITLINK_MODE) {
          const where = within === "" ? "The repository root" : within;
          return `There is no file ${path}. ${where} holds: ${listing(entries)}`;
        }
        if (isTree(entry)) {
          within += `${segment}/`;
          entries = await children(entry.oid);
          continue;
        }

        const found = await file(entry.oid);
        if (found === null) {
          return `The content of ${path} is missing from the repository.`;
        }
        if (found.binary) {
          return `${path} is a binary file of ${found.bytes.length} bytes.`;
        }
        if (found.bytes.length > maxFileBytes) {
          return (
            `${numbered(decoder.decode(found.bytes.subarray(0, maxFileBytes)))}\n` +
            `(cut: the file has ${found.bytes.length} bytes; the first ${maxFileBytes} are shown)`
          );
        }
        return numbered(decoder.decode(found.bytes));
      }
      return `${within === "" ? "The repository root" : within} is a directory. It holds: ${listing(entries)}`;
    },

    async search(given) {
      const text = given.trim();
      if (text === "") {
        return "Give the text to look for.";
      }
      const every = await allFiles();
      const searched = every.slice(0, maxFilesSearched);
      const hits: string[] = [];
      let more = false;

      search: for (const { path, oid } of searched) {
        const found = await file(oid);
        if (found === null || found.binary) {
          continue;
        }
        for (const [index, line] of decoder.decode(found.bytes).split("\n").entries()) {
          if (!line.includes(text)) {
            continue;
          }
          if (hits.length === maxHits) {
            more = true;
            break search;
          }
          hits.push(`${path}:${index + 1}: ${line.trim().slice(0, MAX_LINE_LENGTH)}`);
        }
      }

      const partial = every.length > searched.length;
      if (hits.length === 0) {
        return partial
          ? `No line in the first ${searched.length} files contains ${JSON.stringify(text)}. The repository has ${every.length} files; the rest were not searched.`
          : `No line in the repository contains ${JSON.stringify(text)}.`;
      }
      if (more) {
        hits.push(`(cut: only the first ${maxHits} matches are shown)`);
      } else if (partial) {
        hits.push(`(only the first ${searched.length} of ${every.length} files were searched)`);
      }
      return hits.join("\n");
    },
  };
}
