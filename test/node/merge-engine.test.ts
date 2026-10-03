import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffTrees, type Change } from "../../src/git/changes";
import { MergeError, PackPushMergeEngine, type MergeRequest } from "../../src/merge";
import { git, gitAsync, lsTree, makeTempDir, removeTempDirs, startGitServer, type GitServer } from "./helpers/git";
import { GitCliRepoHost } from "./helpers/git-host";
import { applyFiles, buildScenario, commitAll, gitTreeReader, treeOf, type Scenario } from "./helpers/scenario";

let server: GitServer;

beforeAll(async () => {
  server = await startGitServer();
});

afterAll(async () => {
  await server.close();
  removeTempDirs();
});

interface Setup {
  scenario: Scenario;
  host: GitCliRepoHost;
  repoDir: string;
  request: MergeRequest;
  // The tree a real three-way merge of `onto` and the task's head produces.
  mergedTree(onto: string): string;
}

// A served main repository at scenario.main, and a served fork holding the task's work.
async function setup(name: string): Promise<Setup> {
  const scenario = buildScenario();
  const host = new GitCliRepoHost(server);
  const fork = `${name}--t-1`;
  await host.create(name);
  await host.create(fork);
  git(scenario.dir, ["push", "--quiet", host.dir(name), `${scenario.main}:refs/heads/main`]);
  git(scenario.dir, ["push", "--quiet", host.dir(fork), `${scenario.head}:refs/heads/main`]);

  const changes = await diffTrees(
    gitTreeReader(scenario.dir),
    treeOf(scenario.dir, scenario.base),
    treeOf(scenario.dir, scenario.head),
  );
  return {
    scenario,
    host,
    repoDir: host.dir(name),
    request: {
      repo: name,
      branch: "main",
      fork,
      taskId: "t-1",
      changes,
      author: { name: "agent-one", email: "agent-one@agents.dibs.invalid" },
      message: "Add a health check\n\nAdds the route and its wiring.\n\nDibs-Task: t-1\nDibs-Agent: agent-one\n",
      note: '{"decision":"approve"}',
      now: 1760001000,
    },
    mergedTree: (onto) => git(scenario.dir, ["merge-tree", "--write-tree", onto, scenario.head]).split("\n")[0]!,
  };
}

const mainHead = (repoDir: string) => git(repoDir, ["rev-parse", "refs/heads/main"]);

// Lands an unrelated commit on the served main branch, as another task's merge would.
function landInterloper(setup: Setup, file: string): string {
  git(setup.scenario.dir, ["checkout", "--quiet", "--detach", mainHead(setup.repoDir)]);
  applyFiles(setup.scenario.dir, { [file]: `${file}\n` });
  const commit = commitAll(setup.scenario.dir, `interloper ${file}`);
  git(setup.scenario.dir, ["push", "--quiet", setup.repoDir, `${commit}:refs/heads/main`]);
  return commit;
}

function isPushTo(init: RequestInit | undefined, input: RequestInfo | URL, ref: string): boolean {
  if (init?.method !== "POST" || !String(input).endsWith("/git-receive-pack")) {
    return false;
  }
  const head = new TextDecoder().decode((init.body as Uint8Array).subarray(0, 200));
  return head.includes(ref);
}

