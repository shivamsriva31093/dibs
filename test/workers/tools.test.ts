import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexTree } from "../../src/index/build";
import {
  abandon,
  declareInterfaceChange,
  expandClaim,
  expandScope,
  getVerdict,
  peek,
  startTask,
  submit,
  syncWithMain,
  whatsHappening,
  type StartTaskData,
  type ToolDeps,
  type ToolResult,
  type WaitingData,
} from "../../src/tools";
import { DEFAULT_DECIDER_CONFIG, type Agent, type RepoConfig } from "../../src/types";
import { advanceTime, freezeTime, MINUTE, newCoordinator, T0, type CoordinatorStub } from "./helpers/coordinator";
import { FakeDecider } from "./helpers/fakes";
import { MemoryRepoHost } from "./helpers/memory-host";

beforeEach(() => freezeTime());
afterEach(() => vi.useRealTimers());

const SEED = { "README.md": "# demo\n", "src/db/users.ts": "export const users = [];\n" };

// A repository whose files use each other, for what the interface index adds.
const CODE = {
  "src/db/users.ts": "export function findUser(id: string): User | null { return null; }\n",
  "src/routes/list.ts": 'import { findUser } from "../db/users";\nexport const listRoute = findUser;\n',
  "test/users.test.ts": 'import { findUser } from "../src/db/users";\n',
};

// Reads the main branch into the interface index, as registering a repository does.
async function buildIndex(s: Setup): Promise<void> {
  const main = await s.host.open("demo-app");
  const head = (await main.head("main"))!;
  const built = await indexTree(main, head.tree);
  await s.coordinator.indexFiles({ files: built.files, removed: [], sha: head.oid, reset: true });
}

function started(result: ToolResult<StartTaskData | WaitingData>): StartTaskData {
  if (!result.ok || !("task_id" in result.data)) {
    throw new Error(`expected the task to start: ${JSON.stringify(result)}`);
  }
  return result.data;
}

function waiting(result: ToolResult<object>): WaitingData {
  if (!result.ok || !("request_id" in result.data)) {
    throw new Error(`expected the request to wait: ${JSON.stringify(result)}`);
  }
  return result.data as WaitingData;
}

interface Setup {
  coordinator: CoordinatorStub;
  host: MemoryRepoHost;
  decider: FakeDecider;
  deps: ToolDeps;
  reviews: { repo: string; submissionId: number }[];
  sleeps: number[];
  mainHead: string;
  agent(name: string): Promise<Agent>;
}

