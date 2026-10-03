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
const MERGE = "e".repeat(40);

async function startedTask(coordinator: CoordinatorStub, agentName: string, goal: string, paths: string[]) {
  const agentId = await newAgent(coordinator, agentName);
  const started = await coordinator.startTask({ agentId, goal, paths });
  if (!started.ok) {
    throw new Error(`claim refused: ${started.error.message}`);
  }
  await coordinator.attachFork(started.task.id, BASE);
  return { agentId, taskId: started.task.id };
}

async function submittedTask(coordinator: CoordinatorStub, agentName: string, goal: string, paths: string[]) {
  const task = await startedTask(coordinator, agentName, goal, paths);
  const submission = await coordinator.submit({ ...task, summary: `summary of ${goal}`, headSha: HEAD });
  if (!submission.ok) {
    throw new Error(`submit failed: ${submission.error.message}`);
  }
  return { ...task, submissionId: submission.submissionId };
}

async function snapshotOf(coordinator: CoordinatorStub) {
  const snapshot = await coordinator.snapshot();
  if (snapshot === null) {
    throw new Error("expected a registered repository");
  }
  return snapshot;
}

const triage = {
  model: "clef",
  goal_fit: { score: 2.8, confidence: 0.81 },
  risk: { score: 1.1, confidence: 0.77, high: 0.03 },
  unrelated_changes: 0.04,
  interface_change: 0.12,
  leftovers: 0.02,
};

describe("related work", () => {
  it("returns the related tasks in full and remembers them for the review", async () => {
    const coordinator = await newCoordinator();
    const users = await startedTask(coordinator, "agent-one", "Add GET /users/:id", ["src/routes/users/"]);
    const db = await submittedTask(coordinator, "agent-five", "Change findUser to return a result", ["src/db/users.ts"]);

    const related = await coordinator.recordRelated(db.taskId, [
      { taskId: users.taskId, relation: "coupled", confidence: 0.83 },
    ]);

    const want = [
      {
        taskId: users.taskId,
        agent: "agent-one",
        goal: "Add GET /users/:id",
        state: "active",
        paths: ["src/routes/users/"],
        relation: "coupled",
        confidence: 0.83,
      },
    ];
    expect(related).toEqual(want);
    expect((await coordinator.getSubmission(db.submissionId))?.related).toEqual(want);
  });

  it("shows the link from the other task's side as well", async () => {
    const coordinator = await newCoordinator();
    const users = await submittedTask(coordinator, "agent-one", "Add GET /users/:id", ["src/routes/users/"]);
    const db = await startedTask(coordinator, "agent-five", "Change findUser", ["src/db/users.ts"]);
    await coordinator.recordRelated(db.taskId, [{ taskId: users.taskId, relation: "coupled", confidence: 0.83 }]);

    const context = await coordinator.getSubmission(users.submissionId);

    expect(context?.related).toEqual([
      {
        taskId: db.taskId,
        agent: "agent-five",
        goal: "Change findUser",
        state: "active",
        paths: ["src/db/users.ts"],
        relation: "coupled",
        confidence: 0.83,
      },
    ]);
  });

  it("records a related-work event naming both sides", async () => {
    const coordinator = await newCoordinator();
    const users = await startedTask(coordinator, "agent-one", "Add users", ["src/routes/users/"]);
    const db = await startedTask(coordinator, "agent-five", "Change findUser", ["src/db/users.ts"]);

    await coordinator.recordRelated(db.taskId, [{ taskId: users.taskId, relation: "duplicate", confidence: 0.9 }]);

    const event = (await coordinator.listEvents()).at(-1);
    expect(event).toMatchObject({
      type: "related_work",
      taskId: db.taskId,
      body: {
        agent: "agent-five",
        related: [{ taskId: users.taskId, agent: "agent-one", goal: "Add users", relation: "duplicate", confidence: 0.9 }],
      },
    });
  });

  it("records nothing when there is nothing related", async () => {
    const coordinator = await newCoordinator();
    const db = await startedTask(coordinator, "agent-five", "Change findUser", ["src/db/users.ts"]);
    const eventsBefore = (await coordinator.listEvents()).length;

    expect(await coordinator.recordRelated(db.taskId, [])).toEqual([]);

    expect(await coordinator.listEvents()).toHaveLength(eventsBefore);
  });

  it("notes when the decision model could not be reached", async () => {
    const coordinator = await newCoordinator();
    const db = await startedTask(coordinator, "agent-five", "Change findUser", ["src/db/users.ts"]);

    await coordinator.recordDeciderUnavailable({ taskId: db.taskId, stage: "claim", reason: "timed out after 2000 ms" });

    expect((await coordinator.listEvents()).at(-1)).toMatchObject({
      type: "decider_unavailable",
      taskId: db.taskId,
      body: { stage: "claim", reason: "timed out after 2000 ms" },
    });
  });
});

