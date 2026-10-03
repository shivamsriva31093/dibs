import { describe, expect, it } from "vitest";
import {
  DeciderError,
  readRelatedAnswers,
  readTriage,
  relatedWorkRequest,
  selectRelated,
  triageRequest,
  WorkersAiDecider,
  type AiRun,
  type TriageInput,
} from "../../src/decider";
import type { LiveTask } from "../../src/types";

const liveTasks: LiveTask[] = [
  {
    taskId: "t-aaaaaaaa",
    agent: "agent-one",
    goal: "Add GET /users/:id",
    state: "active",
    paths: ["src/routes/users/"],
    scope: [],
    startedAt: 1,
  },
  {
    taskId: "t-bbbbbbbb",
    agent: "agent-two",
    goal: "Add rate limiting",
    state: "in_review",
    paths: ["src/middleware/"],
    scope: [],
    startedAt: 2,
  },
];

const newTask = { goal: "Change findUser to return a result object", paths: ["src/db/users.ts"] };

describe("relatedWorkRequest", () => {
  it("asks one self-contained choice question per live task, keyed by its task id", () => {
    const request = relatedWorkRequest({ newTask, liveTasks });

    expect(request.model).toBe("clef-flash");
    expect(request.state).toEqual({ new_task: newTask });
    expect(Object.keys(request.questions)).toEqual(["t-aaaaaaaa", "t-bbbbbbbb"]);
    expect(request.questions["t-aaaaaaaa"]).toEqual({
      type: "choice",
      instructions: {
        question:
          "How does new_task relate to other_task? Both are changes that different agents are making to the same code repository at the same time.",
        other_task: { goal: "Add GET /users/:id", paths: ["src/routes/users/"] },
      },
      criteria: {
        independent: "The two tasks do not affect each other.",
        duplicate: "Both tasks implement the same change.",
        coupled: "One task relies on code or behaviour that the other task is changing.",
      },
    });
  });

  it("asks about at most the 64 most recently started tasks, the limit of one request", () => {
    const many: LiveTask[] = Array.from({ length: 70 }, (_, index) => ({
      taskId: `t-${String(index).padStart(8, "0")}`,
      agent: "a",
      goal: "g",
      state: "active",
      paths: [`f${index}.ts`],
      scope: [],
      startedAt: index,
    }));

    const ids = Object.keys(relatedWorkRequest({ newTask, liveTasks: many }).questions);

    expect(ids).toHaveLength(64);
    expect(ids[0]).toBe("t-00000006");
    expect(ids[63]).toBe("t-00000069");
  });
});

describe("readRelatedAnswers", () => {
  // Answers as clef-flash gave them for these two tasks on 2026-10-02.
  const response = {
    model: "clef-flash",
    answers: {
      "t-aaaaaaaa": {
        type: "choice",
        choice: "coupled",
        probabilities: { independent: 0.308, duplicate: 0.04, coupled: 0.652 },
        confidence: 0.282,
      },
      "t-bbbbbbbb": {
        type: "choice",
        choice: "independent",
        probabilities: { independent: 0.984, duplicate: 0.003, coupled: 0.013 },
        confidence: 0.954,
      },
    },
    usage: { input_tokens: 300, output_tokens: 12 },
  };

  // Clef's own "confidence" says how concentrated the answer is across all options: 0.28 for an
  // answer that is 65% "coupled". The number that means something to a reader is that 65%.
  it("reads the chosen relation and the probability the model gives it, for each task", () => {
    expect(readRelatedAnswers(liveTasks, response)).toEqual([
      { taskId: "t-aaaaaaaa", relation: "coupled", confidence: 0.652 },
      { taskId: "t-bbbbbbbb", relation: "independent", confidence: 0.984 },
    ]);
  });

  it.each([
    ["no answers at all", { model: "clef-flash" }],
    ["an answer missing for a task", { answers: { "t-aaaaaaaa": response.answers["t-aaaaaaaa"] } }],
    [
      "a choice that was not offered",
      { answers: { ...response.answers, "t-bbbbbbbb": { type: "choice", choice: "maybe", probabilities: { maybe: 0.9 } } } },
    ],
    [
      "no probability for the chosen relation",
      { answers: { ...response.answers, "t-bbbbbbbb": { type: "choice", choice: "coupled", probabilities: { independent: 0.2 } } } },
    ],
    [
      "a probability that is not one",
      { answers: { ...response.answers, "t-bbbbbbbb": { type: "choice", choice: "coupled", probabilities: { coupled: 7 } } } },
    ],
  ])("refuses a response with %s", (_label, malformed) => {
    expect(() => readRelatedAnswers(liveTasks, malformed)).toThrow(DeciderError);
  });
});

