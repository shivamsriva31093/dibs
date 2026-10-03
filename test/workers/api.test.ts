import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi, type ApiDeps } from "../../src/api";
import { freezeTime, T0, type CoordinatorStub } from "./helpers/coordinator";
import { MemoryRepoHost } from "./helpers/memory-host";

beforeEach(() => freezeTime());
afterEach(() => vi.useRealTimers());

const ADMIN = "admin-secret-token";

interface Setup {
  deps: ApiDeps;
  host: MemoryRepoHost;
  seeds: { repo: string; files: Record<string, string> }[];
  reviews: { repo: string; submissionId: number; mergeOnly?: boolean }[];
  // The repository's Coordinator, for driving tasks directly.
  stub(repo: string): CoordinatorStub;
  call(method: string, path: string, body?: unknown, token?: string | null): Promise<{ status: number; body: any }>;
}

function setup(): Setup {
  // Unique names keep tests in this file apart: they share one storage.
  const suffix = crypto.randomUUID();
  const host = new MemoryRepoHost();
  const seeds: Setup["seeds"] = [];
  const reviews: Setup["reviews"] = [];
  const stub = (repo: string) => env.COORDINATOR.getByName(`${repo}-${suffix}`);
  const deps: ApiDeps = {
    adminToken: ADMIN,
    origin: "https://dibs.example.workers.dev",
    registry: env.REGISTRY.getByName(`registry-${suffix}`),
    coordinator: (repo) => stub(repo),
    host,
    seed: async (repo, files) => {
      seeds.push({ repo, files });
      const commit = await host.repo(repo).commit("main", files, "Initial commit\n");
      return { commit, created: true };
    },
    startReview: async (params) => {
      reviews.push(params);
    },
  };
  return {
    deps,
    host,
    seeds,
    reviews,
    stub,
    call: async (method, path, body, token = ADMIN) => {
      const response = await handleApi(
        new Request(`https://dibs.example.workers.dev${path}`, {
          method,
          headers: {
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        deps,
      );
      const text = await response.text();
      return { status: response.status, body: text === "" ? null : JSON.parse(text) };
    },
  };
}

const FILES = { "README.md": "# demo\n", "src/db/users.ts": "export const users = [];\n" };

async function registered(s: Setup, name = "demo-app") {
  const created = await s.call("POST", "/api/repos", { name, files: FILES });
  expect(created.status).toBe(201);
  return name;
}

async function agentKey(s: Setup, repo: string, name: string): Promise<{ id: string; key: string }> {
  const created = await s.call("POST", `/api/repos/${repo}/agents`, { name });
  expect(created.status).toBe(201);
  return created.body;
}

describe("authentication", () => {
  it.each([
    ["no token", null],
    ["a wrong token", "not-the-admin-token"],
  ])("refuses a request with %s", async (_label, token) => {
    const s = setup();

    const response = await s.call("GET", "/api/repos", undefined, token);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: { code: "unauthorized", message: "send the admin token as a bearer token" } });
  });

  it("accepts the admin token", async () => {
    const s = setup();

    expect((await s.call("GET", "/api/repos")).status).toBe(200);
  });
});

describe("POST /api/repos", () => {
  it("creates a repository with starting files and registers it", async () => {
    const s = setup();

    const response = await s.call("POST", "/api/repos", { name: "demo-app", files: FILES });

    expect(response).toEqual({
      status: 201,
      body: {
        name: "demo-app",
        remote: "https://git.example.invalid/demo-app.git",
        default_branch: "main",
        created: true,
        head: expect.stringMatching(/^[0-9a-f]{40}$/),
        mcp_url: "https://dibs.example.workers.dev/mcp/demo-app",
        // One of the two files is code dibs can read: it has one interface and uses no other file.
        index: { files: 1, interfaces: 1, references: 0, unread: 0 },
      },
    });
    expect(s.seeds).toEqual([{ repo: "demo-app", files: FILES }]);
    expect((await s.call("GET", "/api/repos")).body).toEqual({ repos: [{ name: "demo-app", created_at: new Date(T0).toISOString() }] });
    expect((await s.call("GET", "/api/repos/demo-app/state")).body.config.repoName).toBe("demo-app");
  });

  it("reads the repository's code into the interface index", async () => {
    const s = setup();
    const files = {
      "src/db/users.ts": "export function findUser(id: string): User | null { return null; }\n",
      "src/routes/get.ts": 'import { findUser } from "../db/users";\nexport const getRoute = findUser;\n',
    };

    const response = await s.call("POST", "/api/repos", { name: "demo-app", files });

    expect(response.body.index).toEqual({ files: 2, interfaces: 2, references: 1, unread: 0 });
    expect((await s.call("GET", "/api/repos/demo-app/state")).body.index).toEqual({ files: 2, interfaces: 2, references: 1 });
  });

  it("applies the repository settings it is given", async () => {
    const s = setup();

    await s.call("POST", "/api/repos", {
      name: "demo-app",
      files: FILES,
      protected_paths: ["infra/"],
      max_cycles: 2,
      claim_ttl_minutes: 45,
      decider_enabled: false,
    });

    expect((await s.call("GET", "/api/repos/demo-app/state")).body.config).toMatchObject({
      protectedPaths: ["infra/"],
      maxCycles: 2,
      claimTtlMinutes: 45,
      decider: { enabled: false },
    });
  });

  it("imports from another git remote when given a URL", async () => {
    const s = setup();
    const imported: unknown[] = [];
    s.host.importFrom = async (name, ...rest: unknown[]) => {
      imported.push([name, ...rest]);
      await s.host.seed(name, FILES);
      return { name, remote: `https://git.example.invalid/${name}.git`, defaultBranch: "main", token: "t" };
    };

    const response = await s.call("POST", "/api/repos", {
      name: "demo-app",
      import_url: "https://github.com/example/demo-app",
      branch: "main",
    });

    expect(response.status).toBe(201);
    expect(imported).toEqual([["demo-app", { url: "https://github.com/example/demo-app", branch: "main" }]]);
    expect(s.seeds).toEqual([]);
  });

  it("registers a repository that already exists instead of failing", async () => {
    const s = setup();
    await registered(s);

    const again = await s.call("POST", "/api/repos", { name: "demo-app", files: FILES });

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ name: "demo-app", created: false });
    expect((await s.call("GET", "/api/repos")).body.repos).toHaveLength(1);
  });

  it.each([
    ["an empty name", { name: "", files: FILES }],
    ["a name with a slash", { name: "a/b", files: FILES }],
    ["a name containing the fork separator", { name: "demo--app", files: FILES }],
    ["neither files nor an import URL", { name: "demo-app" }],
    ["both files and an import URL", { name: "demo-app", files: FILES, import_url: "https://github.com/example/demo-app" }],
    ["an import URL that is not https", { name: "demo-app", import_url: "git@github.com:example/demo-app.git" }],
  ])("refuses %s", async (_label, body) => {
    const s = setup();

    const response = await s.call("POST", "/api/repos", body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_input");
    expect((await s.call("GET", "/api/repos")).body.repos).toEqual([]);
  });
});

