// The review of one submission, from diff to merge. Every side effect runs
// inside a named step, so the same function runs under a Cloudflare Workflow
// (durable, with retries) in production and under a plain runner in tests.
//
//   load -> changes -> checks -> interfaces -> contracts -> diff -> checks -> gate -> triage -> review -> decide
//        -> lock -> contracts -> candidate -> (gate again if main moved) -> land

import {
  decide,
  earlyChecks,
  lateChecks,
  rejectOrEscalate,
  wouldAutoApprove,
  type CheckOutcome,
  type EscalationReason,
  type Issue,
} from "./checks";
import { contractsBroken, coordinationFor, describeContract } from "./contracts";
import type { RecordVerdictResult, SubmissionContext, VerdictInput, VerdictView } from "./coordinator";
import type { Decider } from "./decider";
import { buildDiff, type DiffResult } from "./diff";
import { CHECKS_FILE, describeGateFailure, gateEvidence, gateSummary, parseChecks, type ChecksConfig, type Gate, type GateResult } from "./gate";
import { diffTrees, type Change } from "./git/changes";
import type { StalePath } from "./git/overlay";
import { indexPaths, interfaceReport } from "./index/build";
import type { IndexedFile } from "./index/file";
import { repoLookup } from "./lookup";
import type { CandidateOutcome, MergeEngine, MergeRequest } from "./merge";
import type { RepoHost } from "./repo-host";
import type { Reviewer, ReviewInput, ReviewOutcome } from "./reviewer";
import { formatScope, parseTarget } from "./scopes";
import { buildMergeMessage, collectForeignTrailers } from "./trailers";
import { LIVE_STATES, type ContractReport, type Failure, type InterfaceReport, type JsonObject, type Triage } from "./types";

// The Coordinator calls a review makes. The Durable Object stub satisfies this.
export interface CoordinatorPort {
  getSubmission(submissionId: number): Promise<SubmissionContext | null>;
  recordTriage(submissionId: number, triage: Triage | null, reason?: string): Promise<void>;
  recordVerdict(submissionId: number, verdict: VerdictInput): Promise<RecordVerdictResult>;
  recordInterfaces(submissionId: number, report: InterfaceReport): Promise<ContractReport | null>;
  recordGate(submissionId: number, result: GateResult): Promise<void>;
  // Not ok when the change would break a contract: it is sent back, or on its last allowed attempt goes to a person.
  confirmContracts(submissionId: number): Promise<{ ok: true } | { ok: false; report: ContractReport; escalated: boolean }>;
  acquireMergeLock(taskId: string, holdMs?: number): Promise<boolean>;
  releaseMergeLock(taskId: string): Promise<void>;
  recordMerged(
    submissionId: number,
    mergeSha: string,
    noteWritten: boolean,
    index?: { files: IndexedFile[]; removed: string[] },
  ): Promise<{ ok: true } | Failure>;
  recordStale(submissionId: number, paths: StalePath[]): Promise<{ ok: true; escalated: boolean } | Failure>;
}

export interface PipelineDeps {
  coordinator: CoordinatorPort;
  host: RepoHost;
  // Null when no decision model is configured.
  decider: Decider | null;
  reviewer: Reviewer;
  merge: MergeEngine;
  // Runs the repository's checks. Null or absent where there is no way to run them.
  gate?: Gate | null;
  // Milliseconds since the epoch.
  now(): number;
}

