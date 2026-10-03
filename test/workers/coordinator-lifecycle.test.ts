import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceTime,
  freezeTime,
  MINUTE,
  newAgent,
  newCoordinator,
  T0,
  type CoordinatorStub,
} from "./helpers/coordinator";

beforeEach(() => freezeTime());
afterEach(() => vi.useRealTimers());

const BASE = "b".repeat(40);
const HEAD = "1".repeat(40);
const HEAD_2 = "2".repeat(40);
const MERGE = "e".repeat(40);

// A task whose claim was granted and whose fork is ready.
async function startedTask(
  coordinator: CoordinatorStub,
  agentName: string,
  paths: string[],
  options: { goal?: string; ttlMinutes?: number } = {},
): Promise<{ agentId: string; taskId: string }> {
  const agentId = await newAgent(coordinator, agentName);
  const started = await coordinator.startTask({
    agentId,
    goal: options.goal ?? `work by ${agentName}`,
    paths,
    ttlMinutes: options.ttlMinutes,
  });
  if (!started.ok) {
    throw new Error(`claim refused: ${started.error.message}`);
  }
  const attached = await coordinator.attachFork(started.task.id, BASE);
  if (!attached.ok) {
    throw new Error(`attachFork failed: ${attached.error.message}`);
  }
  return { agentId, taskId: started.task.id };
}

async function submitted(
  coordinator: CoordinatorStub,
  agentName: string,
  paths: string[],
): Promise<{ agentId: string; taskId: string; submissionId: number }> {
  const task = await startedTask(coordinator, agentName, paths);
  const submission = await coordinator.submit({ ...task, summary: "done", headSha: HEAD });
  if (!submission.ok) {
    throw new Error(`submit failed: ${submission.error.message}`);
  }
  return { ...task, submissionId: submission.submissionId };
}

async function stateOf(coordinator: CoordinatorStub, task: { agentId: string; taskId: string }): Promise<string> {
  const view = await coordinator.getTask(task);
  if (!view.ok) {
    throw new Error(view.error.message);
  }
  return view.task.state;
}

describe("fork attachment", () => {
  it("records the fork's starting commit", async () => {
    const coordinator = await newCoordinator();
    const task = await startedTask(coordinator, "agent-one", ["src/a.ts"]);

    expect(await coordinator.getTask(task)).toMatchObject({ ok: true, task: { baseSha: BASE, state: "active" } });
  });

  it("refuses to change the starting commit once set", async () => {
    const coordinator = await newCoordinator();
    const task = await startedTask(coordinator, "agent-one", ["src/a.ts"]);

    expect(await coordinator.attachFork(task.taskId, HEAD)).toMatchObject({ ok: false, error: { code: "bad_state" } });
  });

  it("releases the claim when the fork could not be created", async () => {
    const coordinator = await newCoordinator();
    const one = await newAgent(coordinator, "agent-one");
    const two = await newAgent(coordinator, "agent-two");
    const started = await coordinator.startTask({ agentId: one, goal: "g", paths: ["src/a.ts"] });
    if (!started.ok) {
      throw new Error("expected the claim to be granted");
    }

    await coordinator.failStart(started.task.id, "fork was not ready in time");

    expect(await stateOf(coordinator, { agentId: one, taskId: started.task.id })).toBe("abandoned");
    expect((await coordinator.startTask({ agentId: two, goal: "g", paths: ["src/a.ts"] })).ok).toBe(true);
  });
});

