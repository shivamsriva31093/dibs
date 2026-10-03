import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // Runs inside workerd with the Durable Objects only. Artifacts, Workers AI
        // and Workflows have no local simulation, so they are reached through
        // interfaces (RepoHost, Decider, Reviewer, MergeEngine) and faked here.
        plugins: [
          cloudflareTest({
            main: "./src/index.ts",
            miniflare: {
              compatibilityDate: "2026-10-01",
              compatibilityFlags: ["nodejs_compat"],
              bindings: { ADMIN_TOKEN: "test-admin-token", REVIEW_MODEL: "claude-opus-5-5" },
              durableObjects: {
                COORDINATOR: { className: "Coordinator", useSQLite: true },
                REGISTRY: { className: "Registry", useSQLite: true },
              },
            },
          }),
        ],
        test: {
          name: "workers",
          include: ["test/workers/**/*.test.ts"],
          setupFiles: ["./test/workers/helpers/warmup.ts"],
          testTimeout: 15_000,
        },
      },
      {
        // Runs in Node so the git layer can be checked against the real git CLI
        // and a real local git HTTP server. The board's logic is tested here too.
        test: {
          name: "node",
          environment: "node",
          include: ["test/node/**/*.test.ts", "board/src/**/*.test.ts"],
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
    ],
  },
});