describe("POST /api/repos/:repo/agents", () => {
  it("creates an agent and returns its key and where to connect", async () => {
    const s = setup();
    const repo = await registered(s);

    const response = await s.call("POST", `/api/repos/${repo}/agents`, { name: "agent-one" });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.stringMatching(/^a-[a-z0-9]{8}$/),
      name: "agent-one",
      key: expect.stringMatching(/^dibs_/),
      mcp_url: "https://dibs.example.workers.dev/mcp/demo-app",
    });
  });

  it("refuses a name that is taken", async () => {
    const s = setup();
    const repo = await registered(s);
    await agentKey(s, repo, "agent-one");

    const response = await s.call("POST", `/api/repos/${repo}/agents`, { name: "agent-one" });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("already_exists");
  });

  it("is not found for a repository that is not registered", async () => {
    const s = setup();

    const response = await s.call("POST", "/api/repos/nope/agents", { name: "agent-one" });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("not_found");
  });
});

// Drives one task to an escalation, through the Coordinator directly.
async function escalatedTask(s: Setup, repo: string) {
  const coordinator = s.stub(repo);
  const agent = await agentKey(s, repo, "agent-one");
  const started = await coordinator.startTask({ agentId: agent.id, goal: "Bump the version", paths: ["src/db/users.ts"] });
  if (!started.ok) {
    throw new Error(started.error.message);
  }
  const forkName = started.task.forkName;
  await (await s.host.open(repo)).fork(forkName);
  const base = (await (await s.host.open(forkName)).head("main"))!.oid;
  await coordinator.attachFork(started.task.id, base);
  const head = await s.host.repo(forkName).commit("main", { "src/db/users.ts": "export const users = [1];\n" }, "work\n");
  const submission = await coordinator.submit({ agentId: agent.id, taskId: started.task.id, summary: "s", headSha: head });
  if (!submission.ok) {
    throw new Error(submission.error.message);
  }
  await coordinator.recordVerdict(submission.submissionId, {
    decision: "escalate",
    source: "reviewer",
    body: { decision: "approve", summary: "Looks fine", reasons: [{ kind: "interface_change", detail: "d" }] },
  });
  return { taskId: started.task.id, submissionId: submission.submissionId, agentId: agent.id };
}