describe("expandClaim", () => {
  it("adds free paths, returns the whole claim and restarts the clock", async () => {
    const coordinator = await newCoordinator();
    const task = await startedTask(coordinator, "agent-one", ["src/db/"], { ttlMinutes: 60 });
    advanceTime(50 * MINUTE);

    const expanded = await coordinator.expandClaim({ ...task, paths: ["src/utils/date.ts", "src/db/users.ts"] });

    expect(expanded).toEqual({
      ok: true,
      paths: ["src/db/", "src/utils/date.ts"],
      scope: [{ target: "src/db/", relation: "change", origin: "declared" }, { target: "src/utils/date.ts", relation: "change", origin: "declared" }],
      claimExpiresAt: T0 + 110 * MINUTE,
    });
  });

  it("refuses paths another task holds and leaves the existing claim and clock unchanged", async () => {
    const coordinator = await newCoordinator();
    const one = await startedTask(coordinator, "agent-one", ["src/db/"], { ttlMinutes: 60 });
    const two = await startedTask(coordinator, "agent-two", ["src/utils/"]);
    advanceTime(10 * MINUTE);

    const refused = await coordinator.expandClaim({ ...one, paths: ["src/utils/date.ts", "docs/"] });

    expect(refused).toMatchObject({
      ok: false,
      error: { code: "conflict" },
      conflicts: [{ taskId: two.taskId, agent: "agent-two", paths: ["src/utils/"] }],
    });
    expect(await coordinator.getTask(one)).toMatchObject({
      ok: true,
      task: { paths: ["src/db/"], claimExpiresAt: T0 + 60 * MINUTE },
    });
  });

  it("does not treat the task's own claim as a conflict", async () => {
    const coordinator = await newCoordinator();
    const task = await startedTask(coordinator, "agent-one", ["src/db/users.ts"]);

    expect(await coordinator.expandClaim({ ...task, paths: ["src/db/"] })).toMatchObject({
      ok: true,
      paths: ["src/db/"],
    });
  });

  it("is refused for another agent's task", async () => {
    const coordinator = await newCoordinator();
    const one = await startedTask(coordinator, "agent-one", ["src/db/"]);
    const intruder = await newAgent(coordinator, "agent-two");

    expect(await coordinator.expandClaim({ agentId: intruder, taskId: one.taskId, paths: ["docs/"] })).toMatchObject({
      ok: false,
      error: { code: "not_owner" },
    });
  });

  it("is refused while the task is in review", async () => {
    const coordinator = await newCoordinator();
    const task = await submitted(coordinator, "agent-one", ["src/db/"]);

    expect(await coordinator.expandClaim({ ...task, paths: ["docs/"] })).toMatchObject({
      ok: false,
      error: { code: "bad_state" },
    });
  });
});

