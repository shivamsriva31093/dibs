// Says what an event means in a sentence a person can read at a glance.

import type { DibsEvent } from "../../../src/types";
import { shortSha } from "./format";
import type { Refusal } from "./tree";

export interface EventLine {
  // plain: routine. good: something landed. warn: something was pushed back. human: it involves you.
  tone: "plain" | "good" | "warn" | "human";
  text: string;
  detail?: string;
}

const REFUSAL_VISIBLE_MS = 20_000;

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(record) : []);

// Why a change is in front of a person, in the words the review recorded.
export function escalationReasons(verdict: Record<string, unknown>): string[] {
  const reasons = records(verdict.reasons).map((reason) => {
    // The reviewer's own reason is its summary, which the card shows in full elsewhere.
    if (reason.kind === "reviewer") {
      return "The reviewer asked for a person to decide.";
    }
    const paths = list(reason.paths);
    return paths.length > 0 ? `${text(reason.detail)}: ${paths.join(", ")}` : text(reason.detail);
  });
  if (reasons.length > 0) {
    // A change out of attempts: what it was last sent back for is what the person has to weigh.
    const lastSentBack = records(verdict.reasons).some((reason) => reason.kind === "max_cycles") && text(verdict.message) !== "";
    return lastSentBack ? [...reasons, `The last attempt was sent back because: ${opening(text(verdict.message))}`] : reasons;
  }
  if (text(verdict.message) !== "") {
    return [text(verdict.message)];
  }
  if (text(verdict.error) !== "") {
    return [`The review stopped at the ${text(verdict.step) || "unknown"} step: ${text(verdict.error)}`];
  }
  return ["The reviewer asked for a person to decide."];
}

