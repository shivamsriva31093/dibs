import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexFile, type IndexedFile } from "../../src/index/file";
import { signatureHash } from "../../src/index/signature";
import type { InterfaceReport, RepoConfig } from "../../src/types";
import { advanceTime, freezeTime, MINUTE, newAgent, newCoordinator, type CoordinatorStub } from "./helpers/coordinator";

beforeEach(() => freezeTime());
afterEach(() => vi.useRealTimers());

const SEED_SHA = "1".repeat(40);
const BASE = "a".repeat(40);
const USERS = "src/db/users.ts";
const FIND = `${USERS}#findUser`;
const LIST = `${USERS}#listUsers`;
const GET_ROUTE = "src/routes/users/get.ts";

const OLD_FIND = "export function findUser(id: string): User | null";
const NEW_FIND = "export function findUser(id: string): Found";

const REPO: Record<string, string> = {
  [USERS]: `${OLD_FIND} { return null; }\nexport function listUsers(): User[] { return []; }`,
  "src/routes/users/list.ts": 'import { listUsers } from "../../db/users";\nexport const listUsersRoute = 1;',
  "test/users.test.ts": 'import { findUser, listUsers } from "../src/db/users";',
};
const NEW_USERS = `${NEW_FIND} { return { ok: false }; }\nexport function listUsers(): User[] { return []; }`;
const GET_ROUTE_TEXT = 'import { findUser } from "../../db/users";\nexport const getUserRoute = 1;';

async function indexed(files: Record<string, string>, all: Record<string, string> = { ...REPO, [GET_ROUTE]: GET_ROUTE_TEXT }): Promise<IndexedFile[]> {
  const out: IndexedFile[] = [];
  for (const [path, text] of Object.entries(files)) {
    out.push((await indexFile(path, text, (candidate) => candidate in all))!);
  }
  return out;
}

interface Task {
  agentId: string;
  taskId: string;
}

async function setup(...names: string[]): Promise<{ coordinator: CoordinatorStub; agents: Record<string, string> }> {
  return setupWith({}, ...names);
}

async function setupWith(config: Partial<RepoConfig>, ...names: string[]): Promise<{ coordinator: CoordinatorStub; agents: Record<string, string> }> {
  const coordinator = await newCoordinator(config);
  await coordinator.indexFiles({ files: await indexed(REPO), removed: [], sha: SEED_SHA, reset: true });
  const agents: Record<string, string> = {};
  for (const name of names) {
    agents[name] = await newAgent(coordinator, name);
  }
  return { coordinator, agents };
}

type Entry = { target: string; relation: string };
const change = (target: string): Entry => ({ target, relation: "change" });
const add = (target: string): Entry => ({ target, relation: "add" });
const rely = (target: string): Entry => ({ target, relation: "rely" });

async function start(coordinator: CoordinatorStub, agentId: string, scope: Entry[], goal = "a goal"): Promise<Task> {
  const granted = await coordinator.startTask({ agentId, goal, scope });
  if (!granted.ok) {
    throw new Error(`expected the scope to be granted: ${granted.error.message}`);
  }
  await coordinator.attachFork(granted.task.id, BASE);
  return { agentId, taskId: granted.task.id };
}

let heads = 0;
async function submit(coordinator: CoordinatorStub, task: Task, extra: { leaves?: string; confirmDistinct?: boolean } = {}): Promise<number> {
  heads++;
  const submitted = await coordinator.submit({ ...task, summary: "what was done", headSha: heads.toString(16).padStart(40, "0"), ...extra });
  if (!submitted.ok) {
    throw new Error(`expected the submission to be accepted: ${submitted.error.message}`);
  }
  return submitted.submissionId;
}

async function land(coordinator: CoordinatorStub, submissionId: number, mergeSha: string, files: Record<string, string> = {}): Promise<void> {
  await coordinator.recordVerdict(submissionId, { decision: "approve", source: "reviewer", body: {} });
  const merged = await coordinator.recordMerged(submissionId, mergeSha, true, { files: await indexed(files), removed: [] });
  if (!merged.ok) {
    throw new Error(merged.error.message);
  }
}

