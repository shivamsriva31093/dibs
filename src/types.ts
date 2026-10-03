// Types shared by the Coordinator, the agent tools, the review pipeline and the board.

import type { CollisionKind, CollisionRole } from "./collisions";
import type { ScopeEntry, ScopeRelation } from "./scopes";

export type { ScopeEntry, ScopeOrigin, ScopeRelation } from "./scopes";

export type TaskState = "active" | "in_review" | "escalated" | "merged" | "expired" | "abandoned" | "closed";

// A task in one of these states holds its scope.
export const LIVE_STATES: readonly TaskState[] = ["active", "in_review", "escalated"];

export type ErrorCode =
  | "conflict"
  | "not_found"
  | "not_owner"
  | "bad_state"
  | "invalid_path"
  | "invalid_input"
  | "already_exists"
  | "fork_not_ready"
  | "nothing_to_submit"
  | "duplicate"
  | "not_registered"
  | "internal";

export interface DibsError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface Failure {
  ok: false;
  error: DibsError;
}

// The thresholds were set from the model's answers on ten cases (2026-10-02). They are a starting point.
export interface DeciderConfig {
  enabled: boolean;
  // A related task is reported when the model gives its relation at least this probability.
  relatedMinConfidence: number;
  // A change goes to a person when the model's probability that it is high risk reaches this.
  riskHighMin: number;
  // A change goes to a person when the probability that it changes an interface reaches this.
  interfaceChangeMin: number;
}

export interface RepoConfig {
  repoName: string;
  defaultBranch: string;
  protectedPaths: string[];
  claimTtlMinutes: number;
  maxCycles: number;
  decider: DeciderConfig;
}

export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  ".dibs/",
  ".github/",
  "wrangler.jsonc",
  "wrangler.toml",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  ".env",
  "migrations/",
];

export const DEFAULT_DECIDER_CONFIG: DeciderConfig = {
  enabled: true,
  relatedMinConfidence: 0.5,
  riskHighMin: 0.3,
  interfaceChangeMin: 0.6,
};

export const DEFAULT_CLAIM_TTL_MINUTES = 120;
export const MAX_CLAIM_TTL_MINUTES = 480;
export const DEFAULT_MAX_CYCLES = 3;

export interface Agent {
  id: string;
  name: string;
}

// One thing an agent asks to hold, as it writes it.
export interface ScopeInput {
  target: string;
  relation: string;
}

// Another task that holds what a request asks for.
export interface Conflict {
  taskId: string;
  agent: string;
  goal: string;
  state: TaskState;
  // What the blocking task holds that the request cannot have.
  paths: string[];
  // The same, with how each is held.
  held: { target: string; relation: ScopeRelation }[];
  startedAt: number;
  // Null while the task is in review or escalated: its scope does not expire then.
  claimExpiresAt: number | null;
}

export interface LiveTask {
  taskId: string;
  agent: string;
  goal: string;
  state: TaskState;
  // The paths the task may write.
  paths: string[];
  scope: ScopeEntry[];
  startedAt: number;
}

// A request that is waiting in line for what other tasks hold.
export interface WaitingView {
  requestId: string;
  agent: string;
  goal: string;
  // The task whose scope is to grow, or null for a task that has yet to start.
  taskId: string | null;
  scope: ScopeInput[];
  arrivedAt: number;
  // 1 for the request that is served first among those that want the same things.
  position: number;
  blockedBy: { taskId: string; agent: string }[];
}

// Two tasks whose work meets, as one of them sees it.
export interface CollisionView {
  id: string;
  kind: CollisionKind;
  state: "possible" | "open";
  // The part this task has in it.
  role: CollisionRole;
  with: { taskId: string; agent: string; goal: string; state: TaskState; mergeSha: string | null };
  targets: string[];
  // Which task is expected to land first, by the name of its agent.
  order: { first: string; why: string } | null;
  // What this task should do about it.
  brief: string;
}

export type Relation = "duplicate" | "coupled";

export interface RelatedTask {
  taskId: string;
  agent: string;
  goal: string;
  state: TaskState;
  paths: string[];
  relation: Relation;
  confidence: number;
}

