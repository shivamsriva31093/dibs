// Scopes: what a task holds, and how. A scope entry names a target and a relation
// to it: the task will change it, add to it, or rely on it.
//
// A target is a path (a file, or a directory with a trailing "/"), an interface
// written `path#name` (an exported symbol or declaration in a file), or a route
// written `route:METHOD /pattern`.

import { normalizePath, overlaps } from "./paths";

export type Target =
  | { kind: "path"; path: string }
  | { kind: "interface"; path: string; name: string }
  | { kind: "route"; method: string; pattern: string };

export type ParsedTarget = { ok: true; target: Target; text: string } | { ok: false; reason: string };

const ROUTE_PREFIX = "route:";
const ROUTE_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "*"];
const WHITESPACE = /\s/;

export function targetText(target: Target): string {
  switch (target.kind) {
    case "path":
      return target.path;
    case "interface":
      return `${target.path}#${target.name}`;
    case "route":
      return `${ROUTE_PREFIX}${target.method} ${target.pattern}`;
  }
}

function parseRoute(input: string): ParsedTarget {
  const parts = input.slice(ROUTE_PREFIX.length).trim().split(/\s+/);
  if (parts.length < 2 || parts[0] === "") {
    return { ok: false, reason: "a route is written route:METHOD /pattern" };
  }
  const method = parts[0]!.toUpperCase();
  if (!ROUTE_METHODS.includes(method)) {
    return { ok: false, reason: "a route's method must be GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS or *" };
  }
  if (parts.length > 2) {
    return { ok: false, reason: "a route's pattern must not contain whitespace" };
  }
  const pattern = parts[1]!;
  if (!pattern.startsWith("/")) {
    return { ok: false, reason: "a route's pattern must start with /" };
  }
  const target: Target = { kind: "route", method, pattern };
  return { ok: true, target, text: targetText(target) };
}

function parseInterface(input: string): ParsedTarget {
  const hash = input.indexOf("#");
  const file = input.slice(0, hash).trim();
  const name = input.slice(hash + 1).trim();
  if (file === "" || file.endsWith("/")) {
    return { ok: false, reason: "an interface names a file, not a directory" };
  }
  const path = normalizePath(file);
  if (!path.ok) {
    return { ok: false, reason: path.reason };
  }
  if (path.path.endsWith("/")) {
    return { ok: false, reason: "an interface names a file, not a directory" };
  }
  if (name === "") {
    return { ok: false, reason: "an interface needs a name after the #" };
  }
  if (WHITESPACE.test(name) || name.includes("#") || name.includes("/")) {
    return { ok: false, reason: "an interface name must not contain whitespace, # or /" };
  }
  const target: Target = { kind: "interface", path: path.path, name };
  return { ok: true, target, text: targetText(target) };
}

export function parseTarget(input: string): ParsedTarget {
  const trimmed = input.trim();
  if (trimmed.startsWith(ROUTE_PREFIX)) {
    return parseRoute(trimmed);
  }
  if (trimmed.includes("#")) {
    return parseInterface(trimmed);
  }
  const path = normalizePath(trimmed);
  if (!path.ok) {
    return { ok: false, reason: path.reason };
  }
  return { ok: true, target: { kind: "path", path: path.path }, text: path.path };
}

// The file or directory a target lives in. A route is not in any one file.
export function targetPath(target: Target): string | null {
  return target.kind === "route" ? null : target.path;
}

// Whether two targets name code that overlaps.
export function targetsOverlap(a: Target, b: Target): boolean {
  if (a.kind === "route" || b.kind === "route") {
    return (
      a.kind === "route" &&
      b.kind === "route" &&
      a.pattern === b.pattern &&
      (a.method === b.method || a.method === "*" || b.method === "*")
    );
  }
  if (a.kind === "interface" && b.kind === "interface") {
    return a.path === b.path && a.name === b.name;
  }
  // A path holds an interface when it holds the interface's file.
  return overlaps(a.path, b.path);
}

export type ScopeRelation = "change" | "add" | "rely";
// Who put an entry in a scope: the agent, dibs from what the code refers to, or dibs from the submitted diff.
export type ScopeOrigin = "declared" | "inferred" | "detected";