const collisions = async (coordinator: CoordinatorStub, task: Task) => {
  const view = await coordinator.getTask(task);
  if (!view.ok) {
    throw new Error(view.error.message);
  }
  return view.task.collisions;
};

// What the review of the provider's work reports: it gives findUser another signature and updates the test that uses it.
const PROVIDER_REPORT: InterfaceReport = {
  changedPaths: [USERS, "test/users.test.ts"],
  changed: [{ path: USERS, name: "findUser", kind: "function", change: "changed", before: OLD_FIND, after: NEW_FIND }],
  relied: [],
};

// What the review of the relier's work reports: a new route that uses findUser as it was at the fork's base.
const relierReport = async (signature = OLD_FIND): Promise<InterfaceReport> => ({
  changedPaths: [GET_ROUTE],
  changed: [{ path: GET_ROUTE, name: "getUserRoute", kind: "const", change: "added", after: "export const getUserRoute" }],
  relied: [{ target: FIND, hash: await signatureHash(signature) }],
});

const MERGE_ONE = "c".repeat(40);
const MERGE_TWO = "d".repeat(40);

describe("two tasks that meet at an interface", () => {
  it("are both told when one says it will change what the other relies on", async () => {
    const { coordinator, agents } = await setup("five", "one");
    const provider = await start(coordinator, agents.five!, [change(FIND)], "Make findUser return a result");

    const relier = await start(coordinator, agents.one!, [change(GET_ROUTE), rely(FIND)], "Add GET /users/:id");

    expect(await collisions(coordinator, relier)).toEqual([
      {
        id: expect.stringMatching(/^c-[a-z0-9]{8}$/),
        kind: "contract",
        state: "open",
        role: "relier",
        with: { taskId: provider.taskId, agent: "five", goal: "Make findUser return a result", state: "active", mergeSha: null },
        targets: [FIND],
        order: { first: "five", why: expect.stringContaining("neither task has submitted") },
        brief: expect.stringContaining("five is changing src/db/users.ts#findUser, which your work uses."),
      },
    ]);
    expect(await collisions(coordinator, provider)).toMatchObject([
      { kind: "contract", state: "open", role: "provider", with: { agent: "one" }, targets: [FIND], order: { first: "five" } },
    ]);
  });

  it("are recorded once as an event, with both sides", async () => {
    const { coordinator, agents } = await setup("five", "one");
    const provider = await start(coordinator, agents.five!, [change(FIND)]);
    const relier = await start(coordinator, agents.one!, [change(GET_ROUTE), rely(FIND)]);

    const events = (await coordinator.listEvents()).filter((event) => event.type === "collision");

    expect(events).toMatchObject([
      {
        taskId: relier.taskId,
        body: {
          kind: "contract",
          state: "open",
          target: FIND,
          provider: { taskId: provider.taskId, agent: "five" },
          relier: { taskId: relier.taskId, agent: "one" },
        },
      },
    ]);
  });

  it("are told whichever of them comes second", async () => {
    const { coordinator, agents } = await setup("five", "one");
    const relier = await start(coordinator, agents.one!, [change(GET_ROUTE), rely(FIND)]);

    const provider = await start(coordinator, agents.five!, [change(FIND)]);

    expect(await collisions(coordinator, relier)).toMatchObject([{ role: "relier", state: "open", with: { agent: "five" } }]);
    expect(await collisions(coordinator, provider)).toMatchObject([{ role: "provider", state: "open", with: { agent: "one" } }]);
  });

  it("are only watched when one holds the file and has not said what it will change", async () => {
    const { coordinator, agents } = await setup("five", "one");
    await start(coordinator, agents.five!, [change(USERS)]);

    // The index knows that list.ts uses listUsers; the agent did not have to say so.
    const relier = await start(coordinator, agents.one!, [change("src/routes/users/list.ts")]);

    expect(await collisions(coordinator, relier)).toMatchObject([
      {
        kind: "contract",
        state: "possible",
        role: "relier",
        with: { agent: "five" },
        targets: [LIST],
        order: null,
        brief: expect.stringContaining("There is nothing to do"),
      },
    ]);
  });

  it("are not connected when what one changes is not what the other uses", async () => {
    const { coordinator, agents } = await setup("five", "one");
    await start(coordinator, agents.five!, [change(FIND)]);

    const other = await start(coordinator, agents.one!, [change("src/routes/users/list.ts")]);

    expect(await collisions(coordinator, other)).toEqual([]);
  });

  it("are told again when a task comes to rely on more", async () => {
    const { coordinator, agents } = await setup("five", "one");
    await start(coordinator, agents.five!, [change(FIND)]);
    const relier = await start(coordinator, agents.one!, [change(GET_ROUTE)]);
    expect(await collisions(coordinator, relier)).toEqual([]);

    await coordinator.expandScope({ ...relier, scope: [rely(FIND)] });

    expect(await collisions(coordinator, relier)).toMatchObject([{ state: "open", role: "relier" }]);
  });

  it("stop being connected when one of them gives up", async () => {
    const { coordinator, agents } = await setup("five", "one");
    const provider = await start(coordinator, agents.five!, [change(FIND)]);
    const relier = await start(coordinator, agents.one!, [change(GET_ROUTE), rely(FIND)]);

    await coordinator.abandon(provider);

    expect(await collisions(coordinator, relier)).toEqual([]);
    expect((await coordinator.listEvents()).at(-1)).toMatchObject({ type: "collision_resolved", body: { how: "ended" } });
  });

  it("stop being connected when a scope runs out", async () => {
    const { coordinator, agents } = await setup("five", "one");
    await start(coordinator, agents.five!, [change(FIND)]);
    const relier = await start(coordinator, agents.one!, [change(GET_ROUTE), rely(FIND)]);
    await coordinator.expandScope({ ...relier, paths: ["README.md"] });

    advanceTime(121 * MINUTE);

    expect(await collisions(coordinator, relier)).toEqual([]);
  });
});

