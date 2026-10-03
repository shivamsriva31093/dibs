import { describe, expect, it } from "vitest";
import { diffTrees } from "../../src/git/changes";
import { indexPaths, indexTree, interfaceReport } from "../../src/index/build";
import { fileDigest, indexFile } from "../../src/index/file";
import { signatureHash } from "../../src/index/signature";
import { MemoryRepoHost } from "./helpers/memory-host";

const OLD_FIND = "export function findUser(id: string): User | null";
const NEW_FIND = "export function findUser(id: string): Found";

const SEED: Record<string, string | Uint8Array> = {
  "README.md": "# demo\n",
  "src/db/client.ts": "export interface User { id: string }\nexport const db = new Map();\n",
  "src/db/users.ts": `import { db, type User } from "./client";\n${OLD_FIND} { return null; }\nexport function listUsers(): User[] { return []; }\n`,
  "src/db/index.ts": 'export * from "./users";\nexport { db as database } from "./client";\n',
  "src/router.ts": "export interface Route { path: string }\nexport function match(): void {}\n",
  "src/routes/list.ts": 'import { listUsers } from "../db";\nimport type { Route } from "../router";\nexport const listRoute: Route = { path: "/users" };\n',
  "test/users.test.ts": 'import { findUser } from "../src/db/users";\n',
  "assets/logo.ts": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
};

async function seeded(files: Record<string, string | Uint8Array> = SEED) {
  const host = new MemoryRepoHost();
  const head = await host.seed("repo", files);
  const repo = await host.open("repo");
  const tree = (await repo.readCommit(head))!.tree;
  return { host, repo, tree };
}

describe("indexTree", () => {
  it("reads every file it can, and resolves what each uses to the files of the tree", async () => {
    const { repo, tree } = await seeded();

    const built = await indexTree(repo, tree);

    expect(built.files.map((file) => file.path)).toEqual([
      "src/db/client.ts",
      "src/db/index.ts",
      "src/db/users.ts",
      "src/router.ts",
      "src/routes/list.ts",
      "test/users.test.ts",
    ]);
    expect(built.files.find((file) => file.path === "src/routes/list.ts")?.refs).toEqual([
      { path: "src/db/index.ts", name: "listUsers", via: "import" },
      { path: "src/router.ts", name: "Route", via: "import" },
    ]);
    // README.md is not code dibs reads; assets/logo.ts is named like code and is not text.
    expect(built).toMatchObject({ total: 8, skipped: 0 });
  });

  it("stops at the limit it is given and says how many files it left unread", async () => {
    const { repo, tree } = await seeded();

    const built = await indexTree(repo, tree, { maxFiles: 2 });

    expect(built.files.map((file) => file.path)).toEqual(["src/db/client.ts", "src/db/index.ts"]);
    expect(built.skipped).toBe(4);
  });
});

describe("indexPaths", () => {
  it("reads the paths it is given, and reports as removed those that are not files it can read", async () => {
    const { repo, tree } = await seeded();

    const read = await indexPaths(repo, tree, ["src/db/users.ts", "src/gone.ts", "README.md", "assets/logo.ts"]);

    expect(read.files).toEqual([
      await indexFile("src/db/users.ts", SEED["src/db/users.ts"] as string, (path) => path === "src/db/client.ts"),
    ]);
    expect(read.removed).toEqual(["src/gone.ts", "README.md", "assets/logo.ts"]);
  });
});

