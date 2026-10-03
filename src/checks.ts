// The parts of a review that are decided by code, not by a model: the mechanical
// checks that run before any model is called, and the rules that turn a
// reviewer's verdict and the triage signals into what actually happens.

import type { Change } from "./git/changes";
import type { GateResult } from "./gate";
import type { ContractReport, DeciderConfig, JsonObject, Triage } from "./types";

export const MAX_CHANGED_FILES = 50;
export const MAX_DIFF_BYTES = 100 * 1024;
const PATHS_NAMED_IN_MESSAGE = 20;

// A directory covers everything beneath it; a file covers that file only.
export function covers(claim: readonly string[], path: string): boolean {
  return claim.some((held) => (held.endsWith("/") ? path.startsWith(held) : held === path));
}

export type CheckOutcome =
  | { ok: true }
  | {
      ok: false;
      decision: "reject" | "escalate";
      check: "empty" | "coverage" | "size" | "contract";
      message: string;
      details: JsonObject;
    };

function listPaths(paths: string[]): string {
  const shown = paths.slice(0, PATHS_NAMED_IN_MESSAGE).join(", ");
  return paths.length > PATHS_NAMED_IN_MESSAGE ? `${shown} and ${paths.length - PATHS_NAMED_IN_MESSAGE} more` : shown;
}

// Checks that need only the list of changed paths.
export function earlyChecks(input: { claim: string[]; changes: Change[] }): CheckOutcome {
  if (input.changes.length === 0) {
    return {
      ok: false,
      decision: "reject",
      check: "empty",
      message: "The fork has no changes compared with the commit it started from.",
      details: {},
    };
  }

  const uncovered = input.changes
    .map((change) => change.path)
    .filter((path) => !covers(input.claim, path))
    .sort();
  if (uncovered.length > 0) {
    const count = uncovered.length;
    return {
      ok: false,
      decision: "reject",
      check: "coverage",
      message:
        `${count} changed ${count === 1 ? "path is" : "paths are"} outside the task's scope: ${listPaths(uncovered)}. ` +
        "Call expand_scope for them, or revert those changes, then submit again.",
      details: { uncovered, claim: input.claim },
    };
  }

  if (input.changes.length > MAX_CHANGED_FILES) {
    return {
      ok: false,
      decision: "escalate",
      check: "size",
      message: `Too large for automatic review: ${input.changes.length} changed files (the limit is ${MAX_CHANGED_FILES}).`,
      details: { files: input.changes.length, limit: MAX_CHANGED_FILES },
    };
  }
  return { ok: true };
}

// Checks that need the diff itself.
export function lateChecks(input: { diffBytes: number; unreviewable: string[] }): CheckOutcome {
  if (input.unreviewable.length > 0) {
    return {
      ok: false,
      decision: "escalate",
      check: "size",
      message: `Cannot be reviewed automatically: binary files or submodule links changed (${listPaths(input.unreviewable)}).`,
      details: { unreviewable: input.unreviewable },
    };
  }
  if (input.diffBytes > MAX_DIFF_BYTES) {
    return {
      ok: false,
      decision: "escalate",
      check: "size",
      message: `Too large for automatic review: ${input.diffBytes} bytes of diff (the limit is ${MAX_DIFF_BYTES}).`,
      details: { diffBytes: input.diffBytes, limit: MAX_DIFF_BYTES },
    };
  }
  return { ok: true };
}

export type Issue = {
  severity: "critical" | "major" | "minor";
  path: string;
  line?: number;
  description: string;
  suggestion?: string;
};

export type ReviewerVerdict = {
  decision: "approve" | "reject" | "escalate";
  summary: string;
  issues: Issue[];
};

export type EscalationReason = {
  kind: "reviewer" | "max_cycles" | "protected_path" | "risk" | "interface_change";
  detail: string;
  paths?: string[];
};

export type Decision = { action: "merge" } | { action: "reject" } | { action: "escalate"; reasons: EscalationReason[] };