async function setup(config: Partial<RepoConfig> = {}, seed: Record<string, string> = SEED): Promise<Setup> {
  const coordinator = await newCoordinator(config);
  const host = new MemoryRepoHost();
  const mainHead = await host.seed("demo-app", seed);
  const decider = new FakeDecider();
  const reviews: { repo: string; submissionId: number }[] = [];
  const sleeps: number[] = [];
  const deps: ToolDeps = {
    repo: "demo-app",
    coordinator,
    host,
    decider,
    startReview: async (params) => {
      reviews.push(params);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return {
    coordinator,
    host,
    decider,
    deps,
    reviews,
    sleeps,
    mainHead,
    agent: async (name) => {
      const created = await coordinator.createAgent(name);
      if (!created.ok) {
        throw new Error(created.error.message);
      }
      return created.agent;
    },
  };
}

// Starts a task and makes one commit in its fork, ready to submit.
async function startedWithWork(s: Setup, agent: Agent, paths: string[], work: Record<string, string>) {
  const started = await startTask(s.deps, agent, { goal: `work by ${agent.name}`, paths });
  if (!started.ok) {
    throw new Error(`start_task failed: ${started.error.message}`);
  }
  const forkName = `demo-app--${started.data.task_id}`;
  const headSha = await s.host.repo(forkName).commit("main", work, "work\n");
  return { taskId: started.data.task_id, forkName, headSha };
}

describe("start_task", () => {
  it("grants the claim and hands back a fork to work in", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");

    const result = await startTask(s.deps, agent, { goal: "Add a users endpoint", paths: ["src/routes/users/"] });

    if (!result.ok) {
      throw new Error(`expected the task to start: ${result.error.message}`);
    }
    const taskId = result.data.task_id;
    expect(result.data).toEqual({
      task_id: taskId,
      remote: `https://git.example.invalid/demo-app--${taskId}.git`,
      token: `token-demo-app--${taskId}-write`,
      branch: "main",
      base_sha: s.mainHead,
      paths: ["src/routes/users/"],
      scope: [{ target: "src/routes/users/", relation: "change", origin: "declared" }],
      claim_expires_at: new Date(T0 + 120 * MINUTE).toISOString(),
      related: [],
      related_check: "ok",
      collisions: [],
      dependents: [],
      clone_command: `git -c http.extraHeader="Authorization: Bearer token-demo-app--${taskId}-write" clone https://git.example.invalid/demo-app--${taskId}.git`,
      push_command: `git -c http.extraHeader="Authorization: Bearer token-demo-app--${taskId}-write" push origin HEAD:main`,
    });
    expect(s.host.has(`demo-app--${taskId}`)).toBe(true);
    expect(s.host.tokensIssued).toEqual([{ repo: `demo-app--${taskId}`, scope: "write", ttlSeconds: 24 * 60 * 60 }]);
    expect(await s.coordinator.getTask({ agentId: agent.id, taskId })).toMatchObject({
      ok: true,
      task: { state: "active", baseSha: s.mainHead },
    });
  });

  it("refuses an overlapping claim, says who holds the paths, and creates no fork", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const two = await s.agent("agent-two");
    const first = await startTask(s.deps, one, { goal: "Add a users endpoint", paths: ["src/routes/users/"] });
    if (!first.ok) {
      throw new Error("expected the first task to start");
    }
    advanceTime(5 * MINUTE);

    const refused = await startTask(s.deps, two, { goal: "Add rate limiting", paths: ["src/routes/users/limits.ts"] });

    expect(refused).toEqual({
      ok: false,
      error: { code: "conflict", message: "1 path is held by another task", retryable: true },
      conflicts: [
        {
          task_id: first.data.task_id,
          agent: "agent-one",
          goal: "Add a users endpoint",
          state: "active",
          paths: ["src/routes/users/"],
          held: [{ target: "src/routes/users/", relation: "change" }],
          started_at: new Date(T0).toISOString(),
          claim_expires_at: new Date(T0 + 120 * MINUTE).toISOString(),
        },
      ],
    });
    expect(s.host.tokensIssued).toHaveLength(1);
  });

  it("warns about a live task the decision model judges to be coupled", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const five = await s.agent("agent-five");
    const users = await startTask(s.deps, one, { goal: "Add GET /users/:id", paths: ["src/routes/users/"] });
    if (!users.ok) {
      throw new Error("expected the first task to start");
    }
    s.decider.relatedResult = [{ taskId: users.data.task_id, relation: "coupled", confidence: 0.83 }];

    const result = await startTask(s.deps, five, { goal: "Change findUser to return a result", paths: ["src/db/users.ts"] });

    expect(result).toMatchObject({
      ok: true,
      data: {
        related_check: "ok",
        related: [
          {
            task_id: users.data.task_id,
            agent: "agent-one",
            goal: "Add GET /users/:id",
            paths: ["src/routes/users/"],
            relation: "coupled",
            confidence: 0.83,
          },
        ],
      },
    });
    expect(s.decider.relatedCalls.at(-1)).toMatchObject({
      newTask: { goal: "Change findUser to return a result", paths: ["src/db/users.ts"] },
      liveTasks: [{ taskId: users.data.task_id, goal: "Add GET /users/:id" }],
    });
    expect((await s.coordinator.listEvents()).at(-1)?.type).toBe("related_work");
  });

  it("does not warn when the decision model gives the relation less than an even chance", async () => {
    const s = await setup();
    const users = await startTask(s.deps, await s.agent("agent-one"), { goal: "Add users", paths: ["src/routes/users/"] });
    if (!users.ok) {
      throw new Error("expected the first task to start");
    }
    s.decider.relatedResult = [{ taskId: users.data.task_id, relation: "coupled", confidence: 0.49 }];

    const result = await startTask(s.deps, await s.agent("agent-five"), { goal: "Change findUser", paths: ["src/db/users.ts"] });

    expect(result).toMatchObject({ ok: true, data: { related: [], related_check: "ok" } });
  });

  it("still grants the claim when the decision model fails, and says the check was unavailable", async () => {
    const s = await setup();
    await startTask(s.deps, await s.agent("agent-one"), { goal: "Add users", paths: ["src/routes/users/"] });
    s.decider.relatedResult = new Error("the decision model timed out after 2000 ms");

    const result = await startTask(s.deps, await s.agent("agent-five"), { goal: "Change findUser", paths: ["src/db/users.ts"] });

    expect(result).toMatchObject({ ok: true, data: { related: [], related_check: "unavailable" } });
    expect((await s.coordinator.listEvents()).find((event) => event.type === "decider_unavailable")).toMatchObject({
      body: { stage: "claim", reason: "the decision model timed out after 2000 ms" },
    });
  });

  it("does not ask the decision model when it is switched off or there is nothing to compare with", async () => {
    const off = await setup({
      decider: { ...DEFAULT_DECIDER_CONFIG, enabled: false },
    });
    await startTask(off.deps, await off.agent("agent-one"), { goal: "Add users", paths: ["src/routes/users/"] });
    const second = await startTask(off.deps, await off.agent("agent-two"), { goal: "Other", paths: ["docs/"] });
    const alone = await setup();
    const first = await startTask(alone.deps, await alone.agent("agent-one"), { goal: "Add users", paths: ["src/routes/users/"] });

    expect(second).toMatchObject({ ok: true, data: { related_check: "off" } });
    expect(off.decider.relatedCalls).toEqual([]);
    expect(first).toMatchObject({ ok: true, data: { related_check: "ok" } });
    expect(alone.decider.relatedCalls).toEqual([]);
  });

  it("waits for the fork to become ready", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    // The fork name is not known in advance, so make every repository slow to open except the main one.
    const open = s.host.open.bind(s.host);
    let refusals = 3;
    s.host.open = async (name) => {
      if (name !== "demo-app" && refusals > 0) {
        refusals--;
        s.host.notReady.set(name, 1);
      }
      return open(name);
    };

    const result = await startTask(s.deps, agent, { goal: "g", paths: ["src/a.ts"] });

    expect(result.ok).toBe(true);
    expect(s.sleeps).toEqual([250, 500, 1000]);
  });

  it("gives the paths back and reports a retryable error when the fork is not ready in time", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const two = await s.agent("agent-two");
    const open = s.host.open.bind(s.host);
    let blocked = true;
    s.host.open = async (name) => {
      if (name !== "demo-app" && blocked) {
        s.host.notReady.set(name, 1);
      }
      return open(name);
    };

    const result = await startTask(s.deps, one, { goal: "g", paths: ["src/a.ts"] });

    expect(result).toMatchObject({ ok: false, error: { code: "fork_not_ready", retryable: true } });
    expect(s.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(20_000);
    blocked = false;
    expect((await startTask(s.deps, two, { goal: "g", paths: ["src/a.ts"] })).ok).toBe(true);
  });

  it("tries the fork again while the repository is busy with another agent's fork", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    s.host.forkBusy.set("demo-app", 2);

    const result = await startTask(s.deps, agent, { goal: "g", paths: ["src/a.ts"] });

    expect(result.ok).toBe(true);
    expect(s.sleeps).toEqual([250, 500]);
  });

  it("gives the paths back and reports a retryable error when the repository stays busy", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const two = await s.agent("agent-two");
    s.host.forkBusy.set("demo-app", Number.POSITIVE_INFINITY);

    const result = await startTask(s.deps, one, { goal: "g", paths: ["src/a.ts"] });

    expect(result).toMatchObject({ ok: false, error: { code: "fork_not_ready", retryable: true } });
    expect(s.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(20_000);
    s.host.forkBusy.delete("demo-app");
    expect((await startTask(s.deps, two, { goal: "g", paths: ["src/a.ts"] })).ok).toBe(true);
  });

  it("passes on the coordinator's refusal of invalid input", async () => {
    const s = await setup();

    expect(await startTask(s.deps, await s.agent("agent-one"), { goal: "g", paths: ["../outside"] })).toMatchObject({
      ok: false,
      error: { code: "invalid_path" },
    });
  });

  it("uses the lifetime the agent asks for", async () => {
    const s = await setup();

    const result = await startTask(s.deps, await s.agent("agent-one"), { goal: "g", paths: ["a.ts"], ttl_minutes: 30 });

    expect(result).toMatchObject({ ok: true, data: { claim_expires_at: new Date(T0 + 30 * MINUTE).toISOString() } });
  });
});

