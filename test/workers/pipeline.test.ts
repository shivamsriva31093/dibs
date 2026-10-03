import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewerVerdict } from "../../src/checks";
import { indexTree } from "../../src/index/build";
import { indexFile } from "../../src/index/file";
import { runReview, type PipelineDeps } from "../../src/pipeline";
import { DEFAULT_DECIDER_CONFIG, type RepoConfig, type Triage } from "../../src/types";
import { freezeTime, newAgent, newCoordinator, T0, type CoordinatorStub } from "./helpers/coordinator";
import {
  APPROVE,
  CALM_TRIAGE,
  CANDIDATE_SHA,
  FakeDecider,
  FakeGate,
  FakeMergeEngine,
  FakeReviewer,
  GATE_FAILED,
  GATE_PASSED,
  ImmediateSteps,
  MAIN_SHA,
  MERGE_SHA,
  TREE_SHA,
} from "./helpers/fakes";
import { MemoryRepoHost } from "./helpers/memory-host";

beforeEach(() => freezeTime());
afterEach(() => vi.useRealTimers());

const SEED = {
  "README.md": "# demo\n",
  "AGENTS.md": "Use named exports only.\n",
  "package.json": '{"name":"demo"}\n',
  "src/db/users.ts": "export function findUser(id) { return null; }\n",
  "src/routes/index.ts": "export const routes = [];\n",
  "src/utils/date.ts": "export const now = () => Date.now();\n",
};

type Work = Record<string, string | Uint8Array | null>;

interface Setup {
  coordinator: CoordinatorStub;
  host: MemoryRepoHost;
  decider: FakeDecider;
  reviewer: FakeReviewer;
  merge: FakeMergeEngine;
  steps: ImmediateSteps;
  deps: PipelineDeps;
  agentId: string;
  taskId: string;
  forkName: string;
  headSha: string;
  submissionId: number;
  run(options?: { mergeOnly?: boolean }): ReturnType<typeof runReview>;
  // Commits more work in the fork and submits the task again; returns how to run that review.
  resubmit(work: Work): Promise<{ submissionId: number; run(): ReturnType<typeof runReview> }>;
  state(): Promise<string>;
  latestVerdict(): Promise<{ decision: string; source: string; body: Record<string, unknown> } | null>;
  eventTypes(): Promise<string[]>;
}

async function setup(options: {
  claim: string[];
  work: Work;
  goal?: string;
  config?: Partial<RepoConfig>;
  commitMessage?: string;
  // Files the repository holds besides SEED.
  seed?: Record<string, string>;
  // Read the repository into the interface index, as registering it does.
  index?: boolean;
  // What the agent says about files it leaves as they were.
  leaves?: string;
}): Promise<Setup> {
  const coordinator = await newCoordinator(options.config);
  const host = new MemoryRepoHost();
  const seedSha = await host.seed("demo-app", { ...SEED, ...options.seed });
  if (options.index) {
    const main = await host.open("demo-app");
    const built = await indexTree(main, (await main.readCommit(seedSha))!.tree);
    await coordinator.indexFiles({ files: built.files, removed: [], sha: seedSha, reset: true });
  }

  const agentId = await newAgent(coordinator, "agent-one");
  const started = await coordinator.startTask({
    agentId,
    goal: options.goal ?? "Make findUser return a result object",
    paths: options.claim,
  });
  if (!started.ok) {
    throw new Error(`claim refused: ${started.error.message}`);
  }
  const taskId = started.task.id;
  const forkName = started.task.forkName;
  await (await host.open("demo-app")).fork(forkName);
  const base = await (await host.open(forkName)).head("main");
  await coordinator.attachFork(taskId, base!.oid);

  const headSha = await host.repo(forkName).commit("main", options.work, options.commitMessage ?? "work\n");
  const submission = await coordinator.submit({
    agentId,
    taskId,
    summary: "Did the work.",
    headSha,
    ...(options.leaves === undefined ? {} : { leaves: options.leaves }),
  });
  if (!submission.ok) {
    throw new Error(`submit failed: ${submission.error.message}`);
  }

  const decider = new FakeDecider();
  const reviewer = new FakeReviewer();
  const merge = new FakeMergeEngine();
  const steps = new ImmediateSteps();
  const deps: PipelineDeps = { coordinator, host, decider, reviewer, merge, now: () => Date.now() };
  const submissionId = submission.submissionId;

  return {
    coordinator,
    host,
    decider,
    reviewer,
    merge,
    steps,
    deps,
    agentId,
    taskId,
    forkName,
    headSha,
    submissionId,
    run: (runOptions = {}) => runReview(deps, steps, { repo: "demo-app", submissionId, ...runOptions }),
    resubmit: async (work) => {
      const head = await host.repo(forkName).commit("main", work, "more work\n");
      const next = await coordinator.submit({ agentId, taskId, summary: "Did more.", headSha: head });
      if (!next.ok) {
        throw new Error(`submit failed: ${next.error.message}`);
      }
      return {
        submissionId: next.submissionId,
        run: () => runReview(deps, new ImmediateSteps(), { repo: "demo-app", submissionId: next.submissionId }),
      };
    },
    state: async () => {
      const view = await coordinator.getTask({ agentId, taskId });
      if (!view.ok) {
        throw new Error(view.error.message);
      }
      return view.task.state;
    },
    latestVerdict: async () => {
      const context = await coordinator.getSubmission(submissionId);
      const verdict = context?.verdicts.at(-1);
      return verdict === undefined ? null : { decision: verdict.decision, source: verdict.source, body: verdict.body };
    },
    eventTypes: async () => (await coordinator.listEvents()).map((event) => event.type),
  };
}

const usersWork: Work = { "src/db/users.ts": "export function findUser(id) { return { ok: false }; }\n" };

