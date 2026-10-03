import { describe, expect, it } from "vitest";
import { covers, decide, earlyChecks, lateChecks, wouldAutoApprove, type DecideInput, type ReviewerVerdict } from "../../src/checks";
import type { Change } from "../../src/git/changes";
import { DEFAULT_DECIDER_CONFIG, DEFAULT_PROTECTED_PATHS, type Triage } from "../../src/types";

const OID = "a".repeat(40);

function change(path: string, status: Change["status"] = "modified"): Change {
  const leaf = { mode: "100644", oid: OID };
  return { path, status, base: status === "added" ? null : leaf, head: status === "deleted" ? null : leaf };
}

describe("covers", () => {
  it.each([
    [["src/api/"], "src/api/users.ts", true],
    [["src/api/"], "src/api/v2/users.ts", true],
    [["src/api/users.ts"], "src/api/users.ts", true],
    [["docs/", "src/api/"], "src/api/users.ts", true],
    // A file claim covers that file only, not paths beneath or beside it.
    [["src/api"], "src/api/users.ts", false],
    [["src/api/users.ts"], "src/api/users.test.ts", false],
    [["src/api/"], "src/apiary.ts", false],
    [["src/api/"], "src/db/users.ts", false],
    [[], "README.md", false],
  ])("claim %j, path %j -> %s", (claim, path, want) => {
    expect(covers(claim, path)).toBe(want);
  });
});

describe("earlyChecks", () => {
  it("passes a change that stays inside its claim", () => {
    expect(earlyChecks({ claim: ["src/api/"], changes: [change("src/api/users.ts"), change("src/api/new.ts", "added")] })).toEqual({
      ok: true,
    });
  });

  it("rejects an empty change", () => {
    expect(earlyChecks({ claim: ["src/api/"], changes: [] })).toMatchObject({
      ok: false,
      decision: "reject",
      check: "empty",
    });
  });

  it("rejects paths outside the claim, lists them all and suggests expanding the claim", () => {
    const outcome = earlyChecks({
      claim: ["src/db/"],
      changes: [change("src/db/users.ts"), change("src/utils/date.ts"), change("README.md", "deleted")],
    });

    expect(outcome).toEqual({
      ok: false,
      decision: "reject",
      check: "coverage",
      message:
        "2 changed paths are outside the task's scope: README.md, src/utils/date.ts. Call expand_scope for them, or revert those changes, then submit again.",
      details: { uncovered: ["README.md", "src/utils/date.ts"], claim: ["src/db/"] },
    });
  });

  it("escalates more than 50 changed files without looking further", () => {
    const changes = Array.from({ length: 51 }, (_, index) => change(`src/gen/f${index}.ts`, "added"));

    expect(earlyChecks({ claim: ["src/gen/"], changes })).toMatchObject({
      ok: false,
      decision: "escalate",
      check: "size",
      details: { files: 51, limit: 50 },
    });
    expect(earlyChecks({ claim: ["src/gen/"], changes: changes.slice(0, 50) })).toEqual({ ok: true });
  });

  it("reports missing coverage before size, since the agent can fix that itself", () => {
    const changes = Array.from({ length: 51 }, (_, index) => change(`src/gen/f${index}.ts`, "added"));

    expect(earlyChecks({ claim: ["docs/"], changes })).toMatchObject({ check: "coverage" });
  });
});

describe("lateChecks", () => {
  it("passes a diff at the size limit and escalates one byte over", () => {
    expect(lateChecks({ diffBytes: 100 * 1024, unreviewable: [] })).toEqual({ ok: true });
    expect(lateChecks({ diffBytes: 100 * 1024 + 1, unreviewable: [] })).toMatchObject({
      ok: false,
      decision: "escalate",
      check: "size",
      details: { diffBytes: 100 * 1024 + 1, limit: 100 * 1024 },
    });
  });

  it("escalates a change that contains files a model cannot read", () => {
    expect(lateChecks({ diffBytes: 10, unreviewable: ["assets/logo.png", "vendor/lib"] })).toMatchObject({
      ok: false,
      decision: "escalate",
      check: "size",
      details: { unreviewable: ["assets/logo.png", "vendor/lib"] },
    });
  });
});

const triage: Triage = {
  model: "clef",
  goal_fit: { score: 2.8, confidence: 0.9 },
  risk: { score: 1.0, confidence: 0.9, high: 0.02 },
  unrelated_changes: 0.05,
  interface_change: 0.1,
  leftovers: 0.05,
};

const approve: ReviewerVerdict = { decision: "approve", summary: "ok", issues: [] };

