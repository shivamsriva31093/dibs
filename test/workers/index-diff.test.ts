import { describe, expect, it } from "vitest";
import { diffInterfaces } from "../../src/index/diff";
import { extractTypeScript } from "../../src/index/typescript";

const BEFORE = extractTypeScript(`
export function findUser(id: string): User | null { return null; }
export function listUsers(): User[] { return []; }
export const LIMIT = 10;
`);

describe("diffInterfaces", () => {
  it("finds nothing when only the bodies and values differ", () => {
    const after = extractTypeScript(`
export function findUser(id: string): User | null { return db.get(id) ?? null; }
export function listUsers(): User[] { return [...db.values()]; }
export const LIMIT = 20;
`);

    expect(diffInterfaces(BEFORE, after)).toEqual([]);
  });

  it("reports a declaration whose signature differs, with both signatures", () => {
    const after = extractTypeScript(`
export function findUser(id: string): { ok: true; user: User } | { ok: false } { return { ok: false }; }
export function listUsers(): User[] { return []; }
export const LIMIT = 10;
`);

    expect(diffInterfaces(BEFORE, after)).toEqual([
      {
        name: "findUser",
        kind: "function",
        change: "changed",
        before: "export function findUser(id: string): User | null",
        after: "export function findUser(id: string): { ok: true; user: User } | { ok: false }",
      },
    ]);
  });

  it("reports what was added and what was removed, in order of name", () => {
    const after = extractTypeScript(`
export function findUser(id: string): User | null { return null; }
export function createUser(input: NewUser): User { return input; }
export type NewUser = { name: string };
`);

    expect(diffInterfaces(BEFORE, after)).toEqual([
      { name: "LIMIT", kind: "const", change: "removed", before: "export const LIMIT" },
      { name: "NewUser", kind: "type", change: "added", after: "export type NewUser = { name: string }" },
      { name: "createUser", kind: "function", change: "added", after: "export function createUser(input: NewUser): User" },
      { name: "listUsers", kind: "function", change: "removed", before: "export function listUsers(): User[]" },
    ]);
  });

  it("sees a rename as one removed and one added", () => {
    const after = extractTypeScript("export function getUser(id: string): User | null { return null; }\nexport function listUsers(): User[] { return []; }\nexport const LIMIT = 10;");

    expect(diffInterfaces(BEFORE, after).map((change) => [change.name, change.change])).toEqual([
      ["findUser", "removed"],
      ["getUser", "added"],
    ]);
  });

  it("reports everything as added for a new file, and as removed for a deleted one", () => {
    expect(diffInterfaces(null, BEFORE).map((change) => change.change)).toEqual(["added", "added", "added"]);
    expect(diffInterfaces(BEFORE, null).map((change) => change.change)).toEqual(["removed", "removed", "removed"]);
    expect(diffInterfaces(null, null)).toEqual([]);
  });

  it("reports the kind the declaration has afterwards when the kind changed", () => {
    const after = extractTypeScript("export const findUser = (id: string): User | null => null;\nexport function listUsers(): User[] { return []; }\nexport const LIMIT = 10;");

    expect(diffInterfaces(BEFORE, after)).toMatchObject([{ name: "findUser", kind: "function", change: "changed" }]);
  });
});
