import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceTime, freezeTime, MINUTE, newAgent, newCoordinator, T0 } from "./helpers/coordinator";

beforeEach(() => freezeTime());
afterEach(() => vi.useRealTimers());

describe("registration", () => {
  it("fills in defaults for everything but the repository name", async () => {
    const coordinator = await newCoordinator();

    expect(await coordinator.getConfig()).toEqual({
      repoName: "demo-app",
      defaultBranch: "main",
      protectedPaths: [
        ".dibs/",
        ".github/",
        "wrangler.jsonc",
        "wrangler.toml",
        "package.json",
        "package-lock.json",
        "pnpm-lock.yaml",
        ".env",
        "migrations/",
      ],
      claimTtlMinutes: 120,
      maxCycles: 3,
      decider: {
        enabled: true,
        relatedMinConfidence: 0.5,
        riskHighMin: 0.3,
        interfaceChangeMin: 0.6,
      },
    });
  });

  it("keeps the values it is given", async () => {
    const coordinator = await newCoordinator({ protectedPaths: ["infra/"], maxCycles: 5, claimTtlMinutes: 30 });

    expect(await coordinator.getConfig()).toMatchObject({ protectedPaths: ["infra/"], maxCycles: 5, claimTtlMinutes: 30 });
  });

  it("fills in a threshold that a repository registered by an earlier version does not have", async () => {
    const coordinator = await newCoordinator();
    await runInDurableObject(coordinator, (_instance, state) => {
      const stored = JSON.parse(
        state.storage.sql.exec<{ value: string }>("SELECT value FROM config WHERE key = 'repo'").one().value,
      );
      stored.decider = { enabled: false, relatedMinConfidence: 0.8 };
      state.storage.sql.exec("UPDATE config SET value = ? WHERE key = 'repo'", JSON.stringify(stored));
    });

    expect((await coordinator.getConfig())?.decider).toEqual({
      enabled: false,
      relatedMinConfidence: 0.8,
      riskHighMin: 0.3,
      interfaceChangeMin: 0.6,
    });
  });

  it("refuses work for a repository that was never registered", async () => {
    const unregistered = env.COORDINATOR.getByName(`test-${crypto.randomUUID()}`);

    expect(await unregistered.getConfig()).toBeNull();
    expect(await unregistered.startTask({ agentId: "a-x", goal: "g", paths: ["a.ts"] })).toMatchObject({
      ok: false,
      error: { code: "not_registered" },
    });
  });
});

