// Lands an approved task on the main branch.
//
// No clone and no three-way merge of trees: the engine reads only the trees along
// the changed paths, builds the new tree and commit objects itself, and pushes them
// in one small pack. The push names the head it was built on, so the git server
// refuses it if main moved in the meantime. A file the task holds to add to, which
// other tasks may have added to as well, is the one place where two versions of a
// file are joined (git/merge3.ts).

import type { Change, Leaf } from "./git/changes";
import { merge3 } from "./git/merge3";
import {
  encodeCommit,
  encodeTree,
  makeObject,
  ZERO_OID,
  type GitObject,
  type Identity,
} from "./git/objects";
import { overlayChanges, type Compose, type StalePath } from "./git/overlay";
import { buildPack } from "./git/pack";
import { listRefs, pushPack, type RemoteAuth } from "./git/remote";
import type { RepoHandle, RepoHost } from "./repo-host";
import { parseTrailers } from "./trailers";

export interface MergeRequest {
  repo: string;
  branch: string;
  fork: string;
  taskId: string;
  // The task's changes, as computed when it was submitted.
  changes: Change[];
  author: Identity;
  // The complete commit message, trailers included. A Dibs-Composed trailer is added to it when a file is joined.
  message: string;
  // Text to attach to the merge commit under refs/notes/dibs, or null for none. A JSON note gets a `composed`
  // field when a file is joined.
  note: string | null;
  // Paths and directories the task holds to add to: a change to one of them is joined with what main holds there.
  composable?: string[];
  // Unix seconds.
  now: number;
}

export type MergeOutcome =
  // `composed` lists the files that were joined with what main held, when there were any.
  | { status: "merged"; mergeSha: string; noteWritten: boolean; composed?: string[] }
  | { status: "stale"; paths: StalePath[] };

// The commit a merge would make, written to the main repository under a hidden ref so that it can
// be checked before main is moved to it.
export type CandidateOutcome =
  // `treeSha` is what the checks run on: two candidates with the same tree pass or fail together.
  | { status: "ready"; candidateSha: string; baseSha: string; treeSha: string; ref: string; composed: string[] }
  // The change is on main already, from an earlier run.
  | { status: "landed"; mergeSha: string; noteWritten: boolean }
  | { status: "stale"; paths: StalePath[] };

export type LandOutcome = Extract<MergeOutcome, { status: "merged" }> | { status: "moved"; reason: string };

export interface MergeEngine {
  // Builds the commit and lands it, in one go.
  merge(request: MergeRequest): Promise<MergeOutcome>;
  candidate(request: MergeRequest): Promise<CandidateOutcome>;
  // Moves main to a candidate, if main is still where the candidate was built on.
  land(request: MergeRequest, candidate: { candidateSha: string; baseSha: string; composed: string[] }): Promise<LandOutcome>;
}

export class MergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeError";
  }
}

export const COMMITTER: Identity = { name: "dibs", email: "dibs@dibs.invalid" };
export const NOTES_REF = "refs/notes/dibs";
export const CANDIDATES_REF = "refs/dibs/candidates";
const GITLINK_MODE = "160000";
const TOKEN_TTL_SECONDS = 300;
const TASK_COMMIT_SEARCH_DEPTH = 200;
const PUSH_ATTEMPTS = 2;
// A file larger than this is not joined; the change goes back to its agent instead.
const MAX_COMPOSE_BYTES = 1024 * 1024;
const strictText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface Session {
  main: RepoHandle;
  remote: string;
  auth: RemoteAuth;
}

type Built =
  | { kind: "stale"; paths: StalePath[] }
  // Nothing new: the change is on main already.
  | { kind: "landed"; mergeSha: string; ownCommit: boolean; notesOid: string | null }
  | { kind: "built"; mainOid: string; treeSha: string; commit: GitObject; objects: GitObject[]; composed: string[]; refs: Map<string, string> };

