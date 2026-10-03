import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMcp } from "../../src/mcp";
import type { ToolDeps } from "../../src/tools";
import { freezeTime, newCoordinator, type CoordinatorStub } from "./helpers/coordinator";
import { FakeDecider } from "./helpers/fakes";
import { MemoryRepoHost } from "./helpers/memory-host";

beforeEach(() => freezeTime());
afterEach(() => vi.useRealTimers());

const ENDPOINT = "http://localhost/mcp/demo-app";

interface Setup {
  coordinator: CoordinatorStub;
  host: MemoryRepoHost;
  deps: ToolDeps;
  reviews: number[];
  keyFor(name: string): Promise<{ id: string; key: string }>;
  fetch(request: Request): Promise<Response>;
  connect(key: string): Promise<Client>;
}

async function setup(): Promise<Setup> {
  const coordinator = await newCoordinator();
  const host = new MemoryRepoHost();
  await host.seed("demo-app", { "README.md": "# demo\n" });
  const reviews: number[] = [];
  const deps: ToolDeps = {
    repo: "demo-app",
    coordinator,
    host,
    decider: new FakeDecider(),
    startReview: async ({ submissionId }) => {
      reviews.push(submissionId);
    },
    sleep: async () => {},
  };

  // Routes the real MCP client's HTTP requests straight into the handler, with no network.
  const fetch = async (incoming: Request): Promise<Response> => {
    // A request that arrives over HTTP always has a Host header; one built in memory does not.
    const headers = new Headers(incoming.headers);
    headers.set("host", new URL(incoming.url).host);
    const request = new Request(incoming, { headers });
    const ctx = createExecutionContext();
    const response = await handleMcp(request, env, ctx, { tools: deps, authenticate: (key) => coordinator.authenticate(key) });
    await waitOnExecutionContext(ctx);
    return response;
  };

  return {
    coordinator,
    host,
    deps,
    reviews,
    fetch,
    keyFor: async (name) => {
      const created = await coordinator.createAgent(name);
      if (!created.ok) {
        throw new Error(created.error.message);
      }
      return { id: created.agent.id, key: created.key };
    },
    connect: async (key) => {
      const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
        authProvider: { token: async () => key },
        fetch: (input, init) => fetch(new Request(input, init)),
      });
      const client = new Client({ name: "test-agent", version: "1.0.0" });
      await client.connect(transport);
      return client;
    },
  };
}

// Tool results carry one JSON text block.
function payload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const [block] = result.content as { type: string; text: string }[];
  if (block === undefined || block.type !== "text") {
    throw new Error("expected one text block in the tool result");
  }
  return JSON.parse(block.text) as Record<string, unknown>;
}