// What a step returns is stored by the Workflow, so it has to be serialisable.
export interface StepRunner {
  do<T extends Rpc.Serializable<T>>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

export interface ReviewParams {
  repo: string;
  submissionId: number;
  // Skip the review and merge a submission that has already been approved, as after a person approves an escalation.
  mergeOnly?: boolean;
}

export type ReviewResult =
  | { outcome: "merged"; mergeSha: string }
  | { outcome: "rejected" }
  | { outcome: "escalated" }
  | { outcome: "stale" }
  // Sent back when it was about to land: it would have left the main branch using an interface in the wrong shape.
  | { outcome: "contract" }
  | { outcome: "skipped"; reason: string };

const CONVENTIONS_FILE = "AGENTS.md";
const MAX_CONVENTIONS_CHARS = 20_000;
const COMMITS_SCANNED_FOR_TRAILERS = 100;
// The most the host returns of a branch's history at once.
const MAIN_HISTORY_DEPTH = 1000;
const MERGE_LOCK_WAIT_MS = 2000;
// How long a merge may hold the lock while the repository's checks run under it.
const GATED_LOCK_MS = 18 * 60_000;
// The lock frees itself after two minutes, so this is long enough to always get a turn.
const MERGE_LOCK_ATTEMPTS = 90;

// A verdict that cannot be recorded leaves the task and the review out of step, so it is an error.
async function recordVerdict(coordinator: CoordinatorPort, submissionId: number, verdict: VerdictInput): Promise<void> {
  const recorded = await coordinator.recordVerdict(submissionId, verdict);
  if (!recorded.ok) {
    throw new Error(recorded.error.message);
  }
}

class StepFailure extends Error {
  constructor(
    readonly step: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "StepFailure";
  }
}

export async function runReview(deps: PipelineDeps, steps: StepRunner, params: ReviewParams): Promise<ReviewResult> {
  const { coordinator } = deps;
  const id = params.submissionId;

  // A step that fails for good is reported with its name, so the escalation says where the review stopped.
  const step = async <T extends Rpc.Serializable<T>>(name: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await steps.do(name, fn);
    } catch (error) {
      throw new StepFailure(name, error);
    }
  };

  const context = await steps.do("load", () => coordinator.getSubmission(id));
  if (context === null) {
    return { outcome: "skipped", reason: `submission ${id} does not exist` };
  }
  if (context.task.state !== "in_review") {
    return { outcome: "skipped", reason: `submission ${id} is not in review (task is ${context.task.state})` };
  }
  const { submission, task, config } = context;
  const latest = context.verdicts.at(-1);
  const alreadyApproved = latest?.decision === "approve";
  if (params.mergeOnly && !alreadyApproved) {
    return { outcome: "skipped", reason: `submission ${id} has not been approved` };
  }

