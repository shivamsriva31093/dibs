// The Coordinator: one Durable Object per repository. It owns every piece of
// coordination state (agents, tasks, scopes, the interface index, submissions,
// verdicts, events) and is the only place a scope is granted. A Durable Object
// runs one call at a time and the grant makes no awaits between its check and its
// insert, so two agents can never both be given what only one may hold.

import { DurableObject } from "cloudflare:workers";
import { describeCollision, type CollisionKind, type CollisionRole, type CollisionState, type Party } from "./collisions";
import { rejectOrEscalate } from "./checks";
import { contractsBroken, describeContract } from "./contracts";
import { gateSummary, type GateResult } from "./gate";
import { isOid } from "./git/objects";
import type { StalePath } from "./git/overlay";
import { newApiKey, newId, sha256Hex } from "./ids";
import { isIndexable } from "./index/extract";
import type { IndexedFile } from "./index/file";
import { IndexStore } from "./index/store";
import {
  normalizeScope,
  parseTarget,
  relate,
  scopeFromPaths,
  sortScope,
  targetPath,
  targetsOverlap,
  targetText,
  writablePaths,
  type ScopeEntry,
  type ScopeOrigin,
  type ScopeRelation,
  type Target,
} from "./scopes";
import {
  DEFAULT_CLAIM_TTL_MINUTES,
  DEFAULT_DECIDER_CONFIG,
  DEFAULT_MAX_CYCLES,
  DEFAULT_PROTECTED_PATHS,
  LIVE_STATES,
  MAX_CLAIM_TTL_MINUTES,
  type Agent,
  type CollisionView,
  type Conflict,
  type ContractReport,
  type DeciderConfig,
  type DibsEvent,
  type ErrorCode,
  type Failure,
  type InterfaceReport,
  type JsonObject,
  type LiveTask,
  type RelatedTask,
  type Relation,
  type RepoConfig,
  type ScopeInput,
  type BoardTask,
  type RecentMerge,
  type Snapshot,
  type SubmissionView,
  type TaskState,
  type TaskView,
  type Triage,
  type VerdictInput,
  type VerdictView,
  type WaitingView,
} from "./types";

export type {
  BoardTask,
  RecentMerge,
  Snapshot,
  SubmissionView,
  TaskView,
  VerdictDecision,
  VerdictInput,
  VerdictSource,
  VerdictView,
} from "./types";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    key_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    goal TEXT NOT NULL,
    state TEXT NOT NULL,
    fork_name TEXT NOT NULL,
    base_sha TEXT,
    cycle INTEGER NOT NULL DEFAULT 1,
    claim_ttl_ms INTEGER NOT NULL,
    claim_expires_at INTEGER NOT NULL,
    merge_sha TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX tasks_by_state ON tasks(state);

  CREATE TABLE claims (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    path TEXT NOT NULL,
    PRIMARY KEY (task_id, path)
  );

  CREATE TABLE related (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    other_task_id TEXT NOT NULL REFERENCES tasks(id),
    relation TEXT NOT NULL,
    confidence REAL NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, other_task_id)
  );

  CREATE TABLE submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    cycle INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    summary TEXT NOT NULL,
    triage TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE verdicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL REFERENCES submissions(id),
    decision TEXT NOT NULL,
    source TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    task_id TEXT,
    agent_id TEXT,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // Scopes take the place of claims: a claimed path becomes a path the task holds to change.
  `
  CREATE TABLE scopes (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    target TEXT NOT NULL,
    relation TEXT NOT NULL,
    origin TEXT NOT NULL,
    note TEXT,
    PRIMARY KEY (task_id, target, relation)
  );
  INSERT INTO scopes (task_id, target, relation, origin) SELECT task_id, path, 'change', 'declared' FROM claims;
  DROP TABLE claims;

  CREATE TABLE waiting (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    task_id TEXT REFERENCES tasks(id),
    goal TEXT NOT NULL,
    scope TEXT NOT NULL,
    ttl_ms INTEGER NOT NULL,
    arrived_at INTEGER NOT NULL,
    seen_at INTEGER NOT NULL,
    granted_task_id TEXT,
    granted_at INTEGER
  );

  CREATE TABLE interfaces (
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    signature TEXT NOT NULL,
    hash TEXT NOT NULL,
    origin_path TEXT,
    origin_name TEXT,
    since_sha TEXT NOT NULL,
    PRIMARY KEY (path, name)
  );
  CREATE TABLE refs_to (
    path TEXT NOT NULL,
    target_path TEXT NOT NULL,
    target_name TEXT NOT NULL,
    via TEXT NOT NULL,
    PRIMARY KEY (path, target_path, target_name, via)
  );
  CREATE INDEX refs_by_target ON refs_to(target_path, target_name);
  CREATE TABLE indexed_files (
    path TEXT PRIMARY KEY,
    digest TEXT NOT NULL,
    sha TEXT NOT NULL
  );

  CREATE TABLE collisions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    provider_task_id TEXT NOT NULL REFERENCES tasks(id),
    relier_task_id TEXT NOT NULL REFERENCES tasks(id),
    state TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (kind, target, provider_task_id, relier_task_id)
  );

  ALTER TABLE submissions ADD COLUMN interfaces TEXT;
  ALTER TABLE submissions ADD COLUMN leaves TEXT;
  ALTER TABLE tasks ADD COLUMN confirmed_distinct INTEGER NOT NULL DEFAULT 0;
  `,
  // What the repository's checks said about the submission, the last time they ran on it.
  `
  ALTER TABLE submissions ADD COLUMN gate TEXT;
  `,
];

// The name the board gives its live connection.
const SOCKET_SUBPROTOCOL = "dibs";
const MAX_PATHS_PER_REQUEST = 100;
// The most a task's whole scope may hold, with what dibs adds to it.
const MAX_SCOPE_ENTRIES = 1000;
// The most interfaces dibs adds to a scope as relied on, from what the task's files use.
const MAX_INFERRED = 200;
const MAX_GOAL_LENGTH = 2000;
const MAX_OTHERS = 64;
const AGENT_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const MINUTE_MS = 60_000;
// A waiting request is dropped when its agent has not asked about it for this long.
const WAIT_ALIVE_MS = 3 * MINUTE_MS;
// A task that was granted from the line holds its scope this long without a fork, then gives it up.
const PICKUP_MS = 3 * MINUTE_MS;
const GONE =
  "this request is no longer waiting: it was not asked about for three minutes, or it has been answered. Make the request again.";

type WaitingRow = {
  id: string;
  agent_id: string;
  task_id: string | null;
  goal: string;
  scope: string;
  ttl_ms: number;
  arrived_at: number;
  seen_at: number;
  granted_task_id: string | null;
  granted_at: number | null;
};

type AgentRow = { id: string; name: string };

type TaskRow = {
  id: string;
  agent_id: string;
  goal: string;
  state: string;
  fork_name: string;
  base_sha: string | null;
  cycle: number;
  claim_ttl_ms: number;
  claim_expires_at: number;
  merge_sha: string | null;
  confirmed_distinct: number;
  created_at: number;
  updated_at: number;
};

type CollisionRow = {
  id: string;
  kind: string;
  target: string;
  provider_task_id: string;
  relier_task_id: string;
  state: string;
};

type LiveScopeRow = {
  task_id: string;
  target: string;
  relation: string;
  origin: string;
  agent_name: string;
  goal: string;
  state: string;
  created_at: number;
  claim_expires_at: number;
};

export interface StartTaskRequest {
  agentId: string;
  goal: string;
  // Paths the task will change. The short way to write a scope.
  paths?: string[];
  // What the task will change, add to and rely on.
  scope?: ScopeInput[];
  ttlMinutes?: number;
  // Wait in line for what other tasks hold, and do not be refused.
  wait?: boolean;
}

// A place in the line of requests that wait for what other tasks hold.
export interface WaitingTicket {
  requestId: string;
  position: number;
}

// What a waiting request is told when it asks how it stands.
export type PollResult =
  | { status: "waiting"; requestId: string; position: number; conflicts: Conflict[] }
  // A task that was waiting to start.
  | { status: "granted"; task: GrantedTask; goal: string; others: LiveTask[] }
  // A task that was waiting for more scope.
  | { status: "granted"; paths: string[]; scope: ScopeEntry[]; claimExpiresAt: number }
  | { status: "gone"; reason: string };

export interface GrantedTask {
  id: string;
  forkName: string;
  // The paths the task may write.
  paths: string[];
  scope: ScopeEntry[];
  claimExpiresAt: number;
}

export type StartTaskResult =
  | { ok: true; task: GrantedTask; others: LiveTask[] }
  | (Failure & { conflicts?: Conflict[]; waiting?: WaitingTicket });

export type CreateAgentResult = { ok: true; agent: Agent; key: string } | Failure;

export interface ExpandScopeRequest {
  agentId: string;
  taskId: string;
  paths?: string[];
  scope?: ScopeInput[];
  wait?: boolean;
}

export type ExpandScopeResult =
  | { ok: true; paths: string[]; scope: ScopeEntry[]; claimExpiresAt: number }
  | (Failure & { conflicts?: Conflict[]; waiting?: WaitingTicket });

export interface SubmitRequest {
  agentId: string;
  taskId: string;
  summary: string;
  headSha: string;
  // The newest commit of the main branch that the fork contains. It differs from the commit
  // the fork started at once the agent has brought its fork up to date with main.
  baseSha?: string;
  // Why files that use an interface this submission alters need no change. A person decides whether it holds.
  leaves?: string;
  // The agent's word that this task is not the same work as an earlier task it was told about.
  confirmDistinct?: boolean;
}

export type SubmitResult =
  | { ok: true; submissionId: number; cycle: number; headSha: string }
  | (Failure & { conflicts?: Conflict[] });

export type RecordVerdictResult = { ok: true; state: TaskState; cycle: number } | Failure;

export interface EscalationDecision {
  taskId: string;
  decision: "approve" | "send_back" | "close";
  note?: string;
}

export type EscalationResult = { ok: true; state: TaskState; submissionId: number } | Failure;

type SubmissionRow = {
  id: number;
  task_id: string;
  cycle: number;
  head_sha: string;
  summary: string;
  triage: string | null;
  interfaces: string | null;
  leaves: string | null;
  gate: string | null;
  created_at: number;
};

type VerdictRow = {
  id: number;
  submission_id: number;
  cycle: number;
  decision: string;
  source: string;
  body: string;
  created_at: number;
};

interface MergeLock {
  taskId: string;
  expiresAt: number;
}