describe("what a review finds about interfaces", () => {
  it("turns a watched collision into an open one when the holder did change what the other uses", async () => {
    const { coordinator, agents } = await setup("five", "one");
    const provider = await start(coordinator, agents.five!, [change(USERS)]);
    const relier = await start(coordinator, agents.one!, [change("src/routes/users/list.ts")]);
    const submissionId = await submit(coordinator, provider);

    await coordinator.recordInterfaces(submissionId, {
      changedPaths: [USERS, "src/routes/users/list.ts"],
      changed: [{ path: USERS, name: "listUsers", kind: "function", change: "changed", before: "a", after: "b" }],
      relied: [],
    });

    expect(await collisions(coordinator, relier)).toMatchObject([{ state: "open", targets: [LIST], order: { first: "five" } }]);
  });

  it("adds what it found to the task's scope", async () => {
    const { coordinator, agents } = await setup("five");
    const provider = await start(coordinator, agents.five!, [change(USERS), change("test/users.test.ts")]);
    const submissionId = await submit(coordinator, provider);

    await coordinator.recordInterfaces(submissionId, { ...PROVIDER_REPORT, relied: [{ target: "src/db/client.ts#db", hash: null }] });

    const view = await coordinator.getTask(provider);
    expect(view.ok && view.task.scope.filter((entry) => entry.origin === "detected")).toEqual([
      { target: "src/db/client.ts#db", relation: "rely", origin: "detected" },
      { target: FIND, relation: "change", origin: "detected" },
    ]);
  });

  it("is kept with the submission, with what the agent said about the files it leaves", async () => {
    const { coordinator, agents } = await setup("five");
    const provider = await start(coordinator, agents.five!, [change(USERS)]);
    const submissionId = await submit(coordinator, provider, { leaves: "  the test only checks for null  " });

    expect(await coordinator.getSubmission(submissionId)).toMatchObject({ interfaces: null, leaves: "the test only checks for null" });
    await coordinator.recordInterfaces(submissionId, PROVIDER_REPORT);

    expect(await coordinator.getSubmission(submissionId)).toMatchObject({ interfaces: PROVIDER_REPORT, collisions: [] });
  });
});

