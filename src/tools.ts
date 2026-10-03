// What each agent tool does. These functions are the whole behaviour of the MCP
// server; mcp.ts only describes them to the protocol and passes arguments through.

import type {
  ExpandScopeRequest,
  ExpandScopeResult,
  GrantedTask,
  PollResult,
  RecentMerge,
  RecordVerdictResult,
  StartTaskRequest,
  StartTaskResult,
  SubmitRequest,
  SubmitResult,
  TaskView,
  VerdictInput,
} from "./coordinator";
import { selectRelated, type Decider } from "./decider";
import { buildDiff } from "./diff";
import { newestMainAncestor } from "./git/ancestry";
import { diffTrees, type Change } from "./git/changes";
import { openWhenReady, RepoHostError, whenReady, type RepoHost } from "./repo-host";
import { parseTarget } from "./scopes";
import type {
  Agent,
  CollisionView,
  Conflict,
  DibsError,
  ErrorCode,
  Failure,
  JsonObject,
  LiveTask,
  RelatedTask,
  Relation,
  RepoConfig,
  ScopeEntry,
  ScopeInput,
  TaskState,
  WaitingView,
} from "./types";

// The Coordinator calls the tools make. The Durable Object stub satisfies this.
export interface ToolCoordinatorPort {
  getConfig(): Promise<RepoConfig | null>;
  startTask(request: StartTaskRequest): Promise<StartTaskResult>;
  pollRequest(request: { agentId: string; requestId: string }): Promise<PollResult>;
  cancelRequest(request: { agentId: string; requestId: string }): Promise<{ ok: true } | Failure>;
  attachFork(taskId: string, baseSha: string): Promise<{ ok: true } | Failure>;
  failStart(taskId: string, reason: string): Promise<{ ok: true } | Failure>;
  recordRelated(
    taskId: string,
    related: { taskId: string; relation: Relation; confidence: number }[],
  ): Promise<RelatedTask[]>;
  recordDeciderUnavailable(report: { taskId: string; stage: "claim" | "triage"; reason: string }): Promise<void>;
  expandScope(request: ExpandScopeRequest): Promise<ExpandScopeResult>;
  submit(request: SubmitRequest): Promise<SubmitResult>;
  recordCatchUp(taskId: string, mainHead: string): Promise<void>;
  recordVerdict(submissionId: number, verdict: VerdictInput): Promise<RecordVerdictResult>;
  getTask(request: { agentId: string; taskId: string }): Promise<{ ok: true; task: TaskView } | Failure>;
  peekInfo(request: { agentId: string; taskId: string; otherTaskId: string }): Promise<
    | {
        ok: true;
        other: { taskId: string; agent: string; goal: string; state: TaskState; forkName: string; baseSha: string | null; summary: string | null };
      }
    | Failure
  >;
  whatsHappening(): Promise<{ tasks: LiveTask[]; merges: RecentMerge[]; waiting: WaitingView[] }>;
  abandon(request: { agentId: string; taskId: string }): Promise<{ ok: true } | Failure>;
}

export interface ToolDeps {
  repo: string;
  coordinator: ToolCoordinatorPort;
  host: RepoHost;
  // Null when no decision model is configured.
  decider: Decider | null;
  startReview(params: { repo: string; submissionId: number }): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface ConflictView {
  task_id: string;
  agent: string;
  goal: string;
  state: TaskState;
  // What the other task holds that the request cannot have.
  paths: string[];
  // The same, with how each is held: to change, or to add to.
  held: { target: string; relation: string }[];
  started_at: string;
  claim_expires_at: string | null;
}

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: DibsError; conflicts?: ConflictView[] };

const FORK_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const MAIN_READ_TOKEN_TTL_SECONDS = 10 * 60;
// How far back the main branch's history is read to find where a fork branches off it. The most the host returns at once.
const MAIN_HISTORY_DEPTH = 1000;
// The most scope entries a tool answer lists. What dibs itself found the task to rely on is cut first.
const SCOPE_SHOWN = 40;

