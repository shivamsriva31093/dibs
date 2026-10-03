// What dibs says to an agent whose submission would break the main branch if it
// landed: which interface it is about, who is on the other side, and what to do.
// The check itself is the Coordinator's; this is its wording.

import type { CollisionView, ContractReport, InterfaceReport } from "./types";

// Whether a submission must go back to its agent.
export function contractsBroken(report: ContractReport): boolean {
  return report.moved.length > 0 || report.held.length > 0 || (report.unupdated.length > 0 && report.leaves === null);
}

const short = (sha: string) => sha.slice(0, 7);

function listed(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")}, and by ${items.at(-1)!}`;
}

export function describeContract(report: ContractReport): string {
  const parts: string[] = [];

  if (report.moved.length > 0) {
    const lines = report.moved.map((entry) => {
      const who = entry.by !== null ? `, changed by ${entry.by}` : entry.since !== null ? ", changed" : "";
      const where = entry.since !== null ? ` in ${short(entry.since)}` : "";
      const what = entry.now !== null ? ` It is now: ${entry.now}` : who === "" ? " It is no longer there." : "";
      return `- ${entry.target}${who}${where}.${what}`;
    });
    parts.push(
      "Code your change relies on is not what it was when your fork branched off the main branch:\n" +
        `${lines.join("\n")}\n` +
        "Call sync_with_main, change your code to fit, run the tests, and submit again.",
    );
  }

  if (report.unupdated.length > 0 && report.leaves === null) {
    const lines = report.unupdated.map((entry) => {
      const users = listed(entry.files.map((file) => (file.heldBy === null ? file.path : `${file.path} (held by ${file.heldBy})`)));
      return `- ${entry.target} ${entry.change === "removed" ? "is removed and still used by" : "is used by"} ${users}`;
    });
    parts.push(
      "Your change alters interfaces that files on the main branch use, and it does not change those files:\n" +
        `${lines.join("\n")}\n` +
        "Call sync_with_main, add the files to your scope with expand_scope, update them to the new shape, and submit again. " +
        "A file that another task holds is yours to change only after that task ends: call expand_scope with wait_seconds to wait for it. " +
        "If the files need no change, say why in leaves_dependents when you submit, and a person decides.",
    );
  }

  if (report.held.length > 0) {
    parts.push(
      "Your change alters an interface in a file you share with other tasks, and another task holds that interface:\n" +
        `${report.held.map((entry) => `- ${entry.target} is held by ${entry.by}`).join("\n")}\n` +
        "Leave it as it was, or wait for that task to end and submit again.",
    );
  }
  return parts.join("\n\n");
}

// What the reviewer is told about the interfaces a change alters and the other tasks it meets:
// what dibs has already checked, what it could not, and what is left for the reviewer to judge.
// Null when there is nothing to tell.
export function coordinationFor(
  report: InterfaceReport | null,
  contracts: ContractReport | null,
  collisions: CollisionView[],
): string | null {
  const parts: string[] = [];

  const altered = (report?.changed ?? []).filter((change) => change.change !== "added");
  if (altered.length > 0) {
    const lines = altered.map((change) =>
      change.change === "removed"
        ? `- ${change.path}#${change.name} is removed (it was \`${change.before ?? ""}\`)`
        : `- ${change.path}#${change.name}: \`${change.before ?? ""}\` becomes \`${change.after ?? ""}\``,
    );
    let users: string;
    if (contracts === null || !contracts.indexed) {
      users = "dibs could not work out which files use them. Look for callers that the change would break.";
    } else if (contracts.unupdated.length === 0) {
      users = "Every file on the main branch that uses them is part of this change. Check that each one is updated to the new shape.";
    } else {
      const files = [...new Set(contracts.unupdated.flatMap((entry) => entry.files.map((file) => file.path)))];
      users =
        `These files on the main branch use them and are not part of this change: ${files.join(", ")}. ` +
        `The agent says they need no change: ${JSON.stringify(contracts.leaves ?? "")}. Read those files and say whether that holds. A person decides after you.`;
    }
    parts.push(`This change alters these interfaces:\n${lines.join("\n")}\n${users}`);
  }

  // A task that is only watched, or has landed, or does the same work, asks nothing of the reviewer.
  const met = collisions.filter((collision) => collision.kind === "contract" && collision.state === "open" && collision.with.mergeSha === null);
  if (met.length > 0) {
    const lines = met.map((collision) => {
      const who = `${collision.with.agent} (${JSON.stringify(collision.with.goal)}, ${collision.with.state})`;
      const what = collision.targets.join(", ");
      return collision.role === "provider"
        ? `- ${who} uses ${what}, which this change alters.`
        : `- ${who} is changing ${what}, which this change uses.`;
    });
    parts.push(
      `Other agents' tasks meet this one:\n${lines.join("\n")}\n` +
        "Do not hold this change back because of them. When each change lands, dibs checks that no file on the main branch is left using an interface in a shape it was not written for, and sends the later change back to adapt.",
    );
  }
  return parts.length === 0 ? null : parts.join("\n\n");
}
