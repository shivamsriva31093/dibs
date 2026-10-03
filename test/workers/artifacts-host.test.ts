import { describe, expect, it } from "vitest";
import { ArtifactsRepoHost } from "../../src/artifacts-host";
import { RepoHostError } from "../../src/repo-host";

// The errors the Artifacts binding throws: an Error with a string `code`.
function artifactsError(code: ArtifactsErrorCode, message = code): Error {
  return Object.assign(new Error(message), { name: "ArtifactsError", code, numericCode: 10000 });
}

const COMMIT: ArtifactsCommitMetadata = {
  hash: "c".repeat(40),
  treeHash: "d".repeat(40),
  message: "Add users\n\nDibs-Task: t-1",
  author: { name: "agent-one", email: "agent-one@agents.dibs.invalid" },
  committer: { name: "dibs", email: "dibs@dibs.invalid" },
  parents: ["b".repeat(40)],
  authoredAt: 1760000000,
  committedAt: 1760000100,
};

interface Calls {
  disposed: number;
  log: unknown[];
  fork: unknown[];
  createToken: unknown[];
  readFile: unknown[];
  create: unknown[];
  import: unknown[];
}

// Stands in for the Artifacts binding, returning what its type declarations describe.
function fakeArtifacts(overrides: Partial<ArtifactsRepo> = {}, getError?: Error): { binding: Artifacts; calls: Calls } {
  const calls: Calls = { disposed: 0, log: [], fork: [], createToken: [], readFile: [], create: [], import: [] };
  const created: ArtifactsCreateRepoResult = {
    id: "repo_1",
    name: "demo-app",
    description: null,
    defaultBranch: "main",
    remote: "https://acct.artifacts.cloudflare.net/git/dibs/demo-app.git",
    token: "art_v1_aaaa?expires=1760003600",
  };
  const repo: ArtifactsRepo = {
    info: async () => ({
      id: "repo_1",
      name: "demo-app",
      description: null,
      defaultBranch: "trunk",
      createdAt: "2026-10-02T00:00:00Z",
      updatedAt: "2026-10-02T00:00:00Z",
      lastPushAt: null,
      source: null,
      readOnly: false,
      remote: "https://acct.artifacts.cloudflare.net/git/dibs/demo-app.git",
    }),
    createToken: async (scope, ttl) => {
      calls.createToken.push([scope, ttl]);
      return { id: "tok_1", plaintext: "art_v1_bbbb?expires=1760003600", scope: scope ?? "write", expiresAt: "2026-10-02T01:00:00Z" };
    },
    listTokens: async () => ({ tokens: [], total: 0 }),
    revokeToken: async () => true,
    readBlob: async () => new Blob([new Uint8Array([104, 105, 10])]),
    readTree: async () => [
      { name: "src", mode: "40000", hash: "1".repeat(40), type: "tree" },
      { name: "run.sh", mode: "100755", hash: "2".repeat(40), type: "exec" },
    ],
    readCommit: async () => COMMIT,
    readFile: async (args) => {
      calls.readFile.push(args);
      return new Blob(["Use named exports only.\n"], { type: "text/plain;charset=utf-8" });
    },
    log: async (options) => {
      calls.log.push(options);
      return [COMMIT];
    },
    fork: async (name, options) => {
      calls.fork.push([name, options]);
      return { ...created, name };
    },
    [Symbol.dispose]: () => {
      calls.disposed++;
    },
    ...overrides,
  };
  const binding: Artifacts = {
    get: async () => {
      if (getError) {
        throw getError;
      }
      return repo;
    },
    create: async (name, options) => {
      calls.create.push([name, options]);
      return { ...created, name };
    },
    import: async (params) => {
      calls.import.push(params);
      return { ...created, name: params.target.name };
    },
    list: async () => ({ repos: [], total: 0 }),
    delete: async () => true,
  };
  return { binding, calls };
}

describe("ArtifactsRepoHost.open", () => {
  it.each([
    ["NOT_FOUND", "not_found"],
    ["FORK_IN_PROGRESS", "not_ready"],
    ["IMPORT_IN_PROGRESS", "not_ready"],
    ["CREATE_IN_PROGRESS", "not_ready"],
    ["INTERNAL_ERROR", "internal"],
  ] as const)("turns the binding's %s into a %s error", async (code, want) => {
    const { binding } = fakeArtifacts({}, artifactsError(code));

    const error = await new ArtifactsRepoHost(binding).open("demo-app").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RepoHostError);
    expect((error as RepoHostError).code).toBe(want);
  });

  it("releases the binding's repository handle when the handle is disposed", async () => {
    const { binding, calls } = fakeArtifacts();

    {
      using handle = await new ArtifactsRepoHost(binding).open("demo-app");
      expect(handle.name).toBe("demo-app");
    }

    expect(calls.disposed).toBe(1);
  });
});