describe("submit", () => {
  it("pins the fork's head, puts the task in review and starts the review", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const task = await startedWithWork(s, agent, ["src/db/users.ts"], { "src/db/users.ts": "export const users = [1];\n" });

    const result = await submit(s.deps, agent, { task_id: task.taskId, summary: "Seeded one user" });

    expect(result).toEqual({
      ok: true,
      data: { submission_id: 1, cycle: 1, head_sha: task.headSha, status: "in_review", related: [], collisions: [] },
    });
    expect(s.reviews).toEqual([{ repo: "demo-app", submissionId: 1 }]);
    expect(await s.coordinator.getTask({ agentId: agent.id, taskId: task.taskId })).toMatchObject({
      ok: true,
      task: { state: "in_review" },
    });
  });

  it("has nothing to submit when the agent pushed nothing", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const started = await startTask(s.deps, agent, { goal: "g", paths: ["src/a.ts"] });
    if (!started.ok) {
      throw new Error("expected the task to start");
    }

    const result = await submit(s.deps, agent, { task_id: started.data.task_id, summary: "nothing" });

    expect(result).toMatchObject({ ok: false, error: { code: "nothing_to_submit" } });
    expect(s.reviews).toEqual([]);
  });

  it("is refused for another agent's task", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const two = await s.agent("agent-two");
    const task = await startedWithWork(s, one, ["src/db/users.ts"], { "src/db/users.ts": "x\n" });

    expect(await submit(s.deps, two, { task_id: task.taskId, summary: "mine now" })).toMatchObject({
      ok: false,
      error: { code: "not_owner" },
    });
  });

  it("escalates the submission when the review cannot be started, so it is not left waiting", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const task = await startedWithWork(s, agent, ["src/db/users.ts"], { "src/db/users.ts": "x\n" });
    s.deps.startReview = async () => {
      throw new Error("workflow service unavailable");
    };

    const result = await submit(s.deps, agent, { task_id: task.taskId, summary: "s" });

    expect(result).toMatchObject({ ok: true, data: { status: "escalated" } });
    expect(await s.coordinator.getTask({ agentId: agent.id, taskId: task.taskId })).toMatchObject({
      ok: true,
      task: {
        state: "escalated",
        verdict: { decision: "escalate", source: "system", body: { step: "start", error: "workflow service unavailable" } },
      },
    });
  });
});

describe("catching up with main", () => {
  // Another task's work lands on main after this task's fork was taken.
  async function mainMoves(s: Setup): Promise<string> {
    return s.host.repo("demo-app").commit("main", { "src/db/users.ts": "export const users = [1];\n" }, "another task\n");
  }

  it("sync_with_main gives a read-only way to fetch main and the command that merges it", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const task = await startedWithWork(s, agent, ["src/routes/users/"], { "src/routes/users/get.ts": "x\n" });
    const mainHead = await mainMoves(s);

    const result = await syncWithMain(s.deps, agent, { task_id: task.taskId });

    expect(result).toEqual({
      ok: true,
      data: {
        remote: "https://git.example.invalid/demo-app.git",
        branch: "main",
        main_head: mainHead,
        token: "token-demo-app-read",
        sync_command:
          'git -c http.extraHeader="Authorization: Bearer token-demo-app-read" pull --no-rebase --no-edit https://git.example.invalid/demo-app.git main',
      },
    });
    expect(s.host.tokensIssued.at(-1)).toEqual({ repo: "demo-app", scope: "read", ttlSeconds: 600 });
  });

  it("sync_with_main shows on the board that the agent is catching up", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const task = await startedWithWork(s, agent, ["src/routes/users/"], { "src/routes/users/get.ts": "x\n" });
    const mainHead = await mainMoves(s);

    await syncWithMain(s.deps, agent, { task_id: task.taskId });

    expect((await s.coordinator.listEvents()).at(-1)).toMatchObject({
      type: "catching_up",
      taskId: task.taskId,
      body: { agent: "agent-one", mainHead },
    });
  });

  it("sync_with_main is refused for another agent's task, and for a task that is not being worked on", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const two = await s.agent("agent-two");
    const task = await startedWithWork(s, one, ["src/routes/users/"], { "src/routes/users/get.ts": "x\n" });

    expect(await syncWithMain(s.deps, two, { task_id: task.taskId })).toMatchObject({ ok: false, error: { code: "not_owner" } });
    await submit(s.deps, one, { task_id: task.taskId, summary: "s" });
    expect(await syncWithMain(s.deps, one, { task_id: task.taskId })).toMatchObject({ ok: false, error: { code: "bad_state" } });
  });

  it("submit compares the work with the commit of main the fork has caught up with", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const task = await startedWithWork(s, agent, ["src/routes/users/"], { "src/routes/users/get.ts": "x\n" });
    const mainHead = await mainMoves(s);
    const merged = await s.host.repo(task.forkName).pull(s.host.repo("demo-app"), "main", ["src/routes/users/get.ts"]);

    const result = await submit(s.deps, agent, { task_id: task.taskId, summary: "s" });

    expect(result).toMatchObject({ ok: true, data: { head_sha: merged } });
    expect((await s.coordinator.getSubmission(1))?.task.baseSha).toBe(mainHead);
  });

  it("submit keeps comparing with the commit the fork started from when the fork has not caught up", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const task = await startedWithWork(s, agent, ["src/routes/users/"], { "src/routes/users/get.ts": "x\n" });
    await mainMoves(s);

    await submit(s.deps, agent, { task_id: task.taskId, summary: "s" });

    expect((await s.coordinator.getSubmission(1))?.task.baseSha).toBe(s.mainHead);
  });

  it("submit refuses a fork whose branch shares no history with main", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const task = await startedWithWork(s, agent, ["src/routes/users/"], { "src/routes/users/get.ts": "x\n" });
    const fork = s.host.repo(task.forkName);
    fork.branches.delete("main");
    await fork.commit("main", { "README.md": "an unrelated history\n" }, "start over\n");

    const result = await submit(s.deps, agent, { task_id: task.taskId, summary: "s" });

    expect(result).toMatchObject({ ok: false, error: { code: "bad_state", message: expect.stringContaining("sync_with_main") } });
    expect(s.reviews).toEqual([]);
  });
});