describe("selectRelated", () => {
  it.each([
    ["a coupled task at the minimum probability", { relation: "coupled" as const, confidence: 0.5 }, true],
    ["a coupled task just below the minimum", { relation: "coupled" as const, confidence: 0.49 }, false],
    ["a duplicate task well above the minimum", { relation: "duplicate" as const, confidence: 0.9 }, true],
    ["an independent task, however likely", { relation: "independent" as const, confidence: 0.99 }, false],
  ])("for %s", (_label, answer, reported) => {
    const selected = selectRelated([{ taskId: "t-aaaaaaaa", ...answer }], 0.5);

    expect(selected).toEqual(reported ? [{ taskId: "t-aaaaaaaa", ...answer }] : []);
  });
});

const triageInput: TriageInput = {
  goal: "Change findUser to return a result object",
  claim: ["src/db/users.ts"],
  summary: "findUser now returns { ok, user }",
  files: [{ path: "src/db/users.ts", status: "modified", diff: "diff --git a/src/db/users.ts b/src/db/users.ts\n..." }],
  related: [{ agent: "agent-one", goal: "Add GET /users/:id", paths: ["src/routes/users/"], relation: "coupled" }],
};

describe("triageRequest", () => {
  it("sends the goal, claim, summary, diffs and related tasks as the state", () => {
    const request = triageRequest(triageInput);

    expect(request.model).toBe("clef");
    expect(request.state).toEqual({
      goal: triageInput.goal,
      claim: triageInput.claim,
      summary: triageInput.summary,
      files: triageInput.files,
      related_tasks: triageInput.related,
    });
  });

  it("asks the five triage questions with their types and levels", () => {
    const { questions } = triageRequest(triageInput);

    expect(Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, question.type]))).toEqual({
      goal_fit: "score",
      risk: "score",
      unrelated_changes: "noul",
      interface_change: "noul",
      leftovers: "noul",
    });
    expect(questions.goal_fit).toMatchObject({ criteria: expect.any(Array) });
    expect((questions.goal_fit as { criteria: string[] }).criteria).toHaveLength(4);
    expect((questions.risk as { criteria: string[] }).criteria).toHaveLength(4);
    // Level 0 is the lowest: a model that scores risk 3 must mean "high".
    expect((questions.risk as { criteria: string[] }).criteria[0]).toMatch(/cosmetic/i);
    expect((questions.risk as { criteria: string[] }).criteria[3]).toMatch(/high/i);
    expect((questions.goal_fit as { criteria: string[] }).criteria[3]).toMatch(/fully/i);
  });

  // Asked about "the signature or the behaviour", Clef called a bug fix inside a function an
  // interface change (0.77). Asked about names, parameters and result shapes, it does not (0.03).
  it("asks whether a signature or a result shape changed, not whether behaviour did", () => {
    const question = triageRequest(triageInput).questions.interface_change as { instructions: string; criteria: { false: string } };

    expect(question.instructions).toMatch(/the name, the parameters, the return type or the response shape/);
    expect(question.instructions).not.toMatch(/behaviour/);
    expect(question.criteria.false).toMatch(/corrected/);
  });
});

// An answer as clef gave it for a change to a function's return type on 2026-10-02.
const triageResponse = {
  model: "clef",
  answers: {
    goal_fit: { type: "score", score: 2.72, legend: {}, probabilities: { "0": 0.026, "1": 0.048, "2": 0.104, "3": 0.822 }, confidence: 0.585 },
    risk: { type: "score", score: 1.68, legend: {}, probabilities: { "0": 0.024, "1": 0.31, "2": 0.628, "3": 0.039 }, confidence: 0.323 },
    unrelated_changes: { type: "noul", noul: 0.017 },
    interface_change: { type: "noul", noul: 0.969 },
    leftovers: { type: "noul", noul: 0.012 },
  },
  usage: { input_tokens: 2000, output_tokens: 20 },
};

