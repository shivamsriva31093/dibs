import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexFile, type IndexedFile } from "../../src/index/file";
import { freezeTime, MINUTE, newAgent, newCoordinator, T0, type CoordinatorStub } from "./helpers/coordinator";

beforeEach(() => freezeTime());
afterEach(() => vi.useRealTimers());

const SHA = "1".repeat(40);

const REPO: Record<string, string> = {
  "src/db/users.ts": "export function findUser(id: string): User | null { return null; }\nexport function listUsers(): User[] { return []; }",
  "src/routes/users/list.ts": 'import { listUsers } from "../../db/users";\nexport const listUsersRoute = 1;',
  "src/routes/users/index.ts": 'import { listUsersRoute } from "./list";\nexport const userRoutes = [listUsersRoute];',
  "test/users.test.ts": 'import { findUser, listUsers } from "../src/db/users";',
};

async function indexed(files: Record<string, string>, all: Record<string, string> = files): Promise<IndexedFile[]> {
  const out: IndexedFile[] = [];
  for (const [path, text] of Object.entries(files)) {
    out.push((await indexFile(path, text, (candidate) => candidate in all))!);
  }
  return out;
}

async function withAgents(...names: string[]): Promise<{ coordinator: CoordinatorStub; agents: string[] }> {
  const coordinator = await newCoordinator();
  const agents: string[] = [];
  for (const name of names) {
    agents.push(await newAgent(coordinator, name));
  }
  return { coordinator, agents };
}

const change = (target: string) => ({ target, relation: "change" });
const add = (target: string) => ({ target, relation: "add" });
const rely = (target: string) => ({ target, relation: "rely" });

describe("a task's scope", () => {
  it("is what the agent asks for, and the paths it may write are those it changes or adds to", async () => {
    const { coordinator, agents } = await withAgents("agent-one");

    const granted = await coordinator.startTask({
      agentId: agents[0]!,
      goal: "Add a route",
      scope: [change("src/routes/users/get.ts"), add("src/routes/users/index.ts"), rely("src/db/users.ts#findUser")],
    });

    expect(granted).toMatchObject({
      ok: true,
      task: {
        paths: ["src/routes/users/get.ts", "src/routes/users/index.ts"],
        scope: [
          { target: "src/db/users.ts#findUser", relation: "rely", origin: "declared" },
          { target: "src/routes/users/get.ts", relation: "change", origin: "declared" },
          { target: "src/routes/users/index.ts", relation: "add", origin: "declared" },
        ],
        claimExpiresAt: T0 + 120 * MINUTE,
      },
    });
  });

  it("reads a list of paths as paths to change", async () => {
    const { coordinator, agents } = await withAgents("agent-one");

    const granted = await coordinator.startTask({ agentId: agents[0]!, goal: "g", paths: ["src/a.ts"] });

    expect(granted).toMatchObject({ ok: true, task: { scope: [{ target: "src/a.ts", relation: "change", origin: "declared" }] } });
  });

  it("is shown with the task", async () => {
    const { coordinator, agents } = await withAgents("agent-one");
    const granted = await coordinator.startTask({ agentId: agents[0]!, goal: "g", scope: [add("src/app.ts")] });
    if (!granted.ok) {
      throw new Error("expected the scope to be granted");
    }

    const view = await coordinator.getTask({ agentId: agents[0]!, taskId: granted.task.id });

    expect(view).toMatchObject({
      ok: true,
      task: { paths: ["src/app.ts"], scope: [{ target: "src/app.ts", relation: "add", origin: "declared" }], collisions: [] },
    });
  });

  it.each([
    ["an unknown relation", [{ target: "src/a.ts", relation: "own" }], "invalid_input"],
    ["an interface to add to", [add("src/a.ts#f")], "invalid_input"],
    ["a path outside the repository", [change("../x")], "invalid_path"],
    ["nothing", [], "invalid_input"],
  ])("refuses %s", async (_label, scope, code) => {
    const { coordinator, agents } = await withAgents("agent-one");

    expect(await coordinator.startTask({ agentId: agents[0]!, goal: "g", scope })).toMatchObject({ ok: false, error: { code } });
  });
});