  try {
    const changes = await step("changes", async () => {
      using fork = await deps.host.open(task.forkName);
      const [base, head] = await Promise.all([fork.readCommit(task.baseSha), fork.readCommit(submission.headSha)]);
      if (base === null || head === null) {
        throw new Error(`commit ${base === null ? task.baseSha : submission.headSha} is missing from ${task.forkName}`);
      }
      // Awaited here, not returned as a promise: the handle is released when this block ends.
      return await diffTrees(fork, base.tree, head.tree);
    });

    // What the change does to interfaces and what it is built on, held against the index of the main branch.
    const readInterfaces = () =>
      step("interfaces", async () => {
        using fork = await deps.host.open(task.forkName);
        const [base, head] = await Promise.all([fork.readCommit(task.baseSha), fork.readCommit(submission.headSha)]);
        if (base === null || head === null) {
          throw new Error(`commit ${base === null ? task.baseSha : submission.headSha} is missing from ${task.forkName}`);
        }
        const relies = context.scope.filter((entry) => entry.relation === "rely").map((entry) => entry.target);
        return await coordinator.recordInterfaces(id, await interfaceReport(fork, base.tree, head.tree, changes, relies));
      });

    if (alreadyApproved && context.interfaces === null) {
      // A person approved a change the review never got to look at this closely. The merge still checks it.
      await readInterfaces();
    }

    if (!alreadyApproved) {
      const finishCheck = async (failed: Exclude<CheckOutcome, { ok: true }>): Promise<ReviewResult> => {
        const decision =
          failed.decision === "reject"
            ? rejectOrEscalate(submission.cycle, config.maxCycles)
            : { action: "escalate" as const, reasons: [] as EscalationReason[] };
        const escalate = decision.action === "escalate";
        const body: JsonObject = { check: failed.check, message: failed.message, details: failed.details };
        if (decision.action === "escalate" && decision.reasons.length > 0) {
          body.reasons = decision.reasons;
        }
        await step("check", () =>
          recordVerdict(coordinator, id, { decision: escalate ? "escalate" : "reject", source: "check", body }),
        );
        return { outcome: escalate ? "escalated" : "rejected" };
      };

      const early = earlyChecks({ claim: context.claim, changes });
      if (!early.ok) {
        return await finishCheck(early);
      }

      // A change that would break the main branch goes back before any model is asked about it.
      const contracts = await readInterfaces();
      if (contracts !== null && contractsBroken(contracts)) {
        return await finishCheck({
          ok: false,
          decision: "reject",
          check: "contract",
          message: describeContract(contracts),
          details: { contract: contracts },
        });
      }

      const diff: DiffResult = await step("diff", async () => {
        using fork = await deps.host.open(task.forkName);
        return await buildDiff(fork, changes);
      });
      const late = lateChecks({ diffBytes: diff.bytes, unreviewable: diff.unreviewable });
      if (!late.ok) {
        return await finishCheck(late);
      }
      // The repository's checks, on the change joined with main as it is now. A change that fails them goes
      // back before any model is asked about it.
      const checked = await checkCandidate(deps, step, params, context, changes, "gate");
      if (checked.kind === "stale") {
        return await recordStaleStep(step, coordinator, id, checked.paths);
      }
      const gated = checked.kind === "result" ? checked.result : null;
      if (gated?.outcome === "fail") {
        return await gateFailed(step, coordinator, context, gated, "gate-check");
      }

      const files = diff.files.flatMap((file) =>
        file.text === null ? [] : [{ path: file.path, status: file.status, text: file.text }],
      );
      const related = context.related.map(({ agent, goal, paths, relation, state }) => ({
        agent,
        goal,
        paths,
        relation,
        state,
      }));

      // The triage never fails the review: without it, the review goes on and its rule does not apply.
      const triage: Triage | null = await step("triage", async () => {
        if (deps.decider === null || !config.decider.enabled) {
          return null;
        }
        try {
          const answers = await deps.decider.triage({
            goal: task.goal,
            claim: context.claim,
            summary: submission.summary,
            files: files.map((file) => ({ path: file.path, status: file.status, diff: file.text })),
            related: related.map(({ agent, goal, paths, relation }) => ({ agent, goal, paths, relation })),
          });
          await coordinator.recordTriage(id, answers);
          return answers;
        } catch (error) {
          await coordinator.recordTriage(id, null, error instanceof Error ? error.message : String(error));
          return null;
        }
      });
      // Where the index can speak for the change it says whether an interface is altered; elsewhere the decision model guesses.
      const guessed = triage !== null && triage.interface_change >= config.decider.interfaceChangeMin;

      const review: ReviewOutcome = await step("review", async () => {
        using main = await deps.host.open(params.repo);
        using fork = await deps.host.open(task.forkName);
        const [conventions, head, current] = await Promise.all([
          main.readFile(config.defaultBranch, CONVENTIONS_FILE),
          fork.readCommit(submission.headSha),
          // Read again: looking at the interfaces may have connected this task with others.
          coordinator.getSubmission(id),
        ]);
        const report = current?.interfaces ?? null;
        const alters = (report?.changed ?? []).some((change) => change.change !== "added");
        const coordination = coordinationFor(report, contracts, current?.collisions ?? []);
        // Awaited here, not returned as a promise: the reviewer reads the fork while it works.
        return await deps.reviewer.review({
          agent: task.agent,
          goal: task.goal,
          claim: context.claim,
          summary: submission.summary,
          cycle: submission.cycle,
          files,
          triage,
          related,
          conventions: conventions === null ? null : new TextDecoder().decode(conventions).slice(0, MAX_CONVENTIONS_CHARS),
          checkCallers: contracts?.indexed ? alters : guessed,
          ...(coordination === null ? {} : { coordination }),
          gate: gateEvidence(gated),
          previous: context.previous === null ? null : feedbackOf(context.previous),
          lookup: head === null ? null : repoLookup(fork, head.tree),
        });
      });

      const decision = decide({
        reviewer: review.verdict,
        changedPaths: changes.map((change) => change.path),
        protectedPaths: config.protectedPaths,
        triage,
        thresholds: config.decider,
        contracts,
        gate: gated,
        cycle: submission.cycle,
        maxCycles: config.maxCycles,
      });
      const body: JsonObject = {
        decision: review.verdict.decision,
        summary: review.verdict.summary,
        issues: review.verdict.issues,
        model: review.model,
        triage,
      };
      if (triage !== null) {
        body.shadow = { would_auto_approve: wouldAutoApprove(triage) };
      }
      if (review.lookups.length > 0) {
        body.lookups = review.lookups;
      }
      if (decision.action === "escalate") {
        body.reasons = decision.reasons;
        const live = context.related.filter((other) => LIVE_STATES.includes(other.state));
        if (live.length > 0) {
          body.related = live;
        }
      }
      const verdictDecision =
        decision.action === "merge" ? "approve" : decision.action === "reject" ? "reject" : "escalate";
      await step("decide", () => recordVerdict(coordinator, id, { decision: verdictDecision, source: "reviewer", body }));
      if (decision.action === "reject") {
        return { outcome: "rejected" };
      }
      if (decision.action === "escalate") {
        return { outcome: "escalated" };
      }
    }

    // Reload so that the note and the trailer reflect every verdict, including the one just recorded.
    const approved = (alreadyApproved ? context : await coordinator.getSubmission(id)) ?? context;
    return await mergeApproved(deps, steps, step, params, approved, changes, approved.gate);
  } catch (error) {
    if (!(error instanceof StepFailure)) {
      throw error;
    }
    // Do not leave the task stuck in review: hand it to a person with the error attached.
    await coordinator.recordVerdict(id, {
      decision: "escalate",
      source: "system",
      body: { step: error.step, error: error.message },
    });
    return { outcome: "escalated" };
  }
}