describe("submit", () => {
  it("moves the task into review and pins the submitted commit", async () => {
    const coordinator = await newCoordinator();
    const task = await startedTask(coordinator, "agent-one", ["src/a.ts"]);

    const submission = await coordinator.submit({ ...task, summary: "Added a", headSha: HEAD });

    expect(submission).toEqual({ ok: true, submissionId: 1, cycle: 1, headSha: HEAD });
    expect(await stateOf(coordinator, task)).toBe("in_review");
  });

  it("has nothing to submit when the fork has not moved", async () => {
    const coordinator = await newCoordinator();
    const task = await startedTask(coordinator, "agent-one", ["src/a.ts"]);

    expect(await coordinator.submit({ ...task, summary: "s", headSha: BASE })).toMatchObject({
      ok: false,
      error: { code: "nothing_to_submit" },
    });
    expect(await stateOf(coordinator, task)).toBe("active");
  });

  it("compares the work with a later commit of main once the fork has caught up with it", async () => {
    const coordinator = await newCoordinator();
    const task = await startedTask(coordinator, "agent-one", ["src/a.ts"]);
    const caughtUpTo = "c".repeat(40);

    const submission = await coordinator.submit({ ...task, summary: "s", headSha: HEAD, baseSha: caughtUpTo });

    expect(submission).toMatchObject({ ok: true });
    expect((await coordinator.getSubmission(1))?.task.baseSha).toBe(caughtUpTo);
  });

  it("has nothing to submit when the fork holds nothing beyond the commit of main it caught up with", async () => {
    const coordinator = await newCoordinator();
    const task = await startedTask(coordinator, "agent-one", ["src/a.ts"]);

    expect(await coordinator.submit({ ...task, summary: "s", headSha: HEAD, baseSha: HEAD })).toMatchObject({
      ok: false,
      error: { code: "nothing_to_submit" },
    });
    expect((await coordinator.getTask(task)).ok && (await coordinator.getTask(task))).toMatchObject({ task: { baseSha: BASE } });
  });

  it("is refused while an earlier submission is still in review", async () => {
    const coordinator = await newCoordinator();
    const task = await submitted(coordinator, "agent-one", ["src/a.ts"]);

    expect(await coordinator.submit({ ...task, summary: "again", headSha: HEAD_2 })).toMatchObject({
      ok: false,
      error: { code: "bad_state" },
    });
  });

  it("is refused before the fork is ready", async () => {
    const coordinator = await newCoordinator();
    const agentId = await newAgent(coordinator, "agent-one");
    const started = await coordinator.startTask({ agentId, goal: "g", paths: ["src/a.ts"] });
    if (!started.ok) {
      throw new Error("expected the claim to be granted");
    }

    expect(await coordinator.submit({ agentId, taskId: started.task.id, summary: "s", headSha: HEAD })).toMatchObject({
      ok: false,
      error: { code: "bad_state" },
    });
  });

  it("is refused for another agent's task and for an unknown task", async () => {
    const coordinator = await newCoordinator();
    const task = await startedTask(coordinator, "agent-one", ["src/a.ts"]);
    const intruder = await newAgent(coordinator, "agent-two");

    expect(await coordinator.submit({ agentId: intruder, taskId: task.taskId, summary: "s", headSha: HEAD })).toMatchObject({
      ok: false,
      error: { code: "not_owner" },
    });
    expect(await coordinator.submit({ agentId: intruder, taskId: "t-missing0", summary: "s", headSha: HEAD })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("keeps the claim from expiring while the task is in review", async () => {
    const coordinator = await newCoordinator();
    const task = await submitted(coordinator, "agent-one", ["src/a.ts"]);
    const other = await newAgent(coordinator, "agent-two");

    advanceTime(600 * MINUTE);

    expect((await coordinator.startTask({ agentId: other, goal: "g", paths: ["src/a.ts"] })).ok).toBe(false);
    expect(await stateOf(coordinator, task)).toBe("in_review");
  });

  it("takes an expired task back into review when its paths are still free", async () => {
    const coordinator = await newCoordinator();
    const task = await startedTask(coordinator, "agent-one", ["src/a.ts"], { ttlMinutes: 30 });
    advanceTime(31 * MINUTE);
    expect(await stateOf(coordinator, task)).toBe("expired");

    const submission = await coordinator.submit({ ...task, summary: "late", headSha: HEAD });

    expect(submission.ok).toBe(true);
    expect(await stateOf(coordinator, task)).toBe("in_review");
  });

  it("refuses an expired task whose paths were taken meanwhile, and names the new holder", async () => {
    const coordinator = await newCoordinator();
    const task = await startedTask(coordinator, "agent-one", ["src/a.ts"], { ttlMinutes: 30 });
    advanceTime(31 * MINUTE);
    const taker = await startedTask(coordinator, "agent-two", ["src/"]);

    const refused = await coordinator.submit({ ...task, summary: "late", headSha: HEAD });

    expect(refused).toMatchObject({
      ok: false,
      error: { code: "conflict" },
      conflicts: [{ taskId: taker.taskId, agent: "agent-two", paths: ["src/"] }],
    });
    expect(await stateOf(coordinator, task)).toBe("expired");
  });
});

describe("verdicts", () => {
  it("returns a rejected task to its agent for another cycle with a fresh clock", async () => {
    const coordinator = await newCoordinator();
    const task = await submitted(coordinator, "agent-one", ["src/a.ts"]);
    advanceTime(200 * MINUTE);

    const recorded = await coordinator.recordVerdict(task.submissionId, {
      decision: "reject",
      source: "reviewer",
      body: { summary: "Off by one", issues: [{ severity: "critical", path: "src/a.ts", description: "bug" }] },
    });

    expect(recorded).toEqual({ ok: true, state: "active", cycle: 2 });
    expect(await coordinator.getTask(task)).toMatchObject({
      ok: true,
      task: {
        state: "active",
        cycle: 2,
        claimExpiresAt: T0 + 320 * MINUTE,
        verdict: {
          submissionId: task.submissionId,
          cycle: 1,
          decision: "reject",
          source: "reviewer",
          body: { summary: "Off by one", issues: [{ severity: "critical", path: "src/a.ts", description: "bug" }] },
        },
      },
    });
  });

  it("numbers the next submission with the new cycle", async () => {
    const coordinator = await newCoordinator();
    const task = await submitted(coordinator, "agent-one", ["src/a.ts"]);
    await coordinator.recordVerdict(task.submissionId, { decision: "reject", source: "check", body: {} });

    const again = await coordinator.submit({ ...task, summary: "fixed", headSha: HEAD_2 });

    expect(again).toEqual({ ok: true, submissionId: 2, cycle: 2, headSha: HEAD_2 });
  });

  it("holds an escalated task, and its claim, for a human", async () => {
    const coordinator = await newCoordinator();
    const task = await submitted(coordinator, "agent-one", ["package.json"]);
    const other = await newAgent(coordinator, "agent-two");

    const recorded = await coordinator.recordVerdict(task.submissionId, {
      decision: "escalate",
      source: "reviewer",
      body: { reason: "protected path", paths: ["package.json"] },
    });
    advanceTime(600 * MINUTE);

    expect(recorded).toEqual({ ok: true, state: "escalated", cycle: 1 });
    expect((await coordinator.startTask({ agentId: other, goal: "g", paths: ["package.json"] })).ok).toBe(false);
  });

  it("keeps an approved task in review until the merge is recorded", async () => {
    const coordinator = await newCoordinator();
    const task = await submitted(coordinator, "agent-one", ["src/a.ts"]);

    const recorded = await coordinator.recordVerdict(task.submissionId, {
      decision: "approve",
      source: "reviewer",
      body: { summary: "Looks right" },
    });

    expect(recorded).toEqual({ ok: true, state: "in_review", cycle: 1 });
  });

  it("applies the same verdict only once when it is recorded twice", async () => {
    const coordinator = await newCoordinator();
    const task = await submitted(coordinator, "agent-one", ["src/a.ts"]);
    const verdict = { decision: "reject" as const, source: "reviewer" as const, body: { summary: "no" } };
    await coordinator.recordVerdict(task.submissionId, verdict);

    const repeated = await coordinator.recordVerdict(task.submissionId, verdict);

    expect(repeated).toEqual({ ok: true, state: "active", cycle: 2 });
    const events = await coordinator.listEvents();
    expect(events.filter((event) => event.type === "verdict")).toHaveLength(1);
  });

  it("is refused for a submission that does not exist", async () => {
    const coordinator = await newCoordinator();

    expect(
      await coordinator.recordVerdict(99, { decision: "approve", source: "reviewer", body: {} }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("merging", () => {
  async function approved(coordinator: CoordinatorStub, agentName: string, paths: string[]) {
    const task = await submitted(coordinator, agentName, paths);
    await coordinator.recordVerdict(task.submissionId, { decision: "approve", source: "reviewer", body: {} });
    return task;
  }

  it("lets one task hold the merge lock at a time", async () => {
    const coordinator = await newCoordinator();
    const one = await approved(coordinator, "agent-one", ["src/a.ts"]);
    const two = await approved(coordinator, "agent-two", ["src/b.ts"]);

    expect(await coordinator.acquireMergeLock(one.taskId)).toBe(true);
    expect(await coordinator.acquireMergeLock(two.taskId)).toBe(false);
    // Asking again for a lock already held is fine: a retried merge step does this.
    expect(await coordinator.acquireMergeLock(one.taskId)).toBe(true);

    await coordinator.releaseMergeLock(one.taskId);
    expect(await coordinator.acquireMergeLock(two.taskId)).toBe(true);
  });

  it("frees a merge lock that was never released after two minutes", async () => {
    const coordinator = await newCoordinator();
    const one = await approved(coordinator, "agent-one", ["src/a.ts"]);
    const two = await approved(coordinator, "agent-two", ["src/b.ts"]);
    await coordinator.acquireMergeLock(one.taskId);

    advanceTime(2 * MINUTE - 1);
    const beforeExpiry = await coordinator.acquireMergeLock(two.taskId);
    advanceTime(1);
    const afterExpiry = await coordinator.acquireMergeLock(two.taskId);

    expect(beforeExpiry).toBe(false);
    expect(afterExpiry).toBe(true);
  });

  it("does not release a lock on behalf of a task that does not hold it", async () => {
    const coordinator = await newCoordinator();
    const one = await approved(coordinator, "agent-one", ["src/a.ts"]);
    const two = await approved(coordinator, "agent-two", ["src/b.ts"]);
    await coordinator.acquireMergeLock(one.taskId);

    await coordinator.releaseMergeLock(two.taskId);

    expect(await coordinator.acquireMergeLock(two.taskId)).toBe(false);
  });

  it("finishes the task, frees its paths and its lock when the merge is recorded", async () => {
    const coordinator = await newCoordinator();
    const one = await approved(coordinator, "agent-one", ["src/a.ts"]);
    const two = await approved(coordinator, "agent-two", ["src/b.ts"]);
    const three = await newAgent(coordinator, "agent-three");
    await coordinator.acquireMergeLock(one.taskId);

    const recorded = await coordinator.recordMerged(one.submissionId, MERGE, true);

    expect(recorded).toEqual({ ok: true });
    expect(await coordinator.getTask(one)).toMatchObject({ ok: true, task: { state: "merged", mergeSha: MERGE } });
    expect((await coordinator.startTask({ agentId: three, goal: "g", paths: ["src/a.ts"] })).ok).toBe(true);
    expect(await coordinator.acquireMergeLock(two.taskId)).toBe(true);
  });

  it("accepts the same merge being recorded twice", async () => {
    const coordinator = await newCoordinator();
    const one = await approved(coordinator, "agent-one", ["src/a.ts"]);
    await coordinator.recordMerged(one.submissionId, MERGE, true);

    expect(await coordinator.recordMerged(one.submissionId, MERGE, true)).toEqual({ ok: true });
    expect((await coordinator.listEvents()).filter((event) => event.type === "merged")).toHaveLength(1);
  });

  it("refuses to record a merge for a task that was not approved", async () => {
    const coordinator = await newCoordinator();
    const task = await startedTask(coordinator, "agent-one", ["src/a.ts"]);
    const submission = await coordinator.submit({ ...task, summary: "s", headSha: HEAD });
    if (!submission.ok) {
      throw new Error("expected the submission to be accepted");
    }
    await coordinator.recordVerdict(submission.submissionId, { decision: "reject", source: "reviewer", body: {} });

    expect(await coordinator.recordMerged(submission.submissionId, MERGE, true)).toMatchObject({
      ok: false,
      error: { code: "bad_state" },
    });
  });

  // The task keeps its claim: its agent can catch up with main in the same fork and submit again.
  it("sends a task whose base went stale back to its agent, with its paths still held", async () => {
    const coordinator = await newCoordinator();
    const one = await approved(coordinator, "agent-one", ["src/a.ts"]);
    const two = await newAgent(coordinator, "agent-two");
    await coordinator.acquireMergeLock(one.taskId);

    const recorded = await coordinator.recordStale(one.submissionId, [
      { path: "src/a.ts", reason: "changed on main since the task started" },
    ]);

    expect(recorded).toEqual({ ok: true, escalated: false });
    expect(await coordinator.getTask(one)).toMatchObject({
      ok: true,
      task: {
        state: "active",
        cycle: 2,
        claimExpiresAt: T0 + 120 * MINUTE,
        verdict: {
          decision: "reject",
          source: "merge",
          body: {
            stale: [{ path: "src/a.ts", reason: "changed on main since the task started" }],
            message: expect.stringContaining("sync_with_main"),
          },
        },
      },
    });
    expect(await coordinator.startTask({ agentId: two, goal: "g", paths: ["src/a.ts"] })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(await coordinator.acquireMergeLock("t-anyone00")).toBe(true);
  });

  it("accepts the same stale merge being recorded twice", async () => {
    const coordinator = await newCoordinator();
    const one = await approved(coordinator, "agent-one", ["src/a.ts"]);
    const paths = [{ path: "src/a.ts", reason: "changed on main since the task started" }];

    await coordinator.recordStale(one.submissionId, paths);

    expect(await coordinator.recordStale(one.submissionId, paths)).toEqual({ ok: true, escalated: false });
    expect(await coordinator.getTask(one)).toMatchObject({ ok: true, task: { state: "active", cycle: 2 } });
  });

  // Catching up is an attempt like any other.
  it("hands a stale task to a person instead on its last allowed attempt", async () => {
    const coordinator = await newCoordinator({ maxCycles: 1 });
    const one = await approved(coordinator, "agent-one", ["src/a.ts"]);
    await coordinator.acquireMergeLock(one.taskId);
    const paths = [{ path: "src/a.ts", reason: "changed on main since the task started" }];

    expect(await coordinator.recordStale(one.submissionId, paths)).toEqual({ ok: true, escalated: true });
    expect(await coordinator.getTask(one)).toMatchObject({
      ok: true,
      task: {
        state: "escalated",
        cycle: 1,
        verdict: {
          decision: "escalate",
          source: "merge",
          body: { stale: paths, message: expect.stringContaining("sync_with_main"), reasons: [{ kind: "max_cycles", detail: "rejected on cycle 1 of 1" }] },
        },
      },
    });
    expect((await coordinator.listEvents()).at(-1)).toMatchObject({ type: "escalated", body: { source: "merge" } });
    expect(await coordinator.acquireMergeLock("t-anyone00")).toBe(true);
  });

  it("hands a stale task to a person once however often it is recorded", async () => {
    const coordinator = await newCoordinator({ maxCycles: 1 });
    const one = await approved(coordinator, "agent-one", ["src/a.ts"]);
    const paths = [{ path: "src/a.ts", reason: "changed on main since the task started" }];

    await coordinator.recordStale(one.submissionId, paths);

    expect(await coordinator.recordStale(one.submissionId, paths)).toEqual({ ok: true, escalated: true });
    expect((await coordinator.listEvents()).filter((event) => event.type === "escalated")).toHaveLength(1);
  });
});

describe("human decisions", () => {
  async function escalated(coordinator: CoordinatorStub) {
    const task = await submitted(coordinator, "agent-one", ["package.json"]);
    await coordinator.recordVerdict(task.submissionId, {
      decision: "escalate",
      source: "reviewer",
      body: { reason: "protected path" },
    });
    return task;
  }

  it("approve puts the task back in review, ready to merge", async () => {
    const coordinator = await newCoordinator();
    const task = await escalated(coordinator);

    const decided = await coordinator.decideEscalation({ taskId: task.taskId, decision: "approve" });

    expect(decided).toEqual({ ok: true, state: "in_review", submissionId: task.submissionId });
    expect(await coordinator.recordMerged(task.submissionId, MERGE, true)).toEqual({ ok: true });
  });

  it("send back returns the task to its agent with the human's note as the verdict", async () => {
    const coordinator = await newCoordinator();
    const task = await escalated(coordinator);
    advanceTime(30 * MINUTE);

    const decided = await coordinator.decideEscalation({
      taskId: task.taskId,
      decision: "send_back",
      note: "Use the existing dependency instead",
    });

    expect(decided).toEqual({ ok: true, state: "active", submissionId: task.submissionId });
    expect(await coordinator.getTask(task)).toMatchObject({
      ok: true,
      task: {
        state: "active",
        cycle: 2,
        claimExpiresAt: T0 + 150 * MINUTE,
        verdict: { decision: "reject", source: "human", body: { note: "Use the existing dependency instead" } },
      },
    });
  });

  it("close ends the task and frees its paths", async () => {
    const coordinator = await newCoordinator();
    const task = await escalated(coordinator);
    const other = await newAgent(coordinator, "agent-two");

    const decided = await coordinator.decideEscalation({ taskId: task.taskId, decision: "close", note: "Not wanted" });

    expect(decided).toEqual({ ok: true, state: "closed", submissionId: task.submissionId });
    expect((await coordinator.startTask({ agentId: other, goal: "g", paths: ["package.json"] })).ok).toBe(true);
  });

  it("is refused for a task that is not escalated", async () => {
    const coordinator = await newCoordinator();
    const task = await submitted(coordinator, "agent-one", ["src/a.ts"]);

    expect(await coordinator.decideEscalation({ taskId: task.taskId, decision: "approve" })).toMatchObject({
      ok: false,
      error: { code: "bad_state" },
    });
  });
});

describe("abandon", () => {
  it("ends an active task and frees its paths", async () => {
    const coordinator = await newCoordinator();
    const task = await startedTask(coordinator, "agent-one", ["src/a.ts"]);
    const other = await newAgent(coordinator, "agent-two");

    expect(await coordinator.abandon(task)).toEqual({ ok: true });

    expect(await stateOf(coordinator, task)).toBe("abandoned");
    expect((await coordinator.startTask({ agentId: other, goal: "g", paths: ["src/a.ts"] })).ok).toBe(true);
  });

  it("is refused while the task is in review", async () => {
    const coordinator = await newCoordinator();
    const task = await submitted(coordinator, "agent-one", ["src/a.ts"]);

    expect(await coordinator.abandon(task)).toMatchObject({ ok: false, error: { code: "bad_state" } });
  });

  it("is refused for another agent's task", async () => {
    const coordinator = await newCoordinator();
    const task = await startedTask(coordinator, "agent-one", ["src/a.ts"]);
    const intruder = await newAgent(coordinator, "agent-two");

    expect(await coordinator.abandon({ agentId: intruder, taskId: task.taskId })).toMatchObject({
      ok: false,
      error: { code: "not_owner" },
    });
  });
});

describe("alarms across the lifecycle", () => {
  it("expires a task that was sent back and then left alone", async () => {
    const coordinator = await newCoordinator();
    const task = await submitted(coordinator, "agent-one", ["src/a.ts"]);
    await coordinator.recordVerdict(task.submissionId, { decision: "reject", source: "reviewer", body: {} });
    advanceTime(121 * MINUTE);

    expect(await runDurableObjectAlarm(coordinator)).toBe(true);

    expect(await stateOf(coordinator, task)).toBe("expired");
  });
});
