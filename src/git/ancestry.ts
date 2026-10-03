// Where a task's work starts from. A fork begins at one commit of the main
// branch; when its agent merges or rebases onto a later one, the work is to be
// compared with that later commit instead.

export interface CommitReader {
  readCommit(oid: string): Promise<{ oid: string; parents: string[] } | null>;
}

const MAX_COMMITS_READ = 500;

// The newest commit of the main branch that `head` contains, or null if it
// contains none. `mainNewestFirst` is the main branch's own history. Only the
// fork's commits are read: the search stops at every commit of main it meets.
export async function newestMainAncestor(
  reader: CommitReader,
  head: string,
  mainNewestFirst: string[],
  maxCommitsRead = MAX_COMMITS_READ,
): Promise<string | null> {
  const age = new Map(mainNewestFirst.map((oid, index) => [oid, index]));
  const seen = new Set<string>([head]);
  const queue = [head];
  let newest: number | null = null;
  let read = 0;

  while (queue.length > 0) {
    const oid = queue.shift()!;
    const onMain = age.get(oid);
    if (onMain !== undefined) {
      newest = newest === null ? onMain : Math.min(newest, onMain);
      continue;
    }
    if (read >= maxCommitsRead) {
      return null;
    }
    read++;
    const commit = await reader.readCommit(oid);
    for (const parent of commit?.parents ?? []) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return newest === null ? null : mainNewestFirst[newest]!;
}