const iso = (ms: number) => new Date(ms).toISOString();
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function failure(code: ErrorCode, text: string, retryable = false): { ok: false; error: DibsError } {
  return { ok: false, error: { code, message: text, retryable } };
}

function conflictView(conflict: Conflict): ConflictView {
  return {
    task_id: conflict.taskId,
    agent: conflict.agent,
    goal: conflict.goal,
    state: conflict.state,
    paths: conflict.paths,
    held: conflict.held,
    started_at: iso(conflict.startedAt),
    claim_expires_at: conflict.claimExpiresAt === null ? null : iso(conflict.claimExpiresAt),
  };
}

function refused(result: Failure & { conflicts?: Conflict[] }): { ok: false; error: DibsError; conflicts?: ConflictView[] } {
  if (result.conflicts === undefined) {
    return { ok: false, error: result.error };
  }
  return { ok: false, error: result.error, conflicts: result.conflicts.map(conflictView) };
}

export interface RelatedView {
  task_id: string;
  agent: string;
  goal: string;
  state: TaskState;
  paths: string[];
  relation: Relation;
  // The probability the decision model gave the relation.
  confidence: number;
}

function relatedView(other: RelatedTask): RelatedView {
  return {
    task_id: other.taskId,
    agent: other.agent,
    goal: other.goal,
    state: other.state,
    paths: other.paths,
    relation: other.relation,
    confidence: other.confidence,
  };
}

// Another task whose work meets this one's, with what to do about it.
export interface CollisionData {
  kind: CollisionView["kind"];
  // "possible": the other task holds code this one uses and has not said it will change it. "open": it will, or has.
  state: CollisionView["state"];
  // "provider": this task changes what the other uses. "relier": the other changes what this task uses.
  role: CollisionView["role"];
  with: { task_id: string; agent: string; goal: string; state: TaskState; merge_sha: string | null };
  targets: string[];
  // Which of the two is expected to land first.
  order: { first: string; why: string } | null;
  brief: string;
}

function collisionData(view: CollisionView): CollisionData {
  return {
    kind: view.kind,
    state: view.state,
    role: view.role,
    with: { task_id: view.with.taskId, agent: view.with.agent, goal: view.with.goal, state: view.with.state, merge_sha: view.with.mergeSha },
    targets: view.targets,
    order: view.order,
    brief: view.brief,
  };
}

// The files that use an interface the task changes, and are not the task's to write.
export interface DependentsData {
  target: string;
  used_by: { path: string; held_by: string | null }[];
}

// What a task holds first, then what it said it relies on, then what dibs found it to rely on.
function shownScope(scope: ScopeEntry[]): { scope: ScopeEntry[]; scope_cut?: number } {
  const rank = (entry: ScopeEntry) => (entry.relation !== "rely" ? 0 : entry.origin === "declared" ? 1 : 2);
  const ordered = [...scope].sort((a, b) => rank(a) - rank(b));
  return ordered.length > SCOPE_SHOWN ? { scope: ordered.slice(0, SCOPE_SHOWN), scope_cut: ordered.length - SCOPE_SHOWN } : { scope: ordered };
}

// What every answer about a task says of how it stands with the other tasks.
interface Standing {
  collisions: CollisionData[];
  dependents: DependentsData[];
}

function standing(task: TaskView): Standing {
  return {
    collisions: task.collisions.map(collisionData),
    dependents: task.dependents.map((entry) => ({
      target: entry.target,
      used_by: entry.files.map((file) => ({ path: file.path, held_by: file.heldBy })),
    })),
  };
}

// ── Waiting in line ───────────────────────────────────────────────────────

// The answer to a request that is still waiting for what other tasks hold.
export interface WaitingData {
  status: "waiting";
  request_id: string;
  position: number;
  blocking: ConflictView[];
  message: string;
}

const LINE_POLL_MS = 1000;
// How long a call that picks a waiting request up again waits, unless told otherwise.
const DEFAULT_LINE_WAIT_SECONDS = 20;
// Kept under the minute after which many MCP clients give up on a tool call.
const MAX_WAIT_SECONDS = 30;

const waitMs = (seconds: number | undefined, fallback: number) => Math.min(Math.max(seconds ?? fallback, 0), MAX_WAIT_SECONDS) * 1000;

