import { describe, expect, it } from "vitest";
import { describeAnswer, describeStep, shownCommand, stepsFrom } from "../../video/agent-log";

// The demo video shows what each agent is doing, read from the log of its headless
// session. That log holds the credentials dibs hands to the agent, so what is shown
// is built from it piece by piece and never copied.

const TOKEN = "art_v1_0123456789abcdef0123456789abcdef01234567?expires=1790000000";
const REMOTE = "https://0a1b2c3d.artifacts.cloudflare.net/git/dibs/demo--t-k3x9a1.git";
const CWD = "/private/var/folders/m1/zf3k/T/dibs-demo-Ab12Cd/agent-one";
const WHERE = { cwd: CWD, clone: "demo--t-k3x9a1" };

describe("shownCommand", () => {
  it.each([
    [`git -c http.extraHeader="Authorization: Bearer ${TOKEN}" clone ${REMOTE}`, "git clone …"],
    [`git -c http.extraHeader='Authorization: Bearer ${TOKEN}' push origin HEAD:main`, "git push origin HEAD:main"],
    [`git -c http.extraHeader="Authorization: Bearer ${TOKEN}" pull --no-rebase --no-edit ${REMOTE} main`, "git pull --no-rebase --no-edit … main"],
  ])("shows a git command without the credential it was given", (command, shown) => {
    expect(shownCommand(command)).toBe(shown);
  });

  it.each([
    `git clone https://x:${TOKEN}@0a1b2c3d.artifacts.cloudflare.net/git/dibs/demo.git`,
    `git config http.extraHeader "Authorization: Bearer ${TOKEN}"`,
    `curl -H "Authorization: Bearer ${TOKEN}" localhost`,
    `echo ${TOKEN}`,
    `GIT_TOKEN=${TOKEN} git fetch`,
  ])("never shows a token, wherever it is: %s", (command) => {
    const shown = shownCommand(command);

    expect(shown).not.toContain("art_v1_");
    expect(shown).not.toContain("0123456789abcdef");
    expect(shown).not.toContain("expires=");
  });

  it("hides whatever follows Bearer, whether or not it looks like a dibs token", () => {
    expect(shownCommand('curl -H "Authorization: Bearer sk-live-abc.def_123" localhost')).toBe('curl -H "Authorization: Bearer …" localhost');
  });

  it("drops the changes of directory in front of a command", () => {
    expect(shownCommand(`cd ${CWD}/demo--t-k3x9a1 && npm test`)).toBe("npm test");
    expect(shownCommand("cd demo--t-k3x9a1 && cd src && ls")).toBe("ls");
  });

  it("puts a command of several lines on one line", () => {
    expect(shownCommand('git commit -m "Add the route\n\nIt answers 404 when there is no such user."')).toBe(
      'git commit -m "Add the route It answers 404 when there is no such user."',
    );
  });
});

