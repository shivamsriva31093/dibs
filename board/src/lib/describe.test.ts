import { describe, expect, it } from "vitest";
import type { DibsEvent } from "../../../src/types";
import { describeEvent, escalationReasons, groupRelated, lookedUp, refusalsFrom } from "./describe";
import { shortSha, timeLeft } from "./format";

function event(type: string, body: DibsEvent["body"], overrides: Partial<DibsEvent> = {}): DibsEvent {
  return { id: 1, type, taskId: "t-1", agentId: "a-1", body, createdAt: 1000, ...overrides };
}

describe("describeEvent", () => {
  it.each([
    [
      event("task_started", { agent: "agent-one", goal: "Add GET /users/:id", paths: ["src/routes/users/"], claimExpiresAt: 9 }),
      { tone: "plain", text: "agent-one claimed src/routes/users/", detail: "Add GET /users/:id" },
    ],
    [
      event("claim_conflict", {
        agent: "agent-two",
        goal: "Add rate limiting",
        paths: ["src/routes/users/limits.ts"],
        blockedBy: [{ taskId: "t-1", agent: "agent-one", paths: ["src/routes/users/"] }],
      }),
      {
        tone: "warn",
        text: "agent-two was refused src/routes/users/limits.ts",
        detail: "agent-one holds src/routes/users/",
      },
    ],
    [
      event("related_work", {
        agent: "agent-five",
        related: [{ taskId: "t-1", agent: "agent-one", goal: "Add GET /users/:id", relation: "coupled", confidence: 0.83 }],
      }),
      {
        tone: "warn",
        text: "agent-five was warned about connected work",
        detail: "coupled with agent-one",
      },
    ],
    [
      event("related_work", {
        agent: "agent-five",
        related: [
          { taskId: "t-1", agent: "agent-one", goal: "Add GET /users/:id", relation: "coupled", confidence: 0.83 },
          { taskId: "t-2", agent: "agent-two", goal: "Return a result from findUser", relation: "duplicate", confidence: 0.7 },
          { taskId: "t-3", agent: "agent-three", goal: "List users", relation: "coupled", confidence: 0.9 },
          { taskId: "t-4", agent: "agent-four", goal: "Validate users", relation: "coupled", confidence: 0.9 },
        ],
      }),
      {
        tone: "warn",
        text: "agent-five was warned about connected work",
        detail: "coupled with agent-one, agent-three and agent-four; may duplicate agent-two",
      },
    ],
    [
      event("claim_expanded", { agent: "agent-three", added: ["src/utils/date.ts"], paths: ["src/services/", "src/utils/date.ts"], claimExpiresAt: 9 }),
      { tone: "plain", text: "agent-three added src/utils/date.ts to its scope" },
    ],
    [
      event("submitted", { agent: "agent-one", submissionId: 1, cycle: 1, headSha: "1".repeat(40), summary: "Added the route" }),
      { tone: "plain", text: "agent-one submitted its work", detail: "Added the route" },
    ],
    [
      event("submitted", { agent: "agent-four", submissionId: 3, cycle: 2, headSha: "1".repeat(40), summary: "" }),
      { tone: "plain", text: "agent-four submitted its work again (attempt 2)" },
    ],
    [
      event("check_failed", {
        agent: "agent-three",
        submissionId: 2,
        cycle: 1,
        decision: "reject",
        source: "check",
        verdict: { check: "coverage", message: "1 changed path is outside the task's claim: src/utils/date.ts." },
      }),
      {
        tone: "warn",
        text: "agent-three's work was sent back by a check",
        detail: "1 changed path is outside the task's claim: src/utils/date.ts.",
      },
    ],
    [
      event("triage", {
        submissionId: 4,
        triage: {
          model: "clef",
          goal_fit: { score: 2.8, confidence: 0.8 },
          risk: { score: 1.6, confidence: 0.7, high: 0.04 },
          unrelated_changes: 0.05,
          interface_change: 0.92,
          leftovers: 0.03,
        },
      }),
      { tone: "plain", text: "Clef scored the change", detail: "risk 1.6 of 3, goal fit 2.8 of 3, interface change 92%" },
    ],
    [
      event("verdict", { agent: "agent-one", submissionId: 1, cycle: 1, decision: "approve", source: "reviewer", verdict: { summary: "Does what it says." } }),
      { tone: "good", text: "The reviewer approved agent-one's work", detail: "Does what it says." },
    ],
    [
      event("verdict", { agent: "agent-four", submissionId: 3, cycle: 1, decision: "reject", source: "reviewer", verdict: { summary: "Empty names pass validation." } }),
      { tone: "warn", text: "The reviewer sent agent-four's work back", detail: "Empty names pass validation." },
    ],
    [
      event("escalated", {
        agent: "agent-five",
        submissionId: 4,
        cycle: 1,
        decision: "escalate",
        source: "reviewer",
        verdict: { summary: "Fine", reasons: [{ kind: "interface_change", detail: "interface change probability 0.92 is at or above 0.6" }] },
      }),
      {
        tone: "human",
        text: "agent-five's work is waiting for you",
        detail: "interface change probability 0.92 is at or above 0.6",
      },
    ],
    [
      event("escalated", {
        agent: "agent-two",
        submissionId: 5,
        cycle: 1,
        decision: "escalate",
        source: "system",
        verdict: { step: "review", error: "401 invalid x-api-key" },
      }),
      {
        tone: "human",
        text: "agent-two's work is waiting for you",
        detail: "the review stopped at the review step: 401 invalid x-api-key",
      },
    ],
    [
      event("merged", { agent: "agent-one", goal: "Add GET /users/:id", submissionId: 1, mergeSha: "1a2b3c4d5e6f".padEnd(40, "0"), noteWritten: true }),
      { tone: "good", text: "agent-one's work landed on main as 1a2b3c4", detail: "Add GET /users/:id" },
    ],
    [
      event("human_decision", { agent: "agent-five", submissionId: 4, decision: "send_back", note: "Keep the old signature" }),
      { tone: "human", text: "You sent agent-five's work back", detail: "Keep the old signature" },
    ],
    [
      event("human_decision", { agent: "agent-five", submissionId: 4, decision: "approve", note: "" }),
      { tone: "human", text: "You approved agent-five's work" },
    ],
    [event("expired", {}), { tone: "warn", text: "A claim expired and its paths are free again" }],
    [event("abandoned", { reason: "abandoned by its agent" }), { tone: "plain", text: "A task was abandoned", detail: "abandoned by its agent" }],
    [
      event("stale", { agent: "agent-two", submissionId: 9, paths: [{ path: "src/a.ts", reason: "changed on main since the task started" }] }),
      { tone: "warn", text: "agent-two's work could not land: main changed under it", detail: "src/a.ts; sent back to catch up with main" },
    ],
    [
      event("catching_up", { agent: "agent-one", mainHead: "1a2b3c4d5e6f".padEnd(40, "0") }),
      { tone: "plain", text: "agent-one is catching up with main", detail: "merging main at 1a2b3c4 into its fork" },
    ],
    [
      event("decider_unavailable", { stage: "triage", reason: "Workers AI returned 503" }),
      { tone: "plain", text: "Clef was unavailable for the triage", detail: "Workers AI returned 503" },
    ],
    [
      event("waiting", {
        agent: "agent-two",
        goal: "Add rate limiting",
        requestId: "w-1",
        paths: ["src/routes/users/index.ts"],
        blockedBy: [{ taskId: "t-1", agent: "agent-one", paths: ["src/routes/users/"] }],
      }),
      { tone: "warn", text: "agent-two is waiting in line for src/routes/users/index.ts", detail: "agent-one holds src/routes/users/" },
    ],
    [event("left_line", { requestId: "w-1", reason: "its agent stopped asking" }), { tone: "plain", text: "A request left the line", detail: "its agent stopped asking" }],
    [
      event("collision", {
        id: "c-1",
        kind: "contract",
        state: "open",
        target: "src/db/users.ts#findUser",
        provider: { taskId: "t-5", agent: "agent-five" },
        relier: { taskId: "t-1", agent: "agent-one" },
      }),
      { tone: "warn", text: "agent-five is changing src/db/users.ts#findUser, which agent-one relies on", detail: "Both were told." },
    ],
    [
      event("collision", {
        id: "c-1",
        kind: "contract",
        state: "possible",
        target: "src/db/users.ts#listUsers",
        provider: { taskId: "t-5", agent: "agent-five" },
        relier: { taskId: "t-1", agent: "agent-one" },
      }),
      { tone: "plain", text: "agent-one relies on src/db/users.ts#listUsers, in code agent-five holds" },
    ],
    [
      event("collision", {
        id: "c-2",
        kind: "duplicate",
        state: "open",
        target: "",
        provider: { taskId: "t-1", agent: "agent-one" },
        relier: { taskId: "t-2", agent: "agent-two" },
      }),
      { tone: "warn", text: "agent-two may be doing the same work as agent-one", detail: "It has to say that its work is different before it can submit." },
    ],
    [
      event("collision_resolved", { id: "c-1", kind: "contract", target: "src/db/users.ts#findUser", how: "adapted" }),
      { tone: "good", text: "The collision at src/db/users.ts#findUser is over", detail: "adapted" },
    ],
    [
      event("collision_resolved", { id: "c-2", kind: "duplicate", target: "", how: "said to be different" }),
      { tone: "plain", text: "Two tasks are no longer taken for the same work", detail: "said to be different" },
    ],
    [
      event("contract", {
        agent: "agent-one",
        submissionId: 4,
        message: "Code your change relies on is not what it was when your fork branched off the main branch:\n- src/db/users.ts#findUser, changed by agent-five in abcdef0.",
      }),
      {
        tone: "warn",
        text: "agent-one's work was sent back as it was about to land: it would have broken main",
        detail: "Code your change relies on is not what it was when your fork branched off the main branch: - src/db/users.ts#findUser, changed by agent-five in abcdef0.",
      },
    ],
    [
      event("check_failed", {
        agent: "agent-five",
        verdict: { check: "contract", message: "Your change alters interfaces that files on the main branch use, and it does not change those files:\n- src/db/users.ts#findUser is used by src/routes/users/get.ts\nCall sync_with_main." },
      }),
      {
        tone: "warn",
        text: "agent-five's work was sent back before review: it would have broken main",
        detail: "Your change alters interfaces that files on the main branch use, and it does not change those files: - src/db/users.ts#findUser is used by src/routes/users/get.ts",
      },
    ],
    [
      event("gate", { agent: "agent-one", submissionId: 3, outcome: "pass", summary: "pass; test; 4s" }),
      { tone: "good", text: "The checks passed on agent-one's change", detail: "test, in 4s" },
    ],
    [
      event("gate", { agent: "agent-two", submissionId: 4, outcome: "fail", summary: "fail; test failed; 3s", failed: "test" }),
      { tone: "warn", text: "The checks failed on agent-two's change", detail: "test failed" },
    ],
    [
      event("gate", { agent: "agent-two", submissionId: 4, outcome: "error", summary: "error; the container did not start" }),
      { tone: "plain", text: "The checks could not be run on agent-two's change", detail: "the container did not start" },
    ],
    [event("something_new", { x: 1 }), { tone: "plain", text: "something_new" }],
  ])("describes %o", (input, want) => {
    expect(describeEvent(input)).toEqual(want);
  });
});