describe("interfaceReport", () => {
  // A fork that gives findUser another result, adds a route that uses it, and updates the test.
  async function forked() {
    const { host, repo, tree } = await seeded();
    const head = await host.repo("repo").commit(
      "main",
      {
        "src/db/users.ts": `import { db, type User } from "./client";\n${NEW_FIND} { return { ok: false }; }\nexport function listUsers(): User[] { return [...db.values()]; }\n`,
        "src/routes/get.ts":
          'import { findUser, database } from "../db";\nimport { match, type Route } from "../router";\nexport const getRoute: Route = { path: "/users/:id" };\n',
        "test/users.test.ts": 'import { findUser } from "../src/db/users";\n// updated\n',
        "README.md": "# demo, changed\n",
      },
      "work\n",
    );
    const headTree = (await repo.readCommit(head))!.tree;
    return { repo, baseTree: tree, headTree, changes: await diffTrees(repo, tree, headTree) };
  }

  it("lists the paths the change touches", async () => {
    const { repo, baseTree, headTree, changes } = await forked();

    const report = await interfaceReport(repo, baseTree, headTree, changes, []);

    expect(report.changedPaths).toEqual(["README.md", "src/db/users.ts", "src/routes/get.ts", "test/users.test.ts"]);
  });

  it("lists the interfaces the change adds, removes, or gives another signature", async () => {
    const { repo, baseTree, headTree, changes } = await forked();

    const report = await interfaceReport(repo, baseTree, headTree, changes, []);

    expect(report.changed).toEqual([
      { path: "src/db/users.ts", name: "findUser", kind: "function", change: "changed", before: OLD_FIND, after: NEW_FIND },
      { path: "src/routes/get.ts", name: "getRoute", kind: "const", change: "added", after: "export const getRoute: Route" },
    ]);
  });

  it("lists what the changed files use outside the change, at the place it comes from, with its hash at the base", async () => {
    const { repo, baseTree, headTree, changes } = await forked();

    const report = await interfaceReport(repo, baseTree, headTree, changes, []);

    // findUser comes from src/db/users.ts, which the change itself replaces, so it is not listed.
    expect(report.relied).toEqual([
      { target: "src/db/client.ts#User", hash: await signatureHash("export interface User { id: string }") },
      { target: "src/db/client.ts#db", hash: await signatureHash("export const db") },
      { target: "src/router.ts#Route", hash: await signatureHash("export interface Route { path: string }") },
      { target: "src/router.ts#match", hash: await signatureHash("export function match(): void") },
    ]);
  });

  it("adds what the task's scope says it relies on, each with its hash at the base", async () => {
    const { repo, baseTree, headTree, changes } = await forked();
    const router = await indexFile("src/router.ts", SEED["src/router.ts"] as string, () => false);

    const report = await interfaceReport(repo, baseTree, headTree, changes, [
      "src/db/index.ts#listUsers",
      "src/router.ts",
      "src/nowhere.ts#thing",
      "src/router.ts#nothing",
      "src/db/",
      "route:GET /users",
      "src/db/users.ts#listUsers",
    ]);

    expect(report.relied).toEqual([
      { target: "src/db/client.ts#User", hash: expect.any(String) },
      { target: "src/db/client.ts#db", hash: expect.any(String) },
      { target: "src/nowhere.ts#thing", hash: null },
      { target: "src/router.ts", hash: await fileDigest(router!.interfaces) },
      { target: "src/router.ts#Route", hash: expect.any(String) },
      { target: "src/router.ts#match", hash: expect.any(String) },
      { target: "src/router.ts#nothing", hash: null },
    ]);
  });

  it("reports a deleted file's interfaces as removed", async () => {
    const { host, repo, tree } = await seeded();
    const head = await host.repo("repo").commit("main", { "src/router.ts": null }, "remove\n");
    const headTree = (await repo.readCommit(head))!.tree;

    const report = await interfaceReport(repo, tree, headTree, await diffTrees(repo, tree, headTree), []);

    expect(report.changed.map((change) => [change.name, change.change])).toEqual([
      ["Route", "removed"],
      ["match", "removed"],
    ]);
  });

  it("has nothing to say about files it cannot read", async () => {
    const { host, repo, tree } = await seeded();
    const head = await host.repo("repo").commit("main", { "README.md": "# changed\n", "docs/a.md": "new\n" }, "docs\n");
    const headTree = (await repo.readCommit(head))!.tree;

    const report = await interfaceReport(repo, tree, headTree, await diffTrees(repo, tree, headTree), []);

    expect(report).toEqual({ changedPaths: ["README.md", "docs/a.md"], changed: [], relied: [] });
  });
});
