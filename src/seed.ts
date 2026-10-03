// Writes a first commit into an empty repository, so that a repository can be
// registered with starting files without anyone but dibs holding a write token.

import type { Change } from "./git/changes";
import { encodeCommit, encodeTree, makeObject, ZERO_OID, type GitObject } from "./git/objects";
import { overlayChanges } from "./git/overlay";
import { buildPack } from "./git/pack";
import { listRefs, pushPack } from "./git/remote";
import { COMMITTER } from "./merge";
import { normalizePath } from "./paths";
import type { RepoHost } from "./repo-host";

export interface SeedOptions {
  branch?: string;
  message?: string;
  // Unix seconds.
  now: number;
  fetchImpl?: typeof fetch;
}

const TOKEN_TTL_SECONDS = 300;

export async function seedRepository(
  host: RepoHost,
  name: string,
  files: Record<string, string>,
  options: SeedOptions,
): Promise<{ commit: string; created: boolean }> {
  const branchRef = `refs/heads/${options.branch ?? "main"}`;
  const fetchImpl = options.fetchImpl ?? fetch;

  const entries = Object.entries(files);
  if (entries.length === 0) {
    throw new Error("no files to seed the repository with");
  }
  const blobs: GitObject[] = [];
  const changes: Change[] = [];
  for (const [rawPath, content] of entries) {
    const normalized = normalizePath(rawPath);
    if (!normalized.ok || normalized.path.endsWith("/")) {
      throw new Error(`cannot seed ${JSON.stringify(rawPath)}: it is not a file path inside the repository`);
    }
    const blob = await makeObject("blob", new TextEncoder().encode(content));
    blobs.push(blob);
    changes.push({ path: normalized.path, status: "added", base: null, head: { mode: "100644", oid: blob.oid } });
  }

  using repo = await host.open(name);
  const remote = await repo.remote();
  const auth = { token: await repo.createToken("write", TOKEN_TTL_SECONDS) };
  const existing = (await listRefs(remote, auth, fetchImpl)).refs.get(branchRef);
  if (existing !== undefined) {
    return { commit: existing, created: false };
  }

  // Every file is an addition to an empty tree.
  const emptyTree = await makeObject("tree", encodeTree([]));
  const overlay = await overlayChanges({ readTree: async () => [] }, emptyTree.oid, changes);
  if (!overlay.ok) {
    throw new Error(`cannot seed the repository: ${overlay.stale.map((entry) => `${entry.path} ${entry.reason}`).join("; ")}`);
  }
  const commit = await makeObject(
    "commit",
    encodeCommit({
      tree: overlay.rootTree,
      parents: [],
      author: COMMITTER,
      committer: COMMITTER,
      authoredAt: options.now,
      committedAt: options.now,
      message: options.message ?? "Initial commit\n",
    }),
  );

  const pushed = await pushPack(
    remote,
    { ref: branchRef, oldOid: ZERO_OID, newOid: commit.oid },
    await buildPack([...blobs, ...overlay.trees, commit]),
    auth,
    fetchImpl,
  );
  if (!pushed.ok) {
    throw new Error(`could not write the first commit (${pushed.stage}): ${pushed.reason}`);
  }
  return { commit: commit.oid, created: true };
}