describe("getSubmission", () => {
  it("gives the review everything it needs about the submission", async () => {
    const coordinator = await newCoordinator({ maxCycles: 4 });
    const task = await submittedTask(coordinator, "agent-one", "Add users", ["src/routes/users/", "test/users.test.ts"]);

    const context = await coordinator.getSubmission(task.submissionId);

    expect(context).toEqual({
      submission: { id: task.submissionId, taskId: task.taskId, cycle: 1, headSha: HEAD, summary: "summary of Add users", triage: null },
      task: {
        id: task.taskId,
        agentId: task.agentId,
        agent: "agent-one",
        goal: "Add users",
        state: "in_review",
        cycle: 1,
        forkName: `demo-app--${task.taskId}`,
        baseSha: BASE,
      },
      claim: ["src/routes/users/", "test/users.test.ts"],
      scope: [{ target: "src/routes/users/", relation: "change", origin: "declared" }, { target: "test/users.test.ts", relation: "change", origin: "declared" }],
      related: [],
      collisions: [],
      interfaces: null,
      leaves: null,
      gate: null,
      verdicts: [],
      previous: null,
      config: await coordinator.getConfig(),
    });
    expect(context?.config.maxCycles).toBe(4);
  });

  it("returns null for a submission that does not exist", async () => {
    const coordinator = await newCoordinator();

    expect(await coordinator.getSubmission(7)).toBeNull();
  });

  it("includes the triage once it is recorded, and reports it as an event", async () => {
    const coordinator = await newCoordinator();
    const task = await submittedTask(coordinator, "agent-one", "Add users", ["src/routes/users/"]);

    await coordinator.recordTriage(task.submissionId, triage);

    expect((await coordinator.getSubmission(task.submissionId))?.submission.triage).toEqual(triage);
    expect((await coordinator.listEvents()).at(-1)).toMatchObject({
      type: "triage",
      taskId: task.taskId,
      body: { submissionId: task.submissionId, triage },
    });
  });

  it("records an unavailable triage as an event and leaves the triage empty", async () => {
    const coordinator = await newCoordinator();
    const task = await submittedTask(coordinator, "agent-one", "Add users", ["src/routes/users/"]);

    await coordinator.recordTriage(task.submissionId, null, "Workers AI returned 503");

    expect((await coordinator.getSubmission(task.submissionId))?.submission.triage).toBeNull();
    expect((await coordinator.listEvents()).at(-1)).toMatchObject({
      type: "decider_unavailable",
      taskId: task.taskId,
      body: { stage: "triage", reason: "Workers AI returned 503", submissionId: task.submissionId },
    });
  });

  it("carries every verdict on the submission, oldest first, so a merge-only run can see what was approved", async () => {
    const coordinator = await newCoordinator();
    const task = await submittedTask(coordinator, "agent-one", "Add users", ["src/routes/users/"]);
    await coordinator.recordVerdict(task.submissionId, {
      decision: "escalate",
      source: "reviewer",
      body: { summary: "Looks fine", reason: "protected path" },
    });
    await coordinator.decideEscalation({ taskId: task.taskId, decision: "approve", note: "ok" });

    const context = await coordinator.getSubmission(task.submissionId);

    expect(context?.verdicts).toMatchObject([
      { decision: "escalate", source: "reviewer", body: { summary: "Looks fine", reason: "protected path" } },
      { decision: "approve", source: "human", body: { note: "ok" } },
    ]);
    expect(context?.task.state).toBe("in_review");
  });
});

describe("getSubmission on a later attempt", () => {
  it("carries the verdict that sent the previous attempt back, so the next review can check it was dealt with", async () => {
    const coordinator = await newCoordinator();
    const task = await submittedTask(coordinator, "agent-one", "Add users", ["src/routes/users/"]);
    await coordinator.recordVerdict(task.submissionId, {
      decision: "reject",
      source: "reviewer",
      body: { summary: "No test", issues: [{ severity: "major", path: "src/routes/users/get.ts", description: "untested" }] },
    });
    const second = await coordinator.submit({ agentId: task.agentId, taskId: task.taskId, summary: "now tested", headSha: "2".repeat(40) });
    if (!second.ok) {
      throw new Error(second.error.message);
    }

    const context = await coordinator.getSubmission(second.submissionId);

    expect(context?.verdicts).toEqual([]);
    expect(context?.previous).toMatchObject({
      submissionId: task.submissionId,
      cycle: 1,
      decision: "reject",
      source: "reviewer",
      body: { summary: "No test" },
    });
  });
});

