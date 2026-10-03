import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { indexFile, type IndexedFile } from "../../src/index/file";
import { IndexStore } from "../../src/index/store";
import { newCoordinator } from "./helpers/coordinator";

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);

const REPO: Record<string, string> = {
  "src/db/users.ts": `import { db, type User } from "./client";
export function findUser(id: string): User | null { return null; }
export function listUsers(): User[] { return []; }`,
  "src/db/client.ts": "export interface User { id: string }\nexport const db = new Map();",
  "src/db/index.ts": 'export * from "./users";\nexport { db as database } from "./client";',
  "src/routes/users/get.ts": 'import { findUser } from "../../db/users";\nexport const getUserRoute = 1;',
  "src/routes/users/list.ts": 'import { listUsers } from "../../db";\nexport const listUsersRoute = 1;',
  "src/routes/users/index.ts": 'import { getUserRoute } from "./get";\nimport { listUsersRoute } from "./list";\nexport const userRoutes = [getUserRoute, listUsersRoute];',
  "src/admin.ts": 'import * as users from "./db/users";\nimport { database } from "./db/index";\nexport const admin = 1;',
  "test/users.test.ts": 'import { findUser, listUsers } from "../src/db/users";',
};

async function indexed(files: Record<string, string>, all: Record<string, string> = files): Promise<IndexedFile[]> {
  const exists = (path: string) => path in all;
  const out: IndexedFile[] = [];
  for (const [path, text] of Object.entries(files)) {
    out.push((await indexFile(path, text, exists))!);
  }
  return out;
}

// Runs `use` against the index of a fresh repository that holds REPO.
async function withIndex<T>(use: (index: IndexStore) => T | Promise<T>, files: Record<string, string> = REPO): Promise<T> {
  const coordinator = await newCoordinator();
  const records = await indexed(files);
  return runInDurableObject(coordinator, async (_instance, state) => {
    const index = new IndexStore(state.storage.sql);
    index.replace(records, [], SHA1);
    return use(index);
  });
}

