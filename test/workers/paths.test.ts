import { describe, expect, it } from "vitest";
import { normalizePath, overlaps } from "../../src/paths";

describe("normalizePath", () => {
  it.each([
    ["src/api/users.ts", "src/api/users.ts"],
    ["src/api/", "src/api/"],
    ["README.md", "README.md"],
    ["  src/a.ts  ", "src/a.ts"],
    ["src//api///users.ts", "src/api/users.ts"],
    ["src/api//", "src/api/"],
    [".github/workflows/", ".github/workflows/"],
    [".env", ".env"],
  ])("accepts %j as %j", (input, want) => {
    expect(normalizePath(input)).toEqual({ ok: true, path: want });
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["/", "leading slash"],
    ["/src/a.ts", "leading slash"],
    ["src/../secrets", "dot segment"],
    ["./src/a.ts", "dot segment"],
    ["src/./a.ts", "dot segment"],
    ["..", "dot segment"],
    ["src\\a.ts", "backslash"],
    ["src/a\u0000.ts", "control character"],
    ["src/a\n.ts", "control character"],
  ])("rejects %j (%s)", (input) => {
    expect(normalizePath(input).ok).toBe(false);
  });

  it("says why a path was rejected", () => {
    expect(normalizePath("/etc/passwd")).toEqual({
      ok: false,
      reason: "path must be repository-relative, without a leading slash",
    });
  });
});

describe("overlaps", () => {
  it.each([
    // equal paths
    ["src/a.ts", "src/a.ts", true],
    ["src/api/", "src/api/", true],
    // a directory claims everything under it, at any depth
    ["src/api/", "src/api/users.ts", true],
    ["src/api/users.ts", "src/api/", true],
    ["src/", "src/api/v2/users.ts", true],
    ["src/", "src/api/", true],
    // different files never overlap
    ["src/a.ts", "src/b.ts", false],
    // a file path is not a prefix claim: `src/api` does not cover `src/api2.ts`
    ["src/api", "src/api2.ts", false],
    // a directory only matches on a segment boundary
    ["src/api/", "src/api2/users.ts", false],
    ["src/api/", "src/apiary.ts", false],
    // a file cannot coexist with a directory of the same name, so these collide
    ["src/api", "src/api/users.ts", true],
    ["src/api/users.ts", "src/api", true],
    ["src/api", "src/api/", true],
    // sibling directories
    ["src/api/", "src/db/", false],
    ["docs/", "src/docs/readme.md", false],
  ])("%j vs %j -> %s", (a, b, want) => {
    expect(overlaps(a, b)).toBe(want);
  });
});