describe("authentication", () => {
  const listTools = (headers: Record<string, string>) =>
    new Request(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  it("refuses a request without a key", async () => {
    const s = await setup();

    const response = await s.fetch(listTools({}));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    await response.body?.cancel();
  });

  it("refuses a key that was not issued for this repository", async () => {
    const s = await setup();
    await s.keyFor("agent-one");

    const response = await s.fetch(listTools({ authorization: "Bearer dibs_not-a-real-key" }));

    expect(response.status).toBe(401);
    await response.body?.cancel();
  });
});

describe("tools over MCP", () => {
  it("lists the ten tools, each with a description and an input schema", async () => {
    const s = await setup();
    const client = await s.connect((await s.keyFor("agent-one")).key);

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "abandon",
      "declare_interface_change",
      "expand_claim",
      "expand_scope",
      "get_verdict",
      "peek",
      "start_task",
      "submit",
      "sync_with_main",
      "whats_happening",
    ]);
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  // A goal is not required of a call that only picks up a request that is waiting.
  it("lets start_task be called with paths, with a scope, or with a request that is waiting", async () => {
    const s = await setup();
    const client = await s.connect((await s.keyFor("agent-one")).key);

    const { tools } = await client.listTools();
    const startTask = tools.find((tool) => tool.name === "start_task")!;

    expect(Object.keys(startTask.inputSchema.properties ?? {}).sort()).toEqual([
      "goal",
      "paths",
      "request_id",
      "scope",
      "ttl_minutes",
      "wait_seconds",
    ]);
    expect(startTask.inputSchema.required ?? []).toEqual([]);
  });

  it("start_task takes a scope with relations and says how the task stands with the others", async () => {
    const s = await setup();
    const client = await s.connect((await s.keyFor("agent-one")).key);

    const result = await client.callTool({
      name: "start_task",
      arguments: {
        goal: "Add a route",
        scope: [
          { target: "src/routes/get.ts", relation: "change" },
          { target: "src/routes/index.ts", relation: "add" },
          { target: "src/db/users.ts#findUser", relation: "rely" },
        ],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({
      paths: ["src/routes/get.ts", "src/routes/index.ts"],
      scope: [
        { target: "src/routes/get.ts", relation: "change", origin: "declared" },
        { target: "src/routes/index.ts", relation: "add", origin: "declared" },
        { target: "src/db/users.ts#findUser", relation: "rely", origin: "declared" },
      ],
      collisions: [],
      dependents: [],
    });
  });

  it("refuses a relation it does not know before the tool runs", async () => {
    const s = await setup();
    const client = await s.connect((await s.keyFor("agent-one")).key);

    const outcome = await client
      .callTool({ name: "start_task", arguments: { goal: "g", scope: [{ target: "src/a.ts", relation: "own" }] } })
      .then(
        (result) => ({ rejected: result.isError === true }),
        () => ({ rejected: true }),
      );

    expect(outcome.rejected).toBe(true);
    expect((await s.coordinator.whatsHappening()).tasks).toEqual([]);
  });

  it("start_task runs as the agent the key belongs to and returns a fork to work in", async () => {
    const s = await setup();
    const agent = await s.keyFor("agent-one");
    const client = await s.connect(agent.key);

    const result = await client.callTool({
      name: "start_task",
      arguments: { goal: "Add a users endpoint", paths: ["src/routes/users/"] },
    });

    expect(result.isError ?? false).toBe(false);
    const data = payload(result);
    expect(data).toMatchObject({ branch: "main", paths: ["src/routes/users/"], related_check: "ok" });
    expect(await s.coordinator.getTask({ agentId: agent.id, taskId: data.task_id as string })).toMatchObject({
      ok: true,
      task: { agent: "agent-one", goal: "Add a users endpoint", state: "active" },
    });
  });

  it("returns a refused claim as a tool error that names the holder", async () => {
    const s = await setup();
    const one = await s.connect((await s.keyFor("agent-one")).key);
    const two = await s.connect((await s.keyFor("agent-two")).key);
    await one.callTool({ name: "start_task", arguments: { goal: "Add users", paths: ["src/routes/users/"] } });

    const result = await two.callTool({
      name: "start_task",
      arguments: { goal: "Add limits", paths: ["src/routes/users/limits.ts"] },
    });

    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      error: { code: "conflict", retryable: true },
      conflicts: [{ agent: "agent-one", goal: "Add users", paths: ["src/routes/users/"] }],
    });
  });

  it("carries a task from start to submit to verdict", async () => {
    const s = await setup();
    const client = await s.connect((await s.keyFor("agent-one")).key);
    const started = payload(
      await client.callTool({ name: "start_task", arguments: { goal: "Edit the readme", paths: ["README.md"] } }),
    );
    const taskId = started.task_id as string;
    await s.host.repo(`demo-app--${taskId}`).commit("main", { "README.md": "# demo, edited\n" }, "edit\n");

    const submitted = payload(await client.callTool({ name: "submit", arguments: { task_id: taskId, summary: "Edited" } }));
    const verdict = payload(await client.callTool({ name: "get_verdict", arguments: { task_id: taskId } }));

    expect(submitted).toMatchObject({ submission_id: 1, status: "in_review" });
    expect(s.reviews).toEqual([1]);
    expect(verdict).toMatchObject({ task_id: taskId, state: "in_review", verdict: null });
  });

  it("does not let one agent act on another agent's task", async () => {
    const s = await setup();
    const one = await s.connect((await s.keyFor("agent-one")).key);
    const two = await s.connect((await s.keyFor("agent-two")).key);
    const started = payload(await one.callTool({ name: "start_task", arguments: { goal: "g", paths: ["a.ts"] } }));

    const result = await two.callTool({ name: "abandon", arguments: { task_id: started.task_id } });

    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: { code: "not_owner" } });
  });

  it("rejects arguments that do not match a tool's schema, without running the tool", async () => {
    const s = await setup();
    const client = await s.connect((await s.keyFor("agent-one")).key);

    const outcome = await client
      .callTool({ name: "start_task", arguments: { goal: "no paths given" } })
      .then(
        (result) => ({ rejected: result.isError === true }),
        () => ({ rejected: true }),
      );

    expect(outcome.rejected).toBe(true);
    expect((await s.coordinator.whatsHappening()).tasks).toEqual([]);
  });

  it("whats_happening shows every agent's live work", async () => {
    const s = await setup();
    const one = await s.connect((await s.keyFor("agent-one")).key);
    const two = await s.connect((await s.keyFor("agent-two")).key);
    await one.callTool({ name: "start_task", arguments: { goal: "Add users", paths: ["src/routes/users/"] } });

    const data = payload(await two.callTool({ name: "whats_happening", arguments: {} }));

    expect(data).toMatchObject({
      repository: "demo-app",
      live_tasks: [{ agent: "agent-one", goal: "Add users", paths: ["src/routes/users/"] }],
      recent_merges: [],
    });
  });
});