// Records that a change cannot land because main changed under a path it held.
async function recordStaleStep(
  step: <T extends Rpc.Serializable<T>>(name: string, fn: () => Promise<T>) => Promise<T>,
  coordinator: CoordinatorPort,
  submissionId: number,
  paths: StalePath[],
): Promise<ReviewResult> {
  const escalated = await step("stale", async () => {
    const recorded = await coordinator.recordStale(submissionId, paths);
    if (!recorded.ok) {
      throw new Error(recorded.error.message);
    }
    return recorded.escalated;
  });
  return escalated ? { outcome: "escalated" } : { outcome: "stale" };
}

// Sends a change back because the repository's checks failed on it, or hands it to a person on its last attempt.
async function gateFailed(
  step: <T extends Rpc.Serializable<T>>(name: string, fn: () => Promise<T>) => Promise<T>,
  coordinator: CoordinatorPort,
  context: SubmissionContext,
  result: GateResult,
  name: string,
): Promise<ReviewResult> {
  const decision = rejectOrEscalate(context.submission.cycle, context.config.maxCycles);
  const body: JsonObject = { message: describeGateFailure(result), gate: result };
  if (decision.action === "escalate") {
    body.reasons = decision.reasons;
  }
  const escalate = decision.action === "escalate";
  await step(name, () =>
    recordVerdict(coordinator, context.submission.id, { decision: escalate ? "escalate" : "reject", source: "gate", body }),
  );
  return { outcome: escalate ? "escalated" : "rejected" };
}

function gateError(reason: string): GateResult {
  return { outcome: "error", candidateSha: "", baseSha: "", treeSha: "", seconds: 0, steps: [], error: reason };
}

// The repository's declared checks, or null for a repository that declares none. An invalid declaration is an error result.
async function readChecks(deps: PipelineDeps, params: ReviewParams, context: SubmissionContext): Promise<ChecksConfig | GateResult | null> {
  using main = await deps.host.open(params.repo);
  const bytes = await main.readFile(context.config.defaultBranch, CHECKS_FILE);
  if (bytes === null) {
    return null;
  }
  const parsed = parseChecks(new TextDecoder().decode(bytes));
  return parsed.ok ? parsed.config : gateError(parsed.reason);
}

// Runs the checks on a candidate and records what they said. Never throws for a failure to run them: that is an error result.
async function runChecks(
  deps: PipelineDeps,
  params: ReviewParams,
  context: SubmissionContext,
  candidate: Extract<CandidateOutcome, { status: "ready" }>,
  config: ChecksConfig,
): Promise<GateResult> {
  let result: GateResult;
  try {
    using main = await deps.host.open(params.repo);
    result = await deps.gate!.run({
      repo: params.repo,
      remote: await main.remote(),
      ref: candidate.ref,
      candidateSha: candidate.candidateSha,
      baseSha: candidate.baseSha,
      treeSha: candidate.treeSha,
      config,
    });
  } catch (error) {
    result = gateError(error instanceof Error ? error.message : String(error));
  }
  await deps.coordinator.recordGate(context.submission.id, result);
  return result;
}

type Checked = { kind: "none" } | { kind: "stale"; paths: StalePath[] } | { kind: "result"; result: GateResult };