describe("GET /api/repos/:repo/state", () => {
  it("returns the board's snapshot", async () => {
    const s = setup();
    const repo = await registered(s);
    const task = await escalatedTask(s, repo);

    const response = await s.call("GET", `/api/repos/${repo}/state`);

    expect(response.status).toBe(200);
    expect(response.body.tasks).toMatchObject([{ id: task.taskId, state: "escalated", agent: "agent-one" }]);
    expect(response.body.events.map((event: { type: string }) => event.type)).toEqual(["task_started", "submitted", "escalated"]);
  });

  it("is not found for a repository that is not registered", async () => {
    const s = setup();

    expect((await s.call("GET", "/api/repos/nope/state")).status).toBe(404);
  });
});

describe("POST /api/repos/:repo/escalations/:taskId", () => {
  it("approve puts the task back in review and starts a merge-only run", async () => {
    const s = setup();
    const repo = await registered(s);
    const task = await escalatedTask(s, repo);

    const response = await s.call("POST", `/api/repos/${repo}/escalations/${task.taskId}`, { decision: "approve", note: "Fine" });

    expect(response).toEqual({ status: 200, body: { task_id: task.taskId, state: "in_review" } });
    expect(s.reviews).toEqual([{ repo, submissionId: task.submissionId, mergeOnly: true }]);
  });

  it("send back returns the task to its agent and starts nothing", async () => {
    const s = setup();
    const repo = await registered(s);
    const task = await escalatedTask(s, repo);

    const response = await s.call("POST", `/api/repos/${repo}/escalations/${task.taskId}`, { decision: "send_back", note: "Keep the old signature" });

    expect(response).toEqual({ status: 200, body: { task_id: task.taskId, state: "active" } });
    expect(s.reviews).toEqual([]);
    const view = await s.stub(repo).getTask({ agentId: task.agentId, taskId: task.taskId });
    expect(view).toMatchObject({ ok: true, task: { verdict: { source: "human", body: { note: "Keep the old signature" } } } });
  });

  it("close ends the task", async () => {
    const s = setup();
    const repo = await registered(s);
    const task = await escalatedTask(s, repo);

    const response = await s.call("POST", `/api/repos/${repo}/escalations/${task.taskId}`, { decision: "close" });

    expect(response).toEqual({ status: 200, body: { task_id: task.taskId, state: "closed" } });
  });

  it("refuses a decision it does not know", async () => {
    const s = setup();
    const repo = await registered(s);
    const task = await escalatedTask(s, repo);

    const response = await s.call("POST", `/api/repos/${repo}/escalations/${task.taskId}`, { decision: "merge-it" });

    expect(response.status).toBe(400);
  });

  it("conflicts when the task is not waiting for a decision", async () => {
    const s = setup();
    const repo = await registered(s);
    const task = await escalatedTask(s, repo);
    await s.call("POST", `/api/repos/${repo}/escalations/${task.taskId}`, { decision: "close" });

    const response = await s.call("POST", `/api/repos/${repo}/escalations/${task.taskId}`, { decision: "approve" });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("bad_state");
    expect(s.reviews).toEqual([]);
  });

  it("escalates again, with the error, when the merge run cannot be started", async () => {
    const s = setup();
    const repo = await registered(s);
    const task = await escalatedTask(s, repo);
    s.deps.startReview = async () => {
      throw new Error("workflow service unavailable");
    };

    const response = await s.call("POST", `/api/repos/${repo}/escalations/${task.taskId}`, { decision: "approve" });

    expect(response).toEqual({ status: 200, body: { task_id: task.taskId, state: "escalated" } });
  });
});

describe("GET /api/repos/:repo/tasks/:taskId/diff", () => {
  it("returns the diff of the task's latest submission", async () => {
    const s = setup();
    const repo = await registered(s);
    const task = await escalatedTask(s, repo);

    const response = await s.call("GET", `/api/repos/${repo}/tasks/${task.taskId}/diff`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      files: [{ path: "src/db/users.ts", status: "modified" }],
      unreviewable: [],
      truncated: false,
    });
    expect(response.body.files[0].text).toContain("+export const users = [1];");
  });

  it("is not found for a task that does not exist or has nothing submitted", async () => {
    const s = setup();
    const repo = await registered(s);

    expect((await s.call("GET", `/api/repos/${repo}/tasks/t-missing0/diff`)).status).toBe(404);
  });
});

