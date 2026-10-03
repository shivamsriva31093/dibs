import { describe, expect, it } from "vitest";
import { describeGateFailure, gateSummary, gateEvidence, parseChecks, type GateResult } from "../../src/gate";

describe("parseChecks", () => {
  it("reads the checks a repository declares", () => {
    expect(parseChecks('{ "setup": "npm ci", "checks": [{ "name": "test", "run": "npm test" }, { "name": "types", "run": "npm run typecheck" }] }')).toEqual({
      ok: true,
      config: {
        setup: "npm ci",
        checks: [
          { name: "test", run: "npm test" },
          { name: "types", run: "npm run typecheck" },
        ],
        timeoutSeconds: 600,
        internet: false,
      },
    });
  });

  it("takes a time limit and leave to reach the Internet", () => {
    expect(parseChecks('{ "checks": [{ "name": "test", "run": "npm test" }], "timeout_seconds": 120, "internet": true }')).toMatchObject({
      ok: true,
      config: { setup: null, timeoutSeconds: 120, internet: true },
    });
  });

  it.each([
    ["not json", "the file is not JSON"],
    ["[]", "the file must hold an object"],
    ['{ "checks": [] }', "checks must list between 1 and 10 commands"],
    ['{ "checks": [{ "name": "", "run": "x" }] }', "each check needs a name of 1 to 40 letters, digits, dots, hyphens or underscores"],
    ['{ "checks": [{ "name": "a b", "run": "x" }] }', "each check needs a name of 1 to 40 letters, digits, dots, hyphens or underscores"],
    ['{ "checks": [{ "name": "test", "run": "" }] }', "each check needs a command to run"],
    ['{ "checks": [{ "name": "test", "run": "x" }, { "name": "test", "run": "y" }] }', "two checks are named test"],
    ['{ "checks": [{ "name": "test", "run": "x" }], "timeout_seconds": 0 }', "timeout_seconds must be between 1 and 900"],
    ['{ "checks": [{ "name": "test", "run": "x" }], "timeout_seconds": 901 }', "timeout_seconds must be between 1 and 900"],
    ['{ "checks": [{ "name": "test", "run": "x" }], "setup": 3 }', "setup must be a command"],
  ])("refuses %s: %s", (text, reason) => {
    expect(parseChecks(text)).toEqual({ ok: false, reason: `.dibs/checks.json: ${reason}` });
  });
});

const PASSED: GateResult = {
  outcome: "pass",
  candidateSha: "c".repeat(40),
  baseSha: "b".repeat(40),
  treeSha: "7".repeat(40),
  seconds: 14.2,
  steps: [
    { name: "setup", command: "npm ci", exitCode: 0, seconds: 9.1, output: "added 12 packages" },
    { name: "test", command: "npm test", exitCode: 0, seconds: 3.4, output: "# pass 26\n# fail 0" },
  ],
};

const FAILED: GateResult = {
  ...PASSED,
  outcome: "fail",
  steps: [
    PASSED.steps[0]!,
    { name: "test", command: "npm test", exitCode: 1, seconds: 2.9, output: "not ok 3 - GET /users/:id is 404 for an unknown id\n# pass 25\n# fail 1" },
  ],
};

describe("gateSummary", () => {
  it("says on one line how the checks went, for a commit trailer", () => {
    expect(gateSummary(PASSED)).toBe("pass; test; 14s");
    expect(gateSummary(FAILED)).toBe("fail; test failed; 14s");
    expect(gateSummary({ ...PASSED, outcome: "error", steps: [], error: "the container did not start" })).toBe("error; the container did not start");
  });
});

describe("describeGateFailure", () => {
  it("tells the agent which check failed, how, and what to do", () => {
    expect(describeGateFailure(FAILED)).toBe(
      "The repository's checks failed on your change joined with the current main branch.\n" +
        "`npm test` (test) exited with 1 after 3 s. The end of its output:\n" +
        "```\nnot ok 3 - GET /users/:id is 404 for an unknown id\n# pass 25\n# fail 1\n```\n" +
        "Call sync_with_main if the main branch has moved, run `npm test` in your clone, fix what fails, push, and submit again.",
    );
  });

  it("names the setup when that is what failed", () => {
    const failed: GateResult = { ...PASSED, outcome: "fail", steps: [{ name: "setup", command: "npm ci", exitCode: 1, seconds: 4, output: "npm ERR! missing lockfile" }] };

    expect(describeGateFailure(failed)).toContain("`npm ci` (setup) exited with 1 after 4 s.");
  });

  it("says when a check ran out of time", () => {
    const slow: GateResult = { ...FAILED, steps: [{ ...FAILED.steps[1]!, exitCode: 124, seconds: 600 }] };

    expect(describeGateFailure(slow)).toContain("`npm test` (test) did not finish within 600 s.");
  });
});

describe("gateEvidence", () => {
  it("tells the reviewer what ran and how it went", () => {
    expect(gateEvidence(PASSED)).toBe(
      "dibs ran the repository's checks on this change joined with the current main branch, before you were asked:\n" +
        "- setup, `npm ci`: passed in 9 s\n" +
        "- test, `npm test`: passed in 3 s\n" +
        "Look for what the checks do not cover.",
    );
  });

  it("is null when there is nothing to tell", () => {
    expect(gateEvidence(null)).toBeNull();
    expect(gateEvidence({ ...PASSED, outcome: "error", steps: [], error: "the container did not start" })).toBeNull();
  });
});
