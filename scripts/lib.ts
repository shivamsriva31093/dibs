// Shared by the scripts: where dibs is deployed, and small helpers for its HTTP API and for git.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const DIBS_URL = (process.env.DIBS_URL ?? "").replace(/\/+$/, "");
export const ADMIN_TOKEN = process.env.DIBS_ADMIN_TOKEN ?? "";

export function requireConfig(): void {
  if (DIBS_URL === "" || ADMIN_TOKEN === "") {
    console.error("Set DIBS_URL (for example https://dibs.<your-subdomain>.workers.dev) and DIBS_ADMIN_TOKEN first.");
    process.exit(2);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${DIBS_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as T };
}

// Every text file under a directory, keyed by its path relative to that directory.
export function readTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") {
        continue;
      }
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        files[relative(root, full).split("\\").join("/")] = readFileSync(full, "utf8");
      }
    }
  };
  walk(root);
  return files;
}

export function git(cwd: string, args: string[], token?: string): string {
  const auth = token === undefined ? [] : ["-c", `http.extraHeader=Authorization: Bearer ${token}`];
  return execFileSync("git", [...auth, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "dibs script",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "script@dibs.invalid",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "dibs script",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "script@dibs.invalid",
    },
  }).trim();
}

const pktLine = (line: string) => `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, "0")}${line}`;

// Asks a git server to move a ref from `expected` to `next` with git's push
// protocol, sending no objects: the server must already hold `next`. An ordinary
// git client always names the commit the server just advertised, so this is the
// way to find out what a server does when the named commit is out of date.
export async function updateRef(
  remote: string,
  token: string | undefined,
  ref: string,
  expected: string,
  next: string,
): Promise<{ accepted: boolean; report: string }> {
  // A pack holding no objects: the signature, version 2, a count of zero, and the checksum of those.
  const header = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
  const pack = Buffer.concat([header, createHash("sha1").update(header).digest()]);
  const command = pktLine(`${expected} ${next} ${ref}\0report-status agent=dibs-script\n`);
  const response = await fetch(`${remote}/git-receive-pack`, {
    method: "POST",
    headers: {
      "content-type": "application/x-git-receive-pack-request",
      accept: "application/x-git-receive-pack-result",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: Buffer.concat([Buffer.from(`${command}0000`), pack]),
  });
  const report = await response.text();
  if (!response.ok) {
    throw new Error(`the git server answered ${response.status} to a push: ${report.slice(0, 200)}`);
  }
  return { accepted: report.includes(`ok ${ref}`), report };
}

export const AGENT_NAMES = ["agent-one", "agent-two", "agent-three", "agent-four", "agent-five"] as const;