describe("POST /api/repos/:repo/read-token", () => {
  it("gives a short-lived token that can read the main repository, never write it", async () => {
    const s = setup();
    const repo = await registered(s);

    const response = await s.call("POST", `/api/repos/${repo}/read-token`);

    expect(response).toEqual({
      status: 200,
      body: {
        remote: "https://git.example.invalid/demo-app.git",
        token: "token-demo-app-read",
        expires_in_seconds: 3600,
        clone_command:
          'git -c http.extraHeader="Authorization: Bearer token-demo-app-read" clone https://git.example.invalid/demo-app.git',
      },
    });
    expect(s.host.tokensIssued).toEqual([{ repo: "demo-app", scope: "read", ttlSeconds: 3600 }]);
  });
});

describe("GET /api/repos/:repo/ws", () => {
  const upgrade = (s: Setup, repo: string, headers: Record<string, string>, query = "") =>
    handleApi(
      new Request(`https://dibs.example.workers.dev/api/repos/${repo}/ws${query}`, { headers: { upgrade: "websocket", ...headers } }),
      s.deps,
    );

  // What the board offers: the name of the protocol, and the token in a form a subprotocol may take.
  const offer = (token: string) => `dibs, token.${btoa(token).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

  it("opens the live connection for the admin token offered as a subprotocol", async () => {
    const s = setup();
    const repo = await registered(s);

    const response = await upgrade(s, repo, { "sec-websocket-protocol": offer(ADMIN) });

    expect(response.status).toBe(101);
    expect(response.headers.get("sec-websocket-protocol")).toBe("dibs");
    response.webSocket!.accept();
    response.webSocket!.close();
  });

  it("opens the live connection for the admin token sent as a bearer token", async () => {
    const s = setup();
    const repo = await registered(s);

    const response = await upgrade(s, repo, { authorization: `Bearer ${ADMIN}` });

    expect(response.status).toBe(101);
    response.webSocket!.accept();
    response.webSocket!.close();
  });

  it.each([
    ["no token", {}],
    ["a wrong token", { "sec-websocket-protocol": offer("not-the-admin-token") }],
    ["a subprotocol that carries no token", { "sec-websocket-protocol": "dibs" }],
    ["a token that is not base64", { "sec-websocket-protocol": "dibs, token.%%%" }],
  ])("refuses the live connection with %s", async (_label, headers) => {
    const s = setup();
    const repo = await registered(s);

    const response = await upgrade(s, repo, headers);

    expect(response.status).toBe(401);
    await response.body?.cancel();
  });

  it("does not take the token from the URL, where it would end up in request logs", async () => {
    const s = setup();
    const repo = await registered(s);

    const response = await upgrade(s, repo, {}, `?token=${ADMIN}`);

    expect(response.status).toBe(401);
    await response.body?.cancel();
  });

  it("takes the offered token only on the live connection, not on other routes", async () => {
    const s = setup();
    const repo = await registered(s);

    const response = await handleApi(
      new Request(`https://dibs.example.workers.dev/api/repos/${repo}/state`, { headers: { "sec-websocket-protocol": offer(ADMIN) } }),
      s.deps,
    );

    expect(response.status).toBe(401);
    await response.body?.cancel();
  });
});

describe("routing", () => {
  it("is not found for a path it does not serve", async () => {
    const s = setup();

    expect((await s.call("GET", "/api/nothing-here")).status).toBe(404);
  });

  it("refuses a method a route does not support", async () => {
    const s = setup();

    expect((await s.call("DELETE", "/api/repos")).status).toBe(405);
  });

  it("refuses a body that is not JSON", async () => {
    const s = setup();

    const response = await handleApi(
      new Request("https://dibs.example.workers.dev/api/repos", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
        body: "{not json",
      }),
      s.deps,
    );

    expect(response.status).toBe(400);
    await response.body?.cancel();
  });
});

describe("POST /api/repos/:repo/index", () => {
  it("reads the main branch into the interface index again, in place of what the index held", async () => {
    const s = setup();
    await registered(s);
    // The main branch gains a file without dibs landing it, as when a repository is changed from outside.
    await s.host.repo("demo-app").commit("main", { "src/new.ts": 'import { users } from "./db/users";\nexport const count = users.length;\n' }, "more\n");

    const response = await s.call("POST", "/api/repos/demo-app/index");

    expect(response).toEqual({ status: 200, body: { files: 2, interfaces: 2, references: 1, unread: 0 } });
  });

  it("is not found for a repository that is not registered", async () => {
    const s = setup();

    expect((await s.call("POST", "/api/repos/nope/index")).status).toBe(404);
  });

  it("is refused for any method but POST", async () => {
    const s = setup();
    await registered(s);

    expect((await s.call("GET", "/api/repos/demo-app/index")).status).toBe(405);
  });
});