// Builds the change joined with main as it is now, and runs the repository's checks on it.
async function checkCandidate(
  deps: PipelineDeps,
  step: <T extends Rpc.Serializable<T>>(name: string, fn: () => Promise<T>) => Promise<T>,
  params: ReviewParams,
  context: SubmissionContext,
  changes: Change[],
  name: string,
): Promise<Checked> {
  return step(name, async (): Promise<Checked> => {
    if (!deps.gate) {
      return { kind: "none" };
    }
    const config = await readChecks(deps, params, context);
    if (config === null) {
      return { kind: "none" };
    }
    if ("outcome" in config) {
      await deps.coordinator.recordGate(context.submission.id, config);
      return { kind: "result", result: config };
    }
    const candidate = await deps.merge.candidate(await requestFor(deps, params, context, changes, null));
    if (candidate.status === "stale") {
      return { kind: "stale", paths: candidate.paths };
    }
    if (candidate.status === "landed") {
      return { kind: "none" };
    }
    return { kind: "result", result: await runChecks(deps, params, context, candidate, config) };
  });
}

// What the merge engine is asked to land: the task's changes, its author, and a commit message and note that say
// what the review found. `gate` is how the checks went on the tree the commit holds, when they ran.
async function requestFor(
  deps: PipelineDeps,
  params: ReviewParams,
  context: SubmissionContext,
  changes: Change[],
  gate: GateResult | null,
): Promise<MergeRequest> {
  const { submission, task, config } = context;
  // Read again, so that the commit says what the review found about the task's scope and interfaces.
  const current = (await deps.coordinator.getSubmission(submission.id)) ?? context;
  const altered = (current.interfaces?.changed ?? []).filter((change) => change.change !== "added");

  using fork = await deps.host.open(task.forkName);
  using main = await deps.host.open(params.repo);
  // The task's own commits: from its head back to the first commit that belongs to main. That is
  // the commit it started from, or a later one if the agent has brought its fork up to date since.
  const onMain = new Set((await main.log(config.defaultBranch, MAIN_HISTORY_DEPTH)).map((commit) => commit.oid));
  const messages: string[] = [];
  for (const commit of await fork.log(submission.headSha, COMMITS_SCANNED_FOR_TRAILERS)) {
    if (commit.oid === task.baseSha || onMain.has(commit.oid)) {
      break;
    }
    messages.push(commit.message);
  }

  const approval = current.verdicts.at(-1);
  const byHuman = approval?.source === "human";
  const reviewed = current.verdicts.findLast((verdict) => verdict.source === "reviewer");
  const model = typeof reviewed?.body.model === "string" ? reviewed.body.model : null;
  // Before the review there is no verdict yet; such a request only builds a candidate to check.
  const reviewer = approval?.decision === "approve" ? (byHuman ? "human" : (model ?? "unknown")) : "pending";
  const note = noteFor(current, approval, reviewed);
  if (gate !== null) {
    note.gate = gate;
  }

  return {
    repo: params.repo,
    branch: config.defaultBranch,
    fork: task.forkName,
    taskId: task.id,
    changes,
    // What the task holds to add to may have been added to by others meanwhile; those files are joined.
    composable: current.scope.flatMap((entry) => {
      const parsed = entry.relation === "add" ? parseTarget(entry.target) : null;
      return parsed?.ok && parsed.target.kind === "path" ? [parsed.target.path] : [];
    }),
    author: { name: task.agent, email: `${task.agent}@agents.dibs.invalid` },
    message: buildMergeMessage({
      goal: task.goal,
      summary: submission.summary,
      taskId: task.id,
      agent: task.agent,
      claim: context.claim,
      scope: formatScope(current.scope),
      interfaces: altered.map((change) => `${change.path}#${change.name} (${change.change})`),
      gate: gate === null ? null : gateSummary(gate),
      verdict: { decision: "approve", reviewer, cycle: submission.cycle },
      fork: task.forkName,
      headSha: submission.headSha,
      foreignTrailers: collectForeignTrailers(messages),
    }),
    note: `${JSON.stringify(note, null, 2)}\n`,
    now: Math.floor(deps.now() / 1000),
  };
}