describe("a submission that relies on what has moved", () => {
  // The provider lands a new findUser; the relier's fork still has the old one.
  async function providerLands(config: Partial<RepoConfig> = {}) {
    const made = await setupWith(config, "five", "one");
    const { coordinator, agents } = made;
    const provider = await start(coordinator, agents.five!, [change(FIND), change("test/users.test.ts")], "Make findUser return a result");
    const relier = await start(coordinator, agents.one!, [change(GET_ROUTE), rely(FIND)], "Add GET /users/:id");
    const providerSubmission = await submit(coordinator, provider);
    await coordinator.recordInterfaces(providerSubmission, PROVIDER_REPORT);
    await land(coordinator, providerSubmission, MERGE_ONE, { [USERS]: NEW_USERS });
    return { ...made, provider, relier };
  }

  it("is told so before it is reviewed", async () => {
    const { coordinator, relier } = await providerLands();
    const submissionId = await submit(coordinator, relier);

    const report = await coordinator.recordInterfaces(submissionId, await relierReport());

    expect(report).toEqual({
      indexed: true,
      moved: [{ target: FIND, now: NEW_FIND, since: MERGE_ONE, by: "five" }],
      unupdated: [],
      held: [],
      leaves: null,
    });
  });

  it("tells the relier to adapt once the provider has landed", async () => {
    const { coordinator, provider, relier } = await providerLands();

    expect(await collisions(coordinator, relier)).toMatchObject([
      {
        state: "open",
        role: "relier",
        with: { taskId: provider.taskId, state: "merged", mergeSha: MERGE_ONE },
        order: { first: "five", why: "it has landed" },
        brief: "src/db/users.ts#findUser changed on the main branch when five's task landed (ccccccc). Call sync_with_main, change your code to fit, run the tests, and submit.",
      },
    ]);
  });

  it("is sent back when it is about to land", async () => {
    const { coordinator, relier } = await providerLands();
    const submissionId = await submit(coordinator, relier);
    await coordinator.recordInterfaces(submissionId, await relierReport());

    const confirmed = await coordinator.confirmContracts(submissionId);

    expect(confirmed).toMatchObject({ ok: false, escalated: false, report: { moved: [{ target: FIND }] } });
    expect(await coordinator.getTask(relier)).toMatchObject({
      task: {
        state: "active",
        cycle: 2,
        verdict: {
          decision: "reject",
          source: "merge",
          body: {
            contract: { moved: [{ target: FIND, by: "five" }] },
            message: expect.stringContaining("Call sync_with_main, change your code to fit"),
          },
        },
      },
    });
    expect((await coordinator.listEvents()).at(-1)).toMatchObject({ type: "contract", taskId: relier.taskId });
  });

  it("is sent back once however often it is asked about", async () => {
    const { coordinator, relier } = await providerLands();
    const submissionId = await submit(coordinator, relier);
    await coordinator.recordInterfaces(submissionId, await relierReport());

    await coordinator.confirmContracts(submissionId);
    await coordinator.confirmContracts(submissionId);

    expect(await coordinator.getTask(relier)).toMatchObject({ task: { cycle: 2 } });
  });

  // A send-back at landing is an attempt like any other.
  it("goes to a person instead on its last allowed attempt", async () => {
    const { coordinator, relier } = await providerLands({ maxCycles: 1 });
    const submissionId = await submit(coordinator, relier);
    await coordinator.recordInterfaces(submissionId, await relierReport());
    await coordinator.acquireMergeLock(relier.taskId);

    const confirmed = await coordinator.confirmContracts(submissionId);

    expect(confirmed).toMatchObject({ ok: false, escalated: true, report: { moved: [{ target: FIND }] } });
    expect(await coordinator.getTask(relier)).toMatchObject({
      task: {
        state: "escalated",
        cycle: 1,
        verdict: {
          decision: "escalate",
          source: "merge",
          body: {
            contract: { moved: [{ target: FIND, by: "five" }] },
            message: expect.stringContaining("Call sync_with_main, change your code to fit"),
            reasons: [{ kind: "max_cycles", detail: "rejected on cycle 1 of 1" }],
          },
        },
      },
    });
    expect((await coordinator.listEvents()).at(-1)).toMatchObject({
      type: "escalated",
      taskId: relier.taskId,
      body: { source: "merge", decision: "escalate", verdict: { reasons: [{ kind: "max_cycles" }] } },
    });
    expect(await coordinator.acquireMergeLock("t-anyone00")).toBe(true);
  });

  it("goes to a person once however often it is asked about", async () => {
    const { coordinator, relier } = await providerLands({ maxCycles: 1 });
    const submissionId = await submit(coordinator, relier);
    await coordinator.recordInterfaces(submissionId, await relierReport());

    await coordinator.confirmContracts(submissionId);

    expect(await coordinator.confirmContracts(submissionId)).toMatchObject({ ok: false, escalated: true });
    expect((await coordinator.listEvents()).filter((event) => event.type === "escalated")).toHaveLength(1);
  });

  it("lands once it has been written against the new shape, and the collision is over", async () => {
    const { coordinator, provider, relier } = await providerLands();
    const submissionId = await submit(coordinator, relier);

    const report = await coordinator.recordInterfaces(submissionId, await relierReport(NEW_FIND));

    expect(report?.moved).toEqual([]);
    expect(await coordinator.confirmContracts(submissionId)).toEqual({ ok: true });
    expect(await collisions(coordinator, relier)).toEqual([]);
    await land(coordinator, submissionId, MERGE_TWO, { [GET_ROUTE]: GET_ROUTE_TEXT });
    expect(await collisions(coordinator, provider)).toEqual([]);
  });

  it("passes when the index has not read the file, because nothing can be said", async () => {
    const { coordinator, relier } = await providerLands();
    const submissionId = await submit(coordinator, relier);

    const report = await coordinator.recordInterfaces(submissionId, {
      changedPaths: [GET_ROUTE],
      changed: [],
      relied: [{ target: "lib/unread.py#helper", hash: await signatureHash("def helper()") }],
    });

    expect(report?.moved).toEqual([]);
  });

  it("is told when it relies on something that was not there when it branched off", async () => {
    const { coordinator, relier } = await providerLands();
    const submissionId = await submit(coordinator, relier);

    const report = await coordinator.recordInterfaces(submissionId, { changedPaths: [GET_ROUTE], changed: [], relied: [{ target: FIND, hash: null }] });

    expect(report?.moved).toMatchObject([{ target: FIND, now: NEW_FIND }]);
  });

  it("does not hold a task to what its own change replaces", async () => {
    const { coordinator, relier } = await providerLands();
    const submissionId = await submit(coordinator, relier);

    const report = await coordinator.recordInterfaces(submissionId, {
      changedPaths: [GET_ROUTE, USERS],
      changed: [],
      relied: [{ target: FIND, hash: await signatureHash(OLD_FIND) }],
    });

    expect(report?.moved).toEqual([]);
  });
});