export interface SubmissionContext {
  submission: SubmissionView;
  task: {
    id: string;
    agentId: string;
    agent: string;
    goal: string;
    state: TaskState;
    cycle: number;
    forkName: string;
    baseSha: string;
  };
  // The paths the task may write.
  claim: string[];
  scope: ScopeEntry[];
  related: RelatedTask[];
  // Other tasks whose work meets this one's.
  collisions: CollisionView[];
  // What the review found about the interfaces the submission touches, once it has looked.
  interfaces: InterfaceReport | null;
  // The agent's word on why files that use an interface it alters need no change.
  leaves: string | null;
  // What the repository's checks said about the submission, the last time they ran on it.
  gate: GateResult | null;
  // Every verdict recorded on this submission, oldest first.
  verdicts: VerdictView[];
  // The verdict that sent the task's previous attempt back, or null on a first attempt.
  previous: VerdictView | null;
  config: RepoConfig;
}

const RECENT_MERGES = 10;
const FINISHED_TASKS_ON_BOARD = 30;

function submissionView(row: SubmissionRow): SubmissionView {
  return {
    id: row.id,
    taskId: row.task_id,
    cycle: row.cycle,
    headSha: row.head_sha,
    summary: row.summary,
    triage: row.triage === null ? null : (JSON.parse(row.triage) as Triage),
  };
}

const MERGE_LOCK_MS = 2 * 60_000;
const MAX_MERGE_LOCK_MS = 20 * 60_000;
const MAX_SUMMARY_LENGTH = 4000;

type Asked = { target: Target; relation: ScopeRelation };

function asked(entry: { target: string; relation: string }): Asked | null {
  const parsed = parseTarget(entry.target);
  return parsed.ok ? { target: parsed.target, relation: entry.relation as ScopeRelation } : null;
}

// "2 paths are held by other tasks": how much of a request cannot be had, and from how many tasks.
function conflictMessage(requested: ScopeEntry[], conflicts: Conflict[]): string {
  const held = conflicts.flatMap((conflict) => conflict.held.flatMap((entry) => asked(entry) ?? []));
  const blocked = requested.flatMap((entry) => {
    const wanted = asked(entry);
    return wanted !== null && held.some((other) => relate(wanted, other) === "conflict") ? [wanted] : [];
  });
  const noun = blocked.every((entry) => entry.target.kind === "path") ? "path" : "target";
  return `${blocked.length} ${blocked.length === 1 ? `${noun} is` : `${noun}s are`} held by ${conflicts.length === 1 ? "another task" : "other tasks"}`;
}

// Validates what a request asks to hold. Paths given the short way are paths to change.
function readScope(
  request: { paths?: string[]; scope?: ScopeInput[] },
  maxEntries = MAX_PATHS_PER_REQUEST,
): { ok: true; entries: ScopeEntry[] } | Failure {
  const entries = [...scopeFromPaths(request.paths ?? []), ...(request.scope ?? [])];
  const normalized = normalizeScope(
    entries.map((entry) => ({ target: String(entry.target), relation: String(entry.relation) })),
    { maxEntries },
  );
  if (!normalized.ok) {
    return fail(normalized.reason.startsWith("invalid target") ? "invalid_path" : "invalid_input", normalized.reason);
  }
  return normalized;
}

function fail(code: ErrorCode, message: string, retryable = false): Failure {
  return { ok: false, error: { code, message, retryable } };
}

