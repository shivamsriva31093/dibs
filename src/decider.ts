// The decision model: Cloudflare's Clef, reached through Workers AI. It takes a
// state and typed questions and returns a probability for every allowed answer.
// dibs asks it two things: how a new task relates to the live ones, and how a
// submitted change looks. Its answers are signals; code decides what to do with them.

import type { LiveTask, Relation, Triage } from "./types";

export type AiRun = (
  model: string,
  inputs: Record<string, unknown>,
  options: { signal: AbortSignal },
) => Promise<Record<string, unknown>>;

export interface RelatedWorkInput {
  newTask: { goal: string; paths: string[] };
  liveTasks: LiveTask[];
}

export type RelatedAnswer = {
  taskId: string;
  relation: "independent" | Relation;
  confidence: number;
};

export interface TriageInput {
  goal: string;
  claim: string[];
  summary: string;
  files: { path: string; status: string; diff: string }[];
  related: { agent: string; goal: string; paths: string[]; relation: Relation }[];
}

export interface Decider {
  relatedWork(input: RelatedWorkInput): Promise<RelatedAnswer[]>;
  triage(input: TriageInput): Promise<Triage>;
}

export class DeciderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeciderError";
  }
}

type Question =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string | Record<string, unknown>; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface DeciderRequest {
  // The request field selects the model; the names must match the Workers AI model that is called.
  model: "clef" | "clef-flash";
  state: Record<string, unknown>;
  questions: Record<string, Question>;
  [key: string]: unknown;
}

// One request holds at most 64 questions.
const MAX_QUESTIONS = 64;
const RELATIONS = ["independent", "duplicate", "coupled"] as const;

const askedAbout = (liveTasks: LiveTask[]) => liveTasks.slice(-MAX_QUESTIONS);