describe("an approved change", () => {
  it("is merged and the task finishes", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });

    const result = await s.run();

    expect(result).toEqual({ outcome: "merged", mergeSha: MERGE_SHA });
    expect(await s.state()).toBe("merged");
    expect(s.steps.names).toEqual(["load", "changes", "interfaces", "diff", "gate", "triage", "review", "decide", "lock-1", "merge"]);
  });

  it("hands the merge the task's changes, the agent as author and a commit message with trailers", async () => {
    const s = await setup({
      claim: ["src/db/users.ts"],
      work: usersWork,
      commitMessage: "Return a result object\n\nEntire-Checkpoint: a3b2c4d5e6f7\n",
    });

    await s.run();

    expect(s.merge.calls).toHaveLength(1);
    const request = s.merge.calls[0]!;
    expect(request).toMatchObject({
      repo: "demo-app",
      branch: "main",
      fork: s.forkName,
      taskId: s.taskId,
      author: { name: "agent-one", email: "agent-one@agents.dibs.invalid" },
      now: Math.floor(T0 / 1000),
    });
    expect(request.changes.map((change) => [change.path, change.status])).toEqual([["src/db/users.ts", "modified"]]);
    expect(request.message).toBe(
      [
        "Make findUser return a result object",
        "",
        "Did the work.",
        "",
        `Dibs-Task: ${s.taskId}`,
        "Dibs-Agent: agent-one",
        "Dibs-Claim: src/db/users.ts",
        "Dibs-Verdict: approve; reviewer=claude-opus-5-5; cycle=1",
        `Dibs-Fork: ${s.forkName}@${s.headSha}`,
        "Entire-Checkpoint: a3b2c4d5e6f7",
        "",
      ].join("\n"),
    );
  });

  it("attaches the whole verdict to the merge as a note", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });

    await s.run();

    expect(JSON.parse(s.merge.calls[0]!.note!)).toEqual({
      task: s.taskId,
      agent: "agent-one",
      goal: "Make findUser return a result object",
      claim: ["src/db/users.ts"],
      cycle: 1,
      approved_by: "reviewer",
      decision: "approve",
      summary: "Does what the goal says.",
      issues: [],
      model: "claude-opus-5-5",
      triage: CALM_TRIAGE,
      shadow: { would_auto_approve: true },
    });
  });

  it("stores the reviewer's verdict with the triage and the shadow answer", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });

    await s.run();

    const context = await s.coordinator.getSubmission(s.submissionId);
    expect(context?.verdicts).toMatchObject([
      {
        decision: "approve",
        source: "reviewer",
        body: {
          decision: "approve",
          summary: "Does what the goal says.",
          issues: [],
          model: "claude-opus-5-5",
          triage: CALM_TRIAGE,
          shadow: { would_auto_approve: true },
        },
      },
    ]);
    expect(context?.submission.triage).toEqual(CALM_TRIAGE);
  });

  it("gives the reviewer the diff, the triage, the repo conventions and the related tasks", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });
    const otherAgent = await newAgent(s.coordinator, "agent-two");
    const other = await s.coordinator.startTask({ agentId: otherAgent, goal: "Add GET /users/:id", paths: ["src/routes/"] });
    if (!other.ok) {
      throw new Error("expected the second claim to be granted");
    }
    await s.coordinator.recordRelated(s.taskId, [{ taskId: other.task.id, relation: "coupled", confidence: 0.8 }]);

    await s.run();

    expect(s.reviewer.calls).toHaveLength(1);
    const input = s.reviewer.calls[0]!;
    expect(input).toMatchObject({
      agent: "agent-one",
      goal: "Make findUser return a result object",
      claim: ["src/db/users.ts"],
      summary: "Did the work.",
      cycle: 1,
      triage: CALM_TRIAGE,
      conventions: "Use named exports only.\n",
      checkCallers: false,
      related: [{ agent: "agent-two", goal: "Add GET /users/:id", relation: "coupled", state: "active" }],
    });
    expect(input.files.map((file) => file.path)).toEqual(["src/db/users.ts"]);
    expect(input.files[0]!.text).toContain("+export function findUser(id) { return { ok: false }; }");
    expect(s.decider.triageCalls[0]).toMatchObject({
      goal: "Make findUser return a result object",
      claim: ["src/db/users.ts"],
      summary: "Did the work.",
      related: [{ agent: "agent-two", goal: "Add GET /users/:id", relation: "coupled" }],
    });
    expect(s.decider.triageCalls[0]!.files[0]!.diff).toBe(input.files[0]!.text);
  });

  it("reviews without conventions when the repository has no AGENTS.md", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });
    await s.host.repo("demo-app").commit("main", { "AGENTS.md": null }, "remove conventions\n");

    await s.run();

    expect(s.reviewer.calls[0]!.conventions).toBeNull();
  });
});

describe("mechanical checks", () => {
  it("rejects a change outside the claim without calling any model", async () => {
    const s = await setup({
      claim: ["src/db/"],
      work: { ...usersWork, "src/utils/date.ts": "export const now = () => 0;\n" },
    });

    const result = await s.run();

    expect(result).toEqual({ outcome: "rejected" });
    expect(await s.state()).toBe("active");
    expect(await s.latestVerdict()).toMatchObject({
      decision: "reject",
      source: "check",
      body: { check: "coverage", details: { uncovered: ["src/utils/date.ts"] } },
    });
    expect(s.decider.triageCalls).toEqual([]);
    expect(s.reviewer.calls).toEqual([]);
    expect(s.merge.calls).toEqual([]);
    expect(await s.eventTypes()).toContain("check_failed");
  });

  it("rejects a submission whose commits change nothing", async () => {
    const s = await setup({ claim: ["src/db/"], work: {} });

    const result = await s.run();

    expect(result).toEqual({ outcome: "rejected" });
    expect(await s.latestVerdict()).toMatchObject({ decision: "reject", source: "check", body: { check: "empty" } });
  });

  it("escalates more than 50 changed files without calling any model", async () => {
    const work: Work = {};
    for (let index = 0; index < 51; index++) {
      work[`src/gen/f${index}.ts`] = `export const v${index} = ${index};\n`;
    }
    const s = await setup({ claim: ["src/gen/"], work });

    const result = await s.run();

    expect(result).toEqual({ outcome: "escalated" });
    expect(await s.state()).toBe("escalated");
    expect(await s.latestVerdict()).toMatchObject({ decision: "escalate", source: "check", body: { check: "size" } });
    expect(s.reviewer.calls).toEqual([]);
  });

  it("escalates a binary file without calling any model", async () => {
    const s = await setup({ claim: ["assets/"], work: { "assets/logo.png": new Uint8Array([137, 80, 78, 71, 0, 1, 2]) } });

    const result = await s.run();

    expect(result).toEqual({ outcome: "escalated" });
    expect(await s.latestVerdict()).toMatchObject({
      decision: "escalate",
      source: "check",
      body: { check: "size", details: { unreviewable: ["assets/logo.png"] } },
    });
    expect(s.decider.triageCalls).toEqual([]);
    expect(s.reviewer.calls).toEqual([]);
  });

  it("escalates a diff over the size limit without calling any model", async () => {
    const s = await setup({ claim: ["src/big.ts"], work: { "src/big.ts": "export const line = 1; // filler text\n".repeat(4000) } });

    const result = await s.run();

    expect(result).toEqual({ outcome: "escalated" });
    expect(await s.latestVerdict()).toMatchObject({ decision: "escalate", source: "check", body: { check: "size" } });
    expect(s.reviewer.calls).toEqual([]);
  });

  it("escalates a failed check on the last allowed cycle instead of sending it back again", async () => {
    const s = await setup({
      claim: ["src/db/"],
      work: { "src/utils/date.ts": "export const now = () => 0;\n" },
      config: { maxCycles: 1 },
    });

    const result = await s.run();

    expect(result).toEqual({ outcome: "escalated" });
    expect(await s.latestVerdict()).toMatchObject({
      decision: "escalate",
      source: "check",
      body: { check: "coverage", reasons: [{ kind: "max_cycles" }] },
    });
  });
});