export class Coordinator extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly index: IndexStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.index = new IndexStore(this.sql);
    void ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const applied = this.sql.exec<{ version: number }>("SELECT COALESCE(MAX(id), 0) AS version FROM _migrations").one()
      .version;
    for (let index = applied; index < MIGRATIONS.length; index++) {
      this.sql.exec(MIGRATIONS[index]!);
      this.sql.exec("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)", index + 1, Date.now());
    }
  }

  // ── Registration ──────────────────────────────────────────────────────────

  async init(config: Partial<RepoConfig> & { repoName: string }): Promise<RepoConfig> {
    const full: RepoConfig = {
      repoName: config.repoName,
      defaultBranch: config.defaultBranch ?? "main",
      protectedPaths: config.protectedPaths ?? [...DEFAULT_PROTECTED_PATHS],
      claimTtlMinutes: config.claimTtlMinutes ?? DEFAULT_CLAIM_TTL_MINUTES,
      maxCycles: config.maxCycles ?? DEFAULT_MAX_CYCLES,
      decider: { ...DEFAULT_DECIDER_CONFIG, ...config.decider },
    };
    this.sql.exec(
      "INSERT INTO config (key, value) VALUES ('repo', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(full),
    );
    return full;
  }

  async getConfig(): Promise<RepoConfig | null> {
    return this.config();
  }

  private config(): RepoConfig | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM config WHERE key = 'repo'").toArray()[0];
    if (row === undefined) {
      return null;
    }
    // A repository registered by an earlier version may lack a threshold that was added since.
    const stored = JSON.parse(row.value) as RepoConfig & { decider: Partial<DeciderConfig> };
    const decider = stored.decider;
    return {
      ...stored,
      decider: {
        enabled: decider.enabled ?? DEFAULT_DECIDER_CONFIG.enabled,
        relatedMinConfidence: decider.relatedMinConfidence ?? DEFAULT_DECIDER_CONFIG.relatedMinConfidence,
        riskHighMin: decider.riskHighMin ?? DEFAULT_DECIDER_CONFIG.riskHighMin,
        interfaceChangeMin: decider.interfaceChangeMin ?? DEFAULT_DECIDER_CONFIG.interfaceChangeMin,
      },
    };
  }

  // ── Agents ────────────────────────────────────────────────────────────────

  async createAgent(name: string): Promise<CreateAgentResult> {
    if (!AGENT_NAME.test(name)) {
      return fail("invalid_input", "agent name must be 1 to 64 letters, digits, dots, underscores or hyphens");
    }
    const key = newApiKey();
    // Hash before touching storage, so the check and the insert below run without an await between them.
    const keyHash = await sha256Hex(key);

    const taken = this.sql.exec("SELECT 1 FROM agents WHERE name = ?", name).toArray().length > 0;
    if (taken) {
      return fail("already_exists", `an agent named ${name} already exists`);
    }
    const agent: Agent = { id: newId("a"), name };
    this.sql.exec(
      "INSERT INTO agents (id, name, key_hash, created_at) VALUES (?, ?, ?, ?)",
      agent.id,
      agent.name,
      keyHash,
      Date.now(),
    );
    return { ok: true, agent, key };
  }

  async authenticate(key: string): Promise<Agent | null> {
    const keyHash = await sha256Hex(key);
    return this.sql.exec<AgentRow>("SELECT id, name FROM agents WHERE key_hash = ?", keyHash).toArray()[0] ?? null;
  }

  private agentById(id: string): Agent | null {
    return this.sql.exec<AgentRow>("SELECT id, name FROM agents WHERE id = ?", id).toArray()[0] ?? null;
  }

  // ── The interface index ───────────────────────────────────────────────────

  // Puts files in the index as they are at `sha`. With `reset`, what the index held before is forgotten first.
  async indexFiles(update: {
    files: IndexedFile[];
    removed: string[];
    sha: string;
    reset?: boolean;
  }): Promise<{ files: number; interfaces: number; references: number }> {
    if (update.reset) {
      this.index.clear();
    }
    this.index.replace(update.files, update.removed, update.sha);
    return this.index.status();
  }

  // ── Scopes ────────────────────────────────────────────────────────────────

  async startTask(request: StartTaskRequest): Promise<StartTaskResult> {
    const config = this.config();
    if (config === null) {
      return fail("not_registered", "this repository is not registered with dibs");
    }
    const now = Date.now();
    this.tick(now);

    const agent = this.agentById(request.agentId);
    if (agent === null) {
      return fail("not_found", `agent ${request.agentId} is not known`);
    }
    const goal = request.goal.trim();
    if (goal === "" || goal.length > MAX_GOAL_LENGTH) {
      return fail("invalid_input", `goal must be between 1 and ${MAX_GOAL_LENGTH} characters`);
    }
    const scope = readScope(request);
    if (!scope.ok) {
      return scope;
    }

    const ttlMinutes = Math.min(Math.max(request.ttlMinutes ?? config.claimTtlMinutes, 1), MAX_CLAIM_TTL_MINUTES);
    const ttlMs = ttlMinutes * MINUTE_MS;

    const conflicts = this.blockers(scope.entries, null);
    if (conflicts.length > 0) {
      this.emitRefusal(now, null, agent, goal, scope.entries, conflicts);
      const refusal = { ...fail("conflict", conflictMessage(scope.entries, conflicts), true), conflicts };
      if (!request.wait) {
        return refusal;
      }
      const waiting = this.enqueue(agent, null, goal, scope.entries, ttlMs, now, conflicts);
      await this.scheduleAlarm();
      return { ...refusal, waiting };
    }

    const others = this.liveTasks(MAX_OTHERS);
    const task = this.createTask(config, agent, goal, scope.entries, ttlMs, now, now + ttlMs);
    await this.scheduleAlarm();
    return { ok: true, task, others };
  }

  // `claimExpiresAt` is sooner than the lifetime for a task granted from the line: it has
  // to be picked up by its agent before it gets its whole lifetime.
  private createTask(
    config: RepoConfig,
    agent: Agent,
    goal: string,
    entries: ScopeEntry[],
    ttlMs: number,
    now: number,
    claimExpiresAt: number,
  ): GrantedTask {
    const id = newId("t");
    const forkName = `${config.repoName}--${id}`;
    this.sql.exec(
      `INSERT INTO tasks (id, agent_id, goal, state, fork_name, cycle, claim_ttl_ms, claim_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, 1, ?, ?, ?, ?)`,
      id,
      agent.id,
      goal,
      forkName,
      ttlMs,
      claimExpiresAt,
      now,
      now,
    );
    this.writeScope(id, entries);
    this.inferReliance(id);
    const scope = this.scopeOf(id);
    const paths = writablePaths(scope);
    this.emit(now, "task_started", id, agent.id, { agent: agent.name, goal, paths, scope, claimExpiresAt });
    this.linkTask(id, now);
    return { id, forkName, paths, scope, claimExpiresAt };
  }

  private emitRefusal(now: number, taskId: string | null, agent: Agent, goal: string, requested: ScopeEntry[], conflicts: Conflict[]): void {
    this.emit(now, "claim_conflict", taskId, agent.id, {
      agent: agent.name,
      goal,
      paths: requested.map((entry) => entry.target),
      blockedBy: conflicts.map((conflict) => ({ taskId: conflict.taskId, agent: conflict.agent, paths: conflict.paths })),
    });
  }

  // Live tasks, other than `exceptTaskId`, that hold something the entries cannot be held alongside.
  private blockers(entries: ScopeEntry[], exceptTaskId: string | null): Conflict[] {
    const wanted = entries.flatMap((entry) => asked(entry) ?? []);
    const byTask = new Map<string, Conflict>();
    for (const row of this.liveScopeRows()) {
      const held = asked(row);
      if (row.task_id === exceptTaskId || held === null || !wanted.some((entry) => relate(entry, held) === "conflict")) {
        continue;
      }
      let conflict = byTask.get(row.task_id);
      if (conflict === undefined) {
        const state = row.state as TaskState;
        conflict = {
          taskId: row.task_id,
          agent: row.agent_name,
          goal: row.goal,
          state,
          paths: [],
          held: [],
          startedAt: row.created_at,
          claimExpiresAt: state === "active" ? row.claim_expires_at : null,
        };
        byTask.set(row.task_id, conflict);
      }
      if (!conflict.paths.includes(row.target)) {
        conflict.paths.push(row.target);
      }
      conflict.held.push({ target: row.target, relation: held.relation });
    }
    return [...byTask.values()];
  }

  private liveScopeRows(): LiveScopeRow[] {
    return this.sql
      .exec<LiveScopeRow>(
        `SELECT scopes.task_id, scopes.target, scopes.relation, scopes.origin, agents.name AS agent_name, tasks.goal,
                tasks.state, tasks.created_at, tasks.claim_expires_at
           FROM scopes
           JOIN tasks ON tasks.id = scopes.task_id
           JOIN agents ON agents.id = tasks.agent_id
          WHERE tasks.state IN (${LIVE_STATES.map((state) => `'${state}'`).join(", ")})
          ORDER BY tasks.created_at, tasks.rowid, scopes.target`,
      )
      .toArray();
  }

  // The most recently started live tasks, oldest first.
  private liveTasks(limit: number): LiveTask[] {
    const byTask = new Map<string, LiveTask>();
    for (const row of this.liveScopeRows()) {
      let task = byTask.get(row.task_id);
      if (task === undefined) {
        task = {
          taskId: row.task_id,
          agent: row.agent_name,
          goal: row.goal,
          state: row.state as TaskState,
          paths: [],
          scope: [],
          startedAt: row.created_at,
        };
        byTask.set(row.task_id, task);
      }
      task.scope.push({ target: row.target, relation: row.relation as ScopeRelation, origin: row.origin as ScopeOrigin });
    }
    const tasks = [...byTask.values()].slice(-limit);
    for (const task of tasks) {
      task.scope = sortScope(task.scope);
      task.paths = writablePaths(task.scope);
    }
    return tasks;
  }

  private scopeOf(taskId: string): ScopeEntry[] {
    return sortScope(
      this.sql
        .exec<{ target: string; relation: string; origin: string }>("SELECT target, relation, origin FROM scopes WHERE task_id = ?", taskId)
        .toArray()
        .map((row) => ({ target: row.target, relation: row.relation as ScopeRelation, origin: row.origin as ScopeOrigin })),
    );
  }

  private writeScope(taskId: string, entries: ScopeEntry[]): void {
    this.sql.exec("DELETE FROM scopes WHERE task_id = ?", taskId);
    for (const entry of entries) {
      this.sql.exec(
        "INSERT INTO scopes (task_id, target, relation, origin) VALUES (?, ?, ?, ?)",
        taskId,
        entry.target,
        entry.relation,
        entry.origin,
      );
    }
  }

  // Adds to a task's scope what its files use of other files, as the index knows it. An agent
  // seldom lists everything its code is built on; this is what lets dibs tell it when one of
  // those things is about to change.
  private inferReliance(taskId: string): void {
    this.sql.exec("DELETE FROM scopes WHERE task_id = ? AND relation = 'rely' AND origin = 'inferred'", taskId);
    const scope = this.scopeOf(taskId);
    const relied = new Set(scope.filter((entry) => entry.relation === "rely").map((entry) => entry.target));
    for (const used of this.index.usedBy(writablePaths(scope)).slice(0, MAX_INFERRED)) {
      const target = used.name === "*" ? used.path : `${used.path}#${used.name}`;
      if (relied.has(target) || !parseTarget(target).ok) {
        continue;
      }
      this.sql.exec(
        "INSERT INTO scopes (task_id, target, relation, origin) VALUES (?, ?, 'rely', 'inferred') ON CONFLICT DO NOTHING",
        taskId,
        target,
      );
    }
  }

  // ── Collisions ────────────────────────────────────────────────────────────
  //
  // A collision records that two live tasks meet: one changes what the other
  // relies on, or both do the same work. It decides nothing. What keeps the
  // main branch whole is `contracts`, checked when a change is about to land.

  // Records every place where a task changes what another live task relies on, or the other way round.
  private linkTask(taskId: string, now: number): void {
    const mine = this.scopeOf(taskId).flatMap((entry) => asked(entry) ?? []);
    for (const row of this.liveScopeRows()) {
      const theirs = asked(row);
      if (row.task_id === taskId || theirs === null) {
        continue;
      }
      for (const own of mine) {
        if (relate(own, theirs) !== "link") {
          continue;
        }
        const [provider, relier] = own.relation === "change" ? [own, theirs] : [theirs, own];
        // The collision is about the narrower of the two: the interface, when either side names one.
        const about =
          relier.target.kind !== "path" || provider.target.kind === "path"
            ? relier.target.kind === "path" && provider.target.kind === "path" && provider.target.path.startsWith(relier.target.path)
              ? provider.target
              : relier.target
            : provider.target;
        this.recordCollision(
          "contract",
          targetText(about),
          own.relation === "change" ? taskId : row.task_id,
          own.relation === "change" ? row.task_id : taskId,
          // A task that holds a whole file has not said that it will change this part of it.
          provider.target.kind === "path" ? "possible" : "open",
          taskId,
          now,
        );
      }
    }
  }

  private recordCollision(
    kind: CollisionKind,
    target: string,
    providerId: string,
    relierId: string,
    state: Exclude<CollisionState, "resolved">,
    forTaskId: string,
    now: number,
  ): void {
    const existing = this.sql
      .exec<{ id: string; state: string }>(
        "SELECT id, state FROM collisions WHERE kind = ? AND target = ? AND provider_task_id = ? AND relier_task_id = ?",
        kind,
        target,
        providerId,
        relierId,
      )
      .toArray()[0];
    let id: string;
    if (existing === undefined) {
      id = newId("c");
      this.sql.exec(
        `INSERT INTO collisions (id, kind, target, provider_task_id, relier_task_id, state, detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
        id,
        kind,
        target,
        providerId,
        relierId,
        state,
        now,
        now,
      );
    } else if (existing.state === "resolved" || (existing.state === "possible" && state === "open")) {
      id = existing.id;
      this.sql.exec("UPDATE collisions SET state = ?, detail = '{}', updated_at = ? WHERE id = ?", state, now, id);
    } else {
      return;
    }
    const provider = this.taskRow(providerId)!;
    const relier = this.taskRow(relierId)!;
    this.emit(now, "collision", forTaskId, this.taskRow(forTaskId)!.agent_id, {
      id,
      kind,
      state,
      target,
      provider: { taskId: providerId, agent: this.agentById(provider.agent_id)!.name },
      relier: { taskId: relierId, agent: this.agentById(relier.agent_id)!.name },
    });
  }

  private resolveCollision(row: CollisionRow, how: string, now: number): void {
    this.sql.exec(
      "UPDATE collisions SET state = 'resolved', detail = ?, updated_at = ? WHERE id = ?",
      JSON.stringify({ how }),
      now,
      row.id,
    );
    this.emit(now, "collision_resolved", null, null, { id: row.id, kind: row.kind, target: row.target, how });
  }

  private openCollisions(taskId: string): CollisionRow[] {
    return this.sql
      .exec<CollisionRow>(
        `SELECT id, kind, target, provider_task_id, relier_task_id, state FROM collisions
          WHERE state != 'resolved' AND (provider_task_id = ? OR relier_task_id = ?) ORDER BY created_at, rowid`,
        taskId,
        taskId,
      )
      .toArray();
  }

  // Whether a task's latest submission alters what a collision is about. Without a review's report, nothing is known.
  private altered(taskId: string, target: string): boolean | null {
    const submission = this.latestSubmission(taskId);
    const parsed = parseTarget(target);
    if (submission === null || submission.interfaces === null || !parsed.ok) {
      return null;
    }
    const report = JSON.parse(submission.interfaces) as InterfaceReport;
    return report.changed.some((change) => {
      if (change.change === "added") {
        return false;
      }
      const altered = parseTarget(`${change.path}#${change.name}`);
      return altered.ok && targetsOverlap(altered.target, parsed.target);
    });
  }

  // Closes or updates a task's collisions once the task has ended: landed, given up, closed, or run out.
  private settleCollisions(taskId: string, now: number): void {
    const task = this.taskRow(taskId)!;
    for (const row of this.openCollisions(taskId)) {
      const isProvider = row.provider_task_id === taskId;
      const other = this.taskRow(isProvider ? row.relier_task_id : row.provider_task_id)!;
      if (task.state !== "merged") {
        this.resolveCollision(row, "ended", now);
      } else if (!LIVE_STATES.includes(other.state as TaskState)) {
        this.resolveCollision(row, "landed", now);
      } else if (row.kind === "duplicate") {
        // The later of the two is still told while the earlier has landed; once the later lands, it is over.
        if (!isProvider) {
          this.resolveCollision(row, "landed", now);
        }
      } else if (isProvider) {
        // The other task has to adapt only if this one did alter what it uses.
        const altered = this.altered(taskId, row.target);
        if (altered === false || (altered === null && row.state === "possible")) {
          this.resolveCollision(row, "no change", now);
        } else if (row.state !== "open") {
          this.sql.exec("UPDATE collisions SET state = 'open', updated_at = ? WHERE id = ?", now, row.id);
        }
      }
      // A task that relies on an interface and lands first leaves the collision open: the
      // task that changes the interface now has this one's code to update.
    }
  }

  private party(task: TaskRow): Party {
    return {
      taskId: task.id,
      agent: this.agentById(task.agent_id)!.name,
      goal: task.goal,
      state: task.state as TaskState,
      submittedAt: this.latestSubmission(task.id)?.created_at ?? null,
      mergeSha: task.merge_sha,
    };
  }

  // A task's collisions as it should read them: one for each other task, kind and state, with what to do.
  private collisionsOf(taskId: string): CollisionView[] {
    const me = this.party(this.taskRow(taskId)!);
    const views = new Map<string, CollisionView>();
    for (const row of this.openCollisions(taskId)) {
      const role: CollisionRole = row.provider_task_id === taskId ? "provider" : "relier";
      const otherId = role === "provider" ? row.relier_task_id : row.provider_task_id;
      const key = `${otherId}\0${row.kind}\0${row.state}\0${role}`;
      let view = views.get(key);
      if (view === undefined) {
        const other = this.party(this.taskRow(otherId)!);
        view = {
          id: row.id,
          kind: row.kind as CollisionKind,
          state: row.state as "possible" | "open",
          role,
          with: { taskId: other.taskId, agent: other.agent, goal: other.goal, state: other.state, mergeSha: other.mergeSha },
          targets: [],
          order: null,
          brief: "",
        };
        views.set(key, view);
      }
      if (row.target !== "") {
        view.targets.push(row.target);
      }
    }
    for (const view of views.values()) {
      const other = this.party(this.taskRow(view.with.taskId)!);
      const described = describeCollision({ kind: view.kind, state: view.state, role: view.role, me, other, targets: view.targets });
      view.order = described.order;
      view.brief = described.brief;
    }
    return [...views.values()];
  }

  // What a task that meets another may know of it, so that it can read the other's work.
  async peekInfo(request: { agentId: string; taskId: string; otherTaskId: string }): Promise<
    | {
        ok: true;
        other: { taskId: string; agent: string; goal: string; state: TaskState; forkName: string; baseSha: string | null; summary: string | null };
      }
    | Failure
  > {
    const task = this.ownedTask(request.agentId, request.taskId);
    if ("ok" in task) {
      return task;
    }
    const other = this.taskRow(request.otherTaskId);
    const pair = [task.id, request.otherTaskId, request.otherTaskId, task.id] as const;
    const connected =
      other !== null &&
      (this.sql
        .exec(
          "SELECT 1 FROM collisions WHERE (provider_task_id = ? AND relier_task_id = ?) OR (provider_task_id = ? AND relier_task_id = ?)",
          ...pair,
        )
        .toArray().length > 0 ||
        this.sql
          .exec("SELECT 1 FROM related WHERE (task_id = ? AND other_task_id = ?) OR (task_id = ? AND other_task_id = ?)", ...pair)
          .toArray().length > 0);
    if (other === null || !connected) {
      return fail("not_found", `task ${request.otherTaskId} is not connected with this task`);
    }
    return {
      ok: true,
      other: {
        taskId: other.id,
        agent: this.agentById(other.agent_id)!.name,
        goal: other.goal,
        state: other.state as TaskState,
        forkName: other.fork_name,
        baseSha: other.base_sha,
        summary: this.latestSubmission(other.id)?.summary ?? null,
      },
    };
  }

  // ── Contracts ─────────────────────────────────────────────────────────────
  //
  // The main branch must never hold a file that uses an interface in a shape the
  // file was not written for. Two things can bring that about, and both are
  // checked against the index when a review starts and again when a change is
  // about to land: the change relies on an interface that has moved since its
  // fork branched off, or the change alters an interface and leaves a file that
  // uses it as it was.

  private contracts(task: TaskRow, submission: SubmissionRow): ContractReport | null {
    if (submission.interfaces === null) {
      return null;
    }
    const report = JSON.parse(submission.interfaces) as InterfaceReport;
    const changedPaths = new Set(report.changedPaths);

    const moved: ContractReport["moved"] = [];
    for (const { target, hash } of report.relied) {
      const parsed = parseTarget(target);
      const file = parsed.ok ? targetPath(parsed.target) : null;
      // What the change itself replaces is the change's own to answer for.
      if (!parsed.ok || file === null || changedPaths.has(file)) {
        continue;
      }
      const origin =
        parsed.target.kind === "interface" && parsed.target.name !== "*" ? this.index.origin(parsed.target.path, parsed.target.name) : null;
      const now = this.index.hashOf(target);
      // Nothing can be said about a file the index has not read.
      if (now === undefined || now === hash || !this.index.has(origin?.path ?? file)) {
        continue;
      }
      const stored = origin === null ? null : this.index.signature(origin.path, origin.name);
      const since = stored?.sinceSha ?? this.index.fileSha(origin?.path ?? file);
      moved.push({ target, now: stored?.signature ?? null, since, by: since === null ? null : this.landedBy(since) });
    }

    const unupdated: ContractReport["unupdated"] = [];
    const held: ContractReport["held"] = [];
    for (const change of report.changed) {
      const target = `${change.path}#${change.name}`;
      if (change.kind === "route" || !parseTarget(target).ok) {
        continue;
      }
      for (const blocker of this.blockers([{ target, relation: "change", origin: "detected" }], task.id)) {
        held.push({ target, by: blocker.agent, taskId: blocker.taskId });
      }
      if (change.change === "added") {
        continue;
      }
      const users = this.index
        .dependents(change.path, change.name, { withPassers: change.change === "removed" })
        .filter((path) => !changedPaths.has(path));
      if (users.length > 0) {
        unupdated.push({ target, change: change.change, files: users.map((path) => ({ path, heldBy: this.holderOf(path, task.id) })) });
      }
    }
    const indexed = this.index.status().files > 0 && report.changedPaths.some((path) => isIndexable(path, 0));
    return { indexed, moved, unupdated, held, leaves: submission.leaves };
  }

  // For each interface a task changes, the files of the main branch that use it and that the task may not write.
  // An agent that knows them early can ask for them before it submits.
  private dependentsOf(taskId: string, scope: ScopeEntry[]): TaskView["dependents"] {
    const own = writablePaths(scope);
    const mine = (path: string) => own.some((held) => (held.endsWith("/") ? path.startsWith(held) : held === path));
    const out: TaskView["dependents"] = [];
    for (const entry of scope) {
      const parsed = entry.relation === "change" ? parseTarget(entry.target) : null;
      if (!parsed?.ok || parsed.target.kind !== "interface") {
        continue;
      }
      const files = this.index
        .dependents(parsed.target.path, parsed.target.name)
        .filter((path) => !mine(path))
        .map((path) => ({ path, heldBy: this.holderOf(path, taskId) }));
      if (files.length > 0) {
        out.push({ target: entry.target, files });
      }
    }
    return out;
  }

  // The agent whose task landed as a commit of the main branch.
  private landedBy(mergeSha: string): string | null {
    return (
      this.sql
        .exec<{ name: string }>("SELECT agents.name FROM tasks JOIN agents ON agents.id = tasks.agent_id WHERE tasks.merge_sha = ?", mergeSha)
        .toArray()[0]?.name ?? null
    );
  }

  // The agent of a live task, other than `exceptTaskId`, that may write a path.
  private holderOf(path: string, exceptTaskId: string): string | null {
    for (const row of this.liveScopeRows()) {
      const held = asked(row);
      if (row.task_id !== exceptTaskId && held !== null && held.relation !== "rely" && held.target.kind === "path") {
        const covers = held.target.path.endsWith("/") ? path.startsWith(held.target.path) : held.target.path === path;
        if (covers) {
          return row.agent_name;
        }
      }
    }
    return null;
  }

  // Stores what a review found about the interfaces a submission touches, adds it to the task's
  // scope, and says how the submission stands against the main branch.
  async recordInterfaces(submissionId: number, report: InterfaceReport): Promise<ContractReport | null> {
    const now = Date.now();
    const submission = this.submissionRow(submissionId);
    if (submission === null) {
      return null;
    }
    const task = this.taskRow(submission.task_id)!;
    const stored = JSON.stringify(report);
    this.sql.exec("UPDATE submissions SET interfaces = ? WHERE id = ?", stored, submissionId);
    const contracts = this.contracts(task, { ...submission, interfaces: stored })!;

    // What the task turns out to change and to rely on becomes part of its scope, so that
    // other tasks are connected with it as if it had said so.
    const held = new Set(contracts.held.map((entry) => entry.target));
    const changedPaths = new Set(report.changedPaths);
    const detected: [string, string][] = [];
    for (const change of report.changed) {
      const target = `${change.path}#${change.name}`;
      if (change.change !== "added" && change.kind !== "route" && !held.has(target) && parseTarget(target).ok) {
        detected.push([target, "change"]);
      }
    }
    for (const { target } of report.relied) {
      const parsed = parseTarget(target);
      const file = parsed.ok ? targetPath(parsed.target) : null;
      if (file !== null && !changedPaths.has(file)) {
        detected.push([target, "rely"]);
      }
    }
    for (const [target, relation] of detected) {
      this.sql.exec(
        "INSERT INTO scopes (task_id, target, relation, origin) VALUES (?, ?, ?, 'detected') ON CONFLICT DO NOTHING",
        task.id,
        target,
        relation,
      );
    }
    if (LIVE_STATES.includes(task.state as TaskState)) {
      this.linkTask(task.id, now);
    }

    // A collision with a task that has landed is over once this one has caught up with it.
    for (const row of this.openCollisions(task.id)) {
      const isProvider = row.provider_task_id === task.id;
      const other = this.taskRow(isProvider ? row.relier_task_id : row.provider_task_id)!;
      const about = parseTarget(row.target);
      if (row.kind !== "contract" || other.state !== "merged" || !about.ok) {
        continue;
      }
      const stillBroken = (isProvider ? contracts.unupdated : contracts.moved).some((entry) => {
        const parsed = parseTarget(entry.target);
        return parsed.ok && targetsOverlap(parsed.target, about.target);
      });
      if (!stillBroken) {
        this.resolveCollision(row, "adapted", now);
      }
    }
    return contracts;
  }

  // The last check before a change lands, made while the merge lock is held. A submission
  // that would break the main branch goes back to its agent with what is wrong and what to do.
  async confirmContracts(submissionId: number): Promise<{ ok: true } | { ok: false; report: ContractReport; escalated: boolean }> {
    const now = Date.now();
    const submission = this.submissionRow(submissionId);
    const task = submission === null ? null : this.taskRow(submission.task_id);
    const report = submission === null || task === null ? null : this.contracts(task, submission);
    if (submission === null || task === null || report === null || !contractsBroken(report)) {
      return { ok: true };
    }
    const latest = this.latestVerdict({ submissionId });
    if (task.state !== "in_review" || latest?.source === "merge") {
      return { ok: false, report, escalated: latest?.source === "merge" && latest.decision === "escalate" };
    }
    const message = describeContract(report);
    const escalated = await this.sendBackFromLanding(task, submissionId, { contract: report, message }, now, () =>
      this.emit(now, "contract", task.id, task.agent_id, {
        agent: this.agentById(task.agent_id)!.name,
        submissionId,
        contract: report,
        message,
      }),
    );
    return { ok: false, report, escalated };
  }

  // Sends a change back from its landing, as an attempt like any other: on the task's last allowed
  // attempt, a person decides instead. Says whether it went to a person.
  private async sendBackFromLanding(task: TaskRow, submissionId: number, body: JsonObject, now: number, sentBack: () => void): Promise<boolean> {
    const decision = rejectOrEscalate(task.cycle, this.config()!.maxCycles);
    if (decision.action === "escalate") {
      const verdict = { ...body, reasons: decision.reasons };
      this.insertVerdict(submissionId, { decision: "escalate", source: "merge", body: verdict }, now);
      this.setState(task, "escalated", now);
      this.emit(now, "escalated", task.id, task.agent_id, {
        agent: this.agentById(task.agent_id)!.name,
        submissionId,
        cycle: task.cycle,
        decision: "escalate",
        source: "merge",
        verdict,
      });
    } else {
      this.insertVerdict(submissionId, { decision: "reject", source: "merge", body }, now);
      this.setState(task, "active", now, { cycle: task.cycle + 1, restartClock: true });
      sentBack();
    }
    await this.releaseMergeLock(task.id);
    await this.scheduleAlarm();
    return decision.action === "escalate";
  }

  // ── The line ──────────────────────────────────────────────────────────────
  //
  // A request that cannot be granted may wait. A waiting request holds nothing:
  // what it wants stays open to others. When something is given up, the requests
  // in line are tried in order of arrival and each is granted whole or not at all.

  private waitingRows(): WaitingRow[] {
    return this.sql.exec<WaitingRow>("SELECT * FROM waiting WHERE granted_task_id IS NULL ORDER BY arrived_at, rowid").toArray();
  }

  private enqueue(
    agent: Agent,
    taskId: string | null,
    goal: string,
    entries: ScopeEntry[],
    ttlMs: number,
    now: number,
    conflicts: Conflict[],
  ): WaitingTicket {
    const requestId = newId("w");
    const scope = entries.map(({ target, relation }) => ({ target, relation }));
    this.sql.exec(
      "INSERT INTO waiting (id, agent_id, task_id, goal, scope, ttl_ms, arrived_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      requestId,
      agent.id,
      taskId,
      goal,
      JSON.stringify(scope),
      ttlMs,
      now,
      now,
    );
    this.emit(now, "waiting", taskId, agent.id, {
      agent: agent.name,
      goal,
      requestId,
      paths: scope.map((entry) => entry.target),
      scope,
      blockedBy: conflicts.map((conflict) => ({ taskId: conflict.taskId, agent: conflict.agent, paths: conflict.paths })),
    });
    return { requestId, position: this.positionOf(requestId) };
  }

  private static entriesOf(row: WaitingRow): ScopeEntry[] {
    return (JSON.parse(row.scope) as { target: string; relation: ScopeRelation }[]).map((entry) => ({ ...entry, origin: "declared" }));
  }

  // 1 for a request that no earlier request competes with; one more for each earlier request that wants what it wants.
  private positionOf(requestId: string, rows: WaitingRow[] = this.waitingRows()): number {
    const at = rows.findIndex((row) => row.id === requestId);
    const mine = Coordinator.entriesOf(rows[at]!).flatMap((entry) => asked(entry) ?? []);
    const ahead = rows.slice(0, at).filter((row) =>
      Coordinator.entriesOf(row)
        .flatMap((entry) => asked(entry) ?? [])
        .some((theirs) => mine.some((entry) => relate(entry, theirs) === "conflict")),
    );
    return ahead.length + 1;
  }

  // The agent of a task among `taskIds`, or among the tasks those wait for, that waits for `target`. Null if none does.
  private waitsFor(taskIds: string[], target: string): string | null {
    const seen = new Set<string>();
    const pending = [...taskIds];
    while (pending.length > 0) {
      const taskId = pending.pop()!;
      if (seen.has(taskId)) {
        continue;
      }
      seen.add(taskId);
      for (const row of this.waitingRows().filter((waiting) => waiting.task_id === taskId)) {
        const blockers = this.blockers(Coordinator.entriesOf(row), taskId).map((conflict) => conflict.taskId);
        if (blockers.includes(target)) {
          return this.agentById(row.agent_id)!.name;
        }
        pending.push(...blockers);
      }
    }
    return null;
  }

  // Drops the requests nobody asks about any more, then grants what can be granted, in order of arrival.
  private grantWaiting(now: number): void {
    const dropped = this.sql
      .exec<{ id: string; agent_id: string; task_id: string | null }>(
        "DELETE FROM waiting WHERE granted_task_id IS NULL AND seen_at <= ? RETURNING id, agent_id, task_id",
        now - WAIT_ALIVE_MS,
      )
      .toArray();
    for (const row of dropped) {
      this.emit(now, "left_line", row.task_id, row.agent_id, { requestId: row.id, reason: "its agent stopped asking" });
    }
    // A granted request is kept until its agent hears of it, or until the task it was granted is no longer waiting for that.
    this.sql.exec(
      `DELETE FROM waiting WHERE granted_task_id IS NOT NULL AND (
         granted_at <= ? OR granted_task_id NOT IN (SELECT id FROM tasks WHERE state = 'active'))`,
      now - WAIT_ALIVE_MS,
    );

    const config = this.config();
    if (config === null) {
      return;
    }
    for (const row of this.waitingRows()) {
      const entries = Coordinator.entriesOf(row);
      const task = row.task_id === null ? null : this.taskRow(row.task_id);
      if (row.task_id !== null && task?.state !== "active") {
        this.sql.exec("DELETE FROM waiting WHERE id = ?", row.id);
        this.emit(now, "left_line", row.task_id, row.agent_id, { requestId: row.id, reason: "its task is no longer being worked on" });
        continue;
      }
      if (this.blockers(entries, row.task_id).length > 0) {
        continue;
      }
      let grantedTo: string;
      if (task === null) {
        grantedTo = this.createTask(config, this.agentById(row.agent_id)!, row.goal, entries, row.ttl_ms, now, now + PICKUP_MS).id;
      } else if (this.growScope(task, entries, now).ok) {
        grantedTo = task.id;
      } else {
        this.sql.exec("DELETE FROM waiting WHERE id = ?", row.id);
        continue;
      }
      this.sql.exec("UPDATE waiting SET granted_task_id = ?, granted_at = ? WHERE id = ?", grantedTo, now, row.id);
    }
  }

  // How a waiting request stands. An agent that waits calls this again and again; a request
  // that is not asked about for three minutes is dropped.
  async pollRequest(request: { agentId: string; requestId: string }): Promise<PollResult> {
    const now = Date.now();
    const find = () =>
      this.sql.exec<WaitingRow>("SELECT * FROM waiting WHERE id = ? AND agent_id = ?", request.requestId, request.agentId).toArray()[0];

    // Asking keeps the request in line, and keeps the scope of a task that waits for more from running out.
    const before = find();
    if (before !== undefined && before.granted_task_id === null) {
      this.sql.exec("UPDATE waiting SET seen_at = ? WHERE id = ?", now, before.id);
      const task = before.task_id === null ? null : this.taskRow(before.task_id);
      if (task?.state === "active" && task.claim_expires_at > now) {
        this.setState(task, "active", now, { restartClock: true });
      }
    }
    this.tick(now);

    const row = find();
    let result: PollResult;
    if (row === undefined) {
      result = { status: "gone", reason: GONE };
    } else if (row.granted_task_id === null) {
      result = {
        status: "waiting",
        requestId: row.id,
        position: this.positionOf(row.id),
        conflicts: this.blockers(Coordinator.entriesOf(row), row.task_id),
      };
    } else {
      this.sql.exec("DELETE FROM waiting WHERE id = ?", row.id);
      const task = this.taskRow(row.granted_task_id)!;
      const scope = this.scopeOf(task.id);
      const paths = writablePaths(scope);
      result =
        row.task_id === null
          ? {
              status: "granted",
              // Its whole lifetime starts when its fork is attached.
              task: { id: task.id, forkName: task.fork_name, paths, scope, claimExpiresAt: now + task.claim_ttl_ms },
              goal: task.goal,
              others: this.liveTasks(MAX_OTHERS + 1).filter((other) => other.taskId !== task.id),
            }
          : { status: "granted", paths, scope, claimExpiresAt: task.claim_expires_at };
    }
    await this.scheduleAlarm();
    return result;
  }

  // Leaves the line. A task that was granted from the line and not yet picked up is given up too.
  async cancelRequest(request: { agentId: string; requestId: string }): Promise<{ ok: true } | Failure> {
    const now = Date.now();
    const row = this.sql
      .exec<WaitingRow>("DELETE FROM waiting WHERE id = ? AND agent_id = ? RETURNING *", request.requestId, request.agentId)
      .toArray()[0];
    if (row === undefined) {
      return fail("not_found", `request ${request.requestId} is not waiting`);
    }
    if (row.task_id === null && row.granted_task_id !== null) {
      const task = this.taskRow(row.granted_task_id);
      if (task !== null && task.state === "active" && task.base_sha === null) {
        this.setState(task, "abandoned", now);
        this.emit(now, "abandoned", task.id, task.agent_id, { reason: "its agent stopped waiting for it" });
        this.settleCollisions(task.id, now);
      }
    } else {
      this.emit(now, "left_line", row.task_id, row.agent_id, { requestId: row.id, reason: "its agent stopped waiting" });
    }
    this.tick(now);
    await this.scheduleAlarm();
    return { ok: true };
  }

  private waitingViews(): WaitingView[] {
    const rows = this.waitingRows();
    return rows.map((row) => ({
      requestId: row.id,
      agent: this.agentById(row.agent_id)!.name,
      goal: row.goal,
      taskId: row.task_id,
      scope: JSON.parse(row.scope) as ScopeInput[],
      arrivedAt: row.arrived_at,
      position: this.positionOf(row.id, rows),
      blockedBy: this.blockers(Coordinator.entriesOf(row), row.task_id).map((conflict) => ({
        taskId: conflict.taskId,
        agent: conflict.agent,
      })),
    }));
  }

  private taskRow(taskId: string): TaskRow | null {
    return this.sql.exec<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId).toArray()[0] ?? null;
  }

  private ownedTask(agentId: string, taskId: string): TaskRow | Failure {
    const task = this.taskRow(taskId);
    if (task === null) {
      return fail("not_found", `task ${taskId} does not exist`);
    }
    if (task.agent_id !== agentId) {
      return fail("not_owner", `task ${taskId} belongs to another agent`);
    }
    return task;
  }

  // The paths a task may write.
  private claimPaths(taskId: string): string[] {
    return writablePaths(this.scopeOf(taskId));
  }

  private setState(task: TaskRow, state: TaskState, now: number, changes: { cycle?: number; restartClock?: boolean } = {}): void {
    this.sql.exec(
      "UPDATE tasks SET state = ?, cycle = ?, claim_expires_at = ?, updated_at = ? WHERE id = ?",
      state,
      changes.cycle ?? task.cycle,
      changes.restartClock ? now + task.claim_ttl_ms : task.claim_expires_at,
      now,
      task.id,
    );
  }

  async attachFork(taskId: string, baseSha: string): Promise<{ ok: true } | Failure> {
    const task = this.taskRow(taskId);
    if (task === null) {
      return fail("not_found", `task ${taskId} does not exist`);
    }
    if (!isOid(baseSha)) {
      return fail("invalid_input", "base commit must be a 40-character commit id");
    }
    if (task.state !== "active" || task.base_sha !== null) {
      return fail("bad_state", `task ${taskId} already has a fork or is no longer active`);
    }
    // The lifetime runs from here: a task granted from the line had only a few minutes until now.
    const now = Date.now();
    this.sql.exec(
      "UPDATE tasks SET base_sha = ?, claim_expires_at = ?, updated_at = ? WHERE id = ?",
      baseSha,
      now + task.claim_ttl_ms,
      now,
      taskId,
    );
    await this.scheduleAlarm();
    return { ok: true };
  }

  // The fork could not be created: give the paths back.
  async failStart(taskId: string, reason: string): Promise<{ ok: true } | Failure> {
    const task = this.taskRow(taskId);
    if (task === null) {
      return fail("not_found", `task ${taskId} does not exist`);
    }
    if (task.state !== "active" || task.base_sha !== null) {
      return fail("bad_state", `task ${taskId} has already started`);
    }
    const now = Date.now();
    this.setState(task, "abandoned", now);
    this.emit(now, "abandoned", task.id, task.agent_id, { reason });
    this.settleCollisions(task.id, now);
    this.grantWaiting(now);
    await this.scheduleAlarm();
    return { ok: true };
  }

  async expandScope(request: ExpandScopeRequest): Promise<ExpandScopeResult> {
    const now = Date.now();
    this.tick(now);
    const task = this.ownedTask(request.agentId, request.taskId);
    if ("ok" in task) {
      return task;
    }
    if (task.state !== "active") {
      return fail("bad_state", `a scope can only be expanded while the task is active; it is ${task.state}`);
    }
    const requested = readScope(request);
    if (!requested.ok) {
      return requested;
    }
    const agent = this.agentById(task.agent_id)!;
    const conflicts = this.blockers(requested.entries, task.id);
    if (conflicts.length > 0) {
      this.emitRefusal(now, task.id, agent, task.goal, requested.entries, conflicts);
      const message = conflictMessage(requested.entries, conflicts);
      if (!request.wait) {
        return { ...fail("conflict", message, true), conflicts };
      }
      // A task that holds something and waits for more can wait for a task that waits for it.
      const circle = this.waitsFor(
        conflicts.map((conflict) => conflict.taskId),
        task.id,
      );
      if (circle !== null) {
        const reason = `${message}, and waiting would never end: ${circle}'s task is itself waiting for what this task holds. Give up one of the two.`;
        return { ...fail("conflict", reason, false), conflicts };
      }
      const waiting = this.enqueue(agent, task.id, task.goal, requested.entries, task.claim_ttl_ms, now, conflicts);
      await this.scheduleAlarm();
      return { ...fail("conflict", message, true), conflicts, waiting };
    }

    const grown = this.growScope(task, requested.entries, now);
    await this.scheduleAlarm();
    return grown;
  }

  // Adds entries that nothing blocks to a task's scope, and restarts its clock.
  private growScope(task: TaskRow, entries: ScopeEntry[], now: number): Extract<ExpandScopeResult, { ok: true }> | Failure {
    const combined = normalizeScope([...entries, ...this.scopeOf(task.id)], { maxEntries: MAX_SCOPE_ENTRIES });
    if (!combined.ok) {
      return fail("invalid_input", combined.reason);
    }
    this.writeScope(task.id, combined.entries);
    this.inferReliance(task.id);
    this.setState(task, "active", now, { restartClock: true });
    const scope = this.scopeOf(task.id);
    const paths = writablePaths(scope);
    const claimExpiresAt = now + task.claim_ttl_ms;
    this.emit(now, "claim_expanded", task.id, task.agent_id, {
      agent: this.agentById(task.agent_id)!.name,
      added: entries.map((entry) => entry.target),
      paths,
      scope,
      claimExpiresAt,
    });
    this.linkTask(task.id, now);
    return { ok: true, paths, scope, claimExpiresAt };
  }

  // The name this had when a scope was a list of paths.
  async expandClaim(request: ExpandScopeRequest): Promise<ExpandScopeResult> {
    return this.expandScope(request);
  }

  async abandon(request: { agentId: string; taskId: string }): Promise<{ ok: true } | Failure> {
    const now = Date.now();
    this.tick(now);
    const task = this.ownedTask(request.agentId, request.taskId);
    if ("ok" in task) {
      return task;
    }
    if (task.state !== "active" && task.state !== "expired") {
      return fail("bad_state", `a task can only be abandoned while it is active or expired; it is ${task.state}`);
    }
    this.setState(task, "abandoned", now);
    this.emit(now, "abandoned", task.id, task.agent_id, { reason: "abandoned by its agent" });
    this.settleCollisions(task.id, now);
    this.grantWaiting(now);
    await this.scheduleAlarm();
    return { ok: true };
  }

  // ── Submissions and verdicts ──────────────────────────────────────────────

  async submit(request: SubmitRequest): Promise<SubmitResult> {
    const now = Date.now();
    this.tick(now);
    const task = this.ownedTask(request.agentId, request.taskId);
    if ("ok" in task) {
      return task;
    }
    if (!isOid(request.headSha)) {
      return fail("invalid_input", "head commit must be a 40-character commit id");
    }
    if (task.state !== "active" && task.state !== "expired") {
      return fail(
        "bad_state",
        task.state === "in_review"
          ? "a submission for this task is already in review"
          : `a task can only be submitted while it is active; it is ${task.state}`,
      );
    }
    if (task.base_sha === null) {
      return fail("bad_state", "the task's fork is not ready yet", true);
    }
    if (request.baseSha !== undefined && !isOid(request.baseSha)) {
      return fail("invalid_input", "base commit must be a 40-character commit id");
    }
    const baseSha = request.baseSha ?? task.base_sha;
    if (request.headSha === baseSha) {
      return fail("nothing_to_submit", "the fork has no commits beyond the main branch it is based on");
    }
    if (task.state === "expired") {
      // The claim lapsed. It comes back only if nobody else has taken any of its paths since.
      const conflicts = this.blockers(this.scopeOf(task.id), task.id);
      if (conflicts.length > 0) {
        return {
          ...fail("conflict", "the claim expired and its paths are now held by another task", false),
          conflicts,
        };
      }
    }
    // A task that was told it repeats an earlier task has to say that it does not.
    const repeats = this.openCollisions(task.id).filter((row) => row.kind === "duplicate" && row.relier_task_id === task.id);
    if (repeats.length > 0 && task.confirmed_distinct === 0) {
      if (!request.confirmDistinct) {
        const told = this.collisionsOf(task.id).find((view) => view.kind === "duplicate" && view.role === "relier")!;
        return fail("duplicate", told.brief);
      }
      this.sql.exec("UPDATE tasks SET confirmed_distinct = 1 WHERE id = ?", task.id);
      for (const row of repeats) {
        this.resolveCollision(row, "said to be different", now);
      }
    }

    const cycle = task.cycle;
    const summary = request.summary.trim().slice(0, MAX_SUMMARY_LENGTH);
    if (baseSha !== task.base_sha) {
      this.sql.exec("UPDATE tasks SET base_sha = ? WHERE id = ?", baseSha, task.id);
    }
    const leaves = request.leaves?.trim().slice(0, MAX_SUMMARY_LENGTH) || null;
    const submissionId = this.sql
      .exec<{ id: number }>(
        "INSERT INTO submissions (task_id, cycle, head_sha, summary, leaves, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
        task.id,
        cycle,
        request.headSha,
        summary,
        leaves,
        now,
      )
      .one().id;
    const cameBack = task.state === "expired";
    this.setState(task, "in_review", now);
    if (cameBack) {
      this.linkTask(task.id, now);
    }
    this.emit(now, "submitted", task.id, task.agent_id, {
      agent: this.agentById(task.agent_id)!.name,
      submissionId,
      cycle,
      headSha: request.headSha,
      summary,
    });
    await this.scheduleAlarm();
    return { ok: true, submissionId, cycle, headSha: request.headSha };
  }

  // Notes, for the board, that a task's agent is bringing its fork up to date with the main branch.
  async recordCatchUp(taskId: string, mainHead: string): Promise<void> {
    const task = this.taskRow(taskId);
    if (task !== null) {
      this.emit(Date.now(), "catching_up", task.id, task.agent_id, { agent: this.agentById(task.agent_id)!.name, mainHead });
    }
  }

  private submissionRow(submissionId: number): SubmissionRow | null {
    return this.sql.exec<SubmissionRow>("SELECT * FROM submissions WHERE id = ?", submissionId).toArray()[0] ?? null;
  }

  private latestSubmission(taskId: string): SubmissionRow | null {
    return (
      this.sql
        .exec<SubmissionRow>("SELECT * FROM submissions WHERE task_id = ? ORDER BY id DESC LIMIT 1", taskId)
        .toArray()[0] ?? null
    );
  }

  // Verdicts for a task or for one submission, oldest first.
  private verdictsOf(where: { taskId: string } | { submissionId: number }): VerdictView[] {
    return this.sql
      .exec<VerdictRow>(
        `SELECT verdicts.id, verdicts.submission_id, submissions.cycle, verdicts.decision, verdicts.source,
                verdicts.body, verdicts.created_at
           FROM verdicts JOIN submissions ON submissions.id = verdicts.submission_id
          WHERE ${"taskId" in where ? "submissions.task_id = ?" : "submissions.id = ?"}
          ORDER BY verdicts.id`,
        "taskId" in where ? where.taskId : where.submissionId,
      )
      .toArray()
      .map((row) => ({
        submissionId: row.submission_id,
        cycle: row.cycle,
        decision: row.decision as VerdictView["decision"],
        source: row.source as VerdictView["source"],
        body: JSON.parse(row.body) as JsonObject,
        createdAt: row.created_at,
      }));
  }

  private latestVerdict(where: { taskId: string } | { submissionId: number }): VerdictView | null {
    return this.verdictsOf(where).at(-1) ?? null;
  }

  private insertVerdict(submissionId: number, verdict: VerdictInput, now: number): void {
    this.sql.exec(
      "INSERT INTO verdicts (submission_id, decision, source, body, created_at) VALUES (?, ?, ?, ?, ?)",
      submissionId,
      verdict.decision,
      verdict.source,
      JSON.stringify(verdict.body),
      now,
    );
  }

  // Records the outcome of a review and moves the task accordingly. Recording
  // the same outcome twice changes nothing, so a retried workflow step is safe.
  async recordVerdict(submissionId: number, verdict: VerdictInput): Promise<RecordVerdictResult> {
    const now = Date.now();
    const submission = this.submissionRow(submissionId);
    if (submission === null) {
      return fail("not_found", `submission ${submissionId} does not exist`);
    }
    const task = this.taskRow(submission.task_id)!;
    const previous = this.latestVerdict({ submissionId });
    if (previous !== null && previous.decision === verdict.decision && previous.source === verdict.source) {
      return { ok: true, state: task.state as TaskState, cycle: task.cycle };
    }
    if (task.state !== "in_review" || submission.cycle !== task.cycle) {
      return fail("bad_state", `submission ${submissionId} is no longer in review`);
    }

    this.insertVerdict(submissionId, verdict, now);
    const eventBody = {
      agent: this.agentById(task.agent_id)!.name,
      submissionId,
      cycle: submission.cycle,
      decision: verdict.decision,
      source: verdict.source,
      verdict: verdict.body,
    };
    let state: TaskState = "in_review";
    let cycle = task.cycle;
    if (verdict.decision === "reject") {
      state = "active";
      cycle = task.cycle + 1;
      this.setState(task, state, now, { cycle, restartClock: true });
      this.emit(now, verdict.source === "check" || verdict.source === "gate" ? "check_failed" : "verdict", task.id, task.agent_id, eventBody);
    } else if (verdict.decision === "escalate") {
      state = "escalated";
      this.setState(task, state, now);
      this.emit(now, "escalated", task.id, task.agent_id, eventBody);
    } else {
      this.setState(task, state, now);
      this.emit(now, "verdict", task.id, task.agent_id, eventBody);
    }
    await this.scheduleAlarm();
    return { ok: true, state, cycle };
  }

  // ── Merging ───────────────────────────────────────────────────────────────

  private mergeLock(): MergeLock | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM config WHERE key = 'merge_lock'").toArray()[0];
    return row === undefined ? null : (JSON.parse(row.value) as MergeLock);
  }

  // One merge at a time per repository. A lock that is never released frees itself: after two
  // minutes, or after `holdMs` for a merge that runs the repository's checks while it holds it.
  async acquireMergeLock(taskId: string, holdMs: number = MERGE_LOCK_MS): Promise<boolean> {
    const now = Date.now();
    const held = this.mergeLock();
    if (held !== null && held.taskId !== taskId && held.expiresAt > now) {
      return false;
    }
    const lock: MergeLock = { taskId, expiresAt: now + Math.min(Math.max(holdMs, MERGE_LOCK_MS), MAX_MERGE_LOCK_MS) };
    this.sql.exec(
      "INSERT INTO config (key, value) VALUES ('merge_lock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(lock),
    );
    return true;
  }

  async releaseMergeLock(taskId: string): Promise<void> {
    if (this.mergeLock()?.taskId === taskId) {
      this.sql.exec("DELETE FROM config WHERE key = 'merge_lock'");
    }
  }

  // `index` holds the files the change touched as they are on the main branch now, so that the
  // index is true to the main branch from the moment the change has landed.
  async recordMerged(
    submissionId: number,
    mergeSha: string,
    noteWritten: boolean,
    index?: { files: IndexedFile[]; removed: string[] },
  ): Promise<{ ok: true } | Failure> {
    const now = Date.now();
    const submission = this.submissionRow(submissionId);
    if (submission === null) {
      return fail("not_found", `submission ${submissionId} does not exist`);
    }
    const task = this.taskRow(submission.task_id)!;
    if (task.state === "merged" && task.merge_sha === mergeSha) {
      return { ok: true };
    }
    if (task.state !== "in_review" || this.latestVerdict({ submissionId })?.decision !== "approve") {
      return fail("bad_state", `submission ${submissionId} is not approved and waiting to merge`);
    }
    this.sql.exec("UPDATE tasks SET state = 'merged', merge_sha = ?, updated_at = ? WHERE id = ?", mergeSha, now, task.id);
    if (index !== undefined) {
      this.index.replace(index.files, index.removed, mergeSha);
    }
    await this.releaseMergeLock(task.id);
    this.emit(now, "merged", task.id, task.agent_id, {
      agent: this.agentById(task.agent_id)!.name,
      goal: task.goal,
      submissionId,
      mergeSha,
      noteWritten,
    });
    this.settleCollisions(task.id, now);
    this.grantWaiting(now);
    await this.scheduleAlarm();
    return { ok: true };
  }

  // The merge found that main had changed under the task's paths: the claim
  // lapsed at some point. The work cannot land from this fork any more.
  // The merge found that a path of this task changed on main while the task did not hold it.
  // The work goes back to its agent, which can catch up with main in the same fork and submit again.
  async recordStale(submissionId: number, paths: StalePath[]): Promise<{ ok: true; escalated: boolean } | Failure> {
    const now = Date.now();
    const submission = this.submissionRow(submissionId);
    if (submission === null) {
      return fail("not_found", `submission ${submissionId} does not exist`);
    }
    const task = this.taskRow(submission.task_id)!;
    const latest = this.latestVerdict({ submissionId });
    if (latest?.source === "merge") {
      return { ok: true, escalated: latest.decision === "escalate" };
    }
    if (task.state !== "in_review") {
      return fail("bad_state", `submission ${submissionId} is no longer in review`);
    }
    const body = {
      stale: paths,
      message:
        "These paths changed on the main branch while this task did not hold them. " +
        "Call sync_with_main, merge the current main into your work, and submit again.",
    };
    const escalated = await this.sendBackFromLanding(task, submissionId, body, now, () =>
      this.emit(now, "stale", task.id, task.agent_id, {
        agent: this.agentById(task.agent_id)!.name,
        submissionId,
        paths,
      }),
    );
    return { ok: true, escalated };
  }

  // ── Human decisions ───────────────────────────────────────────────────────

  async decideEscalation(request: EscalationDecision): Promise<EscalationResult> {
    const now = Date.now();
    const task = this.taskRow(request.taskId);
    if (task === null) {
      return fail("not_found", `task ${request.taskId} does not exist`);
    }
    if (task.state !== "escalated") {
      return fail("bad_state", `task ${request.taskId} is not waiting for a decision; it is ${task.state}`);
    }
    const submission = this.latestSubmission(task.id)!;
    const note = request.note?.trim() ?? "";

    let state: TaskState;
    if (request.decision === "approve") {
      state = "in_review";
      this.insertVerdict(submission.id, { decision: "approve", source: "human", body: { note } }, now);
      this.setState(task, state, now);
    } else if (request.decision === "send_back") {
      state = "active";
      this.insertVerdict(submission.id, { decision: "reject", source: "human", body: { note } }, now);
      this.setState(task, state, now, { cycle: task.cycle + 1, restartClock: true });
    } else {
      state = "closed";
      this.insertVerdict(submission.id, { decision: "reject", source: "human", body: { note, closed: true } }, now);
      this.setState(task, state, now);
    }
    this.emit(now, "human_decision", task.id, task.agent_id, {
      agent: this.agentById(task.agent_id)!.name,
      submissionId: submission.id,
      decision: request.decision,
      note,
    });
    if (state === "closed") {
      this.settleCollisions(task.id, now);
    }
    this.grantWaiting(now);
    await this.scheduleAlarm();
    return { ok: true, state, submissionId: submission.id };
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  private taskView(task: TaskRow): TaskView {
    const state = task.state as TaskState;
    const scope = this.scopeOf(task.id);
    return {
      id: task.id,
      agentId: task.agent_id,
      agent: this.agentById(task.agent_id)!.name,
      goal: task.goal,
      state,
      cycle: task.cycle,
      forkName: task.fork_name,
      baseSha: task.base_sha,
      paths: writablePaths(scope),
      scope,
      collisions: this.collisionsOf(task.id),
      dependents: LIVE_STATES.includes(state) ? this.dependentsOf(task.id, scope) : [],
      claimExpiresAt: state === "active" ? task.claim_expires_at : null,
      mergeSha: task.merge_sha,
      verdict: this.latestVerdict({ taskId: task.id }),
      related: this.relatedOf(task.id),
      createdAt: task.created_at,
      updatedAt: task.updated_at,
    };
  }

  async getTask(request: { agentId: string; taskId: string }): Promise<{ ok: true; task: TaskView } | Failure> {
    this.tick(Date.now());
    const task = this.ownedTask(request.agentId, request.taskId);
    if ("ok" in task) {
      return task;
    }
    return { ok: true, task: this.taskView(task) };
  }

  // Everything the review of one submission needs, in one call.
  async getSubmission(submissionId: number): Promise<SubmissionContext | null> {
    const submission = this.submissionRow(submissionId);
    const config = this.config();
    if (submission === null || config === null) {
      return null;
    }
    const task = this.taskRow(submission.task_id)!;
    return {
      submission: submissionView(submission),
      task: {
        id: task.id,
        agentId: task.agent_id,
        agent: this.agentById(task.agent_id)!.name,
        goal: task.goal,
        state: task.state as TaskState,
        cycle: task.cycle,
        forkName: task.fork_name,
        baseSha: task.base_sha ?? "",
      },
      claim: this.claimPaths(task.id),
      scope: this.scopeOf(task.id),
      related: this.relatedOf(task.id),
      collisions: this.collisionsOf(task.id),
      interfaces: submission.interfaces === null ? null : (JSON.parse(submission.interfaces) as InterfaceReport),
      leaves: submission.leaves,
      gate: submission.gate === null ? null : (JSON.parse(submission.gate) as GateResult),
      verdicts: this.verdictsOf({ submissionId }),
      previous:
        this.verdictsOf({ taskId: task.id })
          .filter((verdict) => verdict.submissionId < submissionId)
          .at(-1) ?? null,
      config,
    };
  }

  async whatsHappening(): Promise<{ tasks: LiveTask[]; merges: RecentMerge[]; waiting: WaitingView[] }> {
    this.tick(Date.now());
    const merges = this.sql
      .exec<{ id: string; agent: string; goal: string; merge_sha: string; updated_at: number }>(
        `SELECT tasks.id, agents.name AS agent, tasks.goal, tasks.merge_sha, tasks.updated_at
           FROM tasks JOIN agents ON agents.id = tasks.agent_id
          WHERE tasks.state = 'merged'
          ORDER BY tasks.updated_at DESC, tasks.rowid DESC LIMIT ?`,
        RECENT_MERGES,
      )
      .toArray()
      .map((row) => ({
        taskId: row.id,
        agent: row.agent,
        goal: row.goal,
        mergeSha: row.merge_sha,
        mergedAt: row.updated_at,
      }));
    return { tasks: this.liveTasks(MAX_OTHERS), merges, waiting: this.waitingViews() };
  }

  private boardTask(task: TaskRow): BoardTask {
    const submission = this.latestSubmission(task.id);
    return {
      ...this.taskView(task),
      submission: submission === null ? null : submissionView(submission),
    };
  }

  // One task as the board sees it, whoever owns it.
  async inspectTask(taskId: string): Promise<BoardTask | null> {
    const task = this.taskRow(taskId);
    return task === null ? null : this.boardTask(task);
  }

  // The whole picture for the board.
  async snapshot(): Promise<Snapshot | null> {
    this.tick(Date.now());
    const config = this.config();
    if (config === null) {
      return null;
    }
    const liveStates = LIVE_STATES.map((state) => `'${state}'`).join(", ");
    const live = this.sql.exec<TaskRow>(`SELECT * FROM tasks WHERE state IN (${liveStates}) ORDER BY created_at, rowid`);
    const finished = this.sql.exec<TaskRow>(
      `SELECT * FROM tasks WHERE state NOT IN (${liveStates}) ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
      FINISHED_TASKS_ON_BOARD,
    );
    const tasks = [...live.toArray(), ...finished.toArray()].map((task) => this.boardTask(task));
    return {
      config,
      agents: this.sql.exec<AgentRow>("SELECT id, name FROM agents ORDER BY created_at, rowid").toArray(),
      tasks,
      events: await this.listEvents(),
      shadow: this.shadowTally(),
      waiting: this.waitingViews(),
      index: this.index.status(),
    };
  }

  // How often the decision model's answers alone would have reached the outcome
  // the full review reached. A submission still waiting for a person is left out.
  private shadowTally(): { reviewed: number; agreed: number } {
    const bySubmission = new Map<number, { would: boolean | null; final: string }>();
    const rows = this.sql.exec<{ submission_id: number; decision: string; body: string }>(
      "SELECT submission_id, decision, body FROM verdicts ORDER BY id",
    );
    for (const row of rows) {
      const entry = bySubmission.get(row.submission_id) ?? { would: null, final: row.decision };
      entry.final = row.decision;
      const shadow = (JSON.parse(row.body) as { shadow?: { would_auto_approve?: unknown } }).shadow;
      if (typeof shadow?.would_auto_approve === "boolean") {
        entry.would = shadow.would_auto_approve;
      }
      bySubmission.set(row.submission_id, entry);
    }

    let reviewed = 0;
    let agreed = 0;
    for (const { would, final } of bySubmission.values()) {
      if (would === null || final === "escalate") {
        continue;
      }
      reviewed++;
      if (would === (final === "approve")) {
        agreed++;
      }
    }
    return { reviewed, agreed };
  }

  // ── Decision model signals ────────────────────────────────────────────────

  // Tasks the decision model judged to be connected to this one, from either side.
  private relatedOf(taskId: string): RelatedTask[] {
    const rows = this.sql
      .exec<{ task_id: string; other_task_id: string; relation: string; confidence: number }>(
        "SELECT task_id, other_task_id, relation, confidence FROM related WHERE task_id = ? OR other_task_id = ? ORDER BY created_at, rowid",
        taskId,
        taskId,
      )
      .toArray();
    return rows.map((row) => {
      const other = this.taskRow(row.task_id === taskId ? row.other_task_id : row.task_id)!;
      return {
        taskId: other.id,
        agent: this.agentById(other.agent_id)!.name,
        goal: other.goal,
        state: other.state as TaskState,
        paths: this.claimPaths(other.id),
        relation: row.relation as Relation,
        confidence: row.confidence,
      };
    });
  }

  async recordRelated(
    taskId: string,
    related: { taskId: string; relation: Relation; confidence: number }[],
  ): Promise<RelatedTask[]> {
    const task = this.taskRow(taskId);
    const known = related.filter((entry) => entry.taskId !== taskId && this.taskRow(entry.taskId) !== null);
    if (task === null || known.length === 0) {
      return [];
    }
    const now = Date.now();
    for (const entry of known) {
      this.sql.exec(
        `INSERT INTO related (task_id, other_task_id, relation, confidence, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id, other_task_id) DO UPDATE SET relation = excluded.relation, confidence = excluded.confidence`,
        taskId,
        entry.taskId,
        entry.relation,
        entry.confidence,
        now,
      );
      if (entry.relation === "duplicate") {
        this.recordCollision("duplicate", "", entry.taskId, taskId, "open", taskId, now);
      }
    }
    const view = this.relatedOf(taskId);
    this.emit(now, "related_work", task.id, task.agent_id, {
      agent: this.agentById(task.agent_id)!.name,
      related: view.map(({ taskId: otherId, agent, goal, relation, confidence }) => ({
        taskId: otherId,
        agent,
        goal,
        relation,
        confidence,
      })),
    });
    return view;
  }

  async recordDeciderUnavailable(report: { taskId: string; stage: "claim" | "triage"; reason: string }): Promise<void> {
    const task = this.taskRow(report.taskId);
    this.emit(Date.now(), "decider_unavailable", task?.id ?? null, task?.agent_id ?? null, {
      stage: report.stage,
      reason: report.reason,
    });
  }

  // Stores what the repository's checks said about a submission, and shows it on the board.
  async recordGate(submissionId: number, result: GateResult): Promise<void> {
    const submission = this.submissionRow(submissionId);
    if (submission === null) {
      return;
    }
    const task = this.taskRow(submission.task_id)!;
    this.sql.exec("UPDATE submissions SET gate = ? WHERE id = ?", JSON.stringify(result), submissionId);
    this.emit(Date.now(), "gate", task.id, task.agent_id, {
      agent: this.agentById(task.agent_id)!.name,
      submissionId,
      outcome: result.outcome,
      summary: gateSummary(result),
      ...(result.outcome === "fail" ? { failed: result.steps.at(-1)?.name ?? "" } : {}),
    });
  }

  // Stores the triage for a submission, or notes that the decision model could not provide one.
  async recordTriage(submissionId: number, triage: Triage | null, reason = "unavailable"): Promise<void> {
    const submission = this.submissionRow(submissionId);
    if (submission === null) {
      return;
    }
    const task = this.taskRow(submission.task_id)!;
    this.sql.exec(
      "UPDATE submissions SET triage = ? WHERE id = ?",
      triage === null ? null : JSON.stringify(triage),
      submissionId,
    );
    if (triage === null) {
      this.emit(Date.now(), "decider_unavailable", task.id, task.agent_id, { stage: "triage", reason, submissionId });
    } else {
      this.emit(Date.now(), "triage", task.id, task.agent_id, { submissionId, triage });
    }
  }

  // ── Expiry ────────────────────────────────────────────────────────────────

  // Expires every active task whose claim lifetime has passed.
  private sweep(now: number): void {
    const expired = this.sql
      .exec<{ id: string; agent_id: string }>(
        "UPDATE tasks SET state = 'expired', updated_at = ? WHERE state = 'active' AND claim_expires_at <= ? RETURNING id, agent_id",
        now,
        now,
      )
      .toArray();
    for (const task of expired) {
      this.emit(now, "expired", task.id, task.agent_id, {});
      this.settleCollisions(task.id, now);
    }
  }

  // What the passing of time brings: scopes run out, and what they held goes to the requests in line.
  private tick(now: number): void {
    this.sweep(now);
    this.grantWaiting(now);
  }

  // Wakes the object when the next scope runs out or the next waiting request is due to be dropped,
  // so that both show up without waiting for a call.
  private async scheduleAlarm(): Promise<void> {
    const expiry = this.sql
      .exec<{ next: number | null }>("SELECT MIN(claim_expires_at) AS next FROM tasks WHERE state = 'active'")
      .one().next;
    const seen = this.sql
      .exec<{ next: number | null }>("SELECT MIN(COALESCE(granted_at, seen_at)) AS next FROM waiting")
      .one().next;
    const times = [expiry, seen === null ? null : seen + WAIT_ALIVE_MS].filter((time) => time !== null);
    if (times.length === 0) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Math.min(...times));
    }
  }

  override async alarm(): Promise<void> {
    this.tick(Date.now());
    await this.scheduleAlarm();
  }

  // ── Events ────────────────────────────────────────────────────────────────

  private emit(
    now: number,
    type: string,
    taskId: string | null,
    agentId: string | null,
    body: JsonObject,
  ): void {
    const id = this.sql
      .exec<{ id: number }>(
        "INSERT INTO events (type, task_id, agent_id, body, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
        type,
        taskId,
        agentId,
        JSON.stringify(body),
        now,
      )
      .one().id;

    // Push the event to every connected board. A board that has gone away is not an error.
    const event: DibsEvent = { id, type, taskId, agentId, body, createdAt: now };
    const message = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // The socket closed between being listed and being written to.
      }
    }
  }

  // The board connects here and is sent every event from then on. Sockets
  // hibernate, so an idle board costs nothing while nothing happens.
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    // A browser that offered subprotocols drops the connection unless one of them is selected.
    const offered = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((protocol) => protocol.trim());
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      ...(offered.includes(SOCKET_SUBPROTOCOL) ? { headers: { "sec-websocket-protocol": SOCKET_SUBPROTOCOL } } : {}),
    });
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
  }

  // The most recent events, oldest first.
  async listEvents(limit = 100): Promise<DibsEvent[]> {
    return this.sql
      .exec<{ id: number; type: string; task_id: string | null; agent_id: string | null; body: string; created_at: number }>(
        "SELECT * FROM (SELECT * FROM events ORDER BY id DESC LIMIT ?) ORDER BY id",
        limit,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        type: row.type,
        taskId: row.task_id,
        agentId: row.agent_id,
        body: JSON.parse(row.body) as JsonObject,
        createdAt: row.created_at,
      }));
  }
}
