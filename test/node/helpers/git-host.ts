// A RepoHost backed by real bare repositories on disk and served over HTTP by
// the test git server. Reads go through the git CLI; pushes go over the wire.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TreeEntry } from "../../../src/git/objects";
import {
  RepoHostError,
  type CommitInfo,
  type CreatedRepo,
  type RepoHandle,
  type RepoHost,
} from "../../../src/repo-host";
import { disposable } from "../../helpers/disposable";
import { createServedRepo, git, gitRaw, lsTree, type GitServer } from "./git";

function readCommit(dir: string, oid: string): CommitInfo | null {
  let raw: string;
  try {
    if (git(dir, ["cat-file", "-t", oid]) !== "commit") {
      return null;
    }
    raw = gitRaw(dir, ["show", "-s", "--format=%H%n%T%n%P%n%an%n%ae%n%at%n%cn%n%ce%n%ct%n%B", oid]).toString("utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  const [hash, tree, parents, authorName, authorEmail, authoredAt, committerName, committerEmail, committedAt] =
    lines as [string, string, string, string, string, string, string, string, string];
  return {
    oid: hash,
    tree,
    parents: parents === "" ? [] : parents.split(" "),
    // Like Artifacts: the message with one trailing newline removed.
    message: lines.slice(9).join("\n").replace(/\n+$/, ""),
    author: { name: authorName, email: authorEmail },
    committer: { name: committerName, email: committerEmail },
    authoredAt: Number(authoredAt),
    committedAt: Number(committedAt),
  };
}

export class GitCliRepoHost implements RepoHost {
  readonly tokensIssued: { repo: string; scope: string; ttlSeconds: number }[] = [];
  readonly blobsRead: { repo: string; oid: string }[] = [];
  // Lets a test corrupt what a blob read returns.
  blobOverride: ((repo: string, oid: string, bytes: Uint8Array) => Uint8Array) | undefined;

  constructor(private readonly server: GitServer) {}

  dir(name: string): string {
    return join(this.server.root, `${name}.git`);
  }

  remoteOf(name: string): string {
    return `${this.server.url}/${name}.git`;
  }

  async open(name: string): Promise<RepoHandle> {
    const dir = this.dir(name);
    if (!existsSync(dir)) {
      throw new RepoHostError("not_found", `repository ${name} does not exist`);
    }
    const host = this;
    return disposable({
      name,
      remote: async () => this.remoteOf(name),
      defaultBranch: async () => "main",
      createToken: async (scope, ttlSeconds) => {
        this.tokensIssued.push({ repo: name, scope, ttlSeconds });
        return `test-token-${name}-${scope}`;
      },
      head: async (branch) => {
        try {
          return readCommit(dir, git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]));
        } catch {
          return null;
        }
      },
      log: async (ref, limit) =>
        git(dir, ["log", "--first-parent", `-n${limit}`, "--format=%H", ref])
          .split("\n")
          .filter((line) => line !== "")
          .map((oid) => readCommit(dir, oid)!),
      readCommit: async (oid) => readCommit(dir, oid),
      readTree: async (oid): Promise<TreeEntry[] | null> => {
        try {
          if (git(dir, ["cat-file", "-t", oid]) !== "tree") {
            return null;
          }
        } catch {
          return null;
        }
        return lsTree(dir, oid).map(({ name: entryName, mode, oid: entryOid }) => ({
          name: entryName,
          mode,
          oid: entryOid,
        }));
      },
      readBlob: async (oid) => {
        host.blobsRead.push({ repo: name, oid });
        try {
          if (git(dir, ["cat-file", "-t", oid]) !== "blob") {
            return null;
          }
        } catch {
          return null;
        }
        const bytes = new Uint8Array(gitRaw(dir, ["cat-file", "blob", oid]));
        return host.blobOverride ? host.blobOverride(name, oid, bytes) : bytes;
      },
      readFile: async (ref, path) => {
        try {
          return new Uint8Array(gitRaw(dir, ["show", `${ref}:${path}`]));
        } catch {
          return null;
        }
      },
      fork: async (forkName) => {
        const { dir: forkDir } = createServedRepo(this.server, forkName);
        git(dir, ["push", "--quiet", forkDir, "refs/heads/main:refs/heads/main"]);
      },
      [Symbol.dispose]: () => {},
    });
  }

  async create(name: string): Promise<CreatedRepo> {
    if (existsSync(this.dir(name))) {
      throw new RepoHostError("already_exists", `repository ${name} already exists`);
    }
    const { remote } = createServedRepo(this.server, name);
    return { name, remote, defaultBranch: "main", token: `test-token-${name}-write` };
  }

  async importFrom(): Promise<CreatedRepo> {
    throw new RepoHostError("internal", "import is not supported by the test host");
  }
}
