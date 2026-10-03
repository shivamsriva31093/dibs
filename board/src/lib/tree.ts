// Turns what the live tasks hold into rows of a path tree: the repository's contested ground.
// A file that several tasks add to is one row with all of them; an interface a task holds is a
// row under its file. What a task only relies on is not ground it holds, and is left out.

import type { BoardTask } from "../../../src/types";

// A claim that was refused, shown for a while against the path that blocked it.
export interface Refusal {
  id: number;
  agent: string;
  goal: string;
  requested: string[];
  blockedBy: { taskId: string; agent: string; paths: string[] }[];
  at: number;
}

export interface ClaimRow {
  // The full target of this row: a path, or an interface written path#name.
  path: string;
  // The part of the path shown at this depth.
  label: string;
  depth: number;
  // The task that holds this, or null for a directory that only groups what is held. Where
  // several tasks add to one file, this is the one that started first.
  holder: BoardTask | null;
  // How it is held: to change, or to add to.
  relation: "change" | "add" | null;
  // The other tasks that add to the same file.
  sharers: BoardTask[];
  // Whether this is the first row of its holder, where what is said once about a task is shown.
  first: boolean;
  refusals: Refusal[];
}

const LIVE = new Set(["active", "in_review", "escalated"]);

interface Node {
  label: string;
  path: string;
  holders: { task: BoardTask; relation: "change" | "add" }[];
  children: Map<string, Node>;
}

// "src/db/users.ts" -> ["src/", "db/", "users.ts"]; a directory keeps its trailing slash.
// "src/db/users.ts#findUser" -> ["src/", "db/", "users.ts", "#findUser"].
function segments(target: string): string[] {
  if (target.startsWith("route:")) {
    return [target];
  }
  const hash = target.indexOf("#");
  const path = hash === -1 ? target : target.slice(0, hash);
  const parts = path.split("/");
  const isDirectory = parts[parts.length - 1] === "";
  const names = parts.filter((part) => part !== "");
  const out = names.map((name, index) => (index < names.length - 1 || isDirectory ? `${name}/` : name));
  return hash === -1 ? out : [...out, target.slice(hash)];
}

export function buildClaimRows(tasks: BoardTask[], refusals: Refusal[]): ClaimRow[] {
  const root: Node = { label: "", path: "", holders: [], children: new Map() };
  for (const task of tasks) {
    if (!LIVE.has(task.state)) {
      continue;
    }
    for (const entry of task.scope) {
      if (entry.relation === "rely") {
        continue;
      }
      let node = root;
      for (const segment of segments(entry.target)) {
        let next = node.children.get(segment);
        if (next === undefined) {
          next = { label: segment, path: node.path + segment, holders: [], children: new Map() };
          node.children.set(segment, next);
        }
        node = next;
      }
      node.holders.push({ task, relation: entry.relation });
    }
  }

  const rows: ClaimRow[] = [];
  // A request can be blocked by several paths of one task. It is shown once, against the first of them.
  const shown = new Set<number>();
  const seen = new Set<string>();
  const visit = (node: Node, depth: number): void => {
    // A directory that holds nothing itself and has one thing in it is folded into that thing.
    let current = node;
    let label = node.label;
    while (current.holders.length === 0 && current.children.size === 1) {
      current = [...current.children.values()][0]!;
      label += current.label;
    }
    const [first, ...others] = current.holders;
    const ids = current.holders.map((held) => held.task.id);
    const blockedHere = refusals.filter(
      (refusal) =>
        !shown.has(refusal.id) &&
        refusal.blockedBy.some((blocker) => ids.includes(blocker.taskId) && blocker.paths.includes(current.path)),
    );
    for (const refusal of blockedHere) {
      shown.add(refusal.id);
    }
    const holder = first?.task ?? null;
    rows.push({
      path: current.path,
      label,
      depth,
      holder,
      relation: first?.relation ?? null,
      sharers: others.map((held) => held.task),
      first: holder !== null && !seen.has(holder.id),
      refusals: blockedHere,
    });
    if (holder !== null) {
      seen.add(holder.id);
    }
    for (const child of sorted(current)) {
      visit(child, depth + 1);
    }
  };
  for (const child of sorted(root)) {
    visit(child, 0);
  }
  return rows;
}

function sorted(node: Node): Node[] {
  return [...node.children.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}
