// A repository history, built with the real git, that exercises every kind of
// change the merge has to handle. `base` is where a task forked, `head` is the
// task's work, and `main` is where other tasks have moved the branch meanwhile.
// The two sets of changes touch different paths, as exclusive claims guarantee.

import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TreeEntry } from "../../../src/git/objects";
import type { TreeReader } from "../../../src/git/changes";
import { git, initRepo, lsTree } from "./git";

export type FileSpec = string | { content: string; executable: true } | { symlink: string } | null;

// Writes, replaces or (for null) removes each path.
export function applyFiles(dir: string, files: Record<string, FileSpec>): void {
  for (const [path, spec] of Object.entries(files)) {
    const full = join(dir, path);
    rmSync(full, { recursive: true, force: true });
    if (spec === null) {
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    if (typeof spec === "string") {
      writeFileSync(full, spec);
    } else if ("symlink" in spec) {
      symlinkSync(spec.symlink, full);
    } else {
      writeFileSync(full, spec.content);
      chmodSync(full, 0o755);
    }
  }
}

export function commitAll(dir: string, message: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "--allow-empty", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

export function treeOf(dir: string, commit: string): string {
  return git(dir, ["rev-parse", `${commit}^{tree}`]);
}

// Reads trees straight from a real repository.
export function gitTreeReader(dir: string): TreeReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async readTree(oid: string): Promise<TreeEntry[] | null> {
      reads.push(oid);
      try {
        if (git(dir, ["cat-file", "-t", oid]) !== "tree") {
          return null;
        }
      } catch {
        return null;
      }
      return lsTree(dir, oid).map(({ name, mode, oid: entryOid }) => ({ name, mode, oid: entryOid }));
    },
  };
}

export const BASE_FILES: Record<string, FileSpec> = {
  "README.md": "# app\n",
  "package.json": "{}\n",
  "src/index.ts": "export {};\n",
  "src/routes/users.ts": "users v1\n",
  "src/routes/posts.ts": "posts v1\n",
  "src/db/client.ts": "db v1\n",
  "src/util/date.ts": "date v1\n",
  "src/old/legacy.ts": "legacy\n",
  "scripts/run.sh": "#!/bin/sh\n",
  config: "plain file\n",
  "docs/guide/intro.md": "intro\n",
  link: "target\n",
};

// The task's work.
export const HEAD_CHANGES: Record<string, FileSpec> = {
  "src/routes/users.ts": "users v2\n",
  "src/routes/health.ts": "health\n",
  "src/new/deep/nested/file.ts": "deep\n",
  "src/old/legacy.ts": null,
  "scripts/run.sh": { content: "#!/bin/sh\n", executable: true },
  config: null,
  "config/app.json": '{"a":1}\n',
  "docs/guide": "now a file\n",
  link: { symlink: "README.md" },
};

// What other tasks merged into main after the fork was taken.
export const MAIN_CHANGES: Record<string, FileSpec> = {
  "src/routes/posts.ts": "posts v2\n",
  "src/db/migrate.ts": "migrate\n",
  "README.md": "# app, updated\n",
  "zeta.txt": "zeta\n",
  "src/util/date.ts": null,
};

export interface Scenario {
  dir: string;
  base: string;
  head: string;
  main: string;
}

export function buildScenario(): Scenario {
  const dir = initRepo();
  applyFiles(dir, BASE_FILES);
  const base = commitAll(dir, "base");

  git(dir, ["checkout", "--quiet", "-b", "task"]);
  applyFiles(dir, HEAD_CHANGES);
  const head = commitAll(dir, "task work");

  git(dir, ["checkout", "--quiet", "main"]);
  applyFiles(dir, MAIN_CHANGES);
  const main = commitAll(dir, "other tasks");

  return { dir, base, head, main };
}
