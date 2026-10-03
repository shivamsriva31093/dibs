// A stand-in for the Cloudflare services dibs depends on, so that the whole
// system can run on one machine: Artifacts, the Clef decision model, and the
// reviewer model.
//
// The Artifacts stand-in keeps real bare repositories and serves them with the
// real `git http-backend`, and it follows the documented behaviour of the
// binding: the same result shapes, the same error codes, forks that take a
// moment, and tokens that are scoped to one repository. It shows that dibs's own
// code hangs together. It cannot show how the real service behaves.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { git, gitRaw, serveGit } from "../node/helpers/git.ts";
import { standInClef, standInReviewer } from "./models.ts";

const NAMESPACE = "local";
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OBJECT_ID = /^[0-9a-f]{40}$/;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 31_536_000;

const NUMERIC_CODES: Record<string, number> = {
  INVALID_INPUT: 10100,
  INVALID_REPO_NAME: 10101,
  INVALID_TTL: 10103,
  INVALID_URL: 10104,
  NOT_FOUND: 10200,
  ALREADY_EXISTS: 10201,
  FORK_IN_PROGRESS: 10303,
  INTERNAL_ERROR: 10400,
};

class ServiceError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface RepoRecord {
  id: string;
  name: string;
  dir: string;
  source: string | null;
  createdAt: string;
  // Milliseconds since the epoch. A fork cannot be opened before this.
  readyAt: number;
}

interface TokenRecord {
  repo: string;
  scope: "read" | "write";
  // Unix seconds.
  expires: number;
}

export interface PlatformOptions {
  // The directory that holds the bare repositories.
  root: string;
  port: number;
  // How long a fork takes. Until then, opening it fails with FORK_IN_PROGRESS, and so does another fork of its source.
  forkDelayMs?: number;
}

export interface Platform {
  url: string;
  close(): Promise<void>;
}

function tryGit(dir: string, args: string[]): string | null {
  try {
    return git(dir, args);
  } catch {
    return null;
  }
}

function identity(line: string): { name: string; email: string; at: number } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) {
    throw new ServiceError("INTERNAL_ERROR", `cannot read the identity "${line}"`);
  }
  return { name: match[1]!, email: match[2]!, at: Number(match[3]) };
}

function readCommit(dir: string, hash: string): Record<string, unknown> | null {
  if (!OBJECT_ID.test(hash)) {
    throw new ServiceError("INVALID_INPUT", `not an object id: ${hash}`);
  }
  const type = tryGit(dir, ["cat-file", "-t", hash]);
  if (type === null) {
    return null;
  }
  if (type !== "commit") {
    throw new ServiceError("INTERNAL_ERROR", `${hash} is not a commit`);
  }
  const raw = gitRaw(dir, ["cat-file", "commit", hash]).toString("utf8");
  const split = raw.indexOf("\n\n");
  const headers = raw.slice(0, split).split("\n");
  const header = (name: string) => headers.filter((line) => line.startsWith(`${name} `)).map((line) => line.slice(name.length + 1));
  const author = identity(header("author")[0]!);
  const committer = identity(header("committer")[0]!);
  const message = raw.slice(split + 2);
  return {
    hash,
    treeHash: header("tree")[0],
    message: message.endsWith("\n") ? message.slice(0, -1) : message,
    author: { name: author.name, email: author.email },
    committer: { name: committer.name, email: committer.email },
    parents: header("parent"),
    authoredAt: author.at,
    committedAt: committer.at,
  };
}

const ENTRY_TYPES: Record<string, string> = {
  "40000": "tree",
  "100644": "blob",
  "100755": "exec",
  "120000": "symlink",
  "160000": "gitlink",
};

function readTree(dir: string, hash: string): Record<string, unknown>[] | null {
  if (!OBJECT_ID.test(hash)) {
    throw new ServiceError("INVALID_INPUT", `not an object id: ${hash}`);
  }
  const type = tryGit(dir, ["cat-file", "-t", hash]);
  if (type === null) {
    return null;
  }
  if (type !== "tree") {
    throw new ServiceError("INTERNAL_ERROR", `${hash} is not a tree`);
  }
  return gitRaw(dir, ["ls-tree", "-z", hash])
    .toString("utf8")
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      const [rawMode, , oid] = line.slice(0, tab).split(" ") as [string, string, string];
      // `git ls-tree` pads a tree's mode to six digits; the canonical form has no leading zero.
      const mode = rawMode.replace(/^0+/, "");
      return { name: line.slice(tab + 1), mode, hash: oid, type: ENTRY_TYPES[mode] ?? "blob" };
    });
}

function readBlob(dir: string, hash: string): { base64: string; type: string } | null {
  if (tryGit(dir, ["cat-file", "-t", hash]) !== "blob") {
    return null;
  }
  return { base64: gitRaw(dir, ["cat-file", "blob", hash]).toString("base64"), type: "" };
}