// Asks how a waiting request stands until it is granted or gone, or until the time is up.
// `fresh` is set for a request that has just joined the line: it cannot have been granted yet.
async function waitInLine(deps: ToolDeps, agent: Agent, requestId: string, forMs: number, fresh: boolean): Promise<PollResult> {
  const poll = () => deps.coordinator.pollRequest({ agentId: agent.id, requestId });
  let polled: PollResult | null = fresh && forMs > 0 ? null : await poll();
  for (let waited = 0; (polled === null || polled.status === "waiting") && waited < forMs; waited += LINE_POLL_MS) {
    await deps.sleep(LINE_POLL_MS);
    polled = await poll();
  }
  return polled!;
}

function waitingData(polled: Extract<PollResult, { status: "waiting" }>, tool: string): WaitingData {
  const place = polled.position === 1 ? "first" : `number ${polled.position}`;
  return {
    status: "waiting",
    request_id: polled.requestId,
    position: polled.position,
    blocking: polled.conflicts.map(conflictView),
    message:
      `What you asked for is held by another task. You are ${place} in line. Call ${tool} again with this request_id to keep waiting; ` +
      "a request that is not asked about for three minutes is dropped. To do other work meanwhile, call abandon with the request_id.",
  };
}

// ── start_task ────────────────────────────────────────────────────────────

export interface StartTaskInput {
  goal?: string;
  paths?: string[];
  scope?: ScopeInput[];
  ttl_minutes?: number;
  // How long to wait in line for what other tasks hold. 0, the default, is to be refused at once.
  wait_seconds?: number;
  // The request_id of an earlier call that is still waiting.
  request_id?: string;
}

export interface StartTaskData extends Standing {
  task_id: string;
  remote: string;
  token: string;
  branch: string;
  base_sha: string;
  // The paths the task may write.
  paths: string[];
  scope: ScopeEntry[];
  // How many more entries the scope has than are listed.
  scope_cut?: number;
  claim_expires_at: string;
  related: RelatedView[];
  // "ok": the check ran. "unavailable": the decision model could not be reached. "off": it is not in use.
  related_check: "ok" | "unavailable" | "off";
  clone_command: string;
  push_command: string;
}

type RelatedCheck = Pick<StartTaskData, "related" | "related_check">;

// Asks the decision model how a task relates to the other live tasks. It only ever warns:
// whatever happens here, what the task holds stands.
async function checkRelated(
  deps: ToolDeps,
  config: RepoConfig,
  task: { id: string; goal: string; paths: string[] },
  others: LiveTask[],
): Promise<RelatedCheck> {
  if (deps.decider === null || !config.decider.enabled) {
    return { related: [], related_check: "off" };
  }
  if (others.length === 0) {
    return { related: [], related_check: "ok" };
  }
  try {
    const answers = await deps.decider.relatedWork({ newTask: { goal: task.goal, paths: task.paths }, liveTasks: others });
    const recorded = await deps.coordinator.recordRelated(task.id, selectRelated(answers, config.decider.relatedMinConfidence));
    return { related: recorded.map(relatedView), related_check: "ok" };
  } catch (error) {
    await deps.coordinator.recordDeciderUnavailable({ taskId: task.id, stage: "claim", reason: message(error) });
    return { related: [], related_check: "unavailable" };
  }
}

