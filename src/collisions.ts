// A collision is two tasks whose work meets: one changes an interface the other
// relies on, or both are doing the same work. Nothing here decides anything.
// It says, in words an agent can act on, which of the two is expected to land
// first and what each should do. What keeps the main branch whole is the check
// made when a change lands (Coordinator.contractsOf).

import type { TaskState } from "./types";

export type CollisionKind = "contract" | "duplicate";
// "possible": one task holds code the other uses, and has not said it will change it.
// "open": the change is declared, found in a submission, or has landed.
export type CollisionState = "possible" | "open" | "resolved";
// In a contract collision the provider changes the interface and the relier uses it.
// In a duplicate, the provider is the task that started first.
export type CollisionRole = "provider" | "relier";

export interface Party {
  taskId: string;
  agent: string;
  goal: string;
  state: TaskState;
  // When its latest submission was made, or null if it has none.
  submittedAt: number | null;
  mergeSha: string | null;
}

export interface Order {
  first: CollisionRole;
  why: string;
}

const SUBMITTED: TaskState[] = ["in_review", "escalated"];
const TARGETS_NAMED = 4;

// Which of the two is expected to land first. Either order is safe; this is the one that wastes least work.
export function landingOrder(provider: Party, relier: Party): Order {
  if (provider.mergeSha !== null || relier.mergeSha !== null) {
    return { first: provider.mergeSha !== null ? "provider" : "relier", why: "it has landed" };
  }
  const providerIn = SUBMITTED.includes(provider.state);
  const relierIn = SUBMITTED.includes(relier.state);
  if (providerIn && relierIn) {
    const first = (provider.submittedAt ?? 0) <= (relier.submittedAt ?? 0) ? "provider" : "relier";
    return { first, why: "both are in review, and it submitted first" };
  }
  if (providerIn !== relierIn) {
    return { first: providerIn ? "provider" : "relier", why: "it has submitted, and the other is still being worked on" };
  }
  return {
    first: "provider",
    why: "neither task has submitted, and the one that changes the interface goes first so that the other can be written against it",
  };
}

function named(targets: string[]): string {
  const shown = targets.slice(0, TARGETS_NAMED).join(", ");
  return targets.length > TARGETS_NAMED ? `${shown} and ${targets.length - TARGETS_NAMED} more` : shown;
}

export interface CollisionInput {
  kind: CollisionKind;
  state: CollisionState;
  // The part of the task that is being told.
  role: CollisionRole;
  me: Party;
  other: Party;
  targets: string[];
}

export function describeCollision(input: CollisionInput): { order: { first: string; why: string } | null; brief: string } {
  const { me, other, role } = input;
  const what = named(input.targets);

  if (input.kind === "duplicate") {
    return {
      order: null,
      brief:
        role === "relier"
          ? `${other.agent} started what looks like the same work before you: ${JSON.stringify(other.goal)}. ` +
            "If yours is different, pass confirm_distinct: true to submit and say how it differs in the summary. If it is the same, call abandon."
          : `${other.agent} started what looks like the same work as yours, after you. There is nothing to do.`,
    };
  }

  if (input.state === "possible") {
    return {
      order: null,
      brief:
        role === "relier"
          ? `${other.agent} holds code that your work uses (${what}) and has not said that it will change it. There is nothing to do; you will be told if that changes.`
          : `${other.agent}'s work uses ${what}, which is in code you hold. If you change its name, parameters or result, say so with declare_interface_change. Otherwise there is nothing to do.`,
    };
  }

  const [provider, relier] = role === "provider" ? [me, other] : [other, me];
  const order = landingOrder(provider, relier);
  const first = order.first === "provider" ? provider : relier;
  const sha = (other.mergeSha ?? "").slice(0, 7);

  let brief: string;
  if (role === "relier") {
    brief =
      other.mergeSha !== null
        ? `${what} changed on the main branch when ${other.agent}'s task landed (${sha}). Call sync_with_main, change your code to fit, run the tests, and submit.`
        : `${other.agent} is changing ${what}, which your work uses. Its goal: ${JSON.stringify(other.goal)}. Call peek to read its change. ` +
          "If it lands before you, your submission is sent back to catch up with the main branch and adapt. If you land first, it has to update your code. " +
          "To avoid doing the work twice, write against the new shape, or wait for it to land and call sync_with_main.";
  } else {
    brief =
      other.mergeSha !== null
        ? `${other.agent}'s task landed code that uses ${what} (${sha}). Call sync_with_main, add the files that use it to your scope with expand_scope, update them to the new shape, and submit.`
        : `${other.agent}'s work uses ${what}, which you are changing. If you land first, it adapts. If it lands first, the files it adds that use the interface become yours to update before you can land.`;
  }
  return { order: { first: first.agent, why: order.why }, brief };
}
