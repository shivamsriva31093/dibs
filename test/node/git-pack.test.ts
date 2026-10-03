import { afterAll, describe, expect, it } from "vitest";
import { encodeCommit, encodeTree, makeObject } from "../../src/git/objects";
import { buildPack } from "../../src/git/pack";
import { git, gitRaw, initRepo, lsTree, removeTempDirs } from "./helpers/git";

afterAll(removeTempDirs);

// Deterministic, incompressible-looking bytes so that failures are reproducible.
function pseudoRandomBytes(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  let state = seed >>> 0;
  for (let index = 0; index < size; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[index] = state >>> 24;
  }
  return out;
}

const identity = { name: "Packer", email: "packer@example.invalid" };

describe("buildPack", () => {
  it("writes a pack that git unpacks with every object intact", async () => {
    // These sizes sit on each side of the boundaries of the pack's variable-length size header.
    const sizes = [0, 1, 15, 16, 2047, 2048, 300_000];
    const blobs = await Promise.all(sizes.map((size, index) => makeObject("blob", pseudoRandomBytes(size, index + 1))));
    const tree = await makeObject(
      "tree",
      encodeTree(blobs.map((blob, index) => ({ name: `file-${sizes[index]}.bin`, mode: "100644", oid: blob.oid }))),
    );
    const commit = await makeObject(
      "commit",
      encodeCommit({
        tree: tree.oid,
        parents: [],
        author: identity,
        committer: identity,
        authoredAt: 1760000000,
        committedAt: 1760000000,
        message: "pack test\n",
      }),
    );

    const pack = await buildPack([...blobs, tree, commit]);

    const repo = initRepo({ bare: true });
    gitRaw(repo, ["unpack-objects", "--strict", "-q"], { input: pack });
    git(repo, ["update-ref", "refs/heads/main", commit.oid]);
    expect(git(repo, ["fsck", "--strict", "--no-dangling"])).toBe("");
    for (const blob of blobs) {
      expect(new Uint8Array(gitRaw(repo, ["cat-file", "blob", blob.oid]))).toEqual(blob.data);
    }
    expect(lsTree(repo, "main").map((entry) => entry.name)).toEqual([
      "file-0.bin",
      "file-1.bin",
      "file-15.bin",
      "file-16.bin",
      "file-2047.bin",
      "file-2048.bin",
      "file-300000.bin",
    ]);
  });

  it("stores an object once even when it is passed twice", async () => {
    const blob = await makeObject("blob", new TextEncoder().encode("same\n"));

    const pack = await buildPack([blob, blob]);

    // Bytes 8..11 of a pack are the big-endian object count.
    expect([...pack.subarray(8, 12)]).toEqual([0, 0, 0, 1]);
    const repo = initRepo({ bare: true });
    gitRaw(repo, ["unpack-objects", "--strict", "-q"], { input: pack });
    expect(git(repo, ["cat-file", "blob", blob.oid])).toBe("same");
  });

  it("writes a valid pack with no objects", async () => {
    const pack = await buildPack([]);

    const repo = initRepo({ bare: true });
    gitRaw(repo, ["unpack-objects", "--strict", "-q"], { input: pack });
    expect([...pack.subarray(0, 12)]).toEqual([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
  });
});