describe("describeStep", () => {
  it("shows the paths a claim asks for", () => {
    expect(describeStep("mcp__dibs__start_task", { goal: "Add a route", paths: ["src/routes/users/", "test/users-get.test.ts"] }, WHERE)).toBe(
      "start_task  src/routes/users/, test/users-get.test.ts",
    );
    expect(describeStep("mcp__dibs__expand_claim", { task_id: "t-k3x9a1", paths: ["src/utils/numbers.ts"] }, WHERE)).toBe(
      "expand_claim  src/utils/numbers.ts",
    );
  });

  it("shows any other dibs call by its name alone", () => {
    expect(describeStep("mcp__dibs__submit", { task_id: "t-k3x9a1", summary: "A long summary of the change." }, WHERE)).toBe("submit");
    expect(describeStep("mcp__dibs__get_verdict", { task_id: "t-k3x9a1" }, WHERE)).toBe("get_verdict");
  });

  it("shows a shell command, cut where it gets long", () => {
    expect(describeStep("Bash", { command: `cd ${CWD}/demo--t-k3x9a1 && npm test` }, WHERE)).toBe("npm test");

    const long = describeStep("Bash", { command: `git commit -m "${"word ".repeat(30)}"` }, WHERE)!;
    expect(long.length).toBe(64);
    expect(long.endsWith("…")).toBe(true);
  });

  it("shows a path under the agent's own directory without that directory", () => {
    expect(describeStep("Bash", { command: `ls ${CWD}/demo--t-k3x9a1/src/routes` }, WHERE)).toBe("ls src/routes");
    expect(describeStep("Bash", { command: `git -C ${CWD}/demo--t-k3x9a1 status` }, WHERE)).toBe("git -C . status");
    expect(describeStep("Bash", { command: `ls ${CWD}` }, WHERE)).toBe("ls .");
  });

  it("names the directory a clone command writes to, even when the agent already works there", () => {
    expect(describeStep("Bash", { command: `git clone ${REMOTE} ${CWD}/demo--t-k3x9a1 2>&1 | tail -2` }, WHERE)).toBe("git clone … demo--t-k3x9a1 2>&1 | tail -2");
  });

  it("treats /private/var and /var as the same place", () => {
    const short = CWD.replace("/private", "");

    expect(describeStep("Edit", { file_path: `${short}/demo--t-k3x9a1/src/index.ts` }, WHERE)).toBe("edit src/index.ts");
    expect(describeStep("Bash", { command: `ls ${short}/demo--t-k3x9a1/test` }, WHERE)).toBe("ls test");
  });

  it("shows paths as they are while it is not known where the agent works", () => {
    expect(describeStep("Bash", { command: "ls src" }, { cwd: "", clone: "" })).toBe("ls src");
    expect(describeStep("Edit", { file_path: "/tmp/somewhere/src/index.ts" }, { cwd: "", clone: "" })).toBe("edit index.ts");
  });

  it("shows an edited file by its path in the repository", () => {
    expect(describeStep("Edit", { file_path: `${CWD}/demo--t-k3x9a1/src/routes/users/index.ts` }, WHERE)).toBe("edit src/routes/users/index.ts");
    expect(describeStep("Write", { file_path: `${CWD}/demo--t-k3x9a1/test/users-get.test.ts` }, WHERE)).toBe("edit test/users-get.test.ts");
  });

  it("shows a file outside the clone by its path under the agent's directory, and any other file by its name", () => {
    expect(describeStep("Write", { file_path: `${CWD}/notes.md` }, WHERE)).toBe("edit notes.md");
    expect(describeStep("Write", { file_path: "/Users/someone/elsewhere/notes.md" }, WHERE)).toBe("edit notes.md");
  });

  it.each(["Read", "Grep", "Glob", "TodoWrite"])("has nothing to say about %s", (name) => {
    expect(describeStep(name, { file_path: `${CWD}/demo--t-k3x9a1/AGENTS.md` }, WHERE)).toBeNull();
  });
});

describe("describeAnswer", () => {
  it("says who holds the paths when a claim is refused", () => {
    const refusal = {
      error: { code: "claim_conflict", message: "another task holds these paths", retryable: true },
      conflicts: [{ task_id: "t-1", agent: "agent-one", goal: "Add a route", state: "active", paths: ["src/routes/users/"] }],
    };

    expect(describeAnswer("start_task", refusal)).toBe("refused: agent-one holds src/routes/users/");
  });

  it("names the error when a call fails for another reason", () => {
    expect(describeAnswer("submit", { error: { code: "nothing_to_submit", message: "the fork has no new commits", retryable: false } })).toBe(
      "refused: nothing_to_submit",
    );
  });

  it("says that a claim was granted, and what it is connected to", () => {
    expect(describeAnswer("start_task", { task_id: "t-1", token: TOKEN, related: [] })).toBe("claimed");
    expect(describeAnswer("start_task", { task_id: "t-5", token: TOKEN, related: [{ agent: "agent-one", relation: "coupled" }] })).toBe(
      "claimed; coupled with agent-one",
    );
    expect(describeAnswer("expand_claim", { paths: ["src/a.ts", "src/b.ts"] })).toBe("claim expanded");
  });

  it("says which attempt went into review", () => {
    expect(describeAnswer("submit", { submission_id: 4, cycle: 2, status: "in_review", related: [] })).toBe("in review, attempt 2");
  });

  it.each([
    [{ state: "in_review", verdict: null }, "in review"],
    [{ state: "escalated", verdict: { decision: "escalate", source: "reviewer" } }, "waiting for a person"],
    [{ state: "merged", merge_sha: "0ec3ab64946c621ef455bf4312c0000000000000", verdict: { decision: "approve", source: "reviewer" } }, "merged as 0ec3ab6"],
    [{ state: "active", verdict: { decision: "reject", source: "reviewer" } }, "sent back: issues to fix"],
    [{ state: "active", verdict: { decision: "reject", source: "human" } }, "sent back: a person's note"],
    [{ state: "active", verdict: { decision: "reject", source: "check" } }, "sent back: a check failed"],
    [{ state: "active", verdict: { decision: "reject", source: "merge" } }, "sent back: main has moved"],
    [{ state: "closed", verdict: { decision: "reject", source: "human" } }, "closed"],
  ])("says where a task stands: %j", (answer, shown) => {
    expect(describeAnswer("get_verdict", answer)).toBe(shown);
  });

  it("says where main is after a catch-up", () => {
    expect(describeAnswer("sync_with_main", { remote: REMOTE, branch: "main", main_head: "2d5ef9c0aa11bb22cc33dd44ee55ff6677889900", token: TOKEN })).toBe(
      "main is at 2d5ef9c",
    );
  });
});