describe("a submission that alters what others use", () => {
  // The relier lands a route that uses findUser as it is; the provider's fork does not have that route.
  async function relierLands() {
    const made = await setup("five", "one", "two");
    const { coordinator, agents } = made;
    const provider = await start(coordinator, agents.five!, [change(FIND), change("test/users.test.ts")]);
    const relier = await start(coordinator, agents.one!, [change(GET_ROUTE), rely(FIND)]);
    const relierSubmission = await submit(coordinator, relier);
    await coordinator.recordInterfaces(relierSubmission, await relierReport());
    await land(coordinator, relierSubmission, MERGE_ONE, { [GET_ROUTE]: GET_ROUTE_TEXT });
    return { ...made, provider, relier };
  }

  it("is told which files use it and are not part of the change", async () => {
    const { coordinator, provider } = await relierLands();
    const submissionId = await submit(coordinator, provider);

    const report = await coordinator.recordInterfaces(submissionId, PROVIDER_REPORT);

    expect(report).toEqual({
      indexed: true,
      moved: [],
      unupdated: [{ target: FIND, change: "changed", files: [{ path: GET_ROUTE, heldBy: null }] }],
      held: [],
      leaves: null,
    });
  });

  it("tells the provider to take over the code that landed before it", async () => {
    const { coordinator, provider } = await relierLands();

    expect(await collisions(coordinator, provider)).toMatchObject([
      { state: "open", role: "provider", with: { state: "merged", mergeSha: MERGE_ONE }, brief: expect.stringContaining("landed code that uses") },
    ]);
  });

  it("is sent back when it is about to land", async () => {
    const { coordinator, provider } = await relierLands();
    const submissionId = await submit(coordinator, provider);
    await coordinator.recordInterfaces(submissionId, PROVIDER_REPORT);

    expect(await coordinator.confirmContracts(submissionId)).toMatchObject({ ok: false });
    expect(await coordinator.getTask(provider)).toMatchObject({
      task: { state: "active", cycle: 2, verdict: { source: "merge", body: { message: expect.stringContaining("add the files to your scope") } } },
    });
  });

  it("says who holds a file that uses it", async () => {
    const { coordinator, agents, provider } = await relierLands();
    await start(coordinator, agents.two!, [change(GET_ROUTE)]);
    const submissionId = await submit(coordinator, provider);

    const report = await coordinator.recordInterfaces(submissionId, PROVIDER_REPORT);

    expect(report?.unupdated).toEqual([{ target: FIND, change: "changed", files: [{ path: GET_ROUTE, heldBy: "two" }] }]);
  });

  it("lands once the files that use it are part of the change, and the collision is over", async () => {
    const { coordinator, provider } = await relierLands();
    const submissionId = await submit(coordinator, provider);

    const report = await coordinator.recordInterfaces(submissionId, { ...PROVIDER_REPORT, changedPaths: [...PROVIDER_REPORT.changedPaths, GET_ROUTE] });

    expect(report?.unupdated).toEqual([]);
    expect(await coordinator.confirmContracts(submissionId)).toEqual({ ok: true });
    expect(await collisions(coordinator, provider)).toEqual([]);
  });

  it("is not sent back when the agent says why the files need no change", async () => {
    const { coordinator, provider } = await relierLands();
    const submissionId = await submit(coordinator, provider, { leaves: "the route only passes the result on" });

    const report = await coordinator.recordInterfaces(submissionId, PROVIDER_REPORT);

    expect(report).toMatchObject({ unupdated: [{ target: FIND }], leaves: "the route only passes the result on" });
    expect(await coordinator.confirmContracts(submissionId)).toEqual({ ok: true });
  });

  it("does not count an interface that the change only adds", async () => {
    const { coordinator, provider } = await relierLands();
    const submissionId = await submit(coordinator, provider);

    const report = await coordinator.recordInterfaces(submissionId, {
      changedPaths: [USERS],
      changed: [{ path: USERS, name: "createUser", kind: "function", change: "added", after: "export function createUser()" }],
      relied: [],
    });

    expect(report?.unupdated).toEqual([]);
  });
});

