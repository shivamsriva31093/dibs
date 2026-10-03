// Registers the demo repository with a deployed dibs and creates the five demo agents.
//
//   DIBS_URL=https://dibs.<subdomain>.workers.dev DIBS_ADMIN_TOKEN=... node scripts/setup-demo.ts [repo-name]
//
// Agent keys are shown only once, so each run registers a fresh repository unless a name is given.
// The keys and one MCP config per agent are written to .demo/<repo>/, which git ignores.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_NAMES, api, DIBS_URL, readTree, requireConfig } from "./lib.ts";

requireConfig();

const repo = process.argv[2] ?? `demo-${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "")}`;
const root = join(import.meta.dirname, "..");

const registered = await api<{ head: string; mcp_url: string; error?: { message: string } }>("POST", "/api/repos", {
  name: repo,
  files: readTree(join(root, "demo-app")),
});
if (registered.status !== 201 && registered.status !== 200) {
  console.error(`Could not register ${repo}: ${registered.body.error?.message ?? registered.status}`);
  process.exit(1);
}
console.log(`Registered ${repo} at ${registered.body.head.slice(0, 7)}`);

const outDir = join(root, ".demo", repo);
mkdirSync(outDir, { recursive: true });
const agents: Record<string, { id: string; key: string }> = {};
for (const name of AGENT_NAMES) {
  const created = await api<{ id: string; key: string; mcp_url: string; error?: { message: string } }>(
    "POST",
    `/api/repos/${repo}/agents`,
    { name },
  );
  if (created.status !== 201) {
    console.error(`Could not create ${name}: ${created.body.error?.message ?? created.status}`);
    process.exit(1);
  }
  agents[name] = { id: created.body.id, key: created.body.key };
  writeFileSync(
    join(outDir, `${name}.mcp.json`),
    `${JSON.stringify(
      {
        mcpServers: {
          dibs: { type: "http", url: created.body.mcp_url, headers: { Authorization: `Bearer ${created.body.key}` } },
        },
      },
      null,
      2,
    )}\n`,
  );
}
writeFileSync(join(outDir, "agents.json"), `${JSON.stringify({ repo, url: DIBS_URL, agents }, null, 2)}\n`);

console.log(`Created ${AGENT_NAMES.length} agents. Keys and MCP configs are in .demo/${repo}/`);
console.log(`Board: ${DIBS_URL}/?repo=${repo}`);
console.log(`Run the agents: scripts/demo.sh ${repo}`);
