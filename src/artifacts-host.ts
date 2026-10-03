// RepoHost on Cloudflare Artifacts. A thin adapter: it renames fields and turns
// the binding's errors into RepoHostError, and nothing else.

import type { TreeEntry } from "./git/objects";
import {
  RepoHostError,
  type CommitInfo,
  type CreatedRepo,
  type RepoHandle,
  type RepoHost,
  type RepoHostErrorCode,
} from "./repo-host";

const ERROR_CODES: Partial<Record<ArtifactsErrorCode, RepoHostErrorCode>> = {
  NOT_FOUND: "not_found",
  FORK_IN_PROGRESS: "not_ready",
  IMPORT_IN_PROGRESS: "not_ready",
  CREATE_IN_PROGRESS: "not_ready",
  ALREADY_EXISTS: "already_exists",
  MEMORY_LIMIT: "too_large",
};

function translate(error: unknown): RepoHostError {
  if (error instanceof RepoHostError) {
    return error;
  }
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  const mapped = typeof code === "string" ? ERROR_CODES[code as ArtifactsErrorCode] : undefined;
  return new RepoHostError(mapped ?? "internal", message);
}

async function guard<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw translate(error);
  }
}

function toCommit(commit: ArtifactsCommitMetadata): CommitInfo {
  return {
    oid: commit.hash,
    tree: commit.treeHash,
    parents: commit.parents,
    message: commit.message,
    author: commit.author,
    committer: commit.committer,
    authoredAt: commit.authoredAt,
    committedAt: commit.committedAt,
  };
}

async function toBytes(blob: Blob | null): Promise<Uint8Array | null> {
  return blob === null ? null : new Uint8Array(await blob.arrayBuffer());
}

function toCreated(result: ArtifactsCreateRepoResult): CreatedRepo {
  return { name: result.name, remote: result.remote, defaultBranch: result.defaultBranch, token: result.token };
}

export class ArtifactsRepoHost implements RepoHost {
  constructor(private readonly artifacts: Artifacts) {}

  async open(name: string): Promise<RepoHandle> {
    const repo = await guard(() => this.artifacts.get(name));
    return {
      name,
      remote: () => guard(async () => (await repo.info()).remote),
      defaultBranch: () => guard(async () => (await repo.info()).defaultBranch),
      createToken: (scope, ttlSeconds) => guard(async () => (await repo.createToken(scope, ttlSeconds)).plaintext),
      head: (branch) =>
        guard(async () => {
          const [newest] = await repo.log({ ref: branch, limit: 1 });
          return newest === undefined ? null : toCommit(newest);
        }),
      log: (ref, limit) => guard(async () => (await repo.log({ ref, limit })).map(toCommit)),
      readCommit: (oid) =>
        guard(async () => {
          const commit = await repo.readCommit(oid);
          return commit === null ? null : toCommit(commit);
        }),
      readTree: (oid) =>
        guard(async (): Promise<TreeEntry[] | null> => {
          const entries = await repo.readTree(oid);
          return entries === null ? null : entries.map((entry) => ({ name: entry.name, mode: entry.mode, oid: entry.hash }));
        }),
      readBlob: (oid) => guard(async () => toBytes(await repo.readBlob(oid))),
      readFile: (ref, path) => guard(async () => toBytes(await repo.readFile({ ref, path }))),
      fork: (forkName) =>
        guard(async () => {
          await repo.fork(forkName, { defaultBranchOnly: true });
        }),
      [Symbol.dispose]: () => repo[Symbol.dispose](),
    };
  }

  async create(name: string, options: { description?: string } = {}): Promise<CreatedRepo> {
    return guard(async () => toCreated(await this.artifacts.create(name, { ...options, setDefaultBranch: "main" })));
  }

  async importFrom(name: string, source: { url: string; branch?: string }): Promise<CreatedRepo> {
    return guard(async () => toCreated(await this.artifacts.import({ source, target: { name } })));
  }
}
