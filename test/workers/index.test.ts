import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const call = (path: string, init: RequestInit = {}) => exports.default.fetch(new Request(`https://dibs.example.workers.dev${path}`, init));

describe("the Worker's routes", () => {
  it("guards the API with the admin token", async () => {
    const refused = await call("/api/repos");
    const allowed = await call("/api/repos", { headers: { authorization: "Bearer test-admin-token" } });

    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ repos: [] });
  });

  it("guards a repository's MCP endpoint with the agent's key", async () => {
    const response = await call("/mcp/demo-app", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it.each(["/mcp", "/mcp/", "/mcp/demo-app/extra", "/mcp/bad name", "/nothing"])("is not found at %s", async (path) => {
    const response = await call(path);

    expect(response.status).toBe(404);
    await response.body?.cancel();
  });
});