// "a", "a and b", "a, b and c".
function listOf(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// What the reviewer looked at in the repository before it decided, as one sentence; empty if nothing.
export function lookedUp(verdict: Record<string, unknown>): string {
  const lookups = list(verdict.lookups);
  return lookups.length === 0 ? "" : `Before deciding, it ${listOf(lookups)}.`;
}

const RELATION_LEADS: [relation: string, lead: string][] = [
  ["coupled", "Coupled with"],
  ["duplicate", "May duplicate"],
];

// The tasks connected to a task, grouped by how they relate to it, for saying so in one line.
export function groupRelated<T extends { relation: string }>(related: T[]): { lead: string; others: T[] }[] {
  return RELATION_LEADS.map(([relation, lead]) => ({ lead, others: related.filter((other) => other.relation === relation) })).filter(
    (group) => group.others.length > 0,
  );
}

// The first lines of a longer message, on one line.
function opening(message: string, lines = 2): string {
  return message
    .split("\n")
    .filter((part) => part.trim() !== "")
    .slice(0, lines)
    .join(" ");
}

function line(tone: EventLine["tone"], sentence: string, detail?: string): EventLine {
  return detail === undefined || detail === "" ? { tone, text: sentence } : { tone, text: sentence, detail };
}

export function describeEvent(event: DibsEvent): EventLine {
  const body = record(event.body);
  const agent = text(body.agent) || "An agent";
  const verdict = record(body.verdict);

  switch (event.type) {
    case "task_started":
      return line("plain", `${agent} claimed ${list(body.paths).join(", ")}`, text(body.goal));
    case "claim_conflict": {
      const blocker = records(body.blockedBy)[0] ?? {};
      return line(
        "warn",
        `${agent} was refused ${list(body.paths).join(", ")}`,
        `${text(blocker.agent)} holds ${list(blocker.paths).join(", ")}`,
      );
    }
    case "related_work": {
      const related = records(body.related).map((other) => ({ agent: text(other.agent), relation: text(other.relation) }));
      const detail = groupRelated(related)
        .map((group) => `${group.lead.toLowerCase()} ${listOf(group.others.map((other) => other.agent))}`)
        .join("; ");
      return line("warn", `${agent} was warned about connected work`, detail);
    }
    case "claim_expanded":
      return line("plain", `${agent} added ${list(body.added).join(", ")} to its scope`);
    case "submitted": {
      const cycle = typeof body.cycle === "number" ? body.cycle : 1;
      return line(
        "plain",
        cycle > 1 ? `${agent} submitted its work again (attempt ${cycle})` : `${agent} submitted its work`,
        text(body.summary),
      );
    }
    case "check_failed":
      return verdict.check === "contract"
        ? line("warn", `${agent}'s work was sent back before review: it would have broken main`, opening(text(verdict.message)))
        : line("warn", `${agent}'s work was sent back by a check`, text(verdict.message));
    case "contract":
      return line("warn", `${agent}'s work was sent back as it was about to land: it would have broken main`, opening(text(body.message)));
    case "waiting": {
      const blocker = records(body.blockedBy)[0] ?? {};
      return line(
        "warn",
        `${agent} is waiting in line for ${list(body.paths).join(", ")}`,
        `${text(blocker.agent)} holds ${list(blocker.paths).join(", ")}`,
      );
    }
    case "left_line":
      return line("plain", "A request left the line", text(body.reason));
    case "collision": {
      const provider = text(record(body.provider).agent);
      const relier = text(record(body.relier).agent);
      if (body.kind === "duplicate") {
        return line(
          "warn",
          `${relier} may be doing the same work as ${provider}`,
          "It has to say that its work is different before it can submit.",
        );
      }
      return body.state === "open"
        ? line("warn", `${provider} is changing ${text(body.target)}, which ${relier} relies on`, "Both were told.")
        : line("plain", `${relier} relies on ${text(body.target)}, in code ${provider} holds`);
    }
    case "gate": {
      const [, first = "", time = ""] = text(body.summary).split("; ");
      if (body.outcome === "pass") {
        return line("good", `The checks passed on ${agent}'s change`, `${first}, in ${time}`);
      }
      return body.outcome === "fail"
        ? line("warn", `The checks failed on ${agent}'s change`, `${text(body.failed)} failed`)
        : line("plain", `The checks could not be run on ${agent}'s change`, first);
    }
    case "collision_resolved":
      return body.kind === "duplicate"
        ? line("plain", "Two tasks are no longer taken for the same work", text(body.how))
        : line("good", `The collision at ${text(body.target)} is over`, text(body.how));
    case "triage": {
      const triage = record(body.triage);
      const risk = record(triage.risk).score;
      const fit = record(triage.goal_fit).score;
      const change = triage.interface_change;
      const parts = [
        typeof risk === "number" ? `risk ${risk.toFixed(1)} of 3` : "",
        typeof fit === "number" ? `goal fit ${fit.toFixed(1)} of 3` : "",
        typeof change === "number" ? `interface change ${Math.round(change * 100)}%` : "",
      ].filter((part) => part !== "");
      return line("plain", "Clef scored the change", parts.join(", "));
    }
    case "verdict":
      return body.decision === "approve"
        ? line("good", `The reviewer approved ${agent}'s work`, text(verdict.summary))
        : line("warn", `The reviewer sent ${agent}'s work back`, text(verdict.summary));
    case "escalated": {
      const reasons = records(verdict.reasons).map((reason) => text(reason.detail));
      const stopped = text(verdict.error) === "" ? "" : `the review stopped at the ${text(verdict.step) || "unknown"} step: ${text(verdict.error)}`;
      const why = reasons.join("; ") || text(verdict.message) || stopped || text(verdict.summary);
      return line("human", `${agent}'s work is waiting for you`, why);
    }
    case "merged":
      return line("good", `${agent}'s work landed on main as ${shortSha(text(body.mergeSha))}`, text(body.goal));
    case "human_decision": {
      const verb = { approve: "approved", send_back: "sent", close: "closed" }[text(body.decision)] ?? "decided";
      const sentence =
        body.decision === "send_back" ? `You sent ${agent}'s work back` : `You ${verb} ${agent}'s work`;
      return line("human", sentence, text(body.note));
    }
    case "expired":
      return line("warn", "A claim expired and its paths are free again");
    case "abandoned":
      return line("plain", "A task was abandoned", text(body.reason));
    case "stale":
      return line(
        "warn",
        `${agent}'s work could not land: main changed under it`,
        `${records(body.paths)
          .map((path) => text(path.path))
          .join(", ")}; sent back to catch up with main`,
      );
    case "catching_up":
      return line("plain", `${agent} is catching up with main`, `merging main at ${shortSha(text(body.mainHead))} into its fork`);
    case "decider_unavailable":
      return line(
        "plain",
        body.stage === "triage" ? "Clef was unavailable for the triage" : "Clef was unavailable for the related-work check",
        text(body.reason),
      );
    default:
      return line("plain", event.type);
  }
}

// The claims refused in the last few seconds, to show against the paths that blocked them.
export function refusalsFrom(events: DibsEvent[], now: number): Refusal[] {
  return events
    .filter((event) => event.type === "claim_conflict" && event.createdAt >= now - REFUSAL_VISIBLE_MS)
    .map((event) => {
      const body = record(event.body);
      return {
        id: event.id,
        agent: text(body.agent),
        goal: text(body.goal),
        requested: list(body.paths),
        blockedBy: records(body.blockedBy).map((blocker) => ({
          taskId: text(blocker.taskId),
          agent: text(blocker.agent),
          paths: list(blocker.paths),
        })),
        at: event.createdAt,
      };
    });
}
