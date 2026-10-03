import { env } from "cloudflare:workers";
import { vi } from "vitest";
import type { Coordinator } from "../../../src/coordinator";
import type { RepoConfig } from "../../../src/types";

// Far enough ahead of the real clock that an alarm set from fake time never fires by itself.
export const T0 = Date.UTC(2035, 0, 1, 12, 0, 0);
export const MINUTE = 60_000;

export function freezeTime(at: number = T0): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
}

export function advanceTime(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

export type CoordinatorStub = DurableObjectStub<Coordinator>;

// A fresh, registered Coordinator. Storage is shared within a test file, so every test gets its own name.
export async function newCoordinator(config: Partial<RepoConfig> = {}): Promise<CoordinatorStub> {
  const stub = env.COORDINATOR.getByName(`test-${crypto.randomUUID()}`);
  await stub.init({ repoName: "demo-app", ...config });
  return stub;
}

export async function newAgent(coordinator: CoordinatorStub, name: string): Promise<string> {
  const created = await coordinator.createAgent(name);
  if (!created.ok) {
    throw new Error(`could not create agent ${name}: ${created.error.message}`);
  }
  return created.agent.id;
}
