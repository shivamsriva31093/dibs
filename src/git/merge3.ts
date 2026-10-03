// A three-way merge of one text file, for a file that several tasks hold to add to:
// a list of routes, a block of imports, an index. Changes to different parts of the
// file are joined, as git joins them. Where both sides added something at the same
// place, both additions are kept, ours first; that is what adding to a shared file
// means. Anything else that both sides changed is a conflict, and the merge refuses.
//
// The same is tried inside a line that both sides changed only by adding to it, so
// that `[a]` with `[a, b]` and `[a, c]` gives `[a, b, c]`.

import { diffArrays } from "diff";

export type Merge3 = { ok: true; text: string } | { ok: false };

// Base items [start, end) replaced by `items`. An addition has start === end.
interface Hunk {
  start: number;
  end: number;
  items: string[];
  side: "ours" | "theirs";
}

function hunks(base: string[], side: string[], name: Hunk["side"]): Hunk[] {
  const out: Hunk[] = [];
  let at = 0;
  let current: Hunk | null = null;
  for (const part of diffArrays(base, side)) {
    if (!part.added && !part.removed) {
      if (current !== null) {
        out.push(current);
        current = null;
      }
      at += part.count ?? part.value.length;
      continue;
    }
    current ??= { start: at, end: at, items: [], side: name };
    if (part.removed) {
      at += part.count ?? part.value.length;
      current.end = at;
    } else {
      current.items.push(...part.value);
    }
  }
  if (current !== null) {
    out.push(current);
  }
  return out;
}

// Whether two hunks touch the same part of the base. Changes that only border each other do not,
// and nor does an addition at the edge of a block the other side changed.
function overlap(a: Hunk, b: Hunk): boolean {
  if (a.start === a.end && b.start === b.end) {
    return a.start === b.start;
  }
  if (a.start === a.end) {
    return b.start < a.start && a.start < b.end;
  }
  if (b.start === b.end) {
    return a.start < b.start && b.start < a.end;
  }
  return a.start < b.end && b.start < a.end;
}

// The base items [start, end) with one side's hunks applied.
function applied(base: string[], start: number, end: number, side: Hunk[]): string[] {
  const out: string[] = [];
  let at = start;
  for (const hunk of side) {
    out.push(...base.slice(at, hunk.start), ...hunk.items);
    at = hunk.end;
  }
  out.push(...base.slice(at, end));
  return out;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((item, index) => item === b[index]);

// Joins two edits of one sequence. `inner` is tried on a single item that both sides changed into a single item.
function mergeSequences(
  base: string[],
  ours: string[],
  theirs: string[],
  inner: ((base: string, ours: string, theirs: string) => string | null) | null,
): string[] | null {
  const all = [...hunks(base, ours, "ours"), ...hunks(base, theirs, "theirs")].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: string[] = [];
  let at = 0;
  for (let index = 0; index < all.length; ) {
    // The hunks that touch, one way or another, the first hunk not yet taken.
    const group = [all[index]!];
    index++;
    while (index < all.length && group.some((hunk) => overlap(hunk, all[index]!))) {
      group.push(all[index]!);
      index++;
    }
    const start = Math.min(...group.map((hunk) => hunk.start));
    const end = Math.max(...group.map((hunk) => hunk.end));
    out.push(...base.slice(at, start));
    at = end;

    const mine = group.filter((hunk) => hunk.side === "ours");
    const yours = group.filter((hunk) => hunk.side === "theirs");
    const fromOurs = applied(base, start, end, mine);
    const fromTheirs = applied(base, start, end, yours);
    if (mine.length === 0 || yours.length === 0 || same(fromOurs, fromTheirs)) {
      out.push(...(mine.length === 0 ? fromTheirs : fromOurs));
    } else if (start === end) {
      // Both added at the same place: both additions stay.
      out.push(...fromOurs, ...fromTheirs);
    } else if (inner !== null && end - start === 1 && fromOurs.length === 1 && fromTheirs.length === 1) {
      const joined = inner(base[start]!, fromOurs[0]!, fromTheirs[0]!);
      if (joined === null) {
        return null;
      }
      out.push(joined);
    } else {
      return null;
    }
  }
  out.push(...base.slice(at));
  return out;
}

const TOKENS = /\w+|\s+|[^\w\s]/g;
const tokens = (line: string) => line.match(TOKENS) ?? [];

// Joins two changes to one line when both only add to it.
function mergeLine(base: string, ours: string, theirs: string): string | null {
  const before = tokens(base);
  const onlyAdds = (after: string[]) => hunks(before, after, "ours").every((hunk) => hunk.start === hunk.end);
  const mine = tokens(ours);
  const yours = tokens(theirs);
  if (!onlyAdds(mine) || !onlyAdds(yours)) {
    return null;
  }
  return mergeSequences(before, mine, yours, null)?.join("") ?? null;
}

export function merge3(base: string, ours: string, theirs: string): Merge3 {
  const merged = mergeSequences(base.split("\n"), ours.split("\n"), theirs.split("\n"), mergeLine);
  return merged === null ? { ok: false } : { ok: true, text: merged.join("\n") };
}