describe("escalationReasons", () => {
  // The card shows the reviewer's summary in its own section, so the reason does not repeat it.
  it("says that the reviewer asked for a person, without repeating its summary", () => {
    const body = { decision: "escalate", summary: "Correct, but it collides with agent-five.", reasons: [{ kind: "reviewer", detail: "Correct, but it collides with agent-five." }] };

    expect(escalationReasons(body)).toEqual(["The reviewer asked for a person to decide."]);
  });

  it("gives each rule that sent an approved change to a person, with the paths it names", () => {
    const body = {
      decision: "approve",
      reasons: [
        { kind: "protected_path", detail: "changes protected paths", paths: ["package.json", "migrations/001.sql"] },
        { kind: "interface_change", detail: "interface change probability 0.92 is at or above 0.6" },
      ],
    };

    expect(escalationReasons(body)).toEqual([
      "changes protected paths: package.json, migrations/001.sql",
      "interface change probability 0.92 is at or above 0.6",
    ]);
  });

  it("gives the message of a check that could not pass the change", () => {
    expect(escalationReasons({ check: "size", message: "Too large for automatic review: 80 changed files (the limit is 50)." })).toEqual([
      "Too large for automatic review: 80 changed files (the limit is 50).",
    ]);
  });

  // The count alone does not say what to do; the last reason the agent was given does.
  it("says what the last attempt was sent back for when the attempts ran out", () => {
    const body = {
      check: "contract",
      message: "This change was built on code that has changed on the main branch since its fork branched off:\n- src/db/users.ts#findUser, changed by five in ccccccc.\nCall sync_with_main, change your code to fit, and submit again.",
      reasons: [{ kind: "max_cycles", detail: "rejected on cycle 3 of 3" }],
    };

    expect(escalationReasons(body)).toEqual([
      "rejected on cycle 3 of 3",
      "The last attempt was sent back because: This change was built on code that has changed on the main branch since its fork branched off: - src/db/users.ts#findUser, changed by five in ccccccc.",
    ]);
  });

  it("says where the review stopped when a step failed", () => {
    expect(escalationReasons({ step: "review", error: "401 invalid x-api-key" })).toEqual([
      "The review stopped at the review step: 401 invalid x-api-key",
    ]);
  });

  it("falls back to the reviewer when nothing else was recorded", () => {
    expect(escalationReasons({})).toEqual(["The reviewer asked for a person to decide."]);
  });
});

