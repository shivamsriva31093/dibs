// Builds the real implementations of each interface from the Worker's bindings.
// Everything else in src takes these as arguments, which is what lets tests substitute them.

import Anthropic from "@anthropic-ai/sdk";
import { ArtifactsRepoHost } from "./artifacts-host";
import { WorkersAiDecider, type Decider } from "./decider";
import type { Gate } from "./gate";
import { SandboxGate } from "./gate-runner";
import { PackPushMergeEngine, type MergeEngine } from "./merge";
import type { ReviewParams } from "./pipeline";
import type { RepoHost } from "./repo-host";
import { AnthropicReviewer, type Reviewer } from "./reviewer";

export function repoHost(env: Env): RepoHost {
  return new ArtifactsRepoHost(env.ARTIFACTS);
}

export function decider(env: Env): Decider {
  return new WorkersAiDecider((model, inputs, options) => env.AI.run(model, inputs, options));
}

export function reviewer(env: Env): Reviewer {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return new AnthropicReviewer({ create: (params) => client.beta.messages.create(params) }, env.REVIEW_MODEL);
}

// Null where the Worker has no container to run checks in, such as on this machine.
export function gate(env: Env): Gate | null {
  const namespace = (env as Partial<Pick<Env, "GATE">>).GATE;
  return namespace === undefined ? null : new SandboxGate(namespace);
}

export function mergeEngine(env: Env): MergeEngine {
  return new PackPushMergeEngine(repoHost(env));
}

// The one call a review needs from the Workflow binding.
export interface ReviewWorkflowPort {
  create(options: { id: string; params: ReviewParams }): Promise<unknown>;
}

// A Workflow instance id may hold only letters, digits, "_" and "-", and at most
// 100 characters. A repository name may also hold ".", so the id carries the name
// in a readable form and a short hash of the exact name, which keeps two names
// that read the same apart.
async function repoKey(repo: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(repo)));
  const hash = [...digest.subarray(0, 6)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${repo.replace(/[^A-Za-z0-9_-]/g, "_")}-${hash}`;
}

// Starts the review of a submission as a durable Workflow. A submission is
// reviewed once, so its id makes a second start fail; a merge-only run can
// happen again after a failed attempt, so each one gets its own id.
export function reviewStarter(
  workflow: ReviewWorkflowPort,
  now: () => number = Date.now,
): (params: ReviewParams) => Promise<void> {
  return async (params) => {
    const repo = await repoKey(params.repo);
    const id = params.mergeOnly
      ? `merge-${repo}-${params.submissionId}-${now().toString(36)}`
      : `review-${repo}-${params.submissionId}`;
    await workflow.create({ id, params });
  };
}