// What a review found about the interfaces a submission touches. The review reads the fork;
// the Coordinator holds this against the index of the main branch.
export interface InterfaceReport {
  // Every path the submission changes.
  changedPaths: string[];
  // The interfaces of the changed files that are added, removed, or given another signature.
  changed: {
    path: string;
    name: string;
    kind: string;
    change: "added" | "removed" | "changed";
    before?: string;
    after?: string;
  }[];
  // What the submission is built on outside the files it changes, each with the hash it had
  // where the submission branched off the main branch. Null: it was not there.
  relied: { target: string; hash: string | null }[];
}

// How a submission stands against the main branch as it is now. Any entry in `moved` or `held`,
// or in `unupdated` without `leaves`, means the submission would break the main branch if it landed.
export interface ContractReport {
  // Whether the index can speak for this change: it has read the repository, and the change
  // touches files it can read. When it cannot, the lists below are empty because nothing is known.
  indexed: boolean;
  // Interfaces the submission relies on that are no longer what they were when it branched off.
  moved: { target: string; now: string | null; since: string | null; by: string | null }[];
  // Interfaces the submission alters that files on the main branch use, where the submission does not change those files.
  unupdated: { target: string; change: "changed" | "removed"; files: { path: string; heldBy: string | null }[] }[];
  // Interfaces the submission alters in a file it shares, while another task holds them.
  held: { target: string; by: string; taskId: string }[];
  // The agent's own word on why the files in `unupdated` need no change. A person decides whether it holds.
  leaves: string | null;
}

// The decision model's answers about one submission. The keys are the question
// ids sent to the model and the names used in the stored verdict.
export type Triage = {
  model: string;
  // `confidence` is the model's own measure of how concentrated its answer is, not the probability of the answer.
  goal_fit: { score: number; confidence: number };
  // `high` is the probability the model gives to the highest level of risk.
  risk: { score: number; confidence: number; high: number };
  unrelated_changes: number;
  interface_change: number;
  leftovers: number;
};

// A free-form JSON object, as stored in event and verdict bodies. Its values are
// deliberately opaque (`{} | null` is "anything but undefined"): a recursive JSON
// type cannot pass through the Workers RPC type mapping, which recurses without bound on it.
export type JsonObject = { [key: string]: {} | null };

export interface DibsEvent {
  id: number;
  type: string;
  taskId: string | null;
  agentId: string | null;
  body: JsonObject;
  createdAt: number;
}

// ── What the Coordinator reports to agents and to the board ────────────────

export type VerdictDecision = "approve" | "reject" | "escalate";
// Who reached the verdict: a mechanical check, the reviewer model, the merge step, a person, or dibs itself after an error.
export type VerdictSource = "check" | "gate" | "reviewer" | "merge" | "human" | "system";

export interface VerdictInput {
  decision: VerdictDecision;
  source: VerdictSource;
  body: JsonObject;
}

export interface VerdictView extends VerdictInput {
  submissionId: number;
  cycle: number;
  createdAt: number;
}

export interface TaskView {
  id: string;
  agentId: string;
  agent: string;
  goal: string;
  state: TaskState;
  cycle: number;
  forkName: string;
  baseSha: string | null;
  // The paths the task may write.
  paths: string[];
  scope: ScopeEntry[];
  // Other tasks whose work meets this one's, with what to do about each.
  collisions: CollisionView[];
  // For each interface the task changes: the files of the main branch that use it and are not the task's to write.
  dependents: { target: string; files: { path: string; heldBy: string | null }[] }[];
  // Null unless the task is active: a scope does not expire in review, and is gone afterwards.
  claimExpiresAt: number | null;
  mergeSha: string | null;
  verdict: VerdictView | null;
  // Tasks the decision model connected with this one, whichever of the two started first.
  related: RelatedTask[];
  createdAt: number;
  updatedAt: number;
}

export interface SubmissionView {
  id: number;
  taskId: string;
  cycle: number;
  headSha: string;
  summary: string;
  triage: Triage | null;
}

export interface RecentMerge {
  taskId: string;
  agent: string;
  goal: string;
  mergeSha: string;
  mergedAt: number;
}

export interface BoardTask extends TaskView {
  submission: SubmissionView | null;
}

export interface Snapshot {
  config: RepoConfig;
  agents: Agent[];
  // Live tasks, oldest first, then the most recently finished ones.
  tasks: BoardTask[];
  events: DibsEvent[];
  shadow: { reviewed: number; agreed: number };
  // Requests waiting in line, in order of arrival.
  waiting: WaitingView[];
  // How much the interface index holds.
  index: { files: number; interfaces: number; references: number };
}