describe("lookedUp", () => {
  it("says in a sentence what the reviewer looked at in the repository before it decided", () => {
    expect(lookedUp({ lookups: ["read src/db/users.ts", 'searched for "findUser"', "read test/users.test.ts"] })).toBe(
      'Before deciding, it read src/db/users.ts, searched for "findUser" and read test/users.test.ts.',
    );
    expect(lookedUp({ lookups: ["read src/db/users.ts"] })).toBe("Before deciding, it read src/db/users.ts.");
  });

  it("says nothing when the reviewer looked nothing up", () => {
    expect(lookedUp({ lookups: [] })).toBe("");
    expect(lookedUp({})).toBe("");
  });
});

describe("groupRelated", () => {
  const other = (agent: string, relation: "coupled" | "duplicate") => ({ agent, relation });

  it("groups related tasks by how they relate, coupled ones first", () => {
    const related = [other("agent-two", "duplicate"), other("agent-one", "coupled"), other("agent-three", "coupled")];

    expect(groupRelated(related)).toEqual([
      { lead: "Coupled with", others: [related[1], related[2]] },
      { lead: "May duplicate", others: [related[0]] },
    ]);
  });

  it("leaves out a kind of relation that nothing has", () => {
    expect(groupRelated([other("agent-one", "duplicate")])).toEqual([{ lead: "May duplicate", others: [other("agent-one", "duplicate")] }]);
    expect(groupRelated([])).toEqual([]);
  });
});