describe("PackPushMergeEngine", () => {
  it("lands a task's changes on main as one commit that real git accepts", async () => {
    const s = await setup("merge-ok");
    // The main repository must not already hold the task's objects, or this proves nothing.
    expect(() => git(s.repoDir, ["cat-file", "-e", s.scenario.head])).toThrow();

    const outcome = await new PackPushMergeEngine(s.host).merge(s.request);

    if (outcome.status !== "merged") {
      throw new Error(`expected merged, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.noteWritten).toBe(true);
    expect(mainHead(s.repoDir)).toBe(outcome.mergeSha);
    expect(git(s.repoDir, ["rev-list", "--parents", "-n1", outcome.mergeSha])).toBe(
      `${outcome.mergeSha} ${s.scenario.main}`,
    );
    expect(git(s.repoDir, ["rev-parse", `${outcome.mergeSha}^{tree}`])).toBe(s.mergedTree(s.scenario.main));
    // Every object the new commit needs made it across.
    expect(git(s.repoDir, ["fsck", "--strict", "--no-dangling"])).toBe("");
    expect(git(s.repoDir, ["show", "-s", "--format=%an|%ae|%cn|%ce|%at|%ct", outcome.mergeSha])).toBe(
      "agent-one|agent-one@agents.dibs.invalid|dibs|dibs@dibs.invalid|1760001000|1760001000",
    );
    expect(git(s.repoDir, ["show", "-s", "--format=%B", outcome.mergeSha])).toBe(s.request.message.trimEnd());
    expect(git(s.repoDir, ["notes", "--ref=dibs", "show", outcome.mergeSha])).toBe('{"decision":"approve"}');
  });

  it("produces a working tree with the task's files, modes and links, and everyone else's work intact", async () => {
    const s = await setup("merge-clone");

    await new PackPushMergeEngine(s.host).merge(s.request);

    const clone = makeTempDir();
    await gitAsync(clone, ["clone", "--quiet", s.host.remoteOf("merge-clone"), "."]);
    // The task's work.
    expect(readFileSync(join(clone, "src/routes/users.ts"), "utf8")).toBe("users v2\n");
    expect(readFileSync(join(clone, "src/routes/health.ts"), "utf8")).toBe("health\n");
    expect(readFileSync(join(clone, "src/new/deep/nested/file.ts"), "utf8")).toBe("deep\n");
    expect(existsSync(join(clone, "src/old"))).toBe(false);
    expect(statSync(join(clone, "scripts/run.sh")).mode & 0o111).toBe(0o111);
    expect(readFileSync(join(clone, "config/app.json"), "utf8")).toBe('{"a":1}\n');
    expect(readFileSync(join(clone, "docs/guide"), "utf8")).toBe("now a file\n");
    expect(lstatSync(join(clone, "link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(clone, "link"))).toBe("README.md");
    // What other tasks had already merged.
    expect(readFileSync(join(clone, "src/routes/posts.ts"), "utf8")).toBe("posts v2\n");
    expect(readFileSync(join(clone, "src/db/migrate.ts"), "utf8")).toBe("migrate\n");
    expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("# app, updated\n");
    expect(readFileSync(join(clone, "zeta.txt"), "utf8")).toBe("zeta\n");
    expect(existsSync(join(clone, "src/util/date.ts"))).toBe(false);
  });

  it("asks for one short-lived write token and reads only the blobs the task added or changed", async () => {
    const s = await setup("merge-minimal");
    const headBlobs = new Map(lsTree(s.scenario.dir, s.scenario.head, true).map((entry) => [entry.name, entry.oid]));

    await new PackPushMergeEngine(s.host).merge(s.request);

    expect(s.host.tokensIssued).toEqual([{ repo: "merge-minimal", scope: "write", ttlSeconds: 300 }]);
    const wanted = s.request.changes
      .filter((change) => change.status !== "deleted")
      .map((change) => headBlobs.get(change.path)!);
    expect(s.host.blobsRead.map((read) => read.repo)).toEqual(wanted.map(() => "merge-minimal--t-1"));
    expect(s.host.blobsRead.map((read) => read.oid).sort()).toEqual([...new Set(wanted)].sort());
  });

  it("returns stale, reads no blobs and leaves main alone when a changed path moved on main", async () => {
    const s = await setup("merge-stale");
    git(s.scenario.dir, ["checkout", "--quiet", "--detach", s.scenario.main]);
    applyFiles(s.scenario.dir, { "src/routes/users.ts": "users, changed by someone else\n" });
    const conflicting = commitAll(s.scenario.dir, "conflicting");
    git(s.scenario.dir, ["push", "--quiet", s.repoDir, `${conflicting}:refs/heads/main`]);

    const outcome = await new PackPushMergeEngine(s.host).merge(s.request);

    expect(outcome).toEqual({
      status: "stale",
      paths: [{ path: "src/routes/users.ts", reason: "changed on main since the task started" }],
    });
    expect(mainHead(s.repoDir)).toBe(conflicting);
    expect(s.host.blobsRead).toEqual([]);
  });

  describe("a file the task holds to add to", () => {
    // Another task added a line to src/routes/users.ts on main after this task forked; this task changed its first line.
    async function shared(name: string, onMain = "users v1\nposts are listed here too\n") {
      const s = await setup(name);
      git(s.scenario.dir, ["checkout", "--quiet", "--detach", s.scenario.main]);
      applyFiles(s.scenario.dir, { "src/routes/users.ts": onMain });
      const other = commitAll(s.scenario.dir, "another task adds to users.ts");
      git(s.scenario.dir, ["push", "--quiet", s.repoDir, `${other}:refs/heads/main`]);
      return { ...s, other };
    }

    it("is joined with what another task added to it on main, and the commit and the note say so", async () => {
      const s = await shared("merge-compose");

      const outcome = await new PackPushMergeEngine(s.host).merge({ ...s.request, composable: ["src/routes/users.ts"] });

      expect(outcome).toMatchObject({ status: "merged", noteWritten: true, composed: ["src/routes/users.ts"] });
      const sha = outcome.status === "merged" ? outcome.mergeSha : "";
      expect(git(s.repoDir, ["show", `${sha}:src/routes/users.ts`])).toBe("users v2\nposts are listed here too");
      expect(git(s.repoDir, ["log", "-1", "--format=%B", sha])).toContain("Dibs-Composed: src/routes/users.ts");
      expect(JSON.parse(git(s.repoDir, ["notes", "--ref=dibs", "show", sha]))).toMatchObject({
        decision: "approve",
        composed: ["src/routes/users.ts"],
      });
      git(s.repoDir, ["fsck", "--strict", "--no-dangling"]);
    });

    it("is covered by a directory held to add to", async () => {
      const s = await shared("merge-compose-directory");

      const outcome = await new PackPushMergeEngine(s.host).merge({ ...s.request, composable: ["src/routes/"] });

      expect(outcome).toMatchObject({ status: "merged", composed: ["src/routes/users.ts"] });
    });

    it("still goes back to its agent when the two changes cannot be joined", async () => {
      const s = await shared("merge-compose-conflict", "users v1, changed by someone else\n");

      const outcome = await new PackPushMergeEngine(s.host).merge({ ...s.request, composable: ["src/routes/users.ts"] });

      expect(outcome).toEqual({ status: "stale", paths: [{ path: "src/routes/users.ts", reason: "changed on main since the task started" }] });
      expect(mainHead(s.repoDir)).toBe(s.other);
    });

    it("goes back to its agent as before when the task holds it to change", async () => {
      const s = await shared("merge-compose-not-shared");

      expect(await new PackPushMergeEngine(s.host).merge(s.request)).toMatchObject({ status: "stale" });
    });

    it("is not joined twice when the same merge is run again", async () => {
      const s = await shared("merge-compose-twice");
      const engine = new PackPushMergeEngine(s.host);
      const request = { ...s.request, composable: ["src/routes/users.ts"] };
      const first = await engine.merge(request);

      const second = await engine.merge(request);

      expect(second).toMatchObject({ status: "merged", mergeSha: first.status === "merged" ? first.mergeSha : "" });
      expect(git(s.repoDir, ["show", "refs/heads/main:src/routes/users.ts"])).toBe("users v2\nposts are listed here too");
    });
  });

  describe("a candidate, built to be checked before it lands", () => {
    it("is the commit the merge would make, kept under a hidden ref, with main left alone", async () => {
      const s = await setup("candidate-ok");
      const before = mainHead(s.repoDir);

      const candidate = await new PackPushMergeEngine(s.host).candidate(s.request);

      expect(candidate).toEqual({
        status: "ready",
        candidateSha: expect.stringMatching(/^[0-9a-f]{40}$/),
        baseSha: before,
        treeSha: s.mergedTree(before),
        ref: "refs/dibs/candidates/t-1",
        composed: [],
      });
      const sha = candidate.status === "ready" ? candidate.candidateSha : "";
      expect(mainHead(s.repoDir)).toBe(before);
      expect(git(s.repoDir, ["rev-parse", "refs/dibs/candidates/t-1"])).toBe(sha);
      expect(git(s.repoDir, ["rev-parse", `${sha}^{tree}`])).toBe(s.mergedTree(before));
      expect(git(s.repoDir, ["rev-parse", `${sha}^`])).toBe(before);
      git(s.repoDir, ["fsck", "--strict", "--no-dangling"]);
    });

    it("lands as it is: main moves to the very commit that was checked, and gets its note", async () => {
      const s = await setup("candidate-land");
      const engine = new PackPushMergeEngine(s.host);
      const candidate = await engine.candidate(s.request);
      if (candidate.status !== "ready") {
        throw new Error("expected a candidate");
      }

      const landed = await engine.land(s.request, candidate);

      expect(landed).toEqual({ status: "merged", mergeSha: candidate.candidateSha, noteWritten: true });
      expect(mainHead(s.repoDir)).toBe(candidate.candidateSha);
      expect(JSON.parse(git(s.repoDir, ["notes", "--ref=dibs", "show", candidate.candidateSha]))).toEqual({ decision: "approve" });
    });

    it("does not land when main has moved since it was built", async () => {
      const s = await setup("candidate-moved");
      const engine = new PackPushMergeEngine(s.host);
      const candidate = await engine.candidate(s.request);
      if (candidate.status !== "ready") {
        throw new Error("expected a candidate");
      }
      const interloper = landInterloper(s, "src/interloper.ts");

      const landed = await engine.land(s.request, candidate);

      expect(landed).toEqual({ status: "moved", reason: `main is at ${interloper}, not at ${candidate.baseSha}` });
      expect(mainHead(s.repoDir)).toBe(interloper);
    });

    it("is built again on the new head, under the same ref, after main has moved", async () => {
      const s = await setup("candidate-again");
      const engine = new PackPushMergeEngine(s.host);
      const first = await engine.candidate(s.request);
      const interloper = landInterloper(s, "src/interloper.ts");

      const second = await engine.candidate(s.request);

      expect(second).toMatchObject({ status: "ready", baseSha: interloper });
      expect(second.status === "ready" && first.status === "ready" && second.candidateSha !== first.candidateSha).toBe(true);
      expect(git(s.repoDir, ["rev-parse", "refs/dibs/candidates/t-1"])).toBe(second.status === "ready" ? second.candidateSha : "");
    });

    it("lands a second time as nothing new, once the change is on main", async () => {
      const s = await setup("candidate-twice");
      const engine = new PackPushMergeEngine(s.host);
      const candidate = await engine.candidate(s.request);
      if (candidate.status !== "ready") {
        throw new Error("expected a candidate");
      }
      await engine.land(s.request, candidate);

      expect(await engine.land(s.request, candidate)).toEqual({ status: "merged", mergeSha: candidate.candidateSha, noteWritten: true });
      expect(await engine.candidate(s.request)).toEqual({ status: "landed", mergeSha: candidate.candidateSha, noteWritten: true });
      expect(git(s.repoDir, ["notes", "--ref=dibs", "list"]).split("\n")).toHaveLength(1);
    });

    it("is stale, like a merge, when a changed path moved on main", async () => {
      const s = await setup("candidate-stale");
      git(s.scenario.dir, ["checkout", "--quiet", "--detach", s.scenario.main]);
      applyFiles(s.scenario.dir, { "src/routes/users.ts": "users, changed by someone else\n" });
      const conflicting = commitAll(s.scenario.dir, "conflicting");
      git(s.scenario.dir, ["push", "--quiet", s.repoDir, `${conflicting}:refs/heads/main`]);

      expect(await new PackPushMergeEngine(s.host).candidate(s.request)).toMatchObject({ status: "stale" });
    });
  });

  it("does not commit twice when the same merge is run again", async () => {
    const s = await setup("merge-twice");
    const engine = new PackPushMergeEngine(s.host);
    const first = await engine.merge(s.request);

    const second = await engine.merge(s.request);

    expect(second).toEqual(first);
    expect(git(s.repoDir, ["rev-list", "--count", "refs/heads/main"])).toBe("3");
    expect(git(s.repoDir, ["notes", "--ref=dibs", "list"]).split("\n")).toHaveLength(1);
  });

  it("writes the note on a second run when the first run landed the commit but not the note", async () => {
    const s = await setup("merge-note-later");
    const failNotes: typeof fetch = async (input, init) =>
      isPushTo(init, input, "refs/notes/dibs") ? new Response("no", { status: 500 }) : fetch(input, init);
    const first = await new PackPushMergeEngine(s.host, failNotes).merge(s.request);
    expect(first).toMatchObject({ status: "merged", noteWritten: false });

    const second = await new PackPushMergeEngine(s.host).merge(s.request);

    expect(second).toEqual({ ...first, noteWritten: true });
    expect(git(s.repoDir, ["notes", "--ref=dibs", "show", mainHead(s.repoDir)])).toBe('{"decision":"approve"}');
    expect(git(s.repoDir, ["rev-list", "--count", "refs/heads/main"])).toBe("3");
  });

  it("merges onto the new head when main moves between reading it and pushing", async () => {
    const s = await setup("merge-race");
    let interloper = "";
    const raceOnce: typeof fetch = async (input, init) => {
      if (interloper === "" && isPushTo(init, input, "refs/heads/main")) {
        interloper = landInterloper(s, "interloper.txt");
      }
      return fetch(input, init);
    };

    const outcome = await new PackPushMergeEngine(s.host, raceOnce).merge(s.request);

    if (outcome.status !== "merged") {
      throw new Error(`expected merged, got ${JSON.stringify(outcome)}`);
    }
    expect(mainHead(s.repoDir)).toBe(outcome.mergeSha);
    expect(git(s.repoDir, ["rev-parse", `${outcome.mergeSha}^`])).toBe(interloper);
    expect(git(s.repoDir, ["rev-parse", `${outcome.mergeSha}^{tree}`])).toBe(s.mergedTree(interloper));
    expect(git(s.repoDir, ["fsck", "--strict", "--no-dangling"])).toBe("");
  });

  it("gives up with an error when main moves again on the retry", async () => {
    const s = await setup("merge-race-twice");
    let count = 0;
    const alwaysRace: typeof fetch = async (input, init) => {
      if (isPushTo(init, input, "refs/heads/main")) {
        landInterloper(s, `interloper-${++count}.txt`);
      }
      return fetch(input, init);
    };

    await expect(new PackPushMergeEngine(s.host, alwaysRace).merge(s.request)).rejects.toThrow(MergeError);

    expect(count).toBe(2);
    expect(git(s.repoDir, ["log", "-1", "--format=%s", "refs/heads/main"])).toBe("interloper interloper-2.txt");
  });

  it("keeps earlier notes when it adds a new one", async () => {
    const s = await setup("merge-notes");
    const engine = new PackPushMergeEngine(s.host);
    const first = await engine.merge(s.request);
    // A second task, forked from the same base, adding one file.
    git(s.scenario.dir, ["checkout", "--quiet", "--detach", s.scenario.base]);
    applyFiles(s.scenario.dir, { "extra/second.txt": "second\n" });
    const secondHead = commitAll(s.scenario.dir, "second task");
    await s.host.create("merge-notes--t-2");
    git(s.scenario.dir, ["push", "--quiet", s.host.dir("merge-notes--t-2"), `${secondHead}:refs/heads/main`]);
    const secondChanges = await diffTrees(
      gitTreeReader(s.scenario.dir),
      treeOf(s.scenario.dir, s.scenario.base),
      treeOf(s.scenario.dir, secondHead),
    );

    const second = await engine.merge({
      ...s.request,
      fork: "merge-notes--t-2",
      taskId: "t-2",
      changes: secondChanges,
      message: "Second\n\nDibs-Task: t-2\n",
      note: '{"decision":"approve","task":"t-2"}',
    });

    if (first.status !== "merged" || second.status !== "merged") {
      throw new Error("expected both merges to land");
    }
    expect(git(s.repoDir, ["notes", "--ref=dibs", "show", first.mergeSha])).toBe('{"decision":"approve"}');
    expect(git(s.repoDir, ["notes", "--ref=dibs", "show", second.mergeSha])).toBe('{"decision":"approve","task":"t-2"}');
    expect(git(s.repoDir, ["rev-list", "--count", "refs/notes/dibs"])).toBe("2");
    expect(git(s.repoDir, ["fsck", "--strict", "--no-dangling"])).toBe("");
  });

  it("writes no note when none is given", async () => {
    const s = await setup("merge-no-note");

    const outcome = await new PackPushMergeEngine(s.host).merge({ ...s.request, note: null });

    expect(outcome).toMatchObject({ status: "merged", noteWritten: false });
    expect(() => git(s.repoDir, ["rev-parse", "--verify", "--quiet", "refs/notes/dibs"])).toThrow();
  });

  it("refuses to push a blob whose content does not match its id, and leaves main alone", async () => {
    const s = await setup("merge-corrupt");
    s.host.blobOverride = (_repo, _oid, bytes) => new Uint8Array([...bytes, 0x21]);

    await expect(new PackPushMergeEngine(s.host).merge(s.request)).rejects.toThrow(/does not match/);

    expect(mainHead(s.repoDir)).toBe(s.scenario.main);
  });

  it("carries a submodule link across without trying to read it as a file", async () => {
    const s = await setup("merge-gitlink");
    const gitlink: Change = {
      path: "vendor/lib",
      status: "added",
      base: null,
      head: { mode: "160000", oid: s.scenario.head },
    };

    const outcome = await new PackPushMergeEngine(s.host).merge({ ...s.request, changes: [gitlink] });

    if (outcome.status !== "merged") {
      throw new Error(`expected merged, got ${JSON.stringify(outcome)}`);
    }
    expect(lsTree(s.repoDir, `${outcome.mergeSha}:vendor`)).toEqual([
      { mode: "160000", type: "commit", oid: s.scenario.head, name: "lib" },
    ]);
    expect(s.host.blobsRead).toEqual([]);
  });

  it("fails when the branch does not exist", async () => {
    const s = await setup("merge-no-branch");

    await expect(new PackPushMergeEngine(s.host).merge({ ...s.request, branch: "trunk" })).rejects.toThrow(/trunk/);
  });
});
