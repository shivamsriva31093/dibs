import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { updateRef } from "../../scripts/lib";
import { createServedRepo, git, initRepo, removeTempDirs, startGitServer, type GitServer } from "./helpers/git";

// The end-to-end script uses updateRef to ask a deployed git server whether it
// refuses a push built on a commit the branch has moved past. Here the same
// question is put to the real git, whose answer is known.

let server: GitServer;

beforeAll(async () => {
  server = await startGitServer();
});

afterAll(async () => {
  await server.close();
  removeTempDirs();
});

// A served repository whose main is at `second`, the child of `first`, and that
// also holds `third`, a child of `second`, under another branch.
function servedHistory(name: string) {
  const { dir, remote } = createServedRepo(server, name);
  const work = initRepo();
  const commit = (content: string) => {
    writeFileSync(join(work, "file.txt"), content);
    git(work, ["add", "-A"]);
    git(work, ["commit", "--quiet", "-m", content]);
    return git(work, ["rev-parse", "HEAD"]);
  };
  const first = commit("first");
  const second = commit("second");
  const third = commit("third");
  git(work, ["push", "--quiet", dir, `${second}:refs/heads/main`, `${third}:refs/heads/next`]);
  return { dir, remote, first, second, third };
}

describe("updateRef", () => {
  it("is refused, and changes nothing, when it names a commit the branch has moved past", async () => {
    const { dir, remote, first, second, third } = servedHistory("stale");

    const result = await updateRef(remote, undefined, "refs/heads/main", first, third);

    expect(result.accepted).toBe(false);
    expect(git(dir, ["rev-parse", "refs/heads/main"])).toBe(second);
  });

  it("moves the branch when it names the commit the branch is at", async () => {
    const { dir, remote, second, third } = servedHistory("fresh");

    const result = await updateRef(remote, undefined, "refs/heads/main", second, third);

    expect(result).toEqual({ accepted: true, report: expect.stringContaining("ok refs/heads/main") });
    expect(git(dir, ["rev-parse", "refs/heads/main"])).toBe(third);
  });
});
