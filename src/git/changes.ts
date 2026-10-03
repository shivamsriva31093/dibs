// Computes which paths differ between two git trees by walking both and
// skipping every subtree whose id is the same on both sides.

import { normalizeMode, TREE_MODE, type TreeEntry } from "./objects";

export interface TreeReader {
  // The immediate children of a tree, or null if the tree does not exist.
  readTree(oid: string): Promise<TreeEntry[] | null>;
}

// A non-directory tree entry: a file, an executable, a symlink or a submodule link.
export interface Leaf {
  mode: string;
  oid: string;
}

export interface Change {
  path: string;
  status: "added" | "modified" | "deleted";
  base: Leaf | null;
  head: Leaf | null;
}

export function isTreeEntry(entry: TreeEntry): boolean {
  return normalizeMode(entry.mode) === TREE_MODE;
}

export function leafOf(entry: TreeEntry | undefined): Leaf | null {
  if (entry === undefined || isTreeEntry(entry)) {
    return null;
  }
  return { mode: normalizeMode(entry.mode), oid: entry.oid };
}

export function sameLeaf(a: Leaf | null, b: Leaf | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.oid === b.oid && a.mode === b.mode;
}

export async function readTreeOrThrow(reader: TreeReader, oid: string): Promise<Map<string, TreeEntry>> {
  const entries = await reader.readTree(oid);
  if (entries === null) {
    throw new Error(`git tree ${oid} does not exist`);
  }
  return new Map(entries.map((entry) => [entry.name, entry]));
}

async function walk(
  reader: TreeReader,
  baseOid: string | null,
  headOid: string | null,
  prefix: string,
  out: Change[],
): Promise<void> {
  if (baseOid === headOid) {
    return;
  }
  const [base, head] = await Promise.all([
    baseOid === null ? new Map<string, TreeEntry>() : readTreeOrThrow(reader, baseOid),
    headOid === null ? new Map<string, TreeEntry>() : readTreeOrThrow(reader, headOid),
  ]);

  for (const name of new Set([...base.keys(), ...head.keys()])) {
    const baseEntry = base.get(name);
    const headEntry = head.get(name);
    const path = prefix + name;

    const baseLeaf = leafOf(baseEntry);
    const headLeaf = leafOf(headEntry);
    if (baseLeaf === null && headLeaf !== null) {
      out.push({ path, status: "added", base: null, head: headLeaf });
    } else if (baseLeaf !== null && headLeaf === null) {
      out.push({ path, status: "deleted", base: baseLeaf, head: null });
    } else if (baseLeaf !== null && headLeaf !== null && !sameLeaf(baseLeaf, headLeaf)) {
      out.push({ path, status: "modified", base: baseLeaf, head: headLeaf });
    }

    // A name can be a file on one side and a directory on the other, so the
    // directory part is handled separately from the file part above.
    const baseTree = baseEntry !== undefined && isTreeEntry(baseEntry) ? baseEntry.oid : null;
    const headTree = headEntry !== undefined && isTreeEntry(headEntry) ? headEntry.oid : null;
    if (baseTree !== null || headTree !== null) {
      await walk(reader, baseTree, headTree, `${path}/`, out);
    }
  }
}

export async function diffTrees(reader: TreeReader, baseTree: string, headTree: string): Promise<Change[]> {
  const out: Change[] = [];
  await walk(reader, baseTree, headTree, "", out);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