export class PackPushMergeEngine implements MergeEngine {
  constructor(
    private readonly host: RepoHost,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async session(main: RepoHandle): Promise<Session> {
    return { main, remote: await main.remote(), auth: { token: await main.createToken("write", TOKEN_TTL_SECONDS) } };
  }

  // Reads main as it is now and builds the commit that lands the change on it.
  private async build(s: Session, fork: RepoHandle, request: MergeRequest): Promise<Built> {
    const advertised = await listRefs(s.remote, s.auth, this.fetchImpl);
    const mainOid = advertised.refs.get(`refs/heads/${request.branch}`);
    if (mainOid === undefined) {
      throw new MergeError(`branch ${request.branch} does not exist in ${request.repo}`);
    }
    const mainCommit = await s.main.readCommit(mainOid);
    if (mainCommit === null) {
      throw new MergeError(`commit ${mainOid} at the head of ${request.branch} could not be read`);
    }
    const notesOid = advertised.refs.get(NOTES_REF) ?? null;

    const joined = new Map<string, GitObject>();
    const compose = this.composer(request, s.main, fork, joined);
    // A file that was joined no longer looks like the task's version, so a merge that already
    // landed is recognised by its commit instead.
    if (compose !== undefined) {
      const existing = await findTaskCommit(s.main, mainOid, request.taskId);
      if (existing !== null) {
        return { kind: "landed", mergeSha: existing, ownCommit: true, notesOid };
      }
    }
    const overlay = await overlayChanges(s.main, mainCommit.tree, request.changes, compose);
    if (!overlay.ok) {
      return { kind: "stale", paths: overlay.stale };
    }
    if (overlay.applied.length === 0) {
      // Everything is on main already, most likely from an earlier attempt of this merge.
      const existing = await findTaskCommit(s.main, mainOid, request.taskId);
      return { kind: "landed", mergeSha: existing ?? mainOid, ownCommit: existing !== null, notesOid };
    }

    const message =
      overlay.composed.length === 0 ? request.message : withTrailer(request.message, `Dibs-Composed: ${overlay.composed.join(", ")}`);
    const blobs = await loadBlobs(fork, overlay.applied, joined);
    const commit = await makeObject(
      "commit",
      encodeCommit({
        tree: overlay.rootTree,
        parents: [mainOid],
        author: request.author,
        committer: COMMITTER,
        authoredAt: request.now,
        committedAt: request.now,
        message,
      }),
    );
    return {
      kind: "built",
      mainOid,
      treeSha: overlay.rootTree,
      commit,
      objects: [...blobs, ...overlay.trees, commit],
      composed: overlay.composed,
      refs: advertised.refs,
    };
  }

  // Attaches the note to a commit of main, and says whether the commit has it.
  private async noted(s: Session, request: MergeRequest, mergeSha: string, notesOid: string | null, composed: string[]): Promise<boolean> {
    const note = composed.length === 0 ? request.note : withComposed(request.note, composed);
    return note === null ? false : this.writeNote(s.main, s.remote, s.auth, notesOid, mergeSha, { ...request, note });
  }

  async merge(request: MergeRequest): Promise<MergeOutcome> {
    using main = await this.host.open(request.repo);
    using fork = await this.host.open(request.fork);
    const s = await this.session(main);
    const branchRef = `refs/heads/${request.branch}`;

    for (let attempt = 1; ; attempt++) {
      const built = await this.build(s, fork, request);
      if (built.kind === "stale") {
        return { status: "stale", paths: built.paths };
      }
      if (built.kind === "landed") {
        const noteWritten = built.ownCommit ? await this.noted(s, request, built.mergeSha, built.notesOid, []) : false;
        return { status: "merged", mergeSha: built.mergeSha, noteWritten };
      }
      const pushed = await pushPack(
        s.remote,
        { ref: branchRef, oldOid: built.mainOid, newOid: built.commit.oid },
        await buildPack(built.objects),
        s.auth,
        this.fetchImpl,
      );
      if (!pushed.ok) {
        if (pushed.stage === "ref" && attempt < PUSH_ATTEMPTS) {
          continue;
        }
        throw new MergeError(`push to ${request.branch} was rejected (${pushed.stage}): ${pushed.reason}`);
      }
      const noteWritten = await this.noted(s, request, built.commit.oid, built.refs.get(NOTES_REF) ?? null, built.composed);
      return built.composed.length === 0
        ? { status: "merged", mergeSha: built.commit.oid, noteWritten }
        : { status: "merged", mergeSha: built.commit.oid, noteWritten, composed: built.composed };
    }
  }

  async candidate(request: MergeRequest): Promise<CandidateOutcome> {
    using main = await this.host.open(request.repo);
    using fork = await this.host.open(request.fork);
    const s = await this.session(main);
    const ref = `${CANDIDATES_REF}/${request.taskId}`;

    for (let attempt = 1; ; attempt++) {
      const built = await this.build(s, fork, request);
      if (built.kind === "stale") {
        return { status: "stale", paths: built.paths };
      }
      if (built.kind === "landed") {
        const noteWritten = built.ownCommit ? await this.noted(s, request, built.mergeSha, built.notesOid, []) : false;
        return { status: "landed", mergeSha: built.mergeSha, noteWritten };
      }
      const pushed = await pushPack(
        s.remote,
        { ref, oldOid: built.refs.get(ref) ?? ZERO_OID, newOid: built.commit.oid },
        await buildPack(built.objects),
        s.auth,
        this.fetchImpl,
      );
      if (!pushed.ok) {
        // Another run of the same task moved the hidden ref meanwhile; read it again.
        if (pushed.stage === "ref" && attempt < PUSH_ATTEMPTS) {
          continue;
        }
        throw new MergeError(`push of the candidate was rejected (${pushed.stage}): ${pushed.reason}`);
      }
      return { status: "ready", candidateSha: built.commit.oid, baseSha: built.mainOid, treeSha: built.treeSha, ref, composed: built.composed };
    }
  }

  async land(request: MergeRequest, candidate: { candidateSha: string; baseSha: string; composed: string[] }): Promise<LandOutcome> {
    using main = await this.host.open(request.repo);
    const s = await this.session(main);
    const branchRef = `refs/heads/${request.branch}`;
    const advertised = await listRefs(s.remote, s.auth, this.fetchImpl);
    const mainOid = advertised.refs.get(branchRef);
    const notesOid = advertised.refs.get(NOTES_REF) ?? null;
    const merged = (noteWritten: boolean): LandOutcome =>
      candidate.composed.length === 0
        ? { status: "merged", mergeSha: candidate.candidateSha, noteWritten }
        : { status: "merged", mergeSha: candidate.candidateSha, noteWritten, composed: candidate.composed };

    // Landed already, by an earlier run of this step.
    if (mainOid === candidate.candidateSha) {
      return merged(await this.noted(s, request, candidate.candidateSha, notesOid, candidate.composed));
    }
    if (mainOid !== candidate.baseSha) {
      return { status: "moved", reason: `${request.branch} is at ${mainOid ?? "nothing"}, not at ${candidate.baseSha}` };
    }
    // The candidate's objects are in the repository already: the push carries none.
    const pushed = await pushPack(
      s.remote,
      { ref: branchRef, oldOid: candidate.baseSha, newOid: candidate.candidateSha },
      await buildPack([]),
      s.auth,
      this.fetchImpl,
    );
    if (!pushed.ok) {
      if (pushed.stage === "ref") {
        return { status: "moved", reason: pushed.reason };
      }
      throw new MergeError(`push to ${request.branch} was rejected (${pushed.stage}): ${pushed.reason}`);
    }
    return merged(await this.noted(s, request, candidate.candidateSha, notesOid, candidate.composed));
  }

  // Joins a change to a file the task holds to add to with what main holds there. Undefined when the task holds nothing so.
  private composer(request: MergeRequest, main: RepoHandle, fork: RepoHandle, joined: Map<string, GitObject>): Compose | undefined {
    const shared = request.composable ?? [];
    if (shared.length === 0) {
      return undefined;
    }
    const covered = (path: string) => shared.some((held) => (held.endsWith("/") ? path.startsWith(held) : held === path));
    const text = async (repo: RepoHandle, oid: string): Promise<string | null> => {
      const bytes = await repo.readBlob(oid);
      if (bytes === null || bytes.length > MAX_COMPOSE_BYTES) {
        return null;
      }
      try {
        return strictText.decode(bytes);
      } catch {
        return null;
      }
    };
    return async (change: Change, onMain: Leaf): Promise<Leaf | null> => {
      if (!covered(change.path) || change.base === null || change.head === null || onMain.mode !== change.head.mode) {
        return null;
      }
      const [base, ours, theirs] = await Promise.all([text(fork, change.base.oid), text(main, onMain.oid), text(fork, change.head.oid)]);
      if (base === null || ours === null || theirs === null) {
        return null;
      }
      // What main holds is "ours": what other tasks added to the file comes first, and this task's additions after it.
      const merged = merge3(base, ours, theirs);
      if (!merged.ok) {
        return null;
      }
      const blob = await makeObject("blob", new TextEncoder().encode(merged.text));
      joined.set(blob.oid, blob);
      return { mode: change.head.mode, oid: blob.oid };
    };
  }

  // Best effort: the merge stands whether or not the note lands.
  private async writeNote(
    main: RepoHandle,
    remote: string,
    auth: RemoteAuth,
    notesOid: string | null,
    mergeSha: string,
    request: MergeRequest,
  ): Promise<boolean> {
    try {
      const notesCommit = notesOid === null ? null : await main.readCommit(notesOid);
      const entries = notesCommit === null ? [] : ((await main.readTree(notesCommit.tree)) ?? []);
      if (entries.some((entry) => entry.name === mergeSha)) {
        return true;
      }

      const blob = await makeObject("blob", new TextEncoder().encode(request.note ?? ""));
      const tree = await makeObject(
        "tree",
        encodeTree([...entries, { name: mergeSha, mode: "100644", oid: blob.oid }]),
      );
      const commit = await makeObject(
        "commit",
        encodeCommit({
          tree: tree.oid,
          parents: notesOid === null ? [] : [notesOid],
          author: COMMITTER,
          committer: COMMITTER,
          authoredAt: request.now,
          committedAt: request.now,
          message: `Verdict for ${request.taskId}\n`,
        }),
      );
      const pushed = await pushPack(
        remote,
        { ref: NOTES_REF, oldOid: notesOid ?? ZERO_OID, newOid: commit.oid },
        await buildPack([blob, tree, commit]),
        auth,
        this.fetchImpl,
      );
      return pushed.ok;
    } catch {
      return false;
    }
  }
}

async function findTaskCommit(main: RepoHandle, from: string, taskId: string): Promise<string | null> {
  for (const commit of await main.log(from, TASK_COMMIT_SEARCH_DEPTH)) {
    const isTaskCommit = parseTrailers(commit.message).some(
      (trailer) => trailer.key === "Dibs-Task" && trailer.value === taskId,
    );
    if (isTaskCommit) {
      return commit.oid;
    }
  }
  return null;
}

// Adds a trailer at the end of a message whose last paragraph is its trailers.
function withTrailer(message: string, trailer: string): string {
  return `${message.replace(/\n+$/, "")}\n${trailer}\n`;
}

// Adds the joined files to a JSON note. A note that is not JSON is left as it is.
function withComposed(note: string | null, composed: string[]): string | null {
  if (note === null) {
    return null;
  }
  try {
    return `${JSON.stringify({ ...(JSON.parse(note) as object), composed }, null, 2)}\n`;
  } catch {
    return note;
  }
}

// Fetches the content of every added or modified file from the fork. A joined file was built here, not read.
async function loadBlobs(fork: RepoHandle, applied: Change[], joined: Map<string, GitObject>): Promise<GitObject[]> {
  const blobs = new Map<string, GitObject>();
  for (const change of applied) {
    const head = change.head;
    // A submodule link points at a commit in another repository; there is no file content to carry.
    if (head === null || head.mode === GITLINK_MODE || blobs.has(head.oid)) {
      continue;
    }
    const built = joined.get(head.oid);
    if (built !== undefined) {
      blobs.set(head.oid, built);
      continue;
    }
    const bytes = await fork.readBlob(head.oid);
    if (bytes === null) {
      throw new MergeError(`content of ${change.path} (${head.oid}) is missing from ${fork.name}`);
    }
    const blob = await makeObject("blob", bytes);
    if (blob.oid !== head.oid) {
      throw new MergeError(`content of ${change.path} does not match its id ${head.oid}`);
    }
    blobs.set(head.oid, blob);
  }
  return [...blobs.values()];
}