// One line of a session's log, as `claude -p --output-format stream-json --verbose` writes it.
const init = JSON.stringify({ type: "system", subtype: "init", cwd: CWD, session_id: "s-1", tools: ["Bash", "Edit"] });
let nextUse = 0;
function asked(name: string, input: Record<string, unknown>): { line: string; id: string } {
  const id = `toolu_${++nextUse}`;
  return {
    id,
    line: JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] }, session_id: "s-1" }),
  };
}
function answered(id: string, answer: unknown, as: "blocks" | "text" = "blocks"): string {
  const text = typeof answer === "string" ? answer : JSON.stringify(answer, null, 2);
  const content = as === "blocks" ? [{ type: "text", text }] : text;
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] }, session_id: "s-1" });
}
// A call and its answer, as two lines.
function exchange(name: string, input: Record<string, unknown>, answer: unknown, as: "blocks" | "text" = "blocks"): string[] {
  const call = asked(name, input);
  return [call.line, answered(call.id, answer, as)];
}

const GRANTED = {
  task_id: "t-k3x9a1",
  remote: REMOTE,
  token: TOKEN,
  branch: "main",
  related: [],
  clone_command: `git -c http.extraHeader="Authorization: Bearer ${TOKEN}" clone ${REMOTE}`,
  push_command: `git -c http.extraHeader="Authorization: Bearer ${TOKEN}" push origin HEAD:main`,
};

