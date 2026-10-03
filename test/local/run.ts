// Runs dibs on this machine: the Worker under `wrangler dev`, next to a stand-in
// for the Cloudflare services it uses (platform.ts). Nothing leaves the machine
// and no Cloudflare account is needed.
//
//   node test/local/run.ts                   start it and leave it running
//   node test/local/run.ts --e2e             start it, run scripts/e2e.ts against it, then stop
//   node test/local/run.ts --real-reviewer   review with the real model: needs ANTHROPIC_API_KEY in
//                                            the environment, and sends the diffs under review to Anthropic
//
// The ports can be changed with DIBS_PORT (8787) and PLATFORM_PORT (8788).

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlatform } from "./platform.ts";

const root = join(import.meta.dirname, "../..");
const dibsPort = Number(process.env.DIBS_PORT ?? 8787);
const platformPort = Number(process.env.PLATFORM_PORT ?? 8788);
const runE2e = process.argv.includes("--e2e");
const realReviewer = process.argv.includes("--real-reviewer");
if (realReviewer && !process.env.ANTHROPIC_API_KEY) {
  console.error("--real-reviewer needs ANTHROPIC_API_KEY in the environment.");
  process.exit(2);
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}
for (const [variable, port] of [
  ["DIBS_PORT", dibsPort],
  ["PLATFORM_PORT", platformPort],
] as const) {
  if (!(await portIsFree(port))) {
    console.error(`Port ${port} is in use. Set ${variable} to another port.`);
    process.exit(2);
  }
}

const scratch = mkdtempSync(join(tmpdir(), "dibs-local-"));
const logPath = join(scratch, "wrangler.log");
const dibsUrl = `http://127.0.0.1:${dibsPort}`;
// Guards the API of this run only; it is made up afresh each time.
const adminToken = `local-${randomBytes(12).toString("hex")}`;

if (!existsSync(join(root, "board/dist/index.html"))) {
  console.log("Building the board first");
  const built = spawnSync("pnpm", ["build:board"], { cwd: root, stdio: "inherit" });
  if (built.status !== 0) {
    process.exit(built.status ?? 1);
  }
}

mkdirSync(join(scratch, "repos"));
const platform = await startPlatform({ root: join(scratch, "repos"), port: platformPort });

const wrangler = spawn(
  process.execPath,
  [
    join(root, "node_modules/wrangler/bin/wrangler.js"),
    "dev",
    "--config",
    join(root, "test/local/wrangler.jsonc"),
    "--ip",
    "127.0.0.1",
    "--port",
    String(dibsPort),
    "--persist-to",
    join(scratch, "state"),
    "--var",
    `PLATFORM_URL:${platform.url}`,
    // Without this, the reviewer's requests go to Anthropic; with it, to the stand-in.
    ...(realReviewer ? [] : ["--var", `ANTHROPIC_BASE_URL:${platform.url}`]),
    "--show-interactive-dev-session=false",
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      ADMIN_TOKEN: adminToken,
      // A placeholder unless the real reviewer was asked for, so that a key in the environment is never sent to the stand-in.
      ...(realReviewer ? {} : { ANTHROPIC_API_KEY: "local-stand-in" }),
      WRANGLER_SEND_METRICS: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const log = createWriteStream(logPath);
wrangler.stdout.pipe(log);
wrangler.stderr.pipe(log);

let stopping = false;
async function stop(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    if (wrangler.exitCode === null) {
      const exited = new Promise((resolve) => wrangler.once("exit", resolve));
      wrangler.kill("SIGTERM");
      const killer = setTimeout(() => wrangler.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(killer);
    }
    await platform.close();
    if (code === 0) {
      rmSync(scratch, { recursive: true, force: true });
    } else {
      console.error(`\nThe Worker's log and the repositories of this run were kept in ${scratch}`);
    }
  }
  process.exit(code);
}
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

async function waitUntilUp(): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (wrangler.exitCode !== null) {
      throw new Error(`wrangler dev stopped with code ${wrangler.exitCode}:\n${readFileSync(logPath, "utf8").slice(-3000)}`);
    }
    try {
      // Without a token the API answers 401, which is enough to know that the Worker is serving.
      if ((await fetch(`${dibsUrl}/api/repos`)).status === 401) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`dibs did not come up within 90 seconds:\n${readFileSync(logPath, "utf8").slice(-3000)}`);
}

try {
  await waitUntilUp();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await stop(1);
}

if (runE2e) {
  const e2e = spawn(process.execPath, [join(root, "scripts/e2e.ts")], {
    cwd: root,
    env: { ...process.env, DIBS_URL: dibsUrl, DIBS_ADMIN_TOKEN: adminToken },
    stdio: "inherit",
  });
  const code = await new Promise<number>((resolve) => e2e.once("exit", (exitCode) => resolve(exitCode ?? 1)));
  await stop(code);
}

console.log(`dibs is running on this machine.

  Board         ${dibsUrl}/   (it asks for the admin token)
  Admin token   ${adminToken}
  Stand-ins     ${platform.url}   Artifacts on local git; Clef follows fixed rules
  Reviewer      ${realReviewer ? "the real model, through the Anthropic API" : "a stand-in that approves everything (--real-reviewer uses the real model)"}

To use it from another terminal:

  export DIBS_URL=${dibsUrl} DIBS_ADMIN_TOKEN=${adminToken}
  node scripts/e2e.ts            # the scripted end-to-end check
  node scripts/setup-demo.ts     # or register the demo repository and its five agents

The Worker's log is ${logPath}. Press Ctrl-C to stop.`);
