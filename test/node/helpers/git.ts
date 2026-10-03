// Test utilities that drive the real git CLI and a real git smart-HTTP server.
// They are the independent oracle for everything in src/git.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

export function makeTempDir(prefix = "dibs-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A fixed identity and clock so that commits made by the real git are reproducible.
export const FIXED_ENV = {
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.invalid",
  GIT_AUTHOR_DATE: "1760000000 +0000",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.invalid",
  GIT_COMMITTER_DATE: "1760000100 +0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

export interface GitOptions {
  input?: string | Uint8Array;
  env?: Record<string, string>;
}

export function gitRaw(cwd: string, args: string[], options: GitOptions = {}): Buffer {
  return execFileSync("git", args, {
    cwd,
    input: options.input,
    env: { ...process.env, ...FIXED_ENV, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

export function git(cwd: string, args: string[], options: GitOptions = {}): string {
  return gitRaw(cwd, args, options).toString("utf8").trimEnd();
}

// Use this for any git command that talks to the in-process HTTP server: the
// synchronous helpers block the event loop the server needs in order to answer.
export function gitAsync(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...FIXED_ENV, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8").trimEnd());
      } else {
        reject(new Error(`git ${args.join(" ")} exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
      }
    });
    child.stdin.end(options.input);
  });
}

export function initRepo(options: { bare?: boolean } = {}): string {
  const dir = makeTempDir();
  git(dir, ["init", "--quiet", "--initial-branch=main", ...(options.bare ? ["--bare"] : [])]);
  return dir;
}

export interface LsTreeEntry {
  mode: string;
  type: string;
  oid: string;
  name: string;
}

// Parses `git ls-tree -z`, which never quotes or escapes file names.
export function lsTree(cwd: string, treeish: string, recursive = false): LsTreeEntry[] {
  const out = gitRaw(cwd, ["ls-tree", "-z", ...(recursive ? ["-r"] : []), treeish]).toString("utf8");
  return out
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, oid] = line.slice(0, tab).split(" ") as [string, string, string];
      return { mode, type, oid, name: line.slice(tab + 1) };
    });
}

export interface GitServer {
  // Base URL; a repo at <root>/<name>.git is served at `${url}/<name>.git`.
  url: string;
  root: string;
  close(): Promise<void>;
}

// Answers one git smart-HTTP request for a bare repo under `root` by running
// `git http-backend` as a CGI program, the same way a real git host does.
// `pathInfo` is the path below the root, such as "/demo.git/info/refs".
export function serveGit(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  pathInfo: string,
  queryString: string,
): void {
  const child = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      REQUEST_METHOD: request.method ?? "GET",
      PATH_INFO: pathInfo,
      QUERY_STRING: queryString,
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      CONTENT_LENGTH: request.headers["content-length"] ?? "",
      HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
      GIT_PROTOCOL: (request.headers["git-protocol"] as string | undefined) ?? "",
      REMOTE_ADDR: "127.0.0.1",
    },
  });

  request.pipe(child.stdin);

  let buffered = Buffer.alloc(0);
  let headersSent = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (headersSent) {
      response.write(chunk);
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf("\r\n\r\n");
    if (end === -1) {
      return;
    }
    let status = 200;
    for (const line of buffered.subarray(0, end).toString("utf8").split("\r\n")) {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") {
        status = Number.parseInt(value, 10);
      } else {
        response.setHeader(name, value);
      }
    }
    response.statusCode = status;
    headersSent = true;
    response.write(buffered.subarray(end + 4));
  });
  child.on("close", () => {
    if (!headersSent) {
      response.statusCode = 500;
    }
    response.end();
  });
}

// Serves every bare repo under `root` over git smart HTTP.
export async function startGitServer(root: string = makeTempDir("dibs-server-")): Promise<GitServer> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    serveGit(root, request, response, url.pathname, url.search.slice(1));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("git test server did not bind to a port");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    root,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

// Creates a bare repo under the server root that accepts pushes over HTTP.
export function createServedRepo(server: GitServer, name: string): { dir: string; remote: string } {
  const dir = join(server.root, `${name}.git`);
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", dir], {
    env: { ...process.env, ...FIXED_ENV },
  });
  git(dir, ["config", "http.receivepack", "true"]);
  return { dir, remote: `${server.url}/${name}.git` };
}
