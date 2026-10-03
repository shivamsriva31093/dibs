import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedRepository } from "../../src/seed";
import { git, gitAsync, makeTempDir, removeTempDirs, startGitServer, type GitServer } from "./helpers/git";
import { GitCliRepoHost } from "./helpers/git-host";

let server: GitServer;

beforeAll(async () => {
  server = await startGitServer();
});

afterAll(async () => {
  await server.close();
  removeTempDirs();
});

const FILES = {
  "README.md": "# demo\n",
  "package.json": '{"name":"demo"}\n',
  "src/index.ts": "export {};\n",
  "src/routes/users/index.ts": "export const users = [];\n",
};

describe("seedRepository", () => {
  it("writes the files as the first commit on main of an empty repository", async () => {
    const host = new GitCliRepoHost(server);
    await host.create("seed-ok");

    const result = await seedRepository(host, "seed-ok", FILES, { now: 1760000000 });

    const dir = host.dir("seed-ok");
    expect(git(dir, ["rev-parse", "refs/heads/main"])).toBe(result.commit);
    expect(git(dir, ["fsck", "--strict", "--no-dangling"])).toBe("");
    expect(git(dir, ["show", "-s", "--format=%an|%s|%at", "main"])).toBe("dibs|Initial commit|1760000000");
    const clone = makeTempDir();
    await gitAsync(clone, ["clone", "--quiet", host.remoteOf("seed-ok"), "."]);
    for (const [path, content] of Object.entries(FILES)) {
      expect(readFileSync(join(clone, path), "utf8")).toBe(content);
    }
    expect(git(clone, ["ls-files"]).split("\n").sort()).toEqual(Object.keys(FILES).sort());
  });

  it("leaves a repository that already has commits alone and reports its head", async () => {
    const host = new GitCliRepoHost(server);
    await host.create("seed-twice");
    const first = await seedRepository(host, "seed-twice", FILES, { now: 1760000000 });

    const second = await seedRepository(host, "seed-twice", { "other.txt": "other\n" }, { now: 1760009999 });

    expect(second).toEqual({ commit: first.commit, created: false });
    expect(git(host.dir("seed-twice"), ["rev-list", "--count", "main"])).toBe("1");
  });

  it("refuses paths that are not plain repository-relative files", async () => {
    const host = new GitCliRepoHost(server);
    await host.create("seed-bad");

    await expect(seedRepository(host, "seed-bad", { "../escape.txt": "x" }, { now: 1 })).rejects.toThrow(/escape/);
    await expect(seedRepository(host, "seed-bad", { "dir/": "x" }, { now: 1 })).rejects.toThrow(/dir/);
    await expect(seedRepository(host, "seed-bad", {}, { now: 1 })).rejects.toThrow(/no files/);
  });
});