// Tells the Coordinator that a change landed, and what the files it touched now hold.
async function recordLanding(
  deps: PipelineDeps,
  params: ReviewParams,
  context: SubmissionContext,
  changes: Change[],
  landed: { mergeSha: string; noteWritten: boolean },
): Promise<void> {
  using fork = await deps.host.open(context.task.forkName);
  using main = await deps.host.open(params.repo);
  // The index learns what the change did in the same call that records the landing, so that the
  // next change to land is checked against the main branch as it now is. It reads what landed:
  // a joined file is neither the fork's version nor main's old one.
  const commit = await main.readCommit(landed.mergeSha);
  const head = commit === null ? await fork.readCommit(context.submission.headSha) : null;
  const paths = changes.map((change) => change.path);
  const index = commit !== null ? await indexPaths(main, commit.tree, paths) : head === null ? undefined : await indexPaths(fork, head.tree, paths);
  const recorded = await deps.coordinator.recordMerged(context.submission.id, landed.mergeSha, landed.noteWritten, index);
  if (!recorded.ok) {
    throw new Error(recorded.error.message);
  }
}

async function mergeApproved(
  deps: PipelineDeps,
  steps: StepRunner,
  step: <T extends Rpc.Serializable<T>>(name: string, fn: () => Promise<T>) => Promise<T>,
  params: ReviewParams,
  context: SubmissionContext,
  changes: Change[],
  gated: GateResult | null,
): Promise<ReviewResult> {
  const { coordinator } = deps;
  const { submission, task } = context;
  // A change whose checks passed lands only as a tree the checks have passed. One whose checks could not be run
  // lands as before, and says so.
  const checking = gated?.outcome === "pass";

  let locked = false;
  for (let attempt = 1; attempt <= MERGE_LOCK_ATTEMPTS && !locked; attempt++) {
    locked = await step(`lock-${attempt}`, () => coordinator.acquireMergeLock(task.id, checking ? GATED_LOCK_MS : undefined));
    if (!locked) {
      await steps.sleep(`lock-wait-${attempt}`, MERGE_LOCK_WAIT_MS);
    }
  }
  if (!locked) {
    throw new StepFailure("lock", new Error("could not get the merge lock: another merge has held it too long"));
  }

  try {
    if (!checking) {
      return await step("merge", async (): Promise<ReviewResult> => {
        // The last look, with the lock held: nothing else can land between this and the merge.
        const confirmed = await coordinator.confirmContracts(submission.id);
        if (!confirmed.ok) {
          return confirmed.escalated ? { outcome: "escalated" } : { outcome: "contract" };
        }
        const outcome = await deps.merge.merge(await requestFor(deps, params, context, changes, gated));
        if (outcome.status === "stale") {
          const recorded = await coordinator.recordStale(submission.id, outcome.paths);
          if (!recorded.ok) {
            throw new Error(recorded.error.message);
          }
          return recorded.escalated ? { outcome: "escalated" } : { outcome: "stale" };
        }
        await recordLanding(deps, params, context, changes, outcome);
        return { outcome: "merged", mergeSha: outcome.mergeSha };
      });
    }

    // With the lock held, build the change joined with main as it is now.
    const built = await step("merge", async (): Promise<{ kind: "contract"; escalated: boolean } | { kind: "built"; candidate: CandidateOutcome; config: ChecksConfig | null }> => {
      const confirmed = await coordinator.confirmContracts(submission.id);
      if (!confirmed.ok) {
        return { kind: "contract", escalated: confirmed.escalated };
      }
      const config = await readChecks(deps, params, context);
      return {
        kind: "built",
        candidate: await deps.merge.candidate(await requestFor(deps, params, context, changes, null)),
        config: config !== null && !("outcome" in config) ? config : null,
      };
    });
    if (built.kind === "contract") {
      return built.escalated ? { outcome: "escalated" } : { outcome: "contract" };
    }
    const { candidate } = built;
    if (candidate.status === "stale") {
      return await recordStaleStep(step, coordinator, submission.id, candidate.paths);
    }
    if (candidate.status === "landed") {
      await step("land", async () => {
        await recordLanding(deps, params, context, changes, candidate);
        return true;
      });
      return { outcome: "merged", mergeSha: candidate.mergeSha };
    }

    // The checks passed on a tree; if main moved since, the tree to land is another, and is checked in its turn.
    let result = gated!;
    if (candidate.treeSha !== result.treeSha && built.config !== null) {
      const again = built.config;
      result = await step("gate-again", () => runChecks(deps, params, context, candidate, again));
      if (result.outcome === "fail") {
        return await gateFailed(step, coordinator, context, result, "gate-check");
      }
    }

    const landedSha = await step("land", async (): Promise<string> => {
      // The commit that lands holds the tree that was checked, and says how the checks went.
      const request = await requestFor(deps, params, context, changes, result);
      const final = await deps.merge.candidate(request);
      if (final.status !== "ready") {
        throw new Error(`the change could not be built again for landing (${final.status})`);
      }
      if (final.treeSha !== result.treeSha && result.outcome === "pass") {
        throw new Error("main moved while the merge lock was held");
      }
      const landed = await deps.merge.land(request, final);
      if (landed.status === "moved") {
        throw new Error(`main moved while the merge lock was held: ${landed.reason}`);
      }
      await recordLanding(deps, params, context, changes, landed);
      return landed.mergeSha;
    });
    return { outcome: "merged", mergeSha: landedSha };
  } finally {
    await coordinator.releaseMergeLock(task.id);
  }
}