function input(overrides: Partial<DecideInput> = {}): DecideInput {
  return {
    reviewer: approve,
    changedPaths: ["src/api/users.ts"],
    protectedPaths: [...DEFAULT_PROTECTED_PATHS],
    triage,
    thresholds: DEFAULT_DECIDER_CONFIG,
    cycle: 1,
    maxCycles: 3,
    ...overrides,
  };
}

describe("decide", () => {
  it("merges an approved, unremarkable change", () => {
    expect(decide(input())).toEqual({ action: "merge" });
  });

  it("merges an approval that carries only minor and major issues", () => {
    const reviewer: ReviewerVerdict = {
      decision: "approve",
      summary: "ok",
      issues: [
        { severity: "minor", path: "a.ts", description: "naming" },
        { severity: "major", path: "a.ts", description: "missing test" },
      ],
    };

    expect(decide(input({ reviewer }))).toEqual({ action: "merge" });
  });

  it("rejects when the reviewer rejects", () => {
    expect(decide(input({ reviewer: { decision: "reject", summary: "no", issues: [] } }))).toEqual({ action: "reject" });
  });

  it("rejects an approval that carries a critical issue", () => {
    const reviewer: ReviewerVerdict = {
      decision: "approve",
      summary: "ok",
      issues: [{ severity: "critical", path: "a.ts", description: "data loss" }],
    };

    expect(decide(input({ reviewer }))).toEqual({ action: "reject" });
  });

  it("escalates instead of rejecting on the last allowed cycle", () => {
    const reviewer: ReviewerVerdict = { decision: "reject", summary: "no", issues: [] };

    expect(decide(input({ reviewer, cycle: 2 }))).toEqual({ action: "reject" });
    expect(decide(input({ reviewer, cycle: 3 }))).toEqual({
      action: "escalate",
      reasons: [{ kind: "max_cycles", detail: "rejected on cycle 3 of 3" }],
    });
  });

  it("sends a rejection back to the agent even when the change touches a protected path or looks risky", () => {
    const reviewer: ReviewerVerdict = { decision: "reject", summary: "no", issues: [] };
    const risky: Triage = { ...triage, risk: { score: 3, confidence: 0.9, high: 0.95 }, interface_change: 0.99 };

    expect(decide(input({ reviewer, changedPaths: ["package.json"], triage: risky }))).toEqual({ action: "reject" });
  });

  it("escalates when the reviewer asks for a human", () => {
    expect(decide(input({ reviewer: { decision: "escalate", summary: "unsure about the migration", issues: [] } }))).toEqual({
      action: "escalate",
      reasons: [{ kind: "reviewer", detail: "unsure about the migration" }],
    });
  });

  it("escalates an approved change to a protected path and names the paths", () => {
    const decision = decide(
      input({ changedPaths: ["src/api/users.ts", "package.json", ".github/workflows/ci.yml", "migrations/001.sql"] }),
    );

    expect(decision).toEqual({
      action: "escalate",
      reasons: [
        {
          kind: "protected_path",
          detail: "changes protected paths",
          paths: [".github/workflows/ci.yml", "migrations/001.sql", "package.json"],
        },
      ],
    });
  });

  describe("with what the index found about the interfaces the change alters", () => {
    const flagged: Triage = { ...triage, interface_change: 0.95 };
    const contracts = { indexed: true, moved: [], unupdated: [], held: [], leaves: null };
    const left = {
      target: "src/db/users.ts#findUser",
      change: "changed" as const,
      files: [
        { path: "src/routes/users/get.ts", heldBy: null },
        { path: "src/admin.ts", heldBy: null },
      ],
    };

    it("merges a change that alters an interface when every file that uses it is part of the change", () => {
      expect(decide(input({ triage: flagged, contracts }))).toEqual({ action: "merge" });
    });

    it("asks a person when files that use an altered interface are left as they were on the agent's word", () => {
      expect(decide(input({ contracts: { ...contracts, unupdated: [left], leaves: "they only read .ok" } }))).toEqual({
        action: "escalate",
        reasons: [
          {
            kind: "interface_change",
            detail:
              'alters src/db/users.ts#findUser, and leaves files that use it as they were. The agent says they need no change: "they only read .ok"',
            paths: ["src/admin.ts", "src/routes/users/get.ts"],
          },
        ],
      });
    });

    it("goes by the decision model when the index cannot speak for the change", () => {
      expect(decide(input({ triage: flagged, contracts: { ...contracts, indexed: false } }))).toMatchObject({
        action: "escalate",
        reasons: [{ kind: "interface_change", detail: "interface change probability 0.95 is at or above 0.6" }],
      });
      expect(decide(input({ triage: flagged, contracts: null }))).toMatchObject({ action: "escalate" });
    });

    it("still asks a person about risk", () => {
      const risky: Triage = { ...flagged, risk: { score: 2.5, confidence: 0.5, high: 0.5 } };

      expect(decide(input({ triage: risky, contracts }))).toMatchObject({ action: "escalate", reasons: [{ kind: "risk" }] });
    });
  });

  it("does not treat a nested file with a protected name as protected", () => {
    expect(decide(input({ changedPaths: ["packages/web/package.json"] }))).toEqual({ action: "merge" });
  });

  it.each([
    ["the chance of high risk just below the threshold", { risk: { score: 2.2, confidence: 0.3, high: 0.29 } }, null],
    ["the chance of high risk at the threshold", { risk: { score: 2.2, confidence: 0.3, high: 0.3 } }, "risk"],
    ["the chance of high risk above the threshold", { risk: { score: 2.9, confidence: 0.8, high: 0.9 } }, "risk"],
    // Clef's confidence says how concentrated its answer is. A spread between "low" and "medium" is ordinary, not a warning.
    ["a spread-out risk answer that gives little weight to high", { risk: { score: 1.5, confidence: 0.1, high: 0.04 } }, null],
    ["interface change just below the threshold", { interface_change: 0.59 }, null],
    ["interface change at the threshold", { interface_change: 0.6 }, "interface_change"],
    ["interface change above the threshold", { interface_change: 0.95 }, "interface_change"],
  ])("with %s", (_label, override, wantKind) => {
    const decision = decide(input({ triage: { ...triage, ...override } }));

    if (wantKind === null) {
      expect(decision).toEqual({ action: "merge" });
    } else {
      expect(decision.action).toBe("escalate");
      expect(decision.action === "escalate" && decision.reasons.map((reason) => reason.kind)).toEqual([wantKind]);
    }
  });

  it("gives every reason when several apply, protected paths first", () => {
    const decision = decide(
      input({
        changedPaths: ["package.json"],
        triage: { ...triage, risk: { score: 2.8, confidence: 0.6, high: 0.85 }, interface_change: 0.9 },
      }),
    );

    expect(decision).toEqual({
      action: "escalate",
      reasons: [
        { kind: "protected_path", detail: "changes protected paths", paths: ["package.json"] },
        { kind: "risk", detail: "the chance that this is high risk, 0.85, is at or above 0.3" },
        { kind: "interface_change", detail: "interface change probability 0.90 is at or above 0.6" },
      ],
    });
  });

  it("ignores goal fit, unrelated changes and leftovers: those inform the reviewer only", () => {
    const sloppy: Triage = { ...triage, goal_fit: { score: 0.2, confidence: 0.2 }, unrelated_changes: 0.99, leftovers: 0.99 };

    expect(decide(input({ triage: sloppy }))).toEqual({ action: "merge" });
  });

  it("applies no triage rule when the triage is unavailable", () => {
    expect(decide(input({ triage: null }))).toEqual({ action: "merge" });
  });

  it("applies no triage rule when the decision model is switched off", () => {
    const risky: Triage = { ...triage, risk: { score: 3, confidence: 0.9, high: 0.95 }, interface_change: 0.99 };

    expect(decide(input({ triage: risky, thresholds: { ...DEFAULT_DECIDER_CONFIG, enabled: false } }))).toEqual({
      action: "merge",
    });
  });
});

describe("wouldAutoApprove", () => {
  const clean: Triage = {
    model: "clef",
    goal_fit: { score: 2.4, confidence: 0.3 },
    risk: { score: 1.49, confidence: 0.3, high: 0.03 },
    unrelated_changes: 0.29,
    interface_change: 0.29,
    leftovers: 0.29,
  };

  it("is true for a low-risk change that fits its goal and has no warning signs", () => {
    expect(wouldAutoApprove(clean)).toBe(true);
  });

  it.each([
    ["risk at 1.5, where medium begins", { risk: { score: 1.5, confidence: 0.3, high: 0.03 } }],
    ["goal fit below 2.4", { goal_fit: { score: 2.39, confidence: 0.3 } }],
    ["unrelated changes at 0.3", { unrelated_changes: 0.3 }],
    ["interface change at 0.3", { interface_change: 0.3 }],
    ["leftovers at 0.3", { leftovers: 0.3 }],
  ])("is false with %s", (_label, override) => {
    expect(wouldAutoApprove({ ...clean, ...override })).toBe(false);
  });
});