const RELATIONS: readonly ScopeRelation[] = ["change", "add", "rely"];

export interface ScopeEntry {
  // The target as it is written.
  target: string;
  relation: ScopeRelation;
  origin: ScopeOrigin;
}

export interface HeldEntry extends ScopeEntry {
  taskId: string;
}

// "conflict": the two cannot both be held. "link": both are held, and the two tasks are told of each other.
export type Outcome = "ok" | "conflict" | "link";

type Held = { target: Target; relation: ScopeRelation };

// What it means for one task to ask for something that another task holds.
//
//   change with change           the same code cannot be changed twice at once
//   change with add              a file being rewritten cannot be added to meanwhile, unless the
//                                change is to one interface in it: then the rest of the file is shared
//   change with rely             both go on; one is changing what the other is built on
//   add with add, and the rest   both go on
export function relate(requested: Held, held: Held): Outcome {
  if (!targetsOverlap(requested.target, held.target)) {
    return "ok";
  }
  const relations = [requested.relation, held.relation];
  if (relations.includes("rely")) {
    return relations.includes("change") ? "link" : "ok";
  }
  if (!relations.includes("change")) {
    return "ok";
  }
  if (relations.includes("add")) {
    const changed = requested.relation === "change" ? requested.target : held.target;
    return changed.kind === "path" ? "conflict" : "ok";
  }
  return "conflict";
}

export interface Pairing {
  requested: ScopeEntry;
  held: HeldEntry;
}

// Sorts what a task asks for, against what other tasks hold, into what is refused and what is linked.
export function classify(requested: ScopeEntry[], held: HeldEntry[]): { conflicts: Pairing[]; links: Pairing[] } {
  const conflicts: Pairing[] = [];
  const links: Pairing[] = [];
  const read = (entry: ScopeEntry): Held | null => {
    const parsed = parseTarget(entry.target);
    return parsed.ok ? { target: parsed.target, relation: entry.relation } : null;
  };
  const others = held.flatMap((entry) => {
    const parsed = read(entry);
    return parsed === null ? [] : [{ entry, parsed }];
  });
  for (const entry of requested) {
    const asked = read(entry);
    if (asked === null) {
      continue;
    }
    for (const other of others) {
      const outcome = relate(asked, other.parsed);
      if (outcome === "conflict") {
        conflicts.push({ requested: entry, held: other.entry });
      } else if (outcome === "link") {
        links.push({ requested: entry, held: other.entry });
      }
    }
  }
  return { conflicts, links };
}

const MAX_ENTRIES = 100;
const MAX_TARGET_LENGTH = 500;

const isDirectory = (path: string) => path.endsWith("/");
const holdsPath = (held: string, path: string) => (isDirectory(held) ? path.startsWith(held) : held === path);

