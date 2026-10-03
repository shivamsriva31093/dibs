import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { merge3 } from "../../src/git/merge3";
import { FIXED_ENV, makeTempDir, removeTempDirs } from "./helpers/git";

afterAll(removeTempDirs);

// What git's own three-way merge of one file gives, or null when git reports a conflict.
function gitMergeFile(base: string, ours: string, theirs: string): string | null {
  const dir = makeTempDir("dibs-merge3-");
  writeFileSync(join(dir, "base"), base);
  writeFileSync(join(dir, "ours"), ours);
  writeFileSync(join(dir, "theirs"), theirs);
  try {
    // Read as it is: the shared helper trims what git prints, and the last line break matters here.
    return execFileSync("git", ["merge-file", "-p", "ours", "base", "theirs"], { cwd: dir, env: { ...process.env, ...FIXED_ENV }, encoding: "utf8" });
  } catch {
    return null;
  }
}

const lines = (...items: string[]) => `${items.join("\n")}\n`;

describe("merge3", () => {
  it("keeps the base when neither side changed it", () => {
    expect(merge3("a\nb\n", "a\nb\n", "a\nb\n")).toEqual({ ok: true, text: "a\nb\n" });
  });

  it("takes the one side that changed", () => {
    expect(merge3("a\nb\n", "a\nB\n", "a\nb\n")).toEqual({ ok: true, text: "a\nB\n" });
    expect(merge3("a\nb\n", "a\nb\n", "A\nb\n")).toEqual({ ok: true, text: "A\nb\n" });
  });

  it("joins changes to different parts of a file, as git does", () => {
    const base = lines("one", "two", "three", "four", "five", "six", "seven");
    const ours = lines("ONE", "two", "three", "four", "five", "six", "seven");
    const theirs = lines("one", "two", "three", "four", "five", "six", "SEVEN", "eight");

    expect(merge3(base, ours, theirs)).toEqual({ ok: true, text: gitMergeFile(base, ours, theirs) });
  });

  it("takes a change once when both sides made it", () => {
    const base = lines("a", "b", "c");
    const both = lines("a", "B", "c");

    expect(merge3(base, both, both)).toEqual({ ok: true, text: both });
  });

  it("keeps both sides' lines when both added lines at the same place", () => {
    const base = lines('import { a } from "./a.ts";', "", "export const all = [a];");
    const ours = lines('import { a } from "./a.ts";', 'import { b } from "./b.ts";', "", "export const all = [a];");
    const theirs = lines('import { a } from "./a.ts";', 'import { c } from "./c.ts";', "", "export const all = [a];");

    expect(merge3(base, ours, theirs)).toEqual({
      ok: true,
      text: lines('import { a } from "./a.ts";', 'import { b } from "./b.ts";', 'import { c } from "./c.ts";', "", "export const all = [a];"),
    });
  });

  it("keeps both sides' additions within a line that both changed only by adding", () => {
    const base = lines("export const userRoutes: Route[] = [listUsersRoute];");
    const ours = lines("export const userRoutes: Route[] = [listUsersRoute, getUserRoute];");
    const theirs = lines("export const userRoutes: Route[] = [listUsersRoute, getOrdersRoute];");

    expect(merge3(base, ours, theirs)).toEqual({
      ok: true,
      text: lines("export const userRoutes: Route[] = [listUsersRoute, getUserRoute, getOrdersRoute];"),
    });
  });

  it("composes a registry file that two tasks each added a route to", () => {
    const base = lines(
      'import type { Route } from "../../router.ts";',
      'import { listUsersRoute } from "./list.ts";',
      "",
      "export const userRoutes: Route[] = [listUsersRoute];",
    );
    const ours = lines(
      'import type { Route } from "../../router.ts";',
      'import { getUserRoute } from "./get.ts";',
      'import { listUsersRoute } from "./list.ts";',
      "",
      "export const userRoutes: Route[] = [listUsersRoute, getUserRoute];",
    );
    const theirs = lines(
      'import type { Route } from "../../router.ts";',
      'import { listUsersRoute } from "./list.ts";',
      'import { userOrdersRoute } from "./orders.ts";',
      "",
      "export const userRoutes: Route[] = [listUsersRoute, userOrdersRoute];",
    );

    expect(merge3(base, ours, theirs)).toEqual({
      ok: true,
      text: lines(
        'import type { Route } from "../../router.ts";',
        'import { getUserRoute } from "./get.ts";',
        'import { listUsersRoute } from "./list.ts";',
        'import { userOrdersRoute } from "./orders.ts";',
        "",
        "export const userRoutes: Route[] = [listUsersRoute, getUserRoute, userOrdersRoute];",
      ),
    });
  });

  it("refuses two different changes to the same line that take something away", () => {
    expect(merge3(lines("const limit = 10;"), lines("const limit = 20;"), lines("const limit = 30;"))).toEqual({ ok: false });
  });

  it("refuses a change on one side to a line the other side removed", () => {
    expect(merge3(lines("a", "b", "c"), lines("a", "B", "c"), lines("a", "c"))).toEqual({ ok: false });
  });

  it("refuses two different changes that each span the same lines", () => {
    expect(merge3(lines("a", "b", "c"), lines("a", "x", "y", "c"), lines("a", "p", "c"))).toEqual({ ok: false });
  });

  it("keeps changes to neighbouring lines", () => {
    expect(merge3(lines("a", "b", "c", "d"), lines("a", "B", "c", "d"), lines("a", "b", "C", "d"))).toEqual({
      ok: true,
      text: lines("a", "B", "C", "d"),
    });
  });

  it("puts one side's addition before a block the other side changed, when both start at the same line", () => {
    expect(merge3(lines("a", "b"), lines("a", "new", "b"), lines("a", "B"))).toEqual({ ok: true, text: lines("a", "new", "B") });
  });

  it("keeps a file without a final line break as it is", () => {
    expect(merge3("a\nb", "a\nB", "A\nb")).toEqual({ ok: true, text: "A\nB" });
  });

  it("keeps Windows line endings", () => {
    expect(merge3("a\r\nb\r\n", "a\r\nb\r\nc\r\n", "z\r\na\r\nb\r\n")).toEqual({ ok: true, text: "z\r\na\r\nb\r\nc\r\n" });
  });

  it("agrees with git on a larger file changed in several places on both sides", () => {
    const base = Array.from({ length: 60 }, (_unused, index) => `line ${index}`);
    const ours = [...base];
    ours[3] = "ours 3";
    ours.splice(20, 2);
    ours[40] = "ours 40";
    const theirs = [...base];
    theirs[10] = "theirs 10";
    theirs.splice(30, 0, "theirs inserted");
    theirs[55] = "theirs 55";

    expect(merge3(lines(...base), lines(...ours), lines(...theirs))).toEqual({
      ok: true,
      text: gitMergeFile(lines(...base), lines(...ours), lines(...theirs)),
    });
  });
});
