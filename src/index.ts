// The Worker's entry point. It routes three things:
//   /mcp/<repo>   the MCP server agents connect to
//   /api/...      the HTTP API for people and the board
//   anything else the board's static files

import { handleApi } from "./api";
import { decider, repoHost, reviewStarter } from "./deps";
import { handleMcp } from "./mcp";
import { seedRepository } from "./seed";

export { Coordinator } from "./coordinator";
export { GateRunner, GitGateway } from "./gate-runner";
export { Registry } from "./registry";
export { ReviewWorkflow } from "./workflow";

const MCP_PATH = /^\/mcp\/([A-Za-z0-9][A-Za-z0-9._-]{1,49})$/;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    const mcp = MCP_PATH.exec(url.pathname);
    if (mcp !== null) {
      const repo = mcp[1]!;
      const coordinator = env.COORDINATOR.getByName(repo);
      return handleMcp(request, env, ctx, {
        authenticate: (key) => coordinator.authenticate(key),
        tools: {
          repo,
          coordinator,
          host: repoHost(env),
          decider: decider(env),
          startReview: reviewStarter(env.REVIEW_WORKFLOW),
          sleep,
        },
      });
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const host = repoHost(env);
      return handleApi(request, {
        adminToken: env.ADMIN_TOKEN,
        origin: url.origin,
        registry: env.REGISTRY.getByName("registry"),
        coordinator: (repo) => env.COORDINATOR.getByName(repo),
        host,
        seed: (repo, files) => seedRepository(host, repo, files, { now: Math.floor(Date.now() / 1000) }),
        startReview: reviewStarter(env.REVIEW_WORKFLOW),
        sleep,
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
