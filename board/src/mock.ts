// A canned board for working on the interface without a backend: open the page with ?mock.

import type { BoardTask, DibsEvent, Snapshot, Triage } from "../../src/types";
import type { Api, Decision, TaskDiff } from "./api";

const MINUTE = 60_000;

const triage: Triage = {
  model: "clef",
  goal_fit: { score: 2.8, confidence: 0.82 },
  risk: { score: 1.6, confidence: 0.32, high: 0.04 },
  unrelated_changes: 0.05,
  interface_change: 0.92,
  leftovers: 0.03,
};

const DIFF: TaskDiff = {
  bytes: 512,
  unreviewable: [],
  truncated: false,
  files: [
    {
      path: "src/db/users.ts",
      status: "modified",
      text: [
        "diff --git a/src/db/users.ts b/src/db/users.ts",
        "--- a/src/db/users.ts",
        "+++ b/src/db/users.ts",
        "@@ -1,7 +1,11 @@",
        " import { db } from './client';",
        " ",
        "-export function findUser(id: string): User | null {",
        "-  return db.users.get(id) ?? null;",
        "+export type FindUserResult = { ok: true; user: User } | { ok: false; reason: 'not_found' };",
        "+",
        "+export function findUser(id: string): FindUserResult {",
        "+  const user = db.users.get(id);",
        "+  return user ? { ok: true, user } : { ok: false, reason: 'not_found' };",
        " }",
        "",
      ].join("\n"),
    },
  ],
};

