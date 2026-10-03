// The boundary between dibs and wherever its git repositories live. In
// production that is Cloudflare Artifacts; tests substitute other hosts.

import type { Identity, TreeEntry } from "./git/objects";

export interface CommitInfo {
  oid: string;
  tree: string;
  parents: string[];
  message: string;
  author: Identity;
  committer: Identity;
  // Unix seconds.
  authoredAt: number;
  committedAt: number;
}

export type RepoHostErrorCode = "not_found" | "not_ready" | "already_exists" | "too_large" | "internal";

export class RepoHostError extends Error {
  constructor(
    readonly code: RepoHostErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RepoHostError";
  }
}

export interface RepoHandle extends Disposable {
  readonly name: string;
  // The git remote URL of the repository.
  remote(): Promise<string>;
  defaultBranch(): Promise<string>;
  createToken(scope: "read" | "write", ttlSeconds: number): Promise<string>;
  // The commit a branch points at, or null if the branch does not exist.
  head(branch: string): Promise<CommitInfo | null>;
  // Commits on the first-parent chain from `ref`, newest first.
  log(ref: string, limit: number): Promise<CommitInfo[]>;
  readCommit(oid: string): Promise<CommitInfo | null>;
  readTree(oid: string): Promise<TreeEntry[] | null>;
  readBlob(oid: string): Promise<Uint8Array | null>;
  // The content of a file at a branch or commit, or null if there is no such file.
  readFile(ref: string, path: string): Promise<Uint8Array | null>;
  // Starts a fork of this repository under a new name.
  fork(name: string): Promise<void>;
}

export interface CreatedRepo {
  name: string;
  remote: string;
  defaultBranch: string;
  // A write token for the new repository.
  token: string;
}

export interface RepoHost {
  // Throws RepoHostError "not_found", or "not_ready" while a fork or import is still running.
  open(name: string): Promise<RepoHandle>;
  create(name: string, options?: { description?: string }): Promise<CreatedRepo>;
  importFrom(name: string, source: { url: string; branch?: string }): Promise<CreatedRepo>;
}

const READY_WAIT_MS = 20_000;
const READY_POLL_START_MS = 250;
const READY_POLL_MAX_MS = 2000;

// A fork or an import is prepared in the background, and a repository runs one
// fork at a time. A call that fails with "not_ready" meanwhile is tried again,
// with a growing delay, for up to 20 seconds.
export async function whenReady<T>(
  attempt: () => Promise<T>,
  name: string,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  let waited = 0;
  let delay = READY_POLL_START_MS;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof RepoHostError) || error.code !== "not_ready") {
        throw error;
      }
    }
    if (waited >= READY_WAIT_MS) {
      throw new RepoHostError("not_ready", `repository ${name} was not ready after ${Math.round(waited / 1000)} seconds`);
    }
    await sleep(delay);
    waited += delay;
    delay = Math.min(delay * 2, READY_POLL_MAX_MS);
  }
}

export function openWhenReady(host: RepoHost, name: string, sleep: (ms: number) => Promise<void>): Promise<RepoHandle> {
  return whenReady(() => host.open(name), name, sleep);
}