describe("the reviewer's verdict", () => {
  const rejection: ReviewerVerdict = {
    decision: "reject",
    summary: "Breaks the null case.",
    issues: [{ severity: "critical", path: "src/db/users.ts", line: 1, description: "Returns ok:false for every id" }],
  };

  it("sends a rejected change back with the reviewer's issues, and does not merge", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });
    s.reviewer.result = rejection;

    const result = await s.run();

    expect(result).toEqual({ outcome: "rejected" });
    expect(await s.state()).toBe("active");
    expect(await s.latestVerdict()).toMatchObject({
      decision: "reject",
      source: "reviewer",
      body: { decision: "reject", summary: "Breaks the null case.", issues: rejection.issues },
    });
    expect(s.merge.calls).toEqual([]);
  });

  it("escalates a rejection on the last allowed cycle", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork, config: { maxCycles: 1 } });
    s.reviewer.result = rejection;

    const result = await s.run();

    expect(result).toEqual({ outcome: "escalated" });
    expect(await s.latestVerdict()).toMatchObject({
      decision: "escalate",
      source: "reviewer",
      body: { decision: "reject", reasons: [{ kind: "max_cycles", detail: "rejected on cycle 1 of 1" }] },
    });
  });

  it("escalates when the reviewer asks for a person", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });
    s.reviewer.result = { decision: "escalate", summary: "Cannot tell whether callers cope.", issues: [] };

    const result = await s.run();

    expect(result).toEqual({ outcome: "escalated" });
    expect(await s.latestVerdict()).toMatchObject({
      decision: "escalate",
      body: { reasons: [{ kind: "reviewer", detail: "Cannot tell whether callers cope." }] },
    });
    expect(s.merge.calls).toEqual([]);
  });

  it("escalates an approved change to a protected path", async () => {
    const s = await setup({ claim: ["package.json"], work: { "package.json": '{"name":"demo","version":"2"}\n' } });

    const result = await s.run();

    expect(result).toEqual({ outcome: "escalated" });
    expect(await s.state()).toBe("escalated");
    expect(await s.latestVerdict()).toMatchObject({
      decision: "escalate",
      source: "reviewer",
      body: { decision: "approve", reasons: [{ kind: "protected_path", paths: ["package.json"] }] },
    });
    expect(s.merge.calls).toEqual([]);
  });
});

describe("what the reviewer is given beyond the diff", () => {
  it("can read the repository as it is at the submitted commit, including files the task did not change", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });
    const seen: string[] = [];
    s.reviewer.during = async (input) => {
      seen.push(await input.lookup!.readFile("src/db/users.ts"));
      seen.push(await input.lookup!.readFile("README.md"));
    };

    await s.run();

    expect(seen[0]).toContain(String(usersWork["src/db/users.ts"]).split("\n")[0]);
    expect(seen[1]).toBe(`1\t${SEED["README.md"].trimEnd()}`);
  });

  it("records what the reviewer looked up alongside its verdict", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });
    s.reviewer.lookups = ["read src/db/client.ts", 'searched for "findUser"'];

    await s.run();

    const context = await s.coordinator.getSubmission(s.submissionId);
    expect(context?.verdicts[0]?.body.lookups).toEqual(["read src/db/client.ts", 'searched for "findUser"']);
  });

  it("is told what the reviewer said when it sent the previous attempt back", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });
    s.reviewer.result = {
      decision: "reject",
      summary: "No test covers the new return value.",
      issues: [{ severity: "major", path: "src/db/users.ts", line: 3, description: "Untested.", suggestion: "Add a test." }],
    };
    await s.run();
    const again = await s.resubmit({ "src/db/users.ts": "export const fixed = true;\n" });
    s.reviewer.result = APPROVE;

    await again.run();

    expect(s.reviewer.calls[0]!.previous).toBeNull();
    expect(s.reviewer.calls[1]!.previous).toEqual({
      by: "reviewer",
      feedback: "No test covers the new return value.\n- major src/db/users.ts:3 Untested. Fix: Add a test.",
    });
  });

  it("is told what a person wrote when they sent the previous attempt back", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });
    s.reviewer.result = { decision: "escalate", summary: "Collides with another task.", issues: [] };
    await s.run();
    await s.coordinator.decideEscalation({ taskId: s.taskId, decision: "send_back", note: "findUser changed on main. Catch up and use the result object." });
    const again = await s.resubmit({ "src/db/users.ts": "export const fixed = true;\n" });
    s.reviewer.result = APPROVE;

    await again.run();

    expect(s.reviewer.calls[1]!.previous).toEqual({
      by: "person",
      feedback: "findUser changed on main. Catch up and use the result object.",
    });
  });
});