describe("get_verdict", () => {
  it("reports where the task stands and the latest verdict", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const task = await startedWithWork(s, agent, ["src/db/users.ts"], { "src/db/users.ts": "x\n" });
    await submit(s.deps, agent, { task_id: task.taskId, summary: "s" });
    await s.coordinator.recordVerdict(1, {
      decision: "reject",
      source: "reviewer",
      body: { summary: "Missing export", issues: [{ severity: "critical", path: "src/db/users.ts", description: "no export" }] },
    });

    const result = await getVerdict(s.deps, agent, { task_id: task.taskId });

    expect(result).toEqual({
      ok: true,
      data: {
        task_id: task.taskId,
        state: "active",
        cycle: 2,
        paths: ["src/db/users.ts"],
        scope: [{ target: "src/db/users.ts", relation: "change", origin: "declared" }],
        claim_expires_at: new Date(T0 + 120 * MINUTE).toISOString(),
        merge_sha: null,
        related: [],
        collisions: [],
        dependents: [],
        verdict: {
          decision: "reject",
          source: "reviewer",
          cycle: 1,
          at: new Date(T0).toISOString(),
          details: {
            summary: "Missing export",
            issues: [{ severity: "critical", path: "src/db/users.ts", description: "no export" }],
          },
        },
      },
    });
  });

  it("has no verdict before the first review finishes", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const task = await startedWithWork(s, agent, ["src/db/users.ts"], { "src/db/users.ts": "x\n" });
    await submit(s.deps, agent, { task_id: task.taskId, summary: "s" });

    expect(await getVerdict(s.deps, agent, { task_id: task.taskId })).toMatchObject({
      ok: true,
      data: { state: "in_review", verdict: null, claim_expires_at: null },
    });
  });

  it("waits for a review to finish and answers as soon as there is a verdict", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const task = await startedWithWork(s, agent, ["src/db/users.ts"], { "src/db/users.ts": "x\n" });
    await submit(s.deps, agent, { task_id: task.taskId, summary: "s" });
    // The review finishes during the third second of waiting.
    s.deps.sleep = async (ms) => {
      s.sleeps.push(ms);
      if (s.sleeps.length === 3) {
        await s.coordinator.recordVerdict(1, { decision: "reject", source: "reviewer", body: { summary: "no", issues: [] } });
      }
    };

    const result = await getVerdict(s.deps, agent, { task_id: task.taskId });

    expect(result).toMatchObject({ ok: true, data: { state: "active", verdict: { decision: "reject" } } });
    expect(s.sleeps).toEqual([1000, 1000, 1000]);
  });

  it("answers that the task is still in review once it has waited as long as it was asked to", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const task = await startedWithWork(s, agent, ["src/db/users.ts"], { "src/db/users.ts": "x\n" });
    await submit(s.deps, agent, { task_id: task.taskId, summary: "s" });

    const result = await getVerdict(s.deps, agent, { task_id: task.taskId, wait_seconds: 4 });

    expect(result).toMatchObject({ ok: true, data: { state: "in_review" } });
    expect(s.sleeps).toEqual([1000, 1000, 1000, 1000]);
  });

  it("waits twenty seconds unless told otherwise, and never more than thirty", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const task = await startedWithWork(s, agent, ["src/db/users.ts"], { "src/db/users.ts": "x\n" });
    await submit(s.deps, agent, { task_id: task.taskId, summary: "s" });

    await getVerdict(s.deps, agent, { task_id: task.taskId });
    expect(s.sleeps).toHaveLength(20);

    s.sleeps.length = 0;
    await getVerdict(s.deps, agent, { task_id: task.taskId, wait_seconds: 600 });
    expect(s.sleeps).toHaveLength(30);
  });

  it("answers when a review ends by asking for a person, without then waiting for that person", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const task = await startedWithWork(s, agent, ["src/db/users.ts"], { "src/db/users.ts": "x\n" });
    await submit(s.deps, agent, { task_id: task.taskId, summary: "s" });
    s.deps.sleep = async (ms) => {
      s.sleeps.push(ms);
      if (s.sleeps.length === 2) {
        await s.coordinator.recordVerdict(1, { decision: "escalate", source: "reviewer", body: { summary: "unsure", issues: [] } });
      }
    };

    const result = await getVerdict(s.deps, agent, { task_id: task.taskId });

    expect(result).toMatchObject({ ok: true, data: { state: "escalated" } });
    expect(s.sleeps).toEqual([1000, 1000]);
  });

  it("waits while a person is deciding, and answers as soon as they have", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const task = await startedWithWork(s, agent, ["src/db/users.ts"], { "src/db/users.ts": "x\n" });
    await submit(s.deps, agent, { task_id: task.taskId, summary: "s" });
    await s.coordinator.recordVerdict(1, { decision: "escalate", source: "reviewer", body: { summary: "unsure", issues: [] } });
    // The person sends the work back during the second second of waiting.
    s.deps.sleep = async (ms) => {
      s.sleeps.push(ms);
      if (s.sleeps.length === 2) {
        await s.coordinator.decideEscalation({ taskId: task.taskId, decision: "send_back", note: "Use the result object." });
      }
    };

    const result = await getVerdict(s.deps, agent, { task_id: task.taskId });

    expect(result).toMatchObject({
      ok: true,
      data: { state: "active", cycle: 2, verdict: { decision: "reject", source: "human", details: { note: "Use the result object." } } },
    });
    expect(s.sleeps).toEqual([1000, 1000]);
  });

  it("does not wait when the task is not in review, or when asked not to", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const task = await startedWithWork(s, agent, ["src/db/users.ts"], { "src/db/users.ts": "x\n" });

    await getVerdict(s.deps, agent, { task_id: task.taskId });
    await submit(s.deps, agent, { task_id: task.taskId, summary: "s" });
    await getVerdict(s.deps, agent, { task_id: task.taskId, wait_seconds: 0 });

    expect(s.sleeps).toEqual([]);
  });

  it("gives the merge commit once the task is merged", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const task = await startedWithWork(s, agent, ["src/db/users.ts"], { "src/db/users.ts": "x\n" });
    await submit(s.deps, agent, { task_id: task.taskId, summary: "s" });
    await s.coordinator.recordVerdict(1, { decision: "approve", source: "reviewer", body: { summary: "ok", issues: [] } });
    await s.coordinator.recordMerged(1, "e".repeat(40), true);

    expect(await getVerdict(s.deps, agent, { task_id: task.taskId })).toMatchObject({
      ok: true,
      data: { state: "merged", merge_sha: "e".repeat(40) },
    });
  });
});

