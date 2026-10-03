import { afterAll, describe, expect, it } from "vitest";
import { buildDiff, type BlobReader } from "../../src/diff";
import { diffTrees, type Change } from "../../src/git/changes";
import { git, gitRaw, initRepo, lsTree, removeTempDirs } from "./helpers/git";
import { applyFiles, buildScenario, commitAll, gitTreeReader, treeOf } from "./helpers/scenario";

afterAll(removeTempDirs);

function blobReader(dir: string): BlobReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async readBlob(oid: string) {
      reads.push(oid);
      return new Uint8Array(gitRaw(dir, ["cat-file", "blob", oid]));
    },
  };
}

async function changesBetween(dir: string, from: string, to: string): Promise<Change[]> {
  return diffTrees(gitTreeReader(dir), treeOf(dir, from), treeOf(dir, to));
}

describe("buildDiff", () => {
  it("renders a patch that git applies to turn the base tree into the task's tree", async () => {
    const scenario = buildScenario();
    const changes = await changesBetween(scenario.dir, scenario.base, scenario.head);

    const result = await buildDiff(blobReader(scenario.dir), changes);

    const patch = result.files.map((file) => file.text).join("");
    git(scenario.dir, ["checkout", "--quiet", "--detach", scenario.base]);
    git(scenario.dir, ["apply", "--index", "-"], { input: patch });
    expect(git(scenario.dir, ["write-tree"])).toBe(treeOf(scenario.dir, scenario.head));
    expect(result.files.map((file) => file.path)).toEqual(changes.map((change) => change.path));
    expect(result.unreviewable).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.bytes).toBe(Buffer.byteLength(patch, "utf8"));
  });

  it("handles files without a trailing newline, empty files and non-ASCII text", async () => {
    const dir = initRepo();
    applyFiles(dir, { "a.txt": "one\ntwo", "b.txt": "", "c.txt": "café\n", "gone-empty.txt": "" });
    const base = commitAll(dir, "base");
    applyFiles(dir, {
      "a.txt": "one\ntwo\nthree",
      "b.txt": "now has content\n",
      "c.txt": "café ☕\n",
      "new-empty.txt": "",
      "gone-empty.txt": null,
    });
    const head = commitAll(dir, "head");

    const result = await buildDiff(blobReader(dir), await changesBetween(dir, base, head));

    git(dir, ["checkout", "--quiet", "--detach", base]);
    git(dir, ["apply", "--index", "-"], { input: result.files.map((file) => file.text).join("") });
    expect(git(dir, ["write-tree"])).toBe(treeOf(dir, head));
  });

  it("shows a mode-only change without reading any file content", async () => {
    const scenario = buildScenario();
    const changes = (await changesBetween(scenario.dir, scenario.base, scenario.head)).filter(
      (change) => change.path === "scripts/run.sh",
    );
    const reader = blobReader(scenario.dir);

    const result = await buildDiff(reader, changes);

    expect(result.files).toEqual([
      {
        path: "scripts/run.sh",
        status: "modified",
        text: "diff --git a/scripts/run.sh b/scripts/run.sh\nold mode 100644\nnew mode 100755\n",
      },
    ]);
    expect(reader.reads).toEqual([]);
  });

  it("marks a binary file as unreviewable and gives it no text", async () => {
    const dir = initRepo();
    applyFiles(dir, { "readme.txt": "hello\n" });
    const base = commitAll(dir, "base");
    gitRaw(dir, ["update-index", "--add", "--cacheinfo", `100644,${git(dir, ["hash-object", "-w", "--stdin"], { input: new Uint8Array([137, 80, 78, 71, 0, 1, 2, 3]) })},logo.png`]);
    const head = git(dir, ["commit-tree", git(dir, ["write-tree"]), "-p", base, "-m", "binary"]);

    const result = await buildDiff(blobReader(dir), await changesBetween(dir, base, head));

    expect(result.files).toEqual([{ path: "logo.png", status: "added", text: null }]);
    expect(result.unreviewable).toEqual(["logo.png"]);
  });

  it("marks text that is not valid UTF-8 as unreviewable", async () => {
    const dir = initRepo();
    applyFiles(dir, { "readme.txt": "hello\n" });
    const base = commitAll(dir, "base");
    const latin1 = git(dir, ["hash-object", "-w", "--stdin"], { input: new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]) });
    gitRaw(dir, ["update-index", "--add", "--cacheinfo", `100644,${latin1},latin1.txt`]);
    const head = git(dir, ["commit-tree", git(dir, ["write-tree"]), "-p", base, "-m", "latin1"]);

    const result = await buildDiff(blobReader(dir), await changesBetween(dir, base, head));

    expect(result.unreviewable).toEqual(["latin1.txt"]);
  });

  it("marks a submodule link as unreviewable without trying to read it", async () => {
    const reader = blobReader(initRepo());
    const gitlink: Change = {
      path: "vendor/lib",
      status: "added",
      base: null,
      head: { mode: "160000", oid: "1".repeat(40) },
    };

    const result = await buildDiff(reader, [gitlink]);

    expect(result).toEqual({
      files: [{ path: "vendor/lib", status: "added", text: null }],
      bytes: 0,
      unreviewable: ["vendor/lib"],
      truncated: false,
    });
    expect(reader.reads).toEqual([]);
  });

  it("stops reading once the diff is over the size limit", async () => {
    const dir = initRepo();
    applyFiles(dir, { "seed.txt": "seed\n" });
    const base = commitAll(dir, "base");
    const files: Record<string, string> = {};
    for (let index = 0; index < 10; index++) {
      files[`f${index}.txt`] = `${"line of text\n".repeat(20)}`;
    }
    applyFiles(dir, files);
    const head = commitAll(dir, "ten files");
    const reader = blobReader(dir);

    const result = await buildDiff(reader, await changesBetween(dir, base, head), { maxBytes: 800 });

    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeGreaterThan(800);
    // Each file's diff is about 365 bytes, so the third one crosses the limit and the rest are never read.
    expect(result.files).toHaveLength(3);
    expect(reader.reads).toHaveLength(3);
  });

  it("does not diff a file that is far larger than the limit, and reports the diff as over it", async () => {
    const dir = initRepo();
    applyFiles(dir, { "seed.txt": "seed\n" });
    const base = commitAll(dir, "base");
    applyFiles(dir, { "big.txt": "0123456789\n".repeat(50_000) });
    const head = commitAll(dir, "big");
    const [big] = lsTree(dir, head).filter((entry) => entry.name === "big.txt");

    const result = await buildDiff(
      { readBlob: async (oid) => new Uint8Array(gitRaw(dir, ["cat-file", "blob", oid])) },
      await changesBetween(dir, base, head),
    );

    expect(big).toBeDefined();
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeGreaterThan(100 * 1024);
    expect(result.files).toEqual([]);
  });
});
