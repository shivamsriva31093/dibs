import { describe, expect, it } from "vitest";
import type { BoardTask } from "../../../src/types";
import { buildClaimRows, type Refusal } from "./tree";

function task(id: string, agent: string, paths: string[], overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id,
    agentId: `a-${agent}`,
    agent,
    goal: `goal of ${agent}`,
    state: "active",
    cycle: 1,
    forkName: `demo-app--${id}`,
    baseSha: "b".repeat(40),
    paths,
    scope: paths.map((target) => ({ target, relation: "change", origin: "declared" })),
    collisions: [],
    dependents: [],
    claimExpiresAt: 1000,
    mergeSha: null,
    verdict: null,
    createdAt: 0,
    updatedAt: 0,
    related: [],
    submission: null,
    ...overrides,
  };
}

// A task with a scope that says how each thing is held.
function scoped(id: string, agent: string, scope: [target: string, relation: "change" | "add" | "rely"][]): BoardTask {
  return task(id, agent, [], { scope: scope.map(([target, relation]) => ({ target, relation, origin: "declared" })) });
}

// The shape of the tree, without the task objects, for easy comparison.
const outline = (rows: ReturnType<typeof buildClaimRows>) =>
  rows.map((row) => [row.depth, row.label, row.holder?.agent ?? null, row.refusals.map((refusal) => refusal.agent)]);