describe("a fork that has caught up with main", () => {
  // The task forked at the first commit. Another task then landed on main, and the
  // agent merged main into its fork and adapted its own file to it.
  async function caughtUp() {
    const coordinator = await newCoordinator();
    const host = new MemoryRepoHost();
    await host.seed("demo-app", SEED, "Initial commit\n\nCo-Authored-By: Somebody Else <else@example.invalid>\n");
    const agentId = await newAgent(coordinator, "agent-one");
    const started = await coordinator.startTask({ agentId, goal: "Add GET /users/:id", paths: ["src/routes/users/"] });
    if (!started.ok) {
      throw new Error(`claim refused: ${started.error.message}`);
    }
    const { id: taskId, forkName } = started.task;
    await (await host.open("demo-app")).fork(forkName);
    await coordinator.attachFork(taskId, (await (await host.open(forkName)).head("main"))!.oid);
    const fork = host.repo(forkName);

    await fork.commit("main", { "src/routes/users/get.ts": "old\n" }, "Add the route\n\nEntire-Checkpoint: a3b2c4d5e6f7\n");
    const mainHead = await host
      .repo("demo-app")
      .commit("main", { "src/db/users.ts": "export const users = [1];\n" }, "Change users\n\nCo-Authored-By: Another Agent <other@example.invalid>\n");
    await fork.pull(host.repo("demo-app"), "main", ["src/routes/users/get.ts"]);
    const headSha = await fork.commit("main", { "src/routes/users/get.ts": "new\n" }, "Use the new shape\n");

    const submission = await coordinator.submit({ agentId, taskId, summary: "Adapted.", headSha, baseSha: mainHead });
    if (!submission.ok) {
      throw new Error(`submit failed: ${submission.error.message}`);
    }
    const reviewer = new FakeReviewer();
    const merge = new FakeMergeEngine();
    const deps: PipelineDeps = { coordinator, host, decider: new FakeDecider(), reviewer, merge, now: () => Date.now() };
    await runReview(deps, new ImmediateSteps(), { repo: "demo-app", submissionId: submission.submissionId });
    return { reviewer, merge };
  }

  it("reviews and merges only the task's own changes, not what came in from main", async () => {
    const { reviewer, merge } = await caughtUp();

    expect(reviewer.calls[0]!.files.map((file) => file.path)).toEqual(["src/routes/users/get.ts"]);
    expect(merge.calls[0]!.changes.map((change) => change.path)).toEqual(["src/routes/users/get.ts"]);
  });

  it("copies the trailers of the task's own commits onto the merge, and none from the commits of main", async () => {
    const { merge } = await caughtUp();

    expect(merge.calls[0]!.message).toContain("Entire-Checkpoint: a3b2c4d5e6f7");
    expect(merge.calls[0]!.message).not.toContain("Co-Authored-By");
  });
});

describe("triage signals", () => {
  async function withTriage(override: Partial<Triage>) {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });
    s.decider.triageResult = { ...CALM_TRIAGE, ...override };
    return s;
  }

  it.each([
    ["a real chance of high risk", { risk: { score: 2.2, confidence: 0.3, high: 0.4 } }, "risk"],
    ["an interface change", { interface_change: 0.9 }, "interface_change"],
  ])("escalate an approved change with %s", async (_label, override, kind) => {
    const s = await withTriage(override);

    const result = await s.run();

    expect(result).toEqual({ outcome: "escalated" });
    const verdict = await s.latestVerdict();
    expect(verdict).toMatchObject({ decision: "escalate", body: { decision: "approve" } });
    expect((verdict!.body.reasons as { kind: string }[]).map((reason) => reason.kind)).toEqual([kind]);
    expect(s.merge.calls).toEqual([]);
  });

  it("tell the reviewer to check callers when an interface change is flagged", async () => {
    const s = await withTriage({ interface_change: 0.9 });

    await s.run();

    expect(s.reviewer.calls[0]!.checkCallers).toBe(true);
  });

  it("name the related live tasks when an interface change escalates", async () => {
    const s = await withTriage({ interface_change: 0.9 });
    const otherAgent = await newAgent(s.coordinator, "agent-two");
    const other = await s.coordinator.startTask({ agentId: otherAgent, goal: "Add GET /users/:id", paths: ["src/routes/"] });
    if (!other.ok) {
      throw new Error("expected the second claim to be granted");
    }
    await s.coordinator.recordRelated(s.taskId, [{ taskId: other.task.id, relation: "coupled", confidence: 0.8 }]);

    await s.run();

    expect((await s.latestVerdict())!.body.related).toMatchObject([
      { taskId: other.task.id, agent: "agent-two", goal: "Add GET /users/:id", relation: "coupled" },
    ]);
  });

  it("are recorded in shadow as disagreeing when the model alone would not have approved", async () => {
    const s = await withTriage({ leftovers: 0.5 });

    const result = await s.run();

    expect(result).toMatchObject({ outcome: "merged" });
    const context = await s.coordinator.getSubmission(s.submissionId);
    expect(context?.verdicts[0]?.body.shadow).toEqual({ would_auto_approve: false });
  });

  it("are skipped, and the review still completes, when the decision model fails", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });
    s.decider.triageResult = new Error("Workers AI returned 503");

    const result = await s.run();

    expect(result).toMatchObject({ outcome: "merged" });
    expect(s.reviewer.calls[0]).toMatchObject({ triage: null, checkCallers: false });
    const context = await s.coordinator.getSubmission(s.submissionId);
    expect(context?.verdicts[0]?.body).toMatchObject({ triage: null });
    expect(context?.verdicts[0]?.body.shadow).toBeUndefined();
    const events = await s.coordinator.listEvents();
    expect(events.find((event) => event.type === "decider_unavailable")).toMatchObject({
      body: { stage: "triage", reason: "Workers AI returned 503" },
    });
  });

  it("are not asked for when the decision model is switched off for the repository", async () => {
    const s = await setup({
      claim: ["src/db/users.ts"],
      work: usersWork,
      config: {
        decider: { ...DEFAULT_DECIDER_CONFIG, enabled: false },
      },
    });

    const result = await s.run();

    expect(result).toMatchObject({ outcome: "merged" });
    expect(s.decider.triageCalls).toEqual([]);
    expect(await s.eventTypes()).not.toContain("decider_unavailable");
  });

  it("are not asked for when no decision model is configured", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });
    s.deps.decider = null;

    const result = await s.run();

    expect(result).toMatchObject({ outcome: "merged" });
    expect(s.reviewer.calls[0]!.triage).toBeNull();
  });
});