describe("stepsFrom", () => {
  it("lists what the agent did, each dibs call with what it was answered", () => {
    const log = [
      init,
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "First, the claim." }] } }),
      ...exchange("mcp__dibs__start_task", { goal: "Add a route", paths: ["src/routes/users/"] }, GRANTED),
      ...exchange("Bash", { command: GRANTED.clone_command }, "Cloning into 'demo--t-k3x9a1'..."),
      ...exchange("Read", { file_path: `${CWD}/demo--t-k3x9a1/AGENTS.md` }, "1\t# Rules"),
      ...exchange("Write", { file_path: `${CWD}/demo--t-k3x9a1/src/routes/users/get.ts`, content: "export {}" }, "File created"),
      ...exchange("Bash", { command: `cd ${CWD}/demo--t-k3x9a1 && npm test` }, "# pass 12"),
      ...exchange("mcp__dibs__submit", { task_id: "t-k3x9a1", summary: "Adds the route." }, { submission_id: 1, cycle: 1, status: "in_review", related: [] }),
      JSON.stringify({ type: "result", subtype: "success", result: "Done." }),
    ].join("\n");

    expect(stepsFrom(log, 10)).toEqual([
      "start_task  src/routes/users/  → claimed",
      "git clone …",
      "edit src/routes/users/get.ts",
      "npm test",
      "submit  → in review, attempt 1",
    ]);
  });

  it("knows the directory an agent cloned into when it chose one itself", () => {
    const into = (clone: string, edited: string) =>
      stepsFrom(
        [
          init,
          ...exchange("mcp__dibs__start_task", { goal: "x", paths: ["src/a.ts"] }, GRANTED),
          ...exchange("Bash", { command: clone }, "Cloning..."),
          ...exchange("Edit", { file_path: `${CWD}/${edited}` }, "ok"),
        ].join("\n"),
      ).at(-1);

    expect(into(`${GRANTED.clone_command} repo 2>&1 | tail -2`, "repo/src/a.ts")).toBe("edit src/a.ts");
    expect(into(`${GRANTED.clone_command} work/fork && cd work/fork && ls`, "work/fork/src/a.ts")).toBe("edit src/a.ts");
    expect(into(`${GRANTED.clone_command} --quiet ./repo`, "repo/src/a.ts")).toBe("edit src/a.ts");
    expect(into(`git -c http.extraHeader="Authorization: Bearer ${TOKEN}" clone --depth 1 ${REMOTE} "my repo"`, "my repo/src/a.ts")).toBe("edit src/a.ts");
    // Without a directory, git names it after the address, as before.
    expect(into(`${GRANTED.clone_command} 2>&1 | tail -2`, "demo--t-k3x9a1/src/a.ts")).toBe("edit src/a.ts");
    expect(into(`${GRANTED.clone_command} && ls`, "demo--t-k3x9a1/src/a.ts")).toBe("edit src/a.ts");
    // Cloned into the directory the session started in.
    expect(into(`${GRANTED.clone_command} .`, "src/a.ts")).toBe("edit src/a.ts");
  });

  it("takes the directory from a clone command only once the clone has worked", () => {
    const refused = asked("Bash", { command: `${GRANTED.clone_command} elsewhere 2>&1 | tail -2; cd elsewhere && ls` });
    const log = [
      init,
      ...exchange("mcp__dibs__start_task", { goal: "x", paths: ["src/a.ts"] }, GRANTED),
      refused.line,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: refused.id, is_error: true, content: "This command changes directory before running a version-control command." }] },
      }),
      // The agent then names the directory in full.
      ...exchange("Bash", { command: `${GRANTED.clone_command} ${CWD}/repo 2>&1 | tail -2` }, `Cloning into '${CWD}/repo'...`),
      ...exchange("Edit", { file_path: `${CWD}/repo/src/a.ts` }, "ok"),
      ...exchange("Bash", { command: `ls ${CWD}/repo/test` }, "a.test.ts"),
    ].join("\n");

    expect(stepsFrom(log).slice(-4)).toEqual(["git clone … elsewhere 2>&1 | tail -2; cd elsewhere && ls", "git clone … repo 2>&1 | tail -2", "edit src/a.ts", "ls test"]);
  });

  it("reads a line whose content is plain text", () => {
    const log = [init, JSON.stringify({ type: "user", message: { role: "user", content: "Your task: add a route." } }), ...exchange("Bash", { command: "ls" }, "a")].join("\n");

    expect(stepsFrom(log)).toEqual(["ls"]);
  });

  it("shows later commands from the root of a clone the agent named itself", () => {
    const log = [
      init,
      ...exchange("mcp__dibs__start_task", { goal: "x", paths: ["src/a.ts"] }, GRANTED),
      ...exchange("Bash", { command: `${GRANTED.clone_command} repo` }, "Cloning..."),
      ...exchange("Bash", { command: `ls ${CWD}/repo/src` }, "a.ts"),
    ].join("\n");

    expect(stepsFrom(log).at(-1)).toBe("ls src");
  });

  it("reads an answer that is given as plain text as well", () => {
    const log = [init, ...exchange("mcp__dibs__expand_claim", { task_id: "t-1", paths: ["src/utils/numbers.ts"] }, { paths: ["src/utils/numbers.ts"] }, "text")].join("\n");

    expect(stepsFrom(log)).toEqual(["expand_claim  src/utils/numbers.ts  → claim expanded"]);
  });

  it("counts a step that is repeated in a row, and shows its latest answer", () => {
    const log = [
      init,
      ...exchange("mcp__dibs__submit", { task_id: "t-1", summary: "x" }, { submission_id: 1, cycle: 1, status: "in_review", related: [] }),
      ...exchange("mcp__dibs__get_verdict", { task_id: "t-1" }, { state: "in_review", verdict: null }),
      ...exchange("mcp__dibs__get_verdict", { task_id: "t-1" }, { state: "in_review", verdict: null }),
      ...exchange("mcp__dibs__get_verdict", { task_id: "t-1" }, { state: "escalated", verdict: { decision: "escalate", source: "reviewer" } }),
      ...exchange("mcp__dibs__get_verdict", { task_id: "t-1" }, { state: "escalated", verdict: { decision: "escalate", source: "reviewer" } }),
    ].join("\n");

    expect(stepsFrom(log)).toEqual(["submit  → in review, attempt 1", "get_verdict ×4  → waiting for a person"]);
  });

  it("shows a repeated step while its latest answer is still to come", () => {
    const first = exchange("mcp__dibs__get_verdict", { task_id: "t-1" }, { state: "in_review", verdict: null });
    const second = asked("mcp__dibs__get_verdict", { task_id: "t-1" });

    expect(stepsFrom([init, ...first, second.line].join("\n"))).toEqual(["get_verdict ×2"]);
  });

  it("does not count two different commands as one", () => {
    const log = [init, ...exchange("Bash", { command: "npm test" }, "ok"), ...exchange("Bash", { command: "git status" }, "clean"), ...exchange("Bash", { command: "npm test" }, "ok")].join(
      "\n",
    );

    expect(stepsFrom(log)).toEqual(["npm test", "git status", "npm test"]);
  });

  it("keeps the last few steps only", () => {
    const log = [init, ...["a", "b", "c", "d", "e", "f", "g"].flatMap((name) => exchange("Bash", { command: `ls ${name}` }, name))].join("\n");

    expect(stepsFrom(log)).toEqual(["ls c", "ls d", "ls e", "ls f", "ls g"]);
    expect(stepsFrom(log, 2)).toEqual(["ls f", "ls g"]);
  });

  it("skips what is not a step: a line cut short, a line that is not JSON, and an answer to nothing", () => {
    const call = asked("mcp__dibs__start_task", { goal: "x", paths: ["src/a.ts"] });
    const log = ["warning: something on stderr", init, call.line, answered("toolu_unknown", GRANTED), answered(call.id, GRANTED).slice(0, 80)].join("\n");

    expect(stepsFrom(log)).toEqual(["start_task  src/a.ts"]);
  });

  it("leaves a dibs call without an answer when the answer cannot be read", () => {
    const log = [init, ...exchange("mcp__dibs__get_verdict", { task_id: "t-1" }, "MCP error -32001: Request timed out")].join("\n");

    expect(stepsFrom(log)).toEqual(["get_verdict"]);
  });

  it("never shows a credential that the log holds", () => {
    const log = [
      init,
      ...exchange("mcp__dibs__start_task", { goal: "Add a route", paths: ["src/routes/users/"] }, GRANTED),
      ...exchange("Bash", { command: GRANTED.clone_command }, "Cloning..."),
      ...exchange("Bash", { command: `cd demo--t-k3x9a1 && ${GRANTED.push_command}` }, "To ..."),
      ...exchange("mcp__dibs__sync_with_main", { task_id: "t-k3x9a1" }, { remote: REMOTE, branch: "main", main_head: "2d5ef9c0aa11", token: TOKEN, sync_command: `git -c http.extraHeader="Authorization: Bearer ${TOKEN}" pull --no-rebase --no-edit ${REMOTE} main` }),
      ...exchange("Bash", { command: `git -c http.extraHeader="Authorization: Bearer ${TOKEN}" pull --no-rebase --no-edit ${REMOTE} main` }, "Merge made"),
    ].join("\n");

    const shown = stepsFrom(log, 20).join("\n");

    expect(shown).not.toContain("art_v1_");
    expect(shown).not.toContain("artifacts.cloudflare.net");
    expect(shown).toContain("git push origin HEAD:main");
    expect(shown).toContain("sync_with_main  → main is at 2d5ef9c");
  });

  it("has nothing to show for an empty log", () => {
    expect(stepsFrom("")).toEqual([]);
  });
});
