import { describe, expect, it } from "vitest";
import { reviewStarter } from "../../src/deps";
import type { ReviewParams } from "../../src/pipeline";

// The rules Cloudflare Workflows sets for an instance id.
const WORKFLOW_ID = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;
const MAX_ID_LENGTH = 100;

const NOW = Date.UTC(2035, 0, 1);

async function start(params: ReviewParams, now = NOW): Promise<{ id: string; params: ReviewParams }> {
  const created: { id: string; params: ReviewParams }[] = [];
  const starter = reviewStarter(
    {
      create: async (options) => {
        created.push(options);
      },
    },
    () => now,
  );
  await starter(params);
  expect(created).toHaveLength(1);
  return created[0]!;
}

describe("starting a review", () => {
  it("starts one run that carries the repository and the submission", async () => {
    const run = await start({ repo: "demo-app", submissionId: 7 });

    expect(run.params).toEqual({ repo: "demo-app", submissionId: 7 });
  });

  it("gives a repository with a dot in its name an id that a Workflow accepts", async () => {
    const review = await start({ repo: "next.js", submissionId: 7 });
    const merge = await start({ repo: "next.js", submissionId: 7, mergeOnly: true });

    expect(review.id).toMatch(WORKFLOW_ID);
    expect(merge.id).toMatch(WORKFLOW_ID);
  });

  it("gives repositories whose names differ only in punctuation different ids", async () => {
    const ids = await Promise.all(
      ["my.app", "my_app", "my-app"].map(async (repo) => (await start({ repo, submissionId: 7 })).id),
    );

    expect(new Set(ids).size).toBe(3);
  });

  it("gives a submission the same id whenever its review is started, so it cannot be reviewed twice", async () => {
    const first = await start({ repo: "demo-app", submissionId: 7 }, NOW);
    const second = await start({ repo: "demo-app", submissionId: 7 }, NOW + 60_000);

    expect(second.id).toBe(first.id);
  });

  it("gives each merge-only run its own id, so a merge can be tried again", async () => {
    const first = await start({ repo: "demo-app", submissionId: 7, mergeOnly: true }, NOW);
    const second = await start({ repo: "demo-app", submissionId: 7, mergeOnly: true }, NOW + 60_000);

    expect(second.id).not.toBe(first.id);
  });

  it("keeps the id within the length a Workflow accepts for the longest repository name", async () => {
    const repo = "r".repeat(50);

    const merge = await start({ repo, submissionId: 9_999_999_999, mergeOnly: true });

    expect(merge.id.length).toBeLessThanOrEqual(MAX_ID_LENGTH);
  });
});
