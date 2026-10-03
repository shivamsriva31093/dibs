// The HTTP API for people and for the board: register repositories, create
// agents, read the state, decide escalations, and rebuild the interface index.
// Every route needs the admin token.

import * as z from "zod";
import type {
  BoardTask,
  CreateAgentResult,
  EscalationDecision,
  EscalationResult,
  RecordVerdictResult,
  Snapshot,
  VerdictInput,
} from "./coordinator";
import { buildDiff } from "./diff";
import { diffTrees } from "./git/changes";
import { indexTree } from "./index/build";
import type { IndexedFile } from "./index/file";
import type { RegisteredRepo } from "./registry";
import { openWhenReady, RepoHostError, type RepoHost } from "./repo-host";
import { DEFAULT_DECIDER_CONFIG, type ErrorCode, type RepoConfig } from "./types";

// The Coordinator calls the API makes. The Durable Object stub satisfies this.
export interface ApiCoordinatorPort {
  init(config: Partial<RepoConfig> & { repoName: string }): Promise<RepoConfig>;
  getConfig(): Promise<RepoConfig | null>;
  createAgent(name: string): Promise<CreateAgentResult>;
  snapshot(): Promise<Snapshot | null>;
  inspectTask(taskId: string): Promise<BoardTask | null>;
  decideEscalation(request: EscalationDecision): Promise<EscalationResult>;
  recordVerdict(submissionId: number, verdict: VerdictInput): Promise<RecordVerdictResult>;
  indexFiles(update: {
    files: IndexedFile[];
    removed: string[];
    sha: string;
    reset?: boolean;
  }): Promise<{ files: number; interfaces: number; references: number }>;
  fetch(request: Request): Promise<Response>;
}

export interface RegistryPort {
  add(name: string): Promise<{ created: boolean }>;
  list(): Promise<RegisteredRepo[]>;
}

export interface ApiDeps {
  adminToken: string;
  // The public origin of this deployment, used to tell agents where to connect.
  origin: string;
  registry: RegistryPort;
  coordinator(repo: string): ApiCoordinatorPort;
  host: RepoHost;
  seed(repo: string, files: Record<string, string>): Promise<{ commit: string; created: boolean }>;
  startReview(params: { repo: string; submissionId: number; mergeOnly?: boolean }): Promise<void>;
  sleep?(ms: number): Promise<void>;
}

type ApiErrorCode = ErrorCode | "unauthorized" | "method_not_allowed";

const STATUS: Partial<Record<ApiErrorCode, number>> = {
  unauthorized: 401,
  invalid_input: 400,
  invalid_path: 400,
  not_found: 404,
  not_registered: 404,
  method_not_allowed: 405,
  already_exists: 409,
  bad_state: 409,
  conflict: 409,
};

function fail(code: ApiErrorCode, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { code, message } }, { status: STATUS[code] ?? 500, headers });
}

// "--" separates a repository name from a task id in fork names, so a repository name may not contain it.
const RepoName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,49}$/, "2 to 50 letters, digits, dots, underscores or hyphens, starting with a letter or digit")
  .refine((name) => !name.includes("--"), 'must not contain "--"');

const RegisterBody = z
  .object({
    name: RepoName,
    files: z.record(z.string(), z.string()).optional(),
    import_url: z.string().regex(/^https:\/\/\S+$/, "must be an https URL").optional(),
    branch: z.string().min(1).optional(),
    protected_paths: z.array(z.string()).optional(),
    max_cycles: z.number().int().min(1).max(10).optional(),
    claim_ttl_minutes: z.number().int().min(1).max(480).optional(),
    decider_enabled: z.boolean().optional(),
  })
  .refine((body) => (body.files === undefined) !== (body.import_url === undefined), {
    message: "give either files or import_url, not both",
  });

const AgentBody = z.object({ name: z.string() });
const DecisionBody = z.object({ decision: z.enum(["approve", "send_back", "close"]), note: z.string().optional() });

async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return { ok: false, response: fail("invalid_input", "the request body must be JSON") };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
    return { ok: false, response: fail("invalid_input", detail) };
  }
  return { ok: true, value: parsed.data };
}