describe("whether the index can speak for a change", () => {
  it("can when it has read the repository and the change touches code it can read", async () => {
    const { coordinator, agents } = await setup("one");
    const task = await start(coordinator, agents.one!, [change(USERS)]);
    const submissionId = await submit(coordinator, task);

    expect(await coordinator.recordInterfaces(submissionId, { changedPaths: [USERS], changed: [], relied: [] })).toMatchObject({ indexed: true });
  });

  it("cannot when the change touches no code it can read", async () => {
    const { coordinator, agents } = await setup("one");
    const task = await start(coordinator, agents.one!, [change("README.md")]);
    const submissionId = await submit(coordinator, task);

    expect(await coordinator.recordInterfaces(submissionId, { changedPaths: ["README.md"], changed: [], relied: [] })).toMatchObject({ indexed: false });
  });

  it("cannot when it has not read the repository", async () => {
    const coordinator = await newCoordinator();
    const task = await start(coordinator, await newAgent(coordinator, "one"), [change(USERS)]);
    const submissionId = await submit(coordinator, task);

    expect(await coordinator.recordInterfaces(submissionId, { changedPaths: [USERS], changed: [], relied: [] })).toMatchObject({ indexed: false });
  });
});

describe("a watched collision", () => {
  it("is over when the holder lands without changing what the other uses", async () => {
    const { coordinator, agents } = await setup("five", "one");
    const provider = await start(coordinator, agents.five!, [change(USERS), change("test/users.test.ts")]);
    const relier = await start(coordinator, agents.one!, [change("src/routes/users/list.ts")]);
    const submissionId = await submit(coordinator, provider);
    await coordinator.recordInterfaces(submissionId, PROVIDER_REPORT);
    expect(await collisions(coordinator, relier)).toMatchObject([{ state: "possible" }]);

    await land(coordinator, submissionId, MERGE_ONE, { [USERS]: NEW_USERS });

    expect(await collisions(coordinator, relier)).toEqual([]);
    expect((await coordinator.listEvents()).filter((event) => event.type === "collision_resolved")).toMatchObject([{ body: { how: "no change" } }]);
  });
});

