import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeCommit, encodeTree, makeObject, ZERO_OID, type GitObject } from "../../src/git/objects";
import { buildPack } from "../../src/git/pack";
import { listRefs, pushPack } from "../../src/git/remote";
import {
  createServedRepo,
  git,
  gitAsync,
  initRepo,
  lsTree,
  makeTempDir,
  removeTempDirs,
  startGitServer,
  type GitServer,
} from "./helpers/git";

let server: GitServer;

beforeAll(async () => {
  server = await startGitServer();
});

afterAll(async () => {
  await server.close();
  removeTempDirs();
});

const utf8 = (text: string) => new TextEncoder().encode(text);
const identity = { name: "dibs", email: "dibs@dibs.invalid" };

// A served repo whose main branch has one commit, made by the real git.
function seedRepo(name: string): { dir: string; remote: string; head: string; work: string } {
  const { dir, remote } = createServedRepo(server, name);
  const work = initRepo();
  writeFileSync(join(work, "README.md"), "# seed\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "seed"]);
  git(work, ["push", "--quiet", dir, "main"]);
  return { dir, remote, head: git(dir, ["rev-parse", "refs/heads/main"]), work };
}

// A commit on top of `parent` that adds one file to the parent's root tree.
async function commitAddingFile(
  dir: string,
  parent: string,
  file: { name: string; mode: string; content: string },
): Promise<{ objects: GitObject[]; commit: GitObject }> {
  const blob = await makeObject("blob", utf8(file.content));
  const existing = lsTree(dir, parent).map(({ name, mode, oid }) => ({ name, mode, oid }));
  const tree = await makeObject(
    "tree",
    encodeTree([...existing, { name: file.name, mode: file.mode, oid: blob.oid }]),
  );
  const commit = await makeObject(
    "commit",
    encodeCommit({
      tree: tree.oid,
      parents: [parent],
      author: identity,
      committer: identity,
      authoredAt: 1760000000,
      committedAt: 1760000000,
      message: `add ${file.name}\n`,
    }),
  );
  return { objects: [blob, tree, commit], commit };
}

describe("listRefs", () => {
  it("reads the branch head that a real git server advertises", async () => {
    const { remote, head } = seedRepo("list-refs");

    const advertised = await listRefs(remote);

    expect(Object.fromEntries(advertised.refs)).toEqual({ "refs/heads/main": head });
    expect(advertised.capabilities.has("report-status")).toBe(true);
  });

  it("returns no refs, but still the capabilities, for an empty repository", async () => {
    const { remote } = createServedRepo(server, "empty");

    const advertised = await listRefs(remote);

    expect([...advertised.refs]).toEqual([]);
    expect(advertised.capabilities.has("report-status")).toBe(true);
  });

  it("fails with the HTTP status when the repository does not exist", async () => {
    await expect(listRefs(`${server.url}/missing.git`)).rejects.toThrow(/404/);
  });

  it("sends the token as a bearer credential", async () => {
    const { remote } = seedRepo("auth-header");
    const seen: (string | null)[] = [];
    const spyingFetch: typeof fetch = async (input, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return fetch(input, init);
    };

    await listRefs(remote, { token: "art_v1_abc?expires=1760003600" }, spyingFetch);

    expect(seen).toEqual(["Bearer art_v1_abc?expires=1760003600"]);
  });
});

describe("pushPack", () => {
  it("lands a hand-built commit on a real git server", async () => {
    const { dir, remote, head } = seedRepo("push-ok");
    const { objects, commit } = await commitAddingFile(dir, head, {
      name: "run.sh",
      mode: "100755",
      content: "#!/bin/sh\necho hi\n",
    });

    const result = await pushPack(
      remote,
      { ref: "refs/heads/main", oldOid: head, newOid: commit.oid },
      await buildPack(objects),
    );

    expect(result).toEqual({ ok: true });
    expect(git(dir, ["rev-parse", "refs/heads/main"])).toBe(commit.oid);
    expect(git(dir, ["fsck", "--strict", "--no-dangling"])).toBe("");
    const clone = makeTempDir();
    await gitAsync(clone, ["clone", "--quiet", remote, "."]);
    expect(readFileSync(join(clone, "run.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
    expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("# seed\n");
    expect(statSync(join(clone, "run.sh")).mode & 0o111).toBe(0o111);
    expect(git(clone, ["log", "--format=%s"])).toBe("add run.sh\nseed");
  });

  it("is refused, and changes nothing, when the branch moved after its head was read", async () => {
    const { dir, remote, head, work } = seedRepo("push-stale");
    const { objects, commit } = await commitAddingFile(dir, head, {
      name: "mine.txt",
      mode: "100644",
      content: "mine\n",
    });
    // Someone else lands a commit first.
    writeFileSync(join(work, "theirs.txt"), "theirs\n");
    git(work, ["add", "-A"]);
    git(work, ["commit", "--quiet", "-m", "theirs"]);
    git(work, ["push", "--quiet", dir, "main"]);
    const theirs = git(dir, ["rev-parse", "refs/heads/main"]);

    const result = await pushPack(
      remote,
      { ref: "refs/heads/main", oldOid: head, newOid: commit.oid },
      await buildPack(objects),
    );

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ stage: "ref" });
    expect(git(dir, ["rev-parse", "refs/heads/main"])).toBe(theirs);
  });

  it("creates a ref that does not exist yet", async () => {
    const { dir, remote, head } = seedRepo("push-new-ref");
    const { objects, commit } = await commitAddingFile(dir, head, {
      name: "note.txt",
      mode: "100644",
      content: "note\n",
    });

    const result = await pushPack(
      remote,
      { ref: "refs/notes/dibs", oldOid: ZERO_OID, newOid: commit.oid },
      await buildPack(objects),
    );

    expect(result).toEqual({ ok: true });
    expect(git(dir, ["rev-parse", "refs/notes/dibs"])).toBe(commit.oid);
    expect(git(dir, ["rev-parse", "refs/heads/main"])).toBe(head);
  });

  it("reports an unpack failure, and changes nothing, when the pack is corrupt", async () => {
    const { dir, remote, head } = seedRepo("push-corrupt");
    const { objects, commit } = await commitAddingFile(dir, head, {
      name: "x.txt",
      mode: "100644",
      content: "x\n",
    });
    const pack = await buildPack(objects);
    pack[pack.length - 1] = pack[pack.length - 1]! ^ 0xff;

    const result = await pushPack(remote, { ref: "refs/heads/main", oldOid: head, newOid: commit.oid }, pack);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ stage: "unpack" });
    expect(git(dir, ["rev-parse", "refs/heads/main"])).toBe(head);
  });

  it("fails with the HTTP status when the repository does not exist", async () => {
    await expect(
      pushPack(
        `${server.url}/missing.git`,
        { ref: "refs/heads/main", oldOid: ZERO_OID, newOid: "1".repeat(40) },
        await buildPack([]),
      ),
    ).rejects.toThrow(/404/);
  });

  it("sends the token as a bearer credential", async () => {
    const { dir, remote, head } = seedRepo("push-auth");
    const { objects, commit } = await commitAddingFile(dir, head, {
      name: "x.txt",
      mode: "100644",
      content: "x\n",
    });
    const seen: (string | null)[] = [];
    const spyingFetch: typeof fetch = async (input, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return fetch(input, init);
    };

    await pushPack(
      remote,
      { ref: "refs/heads/main", oldOid: head, newOid: commit.oid },
      await buildPack(objects),
      { token: "art_v1_abc?expires=1760003600" },
      spyingFetch,
    );

    expect(seen).toEqual(["Bearer art_v1_abc?expires=1760003600"]);
  });
});