describe("related tasks", () => {
  // The related-work check runs when a task starts, so only the later task hears about it then.
  // The agent that claimed first learns of it from the tools it calls afterwards.
  it("tells the agent that claimed first about a coupled task that started later", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const five = await s.agent("agent-five");
    const users = await startedWithWork(s, one, ["src/routes/users/"], { "src/routes/users/get.ts": "x\n" });
    s.decider.relatedResult = [{ taskId: users.taskId, relation: "coupled", confidence: 0.7 }];
    const lookup = await startTask(s.deps, five, { goal: "Change findUser", paths: ["src/db/users.ts"] });
    if (!lookup.ok) {
      throw new Error("expected the second task to start");
    }
    const coupled = {
      task_id: lookup.data.task_id,
      agent: "agent-five",
      goal: "Change findUser",
      state: "active",
      paths: ["src/db/users.ts"],
      relation: "coupled",
      confidence: 0.7,
    };

    const submitted = await submit(s.deps, one, { task_id: users.taskId, summary: "s" });
    const verdict = await getVerdict(s.deps, one, { task_id: users.taskId, wait_seconds: 0 });

    expect(submitted).toMatchObject({ ok: true, data: { related: [coupled] } });
    expect(verdict).toMatchObject({ ok: true, data: { related: [coupled] } });
  });

  it("says in what state a related task is, so an agent can tell work in progress from work that has landed", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const five = await s.agent("agent-five");
    const users = await startedWithWork(s, one, ["src/routes/users/"], { "src/routes/users/get.ts": "x\n" });
    s.decider.relatedResult = [{ taskId: users.taskId, relation: "coupled", confidence: 0.7 }];
    const lookup = await startTask(s.deps, five, { goal: "Change findUser", paths: ["src/db/users.ts"] });
    if (!lookup.ok) {
      throw new Error("expected the second task to start");
    }
    await submit(s.deps, one, { task_id: users.taskId, summary: "s" });
    await s.coordinator.recordVerdict(1, { decision: "approve", source: "reviewer", body: { summary: "ok", issues: [] } });
    await s.coordinator.recordMerged(1, "e".repeat(40), true);

    const verdict = await getVerdict(s.deps, five, { task_id: lookup.data.task_id });

    expect(lookup.data.related).toMatchObject([{ agent: "agent-one", state: "active" }]);
    expect(verdict).toMatchObject({ ok: true, data: { related: [{ agent: "agent-one", state: "merged" }] } });
  });
});

describe("expand_claim, whats_happening and abandon", () => {
  it("expand_claim adds paths and returns the whole claim", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const started = await startTask(s.deps, agent, { goal: "g", paths: ["src/db/"] });
    if (!started.ok) {
      throw new Error("expected the task to start");
    }
    advanceTime(10 * MINUTE);

    const result = await expandClaim(s.deps, agent, { task_id: started.data.task_id, paths: ["src/utils/date.ts"] });

    expect(result).toEqual({
      ok: true,
      data: {
        paths: ["src/db/", "src/utils/date.ts"],
        scope: [
          { target: "src/db/", relation: "change", origin: "declared" },
          { target: "src/utils/date.ts", relation: "change", origin: "declared" },
        ],
        claim_expires_at: new Date(T0 + 130 * MINUTE).toISOString(),
        related: [],
        related_check: "ok",
        collisions: [],
        dependents: [],
      },
    });
  });

  it("whats_happening lists live tasks and recent merges with readable times", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const started = await startTask(s.deps, agent, { goal: "Add users", paths: ["src/routes/users/"] });
    if (!started.ok) {
      throw new Error("expected the task to start");
    }

    expect(await whatsHappening(s.deps)).toEqual({
      ok: true,
      data: {
        repository: "demo-app",
        live_tasks: [
          {
            task_id: started.data.task_id,
            agent: "agent-one",
            goal: "Add users",
            state: "active",
            paths: ["src/routes/users/"],
            scope: [{ target: "src/routes/users/", relation: "change", origin: "declared" }],
            started_at: new Date(T0).toISOString(),
          },
        ],
        waiting: [],
        recent_merges: [],
      },
    });
  });

  it("abandon gives the paths back", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const two = await s.agent("agent-two");
    const started = await startTask(s.deps, one, { goal: "g", paths: ["src/a.ts"] });
    if (!started.ok) {
      throw new Error("expected the task to start");
    }

    expect(await abandon(s.deps, one, { task_id: started.data.task_id })).toEqual({ ok: true, data: { abandoned: true } });

    expect((await startTask(s.deps, two, { goal: "g", paths: ["src/a.ts"] })).ok).toBe(true);
  });
});

