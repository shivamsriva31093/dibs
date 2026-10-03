import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceTime, freezeTime, MINUTE, newAgent, newCoordinator, T0, type CoordinatorStub } from "./helpers/coordinator";

beforeEach(() => freezeTime());
afterEach(() => vi.useRealTimers());

const SECOND = 1000;

interface Started {
  agentId: string;
  taskId: string;
}

async function setup(...names: string[]): Promise<{ coordinator: CoordinatorStub; agents: Record<string, string> }> {
  const coordinator = await newCoordinator();
  const agents: Record<string, string> = {};
  for (const name of names) {
    agents[name] = await newAgent(coordinator, name);
  }
  return { coordinator, agents };
}

async function start(coordinator: CoordinatorStub, agentId: string, paths: string[]): Promise<Started> {
  const granted = await coordinator.startTask({ agentId, goal: `work on ${paths.join(", ")}`, paths });
  if (!granted.ok) {
    throw new Error(`expected ${paths.join(", ")} to be granted: ${granted.error.message}`);
  }
  return { agentId, taskId: granted.task.id };
}

// Starts a task that has to wait, and returns its place in line.
async function wait(coordinator: CoordinatorStub, agentId: string, paths: string[]): Promise<string> {
  const refused = await coordinator.startTask({ agentId, goal: `work on ${paths.join(", ")}`, paths, wait: true });
  if (refused.ok || refused.waiting === undefined) {
    throw new Error("expected the request to wait");
  }
  return refused.waiting.requestId;
}

describe("a request that waits", () => {
  it("is told its place in line and who it waits for, and holds nothing", async () => {
    const { coordinator, agents } = await setup("one", "two", "three");
    const holder = await start(coordinator, agents.one!, ["src/a.ts"]);

    const refused = await coordinator.startTask({ agentId: agents.two!, goal: "g2", paths: ["src/a.ts", "src/b.ts"], wait: true });

    expect(refused).toMatchObject({
      ok: false,
      error: { code: "conflict", retryable: true },
      conflicts: [{ taskId: holder.taskId, agent: "one", paths: ["src/a.ts"] }],
      waiting: { requestId: expect.stringMatching(/^w-[a-z0-9]{8}$/), position: 1 },
    });
    // What it waits for is not held for it meanwhile.
    expect((await coordinator.startTask({ agentId: agents.three!, goal: "g3", paths: ["src/b.ts"] })).ok).toBe(true);
  });

  it("is refused outright when it does not ask to wait", async () => {
    const { coordinator, agents } = await setup("one", "two");
    await start(coordinator, agents.one!, ["src/a.ts"]);

    const refused = await coordinator.startTask({ agentId: agents.two!, goal: "g2", paths: ["src/a.ts"] });

    expect(refused).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(!refused.ok && refused.waiting).toBeUndefined();
  });

  it("is still waiting when asked about, with the task it waits for", async () => {
    const { coordinator, agents } = await setup("one", "two");
    const holder = await start(coordinator, agents.one!, ["src/a.ts"]);
    const requestId = await wait(coordinator, agents.two!, ["src/a.ts"]);

    expect(await coordinator.pollRequest({ agentId: agents.two!, requestId })).toEqual({
      status: "waiting",
      requestId,
      position: 1,
      conflicts: [expect.objectContaining({ taskId: holder.taskId, agent: "one" })],
    });
  });

  it("is granted the moment the holder gives its paths up", async () => {
    const { coordinator, agents } = await setup("one", "two");
    const holder = await start(coordinator, agents.one!, ["src/a.ts"]);
    const requestId = await wait(coordinator, agents.two!, ["src/a.ts"]);
    advanceTime(10 * SECOND);

    await coordinator.abandon(holder);
    const polled = await coordinator.pollRequest({ agentId: agents.two!, requestId });

    expect(polled).toMatchObject({
      status: "granted",
      task: { id: expect.stringMatching(/^t-/), paths: ["src/a.ts"], claimExpiresAt: T0 + 10 * SECOND + 120 * MINUTE },
      others: [],
    });
    expect((await coordinator.listEvents()).map((event) => event.type)).toEqual([
      "task_started",
      "claim_conflict",
      "waiting",
      "abandoned",
      "task_started",
    ]);
  });

  it("is granted when the holder's work lands", async () => {
    const { coordinator, agents } = await setup("one", "two");
    const holder = await start(coordinator, agents.one!, ["src/a.ts"]);
    await coordinator.attachFork(holder.taskId, "a".repeat(40));
    const submitted = await coordinator.submit({ ...holder, summary: "s", headSha: "b".repeat(40) });
    if (!submitted.ok) {
      throw new Error("expected the submission to be accepted");
    }
    const requestId = await wait(coordinator, agents.two!, ["src/a.ts"]);
    await coordinator.recordVerdict(submitted.submissionId, { decision: "approve", source: "reviewer", body: {} });

    await coordinator.recordMerged(submitted.submissionId, "c".repeat(40), true);

    expect(await coordinator.pollRequest({ agentId: agents.two!, requestId })).toMatchObject({ status: "granted" });
  });

  it("is granted when the holder's scope expires, without any call", async () => {
    const { coordinator, agents } = await setup("one", "two");
    await coordinator.startTask({ agentId: agents.one!, goal: "g1", paths: ["src/a.ts"], ttlMinutes: 1 });
    const requestId = await wait(coordinator, agents.two!, ["src/a.ts"]);

    // The waiting agent keeps asking; the holder's minute passes.
    for (let asked = 0; asked < 2; asked++) {
      advanceTime(25 * SECOND);
      expect(await coordinator.pollRequest({ agentId: agents.two!, requestId })).toMatchObject({ status: "waiting" });
    }
    advanceTime(25 * SECOND);

    expect(await coordinator.pollRequest({ agentId: agents.two!, requestId })).toMatchObject({ status: "granted" });
  });

  it("is forgotten once it has been answered with its task", async () => {
    const { coordinator, agents } = await setup("one", "two");
    const holder = await start(coordinator, agents.one!, ["src/a.ts"]);
    const requestId = await wait(coordinator, agents.two!, ["src/a.ts"]);
    await coordinator.abandon(holder);
    await coordinator.pollRequest({ agentId: agents.two!, requestId });

    expect(await coordinator.pollRequest({ agentId: agents.two!, requestId })).toMatchObject({ status: "gone" });
  });

  it("is not answered to another agent", async () => {
    const { coordinator, agents } = await setup("one", "two", "three");
    await start(coordinator, agents.one!, ["src/a.ts"]);
    const requestId = await wait(coordinator, agents.two!, ["src/a.ts"]);

    expect(await coordinator.pollRequest({ agentId: agents.three!, requestId })).toMatchObject({ status: "gone" });
  });
});

