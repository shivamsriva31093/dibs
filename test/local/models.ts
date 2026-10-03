// Stand-ins for the two models, for running dibs on one machine. They follow
// fixed rules, written down here in full. They exercise the plumbing around the
// models and judge nothing: a change they pass has not been reviewed.

type Json = Record<string, any>;

interface TaskLike {
  goal: string;
  paths: string[];
}

// The code identifiers a goal names: camelCase words such as findUser.
function identifiers(goal: string): Set<string> {
  return new Set(goal.match(/\b[a-z]+[A-Z][A-Za-z0-9]*\b/g) ?? []);
}

// Two tasks are connected when their goals name the same identifier, or when one goal names a path the other claims.
function connected(a: TaskLike, b: TaskLike): boolean {
  const named = identifiers(a.goal);
  const sharesIdentifier = [...identifiers(b.goal)].some((identifier) => named.has(identifier));
  const namesPathOf = (one: TaskLike, other: TaskLike) => other.paths.some((path) => one.goal.includes(path));
  return sharesIdentifier || namesPathOf(a, b) || namesPathOf(b, a);
}

const taskLike = (value: Json | undefined): TaskLike => ({
  goal: String(value?.goal ?? ""),
  paths: Array.isArray(value?.paths) ? value.paths.map(String) : [],
});

// True when a diff removes or rewrites the declaration of something exported.
function changesAnExport(diff: string): boolean {
  const lines = diff.split("\n");
  const declaration = (line: string) => line.slice(1).split(/[={]/)[0]!.trim();
  const added = new Set(lines.filter((line) => line.startsWith("+export ")).map(declaration));
  return lines.some((line) => line.startsWith("-export ") && !added.has(declaration(line)));
}

function choice(picked: string, options: string[], confidence: number): Json {
  const rest = (1 - confidence) / Math.max(options.length - 1, 1);
  return {
    type: "choice",
    choice: picked,
    probabilities: Object.fromEntries(options.map((option) => [option, option === picked ? confidence : rest])),
    confidence,
  };
}

function score(value: number, levels: unknown[], confidence: number): Json {
  return {
    type: "score",
    score: value,
    legend: Object.fromEntries(levels.map((level, index) => [String(index), level])),
    probabilities: Object.fromEntries(levels.map((_level, index) => [String(index), index === Math.round(value) ? confidence : 0])),
    confidence,
  };
}

// Answers a Clef request the way dibs asks them (see src/decider.ts):
//   - related work: two tasks are "coupled" when their goals name the same identifier, or one names a path the other claims;
//   - goal fit and risk: always "fits the goal", "low risk";
//   - interface change: likely when a diff removes or rewrites an exported declaration;
//   - leftovers: likely when a diff adds a console.log, a TODO or a FIXME.
export function standInClef(inputs: Json): Json {
  const state: Json = inputs.state ?? {};
  const diffs: string[] = (state.files ?? []).map((file: Json) => String(file.diff ?? ""));
  const added = diffs.flatMap((diff) => diff.split("\n").filter((line) => line.startsWith("+")));
  const answers: Json = {};

  for (const [id, question] of Object.entries<Json>(inputs.questions ?? {})) {
    if (question.type === "choice") {
      const coupled = connected(taskLike(state.new_task), taskLike(question.instructions?.other_task));
      answers[id] = choice(coupled ? "coupled" : "independent", Object.keys(question.criteria ?? {}), coupled ? 0.82 : 0.9);
    } else if (question.type === "score") {
      answers[id] = id === "risk" ? score(0.9, question.criteria, 0.8) : score(2.8, question.criteria, 0.8);
    } else if (id === "interface_change") {
      answers[id] = { type: "noul", noul: diffs.some(changesAnExport) ? 0.92 : 0.04 };
    } else if (id === "leftovers") {
      answers[id] = { type: "noul", noul: added.some((line) => /console\.log|TODO|FIXME/.test(line)) ? 0.85 : 0.03 };
    } else {
      answers[id] = { type: "noul", noul: 0.05 };
    }
  }
  return { model: inputs.model, answers, usage: { input_tokens: 0, output_tokens: 0 } };
}

// Answers a Messages API request from the reviewer (see src/reviewer.ts). It approves everything.
export function standInReviewer(request: Json): Json {
  const verdict = {
    decision: "approve",
    summary: "Approved by the local stand-in for the reviewer, which approves every change without reading it.",
    issues: [],
  };
  return {
    id: "msg_local_stand_in",
    type: "message",
    role: "assistant",
    model: request.model,
    content: [{ type: "text", text: JSON.stringify(verdict) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}