describe("an interface in a shared file", () => {
  it("cannot be altered by a task while another task holds it", async () => {
    const { coordinator, agents } = await setup("one", "two");
    const holder = await start(coordinator, agents.one!, [change(FIND)]);
    const sharer = await start(coordinator, agents.two!, [add(USERS)]);
    const submissionId = await submit(coordinator, sharer);

    const report = await coordinator.recordInterfaces(submissionId, { ...PROVIDER_REPORT, changedPaths: [USERS, "test/users.test.ts", GET_ROUTE] });

    expect(report?.held).toEqual([{ target: FIND, by: "one", taskId: holder.taskId }]);
    expect(await coordinator.confirmContracts(submissionId)).toMatchObject({ ok: false });
  });

  it("becomes the task's own when nobody else holds it", async () => {
    const { coordinator, agents } = await setup("one", "two");
    await start(coordinator, agents.one!, [change(LIST)]);
    const sharer = await start(coordinator, agents.two!, [add(USERS), add("test/users.test.ts")]);
    const submissionId = await submit(coordinator, sharer);

    const report = await coordinator.recordInterfaces(submissionId, PROVIDER_REPORT);

    expect(report?.held).toEqual([]);
    const view = await coordinator.getTask(sharer);
    expect(view.ok && view.task.scope).toContainEqual({ target: FIND, relation: "change", origin: "detected" });
  });
});