describe("merging", () => {
  it("sends the work back to its agent when the merge finds its base stale", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });
    s.merge.result = { status: "stale", paths: [{ path: "src/db/users.ts", reason: "changed on main since the task started" }] };

    const result = await s.run();

    expect(result).toEqual({ outcome: "stale" });
    expect(await s.state()).toBe("active");
    expect(await s.latestVerdict()).toMatchObject({ decision: "reject", source: "merge" });
  });

  it("asks a person instead when a stale base is found on the last allowed attempt", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork, config: { maxCycles: 1 } });
    s.merge.result = { status: "stale", paths: [{ path: "src/db/users.ts", reason: "changed on main since the task started" }] };

    const result = await s.run();

    expect(result).toEqual({ outcome: "escalated" });
    expect(await s.state()).toBe("escalated");
    expect(await s.latestVerdict()).toMatchObject({ decision: "escalate", source: "merge", body: { reasons: [{ kind: "max_cycles" }] } });
  });

  it("waits for the merge lock while another task is merging", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });
    await s.coordinator.acquireMergeLock("t-other000");
    let waits = 0;
    s.steps.onSleep = async () => {
      waits++;
      if (waits === 2) {
        await s.coordinator.releaseMergeLock("t-other000");
      }
    };

    const result = await s.run();

    expect(result).toMatchObject({ outcome: "merged" });
    expect(s.steps.sleeps).toEqual([2000, 2000]);
    expect(s.merge.calls).toHaveLength(1);
  });

  it("releases the merge lock when the merge fails", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });
    s.merge.result = new Error("push to main was rejected (unpack): index-pack failed");

    await s.run();

    expect(await s.coordinator.acquireMergeLock("t-other000")).toBe(true);
  });
});

describe("failures", () => {
  it("escalates with the error when the merge fails, so the task is not left in review", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });
    s.merge.result = new Error("push to main was rejected (unpack): index-pack failed");

    const result = await s.run();

    expect(result).toEqual({ outcome: "escalated" });
    expect(await s.state()).toBe("escalated");
    expect(await s.latestVerdict()).toEqual({
      decision: "escalate",
      source: "system",
      body: { step: "merge", error: "push to main was rejected (unpack): index-pack failed" },
    });
  });

  it("escalates with the error when the reviewer fails", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });
    s.reviewer.result = new Error("the reviewer returned no valid verdict in 3 attempts");

    const result = await s.run();

    expect(result).toEqual({ outcome: "escalated" });
    expect(await s.latestVerdict()).toMatchObject({
      decision: "escalate",
      source: "system",
      body: { step: "review", error: "the reviewer returned no valid verdict in 3 attempts" },
    });
    expect(s.merge.calls).toEqual([]);
  });

  it("escalates when the merge landed but could not be recorded, rather than reporting success", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });
    const real = s.coordinator;
    s.deps.coordinator = {
      getSubmission: (id) => real.getSubmission(id),
      recordTriage: (id, triage, reason) => real.recordTriage(id, triage, reason),
      recordVerdict: (id, verdict) => real.recordVerdict(id, verdict),
      recordInterfaces: (id, report) => real.recordInterfaces(id, report),
      recordGate: (id, result) => real.recordGate(id, result),
      confirmContracts: (id) => real.confirmContracts(id),
      acquireMergeLock: (taskId) => real.acquireMergeLock(taskId),
      releaseMergeLock: (taskId) => real.releaseMergeLock(taskId),
      recordStale: (id, paths) => real.recordStale(id, paths),
      recordMerged: async () => ({
        ok: false,
        error: { code: "bad_state", message: "submission 1 is not approved and waiting to merge", retryable: false },
      }),
    };

    const result = await s.run();

    expect(result).toEqual({ outcome: "escalated" });
    expect(await s.latestVerdict()).toMatchObject({
      decision: "escalate",
      source: "system",
      body: { step: "merge", error: "submission 1 is not approved and waiting to merge" },
    });
  });

  it("does nothing for a submission that does not exist", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });

    const result = await runReview(s.deps, s.steps, { repo: "demo-app", submissionId: 999 });

    expect(result).toEqual({ outcome: "skipped", reason: "submission 999 does not exist" });
  });

  it("does nothing for a submission that is no longer in review", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });
    await s.coordinator.recordVerdict(s.submissionId, { decision: "reject", source: "reviewer", body: {} });

    const result = await s.run();

    expect(result).toMatchObject({ outcome: "skipped" });
    expect(s.reviewer.calls).toEqual([]);
  });
});

describe("a merge-only run after a person approves an escalation", () => {
  it("merges without reviewing again and records who approved", async () => {
    const s = await setup({ claim: ["package.json"], work: { "package.json": '{"name":"demo","version":"2"}\n' } });
    await s.run();
    expect(await s.state()).toBe("escalated");
    await s.coordinator.decideEscalation({ taskId: s.taskId, decision: "approve", note: "Version bump is fine" });

    const result = await s.run({ mergeOnly: true });

    expect(result).toEqual({ outcome: "merged", mergeSha: MERGE_SHA });
    expect(await s.state()).toBe("merged");
    expect(s.reviewer.calls).toHaveLength(1);
    expect(s.merge.calls).toHaveLength(1);
    expect(s.merge.calls[0]!.message).toContain("Dibs-Verdict: approve; reviewer=human; cycle=1");
    expect(JSON.parse(s.merge.calls[0]!.note!)).toMatchObject({
      approved_by: "human",
      human_note: "Version bump is fine",
      decision: "approve",
      summary: APPROVE.summary,
      model: "claude-opus-5-5",
    });
  });

  it("refuses to merge a submission nobody approved", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });

    const result = await s.run({ mergeOnly: true });

    expect(result).toMatchObject({ outcome: "skipped" });
    expect(s.merge.calls).toEqual([]);
  });
});