// What the previous attempt was told when it was sent back, in words the reviewer can check the new attempt against.
function feedbackOf(verdict: VerdictView): ReviewInput["previous"] {
  const body = verdict.body as { summary?: unknown; issues?: unknown; note?: unknown; message?: unknown };
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  switch (verdict.source) {
    case "human":
      return { by: "person", feedback: text(body.note) || "(no note was given)" };
    case "check":
      return { by: "check", feedback: text(body.message) };
    case "merge":
      return { by: "merge", feedback: text(body.message) };
    case "reviewer": {
      const issues = (Array.isArray(body.issues) ? (body.issues as Issue[]) : []).map((issue) => {
        const where = issue.line === undefined ? issue.path : `${issue.path}:${issue.line}`;
        const fix = issue.suggestion === undefined ? "" : ` Fix: ${issue.suggestion}`;
        return `- ${issue.severity} ${where} ${issue.description}${fix}`;
      });
      return { by: "reviewer", feedback: [text(body.summary), ...issues].join("\n") };
    }
    default:
      return null;
  }
}

// What is attached to the merge commit under refs/notes/dibs.
function noteFor(
  context: SubmissionContext,
  approval: VerdictView | undefined,
  reviewed: VerdictView | undefined,
): JsonObject {
  const byHuman = approval?.source === "human";
  const note: JsonObject = {
    task: context.task.id,
    agent: context.task.agent,
    goal: context.task.goal,
    claim: context.claim,
    cycle: context.submission.cycle,
    approved_by: byHuman ? "human" : "reviewer",
  };
  if (byHuman && typeof approval.body.note === "string" && approval.body.note !== "") {
    note.human_note = approval.body.note;
  }
  // The scope, where it says more than the claimed paths do.
  if (formatScope(context.scope) !== null) {
    note.scope = context.scope;
  }
  const altered = (context.interfaces?.changed ?? []).filter((change) => change.change !== "added");
  if (altered.length > 0) {
    note.interfaces = altered.map(({ path, name, change, before, after }) => ({
      target: `${path}#${name}`,
      change,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    }));
  }
  if (context.leaves !== null) {
    note.leaves_dependents = context.leaves;
  }
  if (context.collisions.length > 0) {
    note.collisions = context.collisions.map(({ kind, state, role, targets, with: other }) => ({
      kind,
      state,
      role,
      targets,
      with: { task: other.taskId, agent: other.agent, state: other.state },
    }));
  }
  // The reviewer's own verdict; absent when a person approved a change no model reviewed.
  if (reviewed !== undefined) {
    const { decision, summary, issues, model, triage, shadow, lookups } = reviewed.body as {
      decision?: string;
      summary?: string;
      issues?: Issue[];
      model?: string;
      triage?: Triage | null;
      shadow?: { would_auto_approve: boolean };
      lookups?: string[];
    };
    Object.assign(note, {
      decision: decision ?? null,
      summary: summary ?? "",
      issues: issues ?? [],
      model: model ?? null,
      triage: triage ?? null,
    });
    if (shadow !== undefined) {
      note.shadow = shadow;
    }
    if (lookups !== undefined) {
      note.lookups = lookups;
    }
  }
  return note;
}