describe("readTriage", () => {
  it("reads the five answers into a triage, with the probability that the risk is high", () => {
    expect(readTriage("clef", triageResponse)).toEqual({
      model: "clef",
      goal_fit: { score: 2.72, confidence: 0.585 },
      risk: { score: 1.68, confidence: 0.323, high: 0.039 },
      unrelated_changes: 0.017,
      interface_change: 0.969,
      leftovers: 0.012,
    });
  });

  it.each([
    ["a missing answer", { answers: { ...triageResponse.answers, leftovers: undefined } }],
    ["a score outside the scale", { answers: { ...triageResponse.answers, risk: { ...triageResponse.answers.risk, score: 9 } } }],
    ["a probability above 1", { answers: { ...triageResponse.answers, leftovers: { type: "noul", noul: 1.5 } } }],
    ["a score without a confidence", { answers: { ...triageResponse.answers, risk: { type: "score", score: 1, probabilities: { "3": 0.1 } } } }],
    [
      "a risk answer without a probability for its highest level",
      { answers: { ...triageResponse.answers, risk: { type: "score", score: 1, confidence: 0.5, probabilities: { "1": 1 } } } },
    ],
    ["a response that is not an object", "error"],
  ])("refuses %s", (_label, malformed) => {
    expect(() => readTriage("clef", malformed)).toThrow(DeciderError);
  });
});

describe("WorkersAiDecider", () => {
  function recording(responses: (Record<string, unknown> | Error)[]): { run: AiRun; calls: { model: string; inputs: Record<string, unknown> }[] } {
    const calls: { model: string; inputs: Record<string, unknown> }[] = [];
    const run: AiRun = async (model, inputs) => {
      calls.push({ model, inputs });
      const next = responses.shift();
      if (next === undefined) {
        throw new Error("no more responses");
      }
      if (next instanceof Error) {
        throw next;
      }
      return next;
    };
    return { run, calls };
  }

  it("asks the flash model about related work and returns its answers", async () => {
    const { run, calls } = recording([
      {
        answers: {
          "t-aaaaaaaa": { type: "choice", choice: "coupled", probabilities: { independent: 0.3, coupled: 0.7 }, confidence: 0.3 },
          "t-bbbbbbbb": { type: "choice", choice: "independent", probabilities: { independent: 0.98, coupled: 0.02 }, confidence: 0.95 },
        },
      },
    ]);

    const answers = await new WorkersAiDecider(run).relatedWork({ newTask, liveTasks });

    expect(answers).toEqual([
      { taskId: "t-aaaaaaaa", relation: "coupled", confidence: 0.7 },
      { taskId: "t-bbbbbbbb", relation: "independent", confidence: 0.98 },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe("@cf/cloudflare/clef-flash");
    expect(calls[0]?.inputs).toEqual(relatedWorkRequest({ newTask, liveTasks }));
  });

  it("does not call the model when there are no other live tasks", async () => {
    const { run, calls } = recording([]);

    expect(await new WorkersAiDecider(run).relatedWork({ newTask, liveTasks: [] })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("does not retry a failed related-work check, which runs while an agent waits", async () => {
    const { run, calls } = recording([new Error("503 from Workers AI"), { answers: {} }]);

    await expect(new WorkersAiDecider(run).relatedWork({ newTask, liveTasks })).rejects.toThrow(/503 from Workers AI/);
    expect(calls).toHaveLength(1);
  });

  it("asks the larger model for the triage", async () => {
    const { run, calls } = recording([triageResponse]);

    const triage = await new WorkersAiDecider(run).triage(triageInput);

    expect(triage.interface_change).toBe(0.969);
    expect(calls[0]?.model).toBe("@cf/cloudflare/clef");
    expect(calls[0]?.inputs).toEqual(triageRequest(triageInput));
  });

  it("tries the triage once more after a failure", async () => {
    const { run, calls } = recording([new Error("temporary"), triageResponse]);

    const triage = await new WorkersAiDecider(run).triage(triageInput);

    expect(triage.model).toBe("clef");
    expect(calls).toHaveLength(2);
  });

  it("gives up on the triage after the second failure", async () => {
    const { run, calls } = recording([new Error("first"), new Error("second"), triageResponse]);

    await expect(new WorkersAiDecider(run).triage(triageInput)).rejects.toThrow(DeciderError);
    expect(calls).toHaveLength(2);
  });

  it("fails with a timeout when the model does not answer in time, and aborts the call", async () => {
    let aborted = false;
    const never: AiRun = (_model, _inputs, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });

    await expect(
      new WorkersAiDecider(never, { relatedTimeoutMs: 20, triageTimeoutMs: 20 }).relatedWork({ newTask, liveTasks }),
    ).rejects.toThrow(/timed out after 20 ms/);
    expect(aborted).toBe(true);
  });
});