export interface DecideInput {
  reviewer: ReviewerVerdict;
  changedPaths: string[];
  protectedPaths: string[];
  triage: Triage | null;
  thresholds: DeciderConfig;
  // How the change stands against the interface index, when the review has looked.
  contracts?: ContractReport | null;
  // What the repository's checks said, when they ran.
  gate?: GateResult | null;
  cycle: number;
  maxCycles: number;
}

// A rejection goes back to the agent, unless it has used up its cycles.
export function rejectOrEscalate(cycle: number, maxCycles: number): Decision {
  if (cycle >= maxCycles) {
    return { action: "escalate", reasons: [{ kind: "max_cycles", detail: `rejected on cycle ${cycle} of ${maxCycles}` }] };
  }
  return { action: "reject" };
}

// The platform decides; the reviewer and the decision model only inform. A
// person sees a change only if the reviewer would have merged it or could not judge it.
export function decide(input: DecideInput): Decision {
  const { reviewer } = input;
  const hasCritical = reviewer.issues.some((issue) => issue.severity === "critical");
  if (reviewer.decision === "reject" || (reviewer.decision === "approve" && hasCritical)) {
    return rejectOrEscalate(input.cycle, input.maxCycles);
  }
  if (reviewer.decision === "escalate") {
    return { action: "escalate", reasons: [{ kind: "reviewer", detail: reviewer.summary }] };
  }

  const reasons: EscalationReason[] = [];
  const protectedChanges = input.changedPaths.filter((path) => covers(input.protectedPaths, path)).sort();
  if (protectedChanges.length > 0) {
    reasons.push({ kind: "protected_path", detail: "changes protected paths", paths: protectedChanges });
  }

  const { triage, thresholds } = input;
  if (triage !== null && thresholds.enabled) {
    // The probability of "high", not the score or the model's confidence: an answer split between
    // "low" and "medium" is ordinary, and one that gives real weight to "high" is worth a person's look.
    if (triage.risk.high >= thresholds.riskHighMin) {
      reasons.push({
        kind: "risk",
        detail: `the chance that this is high risk, ${triage.risk.high.toFixed(2)}, is at or above ${thresholds.riskHighMin}`,
      });
    }
    // Where the index can speak for the change, it is the index that says whether an interface changed
    // and who uses it, and the decision model's guess is not needed.
    // Checks that pass on the change joined with main say more about callers than either guess does.
    const checked = input.gate?.outcome === "pass";
    if (!input.contracts?.indexed && !checked && triage.interface_change >= thresholds.interfaceChangeMin) {
      reasons.push({
        kind: "interface_change",
        detail: `interface change probability ${triage.interface_change.toFixed(2)} is at or above ${thresholds.interfaceChangeMin}`,
      });
    }
  }

  // An altered interface asks for a person only when files that use it are left as they were. A change
  // that updates every file that uses the interface is whole, and the reviewer has judged it.
  const contracts = input.contracts;
  if (contracts?.indexed && contracts.unupdated.length > 0 && input.gate?.outcome !== "pass") {
    const targets = contracts.unupdated.map((entry) => entry.target);
    reasons.push({
      kind: "interface_change",
      detail:
        `alters ${targets.join(", ")}, and leaves files that use ${targets.length === 1 ? "it" : "them"} as they were. ` +
        `The agent says they need no change: ${JSON.stringify(contracts.leaves ?? "")}`,
      paths: [...new Set(contracts.unupdated.flatMap((entry) => entry.files.map((file) => file.path)))].sort(),
    });
  }

  return reasons.length > 0 ? { action: "escalate", reasons } : { action: "merge" };
}

// Whether the decision model's answers alone would have approved the change.
// Recorded for comparison with the real outcome; it never affects a decision.
export function wouldAutoApprove(triage: Triage): boolean {
  return (
    triage.risk.score < 1.5 &&
    triage.goal_fit.score >= 2.4 &&
    triage.unrelated_changes < 0.3 &&
    triage.interface_change < 0.3 &&
    triage.leftovers < 0.3
  );
}