describe("the interface index", () => {
  it("counts what it holds", async () => {
    expect(await withIndex((index) => index.status())).toEqual({ files: 8, interfaces: 9, references: 12 });
  });

  it("knows an interface by its file and name", async () => {
    const found = await withIndex((index) => index.signature("src/db/users.ts", "findUser"));

    expect(found).toMatchObject({
      kind: "function",
      signature: "export function findUser(id: string): User | null",
      sinceSha: SHA1,
    });
    expect(found?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("knows nothing of an interface that is not there", async () => {
    expect(await withIndex((index) => index.signature("src/db/users.ts", "nope"))).toBeNull();
    expect(await withIndex((index) => index.signature("src/nope.ts", "findUser"))).toBeNull();
  });

  it("says whether it has read a file", async () => {
    expect(await withIndex((index) => [index.has("src/admin.ts"), index.has("README.md")])).toEqual([true, false]);
  });
});

describe("where a name comes from", () => {
  it("is the file itself for a name the file declares", async () => {
    expect(await withIndex((index) => index.origin("src/db/users.ts", "findUser"))).toEqual({ path: "src/db/users.ts", name: "findUser" });
  });

  it("is the file a name is passed on from, under the name it has there", async () => {
    expect(await withIndex((index) => index.origin("src/db/index.ts", "database"))).toEqual({ path: "src/db/client.ts", name: "db" });
  });

  it("is found through a file that passes on everything", async () => {
    expect(await withIndex((index) => index.origin("src/db/index.ts", "findUser"))).toEqual({ path: "src/db/users.ts", name: "findUser" });
  });

  it("is the name as given when the index cannot find it", async () => {
    expect(await withIndex((index) => index.origin("src/db/index.ts", "nope"))).toEqual({ path: "src/db/index.ts", name: "nope" });
    expect(await withIndex((index) => index.origin("src/unknown.ts", "x"))).toEqual({ path: "src/unknown.ts", name: "x" });
  });

  it("stops at a chain of files that pass names round in a circle", async () => {
    const circle = { "a.ts": 'export * from "./b";', "b.ts": 'export * from "./a";' };

    expect(await withIndex((index) => index.origin("a.ts", "x"), circle)).toEqual({ path: "a.ts", name: "x" });
  });
});

describe("what the files under some paths use", () => {
  it("lists the interfaces of other files, at the place they come from", async () => {
    expect(await withIndex((index) => index.usedBy(["src/routes/users/"]))).toEqual([
      { path: "src/db/users.ts", name: "findUser" },
      { path: "src/db/users.ts", name: "listUsers" },
    ]);
  });

  it("leaves out what the files use of each other", async () => {
    const used = await withIndex((index) => index.usedBy(["src/routes/users/index.ts", "src/routes/users/get.ts"]));

    expect(used).toEqual([
      { path: "src/db/users.ts", name: "findUser" },
      { path: "src/routes/users/list.ts", name: "listUsersRoute" },
    ]);
  });

  it("lists a file used as a whole under the name *", async () => {
    expect(await withIndex((index) => index.usedBy(["src/admin.ts"]))).toEqual([
      { path: "src/db/client.ts", name: "db" },
      { path: "src/db/users.ts", name: "*" },
    ]);
  });

  it("is empty for paths the index has not read", async () => {
    expect(await withIndex((index) => index.usedBy(["docs/", "src/new-file.ts"]))).toEqual([]);
  });
});

describe("who uses an interface", () => {
  it("lists the files that import it, directly or through a file that passes it on", async () => {
    expect(await withIndex((index) => index.dependents("src/db/users.ts", "listUsers"))).toEqual([
      "src/admin.ts",
      "src/routes/users/list.ts",
      "test/users.test.ts",
    ]);
  });

  it("counts a file that imports the whole module", async () => {
    expect(await withIndex((index) => index.dependents("src/db/users.ts", "findUser"))).toEqual([
      "src/admin.ts",
      "src/routes/users/get.ts",
      "test/users.test.ts",
    ]);
  });

  it("follows a name that is passed on under another name", async () => {
    expect(await withIndex((index) => index.dependents("src/db/client.ts", "db"))).toEqual(["src/admin.ts", "src/db/users.ts"]);
  });

  it("leaves out the files that only pass it on, unless asked for them", async () => {
    expect(await withIndex((index) => index.dependents("src/db/client.ts", "db", { withPassers: true }))).toEqual([
      "src/admin.ts",
      "src/db/index.ts",
      "src/db/users.ts",
    ]);
  });

  it("is empty for an interface nobody uses", async () => {
    expect(await withIndex((index) => index.dependents("src/admin.ts", "admin"))).toEqual([]);
  });
});

describe("the hash a task's reliance is compared by", () => {
  it("is the hash of the signature for an interface", async () => {
    const [hash, signature] = await withIndex((index) => [index.hashOf("src/db/users.ts#findUser"), index.signature("src/db/users.ts", "findUser")]);

    expect(hash).toBe(signature!.hash);
  });

  it("is one hash over all its interfaces for a file", async () => {
    expect(await withIndex((index) => index.hashOf("src/db/users.ts"))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is null for what is not there", async () => {
    expect(await withIndex((index) => [index.hashOf("src/db/users.ts#nope"), index.hashOf("src/nope.ts")])).toEqual([null, null]);
  });

  it("is undefined for a directory or a route, which are not compared", async () => {
    expect(await withIndex((index) => [index.hashOf("src/db/"), index.hashOf("route:GET /users")])).toEqual([undefined, undefined]);
  });
});

describe("replacing files in the index", () => {
  const CHANGED = {
    "src/db/users.ts": `import { db, type User } from "./client";
export function findUser(id: string): { ok: boolean } { return { ok: false }; }
export function listUsers(): User[] { return [...db.values()]; }`,
  };

  async function afterChange<T>(use: (index: IndexStore) => T): Promise<T> {
    const records = await indexed(CHANGED, REPO);
    return withIndex((index) => {
      index.replace(records, [], SHA2);
      return use(index);
    });
  }

  it("takes the new signature and remembers the commit that brought it", async () => {
    expect(await afterChange((index) => index.signature("src/db/users.ts", "findUser"))).toMatchObject({
      signature: "export function findUser(id: string): { ok: boolean }",
      sinceSha: SHA2,
    });
  });

  it("keeps the commit of an interface whose signature did not change", async () => {
    expect(await afterChange((index) => index.signature("src/db/users.ts", "listUsers"))).toMatchObject({ sinceSha: SHA1 });
  });

  it("changes the hash of the file as a whole", async () => {
    const before = await withIndex((index) => index.hashOf("src/db/users.ts"));

    expect(await afterChange((index) => index.hashOf("src/db/users.ts"))).not.toBe(before);
  });

  it("leaves the other files as they were", async () => {
    expect(await afterChange((index) => index.status())).toEqual({ files: 8, interfaces: 9, references: 12 });
  });

  it("forgets a file that was removed, and what it used", async () => {
    const after = await withIndex((index) => {
      index.replace([], ["src/routes/users/get.ts"], SHA2);
      return {
        has: index.has("src/routes/users/get.ts"),
        signature: index.signature("src/routes/users/get.ts", "getUserRoute"),
        dependents: index.dependents("src/db/users.ts", "findUser"),
      };
    });

    expect(after).toEqual({ has: false, signature: null, dependents: ["src/admin.ts", "test/users.test.ts"] });
  });

  it("forgets everything when it is cleared", async () => {
    const after = await withIndex((index) => {
      index.clear();
      return index.status();
    });

    expect(after).toEqual({ files: 0, interfaces: 0, references: 0 });
  });
});