describe("two tasks doing the same work", () => {
  async function duplicates() {
    const made = await setup("one", "two");
    const { coordinator, agents } = made;
    const earlier = await start(coordinator, agents.one!, [change("src/a.ts")], "Add rate limiting");
    const later = await start(coordinator, agents.two!, [change("src/b.ts")], "Limit request rates");
    await coordinator.recordRelated(later.taskId, [{ taskId: earlier.taskId, relation: "duplicate", confidence: 0.8 }]);
    return { ...made, earlier, later };
  }

  it("are both told, and the later one is asked to say that it differs or to stop", async () => {
    const { coordinator, earlier, later } = await duplicates();

    expect(await collisions(coordinator, later)).toMatchObject([
      { kind: "duplicate", state: "open", role: "relier", with: { agent: "one" }, targets: [], order: null, brief: expect.stringContaining("confirm_distinct") },
    ]);
    expect(await collisions(coordinator, earlier)).toMatchObject([{ kind: "duplicate", role: "provider", brief: expect.stringContaining("nothing to do") }]);
  });

  it("hold the later one back from submitting until it says that it differs", async () => {
    const { coordinator, later } = await duplicates();

    const refused = await coordinator.submit({ ...later, summary: "s", headSha: "9".repeat(40) });

    expect(refused).toMatchObject({
      ok: false,
      error: { code: "duplicate", message: expect.stringContaining("one started what looks like the same work before you"), retryable: false },
    });
  });

  it("let the later one submit once it says that it differs, and the collision is over", async () => {
    const { coordinator, earlier, later } = await duplicates();

    await submit(coordinator, later, { confirmDistinct: true });

    expect(await collisions(coordinator, later)).toEqual([]);
    expect(await collisions(coordinator, earlier)).toEqual([]);
  });

  it("do not hold the earlier one back", async () => {
    const { coordinator, earlier } = await duplicates();

    expect((await coordinator.submit({ ...earlier, summary: "s", headSha: "9".repeat(40) })).ok).toBe(true);
  });

  it("are not held back for work that is only coupled", async () => {
    const { coordinator, agents } = await setup("one", "two");
    const first = await start(coordinator, agents.one!, [change("src/a.ts")]);
    const second = await start(coordinator, agents.two!, [change("src/b.ts")]);
    await coordinator.recordRelated(second.taskId, [{ taskId: first.taskId, relation: "coupled", confidence: 0.8 }]);

    expect(await collisions(coordinator, second)).toEqual([]);
    expect((await coordinator.submit({ ...second, summary: "s", headSha: "9".repeat(40) })).ok).toBe(true);
  });
});

describe("reading another task's work", () => {
  it("is allowed between two tasks that meet", async () => {
    const { coordinator, agents } = await setup("five", "one");
    const provider = await start(coordinator, agents.five!, [change(FIND)], "Make findUser return a result");
    const relier = await start(coordinator, agents.one!, [change(GET_ROUTE), rely(FIND)]);
    await submit(coordinator, provider);

    expect(await coordinator.peekInfo({ ...relier, otherTaskId: provider.taskId })).toEqual({
      ok: true,
      other: {
        taskId: provider.taskId,
        agent: "five",
        goal: "Make findUser return a result",
        state: "in_review",
        forkName: `demo-app--${provider.taskId}`,
        baseSha: BASE,
        summary: "what was done",
      },
    });
  });

  it("is allowed between tasks the decision model connected", async () => {
    const { coordinator, agents } = await setup("one", "two");
    const first = await start(coordinator, agents.one!, [change("src/a.ts")]);
    const second = await start(coordinator, agents.two!, [change("src/b.ts")]);
    await coordinator.recordRelated(second.taskId, [{ taskId: first.taskId, relation: "coupled", confidence: 0.8 }]);

    expect(await coordinator.peekInfo({ ...first, otherTaskId: second.taskId })).toMatchObject({ ok: true, other: { agent: "two", summary: null } });
  });

  it("is refused between tasks that have nothing to do with each other", async () => {
    const { coordinator, agents } = await setup("one", "two");
    const first = await start(coordinator, agents.one!, [change("src/a.ts")]);
    const second = await start(coordinator, agents.two!, [change("src/b.ts")]);

    expect(await coordinator.peekInfo({ ...first, otherTaskId: second.taskId })).toMatchObject({
      ok: false,
      error: { code: "not_found", message: `task ${second.taskId} is not connected with this task` },
    });
  });

  it("is refused for a task that belongs to another agent", async () => {
    const { coordinator, agents } = await setup("one", "two");
    const first = await start(coordinator, agents.one!, [change("src/a.ts")]);
    const second = await start(coordinator, agents.two!, [change("src/b.ts")]);

    expect(await coordinator.peekInfo({ agentId: agents.two!, taskId: first.taskId, otherTaskId: second.taskId })).toMatchObject({
      ok: false,
      error: { code: "not_owner" },
    });
  });
});
