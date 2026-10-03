// Stand-ins for the services a review reaches outside the Worker: the decision
// model, the reviewer model and the git push. Each records what it was asked.

import type { ReviewerVerdict } from "../../../src/checks";
import type { Decider, RelatedAnswer, RelatedWorkInput, TriageInput } from "../../../src/decider";
import type { Gate, GateRequest, GateResult } from "../../../src/gate";
import type { CandidateOutcome, LandOutcome, MergeEngine, MergeOutcome, MergeRequest } from "../../../src/merge";
import type { Reviewer, ReviewInput, ReviewOutcome } from "../../../src/reviewer";
import type { StepRunner } from "../../../src/pipeline";
import type { Triage } from "../../../src/types";

export const CALM_TRIAGE: Triage = {
  model: "clef",
  goal_fit: { score: 2.9, confidence: 0.9 },
  risk: { score: 0.6, confidence: 0.9, high: 0.01 },
  unrelated_changes: 0.03,
  interface_change: 0.05,
  leftovers: 0.02,
};

export class FakeDecider implements Decider {
  readonly triageCalls: TriageInput[] = [];
  readonly relatedCalls: RelatedWorkInput[] = [];
  triageResult: Triage | Error = CALM_TRIAGE;
  relatedResult: RelatedAnswer[] | Error = [];

  async relatedWork(input: RelatedWorkInput): Promise<RelatedAnswer[]> {
    this.relatedCalls.push(input);
    if (this.relatedResult instanceof Error) {
      throw this.relatedResult;
    }
    return this.relatedResult;
  }

  async triage(input: TriageInput): Promise<Triage> {
    this.triageCalls.push(input);
    if (this.triageResult instanceof Error) {
      throw this.triageResult;
    }
    return this.triageResult;
  }
}

export const APPROVE: ReviewerVerdict = { decision: "approve", summary: "Does what the goal says.", issues: [] };

export class FakeReviewer implements Reviewer {
  readonly calls: ReviewInput[] = [];
  result: ReviewerVerdict | Error = APPROVE;
  model = "claude-opus-5-5";
  // What the reviewer reports having looked up.
  lookups: string[] = [];
  // Runs while the review is in progress, with what the reviewer was given.
  during: ((input: ReviewInput) => Promise<void>) | undefined;

  async review(input: ReviewInput): Promise<ReviewOutcome> {
    this.calls.push(input);
    await this.during?.(input);
    if (this.result instanceof Error) {
      throw this.result;
    }
    return { verdict: this.result, model: this.model, lookups: this.lookups };
  }
}

export const MERGE_SHA = "e".repeat(40);

export const CANDIDATE_SHA = "c".repeat(40);
export const MAIN_SHA = "a".repeat(40);
export const TREE_SHA = "7".repeat(40);

export class FakeMergeEngine implements MergeEngine {
  readonly calls: MergeRequest[] = [];
  result: MergeOutcome | Error = { status: "merged", mergeSha: MERGE_SHA, noteWritten: true };
  // What a candidate is built as; with several, one is used per call and the last one after that.
  candidates: CandidateOutcome[] = [
    { status: "ready", candidateSha: CANDIDATE_SHA, baseSha: MAIN_SHA, treeSha: TREE_SHA, ref: "refs/dibs/candidates/t", composed: [] },
  ];
  readonly candidateCalls: MergeRequest[] = [];
  readonly landCalls: { request: MergeRequest; candidate: { candidateSha: string; baseSha: string; composed: string[] } }[] = [];
  landResult: LandOutcome | null = null;

  async merge(request: MergeRequest): Promise<MergeOutcome> {
    this.calls.push(request);
    if (this.result instanceof Error) {
      throw this.result;
    }
    return this.result;
  }

  async candidate(request: MergeRequest): Promise<CandidateOutcome> {
    this.candidateCalls.push(request);
    return this.candidates[Math.min(this.candidateCalls.length, this.candidates.length) - 1]!;
  }

  async land(request: MergeRequest, candidate: { candidateSha: string; baseSha: string; composed: string[] }): Promise<LandOutcome> {
    this.landCalls.push({ request, candidate });
    return this.landResult ?? { status: "merged", mergeSha: candidate.candidateSha, noteWritten: true };
  }
}

export const GATE_PASSED: GateResult = {
  outcome: "pass",
  candidateSha: CANDIDATE_SHA,
  baseSha: MAIN_SHA,
  treeSha: TREE_SHA,
  seconds: 3.2,
  steps: [{ name: "test", command: "npm test", exitCode: 0, seconds: 3.1, output: "# pass 26\n# fail 0" }],
};

export const GATE_FAILED: GateResult = {
  ...GATE_PASSED,
  outcome: "fail",
  steps: [{ name: "test", command: "npm test", exitCode: 1, seconds: 2.4, output: "not ok 3 - findUser says not_found\n# fail 1" }],
};

// Runs no checks: answers each run with the next of `results`, and the last one after that.
export class FakeGate implements Gate {
  readonly calls: GateRequest[] = [];
  results: (GateResult | Error)[] = [GATE_PASSED];

  async run(request: GateRequest): Promise<GateResult> {
    this.calls.push(request);
    const result = this.results[Math.min(this.calls.length, this.results.length) - 1]!;
    if (result instanceof Error) {
      throw result;
    }
    return { ...result, candidateSha: request.candidateSha, baseSha: request.baseSha, treeSha: request.treeSha };
  }
}

// Runs each step at once, in order, the way a Workflow does on a first, failure-free run.
export class ImmediateSteps implements StepRunner {
  readonly names: string[] = [];
  readonly sleeps: number[] = [];
  onSleep: (() => Promise<void>) | undefined;

  async do<T extends Rpc.Serializable<T>>(name: string, fn: () => Promise<T>): Promise<T> {
    this.names.push(name);
    return fn();
  }

  async sleep(_name: string, ms: number): Promise<void> {
    this.sleeps.push(ms);
    await this.onSleep?.();
  }
}
