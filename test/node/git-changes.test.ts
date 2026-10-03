import { afterAll, describe, expect, it } from "vitest";
import { diffTrees, type Change } from "../../src/git/changes";
import { git, gitRaw, lsTree, removeTempDirs } from "./helpers/git";
import { applyFiles, buildScenario, commitAll, gitTreeReader, treeOf } from "./helpers/scenario";

afterAll(removeTempDirs);

// What the real git says changed between two commits.
function gitNameStatus(dir: string, from: string, to: string): { path: string; status: Change["status"] }[] {
  const fields = gitRaw(dir, ["diff-tree", "-r", "--no-renames", "--name-status", "-z", from, to])
    .toString("utf8")
    .split("\0")
    .filter((field) => field !== "");
  const status: Record<string, Change["status"]> = { A: "added", D: "deleted", M: "modified", T: "modified" };
  const out: { path: string; status: Change["status"] }[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    out.push({ path: fields[index + 1]!, status: status[fields[index]!]! });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

describe("diffTrees", () => {
  it("finds the same changed paths, with the same statuses, as git diff-tree", async () => {
    const scenario = buildScenario();
    const want = gitNameStatus(scenario.dir, scenario.base, scenario.head);
    // Guard the fixture: it must really contain each kind of change.
    expect(want).toEqual([
      { path: "config", status: "deleted" },
      { path: "config/app.json", status: "added" },
      { path: "docs/guide", status: "added" },
      { path: "docs/guide/intro.md", status: "deleted" },
      { path: "link", status: "modified" },
      { path: "scripts/run.sh", status: "modified" },
      { path: "src/new/deep/nested/file.ts", status: "added" },
      { path: "src/old/legacy.ts", status: "deleted" },
      { path: "src/routes/health.ts", status: "added" },
      { path: "src/routes/users.ts", status: "modified" },
    ]);

    const changes = await diffTrees(
      gitTreeReader(scenario.dir),
      treeOf(scenario.dir, scenario.base),
      treeOf(scenario.dir, scenario.head),
    );

    expect(changes.map(({ path, status }) => ({ path, status }))).toEqual(want);
  });

  it("reports the mode and object id on each side of a change", async () => {
    const scenario = buildScenario();
    const baseEntries = new Map(lsTree(scenario.dir, scenario.base, true).map((entry) => [entry.name, entry]));
    const headEntries = new Map(lsTree(scenario.dir, scenario.head, true).map((entry) => [entry.name, entry]));

    const changes = await diffTrees(
      gitTreeReader(scenario.dir),
      treeOf(scenario.dir, scenario.base),
      treeOf(scenario.dir, scenario.head),
    );
    const byPath = new Map(changes.map((change) => [change.path, change]));

    // Only the mode changed.
    expect(byPath.get("scripts/run.sh")).toEqual({
      path: "scripts/run.sh",
      status: "modified",
      base: { mode: "100644", oid: baseEntries.get("scripts/run.sh")!.oid },
      head: { mode: "100755", oid: baseEntries.get("scripts/run.sh")!.oid },
    });
    // A regular file became a symlink.
    expect(byPath.get("link")).toEqual({
      path: "link",
      status: "modified",
      base: { mode: "100644", oid: baseEntries.get("link")!.oid },
      head: { mode: "120000", oid: headEntries.get("link")!.oid },
    });
    expect(byPath.get("src/routes/health.ts")).toEqual({
      path: "src/routes/health.ts",
      status: "added",
      base: null,
      head: { mode: "100644", oid: headEntries.get("src/routes/health.ts")!.oid },
    });
    expect(byPath.get("src/old/legacy.ts")).toEqual({
      path: "src/old/legacy.ts",
      status: "deleted",
      base: { mode: "100644", oid: baseEntries.get("src/old/legacy.ts")!.oid },
      head: null,
    });
  });

  it("returns nothing, and reads nothing, for identical trees", async () => {
    const scenario = buildScenario();
    const reader = gitTreeReader(scenario.dir);
    const tree = treeOf(scenario.dir, scenario.base);

    expect(await diffTrees(reader, tree, tree)).toEqual([]);
    expect(reader.reads).toEqual([]);
  });

  it("does not read directories whose contents are unchanged", async () => {
    const scenario = buildScenario();
    applyFiles(scenario.dir, { "src/db/client.ts": "db v2\n" });
    const next = commitAll(scenario.dir, "one file");
    const reader = gitTreeReader(scenario.dir);

    const changes = await diffTrees(reader, treeOf(scenario.dir, scenario.main), treeOf(scenario.dir, next));

    expect(changes.map((change) => change.path)).toEqual(["src/db/client.ts"]);
    // Root, src and src/db, on each side: six reads. Nothing under routes, docs, and so on.
    expect(reader.reads).toHaveLength(6);
  });

  it("fails when a tree it needs is missing", async () => {
    const scenario = buildScenario();

    await expect(
      diffTrees(gitTreeReader(scenario.dir), treeOf(scenario.dir, scenario.base), "1".repeat(40)),
    ).rejects.toThrow(/1{40}/);
  });

  it("lists every file when comparing against an empty tree", async () => {
    const scenario = buildScenario();
    const emptyTree = git(scenario.dir, ["hash-object", "-t", "tree", "-w", "/dev/null"]);

    const changes = await diffTrees(gitTreeReader(scenario.dir), emptyTree, treeOf(scenario.dir, scenario.base));

    expect(changes.map((change) => change.path)).toEqual(
      lsTree(scenario.dir, scenario.base, true)
        .map((entry) => entry.name)
        .sort(),
    );
    expect(changes.every((change) => change.status === "added")).toBe(true);
  });
});