// A call that does not ask to wait is granted or refused; only one that waits can be answered "still waiting".
export function startTask(
  deps: ToolDeps,
  agent: Agent,
  input: StartTaskInput & { goal: string; wait_seconds?: undefined; request_id?: undefined },
): Promise<ToolResult<StartTaskData>>;
export function startTask(deps: ToolDeps, agent: Agent, input: StartTaskInput): Promise<ToolResult<StartTaskData | WaitingData>>;
export async function startTask(
  deps: ToolDeps,
  agent: Agent,
  input: StartTaskInput,
): Promise<ToolResult<StartTaskData | WaitingData>> {
  const config = await deps.coordinator.getConfig();
  if (config === null) {
    return failure("not_registered", "this repository is not registered with dibs");
  }

  let polled: PollResult;
  if (input.request_id !== undefined) {
    polled = await waitInLine(deps, agent, input.request_id, waitMs(input.wait_seconds, DEFAULT_LINE_WAIT_SECONDS), false);
  } else {
    if (input.goal === undefined) {
      return failure("invalid_input", "start_task needs a goal and what the task will hold, or the request_id of a request that is waiting");
    }
    const forMs = waitMs(input.wait_seconds, 0);
    const first = await deps.coordinator.startTask({
      agentId: agent.id,
      goal: input.goal,
      ...(input.paths === undefined ? {} : { paths: input.paths }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.ttl_minutes === undefined ? {} : { ttlMinutes: input.ttl_minutes }),
      wait: forMs > 0,
    });
    if (first.ok) {
      polled = { status: "granted", task: first.task, goal: input.goal.trim(), others: first.others };
    } else if (first.waiting === undefined) {
      return refused(first);
    } else {
      polled = await waitInLine(deps, agent, first.waiting.requestId, forMs, true);
    }
  }
  if (polled.status === "waiting") {
    return { ok: true, data: waitingData(polled, "start_task") };
  }
  if (polled.status === "gone" || !("task" in polled)) {
    return failure("not_found", polled.status === "gone" ? polled.reason : "that request was for more scope; call expand_scope with it");
  }
  const granted: { task: GrantedTask; goal: string; others: LiveTask[] } = polled;
  const { task, others } = granted;

  const prepareFork = async () => {
    using main = await deps.host.open(deps.repo);
    // Another agent's start_task may be in the middle of forking the same repository.
    await whenReady(() => main.fork(task.forkName), deps.repo, deps.sleep);
    using fork = await openWhenReady(deps.host, task.forkName, deps.sleep);
    const head = await fork.head(config.defaultBranch);
    if (head === null) {
      throw new Error(`the repository has no commits on ${config.defaultBranch}`);
    }
    return {
      baseSha: head.oid,
      remote: await fork.remote(),
      token: await fork.createToken("write", FORK_TOKEN_TTL_SECONDS),
    };
  };

  // The related-work check runs alongside the fork, so it adds no waiting.
  const [forked, related] = await Promise.all([
    prepareFork().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    checkRelated(deps, config, { id: task.id, goal: granted.goal, paths: task.paths }, others),
  ]);
  if (!forked.ok) {
    await deps.coordinator.failStart(task.id, message(forked.error));
    const notReady = forked.error instanceof RepoHostError && forked.error.code === "not_ready";
    return failure(
      notReady ? "fork_not_ready" : "internal",
      `could not prepare a fork for the task: ${message(forked.error)}. The claim was released; call start_task again.`,
      true,
    );
  }
  const attached = await deps.coordinator.attachFork(task.id, forked.value.baseSha);
  if (!attached.ok) {
    return { ok: false, error: attached.error };
  }
  // Read once more: the related-work check may have connected this task with another.
  const view = await deps.coordinator.getTask({ agentId: agent.id, taskId: task.id });

  const { remote, token, baseSha } = forked.value;
  const auth = `git -c http.extraHeader="Authorization: Bearer ${token}"`;
  return {
    ok: true,
    data: {
      task_id: task.id,
      remote,
      token,
      branch: config.defaultBranch,
      base_sha: baseSha,
      paths: task.paths,
      ...shownScope(task.scope),
      claim_expires_at: iso(task.claimExpiresAt),
      ...related,
      ...(view.ok ? standing(view.task) : { collisions: [], dependents: [] }),
      clone_command: `${auth} clone ${remote}`,
      push_command: `${auth} push origin HEAD:${config.defaultBranch}`,
    },
  };
}

// ── expand_scope ──────────────────────────────────────────────────────────

export interface ExpandScopeInput {
  task_id: string;
  paths?: string[];
  scope?: ScopeInput[];
  wait_seconds?: number;
  request_id?: string;
}

export interface ExpandScopeData extends Standing, RelatedCheck {
  paths: string[];
  scope: ScopeEntry[];
  scope_cut?: number;
  claim_expires_at: string;
}