describe("what two tasks may hold at once", () => {
  it("lets two tasks add to the same file", async () => {
    const { coordinator, agents } = await withAgents("agent-one", "agent-two");
    await coordinator.startTask({ agentId: agents[0]!, goal: "g1", scope: [add("src/routes/index.ts")] });

    const second = await coordinator.startTask({ agentId: agents[1]!, goal: "g2", scope: [add("src/routes/index.ts")] });

    expect(second.ok).toBe(true);
  });

  it("refuses to change a file another task adds to, and says how it is held", async () => {
    const { coordinator, agents } = await withAgents("agent-one", "agent-two");
    const first = await coordinator.startTask({ agentId: agents[0]!, goal: "g1", scope: [add("src/routes/index.ts")] });
    if (!first.ok) {
      throw new Error("expected the scope to be granted");
    }

    const refused = await coordinator.startTask({ agentId: agents[1]!, goal: "g2", scope: [change("src/routes/")] });

    expect(refused).toMatchObject({
      ok: false,
      error: { code: "conflict", message: "1 path is held by another task", retryable: true },
      conflicts: [{ taskId: first.task.id, paths: ["src/routes/index.ts"], held: [{ target: "src/routes/index.ts", relation: "add" }] }],
    });
  });

  it("lets two tasks change different interfaces of one file, and adds the file to each to add to", async () => {
    const { coordinator, agents } = await withAgents("agent-one", "agent-two");

    const first = await coordinator.startTask({ agentId: agents[0]!, goal: "g1", scope: [change("src/db/users.ts#findUser")] });
    const second = await coordinator.startTask({ agentId: agents[1]!, goal: "g2", scope: [change("src/db/users.ts#listUsers")] });

    expect(first).toMatchObject({
      ok: true,
      task: {
        paths: ["src/db/users.ts"],
        scope: [
          { target: "src/db/users.ts", relation: "add", origin: "inferred" },
          { target: "src/db/users.ts#findUser", relation: "change", origin: "declared" },
        ],
      },
    });
    expect(second.ok).toBe(true);
  });

  it("refuses the same interface to a second task, and the whole file to a third", async () => {
    const { coordinator, agents } = await withAgents("agent-one", "agent-two", "agent-three");
    await coordinator.startTask({ agentId: agents[0]!, goal: "g1", scope: [change("src/db/users.ts#findUser")] });

    const same = await coordinator.startTask({ agentId: agents[1]!, goal: "g2", scope: [change("src/db/users.ts#findUser")] });
    const whole = await coordinator.startTask({ agentId: agents[2]!, goal: "g3", paths: ["src/db/users.ts"] });

    expect(same).toMatchObject({ ok: false, error: { code: "conflict", message: "1 target is held by another task" } });
    expect(whole).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("never refuses a task for what it relies on", async () => {
    const { coordinator, agents } = await withAgents("agent-one", "agent-two");
    await coordinator.startTask({ agentId: agents[0]!, goal: "g1", paths: ["src/db/"] });

    const second = await coordinator.startTask({
      agentId: agents[1]!,
      goal: "g2",
      scope: [change("src/routes/users/get.ts"), rely("src/db/users.ts#findUser")],
    });

    expect(second.ok).toBe(true);
  });

  it("tells a new task what the others hold", async () => {
    const { coordinator, agents } = await withAgents("agent-one", "agent-two");
    await coordinator.startTask({ agentId: agents[0]!, goal: "g1", scope: [add("src/app.ts"), rely("src/db.ts#query")] });

    const second = await coordinator.startTask({ agentId: agents[1]!, goal: "g2", paths: ["src/other.ts"] });

    expect(second).toMatchObject({
      ok: true,
      others: [
        {
          paths: ["src/app.ts"],
          scope: [
            { target: "src/app.ts", relation: "add", origin: "declared" },
            { target: "src/db.ts#query", relation: "rely", origin: "declared" },
          ],
        },
      ],
    });
  });
});

describe("what a task is found to rely on", () => {
  async function setup() {
    const made = await withAgents("agent-one", "agent-two");
    await made.coordinator.indexFiles({ files: await indexed(REPO), removed: [], sha: SHA, reset: true });
    return made;
  }

  it("is what the files it holds use of other files, according to the index", async () => {
    const { coordinator, agents } = await setup();

    const granted = await coordinator.startTask({ agentId: agents[0]!, goal: "g", paths: ["src/routes/users/"] });

    expect(granted).toMatchObject({
      ok: true,
      task: {
        scope: [
          { target: "src/db/users.ts#listUsers", relation: "rely", origin: "inferred" },
          { target: "src/routes/users/", relation: "change", origin: "declared" },
        ],
      },
    });
  });

  it("does not repeat what the agent declared", async () => {
    const { coordinator, agents } = await setup();

    const granted = await coordinator.startTask({
      agentId: agents[0]!,
      goal: "g",
      scope: [change("src/routes/users/list.ts"), rely("src/db/users.ts#listUsers")],
    });

    expect(granted.ok && granted.task.scope.filter((entry) => entry.relation === "rely")).toEqual([
      { target: "src/db/users.ts#listUsers", relation: "rely", origin: "declared" },
    ]);
  });

  it("is nothing when the index has not read the files", async () => {
    const { coordinator, agents } = await setup();

    const granted = await coordinator.startTask({ agentId: agents[0]!, goal: "g", paths: ["src/brand-new.ts"] });

    expect(granted.ok && granted.task.scope).toEqual([{ target: "src/brand-new.ts", relation: "change", origin: "declared" }]);
  });

  it("reports how much the index holds", async () => {
    const { coordinator } = await setup();

    expect((await coordinator.snapshot())?.index).toEqual({ files: 4, interfaces: 4, references: 4 });
  });
});

describe("expandScope", () => {
  it("adds to what the task holds and restarts its clock", async () => {
    const { coordinator, agents } = await withAgents("agent-one");
    const granted = await coordinator.startTask({ agentId: agents[0]!, goal: "g", paths: ["src/a.ts"], ttlMinutes: 30 });
    if (!granted.ok) {
      throw new Error("expected the scope to be granted");
    }
    vi.setSystemTime(T0 + 10 * MINUTE);

    const expanded = await coordinator.expandScope({
      agentId: agents[0]!,
      taskId: granted.task.id,
      scope: [add("src/app.ts"), rely("src/db.ts#query")],
    });

    expect(expanded).toEqual({
      ok: true,
      paths: ["src/a.ts", "src/app.ts"],
      scope: [
        { target: "src/a.ts", relation: "change", origin: "declared" },
        { target: "src/app.ts", relation: "add", origin: "declared" },
        { target: "src/db.ts#query", relation: "rely", origin: "declared" },
      ],
      claimExpiresAt: T0 + 40 * MINUTE,
    });
  });

  it("turns a file held to add to into one held to change", async () => {
    const { coordinator, agents } = await withAgents("agent-one");
    const granted = await coordinator.startTask({ agentId: agents[0]!, goal: "g", scope: [add("src/app.ts")] });
    if (!granted.ok) {
      throw new Error("expected the scope to be granted");
    }

    const expanded = await coordinator.expandScope({ agentId: agents[0]!, taskId: granted.task.id, paths: ["src/app.ts"] });

    expect(expanded).toMatchObject({ ok: true, scope: [{ target: "src/app.ts", relation: "change", origin: "declared" }] });
  });

  it("is refused, and changes nothing, when another task holds what is asked for", async () => {
    const { coordinator, agents } = await withAgents("agent-one", "agent-two");
    await coordinator.startTask({ agentId: agents[0]!, goal: "g1", scope: [add("src/app.ts")] });
    const second = await coordinator.startTask({ agentId: agents[1]!, goal: "g2", paths: ["src/b.ts"] });
    if (!second.ok) {
      throw new Error("expected the scope to be granted");
    }

    const refused = await coordinator.expandScope({ agentId: agents[1]!, taskId: second.task.id, paths: ["src/app.ts", "src/c.ts"] });

    expect(refused).toMatchObject({ ok: false, error: { code: "conflict" }, conflicts: [{ agent: "agent-one" }] });
    expect(await coordinator.getTask({ agentId: agents[1]!, taskId: second.task.id })).toMatchObject({ task: { paths: ["src/b.ts"] } });
  });

  it("finds again what the task relies on, now that it holds more", async () => {
    const { coordinator, agents } = await withAgents("agent-one");
    await coordinator.indexFiles({ files: await indexed(REPO), removed: [], sha: SHA, reset: true });
    const granted = await coordinator.startTask({ agentId: agents[0]!, goal: "g", paths: ["src/routes/users/index.ts"] });
    if (!granted.ok) {
      throw new Error("expected the scope to be granted");
    }
    expect(granted.task.scope.map((entry) => entry.target)).toContain("src/routes/users/list.ts#listUsersRoute");

    const expanded = await coordinator.expandScope({ agentId: agents[0]!, taskId: granted.task.id, paths: ["src/routes/users/list.ts"] });

    // list.ts is the task's own now, so it no longer relies on it; and it relies on what list.ts uses.
    expect(expanded.ok && expanded.scope.filter((entry) => entry.relation === "rely")).toEqual([
      { target: "src/db/users.ts#listUsers", relation: "rely", origin: "inferred" },
    ]);
  });
});
