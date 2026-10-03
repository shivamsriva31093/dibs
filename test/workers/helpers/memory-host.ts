// An in-memory RepoHost for tests that run inside workerd, where there is no git
// binary. Objects are built with the real encoders, so every id is a real git id.

import { encodeCommit, encodeTree, makeObject, TREE_MODE, type TreeEntry } from "../../../src/git/objects";
import {
  RepoHostError,
  type CommitInfo,
  type CreatedRepo,
  type RepoHandle,
  type RepoHost,
} from "../../../src/repo-host";
import { disposable } from "../../helpers/disposable";

type FileSpec = string | Uint8Array | { content: string | Uint8Array; mode: string } | null;
type Snapshot = Map<string, { mode: string; oid: string }>;

const encoder = new TextEncoder();
const IDENTITY = { name: "Test", email: "test@example.invalid" };

class MemoryRepo {
  blobs = new Map<string, Uint8Array>();
  trees = new Map<string, TreeEntry[]>();
  commits = new Map<string, CommitInfo>();
  snapshots = new Map<string, Snapshot>();
  branches = new Map<string, string>();

  clone(): MemoryRepo {
    const copy = new MemoryRepo();
    copy.blobs = new Map(this.blobs);
    copy.trees = new Map(this.trees);
    copy.commits = new Map(this.commits);
    copy.snapshots = new Map(this.snapshots);
    copy.branches = new Map(this.branches);
    return copy;
  }

  private async writeTree(files: Snapshot, prefix: string): Promise<string> {
    const entries = new Map<string, TreeEntry>();
    const directories = new Set<string>();
    for (const [path, leaf] of files) {
      if (!path.startsWith(prefix)) {
        continue;
      }
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        entries.set(rest, { name: rest, mode: leaf.mode, oid: leaf.oid });
      } else {
        directories.add(rest.slice(0, slash));
      }
    }
    for (const directory of directories) {
      entries.set(directory, {
        name: directory,
        mode: TREE_MODE,
        oid: await this.writeTree(files, `${prefix}${directory}/`),
      });
    }
    const list = [...entries.values()];
    const tree = await makeObject("tree", encodeTree(list));
    this.trees.set(tree.oid, list);
    return tree.oid;
  }

  private async store(branch: string, files: Snapshot, parents: string[], message: string, at: number): Promise<string> {
    const tree = await this.writeTree(files, "");
    const fields = { tree, parents, author: IDENTITY, committer: IDENTITY, authoredAt: at, committedAt: at, message };
    const commit = await makeObject("commit", encodeCommit(fields));
    this.commits.set(commit.oid, { oid: commit.oid, ...fields, message: message.replace(/\n$/, "") });
    this.snapshots.set(commit.oid, files);
    this.branches.set(branch, commit.oid);
    return commit.oid;
  }

  // What `git pull` does in a fork: brings in a branch of another repository and merges it,
  // keeping the fork's own versions of `own`, the paths its task changed.
  async pull(from: MemoryRepo, branch: string, own: string[], message = "Merge main\n", at = 1_760_000_500): Promise<string> {
    for (const name of ["blobs", "trees", "commits", "snapshots"] as const) {
      for (const [key, value] of from[name] as Map<string, never>) {
        (this[name] as Map<string, never>).set(key, value);
      }
    }
    const theirs = from.branches.get(branch)!;
    const mine = this.branches.get(branch)!;
    const files: Snapshot = new Map(from.snapshots.get(theirs));
    for (const path of own) {
      const leaf = this.snapshots.get(mine)!.get(path);
      if (leaf === undefined) {
        files.delete(path);
      } else {
        files.set(path, leaf);
      }
    }
    return this.store(branch, files, [mine, theirs], message, at);
  }

  // Commits a set of file changes on a branch; null removes a path.
  async commit(branch: string, changes: Record<string, FileSpec>, message: string, at = 1_760_000_000): Promise<string> {
    const parent = this.branches.get(branch);
    const files: Snapshot = new Map(parent === undefined ? [] : this.snapshots.get(parent));
    for (const [path, spec] of Object.entries(changes)) {
      if (spec === null) {
        files.delete(path);
        continue;
      }
      const content = typeof spec === "object" && "content" in spec ? spec.content : spec;
      const mode = typeof spec === "object" && "mode" in spec ? spec.mode : "100644";
      const bytes = typeof content === "string" ? encoder.encode(content) : content;
      const blob = await makeObject("blob", bytes);
      this.blobs.set(blob.oid, bytes);
      files.set(path, { mode, oid: blob.oid });
    }

    return this.store(branch, files, parent === undefined ? [] : [parent], message, at);
  }

  resolve(ref: string): string | null {
    return this.branches.get(ref) ?? (this.commits.has(ref) ? ref : null);
  }
}

