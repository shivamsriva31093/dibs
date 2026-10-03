import { describe, expect, it } from "vitest";
import { fileDigest, indexFile } from "../../src/index/file";
import { signatureHash } from "../../src/index/signature";

const repo = (...files: string[]) => {
  const set = new Set(files);
  return (path: string) => set.has(path);
};

describe("indexFile", () => {
  it("records each interface with the hash of its signature", async () => {
    const file = await indexFile("src/db/users.ts", "export function findUser(id: string): User | null { return null; }", repo());

    expect(file).toEqual({
      path: "src/db/users.ts",
      digest: await fileDigest(file!.interfaces),
      interfaces: [
        {
          name: "findUser",
          kind: "function",
          signature: "export function findUser(id: string): User | null",
          hash: await signatureHash("export function findUser(id: string): User | null"),
          origin: null,
        },
      ],
      refs: [],
    });
  });

  it("records what the file uses of other files, by the paths of those files", async () => {
    const text = 'import { findUser, listUsers } from "../../db/users.ts";\nimport type { Route } from "../../router";\nimport { z } from "zod";';

    const file = await indexFile("src/routes/users/get.ts", text, repo("src/db/users.ts", "src/router.ts"));

    expect(file?.refs).toEqual([
      { path: "src/db/users.ts", name: "findUser", via: "import" },
      { path: "src/db/users.ts", name: "listUsers", via: "import" },
      { path: "src/router.ts", name: "Route", via: "import" },
    ]);
  });

  it("leaves out an import of a file that is not in the repository", async () => {
    const file = await indexFile("src/a.ts", 'import { gone } from "./gone";', repo());

    expect(file?.refs).toEqual([]);
  });

  it("records where a name that is passed on comes from", async () => {
    const file = await indexFile("src/index.ts", 'export { findUser as find } from "./db/users";\nexport * from "./router";', repo("src/db/users.ts", "src/router.ts"));

    expect(file?.interfaces).toMatchObject([{ name: "find", kind: "reexport", origin: { path: "src/db/users.ts", name: "findUser" } }]);
    expect(file?.refs).toEqual([
      { path: "src/db/users.ts", name: "findUser", via: "reexport" },
      { path: "src/router.ts", name: "*", via: "reexport" },
    ]);
  });

  it("has no origin for a name passed on from a file that is not in the repository", async () => {
    const file = await indexFile("src/index.ts", 'export { a } from "./gone";', repo());

    expect(file?.interfaces).toMatchObject([{ name: "a", kind: "reexport", origin: null }]);
  });

  it("answers null for a file it cannot read", async () => {
    expect(await indexFile("README.md", "# hello", repo())).toBeNull();
  });
});

describe("fileDigest", () => {
  it("is the same for the same interfaces in any order, and differs when one signature differs", async () => {
    const a = await indexFile("a.ts", "export const x = 1;\nexport function f(): void {}", repo());
    const b = await indexFile("a.ts", "export function f(): void { return; }\nexport const x = 2;", repo());
    const c = await indexFile("a.ts", "export function f(): number { return 1; }\nexport const x = 2;", repo());

    expect(await fileDigest(a!.interfaces)).toBe(await fileDigest(b!.interfaces));
    expect(await fileDigest(a!.interfaces)).not.toBe(await fileDigest(c!.interfaces));
  });

  it("is the digest of nothing for a file with no interfaces", async () => {
    expect(await fileDigest([])).toBe(await signatureHash(""));
  });
});