describe("refusalsFrom", () => {
  const conflict = (id: number, createdAt: number) =>
    event(
      "claim_conflict",
      { agent: "agent-two", goal: "Add limits", paths: ["src/users/limits.ts"], blockedBy: [{ taskId: "t-1", agent: "agent-one", paths: ["src/users/"] }] },
      { id, createdAt },
    );

  it("keeps the refused claims of the last twenty seconds", () => {
    const events = [conflict(1, 1_000), event("submitted", {}, { id: 2, createdAt: 30_000 }), conflict(3, 35_000)];

    expect(refusalsFrom(events, 50_000)).toEqual([
      {
        id: 3,
        agent: "agent-two",
        goal: "Add limits",
        requested: ["src/users/limits.ts"],
        blockedBy: [{ taskId: "t-1", agent: "agent-one", paths: ["src/users/"] }],
        at: 35_000,
      },
    ]);
  });
});

describe("timeLeft", () => {
  it.each([
    [2 * 3_600_000, "2h left"],
    [112 * 60_000, "1h 52m left"],
    [12 * 60_000 + 30_000, "12m left"],
    [59_000, "under a minute left"],
    [0, "expired"],
    [-5000, "expired"],
  ])("%d ms -> %s", (ms, want) => {
    expect(timeLeft(ms)).toBe(want);
  });
});

describe("shortSha", () => {
  it("keeps the first seven characters", () => {
    expect(shortSha("1a2b3c4d5e6f7a8b")).toBe("1a2b3c4");
  });
});