function build(now: number, decided: Map<string, Decision>): Snapshot {
  const base = {
    cycle: 1,
    baseSha: "b".repeat(40),
    mergeSha: null,
    verdict: null,
    related: [],
    submission: null,
    createdAt: now - 20 * MINUTE,
    updatedAt: now - 2 * MINUTE,
  };
  const task = (id: string, agent: string, goal: string, paths: string[], rest: Partial<BoardTask>): BoardTask => ({
    ...base,
    id,
    agentId: `a-${agent}`,
    agent,
    goal,
    paths,
    scope: paths.map((target) => ({ target, relation: "change", origin: "declared" })),
    collisions: [],
    dependents: [],
    forkName: `demo-app--${id}`,
    state: "active",
    claimExpiresAt: null,
    ...rest,
  });

  const fiveDecision = decided.get("t-5");
  const tasks: BoardTask[] = [
    task("t-1", "agent-one", "Add GET /users/:id", ["src/routes/users/get.ts"], {
      claimExpiresAt: now + 112 * MINUTE,
      scope: [
        { target: "src/routes/users/get.ts", relation: "change", origin: "declared" },
        { target: "src/routes/users/index.ts", relation: "add", origin: "declared" },
        { target: "src/db/users.ts#findUser", relation: "rely", origin: "declared" },
      ],
      collisions: [
        {
          id: "c-1",
          kind: "contract",
          state: "open",
          role: "relier",
          with: { taskId: "t-5", agent: "agent-five", goal: "Change findUser to return a result object", state: "escalated", mergeSha: null },
          targets: ["src/db/users.ts#findUser"],
          order: { first: "agent-five", why: "it has submitted, and the other is still being worked on" },
          brief: "agent-five is changing src/db/users.ts#findUser, which your work uses.",
        },
      ],
      related: [
        {
          taskId: "t-5",
          agent: "agent-five",
          goal: "Change findUser to return a result object",
          state: "escalated",
          paths: ["src/db/users.ts"],
          relation: "coupled",
          confidence: 0.83,
        },
      ],
    }),
    task("t-2", "agent-two", "Add rate limiting to the public API", ["src/middleware/"], {
      state: "in_review",
      scope: [
        { target: "src/middleware/", relation: "change", origin: "declared" },
        { target: "src/routes/users/index.ts", relation: "add", origin: "declared" },
      ],
    }),
    task("t-3", "agent-three", "Fix the off-by-one in pagination", ["src/services/", "src/utils/numbers.ts"], {
      cycle: 2,
      claimExpiresAt: now + 47 * MINUTE,
    }),
    task("t-5", "agent-five", "Change findUser to return a result object", ["src/db/users.ts"], {
      scope: [
        { target: "src/db/users.ts", relation: "add", origin: "inferred" },
        { target: "src/db/users.ts#findUser", relation: "change", origin: "declared" },
      ],
      state: fiveDecision === "approve" ? "merged" : fiveDecision === "send_back" ? "active" : fiveDecision === "close" ? "closed" : "escalated",
      mergeSha: fiveDecision === "approve" ? "9c41d07a".padEnd(40, "0") : null,
      claimExpiresAt: fiveDecision === "send_back" ? now + 120 * MINUTE : null,
      cycle: fiveDecision === "send_back" ? 2 : 1,
      submission: { id: 4, taskId: "t-5", cycle: 1, headSha: "5".repeat(40), summary: "findUser returns a result object", triage },
      verdict: {
        submissionId: 4,
        cycle: 1,
        decision: "escalate",
        source: "reviewer",
        createdAt: now - MINUTE,
        body: {
          decision: "approve",
          summary:
            "The new return type is implemented cleanly and both branches are covered. Callers outside this diff still expect a user or null.",
          issues: [
            {
              severity: "major",
              path: "src/db/users.ts",
              line: 5,
              description: "findUser's return type changed; src/routes/users/ is being written against the old one.",
            },
          ],
          model: "claude-opus-5-5",
          triage,
          reasons: [{ kind: "interface_change", detail: "interface change probability 0.92 is at or above 0.6" }],
        },
      },
    }),
    task("t-4", "agent-four", "Validate input on POST /users", ["src/validation/"], {
      state: "merged",
      cycle: 2,
      mergeSha: "1a2b3c4d".padEnd(40, "0"),
      updatedAt: now - 3 * MINUTE,
    }),
    task("t-0", "agent-two", "Add a health endpoint", ["src/routes/health.ts"], {
      state: "merged",
      mergeSha: "77e0aa12".padEnd(40, "0"),
      updatedAt: now - 14 * MINUTE,
    }),
  ];

  let id = 0;
  const event = (ago: number, type: string, taskId: string | null, body: DibsEvent["body"]): DibsEvent => ({
    id: ++id,
    type,
    taskId,
    agentId: null,
    body,
    createdAt: now - ago,
  });
  const events: DibsEvent[] = [
    event(14 * MINUTE, "merged", "t-0", { agent: "agent-two", goal: "Add a health endpoint", mergeSha: "77e0aa12".padEnd(40, "0") }),
    event(9 * MINUTE, "task_started", "t-1", { agent: "agent-one", goal: "Add GET /users/:id", paths: ["src/routes/users/"] }),
    event(8 * MINUTE, "task_started", "t-5", { agent: "agent-five", goal: "Change findUser to return a result object", paths: ["src/db/users.ts"] }),
    event(8 * MINUTE, "related_work", "t-5", {
      agent: "agent-five",
      related: [{ taskId: "t-1", agent: "agent-one", goal: "Add GET /users/:id", relation: "coupled", confidence: 0.83 }],
    }),
    event(6 * MINUTE, "check_failed", "t-3", {
      agent: "agent-three",
      verdict: { check: "coverage", message: "1 changed path is outside the task's claim: src/utils/numbers.ts." },
    }),
    event(5 * MINUTE, "claim_expanded", "t-3", { agent: "agent-three", added: ["src/utils/numbers.ts"] }),
    event(4 * MINUTE, "verdict", "t-4", {
      agent: "agent-four",
      decision: "reject",
      verdict: { summary: "Empty names pass validation." },
    }),
    event(3 * MINUTE, "merged", "t-4", { agent: "agent-four", goal: "Validate input on POST /users", mergeSha: "1a2b3c4d".padEnd(40, "0") }),
    event(2 * MINUTE, "submitted", "t-5", { agent: "agent-five", cycle: 1, summary: "findUser returns a result object" }),
    event(90_000, "triage", "t-5", { submissionId: 4, triage }),
    event(MINUTE, "escalated", "t-5", {
      agent: "agent-five",
      verdict: { reasons: [{ kind: "interface_change", detail: "interface change probability 0.92 is at or above 0.6" }] },
    }),
    event(4000, "claim_conflict", null, {
      agent: "agent-two",
      goal: "Add rate limiting",
      paths: ["src/routes/users/limits.ts"],
      blockedBy: [{ taskId: "t-1", agent: "agent-one", paths: ["src/routes/users/"] }],
    }),
  ];

  return {
    config: {
      repoName: "demo-app",
      defaultBranch: "main",
      protectedPaths: ["package.json"],
      claimTtlMinutes: 120,
      maxCycles: 3,
      decider: { enabled: true, relatedMinConfidence: 0.5, riskHighMin: 0.3, interfaceChangeMin: 0.6 },
    },
    agents: ["agent-one", "agent-two", "agent-three", "agent-four", "agent-five"].map((name) => ({ id: `a-${name}`, name })),
    tasks,
    events,
    shadow: { reviewed: 5, agreed: 4 },
    waiting: [
      {
        requestId: "w-1",
        agent: "agent-four",
        goal: "Add GET /users/:id/orders",
        taskId: null,
        scope: [{ target: "src/routes/users/get.ts", relation: "change" }],
        arrivedAt: now - MINUTE,
        position: 1,
        blockedBy: [{ taskId: "t-1", agent: "agent-one" }],
      },
    ],
    index: { files: 14, interfaces: 21, references: 18 },
  };
}

export function mockApi(): Api {
  const opened = Date.now();
  const decided = new Map<string, Decision>();
  let notify: (() => void) | undefined;
  return {
    repos: async () => ["demo-app"],
    // The clock is held at the moment the page opened, so the refused claim stays on screen.
    snapshot: async () => build(opened, decided),
    diff: async () => DIFF,
    decide: async (_repo, taskId, decision) => {
      decided.set(taskId, decision);
      notify?.();
    },
    listen: (_repo, onEvent, onStatus) => {
      notify = onEvent;
      onStatus(true);
      return () => {
        notify = undefined;
      };
    },
  };
}