export class MemoryRepoHost implements RepoHost {
  private readonly repos = new Map<string, MemoryRepo>();
  // Names of repositories that report "still forking" when opened, and how many more times.
  readonly notReady = new Map<string, number>();
  // Names of repositories that report "busy with another fork" when forked, and how many more times.
  readonly forkBusy = new Map<string, number>();
  readonly tokensIssued: { repo: string; scope: string; ttlSeconds: number }[] = [];

  repo(name: string): MemoryRepo {
    const repo = this.repos.get(name);
    if (repo === undefined) {
      throw new RepoHostError("not_found", `repository ${name} does not exist`);
    }
    return repo;
  }

  has(name: string): boolean {
    return this.repos.has(name);
  }

  async seed(name: string, files: Record<string, FileSpec>, message = "seed\n"): Promise<string> {
    const repo = new MemoryRepo();
    this.repos.set(name, repo);
    return repo.commit("main", files, message);
  }

  async open(name: string): Promise<RepoHandle> {
    const repo = this.repo(name);
    const pending = this.notReady.get(name) ?? 0;
    if (pending > 0) {
      this.notReady.set(name, pending - 1);
      throw new RepoHostError("not_ready", `repository ${name} is still being forked`);
    }
    return disposable({
      name,
      remote: async () => `https://git.example.invalid/${name}.git`,
      defaultBranch: async () => "main",
      createToken: async (scope, ttlSeconds) => {
        this.tokensIssued.push({ repo: name, scope, ttlSeconds });
        return `token-${name}-${scope}`;
      },
      head: async (branch) => {
        const oid = repo.branches.get(branch);
        return oid === undefined ? null : (repo.commits.get(oid) ?? null);
      },
      log: async (ref, limit) => {
        const out: CommitInfo[] = [];
        let oid = repo.resolve(ref);
        while (oid !== null && out.length < limit) {
          const commit = repo.commits.get(oid);
          if (commit === undefined) {
            break;
          }
          out.push(commit);
          oid = commit.parents[0] ?? null;
        }
        return out;
      },
      readCommit: async (oid) => repo.commits.get(oid) ?? null,
      readTree: async (oid) => repo.trees.get(oid) ?? null,
      readBlob: async (oid) => repo.blobs.get(oid) ?? null,
      readFile: async (ref, path) => {
        const oid = repo.resolve(ref);
        const leaf = oid === null ? undefined : repo.snapshots.get(oid)?.get(path);
        return leaf === undefined ? null : (repo.blobs.get(leaf.oid) ?? null);
      },
      fork: async (forkName) => {
        const busy = this.forkBusy.get(name) ?? 0;
        if (busy > 0) {
          this.forkBusy.set(name, busy - 1);
          throw new RepoHostError("not_ready", `repository ${name} is busy with another fork`);
        }
        if (this.repos.has(forkName)) {
          throw new RepoHostError("already_exists", `repository ${forkName} already exists`);
        }
        this.repos.set(forkName, repo.clone());
      },
      [Symbol.dispose]: () => {},
    });
  }

  async create(name: string): Promise<CreatedRepo> {
    if (this.repos.has(name)) {
      throw new RepoHostError("already_exists", `repository ${name} already exists`);
    }
    this.repos.set(name, new MemoryRepo());
    return { name, remote: `https://git.example.invalid/${name}.git`, defaultBranch: "main", token: `token-${name}-write` };
  }

  async importFrom(name: string): Promise<CreatedRepo> {
    return this.create(name);
  }
}