describe("the repository's checks", () => {
  const CHECKS = { ".dibs/checks.json": '{ "checks": [{ "name": "test", "run": "npm test" }] }\n' };

  async function gated(options: { seed?: Record<string, string>; work?: Work; claim?: string[]; index?: boolean; leaves?: string } = {}) {
    const s = await setup({
      claim: options.claim ?? ["src/db/users.ts"],
      work: options.work ?? usersWork,
      seed: { ...CHECKS, ...options.seed },
      ...(options.index ? { index: true } : {}),
      ...(options.leaves === undefined ? {} : { leaves: options.leaves }),
    });
    const gate = new FakeGate();
    s.deps.gate = gate;
    return { ...s, gate };
  }

  it("run on the change joined with main before the reviewer is asked, and the reviewer is told how they went", async () => {
    const s = await gated();

    const result = await s.run();

    expect(result).toEqual({ outcome: "merged", mergeSha: CANDIDATE_SHA });
    expect(s.gate.calls[0]).toEqual({
      repo: "demo-app",
      remote: "https://git.example.invalid/demo-app.git",
      ref: "refs/dibs/candidates/t",
      candidateSha: CANDIDATE_SHA,
      baseSha: MAIN_SHA,
      treeSha: TREE_SHA,
      config: { setup: null, checks: [{ name: "test", run: "npm test" }], timeoutSeconds: 600, internet: false },
    });
    expect(s.reviewer.calls[0]!.gate).toContain("- test, `npm test`: passed in 3 s");
    expect(s.steps.names.indexOf("gate")).toBeLessThan(s.steps.names.indexOf("review"));
  });

  it("send a change back with what failed, without asking the reviewer, when a check fails", async () => {
    const s = await gated();
    s.gate.results = [GATE_FAILED];

    const result = await s.run();

    expect(result).toEqual({ outcome: "rejected" });
    expect(s.reviewer.calls).toEqual([]);
    expect(await s.state()).toBe("active");
    expect(await s.latestVerdict()).toMatchObject({
      decision: "reject",
      source: "gate",
      body: { message: expect.stringContaining("not ok 3 - findUser says not_found"), gate: { outcome: "fail" } },
    });
  });

  it("land the very tree that was checked, under a commit that says so, when main has not moved", async () => {
    const s = await gated();

    await s.run();

    expect(s.gate.calls).toHaveLength(1);
    expect(s.merge.calls).toEqual([]);
    expect(s.merge.landCalls).toHaveLength(1);
    const landed = s.merge.candidateCalls.at(-1)!;
    expect(landed.message).toContain("Dibs-Gate: pass; test; 3s");
    expect(JSON.parse(landed.note!)).toMatchObject({ gate: { outcome: "pass", treeSha: TREE_SHA } });
    expect((await s.coordinator.getSubmission(s.submissionId))?.gate).toMatchObject({ outcome: "pass" });
  });

  it("run again on main as it is at landing when main moved during the review", async () => {
    const s = await gated();
    const moved = { status: "ready" as const, candidateSha: "d".repeat(40), baseSha: "b".repeat(40), treeSha: "8".repeat(40), ref: "refs/dibs/candidates/t", composed: [] };
    s.merge.candidates = [s.merge.candidates[0]!, moved];

    const result = await s.run();

    expect(s.gate.calls.map((call) => call.treeSha)).toEqual([TREE_SHA, "8".repeat(40)]);
    expect(result).toMatchObject({ outcome: "merged" });
  });

  it("send the change back when they fail on main as it is at landing", async () => {
    const s = await gated();
    const moved = { status: "ready" as const, candidateSha: "d".repeat(40), baseSha: "b".repeat(40), treeSha: "8".repeat(40), ref: "refs/dibs/candidates/t", composed: [] };
    s.merge.candidates = [s.merge.candidates[0]!, moved];
    s.gate.results = [GATE_PASSED, GATE_FAILED];

    const result = await s.run();

    expect(result).toEqual({ outcome: "rejected" });
    expect(s.merge.landCalls).toEqual([]);
    expect(await s.latestVerdict()).toMatchObject({ decision: "reject", source: "gate" });
    expect(await s.coordinator.acquireMergeLock("t-other000")).toBe(true);
  });

  it("are skipped, and the review goes on, when they cannot be run", async () => {
    const s = await gated();
    s.gate.results = [new Error("the container did not start")];

    const result = await s.run();

    expect(result).toEqual({ outcome: "merged", mergeSha: MERGE_SHA });
    expect(s.merge.calls[0]!.message).toContain("Dibs-Gate: error; the container did not start");
    expect(await s.eventTypes()).toContain("gate");
  });

  it("are skipped with the reason when the file that declares them is not valid", async () => {
    const s = await gated({ seed: { ".dibs/checks.json": "{ not json" } });

    await s.run();

    expect(s.gate.calls).toEqual([]);
    expect((await s.coordinator.getSubmission(s.submissionId))?.gate).toMatchObject({
      outcome: "error",
      error: ".dibs/checks.json: the file is not JSON",
    });
  });

  it("are not run for a repository that declares none", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork });
    const gate = new FakeGate();
    s.deps.gate = gate;

    expect(await s.run()).toEqual({ outcome: "merged", mergeSha: MERGE_SHA });
    expect(gate.calls).toEqual([]);
  });

  it("are not run where no gate is configured", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: usersWork, seed: CHECKS });

    expect(await s.run()).toEqual({ outcome: "merged", mergeSha: MERGE_SHA });
  });

  it("answer for the files a change leaves as they were, when they pass, so that no person is needed", async () => {
    const s = await gated({
      claim: ["src/db/users.ts"],
      work: { "src/db/users.ts": "export function findUser(id, options) { return null; }\n" },
      seed: { "src/routes/get.ts": 'import { findUser } from "../db/users.ts";\nexport const getRoute = findUser;\n' },
      index: true,
      leaves: "options is optional, so the route keeps working",
    });

    const result = await s.run();

    expect(result).toMatchObject({ outcome: "merged" });
    expect(s.reviewer.calls[0]!.coordination).toContain('The agent says they need no change: "options is optional, so the route keeps working"');
  });
});