describe("agents", () => {
  it("issues a key once and recognises it afterwards", async () => {
    const coordinator = await newCoordinator();

    const created = await coordinator.createAgent("claude-auth");

    if (!created.ok) {
      throw new Error("expected the agent to be created");
    }
    expect(created.agent.name).toBe("claude-auth");
    expect(created.agent.id).toMatch(/^a-[a-z0-9]{8}$/);
    expect(created.key).toMatch(/^dibs_[A-Za-z0-9_-]{40,}$/);
    expect(await coordinator.authenticate(created.key)).toEqual(created.agent);
  });

  it("rejects a key it did not issue", async () => {
    const coordinator = await newCoordinator();
    await coordinator.createAgent("claude-auth");

    expect(await coordinator.authenticate("dibs_not-a-real-key")).toBeNull();
  });

  it("does not store the key itself", async () => {
    const coordinator = await newCoordinator();
    const created = await coordinator.createAgent("claude-auth");
    if (!created.ok) {
      throw new Error("expected the agent to be created");
    }

    const stored = await runInDurableObject(coordinator, (_instance, state) =>
      JSON.stringify(state.storage.sql.exec("SELECT * FROM agents").toArray()),
    );

    expect(stored).not.toContain(created.key);
  });

  it("refuses a second agent with the same name", async () => {
    const coordinator = await newCoordinator();
    await coordinator.createAgent("claude-auth");

    expect(await coordinator.createAgent("claude-auth")).toMatchObject({
      ok: false,
      error: { code: "already_exists" },
    });
  });

  it.each(["", "has space", "a".repeat(65), "semi;colon"])("refuses the name %j", async (name) => {
    const coordinator = await newCoordinator();

    expect(await coordinator.createAgent(name)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

describe("startTask", () => {
  it("grants a free claim and describes the new task", async () => {
    const coordinator = await newCoordinator();
    const agentId = await newAgent(coordinator, "agent-one");

    const granted = await coordinator.startTask({
      agentId,
      goal: "Add a users endpoint",
      paths: ["src/routes/users/", "test/users.test.ts"],
    });

    if (!granted.ok) {
      throw new Error("expected the claim to be granted");
    }
    expect(granted.task.id).toMatch(/^t-[a-z0-9]{8}$/);
    expect(granted.task).toEqual({
      id: granted.task.id,
      forkName: `demo-app--${granted.task.id}`,
      paths: ["src/routes/users/", "test/users.test.ts"],
      scope: [{ target: "src/routes/users/", relation: "change", origin: "declared" }, { target: "test/users.test.ts", relation: "change", origin: "declared" }],
      claimExpiresAt: T0 + 120 * MINUTE,
    });
    expect(granted.others).toEqual([]);
  });

  it("refuses a claim that overlaps a live task and says who holds it", async () => {
    const coordinator = await newCoordinator();
    const one = await newAgent(coordinator, "agent-one");
    const two = await newAgent(coordinator, "agent-two");
    const first = await coordinator.startTask({
      agentId: one,
      goal: "Add a users endpoint",
      paths: ["src/routes/users/", "src/db/users.ts"],
    });
    if (!first.ok) {
      throw new Error("expected the first claim to be granted");
    }
    advanceTime(5 * MINUTE);

    const refused = await coordinator.startTask({
      agentId: two,
      goal: "Add rate limiting",
      paths: ["src/middleware/", "src/routes/users/index.ts"],
    });

    expect(refused).toEqual({
      ok: false,
      error: {
        code: "conflict",
        message: "1 path is held by another task",
        retryable: true,
      },
      conflicts: [
        {
          taskId: first.task.id,
          agent: "agent-one",
          goal: "Add a users endpoint",
          state: "active",
          paths: ["src/routes/users/"],
          held: [{ target: "src/routes/users/", relation: "change" }],
          startedAt: T0,
          claimExpiresAt: T0 + 120 * MINUTE,
        },
      ],
    });
  });

  it("holds nothing for a refused request", async () => {
    const coordinator = await newCoordinator();
    const one = await newAgent(coordinator, "agent-one");
    const two = await newAgent(coordinator, "agent-two");
    const three = await newAgent(coordinator, "agent-three");
    await coordinator.startTask({ agentId: one, goal: "g1", paths: ["src/a/"] });
    // Refused because of src/a/; its other path, src/b/, must stay free.
    await coordinator.startTask({ agentId: two, goal: "g2", paths: ["src/a/x.ts", "src/b/"] });

    const granted = await coordinator.startTask({ agentId: three, goal: "g3", paths: ["src/b/"] });

    expect(granted.ok).toBe(true);
  });

  it("grants exactly one of two overlapping requests made at the same moment", async () => {
    const coordinator = await newCoordinator();
    const one = await newAgent(coordinator, "agent-one");
    const two = await newAgent(coordinator, "agent-two");

    const results = await Promise.all([
      coordinator.startTask({ agentId: one, goal: "g1", paths: ["src/shared.ts"] }),
      coordinator.startTask({ agentId: two, goal: "g2", paths: ["src/shared.ts"] }),
    ]);

    expect(results.map((result) => result.ok).sort()).toEqual([false, true]);
  });

  it("lets disjoint claims proceed and tells each new task about the others", async () => {
    const coordinator = await newCoordinator();
    const one = await newAgent(coordinator, "agent-one");
    const two = await newAgent(coordinator, "agent-two");
    const first = await coordinator.startTask({ agentId: one, goal: "Add users", paths: ["src/routes/users/"] });
    if (!first.ok) {
      throw new Error("expected the first claim to be granted");
    }
    advanceTime(MINUTE);

    const second = await coordinator.startTask({ agentId: two, goal: "Add limits", paths: ["src/middleware/"] });

    expect(second).toMatchObject({
      ok: true,
      others: [
        {
          taskId: first.task.id,
          agent: "agent-one",
          goal: "Add users",
          state: "active",
          paths: ["src/routes/users/"],
          startedAt: T0,
        },
      ],
    });
  });

  it("normalises paths and drops ones already covered by a directory in the same request", async () => {
    const coordinator = await newCoordinator();
    const agentId = await newAgent(coordinator, "agent-one");

    const granted = await coordinator.startTask({
      agentId,
      goal: "g",
      paths: [" src//api/ ", "src/api/users.ts", "README.md", "README.md"],
    });

    expect(granted).toMatchObject({ ok: true, task: { paths: ["README.md", "src/api/"] } });
  });

  it("refuses an invalid path and names it", async () => {
    const coordinator = await newCoordinator();
    const agentId = await newAgent(coordinator, "agent-one");

    const refused = await coordinator.startTask({ agentId, goal: "g", paths: ["src/ok.ts", "../outside"] });

    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_path", retryable: false } });
    expect(!refused.ok && refused.error.message).toContain("../outside");
  });

  it.each([
    ["no paths", { goal: "g", paths: [] as string[] }],
    ["an empty goal", { goal: "   ", paths: ["a.ts"] }],
    ["more than 100 paths", { goal: "g", paths: Array.from({ length: 101 }, (_, index) => `f${index}.ts`) }],
  ])("refuses a request with %s", async (_label, request) => {
    const coordinator = await newCoordinator();
    const agentId = await newAgent(coordinator, "agent-one");

    expect(await coordinator.startTask({ agentId, ...request })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("refuses an agent it does not know", async () => {
    const coordinator = await newCoordinator();

    expect(await coordinator.startTask({ agentId: "a-unknown0", goal: "g", paths: ["a.ts"] })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("uses the requested lifetime, capped at eight hours", async () => {
    const coordinator = await newCoordinator();
    const agentId = await newAgent(coordinator, "agent-one");

    const short = await coordinator.startTask({ agentId, goal: "g", paths: ["a.ts"], ttlMinutes: 15 });
    const long = await coordinator.startTask({ agentId, goal: "g", paths: ["b.ts"], ttlMinutes: 9999 });

    expect(short).toMatchObject({ ok: true, task: { claimExpiresAt: T0 + 15 * MINUTE } });
    expect(long).toMatchObject({ ok: true, task: { claimExpiresAt: T0 + 480 * MINUTE } });
  });
});

describe("claim expiry", () => {
  it("frees the paths once the lifetime has passed", async () => {
    const coordinator = await newCoordinator();
    const one = await newAgent(coordinator, "agent-one");
    const two = await newAgent(coordinator, "agent-two");
    await coordinator.startTask({ agentId: one, goal: "g1", paths: ["src/a.ts"], ttlMinutes: 30 });

    advanceTime(29 * MINUTE);
    const tooEarly = await coordinator.startTask({ agentId: two, goal: "g2", paths: ["src/a.ts"] });
    advanceTime(1 * MINUTE);
    const afterExpiry = await coordinator.startTask({ agentId: two, goal: "g2", paths: ["src/a.ts"] });

    expect(tooEarly.ok).toBe(false);
    expect(afterExpiry.ok).toBe(true);
  });

  it("marks the task expired when the alarm runs, without any other call", async () => {
    const coordinator = await newCoordinator();
    const one = await newAgent(coordinator, "agent-one");
    const started = await coordinator.startTask({ agentId: one, goal: "g1", paths: ["src/a.ts"], ttlMinutes: 30 });
    if (!started.ok) {
      throw new Error("expected the claim to be granted");
    }
    advanceTime(31 * MINUTE);

    expect(await runDurableObjectAlarm(coordinator)).toBe(true);

    const events = await coordinator.listEvents();
    expect(events.map((event) => event.type)).toEqual(["task_started", "expired"]);
    expect(events[1]).toMatchObject({ taskId: started.task.id, createdAt: T0 + 31 * MINUTE });
  });

  it("stops scheduling alarms once no task is waiting to expire", async () => {
    const coordinator = await newCoordinator();
    const one = await newAgent(coordinator, "agent-one");
    await coordinator.startTask({ agentId: one, goal: "g1", paths: ["src/a.ts"], ttlMinutes: 30 });
    advanceTime(31 * MINUTE);
    await runDurableObjectAlarm(coordinator);

    expect(await runDurableObjectAlarm(coordinator)).toBe(false);
  });
});

describe("events", () => {
  it("records a started task and a refused claim, in order", async () => {
    const coordinator = await newCoordinator();
    const one = await newAgent(coordinator, "agent-one");
    const two = await newAgent(coordinator, "agent-two");
    const first = await coordinator.startTask({ agentId: one, goal: "Add users", paths: ["src/users/"] });
    if (!first.ok) {
      throw new Error("expected the claim to be granted");
    }
    advanceTime(MINUTE);

    await coordinator.startTask({ agentId: two, goal: "Add limits", paths: ["src/users/limits.ts"] });

    expect(await coordinator.listEvents()).toEqual([
      {
        id: 1,
        type: "task_started",
        taskId: first.task.id,
        agentId: one,
        body: {
          agent: "agent-one",
          goal: "Add users",
          paths: ["src/users/"],
          scope: [{ target: "src/users/", relation: "change", origin: "declared" }],
          claimExpiresAt: T0 + 120 * MINUTE,
        },
        createdAt: T0,
      },
      {
        id: 2,
        type: "claim_conflict",
        taskId: null,
        agentId: two,
        body: {
          agent: "agent-two",
          goal: "Add limits",
          paths: ["src/users/limits.ts"],
          blockedBy: [{ taskId: first.task.id, agent: "agent-one", paths: ["src/users/"] }],
        },
        createdAt: T0 + MINUTE,
      },
    ]);
  });
});