async function sameSecret(given: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

const TOKEN_SUBPROTOCOL = "token.";

// A browser cannot set headers on a WebSocket, but it can offer subprotocols. The
// board offers the admin token as one, base64url-encoded. That keeps the token out
// of the URL, and so out of request logs.
function offeredToken(request: Request): string | null {
  const offered = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((protocol) => protocol.trim());
  const carrier = offered.find((protocol) => protocol.startsWith(TOKEN_SUBPROTOCOL));
  if (carrier === undefined) {
    return null;
  }
  try {
    const base64 = carrier.slice(TOKEN_SUBPROTOCOL.length).replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function isAdmin(request: Request, deps: ApiDeps, isSocket: boolean): Promise<boolean> {
  const header = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  const given = header?.[1] ?? (isSocket ? offeredToken(request) : null);
  return given !== null && given !== "" && deps.adminToken !== "" && (await sameSecret(given, deps.adminToken));
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Reads the main branch into the repository's interface index, in place of whatever the index held.
// `unread` counts files left out because the repository has more code than is read in one go.
async function readIntoIndex(
  deps: ApiDeps,
  repo: string,
  branch: string,
): Promise<{ files: number; interfaces: number; references: number; unread: number }> {
  using handle = await deps.host.open(repo);
  const head = await handle.head(branch);
  if (head === null) {
    return { files: 0, interfaces: 0, references: 0, unread: 0 };
  }
  const built = await indexTree(handle, head.tree);
  const status = await deps.coordinator(repo).indexFiles({ files: built.files, removed: [], sha: head.oid, reset: true });
  return { ...status, unread: built.skipped };
}

async function registerRepo(request: Request, deps: ApiDeps): Promise<Response> {
  const body = await readBody(request, RegisterBody);
  if (!body.ok) {
    return body.response;
  }
  const { name, files, import_url: importUrl, branch } = body.value;

  try {
    if (importUrl !== undefined) {
      await deps.host.importFrom(name, { url: importUrl, ...(branch === undefined ? {} : { branch }) });
    } else {
      await deps.host.create(name);
    }
  } catch (error) {
    // Registering a repository that is already there is fine: it makes this call safe to repeat.
    if (!(error instanceof RepoHostError) || error.code !== "already_exists") {
      throw error;
    }
  }

  let remote: string;
  let defaultBranch: string;
  let head: string | null;
  {
    using repo = await openWhenReady(deps.host, name, deps.sleep ?? sleepFor);
    remote = await repo.remote();
    defaultBranch = await repo.defaultBranch();
    head = (await repo.head(defaultBranch))?.oid ?? null;
  }
  if (head === null && files !== undefined) {
    head = (await deps.seed(name, files)).commit;
  }

  await deps.coordinator(name).init({
    repoName: name,
    defaultBranch,
    ...(body.value.protected_paths === undefined ? {} : { protectedPaths: body.value.protected_paths }),
    ...(body.value.max_cycles === undefined ? {} : { maxCycles: body.value.max_cycles }),
    ...(body.value.claim_ttl_minutes === undefined ? {} : { claimTtlMinutes: body.value.claim_ttl_minutes }),
    ...(body.value.decider_enabled === undefined
      ? {}
      : { decider: { ...DEFAULT_DECIDER_CONFIG, enabled: body.value.decider_enabled } }),
  });
  const { created } = await deps.registry.add(name);
  const index = await readIntoIndex(deps, name, defaultBranch);
  return Response.json(
    { name, remote, default_branch: defaultBranch, created, head, mcp_url: `${deps.origin}/mcp/${name}`, index },
    { status: created ? 201 : 200 },
  );
}

async function createAgent(request: Request, deps: ApiDeps, repo: string): Promise<Response> {
  const body = await readBody(request, AgentBody);
  if (!body.ok) {
    return body.response;
  }
  const created = await deps.coordinator(repo).createAgent(body.value.name);
  if (!created.ok) {
    return fail(created.error.code, created.error.message);
  }
  return Response.json(
    { id: created.agent.id, name: created.agent.name, key: created.key, mcp_url: `${deps.origin}/mcp/${repo}` },
    { status: 201 },
  );
}

async function decideEscalation(request: Request, deps: ApiDeps, repo: string, taskId: string): Promise<Response> {
  const body = await readBody(request, DecisionBody);
  if (!body.ok) {
    return body.response;
  }
  const coordinator = deps.coordinator(repo);
  const decided = await coordinator.decideEscalation({ taskId, ...body.value });
  if (!decided.ok) {
    return fail(decided.error.code, decided.error.message);
  }

  let state = decided.state;
  if (body.value.decision === "approve") {
    try {
      await deps.startReview({ repo, submissionId: decided.submissionId, mergeOnly: true });
    } catch (error) {
      // The approval stands, but nothing is merging it: put it back in front of a person.
      const recorded = await coordinator.recordVerdict(decided.submissionId, {
        decision: "escalate",
        source: "system",
        body: { step: "start", error: error instanceof Error ? error.message : String(error) },
      });
      state = recorded.ok ? recorded.state : state;
    }
  }
  return Response.json({ task_id: taskId, state });
}

async function taskDiff(deps: ApiDeps, repo: string, taskId: string): Promise<Response> {
  const task = await deps.coordinator(repo).inspectTask(taskId);
  if (task === null || task.submission === null || task.baseSha === null) {
    return fail("not_found", `task ${taskId} has no submission to show`);
  }
  using fork = await deps.host.open(task.forkName);
  const [base, head] = await Promise.all([fork.readCommit(task.baseSha), fork.readCommit(task.submission.headSha)]);
  if (base === null || head === null) {
    return fail("not_found", `the commits of task ${taskId} are missing from its fork`);
  }
  const diff = await buildDiff(fork, await diffTrees(fork, base.tree, head.tree));
  return Response.json(diff);
}

const READ_TOKEN_TTL_SECONDS = 60 * 60;

// For people who want to look at the main branch with their own git client. Read only:
// writing to main stays with dibs.
async function readToken(deps: ApiDeps, repo: string): Promise<Response> {
  using handle = await deps.host.open(repo);
  const remote = await handle.remote();
  const token = await handle.createToken("read", READ_TOKEN_TTL_SECONDS);
  return Response.json({
    remote,
    token,
    expires_in_seconds: READ_TOKEN_TTL_SECONDS,
    clone_command: `git -c http.extraHeader="Authorization: Bearer ${token}" clone ${remote}`,
  });
}

export async function handleApi(request: Request, deps: ApiDeps): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  // segments[0] is "api".
  const [, resource, repo, sub, taskId, leaf] = segments;
  const isSocket = resource === "repos" && sub === "ws" && segments.length === 4;

  if (!(await isAdmin(request, deps, isSocket))) {
    return fail("unauthorized", "send the admin token as a bearer token", { "www-authenticate": "Bearer" });
  }
  if (resource !== "repos") {
    return fail("not_found", `no such route: ${url.pathname}`);
  }

  const method = request.method;
  const wrongMethod = () => fail("method_not_allowed", `${method} is not supported on ${url.pathname}`);

  if (segments.length === 2) {
    if (method === "POST") {
      return registerRepo(request, deps);
    }
    if (method === "GET") {
      const repos = await deps.registry.list();
      return Response.json({
        repos: repos.map((entry) => ({ name: entry.name, created_at: new Date(entry.createdAt).toISOString() })),
      });
    }
    return wrongMethod();
  }

  if (repo === undefined || !RepoName.safeParse(repo).success || (await deps.coordinator(repo).getConfig()) === null) {
    return fail("not_found", `repository ${repo ?? ""} is not registered`);
  }

  if (segments.length === 4 && sub === "agents") {
    return method === "POST" ? createAgent(request, deps, repo) : wrongMethod();
  }
  if (segments.length === 4 && sub === "read-token") {
    return method === "POST" ? readToken(deps, repo) : wrongMethod();
  }
  if (segments.length === 4 && sub === "index") {
    if (method !== "POST") {
      return wrongMethod();
    }
    const config = (await deps.coordinator(repo).getConfig())!;
    return Response.json(await readIntoIndex(deps, repo, config.defaultBranch));
  }
  if (segments.length === 4 && sub === "state") {
    return method === "GET" ? Response.json(await deps.coordinator(repo).snapshot()) : wrongMethod();
  }
  if (isSocket) {
    return method === "GET" ? deps.coordinator(repo).fetch(request) : wrongMethod();
  }
  if (segments.length === 5 && sub === "escalations" && taskId !== undefined) {
    return method === "POST" ? decideEscalation(request, deps, repo, taskId) : wrongMethod();
  }
  if (segments.length === 6 && sub === "tasks" && taskId !== undefined && leaf === "diff") {
    return method === "GET" ? taskDiff(deps, repo, taskId) : wrongMethod();
  }
  return fail("not_found", `no such route: ${url.pathname}`);
}