describe("a repository handle", () => {
  async function handle(overrides: Partial<ArtifactsRepo> = {}) {
    const fake = fakeArtifacts(overrides);
    return { ...fake, repo: await new ArtifactsRepoHost(fake.binding).open("demo-app") };
  }

  it("reports the remote and default branch from the repository's metadata", async () => {
    const { repo } = await handle();

    expect(await repo.remote()).toBe("https://acct.artifacts.cloudflare.net/git/dibs/demo-app.git");
    expect(await repo.defaultBranch()).toBe("trunk");
  });

  it("returns the token string git needs", async () => {
    const { repo, calls } = await handle();

    expect(await repo.createToken("write", 300)).toBe("art_v1_bbbb?expires=1760003600");
    expect(calls.createToken).toEqual([["write", 300]]);
  });

  it("reads a branch head as the newest commit on that branch", async () => {
    const { repo, calls } = await handle();

    expect(await repo.head("main")).toEqual({
      oid: "c".repeat(40),
      tree: "d".repeat(40),
      parents: ["b".repeat(40)],
      message: "Add users\n\nDibs-Task: t-1",
      author: { name: "agent-one", email: "agent-one@agents.dibs.invalid" },
      committer: { name: "dibs", email: "dibs@dibs.invalid" },
      authoredAt: 1760000000,
      committedAt: 1760000100,
    });
    expect(calls.log).toEqual([{ ref: "main", limit: 1 }]);
  });

  it("has no head for a branch that does not exist", async () => {
    const { repo } = await handle({ log: async () => [] });

    expect(await repo.head("missing")).toBeNull();
  });

  it("maps tree entries, keeping each entry's mode", async () => {
    const { repo } = await handle();

    expect(await repo.readTree("d".repeat(40))).toEqual([
      { name: "src", mode: "40000", oid: "1".repeat(40) },
      { name: "run.sh", mode: "100755", oid: "2".repeat(40) },
    ]);
  });

  it("returns blob and file contents as bytes, and null when there is none", async () => {
    const { repo, calls } = await handle();
    const missing = await handle({ readBlob: async () => null, readFile: async () => null, readTree: async () => null });

    expect(await repo.readBlob("2".repeat(40))).toEqual(new Uint8Array([104, 105, 10]));
    expect(new TextDecoder().decode((await repo.readFile("main", "AGENTS.md"))!)).toBe("Use named exports only.\n");
    expect(calls.readFile).toEqual([{ ref: "main", path: "AGENTS.md" }]);
    expect(await missing.repo.readBlob("2".repeat(40))).toBeNull();
    expect(await missing.repo.readFile("main", "AGENTS.md")).toBeNull();
    expect(await missing.repo.readTree("d".repeat(40))).toBeNull();
  });

  it("reports a file too large to buffer as too_large", async () => {
    const { repo } = await handle({
      readBlob: async () => {
        throw artifactsError("MEMORY_LIMIT");
      },
    });

    await expect(repo.readBlob("2".repeat(40))).rejects.toMatchObject({ name: "RepoHostError", code: "too_large" });
  });

  it("forks only the default branch", async () => {
    const { repo, calls } = await handle();

    await repo.fork("demo-app--t-1");

    expect(calls.fork).toEqual([["demo-app--t-1", { defaultBranchOnly: true }]]);
  });

  it("reports a fork name that is already taken", async () => {
    const { repo } = await handle({
      fork: async () => {
        throw artifactsError("ALREADY_EXISTS");
      },
    });

    await expect(repo.fork("demo-app--t-1")).rejects.toMatchObject({ code: "already_exists" });
  });
});

describe("creating repositories", () => {
  it("creates an empty repository with main as its default branch", async () => {
    const { binding, calls } = fakeArtifacts();

    const created = await new ArtifactsRepoHost(binding).create("demo-app", { description: "The demo" });

    expect(created).toEqual({
      name: "demo-app",
      remote: "https://acct.artifacts.cloudflare.net/git/dibs/demo-app.git",
      defaultBranch: "main",
      token: "art_v1_aaaa?expires=1760003600",
    });
    expect(calls.create).toEqual([["demo-app", { description: "The demo", setDefaultBranch: "main" }]]);
  });

  it("imports from another git remote", async () => {
    const { binding, calls } = fakeArtifacts();

    const created = await new ArtifactsRepoHost(binding).importFrom("demo-app", {
      url: "https://github.com/example/demo-app",
      branch: "main",
    });

    expect(created.name).toBe("demo-app");
    expect(calls.import).toEqual([
      { source: { url: "https://github.com/example/demo-app", branch: "main" }, target: { name: "demo-app" } },
    ]);
  });
});
