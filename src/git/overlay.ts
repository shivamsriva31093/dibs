// Applies a task's changes on top of the current main tree without a three-way
// merge of trees. A path the task holds to change is its alone, so on main it must
// still look as it did when the task forked (apply the change), or already look
// as the task left it (nothing to do). Anything else means the claim lapsed and
// someone else changed the path: the change is stale.
//
// A path the task holds to add to may have been added to by other tasks too.
// For such a path, `compose` is asked to join the two; only if it cannot is the
// change stale.

import { isTreeEntry, leafOf, readTreeOrThrow, sameLeaf, type Change, type Leaf, type TreeReader } from "./changes";
import { encodeTree, makeObject, TREE_MODE, type GitObject, type TreeEntry } from "./objects";

export type StalePath = {
  path: string;
  reason: string;
};

export type OverlayResult =
  | {
      ok: true;
      rootTree: string;
      // The tree objects that main does not have yet.
      trees: GitObject[];
      // The changes that were not on main already. A joined path's `head` is what was joined.
      applied: Change[];
      // The paths that were joined with what main holds.
      composed: string[];
      alreadyApplied: boolean;
    }
  | { ok: false; stale: StalePath[] };

interface Node {
  change?: Change;
  children: Map<string, Node>;
}

function buildTrie(changes: Change[]): Node {
  const root: Node = { children: new Map() };
  for (const change of changes) {
    let node = root;
    for (const segment of change.path.split("/")) {
      let next = node.children.get(segment);
      if (next === undefined) {
        next = { children: new Map() };
        node.children.set(segment, next);
      }
      node = next;
    }
    node.change = change;
  }
  return root;
}

const byPath = <T extends { path: string }>(a: T, b: T) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

// Joins a change to a path with what main holds there, or answers null if the two cannot be joined.
export type Compose = (change: Change, onMain: Leaf) => Promise<Leaf | null>;

export async function overlayChanges(
  reader: TreeReader,
  mainRootTree: string,
  changes: Change[],
  compose?: Compose,
): Promise<OverlayResult> {
  const trees: GitObject[] = [];
  const applied: Change[] = [];
  const composed: string[] = [];
  const stale: StalePath[] = [];

  // Returns the id of the rewritten tree, or null if the tree ends up empty.
  async function rewrite(treeOid: string | null, node: Node, prefix: string): Promise<string | null> {
    const entries = treeOid === null ? new Map<string, TreeEntry>() : await readTreeOrThrow(reader, treeOid);

    for (const [name, child] of node.children) {
      const path = prefix + name;
      const current = entries.get(name);

      // The directory part of this name: changes to paths underneath it.
      let subtree = current !== undefined && isTreeEntry(current) ? current.oid : null;
      if (child.children.size > 0) {
        subtree = await rewrite(subtree, child, `${path}/`);
      }

      // The file part of this name: a change to the path itself.
      let leaf: Leaf | null = leafOf(current);
      if (child.change !== undefined) {
        if (sameLeaf(leaf, child.change.base)) {
          leaf = child.change.head;
          applied.push(child.change);
        } else if (!sameLeaf(leaf, child.change.head)) {
          // Only a file both sides kept can be joined: not one the task added, removed, or that main removed.
          const joined =
            compose !== undefined && leaf !== null && child.change.base !== null && child.change.head !== null
              ? await compose(child.change, leaf)
              : null;
          if (joined === null) {
            stale.push({ path, reason: "changed on main since the task started" });
          } else {
            leaf = joined;
            applied.push({ ...child.change, head: joined });
            composed.push(path);
          }
        }
      }

      if (leaf !== null && subtree !== null) {
        stale.push({ path, reason: "would be both a file and a directory" });
      } else if (leaf !== null) {
        entries.set(name, { name, mode: leaf.mode, oid: leaf.oid });
      } else if (subtree !== null) {
        entries.set(name, { name, mode: TREE_MODE, oid: subtree });
      } else {
        entries.delete(name);
      }
    }

    if (entries.size === 0) {
      return null;
    }
    const tree = await makeObject("tree", encodeTree([...entries.values()]));
    if (tree.oid !== treeOid) {
      trees.push(tree);
    }
    return tree.oid;
  }

  let rootTree = await rewrite(mainRootTree, buildTrie(changes), "");
  if (stale.length > 0) {
    return { ok: false, stale: stale.sort(byPath) };
  }
  if (rootTree === null) {
    const empty = await makeObject("tree", encodeTree([]));
    rootTree = empty.oid;
    if (rootTree !== mainRootTree) {
      trees.push(empty);
    }
  }

  return {
    ok: true,
    rootTree,
    trees,
    applied: applied.sort(byPath),
    composed: composed.sort(),
    alreadyApplied: changes.length > 0 && applied.length === 0,
  };
}
