// The Worker exactly as it is deployed, except that the two bindings with no
// local version, Artifacts and Workers AI, are replaced by stand-ins that talk to
// platform.ts. Everything in src/ runs unchanged.

import worker, { Coordinator, Registry, ReviewWorkflow as DeployedReviewWorkflow } from "../../src/index";
import { localAi, localArtifacts } from "./bindings";

type LocalEnv = Env & { PLATFORM_URL: string };

function withStandIns(env: LocalEnv): Env {
  return { ...env, ARTIFACTS: localArtifacts(env.PLATFORM_URL), AI: localAi(env.PLATFORM_URL) as Ai };
}

export { Coordinator, Registry };

export class ReviewWorkflow extends DeployedReviewWorkflow {
  constructor(ctx: ExecutionContext, env: LocalEnv) {
    super(ctx, withStandIns(env));
  }
}

export default {
  fetch: (request, env, ctx) => worker.fetch(request, withStandIns(env), ctx),
} satisfies ExportedHandler<LocalEnv>;
