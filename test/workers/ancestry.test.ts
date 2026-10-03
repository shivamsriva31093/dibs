import { describe, expect, it } from "vitest";
import { newestMainAncestor } from "../../src/git/ancestry";

// A history given as "commit: its parents". The reader knows nothing else.
function history(parents: Record<string, string[]>) {
  const read: string[] = [];
  return {
    read,
    readCommit: async (oid: string) => {
      read.push(oid);
      return oid in parents ? { oid, parents: parents[oid]! } : null;
    },
  };
}

describe("newestMainAncestor", () => {
  // main, newest first: m3, m2, m1. A task forked at m1.
  const main = ["m3", "m2", "m1"];

  it("is the commit the fork started from when the fork has not caught up", async () => {
    const reader = history({ a2: ["a1"], a1: ["m1"] });

    expect(await newestMainAncestor(reader, "a2", main)).toBe("m1");
  });

  it("is the commit of main that was merged into the fork", async () => {
    // The agent pulled main at m3 into its work: a merge commit with two parents.
    const reader = history({ merge: ["a1", "m3"], a1: ["m1"] });

    expect(await newestMainAncestor(reader, "merge", main)).toBe("m3");
  });

  it("is the commit of main the work was rebased onto", async () => {
    const reader = history({ a2: ["a1"], a1: ["m2"] });

    expect(await newestMainAncestor(reader, "a2", main)).toBe("m2");
  });

  it("is the newest one when the fork has caught up more than once", async () => {
    const reader = history({ second: ["a2", "m3"], a2: ["first"], first: ["a1", "m2"], a1: ["m1"] });

    expect(await newestMainAncestor(reader, "second", main)).toBe("m3");
  });

  it("is the head itself when the fork holds nothing of its own", async () => {
    const reader = history({});

    expect(await newestMainAncestor(reader, "m2", main)).toBe("m2");
    expect(reader.read).toEqual([]);
  });

  it("does not read the history of main, which can be long", async () => {
    const reader = history({ merge: ["a1", "m3"], a1: ["m1"], m3: ["m2"], m2: ["m1"], m1: [] });

    await newestMainAncestor(reader, "merge", main);

    expect(reader.read.sort()).toEqual(["a1", "merge"]);
  });

  it("is null when the head shares no commit with main", async () => {
    const reader = history({ x2: ["x1"], x1: [] });

    expect(await newestMainAncestor(reader, "x2", main)).toBeNull();
  });

  it("gives up after reading a bounded number of commits", async () => {
    const parents: Record<string, string[]> = {};
    for (let index = 0; index < 50; index++) {
      parents[`c${index}`] = [`c${index + 1}`];
    }
    parents.c50 = ["m1"];
    const reader = history(parents);

    expect(await newestMainAncestor(reader, "c0", main, 10)).toBeNull();
    expect(reader.read).toHaveLength(10);
  });
});
