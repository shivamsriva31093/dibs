// The review as a Cloudflare Workflow: each step of the pipeline is durable and
// retried on failure, and a run survives restarts.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { decider, gate, mergeEngine, repoHost, reviewer } from "./deps";
import { runReview, type ReviewParams, type ReviewResult, type StepRunner } from "./pipeline";

const DEFAULT_STEP: WorkflowStepConfig = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
  timeout: "2 minutes",
};

// The reviewer model thinks before it answers and can take minutes.
const REVIEW_STEP: WorkflowStepConfig = {
  retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
  timeout: "10 minutes",
};

// The repository's checks run in a container and may take as long as the repository allows them.
const GATE_STEP: WorkflowStepConfig = {
  retries: { limit: 1, delay: "5 seconds", backoff: "constant" },
  timeout: "16 minutes",
};

function workflowSteps(step: WorkflowStep): StepRunner {
  return {
    do: (name, fn) => step.do(name, name === "review" ? REVIEW_STEP : name.startsWith("gate") ? GATE_STEP : DEFAULT_STEP, fn),
    sleep: (name, ms) => step.sleep(name, ms),
  };
}

export class ReviewWorkflow extends WorkflowEntrypoint<Env, ReviewParams> {
  override async run(event: Readonly<WorkflowEvent<ReviewParams>>, step: WorkflowStep): Promise<ReviewResult> {
    const { repo } = event.payload;
    return runReview(
      {
        coordinator: this.env.COORDINATOR.getByName(repo),
        host: repoHost(this.env),
        decider: decider(this.env),
        reviewer: reviewer(this.env),
        merge: mergeEngine(this.env),
        gate: gate(this.env),
        now: () => Date.now(),
      },
      workflowSteps(step),
      event.payload,
    );
  }
}