describe("a scope with relations", () => {
  it("is taken by start_task and handed back with what dibs added to it", async () => {
    const s = await setup({}, CODE);
    await buildIndex(s);
    const agent = await s.agent("agent-one");

    const data = started(
      await startTask(s.deps, agent, {
        goal: "Add a route",
        scope: [
          { target: "src/routes/list.ts", relation: "change" },
          { target: "src/routes/index.ts", relation: "add" },
        ],
      }),
    );

    expect(data).toMatchObject({
      paths: ["src/routes/index.ts", "src/routes/list.ts"],
      scope: [
        { target: "src/routes/index.ts", relation: "add", origin: "declared" },
        { target: "src/routes/list.ts", relation: "change", origin: "declared" },
        // list.ts uses findUser; the agent did not have to say so.
        { target: "src/db/users.ts#findUser", relation: "rely", origin: "inferred" },
      ],
    });
  });

  it("takes paths and a scope together", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");

    const data = started(
      await startTask(s.deps, agent, { goal: "g", paths: ["src/a.ts"], scope: [{ target: "src/app.ts", relation: "add" }] }),
    );

    expect(data.paths).toEqual(["src/a.ts", "src/app.ts"]);
  });

  it("lists what the task holds before what it relies on, and cuts a long list of what dibs found", async () => {
    const lib = Array.from({ length: 70 }, (_unused, index) => `export const v${index} = ${index};`).join("\n");
    const user = `import { ${Array.from({ length: 70 }, (_unused, index) => `v${index}`).join(", ")} } from "./lib";\n`;
    const s = await setup({}, { "src/lib.ts": lib, "src/user.ts": user });
    await buildIndex(s);
    const agent = await s.agent("agent-one");

    const data = started(await startTask(s.deps, agent, { goal: "g", paths: ["src/user.ts"] }));

    expect(data.scope).toHaveLength(40);
    expect(data.scope[0]).toEqual({ target: "src/user.ts", relation: "change", origin: "declared" });
    expect(data.scope_cut).toBe(31);
  });

  it("tells both tasks when one changes what the other relies on", async () => {
    const s = await setup({}, CODE);
    await buildIndex(s);
    const five = await s.agent("agent-five");
    const one = await s.agent("agent-one");

    const provider = started(
      await startTask(s.deps, five, {
        goal: "Make findUser return a result",
        scope: [
          { target: "src/db/users.ts#findUser", relation: "change" },
          { target: "test/users.test.ts", relation: "change" },
        ],
      }),
    );
    const relier = started(await startTask(s.deps, one, { goal: "Rework the list route", paths: ["src/routes/list.ts"] }));

    expect(relier.collisions).toEqual([
      {
        kind: "contract",
        state: "open",
        role: "relier",
        with: { task_id: provider.task_id, agent: "agent-five", goal: "Make findUser return a result", state: "active", merge_sha: null },
        targets: ["src/db/users.ts#findUser"],
        order: { first: "agent-five", why: expect.stringContaining("neither task has submitted") },
        brief: expect.stringContaining("agent-five is changing src/db/users.ts#findUser, which your work uses."),
      },
    ]);
    const told = await getVerdict(s.deps, five, { task_id: provider.task_id });
    expect(told.ok && told.data.collisions).toMatchObject([{ role: "provider", with: { agent: "agent-one" } }]);
  });

  it("tells a task that will change an interface which files use it and are not in its scope", async () => {
    const s = await setup({}, CODE);
    await buildIndex(s);
    const five = await s.agent("agent-five");
    const one = await s.agent("agent-one");
    started(await startTask(s.deps, one, { goal: "Rework the tests", paths: ["test/users.test.ts"] }));

    const provider = started(
      await startTask(s.deps, five, { goal: "Make findUser return a result", scope: [{ target: "src/db/users.ts#findUser", relation: "change" }] }),
    );

    expect(provider.dependents).toEqual([
      {
        target: "src/db/users.ts#findUser",
        used_by: [
          { path: "src/routes/list.ts", held_by: null },
          { path: "test/users.test.ts", held_by: "agent-one" },
        ],
      },
    ]);
  });

  it("says in a refusal how the other task holds what was asked for", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const two = await s.agent("agent-two");
    started(await startTask(s.deps, one, { goal: "g1", scope: [{ target: "src/app.ts", relation: "add" }] }));

    const refused = await startTask(s.deps, two, { goal: "g2", paths: ["src/app.ts"] });

    expect(refused).toMatchObject({ ok: false, conflicts: [{ agent: "agent-one", held: [{ target: "src/app.ts", relation: "add" }] }] });
  });
});

