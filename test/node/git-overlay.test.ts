import { afterAll, describe, expect, it } from "vitest";
import { diffTrees } from "../../src/git/changes";
import { overlayChanges } from "../../src/git/overlay";
import { git, removeTempDirs } from "./helpers/git";
import { applyFiles, buildScenario, commitAll, gitTreeReader, treeOf, type Scenario } from "./helpers/scenario";

afterAll(removeTempDirs);

async function taskChanges(scenario: Scenario) {
  return diffTrees(gitTreeReader(scenario.dir), treeOf(scenario.dir, scenario.base), treeOf(scenario.dir, scenario.head));
}

// The tree a real three-way merge produces; throws if git reports a conflict.
function gitMergedTree(dir: string, ours: string, theirs: string): string {
  return git(dir, ["merge-tree", "--write-tree", ours, theirs]).split("\n")[0]!;
}

describe("overlayChanges", () => {
  it("builds the tree a real three-way merge builds when the two sides touch different paths", async () => {
    const scenario = buildScenario();
    const want = gitMergedTree(scenario.dir, scenario.main, scenario.head);
    const changes = await taskChanges(scenario);

    const result = await overlayChanges(gitTreeReader(scenario.dir), treeOf(scenario.dir, scenario.main), changes);

    expect(result).toMatchObject({ ok: true, rootTree: want, alreadyApplied: false });
    expect(result.ok && result.applied.map((change) => change.path)).toEqual(changes.map((change) => change.path));
  });

  it("returns each new tree object, and no tree that main already has", async () => {
    const scenario = buildScenario();
    const want = gitMergedTree(scenario.dir, scenario.main, scenario.head);
    const changes = await taskChanges(scenario);

    const result = await overlayChanges(gitTreeReader(scenario.dir), treeOf(scenario.dir, scenario.main), changes);
    if (!result.ok) {
      throw new Error("expected a clean overlay");
    }

    // Every tree reachable from the merged root that is not reachable from main is new.
    const reachableTrees = (commitOrTree: string) =>
      new Set(
        [git(scenario.dir, ["rev-parse", `${commitOrTree}^{tree}`])].concat(
          git(scenario.dir, ["ls-tree", "-r", "-t", "--format=%(objecttype) %(objectname)", commitOrTree])
            .split("\n")
            .filter((line) => line.startsWith("tree "))
            .map((line) => line.slice(5)),
        ),
      );
    const mainTrees = reachableTrees(scenario.main);
    const wantNew = [...reachableTrees(want)].filter((oid) => !mainTrees.has(oid)).sort();
    expect(result.trees.map((tree) => tree.oid).sort()).toEqual(wantNew);
    expect(result.trees.every((tree) => tree.type === "tree")).toBe(true);
  });

  it("is stale when main changed a file the task also changed", async () => {
    const scenario = buildScenario();
    const changes = await taskChanges(scenario);
    applyFiles(scenario.dir, { "src/routes/users.ts": "users, changed by someone else\n" });
    const moved = commitAll(scenario.dir, "conflicting edit");

    const result = await overlayChanges(gitTreeReader(scenario.dir), treeOf(scenario.dir, moved), changes);

    expect(result).toEqual({
      ok: false,
      stale: [{ path: "src/routes/users.ts", reason: "changed on main since the task started" }],
    });
  });

  it("is stale when main deleted a file the task modified, and lists every stale path", async () => {
    const scenario = buildScenario();
    const changes = await taskChanges(scenario);
    applyFiles(scenario.dir, { "src/routes/users.ts": null, "scripts/run.sh": null });
    const moved = commitAll(scenario.dir, "deletions");

    const result = await overlayChanges(gitTreeReader(scenario.dir), treeOf(scenario.dir, moved), changes);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.stale.map((entry) => entry.path)).toEqual(["scripts/run.sh", "src/routes/users.ts"]);
  });

  it("is stale when main added a different file at a path the task adds", async () => {
    const scenario = buildScenario();
    const changes = await taskChanges(scenario);
    applyFiles(scenario.dir, { "src/routes/health.ts": "someone else's health check\n" });
    const moved = commitAll(scenario.dir, "same path, other content");

    const result = await overlayChanges(gitTreeReader(scenario.dir), treeOf(scenario.dir, moved), changes);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.stale.map((entry) => entry.path)).toEqual(["src/routes/health.ts"]);
  });

  it("is stale when the change would leave a path as both a file and a directory", async () => {
    const scenario = buildScenario();
    const changes = await taskChanges(scenario);
    // The task replaces the directory docs/guide with a file; main added a file inside that directory.
    applyFiles(scenario.dir, { "docs/guide/extra.md": "extra\n" });
    const moved = commitAll(scenario.dir, "file inside a directory the task removes");

    const result = await overlayChanges(gitTreeReader(scenario.dir), treeOf(scenario.dir, moved), changes);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.stale.map((entry) => entry.path)).toEqual(["docs/guide"]);
  });

  it("reports the change as already applied when main already holds the task's version", async () => {
    const scenario = buildScenario();
    const changes = await taskChanges(scenario);
    git(scenario.dir, ["merge", "--quiet", "--no-edit", scenario.head]);
    const merged = git(scenario.dir, ["rev-parse", "HEAD"]);

    const result = await overlayChanges(gitTreeReader(scenario.dir), treeOf(scenario.dir, merged), changes);

    expect(result).toEqual({
      ok: true,
      rootTree: treeOf(scenario.dir, merged),
      trees: [],
      applied: [],
      composed: [],
      alreadyApplied: true,
    });
  });

  it("applies the remaining changes when main already holds some of them", async () => {
    const scenario = buildScenario();
    const changes = await taskChanges(scenario);
    applyFiles(scenario.dir, { "src/routes/health.ts": "health\n" });
    const moved = commitAll(scenario.dir, "same file, same content");
    const want = gitMergedTree(scenario.dir, moved, scenario.head);

    const result = await overlayChanges(gitTreeReader(scenario.dir), treeOf(scenario.dir, moved), changes);

    expect(result).toMatchObject({ ok: true, rootTree: want, alreadyApplied: false });
    expect(result.ok && result.applied.map((change) => change.path)).not.toContain("src/routes/health.ts");
  });

  it("produces the empty tree, and returns it, when the task deletes every file", async () => {
    const scenario = buildScenario();
    const emptyTree = git(scenario.dir, ["hash-object", "-t", "tree", "-w", "/dev/null"]);
    const deleteEverything = await diffTrees(gitTreeReader(scenario.dir), treeOf(scenario.dir, scenario.base), emptyTree);

    const result = await overlayChanges(gitTreeReader(scenario.dir), treeOf(scenario.dir, scenario.base), deleteEverything);

    expect(result).toMatchObject({ ok: true, rootTree: emptyTree, alreadyApplied: false });
    expect(result.ok && result.trees.map((tree) => tree.oid)).toEqual([emptyTree]);
  });

  it("asks to join a path that changed on main, and uses what it is given", async () => {
    const scenario = buildScenario();
    git(scenario.dir, ["checkout", "--quiet", "--detach", scenario.main]);
    applyFiles(scenario.dir, { "src/routes/users.ts": "users, added to on main\n" });
    const moved = commitAll(scenario.dir, "another task");
    const changes = await taskChanges(scenario);
    const joined = { mode: "100644", oid: "1".repeat(40) };
    const asked: string[] = [];

    const result = await overlayChanges(gitTreeReader(scenario.dir), treeOf(scenario.dir, moved), changes, async (change) => {
      asked.push(change.path);
      return joined;
    });

    expect(asked).toEqual(["src/routes/users.ts"]);
    expect(result).toMatchObject({ ok: true, composed: ["src/routes/users.ts"] });
    expect(result.ok && result.applied.find((change) => change.path === "src/routes/users.ts")?.head).toEqual(joined);
  });

  it("is stale for a path that changed on main when it cannot be joined", async () => {
    const scenario = buildScenario();
    git(scenario.dir, ["checkout", "--quiet", "--detach", scenario.main]);
    applyFiles(scenario.dir, { "src/routes/users.ts": "users, changed on main\n" });
    const moved = commitAll(scenario.dir, "another task");

    const result = await overlayChanges(gitTreeReader(scenario.dir), treeOf(scenario.dir, moved), await taskChanges(scenario), async () => null);

    expect(result).toEqual({ ok: false, stale: [{ path: "src/routes/users.ts", reason: "changed on main since the task started" }] });
  });

  it("changes nothing when there are no changes", async () => {
    const scenario = buildScenario();
    const mainTree = treeOf(scenario.dir, scenario.main);

    const result = await overlayChanges(gitTreeReader(scenario.dir), mainTree, []);

    expect(result).toEqual({ ok: true, rootTree: mainTree, trees: [], applied: [], composed: [], alreadyApplied: false });
  });
});
