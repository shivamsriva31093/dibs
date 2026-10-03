// What a change does to the interfaces of one file: which it adds, which it removes,
// and which keep their name and get another signature.

import type { Extracted, InterfaceKind } from "./typescript";

export interface InterfaceChange {
  name: string;
  kind: InterfaceKind;
  change: "added" | "removed" | "changed";
  // The signature before the change; absent for an added interface.
  before?: string;
  // The signature after the change; absent for a removed interface.
  after?: string;
}

// `null` on either side means the file is not there on that side.
export function diffInterfaces(before: Extracted | null, after: Extracted | null): InterfaceChange[] {
  const was = new Map((before?.interfaces ?? []).map((entry) => [entry.name, entry]));
  const is = new Map((after?.interfaces ?? []).map((entry) => [entry.name, entry]));

  const changes: InterfaceChange[] = [];
  for (const [name, old] of was) {
    const now = is.get(name);
    if (now === undefined) {
      changes.push({ name, kind: old.kind, change: "removed", before: old.signature });
    } else if (now.signature !== old.signature) {
      changes.push({ name, kind: now.kind, change: "changed", before: old.signature, after: now.signature });
    }
  }
  for (const [name, now] of is) {
    if (!was.has(name)) {
      changes.push({ name, kind: now.kind, change: "added", after: now.signature });
    }
  }
  return changes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
