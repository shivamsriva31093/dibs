import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";

// The first call into a Durable Object in each test file loads the whole Worker,
// which takes a few seconds on a busy machine. Paying that here keeps it from
// counting against whichever test happens to run first.
beforeAll(async () => {
  await env.REGISTRY.getByName("warm-up").list();
}, 60_000);
