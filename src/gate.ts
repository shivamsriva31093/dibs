// The gate: the repository's own checks, run on a change joined with the current
// main branch, before the change lands. A repository declares them in
// `.dibs/checks.json`; without that file there is no gate.
//
// This file holds what the gate means: the declaration, the result, and how a
// result is put to an agent, to the reviewer and to git. Running the checks is
// gate-runner.ts.

export interface ChecksConfig {
  // Run once before the checks, as `npm ci`. Null for nothing.
  setup: string | null;
  checks: { name: string; run: string }[];
  // The most each command may take.
  timeoutSeconds: number;
  // Whether the commands may reach the Internet. Off unless the repository asks, so that the
  // code under review cannot send anything anywhere.
  internet: boolean;
}

export const CHECKS_FILE = ".dibs/checks.json";

const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 900;
const MAX_CHECKS = 10;
const NAME = /^[A-Za-z0-9._-]{1,40}$/;

export function parseChecks(text: string): { ok: true; config: ChecksConfig } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason: `${CHECKS_FILE}: ${reason}` });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refuse("the file is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refuse("the file must hold an object");
  }
  const raw = value as { setup?: unknown; checks?: unknown; timeout_seconds?: unknown; internet?: unknown };
  if (!Array.isArray(raw.checks) || raw.checks.length === 0 || raw.checks.length > MAX_CHECKS) {
    return refuse(`checks must list between 1 and ${MAX_CHECKS} commands`);
  }
  const checks: ChecksConfig["checks"] = [];
  for (const entry of raw.checks as { name?: unknown; run?: unknown }[]) {
    if (typeof entry?.name !== "string" || !NAME.test(entry.name)) {
      return refuse("each check needs a name of 1 to 40 letters, digits, dots, hyphens or underscores");
    }
    if (typeof entry.run !== "string" || entry.run.trim() === "") {
      return refuse("each check needs a command to run");
    }
    if (checks.some((check) => check.name === entry.name)) {
      return refuse(`two checks are named ${entry.name}`);
    }
    checks.push({ name: entry.name, run: entry.run });
  }
  if (raw.setup !== undefined && (typeof raw.setup !== "string" || raw.setup.trim() === "")) {
    return refuse("setup must be a command");
  }
  const timeout = raw.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS) {
    return refuse(`timeout_seconds must be between 1 and ${MAX_TIMEOUT_SECONDS}`);
  }
  return {
    ok: true,
    config: { setup: typeof raw.setup === "string" ? raw.setup : null, checks, timeoutSeconds: timeout, internet: raw.internet === true },
  };
}

export interface GateStep {
  // "setup", or the name of a check.
  name: string;
  command: string;
  exitCode: number;
  seconds: number;
  // The end of what the command printed, both streams together.
  output: string;
}

export interface GateResult {
  // "error" when the checks could not be run at all; that says nothing about the change.
  outcome: "pass" | "fail" | "error";
  // The commit the checks ran on: the change joined with the main branch at `baseSha`.
  candidateSha: string;
  baseSha: string;
  // The tree of the candidate. A later candidate with the same tree needs no new run.
  treeSha: string;
  seconds: number;
  // The setup and the checks, in the order they ran. A failed step is the last.
  steps: GateStep[];
  error?: string;
}

export interface GateRequest {
  repo: string;
  // The git remote of the main repository, which holds the candidate under `ref`.
  remote: string;
  ref: string;
  candidateSha: string;
  baseSha: string;
  treeSha: string;
  config: ChecksConfig;
}

export interface Gate {
  run(request: GateRequest): Promise<GateResult>;
}

// The exit code `timeout` gives a command it had to stop.
export const TIMED_OUT = 124;

const whole = (seconds: number) => Math.round(seconds);

// For a commit trailer: "pass; test, types; 14s".
export function gateSummary(result: GateResult): string {
  if (result.outcome === "error") {
    return `error; ${result.error ?? "the checks could not be run"}`;
  }
  const checks = result.steps.filter((step) => step.name !== "setup");
  if (result.outcome === "pass") {
    return `pass; ${checks.map((step) => step.name).join(", ")}; ${whole(result.seconds)}s`;
  }
  const failed = result.steps.at(-1)!;
  return `fail; ${failed.name} failed; ${whole(result.seconds)}s`;
}

function how(step: GateStep, timeoutSeconds: number | null): string {
  return step.exitCode === TIMED_OUT
    ? `did not finish within ${timeoutSeconds ?? whole(step.seconds)} s`
    : `exited with ${step.exitCode} after ${whole(step.seconds)} s`;
}

// What an agent is told when the checks fail on its change.
export function describeGateFailure(result: GateResult): string {
  const failed = result.steps.at(-1)!;
  return (
    "The repository's checks failed on your change joined with the current main branch.\n" +
    `\`${failed.command}\` (${failed.name}) ${how(failed, failed.exitCode === TIMED_OUT ? whole(failed.seconds) : null)}. The end of its output:\n` +
    `\`\`\`\n${failed.output.trimEnd()}\n\`\`\`\n` +
    `Call sync_with_main if the main branch has moved, run \`${failed.command}\` in your clone, fix what fails, push, and submit again.`
  );
}

// What the reviewer is told about the checks, or null when they did not run.
export function gateEvidence(result: GateResult | null): string | null {
  if (result === null || result.outcome === "error") {
    return null;
  }
  const lines = result.steps.map(
    (step) => `- ${step.name}, \`${step.command}\`: ${step.exitCode === 0 ? `passed in ${whole(step.seconds)} s` : `failed: ${how(step, null)}`}`,
  );
  return (
    "dibs ran the repository's checks on this change joined with the current main branch, before you were asked:\n" +
    `${lines.join("\n")}\n` +
    "Look for what the checks do not cover."
  );
}