describe("a file the task holds to add to", () => {
  it("is handed to the merge as one to join with what other tasks added to it", async () => {
    const coordinator = await newCoordinator();
    const host = new MemoryRepoHost();
    await host.seed("demo-app", SEED);
    const agentId = await newAgent(coordinator, "agent-one");
    const started = await coordinator.startTask({
      agentId,
      goal: "Add a route",
      scope: [
        { target: "src/routes/get.ts", relation: "change" },
        { target: "src/routes/index.ts", relation: "add" },
      ],
    });
    if (!started.ok) {
      throw new Error(started.error.message);
    }
    await (await host.open("demo-app")).fork(started.task.forkName);
    await coordinator.attachFork(started.task.id, (await (await host.open(started.task.forkName)).head("main"))!.oid);
    const headSha = await host
      .repo(started.task.forkName)
      .commit("main", { "src/routes/get.ts": "export const get = 1;\n", "src/routes/index.ts": "export const routes = [get];\n" }, "work\n");
    const submission = await coordinator.submit({ agentId, taskId: started.task.id, summary: "Adds a route.", headSha });
    if (!submission.ok) {
      throw new Error(submission.error.message);
    }
    const merge = new FakeMergeEngine();
    const deps: PipelineDeps = { coordinator, host, decider: new FakeDecider(), reviewer: new FakeReviewer(), merge, now: () => Date.now() };

    await runReview(deps, new ImmediateSteps(), { repo: "demo-app", submissionId: submission.submissionId });

    expect(merge.calls[0]!.composable).toEqual(["src/routes/index.ts"]);
  });
});