describe("whatsHappening", () => {
  it("lists live tasks and the most recent merges, newest merge first", async () => {
    const coordinator = await newCoordinator();
    const one = await submittedTask(coordinator, "agent-one", "First", ["src/a.ts"]);
    await coordinator.recordVerdict(one.submissionId, { decision: "approve", source: "reviewer", body: {} });
    await coordinator.recordMerged(one.submissionId, MERGE, true);
    advanceTime(MINUTE);
    const two = await submittedTask(coordinator, "agent-two", "Second", ["src/b.ts"]);
    await coordinator.recordVerdict(two.submissionId, { decision: "approve", source: "reviewer", body: {} });
    await coordinator.recordMerged(two.submissionId, "f".repeat(40), true);
    advanceTime(MINUTE);
    const three = await startedTask(coordinator, "agent-three", "Third", ["src/c.ts"]);

    expect(await coordinator.whatsHappening()).toEqual({
      tasks: [
        {
          taskId: three.taskId,
          agent: "agent-three",
          goal: "Third",
          state: "active",
          paths: ["src/c.ts"],
          scope: [{ target: "src/c.ts", relation: "change", origin: "declared" }],
          startedAt: T0 + 2 * MINUTE,
        },
      ],
      merges: [
        { taskId: two.taskId, agent: "agent-two", goal: "Second", mergeSha: "f".repeat(40), mergedAt: T0 + MINUTE },
        { taskId: one.taskId, agent: "agent-one", goal: "First", mergeSha: MERGE, mergedAt: T0 },
      ],
      waiting: [],
    });
  });

  it("returns at most ten merges", async () => {
    const coordinator = await newCoordinator();
    for (let index = 0; index < 12; index++) {
      const task = await submittedTask(coordinator, `agent-${index}`, `Goal ${index}`, [`src/f${index}.ts`]);
      await coordinator.recordVerdict(task.submissionId, { decision: "approve", source: "reviewer", body: {} });
      await coordinator.recordMerged(task.submissionId, index.toString(16).padStart(40, "0"), true);
      advanceTime(MINUTE);
    }

    const { merges } = await coordinator.whatsHappening();

    expect(merges).toHaveLength(10);
    expect(merges[0]?.goal).toBe("Goal 11");
    expect(merges[9]?.goal).toBe("Goal 2");
  });
});

describe("snapshot", () => {
  it("gives the board the repository, agents, tasks with their latest submission, and events", async () => {
    const coordinator = await newCoordinator();
    const task = await submittedTask(coordinator, "agent-one", "Add users", ["src/routes/users/"]);
    await coordinator.recordTriage(task.submissionId, triage);

    const snapshot = await snapshotOf(coordinator);

    expect(snapshot.config.repoName).toBe("demo-app");
    expect(snapshot.agents).toEqual([{ id: task.agentId, name: "agent-one" }]);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({
      id: task.taskId,
      agent: "agent-one",
      goal: "Add users",
      state: "in_review",
      paths: ["src/routes/users/"],
      related: [],
      submission: { id: task.submissionId, cycle: 1, headSha: HEAD, summary: "summary of Add users", triage },
    });
    expect(snapshot.events.map((event) => event.type)).toEqual(["task_started", "submitted", "triage"]);
  });

  it("keeps finished tasks visible, after the live ones", async () => {
    const coordinator = await newCoordinator();
    const done = await submittedTask(coordinator, "agent-one", "Done", ["src/a.ts"]);
    await coordinator.recordVerdict(done.submissionId, { decision: "approve", source: "reviewer", body: {} });
    await coordinator.recordMerged(done.submissionId, MERGE, true);
    advanceTime(MINUTE);
    const live = await startedTask(coordinator, "agent-two", "Live", ["src/b.ts"]);

    const snapshot = await snapshotOf(coordinator);

    expect(snapshot.tasks.map((task) => [task.id, task.state])).toEqual([
      [live.taskId, "active"],
      [done.taskId, "merged"],
    ]);
  });

  describe("shadow tally", () => {
    async function reviewed(
      coordinator: CoordinatorStub,
      index: number,
      wouldAutoApprove: boolean,
      decision: "approve" | "reject" | "escalate",
    ) {
      const task = await submittedTask(coordinator, `agent-${index}`, `Goal ${index}`, [`src/f${index}.ts`]);
      await coordinator.recordVerdict(task.submissionId, {
        decision,
        source: "reviewer",
        body: { summary: "s", shadow: { would_auto_approve: wouldAutoApprove } },
      });
      return task;
    }

    it("counts how often the decision model alone would have matched the final outcome", async () => {
      const coordinator = await newCoordinator();
      await reviewed(coordinator, 1, true, "approve"); // agrees
      await reviewed(coordinator, 2, false, "reject"); // agrees
      await reviewed(coordinator, 3, true, "reject"); // disagrees
      await reviewed(coordinator, 4, false, "approve"); // disagrees

      expect((await snapshotOf(coordinator)).shadow).toEqual({ reviewed: 4, agreed: 2 });
    });

    it("leaves out a submission still waiting for a human, then counts the human's decision", async () => {
      const coordinator = await newCoordinator();
      const task = await reviewed(coordinator, 1, true, "escalate");
      expect((await snapshotOf(coordinator)).shadow).toEqual({ reviewed: 0, agreed: 0 });

      await coordinator.decideEscalation({ taskId: task.taskId, decision: "approve" });

      expect((await snapshotOf(coordinator)).shadow).toEqual({ reviewed: 1, agreed: 1 });
    });

    it("ignores submissions that were decided without a shadow answer", async () => {
      const coordinator = await newCoordinator();
      const task = await submittedTask(coordinator, "agent-one", "Goal", ["src/a.ts"]);
      await coordinator.recordVerdict(task.submissionId, { decision: "reject", source: "check", body: {} });

      expect((await snapshotOf(coordinator)).shadow).toEqual({ reviewed: 0, agreed: 0 });
    });
  });
});
