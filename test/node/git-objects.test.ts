import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { encodeCommit, encodeTree, makeObject, type TreeEntry } from "../../src/git/objects";
import { FIXED_ENV, git, initRepo, lsTree, removeTempDirs } from "./helpers/git";

afterAll(removeTempDirs);

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("makeObject", () => {
  it.each([
    ["text", utf8("hello\n")],
    ["empty", new Uint8Array(0)],
    ["binary with NUL bytes", new Uint8Array([0, 1, 2, 0, 255, 254, 0])],
  ])("gives a blob the id git gives it (%s)", async (_label, data) => {
    const repo = initRepo();
    const want = git(repo, ["hash-object", "--stdin"], { input: data });

    const object = await makeObject("blob", data);

    expect(object.oid).toBe(want);
    expect(object.type).toBe("blob");
    expect(object.data).toEqual(data);
  });
});

describe("encodeTree", () => {
  it("reproduces the tree git writes, including git's directory sort order", async () => {
    const repo = initRepo();
    // git sorts a directory as if its name ended in "/", so the order here is
    // foo-bar, foo.txt, foo/ (the directory), foo0. A plain name sort gets this wrong.
    writeFileSync(join(repo, "foo-bar"), "1\n");
    writeFileSync(join(repo, "foo.txt"), "2\n");
    mkdirSync(join(repo, "foo"));
    writeFileSync(join(repo, "foo", "inner.txt"), "3\n");
    writeFileSync(join(repo, "foo0"), "4\n");
    // UTF-8 byte order differs from JavaScript string order for these two names.
    writeFileSync(join(repo, "～.txt"), "5\n");
    writeFileSync(join(repo, "\u{1f600}.txt"), "6\n");
    writeFileSync(join(repo, "run.sh"), "#!/bin/sh\n");
    chmodSync(join(repo, "run.sh"), 0o755);
    symlinkSync("foo.txt", join(repo, "link"));
    git(repo, ["add", "-A"]);
    const want = git(repo, ["write-tree"]);
    const entries: TreeEntry[] = lsTree(repo, want).map(({ name, mode, oid }) => ({ name, mode, oid }));
    expect(entries.map((entry) => entry.mode).sort()).toEqual([
      "040000",
      "100644",
      "100644",
      "100644",
      "100644",
      "100644",
      "100755",
      "120000",
    ]);

    const tree = await makeObject("tree", encodeTree([...entries].reverse()));

    expect(tree.oid).toBe(want);
  });

  it("gives the well-known id for an empty tree", async () => {
    const tree = await makeObject("tree", encodeTree([]));

    expect(tree.oid).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });

  it("refuses an entry whose name contains a slash", () => {
    expect(() =>
      encodeTree([{ name: "a/b", mode: "100644", oid: "ce013625030ba8dba906f756967f9e9ca394464a" }]),
    ).toThrow(/name/);
  });

  it("refuses an entry whose id is not a 40-character hex string", () => {
    expect(() => encodeTree([{ name: "a", mode: "100644", oid: "abc" }])).toThrow(/id/);
  });
});

describe("encodeCommit", () => {
  function seedTree(): { repo: string; tree: string } {
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, ["add", "-A"]);
    return { repo, tree: git(repo, ["write-tree"]) };
  }

  const author = { name: FIXED_ENV.GIT_AUTHOR_NAME, email: FIXED_ENV.GIT_AUTHOR_EMAIL };
  const committer = { name: FIXED_ENV.GIT_COMMITTER_NAME, email: FIXED_ENV.GIT_COMMITTER_EMAIL };

  it("reproduces a root commit git writes", async () => {
    const { repo, tree } = seedTree();
    const message = "Add a\n\nBody line.\n\nDibs-Task: t-abc123\n";
    const want = git(repo, ["commit-tree", tree, "-F", "-"], { input: message });

    const commit = await makeObject(
      "commit",
      encodeCommit({ tree, parents: [], author, committer, authoredAt: 1760000000, committedAt: 1760000100, message }),
    );

    expect(commit.oid).toBe(want);
  });

  it("reproduces a commit with a parent", async () => {
    const { repo, tree } = seedTree();
    const parent = git(repo, ["commit-tree", tree, "-m", "first"]);
    const message = "second\n";
    const want = git(repo, ["commit-tree", tree, "-p", parent, "-F", "-"], { input: message });

    const commit = await makeObject(
      "commit",
      encodeCommit({
        tree,
        parents: [parent],
        author,
        committer,
        authoredAt: 1760000000,
        committedAt: 1760000100,
        message,
      }),
    );

    expect(commit.oid).toBe(want);
  });

  it("ends the message with exactly one newline", async () => {
    const { repo, tree } = seedTree();
    const want = git(repo, ["commit-tree", tree, "-F", "-"], { input: "no newline at end\n" });

    const commit = await makeObject(
      "commit",
      encodeCommit({
        tree,
        parents: [],
        author,
        committer,
        authoredAt: 1760000000,
        committedAt: 1760000100,
        message: "no newline at end",
      }),
    );

    expect(commit.oid).toBe(want);
  });

  it("keeps angle brackets and newlines out of the identity lines", async () => {
    const { repo, tree } = seedTree();
    const want = git(repo, ["commit-tree", tree, "-F", "-"], {
      input: "m\n",
      env: { GIT_AUTHOR_NAME: "Evil Name", GIT_AUTHOR_EMAIL: "evil@example.invalid" },
    });

    const commit = await makeObject(
      "commit",
      encodeCommit({
        tree,
        parents: [],
        author: { name: "Evil <Name>\n", email: "<evil@example.invalid>\n" },
        committer,
        authoredAt: 1760000000,
        committedAt: 1760000100,
        message: "m\n",
      }),
    );

    expect(commit.oid).toBe(want);
  });
});