// Validates what an agent asks for and writes it the standard way: targets as dibs writes them,
// no repeats, nothing that a directory in the same request already holds, sorted.
export function normalizeScope(
  input: { target: string; relation: string; origin?: ScopeOrigin }[],
  options: { maxEntries?: number } = {},
): { ok: true; entries: ScopeEntry[] } | { ok: false; reason: string } {
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  if (input.length === 0 || input.length > maxEntries) {
    return { ok: false, reason: `between 1 and ${maxEntries} scope entries are required` };
  }

  const byKey = new Map<string, { entry: ScopeEntry; target: Target }>();
  for (const raw of input) {
    const text = String(raw.target);
    if (text.length > MAX_TARGET_LENGTH) {
      return { ok: false, reason: `invalid target: longer than ${MAX_TARGET_LENGTH} characters` };
    }
    const parsed = parseTarget(text);
    if (!parsed.ok) {
      return { ok: false, reason: `invalid target ${JSON.stringify(text)}: ${parsed.reason}` };
    }
    if (!RELATIONS.includes(raw.relation as ScopeRelation)) {
      return { ok: false, reason: `invalid relation ${JSON.stringify(raw.relation)} for ${parsed.text}: it must be change, add or rely` };
    }
    const relation = raw.relation as ScopeRelation;
    if (relation === "add" && parsed.target.kind !== "path") {
      return { ok: false, reason: `${parsed.text} cannot be held to add to: an interface or a route is changed or relied on` };
    }
    const key = `${parsed.text}\0${relation}`;
    if (!byKey.has(key)) {
      byKey.set(key, { entry: { target: parsed.text, relation, origin: raw.origin ?? "declared" }, target: parsed.target });
    }
  }

  // Changing an interface means editing its file, so the file is held too: to add to, which leaves
  // the rest of it open to others.
  const writable = () =>
    [...byKey.values()].flatMap(({ entry, target }) => (target.kind === "path" && entry.relation !== "rely" ? [target.path] : []));
  for (const { entry, target } of [...byKey.values()]) {
    if (target.kind === "interface" && entry.relation === "change" && !writable().some((held) => holdsPath(held, target.path))) {
      byKey.set(`${target.path}\0add`, {
        entry: { target: target.path, relation: "add", origin: "inferred" },
        target: { kind: "path", path: target.path },
      });
    }
  }

  const all = [...byKey.values()];
  // A path is dropped when another path of the request already holds it: a directory of the same
  // relation, or the same path or a directory held to change, which includes adding to it.
  const heldBy = (entry: ScopeEntry, path: string, other: { entry: ScopeEntry; target: Target }): boolean => {
    if (other.target.kind !== "path" || other.entry === entry) {
      return false;
    }
    const sameRelation = other.entry.relation === entry.relation;
    const changeOverAdd = entry.relation === "add" && other.entry.relation === "change";
    if (other.target.path === path) {
      return changeOverAdd;
    }
    return (sameRelation || changeOverAdd) && isDirectory(other.target.path) && path.startsWith(other.target.path);
  };
  const entries = all
    .filter(({ entry, target }) => target.kind !== "path" || !all.some((other) => heldBy(entry, target.path, other)))
    .map(({ entry }) => entry);
  return { ok: true, entries: sortScope(entries) };
}

// The order a scope is always listed in: by target, and by relation where one target is held in two ways.
export function sortScope<T extends { target: string; relation: ScopeRelation }>(entries: T[]): T[] {
  return [...entries].sort((a, b) =>
    a.target < b.target ? -1 : a.target > b.target ? 1 : RELATIONS.indexOf(a.relation) - RELATIONS.indexOf(b.relation),
  );
}

// A list of paths, as agents gave before there were relations, means each path is to change.
export function scopeFromPaths(paths: string[]): { target: string; relation: "change" }[] {
  return paths.map((target) => ({ target, relation: "change" }));
}

// The paths a task may write: what it holds to change or to add to. Interfaces and routes are not paths.
export function writablePaths(scope: ScopeEntry[]): string[] {
  return scope
    .flatMap((entry) => {
      const parsed = entry.relation === "rely" ? null : parseTarget(entry.target);
      return parsed?.ok && parsed.target.kind === "path" ? [parsed.target.path] : [];
    })
    .sort();
}

// Whether a task may write a path: a directory it holds covers everything beneath it, a file covers itself.
export function coversPath(scope: ScopeEntry[], path: string): boolean {
  return writablePaths(scope).some((held) => holdsPath(held, path));
}

const LISTED = 6;

// A scope on one line, for a commit trailer: "change=a, b; add=c; rely=d (inferred)".
// Null for a scope that is only paths to change, which the list of claimed paths already says.
export function formatScope(scope: ScopeEntry[]): string | null {
  const plain = scope.every((entry) => {
    const parsed = parseTarget(entry.target);
    return entry.relation === "change" && entry.origin === "declared" && parsed.ok && parsed.target.kind === "path";
  });
  if (plain) {
    return null;
  }
  const parts: string[] = [];
  for (const relation of RELATIONS) {
    const entries = sortScope(scope.filter((entry) => entry.relation === relation));
    if (entries.length === 0) {
      continue;
    }
    const shown = entries
      .slice(0, LISTED)
      .map((entry) => (entry.origin === "declared" ? entry.target : `${entry.target} (${entry.origin})`))
      .join(", ");
    parts.push(`${relation}=${shown}${entries.length > LISTED ? ` and ${entries.length - LISTED} more` : ""}`);
  }
  return parts.join("; ");
}