export function expandScope(
  deps: ToolDeps,
  agent: Agent,
  input: ExpandScopeInput & { wait_seconds?: undefined; request_id?: undefined },
): Promise<ToolResult<ExpandScopeData>>;
export function expandScope(deps: ToolDeps, agent: Agent, input: ExpandScopeInput): Promise<ToolResult<ExpandScopeData | WaitingData>>;
export async function expandScope(
  deps: ToolDeps,
  agent: Agent,
  input: ExpandScopeInput,
): Promise<ToolResult<ExpandScopeData | WaitingData>> {
  const config = await deps.coordinator.getConfig();
  if (config === null) {
    return failure("not_registered", "this repository is not registered with dibs");
  }

  let polled: PollResult;
  if (input.request_id !== undefined) {
    polled = await waitInLine(deps, agent, input.request_id, waitMs(input.wait_seconds, DEFAULT_LINE_WAIT_SECONDS), false);
  } else {
    const forMs = waitMs(input.wait_seconds, 0);
    const first = await deps.coordinator.expandScope({
      agentId: agent.id,
      taskId: input.task_id,
      ...(input.paths === undefined ? {} : { paths: input.paths }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      wait: forMs > 0,
    });
    if (first.ok) {
      polled = { status: "granted", paths: first.paths, scope: first.scope, claimExpiresAt: first.claimExpiresAt };
    } else if (first.waiting === undefined) {
      return refused(first);
    } else {
      polled = await waitInLine(deps, agent, first.waiting.requestId, forMs, true);
    }
  }
  if (polled.status === "waiting") {
    return { ok: true, data: waitingData(polled, "expand_scope") };
  }
  if (polled.status === "gone" || "task" in polled) {
    return failure("not_found", polled.status === "gone" ? polled.reason : "that request was for a new task; call start_task with it");
  }
  const { claimExpiresAt } = polled;

  // The task holds more now, so the decision model is asked again how it relates to the others.
  const before = await deps.coordinator.getTask({ agentId: agent.id, taskId: input.task_id });
  if (!before.ok) {
    return { ok: false, error: before.error };
  }
  const others = (await deps.coordinator.whatsHappening()).tasks.filter((other) => other.taskId !== input.task_id);
  const related = await checkRelated(deps, config, { id: input.task_id, goal: before.task.goal, paths: before.task.paths }, others);
  const view = await deps.coordinator.getTask({ agentId: agent.id, taskId: input.task_id });
  const task = view.ok ? view.task : before.task;

  return {
    ok: true,
    data: {
      paths: task.paths,
      ...shownScope(task.scope),
      claim_expires_at: iso(claimExpiresAt),
      ...related,
      ...standing(task),
    },
  };
}

// The name this had when a scope was a list of paths.
export function expandClaim(deps: ToolDeps, agent: Agent, input: { task_id: string; paths: string[] }): Promise<ToolResult<ExpandScopeData>> {
  return expandScope(deps, agent, { task_id: input.task_id, paths: input.paths });
}

export interface InterfaceChangeData extends Standing {
  scope: ScopeEntry[];
  scope_cut?: number;
}

// Says that a task will change an interface: its name, its parameters or its result. The tasks
// that use the interface are told at once, and this one is told which files use it.
export async function declareInterfaceChange(
  deps: ToolDeps,
  agent: Agent,
  input: { task_id: string; target: string },
): Promise<ToolResult<InterfaceChangeData>> {
  const parsed = parseTarget(input.target);
  if (!parsed.ok || parsed.target.kind === "path") {
    return failure("invalid_input", 'name the interface as path#name, for example "src/users.ts#findUser"');
  }
  const result = await deps.coordinator.expandScope({
    agentId: agent.id,
    taskId: input.task_id,
    scope: [{ target: input.target, relation: "change" }],
  });
  if (!result.ok) {
    return refused(result);
  }
  const view = await deps.coordinator.getTask({ agentId: agent.id, taskId: input.task_id });
  if (!view.ok) {
    return { ok: false, error: view.error };
  }
  return { ok: true, data: { ...shownScope(view.task.scope), ...standing(view.task) } };
}

// ── peek ──────────────────────────────────────────────────────────────────

export interface PeekData {
  task_id: string;
  agent: string;
  goal: string;
  state: TaskState;
  // What the other agent said of its latest submission, if it has made one.
  summary: string | null;
  head_sha: string | null;
  files: { path: string; status: Change["status"] }[];
  diff: string;
  truncated: boolean;
}

// Lets a task read the work of another task it meets, as it stands in that task's fork. It reads
// and nothing more: no token for the other fork is made or given.
export async function peek(deps: ToolDeps, agent: Agent, input: { task_id: string; other_task_id: string }): Promise<ToolResult<PeekData>> {
  const [config, info] = await Promise.all([
    deps.coordinator.getConfig(),
    deps.coordinator.peekInfo({ agentId: agent.id, taskId: input.task_id, otherTaskId: input.other_task_id }),
  ]);
  if (config === null) {
    return failure("not_registered", "this repository is not registered with dibs");
  }
  if (!info.ok) {
    return { ok: false, error: info.error };
  }
  const { other } = info;
  const data: PeekData = {
    task_id: other.taskId,
    agent: other.agent,
    goal: other.goal,
    state: other.state,
    summary: other.summary,
    head_sha: null,
    files: [],
    diff: "",
    truncated: false,
  };
  if (other.baseSha === null) {
    return { ok: true, data };
  }

  using fork = await deps.host.open(other.forkName);
  const head = await fork.head(config.defaultBranch);
  const base = await fork.readCommit(other.baseSha);
  if (head === null || base === null) {
    return { ok: true, data };
  }
  const changes = await diffTrees(fork, base.tree, head.tree);
  const diff = await buildDiff(fork, changes);
  return {
    ok: true,
    data: {
      ...data,
      head_sha: head.oid,
      files: changes.map((change) => ({ path: change.path, status: change.status })),
      diff: diff.files.map((file) => file.text ?? `(${file.path} is not shown: it is not text)\n`).join(""),
      truncated: diff.truncated,
    },
  };
}

// ── submit ────────────────────────────────────────────────────────────────

export interface SubmitInput {
  task_id: string;
  summary: string;
  // Why files that use an interface this change alters need no change.
  leaves_dependents?: string;
  // That this task is not the same work as an earlier task it was told about.
  confirm_distinct?: boolean;
}

export interface SubmitData {
  submission_id: number;
  cycle: number;
  head_sha: string;
  status: "in_review" | "escalated";
  // Other agents' tasks connected to this one, including any that started after it.
  related: RelatedView[];
  collisions: CollisionData[];
}

export async function submit(deps: ToolDeps, agent: Agent, input: SubmitInput): Promise<ToolResult<SubmitData>> {
  const [config, view] = await Promise.all([
    deps.coordinator.getConfig(),
    deps.coordinator.getTask({ agentId: agent.id, taskId: input.task_id }),
  ]);
  if (config === null) {
    return failure("not_registered", "this repository is not registered with dibs");
  }
  if (!view.ok) {
    return { ok: false, error: view.error };
  }

  const branch = config.defaultBranch;
  let headSha: string;
  let baseSha: string | null;
  {
    using fork = await deps.host.open(view.task.forkName);
    using main = await deps.host.open(deps.repo);
    const head = await fork.head(branch);
    if (head === null) {
      return failure("bad_state", `the fork has no ${branch} branch; push your work to ${branch}`);
    }
    headSha = head.oid;
    // The work is compared with the newest commit of main that the fork contains: the one it
    // started from, or a later one if the agent has merged main into its work since.
    const history = await main.log(branch, MAIN_HISTORY_DEPTH);
    baseSha = await newestMainAncestor(
      fork,
      headSha,
      history.map((commit) => commit.oid),
    );
  }
  if (baseSha === null) {
    return failure(
      "bad_state",
      `the fork's ${branch} branch does not build on the repository's ${branch} branch. Call sync_with_main, merge ${branch} into your work, push, and submit again.`,
    );
  }

  const submitted = await deps.coordinator.submit({
    agentId: agent.id,
    taskId: input.task_id,
    summary: input.summary,
    headSha,
    baseSha,
    ...(input.leaves_dependents === undefined ? {} : { leaves: input.leaves_dependents }),
    ...(input.confirm_distinct === undefined ? {} : { confirmDistinct: input.confirm_distinct }),
  });
  if (!submitted.ok) {
    return refused(submitted);
  }

  let status: SubmitData["status"] = "in_review";
  try {
    await deps.startReview({ repo: deps.repo, submissionId: submitted.submissionId });
  } catch (error) {
    // Do not leave the submission waiting for a review that never started.
    await deps.coordinator.recordVerdict(submitted.submissionId, {
      decision: "escalate",
      source: "system",
      body: { step: "start", error: message(error) },
    });
    status = "escalated";
  }
  // Read once more: a task in review stands differently towards the tasks it meets than one being worked on.
  const after = await deps.coordinator.getTask({ agentId: agent.id, taskId: input.task_id });
  return {
    ok: true,
    data: {
      submission_id: submitted.submissionId,
      cycle: submitted.cycle,
      head_sha: submitted.headSha,
      status,
      related: view.task.related.map(relatedView),
      collisions: (after.ok ? after.task : view.task).collisions.map(collisionData),
    },
  };
}

// ── sync_with_main ────────────────────────────────────────────────────────

export interface SyncData {
  remote: string;
  branch: string;
  // The head of the main branch right now.
  main_head: string;
  // Reads the main repository; it cannot push to it.
  token: string;
  sync_command: string;
}

// Lets an agent bring its fork up to date with the main branch, with a plain `git pull`.
// Nothing is recorded about the task: the next submit sees for itself what the fork contains.
export async function syncWithMain(deps: ToolDeps, agent: Agent, input: { task_id: string }): Promise<ToolResult<SyncData>> {
  const [config, view] = await Promise.all([
    deps.coordinator.getConfig(),
    deps.coordinator.getTask({ agentId: agent.id, taskId: input.task_id }),
  ]);
  if (config === null) {
    return failure("not_registered", "this repository is not registered with dibs");
  }
  if (!view.ok) {
    return { ok: false, error: view.error };
  }
  if (view.task.state !== "active" && view.task.state !== "expired") {
    return failure("bad_state", `a task can only catch up with the main branch while it is being worked on; it is ${view.task.state}`);
  }

  using main = await deps.host.open(deps.repo);
  const branch = config.defaultBranch;
  const [remote, token, head] = await Promise.all([
    main.remote(),
    main.createToken("read", MAIN_READ_TOKEN_TTL_SECONDS),
    main.head(branch),
  ]);
  if (head === null) {
    return failure("internal", `the repository has no commits on ${branch}`);
  }
  await deps.coordinator.recordCatchUp(view.task.id, head.oid);
  return {
    ok: true,
    data: {
      remote,
      branch,
      main_head: head.oid,
      token,
      sync_command: `git -c http.extraHeader="Authorization: Bearer ${token}" pull --no-rebase --no-edit ${remote} ${branch}`,
    },
  };
}

// ── get_verdict ───────────────────────────────────────────────────────────

export interface VerdictData extends Standing {
  task_id: string;
  state: TaskState;
  cycle: number;
  paths: string[];
  scope: ScopeEntry[];
  scope_cut?: number;
  claim_expires_at: string | null;
  merge_sha: string | null;
  // Other agents' tasks connected to this one, including any that started after it.
  related: RelatedView[];
  verdict: {
    decision: string;
    source: string;
    cycle: number;
    at: string;
    details: JsonObject;
  } | null;
}

const DEFAULT_VERDICT_WAIT_SECONDS = 20;
const VERDICT_POLL_MS = 1000;

// The states in which the next thing to happen is not up to the agent: a review is running, or a person is deciding.
const WAITING_STATES: TaskState[] = ["in_review", "escalated"];

// While a review is running or a person is deciding, this waits for the next change of state,
// so that an agent can call it in a loop without needing a way to pause between calls.
export async function getVerdict(
  deps: ToolDeps,
  agent: Agent,
  input: { task_id: string; wait_seconds?: number },
): Promise<ToolResult<VerdictData>> {
  const forMs = waitMs(input.wait_seconds, DEFAULT_VERDICT_WAIT_SECONDS);
  let view = await deps.coordinator.getTask({ agentId: agent.id, taskId: input.task_id });
  const initial = view.ok ? view.task.state : null;
  const unchanged = () => view.ok && view.task.state === initial && WAITING_STATES.includes(view.task.state);
  for (let waited = 0; unchanged() && waited < forMs; waited += VERDICT_POLL_MS) {
    await deps.sleep(VERDICT_POLL_MS);
    view = await deps.coordinator.getTask({ agentId: agent.id, taskId: input.task_id });
  }
  if (!view.ok) {
    return { ok: false, error: view.error };
  }
  const { task } = view;
  return {
    ok: true,
    data: {
      task_id: task.id,
      state: task.state,
      cycle: task.cycle,
      paths: task.paths,
      ...shownScope(task.scope),
      claim_expires_at: task.claimExpiresAt === null ? null : iso(task.claimExpiresAt),
      merge_sha: task.mergeSha,
      related: task.related.map(relatedView),
      ...standing(task),
      verdict:
        task.verdict === null
          ? null
          : {
              decision: task.verdict.decision,
              source: task.verdict.source,
              cycle: task.verdict.cycle,
              at: iso(task.verdict.createdAt),
              details: task.verdict.body,
            },
    },
  };
}

// ── whats_happening and abandon ───────────────────────────────────────────

export interface HappeningData {
  repository: string;
  live_tasks: {
    task_id: string;
    agent: string;
    goal: string;
    state: TaskState;
    paths: string[];
    // What the task holds, and what its agent said it relies on.
    scope: ScopeEntry[];
    started_at: string;
  }[];
  // Requests waiting in line for what the live tasks hold, in order of arrival.
  waiting: {
    request_id: string;
    agent: string;
    goal: string;
    task_id: string | null;
    scope: ScopeInput[];
    position: number;
    waiting_for: { task_id: string; agent: string }[];
    since: string;
  }[];
  recent_merges: { task_id: string; agent: string; goal: string; merge_sha: string; merged_at: string }[];
}

export async function whatsHappening(deps: ToolDeps): Promise<ToolResult<HappeningData>> {
  const { tasks, merges, waiting } = await deps.coordinator.whatsHappening();
  return {
    ok: true,
    data: {
      repository: deps.repo,
      live_tasks: tasks.map((task) => ({
        task_id: task.taskId,
        agent: task.agent,
        goal: task.goal,
        state: task.state,
        paths: task.paths,
        scope: task.scope.filter((entry) => entry.relation !== "rely" || entry.origin === "declared"),
        started_at: iso(task.startedAt),
      })),
      waiting: waiting.map((request) => ({
        request_id: request.requestId,
        agent: request.agent,
        goal: request.goal,
        task_id: request.taskId,
        scope: request.scope,
        position: request.position,
        waiting_for: request.blockedBy.map((blocker) => ({ task_id: blocker.taskId, agent: blocker.agent })),
        since: iso(request.arrivedAt),
      })),
      recent_merges: merges.map((merge) => ({
        task_id: merge.taskId,
        agent: merge.agent,
        goal: merge.goal,
        merge_sha: merge.mergeSha,
        merged_at: iso(merge.mergedAt),
      })),
    },
  };
}

// Gives up a task, or a place in the line.
export async function abandon(
  deps: ToolDeps,
  agent: Agent,
  input: { task_id?: string; request_id?: string },
): Promise<ToolResult<{ abandoned: true }>> {
  if (input.task_id === undefined && input.request_id === undefined) {
    return failure("invalid_input", "give the task_id of a task, or the request_id of a request that is waiting");
  }
  const result =
    input.task_id !== undefined
      ? await deps.coordinator.abandon({ agentId: agent.id, taskId: input.task_id })
      : await deps.coordinator.cancelRequest({ agentId: agent.id, requestId: input.request_id! });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, data: { abandoned: true } };
}