describe("waiting in line", () => {
  // Makes the holder give its paths up while the other agent's call is waiting.
  function releaseAfter(s: Setup, sleeps: number, release: () => Promise<unknown>): void {
    let slept = 0;
    s.deps.sleep = async (ms) => {
      s.sleeps.push(ms);
      slept++;
      if (slept === sleeps) {
        await release();
      }
    };
  }

  it("start_task waits when asked to, and starts the task as soon as its paths are free", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const two = await s.agent("agent-two");
    const holder = started(await startTask(s.deps, one, { goal: "g1", paths: ["src/a.ts"] }));
    releaseAfter(s, 3, () => abandon(s.deps, one, { task_id: holder.task_id }));

    const data = started(await startTask(s.deps, two, { goal: "g2", paths: ["src/a.ts"], wait_seconds: 30 }));

    expect(s.sleeps).toEqual([1000, 1000, 1000]);
    expect(data).toMatchObject({ paths: ["src/a.ts"], base_sha: s.mainHead, token: `token-demo-app--${data.task_id}-write` });
    expect(s.host.has(`demo-app--${data.task_id}`)).toBe(true);
    expect(await s.coordinator.getTask({ agentId: two.id, taskId: data.task_id })).toMatchObject({ task: { state: "active", baseSha: s.mainHead } });
  });

  it("start_task answers that it is still waiting, with what to call it again with", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const two = await s.agent("agent-two");
    const holder = started(await startTask(s.deps, one, { goal: "g1", paths: ["src/a.ts"] }));

    const result = await startTask(s.deps, two, { goal: "g2", paths: ["src/a.ts"], wait_seconds: 2 });

    expect(result).toEqual({
      ok: true,
      data: {
        status: "waiting",
        request_id: expect.stringMatching(/^w-/),
        position: 1,
        blocking: [expect.objectContaining({ task_id: holder.task_id, agent: "agent-one", paths: ["src/a.ts"] })],
        message:
          "What you asked for is held by another task. You are first in line. Call start_task again with this request_id to keep waiting; " +
          "a request that is not asked about for three minutes is dropped. To do other work meanwhile, call abandon with the request_id.",
      },
    });
    expect(s.sleeps).toEqual([1000, 1000]);
    expect(s.host.tokensIssued).toHaveLength(1);
  });

  it("start_task goes on waiting when called again with the request", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const two = await s.agent("agent-two");
    const holder = started(await startTask(s.deps, one, { goal: "g1", paths: ["src/a.ts"] }));
    const first = waiting(await startTask(s.deps, two, { goal: "g2", paths: ["src/a.ts"], wait_seconds: 1 }));
    await abandon(s.deps, one, { task_id: holder.task_id });

    const data = started(await startTask(s.deps, two, { request_id: first.request_id }));

    expect(data.paths).toEqual(["src/a.ts"]);
    expect(await s.coordinator.getTask({ agentId: two.id, taskId: data.task_id })).toMatchObject({ task: { goal: "g2" } });
  });

  it("start_task is refused at once, as before, when it is not asked to wait", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const two = await s.agent("agent-two");
    started(await startTask(s.deps, one, { goal: "g1", paths: ["src/a.ts"] }));

    expect(await startTask(s.deps, two, { goal: "g2", paths: ["src/a.ts"] })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(s.sleeps).toEqual([]);
    expect((await s.coordinator.snapshot())?.waiting).toEqual([]);
  });

  it("start_task says when a request is no longer in line", async () => {
    const s = await setup();
    const two = await s.agent("agent-two");

    expect(await startTask(s.deps, two, { request_id: "w-nothere0" })).toMatchObject({
      ok: false,
      error: { code: "not_found", message: expect.stringContaining("no longer waiting"), retryable: false },
    });
  });

  it("start_task needs a goal and something to hold, unless it is given a request to wait on", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");

    expect(await startTask(s.deps, agent, {})).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await startTask(s.deps, agent, { goal: "g" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("expand_scope waits for a file another task holds, and gets it when that task ends", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const two = await s.agent("agent-two");
    const holder = started(await startTask(s.deps, one, { goal: "g1", paths: ["src/a.ts"] }));
    const task = started(await startTask(s.deps, two, { goal: "g2", paths: ["src/b.ts"] }));
    releaseAfter(s, 2, () => abandon(s.deps, one, { task_id: holder.task_id }));

    const result = await expandScope(s.deps, two, { task_id: task.task_id, paths: ["src/a.ts"], wait_seconds: 30 });

    expect(result).toMatchObject({ ok: true, data: { paths: ["src/a.ts", "src/b.ts"] } });
    expect(s.sleeps).toEqual([1000, 1000]);
  });

  it("expand_scope answers that it is still waiting, and goes on when called again with the request", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const two = await s.agent("agent-two");
    const holder = started(await startTask(s.deps, one, { goal: "g1", paths: ["src/a.ts"] }));
    const task = started(await startTask(s.deps, two, { goal: "g2", paths: ["src/b.ts"] }));

    const first = waiting(await expandScope(s.deps, two, { task_id: task.task_id, paths: ["src/a.ts"], wait_seconds: 1 }));
    expect(first.message).toContain("Call expand_scope again with this request_id");
    await abandon(s.deps, one, { task_id: holder.task_id });

    expect(await expandScope(s.deps, two, { task_id: task.task_id, request_id: first.request_id })).toMatchObject({
      ok: true,
      data: { paths: ["src/a.ts", "src/b.ts"] },
    });
  });

  it("abandon takes a request out of the line", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const two = await s.agent("agent-two");
    started(await startTask(s.deps, one, { goal: "g1", paths: ["src/a.ts"] }));
    const first = waiting(await startTask(s.deps, two, { goal: "g2", paths: ["src/a.ts"], wait_seconds: 1 }));

    expect(await abandon(s.deps, two, { request_id: first.request_id })).toEqual({ ok: true, data: { abandoned: true } });
    expect((await s.coordinator.snapshot())?.waiting).toEqual([]);
  });

  it("whats_happening shows the line", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const two = await s.agent("agent-two");
    const holder = started(await startTask(s.deps, one, { goal: "g1", paths: ["src/a.ts"] }));
    const first = waiting(await startTask(s.deps, two, { goal: "g2", paths: ["src/a.ts"], wait_seconds: 1 }));

    const happening = await whatsHappening(s.deps);

    expect(happening.ok && happening.data.waiting).toEqual([
      {
        request_id: first.request_id,
        agent: "agent-two",
        goal: "g2",
        task_id: null,
        scope: [{ target: "src/a.ts", relation: "change" }],
        position: 1,
        waiting_for: [{ task_id: holder.task_id, agent: "agent-one" }],
        since: new Date(T0).toISOString(),
      },
    ]);
  });
});

describe("expand_scope and declare_interface_change", () => {
  it("expand_scope asks the decision model again, about the task as it now is", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const two = await s.agent("agent-two");
    const other = started(await startTask(s.deps, one, { goal: "Add GET /users/:id", paths: ["src/routes/"] }));
    const task = started(await startTask(s.deps, two, { goal: "Make findUser return a result", paths: ["test/users.test.ts"] }));
    s.decider.relatedResult = [{ taskId: other.task_id, relation: "coupled", confidence: 0.8 }];

    const result = await expandScope(s.deps, two, { task_id: task.task_id, paths: ["src/db/users.ts"] });

    expect(result).toMatchObject({
      ok: true,
      data: { related: [{ task_id: other.task_id, agent: "agent-one", relation: "coupled", confidence: 0.8 }], related_check: "ok" },
    });
    expect(s.decider.relatedCalls.at(-1)).toMatchObject({
      newTask: { goal: "Make findUser return a result", paths: ["src/db/users.ts", "test/users.test.ts"] },
      liveTasks: [{ taskId: other.task_id }],
    });
  });

  it("expand_scope still grants when the decision model fails", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const two = await s.agent("agent-two");
    started(await startTask(s.deps, one, { goal: "g1", paths: ["src/a.ts"] }));
    const task = started(await startTask(s.deps, two, { goal: "g2", paths: ["src/b.ts"] }));
    s.decider.relatedResult = new Error("Workers AI returned 503");

    expect(await expandScope(s.deps, two, { task_id: task.task_id, paths: ["src/c.ts"] })).toMatchObject({
      ok: true,
      data: { paths: ["src/b.ts", "src/c.ts"], related_check: "unavailable" },
    });
  });

  it("declare_interface_change adds the interface to the task's scope and says who uses it", async () => {
    const s = await setup({}, CODE);
    await buildIndex(s);
    const five = await s.agent("agent-five");
    const one = await s.agent("agent-one");
    const relier = started(await startTask(s.deps, one, { goal: "Rework the list route", paths: ["src/routes/list.ts"] }));
    const task = started(await startTask(s.deps, five, { goal: "Tidy the users module", paths: ["src/db/users.ts"] }));
    expect(task.collisions).toMatchObject([{ state: "possible" }]);

    const result = await declareInterfaceChange(s.deps, five, { task_id: task.task_id, target: "src/db/users.ts#findUser" });

    expect(result).toMatchObject({
      ok: true,
      data: {
        scope: [
          { target: "src/db/users.ts", relation: "change", origin: "declared" },
          { target: "src/db/users.ts#findUser", relation: "change", origin: "declared" },
        ],
        collisions: [{ state: "open", role: "provider", with: { task_id: relier.task_id } }],
        dependents: [
          {
            target: "src/db/users.ts#findUser",
            used_by: [
              { path: "src/routes/list.ts", held_by: "agent-one" },
              { path: "test/users.test.ts", held_by: null },
            ],
          },
        ],
      },
    });
  });

  it("declare_interface_change is refused for a target that is not an interface", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const task = started(await startTask(s.deps, agent, { goal: "g", paths: ["src/a.ts"] }));

    expect(await declareInterfaceChange(s.deps, agent, { task_id: task.task_id, target: "src/a.ts" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: 'name the interface as path#name, for example "src/users.ts#findUser"' },
    });
  });
});