// Each question carries the other task's details itself, so the model never
// has to look an entry up by id: decision models are weak at that kind of indirection.
export function relatedWorkRequest(input: RelatedWorkInput): DeciderRequest {
  const questions: Record<string, Question> = {};
  for (const task of askedAbout(input.liveTasks)) {
    questions[task.taskId] = {
      type: "choice",
      instructions: {
        question:
          "How does new_task relate to other_task? Both are changes that different agents are making to the same code repository at the same time.",
        other_task: { goal: task.goal, paths: task.paths },
      },
      criteria: {
        independent: "The two tasks do not affect each other.",
        duplicate: "Both tasks implement the same change.",
        coupled: "One task relies on code or behaviour that the other task is changing.",
      },
    };
  }
  return { model: "clef-flash", state: { new_task: input.newTask }, questions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function answersOf(response: unknown): Record<string, unknown> {
  if (!isRecord(response) || !isRecord(response.answers)) {
    throw new DeciderError("the decision model returned no answers");
  }
  return response.answers;
}

function probability(value: unknown, what: string): number {
  if (typeof value !== "number" || !(value >= 0 && value <= 1)) {
    throw new DeciderError(`the decision model returned an invalid ${what}`);
  }
  return value;
}

export function readRelatedAnswers(liveTasks: LiveTask[], response: unknown): RelatedAnswer[] {
  const answers = answersOf(response);
  return askedAbout(liveTasks).map((task) => {
    const answer = answers[task.taskId];
    if (!isRecord(answer) || !RELATIONS.includes(answer.choice as (typeof RELATIONS)[number])) {
      throw new DeciderError(`the decision model returned no valid answer for task ${task.taskId}`);
    }
    const relation = answer.choice as RelatedAnswer["relation"];
    // The probability of the chosen relation. The model's own `confidence` is not used: it says how
    // concentrated the answer is over all the options, and is low even for a clear two-to-one answer.
    const probabilities = isRecord(answer.probabilities) ? answer.probabilities : {};
    return {
      taskId: task.taskId,
      relation,
      confidence: probability(probabilities[relation], `probability for task ${task.taskId}`),
    };
  });
}

// A task is reported as related when the model did not pick "independent" and is confident enough.
export function selectRelated(
  answers: RelatedAnswer[],
  minConfidence: number,
): { taskId: string; relation: Relation; confidence: number }[] {
  const related: { taskId: string; relation: Relation; confidence: number }[] = [];
  for (const answer of answers) {
    if (answer.relation !== "independent" && answer.confidence >= minConfidence) {
      related.push({ taskId: answer.taskId, relation: answer.relation, confidence: answer.confidence });
    }
  }
  return related;
}

const GOAL_FIT_LEVELS = [
  "The diff does not address the stated goal.",
  "The diff partly addresses the stated goal.",
  "The diff addresses the stated goal but leaves gaps.",
  "The diff fully addresses the stated goal.",
];

const RISK_LEVELS = [
  "Cosmetic: comments, documentation or formatting only.",
  "Low: logic local to one module, with limited reach.",
  "Medium: shared logic or data handling that other code depends on.",
  "High: security, authentication, data loss or effects that cannot be undone.",
];

export function triageRequest(input: TriageInput): DeciderRequest {
  return {
    model: "clef",
    state: {
      goal: input.goal,
      claim: input.claim,
      summary: input.summary,
      files: input.files,
      related_tasks: input.related,
    },
    questions: {
      goal_fit: {
        type: "score",
        instructions: "How well do the diffs in `files` accomplish the stated `goal`?",
        criteria: GOAL_FIT_LEVELS,
      },
      risk: {
        type: "score",
        instructions: "How risky is the change shown in the diffs in `files`?",
        criteria: RISK_LEVELS,
      },
      unrelated_changes: {
        type: "noul",
        instructions: "Do the diffs in `files` contain changes that are unrelated to the stated `goal`?",
      },
      // Worded around names, parameters and result shapes on purpose. Asked whether "behaviour"
      // changes, the model answers yes for any bug fix inside an exported function.
      interface_change: {
        type: "noul",
        instructions:
          "Do the diffs in `files` change the name, the parameters, the return type or the response shape of an existing exported function, type, route or schema?",
        criteria: {
          true: "An existing exported declaration is removed or renamed, or its parameters, return type or response shape differ after the change.",
          false:
            "Only new declarations are added, or existing ones keep their name, parameters, return type and response shape, even if what they compute is corrected.",
        },
      },
      leftovers: {
        type: "noul",
        instructions:
          "Do the diffs in `files` contain debug output, commented-out code, placeholder TODO notes or credentials?",
      },
    },
  };
}

function scoreAnswer(answers: Record<string, unknown>, id: string, levels: number): { score: number; confidence: number } {
  const answer = answers[id];
  if (!isRecord(answer) || typeof answer.score !== "number" || !(answer.score >= 0 && answer.score <= levels - 1)) {
    throw new DeciderError(`the decision model returned no valid score for ${id}`);
  }
  return { score: answer.score, confidence: probability(answer.confidence, `confidence for ${id}`) };
}

// The probability the model gives to the highest level of a score question.
function topLevelProbability(answers: Record<string, unknown>, id: string, levels: number): number {
  const answer = answers[id];
  const probabilities = isRecord(answer) && isRecord(answer.probabilities) ? answer.probabilities : {};
  return probability(probabilities[String(levels - 1)], `probability of the highest level of ${id}`);
}

function noulAnswer(answers: Record<string, unknown>, id: string): number {
  const answer = answers[id];
  if (!isRecord(answer)) {
    throw new DeciderError(`the decision model returned no answer for ${id}`);
  }
  return probability(answer.noul, `probability for ${id}`);
}

export function readTriage(model: string, response: unknown): Triage {
  const answers = answersOf(response);
  return {
    model,
    goal_fit: scoreAnswer(answers, "goal_fit", GOAL_FIT_LEVELS.length),
    risk: { ...scoreAnswer(answers, "risk", RISK_LEVELS.length), high: topLevelProbability(answers, "risk", RISK_LEVELS.length) },
    unrelated_changes: noulAnswer(answers, "unrelated_changes"),
    interface_change: noulAnswer(answers, "interface_change"),
    leftovers: noulAnswer(answers, "leftovers"),
  };
}

export interface DeciderTimeouts {
  relatedTimeoutMs: number;
  triageTimeoutMs: number;
}

const DEFAULT_TIMEOUTS: DeciderTimeouts = { relatedTimeoutMs: 2000, triageTimeoutMs: 5000 };
const TRIAGE_ATTEMPTS = 2;

export class WorkersAiDecider implements Decider {
  private readonly timeouts: DeciderTimeouts;

  constructor(
    private readonly run: AiRun,
    timeouts: Partial<DeciderTimeouts> = {},
  ) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
  }

  private async ask(request: DeciderRequest, timeoutMs: number): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // Reject first, so the race reports the timeout and not the abort it causes.
        reject(new DeciderError(`the decision model timed out after ${timeoutMs} ms`));
        controller.abort();
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.run(`@cf/cloudflare/${request.model}`, request, { signal: controller.signal }),
        timeout,
      ]);
    } catch (error) {
      throw error instanceof DeciderError ? error : new DeciderError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  // One attempt only: an agent is waiting on start_task while this runs.
  async relatedWork(input: RelatedWorkInput): Promise<RelatedAnswer[]> {
    if (input.liveTasks.length === 0) {
      return [];
    }
    const response = await this.ask(relatedWorkRequest(input), this.timeouts.relatedTimeoutMs);
    return readRelatedAnswers(input.liveTasks, response);
  }

  async triage(input: TriageInput): Promise<Triage> {
    const request = triageRequest(input);
    let lastError: unknown;
    for (let attempt = 1; attempt <= TRIAGE_ATTEMPTS; attempt++) {
      try {
        return readTriage(request.model, await this.ask(request, this.timeouts.triageTimeoutMs));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}