describe("contracts", () => {
  const NEW_USERS = "export function findUser(id, options) { return null; }\n";
  // A file of the repository that uses findUser.
  const CALLER = { "src/routes/get.ts": 'import { findUser } from "../db/users.ts";\nexport const getRoute = findUser;\n' };
  const NEW_SHA = "9".repeat(40);

  // What landing another task's change to findUser does to the index.
  async function findUserMoves(coordinator: CoordinatorStub): Promise<void> {
    const moved = await indexFile("src/db/users.ts", NEW_USERS, () => false);
    await coordinator.indexFiles({ files: [moved!], removed: [], sha: NEW_SHA });
  }

  // A task that adds a route which uses findUser as it is in its fork.
  const relier = (config: Partial<RepoConfig> = {}) =>
    setup({
      claim: ["src/routes/list.ts"],
      work: { "src/routes/list.ts": 'import { findUser } from "../db/users.ts";\nexport const listRoute = findUser;\n' },
      goal: "Add a route that lists users",
      index: true,
      config,
    });

  it("merges a change that alters an interface and updates every file that uses it, whatever the decision model guesses", async () => {
    const s = await setup({
      claim: ["src/db/users.ts", "src/routes/get.ts"],
      work: { "src/db/users.ts": NEW_USERS, "src/routes/get.ts": 'import { findUser } from "../db/users.ts";\nexport const getRoute = (id) => findUser(id, {});\n' },
      seed: CALLER,
      index: true,
    });
    s.decider.triageResult = { ...CALM_TRIAGE, interface_change: 0.95 };

    const result = await s.run();

    expect(result).toEqual({ outcome: "merged", mergeSha: MERGE_SHA });
    expect(s.reviewer.calls[0]).toMatchObject({
      checkCallers: true,
      coordination: expect.stringContaining("Every file on the main branch that uses them is part of this change."),
    });
  });

  it("sends back a change that alters an interface and leaves a file that uses it, without calling any model", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: { "src/db/users.ts": NEW_USERS }, seed: CALLER, index: true });

    const result = await s.run();

    expect(result).toEqual({ outcome: "rejected" });
    expect(await s.latestVerdict()).toMatchObject({
      decision: "reject",
      source: "check",
      body: {
        check: "contract",
        message: expect.stringContaining("- src/db/users.ts#findUser is used by src/routes/get.ts"),
        details: { contract: { unupdated: [{ target: "src/db/users.ts#findUser", files: [{ path: "src/routes/get.ts", heldBy: null }] }] } },
      },
    });
    expect(s.reviewer.calls).toEqual([]);
    expect(s.decider.triageCalls).toEqual([]);
    expect(await s.state()).toBe("active");
    expect(s.steps.names).toEqual(["load", "changes", "interfaces", "check"]);
  });

  it("asks a person instead of sending it back before review on the last allowed attempt", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: { "src/db/users.ts": NEW_USERS }, seed: CALLER, index: true, config: { maxCycles: 1 } });

    const result = await s.run();

    expect(result).toEqual({ outcome: "escalated" });
    expect(await s.latestVerdict()).toMatchObject({
      decision: "escalate",
      source: "check",
      body: { check: "contract", message: expect.stringContaining("src/db/users.ts#findUser"), reasons: [{ kind: "max_cycles" }] },
    });
    expect(s.reviewer.calls).toEqual([]);
    expect(await s.state()).toBe("escalated");
  });

  it("asks a person when the agent says that the files it leaves need no change", async () => {
    const s = await setup({
      claim: ["src/db/users.ts"],
      work: { "src/db/users.ts": NEW_USERS },
      seed: CALLER,
      index: true,
      leaves: "the route passes the result on",
    });

    const result = await s.run();

    expect(result).toEqual({ outcome: "escalated" });
    const verdict = await s.latestVerdict();
    expect((verdict!.body.reasons as { kind: string; paths: string[] }[]).map((reason) => [reason.kind, reason.paths])).toEqual([
      ["interface_change", ["src/routes/get.ts"]],
    ]);
    expect(s.reviewer.calls[0]!.coordination).toContain('The agent says they need no change: "the route passes the result on".');
  });

  it("sends back a change that relies on an interface which has moved since its fork branched off", async () => {
    const s = await relier();
    await findUserMoves(s.coordinator);

    const result = await s.run();

    expect(result).toEqual({ outcome: "rejected" });
    expect(await s.latestVerdict()).toMatchObject({
      source: "check",
      body: {
        check: "contract",
        message: expect.stringContaining("- src/db/users.ts#findUser, changed in 9999999. It is now: export function findUser(id, options)"),
      },
    });
    expect(s.reviewer.calls).toEqual([]);
  });

  it("sends a change back at the last moment when what it relies on moved while it was being reviewed", async () => {
    const s = await relier();
    s.reviewer.during = () => findUserMoves(s.coordinator);

    const result = await s.run();

    expect(result).toEqual({ outcome: "contract" });
    expect(s.merge.calls).toEqual([]);
    expect(await s.state()).toBe("active");
    expect(await s.latestVerdict()).toMatchObject({ decision: "reject", source: "merge", body: { contract: { moved: [{ target: "src/db/users.ts#findUser" }] } } });
    expect(await s.coordinator.acquireMergeLock("t-other000")).toBe(true);
  });

  it("asks a person instead at the last moment when it is the last allowed attempt", async () => {
    const s = await relier({ maxCycles: 1 });
    s.reviewer.during = () => findUserMoves(s.coordinator);

    const result = await s.run();

    expect(result).toEqual({ outcome: "escalated" });
    expect(s.merge.calls).toEqual([]);
    expect(await s.state()).toBe("escalated");
    expect(await s.latestVerdict()).toMatchObject({ decision: "escalate", source: "merge", body: { reasons: [{ kind: "max_cycles" }] } });
    expect(await s.coordinator.acquireMergeLock("t-other000")).toBe(true);
  });

  it("lets the next attempt through once the agent has caught up, and tells its reviewer what the first was sent back for", async () => {
    const s = await relier();
    s.reviewer.during = () => findUserMoves(s.coordinator);
    await s.run();
    s.reviewer.during = undefined;

    // The agent catches up: the new findUser has landed on the main branch, it merges that into its fork, and fits its route to it.
    const mainHead = await s.host.repo("demo-app").commit("main", { "src/db/users.ts": NEW_USERS }, "Change findUser\n");
    const fork = s.host.repo(s.forkName);
    await fork.pull(s.host.repo("demo-app"), "main", ["src/routes/list.ts"]);
    const headSha = await fork.commit(
      "main",
      { "src/routes/list.ts": 'import { findUser } from "../db/users.ts";\nexport const listRoute = (id) => findUser(id, {});\n' },
      "Use the new findUser\n",
    );
    const next = await s.coordinator.submit({ agentId: s.agentId, taskId: s.taskId, summary: "Adapted.", headSha, baseSha: mainHead });
    if (!next.ok) {
      throw new Error(`submit failed: ${next.error.message}`);
    }

    const result = await runReview(s.deps, new ImmediateSteps(), { repo: "demo-app", submissionId: next.submissionId });

    expect(result).toEqual({ outcome: "merged", mergeSha: MERGE_SHA });
    expect(s.reviewer.calls.at(-1)!.previous).toMatchObject({
      by: "merge",
      feedback: expect.stringContaining("Call sync_with_main, change your code to fit"),
    });
  });

  it("tells the index what the change did once it has landed", async () => {
    const s = await setup({
      claim: ["src/db/users.ts", "src/extra.ts"],
      work: { "src/db/users.ts": NEW_USERS, "src/extra.ts": "export const extra = 1;\n" },
      index: true,
    });
    const before = (await s.coordinator.snapshot())!.index;

    await s.run();

    expect((await s.coordinator.snapshot())!.index).toEqual({ ...before, files: before.files + 1, interfaces: before.interfaces + 1 });
    const stored = await runInDurableObject(s.coordinator, (_instance, state) =>
      state.storage.sql.exec("SELECT signature, since_sha FROM interfaces WHERE path = 'src/db/users.ts' AND name = 'findUser'").one(),
    );
    expect(stored).toEqual({ signature: "export function findUser(id, options)", since_sha: MERGE_SHA });
  });

  it("keeps what it found about interfaces with the submission", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: { "src/db/users.ts": NEW_USERS }, index: true });

    await s.run();

    expect((await s.coordinator.getSubmission(s.submissionId))?.interfaces).toEqual({
      changedPaths: ["src/db/users.ts"],
      changed: [
        {
          path: "src/db/users.ts",
          name: "findUser",
          kind: "function",
          change: "changed",
          before: "export function findUser(id)",
          after: "export function findUser(id, options)",
        },
      ],
      relied: [],
    });
  });

  it("tells the reviewer about another task that uses what the change alters", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: { "src/db/users.ts": NEW_USERS }, index: true });
    const other = await s.coordinator.startTask({
      agentId: await newAgent(s.coordinator, "agent-two"),
      goal: "Add GET /users/:id",
      scope: [
        { target: "src/routes/users.ts", relation: "change" },
        { target: "src/db/users.ts#findUser", relation: "rely" },
      ],
    });
    expect(other.ok).toBe(true);

    await s.run();

    expect(s.reviewer.calls[0]!.coordination).toContain(
      '- agent-two ("Add GET /users/:id", active) uses src/db/users.ts#findUser, which this change alters.',
    );
  });

  it("says in the commit message and in the note what the change did to interfaces", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: { "src/db/users.ts": NEW_USERS }, index: true });

    await s.run();

    const request = s.merge.calls[0]!;
    expect(request.message.split("\n").filter((line) => /^Dibs-(Claim|Scope|Interfaces)/.test(line))).toEqual([
      "Dibs-Claim: src/db/users.ts",
      "Dibs-Scope: change=src/db/users.ts, src/db/users.ts#findUser (detected)",
      "Dibs-Interfaces: src/db/users.ts#findUser (changed)",
    ]);
    expect(JSON.parse(request.note!)).toMatchObject({
      scope: [
        { target: "src/db/users.ts", relation: "change", origin: "declared" },
        { target: "src/db/users.ts#findUser", relation: "change", origin: "detected" },
      ],
      interfaces: [
        { target: "src/db/users.ts#findUser", change: "changed", before: "export function findUser(id)", after: "export function findUser(id, options)" },
      ],
    });
  });

  it("checks again before a change that a person approved is merged", async () => {
    const s = await relier();
    s.reviewer.result = { decision: "escalate", summary: "A person should look at this.", issues: [] };
    await s.run();
    await s.coordinator.decideEscalation({ taskId: s.taskId, decision: "approve" });
    await findUserMoves(s.coordinator);

    const result = await runReview(s.deps, new ImmediateSteps(), { repo: "demo-app", submissionId: s.submissionId, mergeOnly: true });

    expect(result).toEqual({ outcome: "contract" });
    expect(s.merge.calls).toEqual([]);
  });

  it("has nothing to check, and goes by the decision model, for a repository it has not read", async () => {
    const s = await setup({ claim: ["src/db/users.ts"], work: { "src/db/users.ts": NEW_USERS }, seed: CALLER });
    s.decider.triageResult = { ...CALM_TRIAGE, interface_change: 0.95 };

    const result = await s.run();

    expect(result).toEqual({ outcome: "escalated" });
    expect(s.reviewer.calls[0]!.coordination).toContain("dibs could not work out which files use them.");
  });
});