describe("peek", () => {
  async function twoThatMeet() {
    const s = await setup({}, CODE);
    await buildIndex(s);
    const five = await s.agent("agent-five");
    const one = await s.agent("agent-one");
    const provider = started(
      await startTask(s.deps, five, { goal: "Make findUser return a result", scope: [{ target: "src/db/users.ts#findUser", relation: "change" }] }),
    );
    const relier = started(await startTask(s.deps, one, { goal: "Rework the list route", paths: ["src/routes/list.ts"] }));
    return { s, five, one, provider, relier };
  }

  it("shows a task the work of another task it meets, as it stands in that task's fork", async () => {
    const { s, one, provider, relier } = await twoThatMeet();
    const head = await s.host
      .repo(`demo-app--${provider.task_id}`)
      .commit("main", { "src/db/users.ts": "export function findUser(id: string): Found { return { ok: false }; }\n" }, "work\n");

    const result = await peek(s.deps, one, { task_id: relier.task_id, other_task_id: provider.task_id });

    expect(result).toMatchObject({
      ok: true,
      data: {
        task_id: provider.task_id,
        agent: "agent-five",
        goal: "Make findUser return a result",
        state: "active",
        summary: null,
        head_sha: head,
        files: [{ path: "src/db/users.ts", status: "modified" }],
        truncated: false,
      },
    });
    expect(result.ok && result.data.diff).toContain("+export function findUser(id: string): Found { return { ok: false }; }");
  });

  it("says so when the other task has pushed nothing yet", async () => {
    const { s, one, provider, relier } = await twoThatMeet();

    expect(await peek(s.deps, one, { task_id: relier.task_id, other_task_id: provider.task_id })).toMatchObject({
      ok: true,
      data: { files: [], diff: "", head_sha: s.mainHead },
    });
  });

  it("never hands out the other task's token", async () => {
    const { s, one, provider, relier } = await twoThatMeet();
    const before = s.host.tokensIssued.length;

    const result = await peek(s.deps, one, { task_id: relier.task_id, other_task_id: provider.task_id });

    expect(s.host.tokensIssued).toHaveLength(before);
    expect(JSON.stringify(result)).not.toContain("token-");
  });

  it("is refused for a task that this one has nothing to do with", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const two = await s.agent("agent-two");
    const first = started(await startTask(s.deps, one, { goal: "g1", paths: ["src/a.ts"] }));
    const second = started(await startTask(s.deps, two, { goal: "g2", paths: ["src/b.ts"] }));

    expect(await peek(s.deps, one, { task_id: first.task_id, other_task_id: second.task_id })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});

describe("submit, with what dibs knows about the task", () => {
  it("passes on what the agent says about the files it leaves as they were", async () => {
    const s = await setup();
    const agent = await s.agent("agent-one");
    const task = await startedWithWork(s, agent, ["src/db/users.ts"], { "src/db/users.ts": "export const users = [1];\n" });

    const result = await submit(s.deps, agent, { task_id: task.taskId, summary: "s", leaves_dependents: "nothing else reads the list" });

    expect(result.ok).toBe(true);
    expect(await s.coordinator.getSubmission(result.ok ? result.data.submission_id : 0)).toMatchObject({ leaves: "nothing else reads the list" });
  });

  it("holds back a task that repeats an earlier one until it says that it differs", async () => {
    const s = await setup();
    const one = await s.agent("agent-one");
    const two = await s.agent("agent-two");
    const earlier = started(await startTask(s.deps, one, { goal: "Add rate limiting", paths: ["src/a.ts"] }));
    s.decider.relatedResult = [{ taskId: earlier.task_id, relation: "duplicate", confidence: 0.9 }];
    const later = await startedWithWork(s, two, ["src/b.ts"], { "src/b.ts": "export const b = 1;\n" });

    const refused = await submit(s.deps, two, { task_id: later.taskId, summary: "s" });
    const accepted = await submit(s.deps, two, { task_id: later.taskId, summary: "A different limiter: per route, not per client.", confirm_distinct: true });

    expect(refused).toMatchObject({ ok: false, error: { code: "duplicate", message: expect.stringContaining("confirm_distinct") } });
    expect(accepted).toMatchObject({ ok: true, data: { status: "in_review", collisions: [] } });
  });

  it("tells the agent, with its submission, which tasks its work meets", async () => {
    const s = await setup({}, CODE);
    await buildIndex(s);
    const five = await s.agent("agent-five");
    const one = await s.agent("agent-one");
    const relier = await startedWithWork(s, one, ["src/routes/list.ts"], { "src/routes/list.ts": "export const listRoute = 1;\n" });
    started(await startTask(s.deps, five, { goal: "Make findUser return a result", scope: [{ target: "src/db/users.ts#findUser", relation: "change" }] }));

    const result = await submit(s.deps, one, { task_id: relier.taskId, summary: "s" });

    expect(result).toMatchObject({ ok: true, data: { collisions: [{ role: "relier", with: { agent: "agent-five" }, order: { first: "agent-one" } }] } });
  });
});
