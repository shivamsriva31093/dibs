// What an agent did, in a few short lines for the demo video, read from the log of its
// headless session (`claude -p --output-format stream-json --verbose`).
//
// The log holds the credentials dibs hands to the agent: in the answers of the dibs tools
// and in the git commands the agent runs. Nothing is copied out of it. A step is described
// from its name and a few chosen fields, and a command is shown with its credentials removed.

type Json = Record<string, any>;

// Where an agent works: the directory its session started in, and the name of the clone inside it.
export interface Where {
  cwd: string;
  clone: string;
}

const DIBS_TOOL = "mcp__dibs__";
const MAX_STEP_LENGTH = 64;
const SHA_SHOWN = 7;

// macOS reaches its temporary directories under both names.
const samePlace = (text: string) => text.replaceAll("/private/var/", "/var/");

const cut = (text: string) => (text.length > MAX_STEP_LENGTH ? `${text.slice(0, MAX_STEP_LENGTH - 1)}…` : text);

// A command as it can be shown: without the credential git is given, without any address,
// and without the changes of directory in front of it.
export function shownCommand(command: string): string {
  return command
    .replace(/-c\s+http\.extraHeader=("[^"]*"|'[^']*'|\S+)\s*/g, "")
    .replace(/Bearer\s+[^\s"']+/g, "Bearer …")
    .replace(/art_v1_\w+(\?expires=\d+)?/g, "…")
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi, "…")
    .replace(/^(\s*cd\s+\S+\s*&&\s*)+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Options of `git clone` that are followed by a value of their own.
const CLONE_OPTIONS_WITH_VALUE = new Set(["--depth", "-b", "--branch", "-o", "--origin", "-j", "--jobs", "-c", "--config"]);

// The directory a `git clone` in a command writes to: the one the agent named, or else the one git
// names after the address. Empty when it clones into the directory it is in; null when there is no clone.
export function cloneDirectory(command: string): string | null {
  const words: string[] = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  let at = words.indexOf("clone");
  if (at === -1) {
    return null;
  }
  // The next word that is not an option, or undefined where the clone ends: at a pipe, a redirection, or another command.
  const next = (): string | undefined => {
    for (at++; at < words.length; at++) {
      const word = words[at]!;
      if (/^(\|\|?|&&?|;)$/.test(word) || /^\d*[<>]/.test(word)) {
        return undefined;
      }
      if (!word.startsWith("-")) {
        return word.replace(/;$/, "");
      }
      if (CLONE_OPTIONS_WITH_VALUE.has(word)) {
        at++;
      }
    }
    return undefined;
  };
  const address = next();
  if (address === undefined) {
    return null;
  }
  const named = next();
  if (named === undefined) {
    return (address.split("/").at(-1) ?? "").replace(/\.git$/, "");
  }
  const directory = named.replace(/^["']|["']$/g, "").replace(/^\.\//, "").replace(/\/+$/, "");
  return directory === "." ? "" : directory;
}

// The agent's own directories, the most specific first, each with what stands for it.
function ownDirectories(where: Where): [directory: string, shown: string][] {
  if (where.cwd === "") {
    return [];
  }
  const cwd = samePlace(where.cwd);
  if (where.clone === "") {
    return [[cwd, "."]];
  }
  // An agent may name its clone by its full path.
  const clone = where.clone.startsWith("/") ? samePlace(where.clone) : `${cwd}/${where.clone}`;
  return clone === cwd ? [[cwd, "."]] : [[clone, "."], [cwd, "."]];
}

// Paths under the agent's own directory, written from the repository's root.
function fromRepositoryRoot(text: string, where: Where): string {
  let result = samePlace(text);
  for (const [directory, shown] of ownDirectories(where)) {
    result = result.replaceAll(`${directory}/`, "").replaceAll(directory, shown);
  }
  return result;
}

function shownPath(path: string, where: Where): string {
  const full = samePlace(path);
  for (const [directory] of ownDirectories(where)) {
    if (full.startsWith(`${directory}/`)) {
      return full.slice(directory.length + 1);
    }
  }
  return full.split("/").at(-1) ?? full;
}

// One step of an agent as a short line, or null for a step that is not worth showing.
export function describeStep(name: string, input: Json, where: Where): string | null {
  if (name.startsWith(DIBS_TOOL)) {
    const tool = name.slice(DIBS_TOOL.length);
    const paths = Array.isArray(input.paths) ? input.paths.map(String) : [];
    return tool === "start_task" || tool === "expand_claim" ? `${tool}  ${paths.join(", ")}` : tool;
  }
  if (name === "Bash") {
    const command = String(input.command ?? "");
    // A clone command names the clone's directory: only the directory around it is left out.
    const around = cloneDirectory(command) === null ? where : { cwd: where.cwd, clone: "" };
    return cut(shownCommand(fromRepositoryRoot(command, around)));
  }
  if (name === "Write" || name === "Edit") {
    return cut(`edit ${shownPath(String(input.file_path ?? ""), where)}`);
  }
  return null;
}

const SENT_BACK: Record<string, string> = {
  human: "a person's note",
  check: "a check failed",
  merge: "main has moved",
};

// What a dibs tool answered, in a few words. Never the answer itself.
export function describeAnswer(tool: string, answer: Json): string {
  if (answer.error !== undefined) {
    const holder = answer.conflicts?.[0];
    return holder === undefined ? `refused: ${answer.error.code}` : `refused: ${holder.agent} holds ${(holder.paths ?? []).join(", ")}`;
  }
  switch (tool) {
    case "start_task": {
      const other = answer.related?.[0];
      if (other === undefined) {
        return "claimed";
      }
      return other.relation === "duplicate" ? `claimed; may duplicate ${other.agent}'s work` : `claimed; ${other.relation} with ${other.agent}`;
    }
    case "expand_claim":
      return "claim expanded";
    case "submit":
      return answer.status === "escalated" ? "waiting for a person" : `in review, attempt ${answer.cycle}`;
    case "get_verdict":
      switch (answer.state) {
        case "in_review":
          return "in review";
        case "escalated":
          return "waiting for a person";
        case "merged":
          return `merged as ${String(answer.merge_sha).slice(0, SHA_SHOWN)}`;
        case "active":
          return `sent back: ${SENT_BACK[String(answer.verdict?.source)] ?? "issues to fix"}`;
        default:
          return String(answer.state);
      }
    case "sync_with_main":
      return `main is at ${String(answer.main_head).slice(0, SHA_SHOWN)}`;
    default:
      return "ok";
  }
}

interface Step {
  text: string;
  times: number;
  answer: string | null;
}

// The last few steps of an agent, read from the whole of its log so far.
export function stepsFrom(log: string, keep = 5): string[] {
  const steps: Step[] = [];
  const asked = new Map<string, { tool: string; step: Step }>();
  // The directory each clone command would write to, until the command is known to have worked.
  const cloning = new Map<string, string>();
  const where: Where = { cwd: "", clone: "" };

  for (const raw of log.split("\n")) {
    let event: Json;
    try {
      event = JSON.parse(raw);
    } catch {
      // The session's stderr goes to the same file, and its last line may be half written.
      continue;
    }
    if (event === null || typeof event !== "object") {
      continue;
    }
    if (event.type === "system" && typeof event.cwd === "string") {
      where.cwd = event.cwd;
    }
    const blocks = event.message?.content;
    if (!Array.isArray(blocks)) {
      continue;
    }

    for (const block of blocks) {
      if (event.type === "assistant" && block?.type === "tool_use") {
        const name = String(block.name);
        const text = describeStep(name, block.input ?? {}, where);
        const directory = name === "Bash" ? cloneDirectory(String(block.input?.command ?? "")) : null;
        if (directory !== null) {
          cloning.set(String(block.id), directory);
        }
        if (text === null) {
          continue;
        }
        let step = steps.at(-1);
        if (step !== undefined && step.text === text) {
          step.times++;
          step.answer = null;
        } else {
          step = { text, times: 1, answer: null };
          steps.push(step);
        }
        if (name.startsWith(DIBS_TOOL)) {
          asked.set(String(block.id), { tool: name.slice(DIBS_TOOL.length), step });
        }
      } else if (event.type === "user" && block?.type === "tool_result") {
        const cloned = cloning.get(String(block.tool_use_id));
        if (cloned !== undefined && block.is_error !== true) {
          where.clone = cloned;
        }
        const call = asked.get(String(block.tool_use_id));
        if (call === undefined) {
          continue;
        }
        const text =
          typeof block.content === "string" ? block.content : (Array.isArray(block.content) ? block.content : []).map((part: Json) => part?.text ?? "").join("");
        let answer: Json;
        try {
          answer = JSON.parse(text);
        } catch {
          continue;
        }
        if (answer === null || typeof answer !== "object") {
          continue;
        }
        if (call.tool === "start_task" && typeof answer.remote === "string") {
          // git clones into a directory named after the last part of the address.
          where.clone = (answer.remote.split("/").at(-1) ?? "").replace(/\.git$/, "");
        }
        call.step.answer = describeAnswer(call.tool, answer);
      }
    }
  }

  return steps
    .slice(-keep)
    .map((step) => `${step.text}${step.times > 1 ? ` ×${step.times}` : ""}${step.answer === null ? "" : `  → ${step.answer}`}`);
}