describe("buildClaimRows", () => {
  it("lays claimed paths out as a tree, joining directories that have nothing else in them", () => {
    const rows = buildClaimRows(
      [
        task("t-1", "one", ["src/routes/users/"]),
        task("t-2", "two", ["src/middleware/"]),
        task("t-3", "three", ["src/db/users.ts", "test/users.test.ts"]),
        task("t-4", "four", ["package.json"]),
      ],
      [],
    );

    expect(outline(rows)).toEqual([
      [0, "package.json", "four", []],
      [0, "src/", null, []],
      [1, "db/users.ts", "three", []],
      [1, "middleware/", "two", []],
      [1, "routes/users/", "one", []],
      [0, "test/users.test.ts", "three", []],
    ]);
    expect(rows.map((row) => row.path)).toEqual([
      "package.json",
      "src/",
      "src/db/users.ts",
      "src/middleware/",
      "src/routes/users/",
      "test/users.test.ts",
    ]);
  });

  it("shows a single claim as one row with its whole path", () => {
    expect(outline(buildClaimRows([task("t-1", "one", ["src/routes/users/"])], []))).toEqual([
      [0, "src/routes/users/", "one", []],
    ]);
  });

  it("does not show an expired task's path, even under a live claim that now covers it", () => {
    const rows = buildClaimRows(
      [task("t-1", "one", ["src/api/"]), task("t-2", "two", ["src/api/v2/users.ts"], { state: "expired" })],
      [],
    );

    expect(outline(rows)).toEqual([[0, "src/api/", "one", []]]);
  });

  it("leaves out tasks that no longer hold a claim", () => {
    const rows = buildClaimRows(
      [
        task("t-1", "one", ["src/a.ts"], { state: "merged" }),
        task("t-2", "two", ["src/b.ts"], { state: "in_review" }),
        task("t-3", "three", ["src/c.ts"], { state: "escalated" }),
        task("t-4", "four", ["src/d.ts"], { state: "abandoned" }),
      ],
      [],
    );

    expect(outline(rows)).toEqual([
      [0, "src/", null, []],
      [1, "b.ts", "two", []],
      [1, "c.ts", "three", []],
    ]);
  });

  it("attaches a refused request to the row of the path that blocked it", () => {
    const refusal: Refusal = {
      id: 7,
      agent: "two",
      goal: "Add rate limiting",
      requested: ["src/routes/users/limits.ts"],
      blockedBy: [{ taskId: "t-1", agent: "one", paths: ["src/routes/users/"] }],
      at: 5000,
    };

    const rows = buildClaimRows([task("t-1", "one", ["src/routes/users/", "docs/"])], [refusal]);

    expect(outline(rows)).toEqual([
      [0, "docs/", "one", []],
      [0, "src/routes/users/", "one", ["two"]],
    ]);
  });

  it("shows a refused request once, against the first of the paths that blocked it", () => {
    const refusal: Refusal = {
      id: 7,
      agent: "two",
      goal: "Add rate limiting",
      requested: ["src/routes/users/"],
      blockedBy: [{ taskId: "t-1", agent: "one", paths: ["src/routes/users/get.ts", "src/routes/users/index.ts"] }],
      at: 5000,
    };

    const rows = buildClaimRows([task("t-1", "one", ["src/routes/users/get.ts", "src/routes/users/index.ts"])], [refusal]);

    expect(outline(rows)).toEqual([
      [0, "src/routes/users/", null, []],
      [1, "get.ts", "one", ["two"]],
      [1, "index.ts", "one", []],
    ]);
  });

  it("drops a refusal whose blocker is no longer on the board", () => {
    const refusal: Refusal = {
      id: 7,
      agent: "two",
      goal: "g",
      requested: ["src/a.ts"],
      blockedBy: [{ taskId: "t-gone", agent: "one", paths: ["src/a.ts"] }],
      at: 5000,
    };

    expect(outline(buildClaimRows([task("t-9", "nine", ["docs/"])], [refusal]))).toEqual([[0, "docs/", "nine", []]]);
  });

  it("shows a file that several tasks add to once, with all of them", () => {
    const rows = buildClaimRows(
      [
        scoped("t-1", "one", [["src/routes/index.ts", "add"], ["src/routes/get.ts", "change"]]),
        scoped("t-2", "two", [["src/routes/index.ts", "add"]]),
      ],
      [],
    );

    expect(rows.map((row) => [row.label, row.relation, row.holder?.agent ?? null, row.sharers.map((sharer) => sharer.agent)])).toEqual([
      ["src/routes/", null, null, []],
      ["get.ts", "change", "one", []],
      ["index.ts", "add", "one", ["two"]],
    ]);
  });

  it("shows an interface a task holds under its file", () => {
    const rows = buildClaimRows(
      [
        scoped("t-1", "one", [["src/db/users.ts", "add"], ["src/db/users.ts#findUser", "change"]]),
        scoped("t-2", "two", [["src/db/users.ts", "add"], ["src/db/users.ts#listUsers", "change"]]),
      ],
      [],
    );

    expect(rows.map((row) => [row.depth, row.label, row.relation, row.holder?.agent ?? null, row.sharers.map((sharer) => sharer.agent)])).toEqual([
      [0, "src/db/users.ts", "add", "one", ["two"]],
      [1, "#findUser", "change", "one", []],
      [1, "#listUsers", "change", "two", []],
    ]);
    expect(rows.map((row) => row.path)).toEqual(["src/db/users.ts", "src/db/users.ts#findUser", "src/db/users.ts#listUsers"]);
  });

  it("leaves out what a task only relies on", () => {
    const rows = buildClaimRows([scoped("t-1", "one", [["src/a.ts", "change"], ["src/db/users.ts#findUser", "rely"], ["src/lib/", "rely"]])], []);

    expect(outline(rows)).toEqual([[0, "src/a.ts", "one", []]]);
  });

  it("marks the first row of each task, for what is said once about a task", () => {
    const rows = buildClaimRows([task("t-1", "one", ["src/a.ts", "src/b.ts"]), task("t-2", "two", ["src/c.ts"])], []);

    expect(rows.map((row) => [row.label, row.first])).toEqual([
      ["src/", false],
      ["a.ts", true],
      ["b.ts", false],
      ["c.ts", true],
    ]);
  });

  it("returns no rows when nothing is claimed", () => {
    expect(buildClaimRows([], [])).toEqual([]);
  });
});