async function readBody(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export async function startPlatform(options: PlatformOptions): Promise<Platform> {
  const forkDelayMs = options.forkDelayMs ?? 400;
  const url = `http://127.0.0.1:${options.port}`;
  const repos = new Map<string, RepoRecord>();
  const tokens = new Map<string, TokenRecord>();

  const remoteOf = (name: string) => `${url}/git/${NAMESPACE}/${name}.git`;

  const validName = (name: unknown): string => {
    if (typeof name !== "string" || !REPO_NAME.test(name)) {
      throw new ServiceError("INVALID_REPO_NAME", `"${String(name)}" is not a valid repository name`);
    }
    return name;
  };

  const existing = (name: string): RepoRecord => {
    const repo = repos.get(name);
    if (repo === undefined) {
      throw new ServiceError("NOT_FOUND", `repository ${name} does not exist`);
    }
    return repo;
  };

  const ready = (name: string): RepoRecord => {
    const repo = existing(name);
    if (Date.now() < repo.readyAt) {
      throw new ServiceError("FORK_IN_PROGRESS", `repository ${name} is still being forked`);
    }
    return repo;
  };

  const defaultBranch = (repo: RepoRecord) => git(repo.dir, ["symbolic-ref", "--short", "HEAD"]);

  const mintToken = (repo: string, scope: unknown, ttl: unknown) => {
    if (scope !== "read" && scope !== "write") {
      throw new ServiceError("INVALID_INPUT", `"${String(scope)}" is not a token scope`);
    }
    if (typeof ttl !== "number" || ttl < MIN_TTL_SECONDS || ttl > MAX_TTL_SECONDS) {
      throw new ServiceError("INVALID_TTL", `a token must live between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS} seconds`);
    }
    const expires = Math.floor(Date.now() / 1000) + ttl;
    const plaintext = `art_v1_${randomBytes(20).toString("hex")}?expires=${expires}`;
    tokens.set(plaintext, { repo, scope, expires });
    return { id: randomBytes(8).toString("hex"), plaintext, scope, expiresAt: new Date(expires * 1000).toISOString() };
  };

  const register = (name: string, source: string | null, readyAt: number): RepoRecord => {
    const repo: RepoRecord = {
      id: randomBytes(8).toString("hex"),
      name,
      dir: join(options.root, `${name}.git`),
      source,
      createdAt: new Date().toISOString(),
      readyAt,
    };
    repos.set(name, repo);
    return repo;
  };

  const created = (repo: RepoRecord) => ({
    id: repo.id,
    name: repo.name,
    description: null,
    defaultBranch: defaultBranch(repo),
    remote: remoteOf(repo.name),
    token: mintToken(repo.name, "write", 86_400).plaintext,
  });

  // The methods of the Artifacts binding. `repo` is the repository a method was called on, or null for the namespace.
  const artifacts: Record<string, (repo: string | null, args: any[]) => unknown> = {
    create: (_repo, [name, opts]) => {
      if (repos.has(validName(name))) {
        throw new ServiceError("ALREADY_EXISTS", `repository ${name} already exists`);
      }
      git(options.root, ["init", "--quiet", "--bare", `--initial-branch=${opts?.setDefaultBranch ?? "main"}`, join(options.root, `${name}.git`)]);
      const repo = register(name, null, 0);
      git(repo.dir, ["config", "http.receivepack", "true"]);
      return created(repo);
    },

    import: (_repo, [params]) => {
      const name = validName(params?.target?.name);
      if (repos.has(name)) {
        throw new ServiceError("ALREADY_EXISTS", `repository ${name} already exists`);
      }
      const sourceUrl = String(params?.source?.url ?? "");
      if (!sourceUrl.startsWith("https://")) {
        throw new ServiceError("INVALID_INPUT", "the source must be an https URL");
      }
      const branch = params.source.branch === undefined ? [] : ["--branch", String(params.source.branch)];
      const dir = join(options.root, `${name}.git`);
      if (tryGit(options.root, ["clone", "--quiet", "--bare", ...branch, sourceUrl, dir]) === null) {
        throw new ServiceError("INVALID_URL", `${sourceUrl} could not be cloned`);
      }
      const repo = register(name, sourceUrl, 0);
      git(repo.dir, ["config", "http.receivepack", "true"]);
      return created(repo);
    },

    get: (_repo, [name]) => {
      ready(String(name));
      return null;
    },

    info: (name) => {
      const repo = existing(name!);
      return {
        id: repo.id,
        name: repo.name,
        description: null,
        defaultBranch: defaultBranch(repo),
        createdAt: repo.createdAt,
        updatedAt: repo.createdAt,
        lastPushAt: null,
        source: repo.source,
        readOnly: false,
        remote: remoteOf(repo.name),
      };
    },

    createToken: (name, [scope, ttl]) => mintToken(existing(name!).name, scope ?? "write", ttl ?? 86_400),

    log: (name, [opts]) => {
      const repo = existing(name!);
      const start = tryGit(repo.dir, ["rev-parse", "--verify", "--quiet", `${opts?.ref ?? "HEAD"}^{commit}`]);
      if (start === null) {
        return [];
      }
      const limit = Math.min(opts?.limit ?? 50, 1000);
      return git(repo.dir, ["rev-list", "--first-parent", `--max-count=${limit}`, `--skip=${opts?.offset ?? 0}`, start])
        .split("\n")
        .filter((oid) => oid !== "")
        .map((oid) => readCommit(repo.dir, oid));
    },

    readCommit: (name, [hash]) => readCommit(existing(name!).dir, String(hash)),

    readTree: (name, [hash]) => readTree(existing(name!).dir, String(hash)),

    readBlob: (name, [hash]) => {
      if (!OBJECT_ID.test(String(hash))) {
        throw new ServiceError("INVALID_INPUT", `not an object id: ${hash}`);
      }
      return readBlob(existing(name!).dir, hash);
    },

    readFile: (name, [args]) => {
      if (!args?.ref || !args?.path) {
        throw new ServiceError("INVALID_INPUT", "ref and path must not be empty");
      }
      const repo = existing(name!);
      const oid = tryGit(repo.dir, ["rev-parse", "--verify", "--quiet", `${args.ref}:${args.path}`]);
      const blob = oid === null ? null : readBlob(repo.dir, oid);
      return blob === null ? null : { ...blob, type: "text/plain;charset=utf-8" };
    },

    fork: (name, [forkName, opts]) => {
      const source = existing(name!);
      if (repos.has(validName(forkName))) {
        throw new ServiceError("ALREADY_EXISTS", `repository ${forkName} already exists`);
      }
      const running = [...repos.values()].some((other) => other.source === source.name && Date.now() < other.readyAt);
      if (running) {
        throw new ServiceError("FORK_IN_PROGRESS", `repository ${source.name} is busy with another fork`);
      }
      const hasCommits = tryGit(source.dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]) !== null;
      const oneBranch = hasCommits && opts?.defaultBranchOnly !== false ? ["--single-branch", "--branch", defaultBranch(source)] : [];
      git(options.root, ["clone", "--quiet", "--bare", ...oneBranch, source.dir, join(options.root, `${forkName}.git`)]);
      const fork = register(forkName, source.name, Date.now() + forkDelayMs);
      git(fork.dir, ["config", "http.receivepack", "true"]);
      return created(fork);
    },
  };

  // A token arrives as a bearer credential, or as the password of HTTP Basic auth without its "?expires=" suffix.
  const tokenOf = (request: IncomingMessage): TokenRecord | null => {
    const header = request.headers.authorization ?? "";
    const bearer = /^Bearer\s+(\S+)$/i.exec(header);
    if (bearer !== null) {
      return tokens.get(bearer[1]!) ?? null;
    }
    const basic = /^Basic\s+(\S+)$/i.exec(header);
    if (basic !== null) {
      const secret = Buffer.from(basic[1]!, "base64").toString("utf8").split(":").slice(1).join(":");
      for (const [plaintext, record] of tokens) {
        if (plaintext.split("?")[0] === secret) {
          return record;
        }
      }
    }
    return null;
  };

  const serveRepo = (request: IncomingMessage, response: ServerResponse, requestUrl: URL): void => {
    const match = new RegExp(`^/git/${NAMESPACE}/([^/]+)\\.git(/.*)$`).exec(requestUrl.pathname);
    const repo = match === null ? undefined : repos.get(match[1]!);
    if (match === null || repo === undefined || !existsSync(repo.dir) || Date.now() < repo.readyAt) {
      response.writeHead(404).end("repository not found");
      return;
    }
    const pushing = match[2] === "/git-receive-pack" || requestUrl.searchParams.get("service") === "git-receive-pack";
    const token = tokenOf(request);
    const allowed =
      token !== null &&
      token.repo === repo.name &&
      token.expires > Date.now() / 1000 &&
      (token.scope === "write" || !pushing);
    if (!allowed) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="artifacts"' }).end("a valid token for this repository is required");
      return;
    }
    serveGit(options.root, request, response, `/${repo.name}.git${match[2]}`, requestUrl.search.slice(1));
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestUrl = new URL(request.url ?? "/", url);
    if (requestUrl.pathname.startsWith("/git/")) {
      serveRepo(request, response, requestUrl);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/artifacts") {
      const call = await readBody(request);
      const method = artifacts[call.method as string];
      try {
        if (method === undefined) {
          throw new ServiceError("INTERNAL_ERROR", `the stand-in has no method ${call.method}`);
        }
        sendJson(response, 200, { ok: true, value: method(call.repo ?? null, call.args ?? []) ?? null });
      } catch (error) {
        const code = error instanceof ServiceError ? error.code : "INTERNAL_ERROR";
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, 200, { ok: false, code, numericCode: NUMERIC_CODES[code] ?? 10400, message });
      }
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/ai") {
      sendJson(response, 200, standInClef((await readBody(request)).inputs));
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/v1/messages") {
      sendJson(response, 200, standInReviewer(await readBody(request)));
      return;
    }
    sendJson(response, 404, { error: `the stand-in has no route ${request.method} ${requestUrl.pathname}` });
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      } else {
        response.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