describe("the line", () => {
  it("serves the request that arrived first", async () => {
    const { coordinator, agents } = await setup("one", "two", "three");
    const holder = await start(coordinator, agents.one!, ["src/a.ts"]);
    const first = await wait(coordinator, agents.two!, ["src/a.ts"]);
    advanceTime(SECOND);
    const second = await wait(coordinator, agents.three!, ["src/a.ts"]);

    expect(await coordinator.pollRequest({ agentId: agents.three!, requestId: second })).toMatchObject({ status: "waiting", position: 2 });
    await coordinator.abandon(holder);

    expect(await coordinator.pollRequest({ agentId: agents.two!, requestId: first })).toMatchObject({ status: "granted" });
    expect(await coordinator.pollRequest({ agentId: agents.three!, requestId: second })).toMatchObject({
      status: "waiting",
      position: 1,
      conflicts: [{ agent: "two" }],
    });
  });

  it("serves a later request first when the earlier one still cannot be served", async () => {
    const { coordinator, agents } = await setup("one", "two", "three", "four");
    const holdsA = await start(coordinator, agents.one!, ["src/a.ts"]);
    await start(coordinator, agents.two!, ["src/b.ts"]);
    const wantsBoth = await wait(coordinator, agents.three!, ["src/a.ts", "src/b.ts"]);
    const wantsA = await wait(coordinator, agents.four!, ["src/a.ts"]);

    await coordinator.abandon(holdsA);

    expect(await coordinator.pollRequest({ agentId: agents.three!, requestId: wantsBoth })).toMatchObject({ status: "waiting" });
    expect(await coordinator.pollRequest({ agentId: agents.four!, requestId: wantsA })).toMatchObject({ status: "granted" });
  });

  it("drops a request whose agent has stopped asking", async () => {
    const { coordinator, agents } = await setup("one", "two");
    const holder = await start(coordinator, agents.one!, ["src/a.ts"]);
    const requestId = await wait(coordinator, agents.two!, ["src/a.ts"]);

    advanceTime(4 * MINUTE);
    await coordinator.abandon(holder);

    expect(await coordinator.pollRequest({ agentId: agents.two!, requestId })).toEqual({
      status: "gone",
      reason: "this request is no longer waiting: it was not asked about for three minutes, or it has been answered. Make the request again.",
    });
    expect((await coordinator.snapshot())?.tasks.filter((task) => task.state === "active")).toEqual([]);
  });

  it("gives a task that was granted from the line three minutes to be picked up", async () => {
    const { coordinator, agents } = await setup("one", "two", "three");
    const holder = await start(coordinator, agents.one!, ["src/a.ts"]);
    const first = await wait(coordinator, agents.two!, ["src/a.ts"]);
    const second = await wait(coordinator, agents.three!, ["src/a.ts"]);
    await coordinator.abandon(holder);

    // The first agent never comes back for its task. The second keeps asking.
    for (let asked = 0; asked < 7; asked++) {
      advanceTime(25 * SECOND);
      expect(await coordinator.pollRequest({ agentId: agents.three!, requestId: second })).toMatchObject({ status: "waiting" });
    }
    advanceTime(25 * SECOND);

    expect(await coordinator.pollRequest({ agentId: agents.three!, requestId: second })).toMatchObject({ status: "granted" });
    expect(await coordinator.pollRequest({ agentId: agents.two!, requestId: first })).toMatchObject({ status: "gone" });
  });

  it("gives a picked-up task its whole lifetime from the moment its fork is ready", async () => {
    const { coordinator, agents } = await setup("one", "two");
    const holder = await start(coordinator, agents.one!, ["src/a.ts"]);
    const requestId = await wait(coordinator, agents.two!, ["src/a.ts"]);
    await coordinator.abandon(holder);
    const polled = await coordinator.pollRequest({ agentId: agents.two!, requestId });
    if (polled.status !== "granted" || !("task" in polled)) {
      throw new Error("expected the request to be granted");
    }
    advanceTime(20 * SECOND);

    await coordinator.attachFork(polled.task.id, "a".repeat(40));

    expect(await coordinator.getTask({ agentId: agents.two!, taskId: polled.task.id })).toMatchObject({
      task: { state: "active", claimExpiresAt: T0 + 20 * SECOND + 120 * MINUTE },
    });
  });

  it("wakes by itself to drop a request and to take back a task nobody picked up", async () => {
    const { coordinator, agents } = await setup("one", "two");
    const holder = await start(coordinator, agents.one!, ["src/a.ts"]);
    await wait(coordinator, agents.two!, ["src/a.ts"]);
    await coordinator.abandon(holder);

    advanceTime(3 * MINUTE + SECOND);
    expect(await runDurableObjectAlarm(coordinator)).toBe(true);

    const snapshot = await coordinator.snapshot();
    expect(snapshot?.waiting).toEqual([]);
    expect(snapshot?.tasks.map((task) => task.state)).toEqual(["expired", "abandoned"]);
  });

  it("can be left", async () => {
    const { coordinator, agents } = await setup("one", "two");
    await start(coordinator, agents.one!, ["src/a.ts"]);
    const requestId = await wait(coordinator, agents.two!, ["src/a.ts"]);

    expect(await coordinator.cancelRequest({ agentId: agents.two!, requestId })).toEqual({ ok: true });
    expect(await coordinator.pollRequest({ agentId: agents.two!, requestId })).toMatchObject({ status: "gone" });
    expect(await coordinator.cancelRequest({ agentId: agents.two!, requestId })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("is shown on the board, in order of arrival", async () => {
    const { coordinator, agents } = await setup("one", "two", "three");
    const holder = await start(coordinator, agents.one!, ["src/a.ts"]);
    const first = await wait(coordinator, agents.two!, ["src/a.ts"]);
    advanceTime(SECOND);
    const second = await wait(coordinator, agents.three!, ["src/a.ts"]);

    expect((await coordinator.snapshot())?.waiting).toEqual([
      {
        requestId: first,
        agent: "two",
        goal: "work on src/a.ts",
        taskId: null,
        scope: [{ target: "src/a.ts", relation: "change" }],
        arrivedAt: T0,
        position: 1,
        blockedBy: [{ taskId: holder.taskId, agent: "one" }],
      },
      {
        requestId: second,
        agent: "three",
        goal: "work on src/a.ts",
        taskId: null,
        scope: [{ target: "src/a.ts", relation: "change" }],
        arrivedAt: T0 + SECOND,
        position: 2,
        blockedBy: [{ taskId: holder.taskId, agent: "one" }],
      },
    ]);
  });
});

describe("a task that waits for more", () => {
  it("gets what it asked for when it is free, and keeps what it held meanwhile", async () => {
    const { coordinator, agents } = await setup("one", "two");
    const holder = await start(coordinator, agents.one!, ["src/a.ts"]);
    const task = await start(coordinator, agents.two!, ["src/b.ts"]);

    const refused = await coordinator.expandScope({ ...task, paths: ["src/a.ts"], wait: true });
    if (refused.ok || refused.waiting === undefined) {
      throw new Error("expected the request to wait");
    }
    expect(await coordinator.getTask(task)).toMatchObject({ task: { state: "active", paths: ["src/b.ts"] } });
    advanceTime(5 * SECOND);
    await coordinator.abandon(holder);

    expect(await coordinator.pollRequest({ agentId: task.agentId, requestId: refused.waiting.requestId })).toEqual({
      status: "granted",
      paths: ["src/a.ts", "src/b.ts"],
      scope: [
        { target: "src/a.ts", relation: "change", origin: "declared" },
        { target: "src/b.ts", relation: "change", origin: "declared" },
      ],
      claimExpiresAt: T0 + 5 * SECOND + 120 * MINUTE,
    });
  });

  it("keeps its scope from expiring while it waits and asks", async () => {
    const { coordinator, agents } = await setup("one", "two");
    await start(coordinator, agents.one!, ["src/a.ts"]);
    const granted = await coordinator.startTask({ agentId: agents.two!, goal: "g", paths: ["src/b.ts"], ttlMinutes: 1 });
    if (!granted.ok) {
      throw new Error("expected the scope to be granted");
    }
    const task = { agentId: agents.two!, taskId: granted.task.id };
    const refused = await coordinator.expandScope({ ...task, paths: ["src/a.ts"], wait: true });
    if (refused.ok || refused.waiting === undefined) {
      throw new Error("expected the request to wait");
    }

    for (let asked = 0; asked < 4; asked++) {
      advanceTime(25 * SECOND);
      await coordinator.pollRequest({ agentId: task.agentId, requestId: refused.waiting.requestId });
    }

    expect(await coordinator.getTask(task)).toMatchObject({ task: { state: "active" } });
  });

  it("is refused when waiting could never end", async () => {
    const { coordinator, agents } = await setup("one", "two");
    const one = await start(coordinator, agents.one!, ["src/a.ts"]);
    const two = await start(coordinator, agents.two!, ["src/b.ts"]);
    await coordinator.expandScope({ ...one, paths: ["src/b.ts"], wait: true });

    const refused = await coordinator.expandScope({ ...two, paths: ["src/a.ts"], wait: true });

    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: "conflict",
        message: "1 path is held by another task, and waiting would never end: one's task is itself waiting for what this task holds. Give up one of the two.",
        retryable: false,
      },
    });
    expect(!refused.ok && refused.waiting).toBeUndefined();
  });

  it("stops waiting when the task ends", async () => {
    const { coordinator, agents } = await setup("one", "two");
    await start(coordinator, agents.one!, ["src/a.ts"]);
    const task = await start(coordinator, agents.two!, ["src/b.ts"]);
    const refused = await coordinator.expandScope({ ...task, paths: ["src/a.ts"], wait: true });
    if (refused.ok || refused.waiting === undefined) {
      throw new Error("expected the request to wait");
    }

    await coordinator.abandon(task);

    expect(await coordinator.pollRequest({ agentId: task.agentId, requestId: refused.waiting.requestId })).toMatchObject({ status: "gone" });
  });
});
