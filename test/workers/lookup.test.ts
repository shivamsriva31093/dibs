import { describe, expect, it } from "vitest";
import { repoLookup, type LookupLimits } from "../../src/lookup";
import { MemoryRepoHost } from "./helpers/memory-host";

const FILES = {
  "README.md": "# demo\n",
  "src/db/client.ts": "export const db = { users: new Map() };\n",
  "src/db/users.ts": 'import { db } from "./client.ts";\n\nexport function findUser(id: string) {\n  return db.users.get(id) ?? null;\n}\n',
  "src/routes/users/get.ts": 'import { findUser } from "../../db/users.ts";\nexport const handler = (id: string) => findUser(id);\n',
  "logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
};

async function lookupAt(files: Record<string, string | Uint8Array> = FILES, limits: Partial<LookupLimits> = {}) {
  const host = new MemoryRepoHost();
  await host.seed("demo", files);
  const repo = await host.open("demo");
  const reads = { trees: 0, blobs: 0 };
  const counting = {
    readTree: (oid: string) => {
      reads.trees++;
      return repo.readTree(oid);
    },
    readBlob: (oid: string) => {
      reads.blobs++;
      return repo.readBlob(oid);
    },
  };
  const head = await repo.head("main");
  return { lookup: repoLookup(counting, head!.tree, limits), reads };
}

describe("readFile", () => {
  it("returns a file with its lines numbered, so that a line can be pointed at", async () => {
    const { lookup } = await lookupAt();

    expect(await lookup.readFile("src/db/users.ts")).toBe(
      ['1\timport { db } from "./client.ts";', "2\t", "3\texport function findUser(id: string) {", "4\t  return db.users.get(id) ?? null;", "5\t}"].join("\n"),
    );
  });

  it.each(["./src/db/client.ts", "/src/db/client.ts", "src/db/client.ts "])("finds %j as a path from the repository root", async (path) => {
    const { lookup } = await lookupAt();

    expect(await lookup.readFile(path)).toBe("1\texport const db = { users: new Map() };");
  });

  it("says so when there is no such file, and what the nearest directory does hold", async () => {
    const { lookup } = await lookupAt();

    expect(await lookup.readFile("src/db/user.ts")).toBe("There is no file src/db/user.ts. src/db/ holds: client.ts, users.ts");
    expect(await lookup.readFile("lib/nothing/here.ts")).toBe("There is no file lib/nothing/here.ts. The repository root holds: README.md, logo.png, src/");
  });

  it("lists a directory when given one", async () => {
    const { lookup } = await lookupAt();

    expect(await lookup.readFile("src/")).toBe("src/ is a directory. It holds: db/, routes/");
    expect(await lookup.readFile("src/routes/users")).toBe("src/routes/users/ is a directory. It holds: get.ts");
  });

  it("does not return a binary file", async () => {
    const { lookup } = await lookupAt();

    expect(await lookup.readFile("logo.png")).toBe("logo.png is a binary file of 8 bytes.");
  });

  it("returns the start of a file that is too long, and says that it was cut", async () => {
    const { lookup } = await lookupAt({ "big.txt": "line\n".repeat(100) }, { maxFileBytes: 12 });

    expect(await lookup.readFile("big.txt")).toBe("1\tline\n2\tline\n3\tli\n(cut: the file has 500 bytes; the first 12 are shown)");
  });
});

describe("search", () => {
  it("finds every line that contains the text, with its file and line number", async () => {
    const { lookup } = await lookupAt();

    expect(await lookup.search("findUser")).toBe(
      [
        "src/db/users.ts:3: export function findUser(id: string) {",
        'src/routes/users/get.ts:1: import { findUser } from "../../db/users.ts";',
        "src/routes/users/get.ts:2: export const handler = (id: string) => findUser(id);",
      ].join("\n"),
    );
  });

  it("says so when nothing contains the text", async () => {
    const { lookup } = await lookupAt();

    expect(await lookup.search("deleteUser")).toBe('No line in the repository contains "deleteUser".');
  });

  it("refuses an empty search", async () => {
    const { lookup } = await lookupAt();

    expect(await lookup.search("  ")).toBe("Give the text to look for.");
  });

  it("stops at a number of matches and says that there are more", async () => {
    const { lookup } = await lookupAt({ "a.txt": "x\nx\nx\nx\n" }, { maxHits: 2 });

    expect(await lookup.search("x")).toBe("a.txt:1: x\na.txt:2: x\n(cut: only the first 2 matches are shown)");
  });

  it("looks in a bounded number of files and says when it did not look in all of them", async () => {
    const { lookup } = await lookupAt({ "a.txt": "nothing\n", "b.txt": "nothing\n", "c.txt": "needle\n" }, { maxFilesSearched: 2 });

    expect(await lookup.search("needle")).toBe(
      'No line in the first 2 files contains "needle". The repository has 3 files; the rest were not searched.',
    );
  });

  it("does not look inside binary files", async () => {
    const { lookup } = await lookupAt({ "logo.png": new Uint8Array([0x50, 0x4e, 0x47, 0, 0x50, 0x4e, 0x47]), "a.txt": "PNG\n" });

    expect(await lookup.search("PNG")).toBe("a.txt:1: PNG");
  });
});

describe("reading the repository", () => {
  it("reads each directory and each file once, however many lookups are made", async () => {
    const { lookup, reads } = await lookupAt();

    await lookup.search("findUser");
    await lookup.search("db");
    await lookup.readFile("src/db/users.ts");

    // Directories: the root, src, src/db, src/routes, src/routes/users. Files: five.
    expect(reads).toEqual({ trees: 5, blobs: 5 });
  });

  it("reads only the directories on the way to a file when nothing is searched", async () => {
    const { lookup, reads } = await lookupAt();

    await lookup.readFile("src/db/users.ts");

    expect(reads).toEqual({ trees: 3, blobs: 1 });
  });
});
