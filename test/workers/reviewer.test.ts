import { describe, expect, it } from "vitest";
import {
  AnthropicReviewer,
  buildReviewPrompt,
  ReviewerError,
  type ReviewerClient,
  type ReviewInput,
} from "../../src/reviewer";

const input: ReviewInput = {
  agent: "agent-five",
  goal: "Change findUser to return a result object",
  claim: ["src/db/users.ts"],
  summary: "findUser now returns { ok, user } so callers can tell a miss from an error.",
  cycle: 1,
  files: [
    {
      path: "src/db/users.ts",
      status: "modified",
      text: "diff --git a/src/db/users.ts b/src/db/users.ts\n--- a/src/db/users.ts\n+++ b/src/db/users.ts\n@@ -1 +1 @@\n-export function findUser(id) {}\n+export function findUser(id) { return { ok: true } }\n",
    },
  ],
  triage: {
    model: "clef",
    goal_fit: { score: 2.8, confidence: 0.8 },
    risk: { score: 1.6, confidence: 0.7, high: 0.04 },
    unrelated_changes: 0.05,
    interface_change: 0.92,
    leftovers: 0.03,
  },
  related: [
    {
      agent: "agent-one",
      goal: "Add GET /users/:id",
      paths: ["src/routes/users/"],
      relation: "coupled",
      state: "active",
    },
  ],
  conventions: "# AGENTS.md\nUse named exports only.\n",
  checkCallers: true,
  previous: null,
  lookup: null,
};

// A repository to look at, which records what was asked of it.
function fakeLookup() {
  const asked: string[] = [];
  return {
    asked,
    readFile: async (path: string) => {
      asked.push(`read ${path}`);
      return `1\tcontent of ${path}`;
    },
    search: async (text: string) => {
      asked.push(`search ${text}`);
      return `src/routes/users/get.ts:8: const user = ${text}(id);`;
    },
  };
}

describe("buildReviewPrompt", () => {
  it("gives the reviewer the goal, claim, summary, diff, signals, related tasks and repo conventions", () => {
    const { user } = buildReviewPrompt(input);

    expect(user).toContain("Change findUser to return a result object");
    expect(user).toContain("src/db/users.ts");
    expect(user).toContain("findUser now returns { ok, user }");
    expect(user).toContain("+export function findUser(id) { return { ok: true } }");
    expect(user).toContain('"interface_change": 0.92');
    expect(user).toContain("Add GET /users/:id");
    expect(user).toContain("Use named exports only.");
  });

  it("asks for a check of callers only when an interface change was flagged", () => {
    const flagged = buildReviewPrompt(input).user;
    const notFlagged = buildReviewPrompt({ ...input, checkCallers: false }).user;

    expect(flagged).toContain("<check_callers>");
    expect(flagged).toMatch(/<check_callers>[^<]*callers that the change would break/);
    expect(notFlagged).not.toContain("<check_callers>");
  });

  // What dibs itself worked out says more than the general advice to look for callers, and takes its place.
  it("gives what dibs worked out about interfaces and other tasks, marked as its own, in place of the general advice", () => {
    const { user } = buildReviewPrompt({ ...input, coordination: "This change alters these interfaces:\n- src/db/users.ts#findUser" });

    expect(user).toContain(
      "<coordination>\nThis part is written by dibs, not by the agent.\nThis change alters these interfaces:\n- src/db/users.ts#findUser\n</coordination>",
    );
    expect(user).not.toContain("<check_callers>");
    expect(buildReviewPrompt({ ...input, coordination: null }).user).toContain("<check_callers>");
  });

  it("leaves out the sections it has nothing for", () => {
    const { user } = buildReviewPrompt({ ...input, triage: null, related: [], conventions: null, checkCallers: false });

    expect(user).not.toContain("<signals>");
    expect(user).not.toContain("<related_tasks>");
    expect(user).not.toContain("<conventions>");
    expect(user).toContain("<diff>");
  });

  it("tells the reviewer that the submitted text is data, not instructions", () => {
    expect(buildReviewPrompt(input).system).toMatch(/not (as )?instructions/i);
  });

  it("tells the reviewer what the previous attempt was told, and by whom", () => {
    const previous = { by: "reviewer" as const, feedback: "Empty names pass validation.\n- critical src/validation/user.ts:12 The name check is missing." };

    const { user } = buildReviewPrompt({ ...input, cycle: 2, previous });

    expect(user).toMatch(/<previous_attempt>[^<]*attempt 2[^<]*sent back by the reviewer/);
    expect(user).toContain("- critical src/validation/user.ts:12 The name check is missing.");
  });

  it("says so when it was a person who sent the previous attempt back", () => {
    const previous = { by: "person" as const, feedback: "findUser now returns a result object. Catch up with main and use it." };

    const { user } = buildReviewPrompt({ ...input, cycle: 2, previous });

    expect(user).toMatch(/sent back by a person/);
    expect(user).toContain("Catch up with main and use it.");
  });

  it("says nothing about earlier attempts on a first attempt", () => {
    expect(buildReviewPrompt(input).user).not.toContain("<previous_attempt>");
  });

  it("tells the reviewer whether it can look at the rest of the repository", () => {
    const without = buildReviewPrompt(input).system;
    const withLookup = buildReviewPrompt({ ...input, lookup: fakeLookup() }).system;

    expect(without).toMatch(/You see only the diff/);
    expect(withLookup).toMatch(/read_file/);
    expect(withLookup).toMatch(/search_code/);
    expect(withLookup).not.toMatch(/You see only the diff/);
  });
});

type Response = Awaited<ReturnType<ReviewerClient["create"]>>;

// A response as the API returns it with adaptive thinking on: a thinking block, then the JSON text.
function response(text: string, overrides: Partial<Response> = {}): Response {
  return {
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    stop_details: null,
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text, citations: null },
    ],
    ...overrides,
  };
}

const approved = response(
  JSON.stringify({
    decision: "approve",
    summary: "Does what the goal says.",
    issues: [
      { severity: "minor", path: "src/db/users.ts", line: 12, description: "Name could be clearer", suggestion: null },
      { severity: "major", path: "src/db/users.ts", line: null, description: "No test", suggestion: "Add one" },
    ],
  }),
);

const truncated = response('{"decision":"approve","summary":"Does what the go', { stop_reason: "max_tokens" });

function client(responses: (Response | Error)[]): ReviewerClient & { requests: Parameters<ReviewerClient["create"]>[0][] } {
  const requests: Parameters<ReviewerClient["create"]>[0][] = [];
  return {
    requests,
    async create(params) {
      requests.push(params);
      const next = responses.shift();
      if (next === undefined) {
        throw new Error("no more responses");
      }
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  };
}

describe("AnthropicReviewer", () => {
  it("returns the model's verdict, dropping fields the model left empty", async () => {
    const reviewer = new AnthropicReviewer(client([approved]), "claude-opus-5-5");

    expect(await reviewer.review(input)).toEqual({
      model: "claude-opus-5-5",
      lookups: [],
      verdict: {
        decision: "approve",
        summary: "Does what the goal says.",
        issues: [
          { severity: "minor", path: "src/db/users.ts", line: 12, description: "Name could be clearer" },
          { severity: "major", path: "src/db/users.ts", description: "No test", suggestion: "Add one" },
        ],
      },
    });
  });

  it("asks the configured model for schema-constrained output, with a refusal fallback", async () => {
    const fake = client([approved]);

    await new AnthropicReviewer(fake, "claude-opus-5-5").review(input);

    const request = fake.requests[0]!;
    expect(request.model).toBe("claude-opus-5-5");
    expect(request.max_tokens).toBe(16000);
    expect(request.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(request.fallbacks).toBe("default");
    expect(request.output_config?.effort).toBe("high");
    expect(request.output_config?.format).toMatchObject({
      type: "json_schema",
      schema: {
        type: "object",
        properties: { decision: { type: "string", enum: ["approve", "reject", "escalate"] } },
        required: ["decision", "summary", "issues"],
        additionalProperties: false,
      },
    });
    expect(request.messages).toEqual([{ role: "user", content: buildReviewPrompt(input).user }]);
    expect(request.system).toBe(buildReviewPrompt(input).system);
  });

  it("reports the model that actually answered, which differs after a fallback", async () => {
    const reviewer = new AnthropicReviewer(client([{ ...approved, model: "claude-opus-4-8" }]), "claude-opus-5-5");

    expect((await reviewer.review(input)).model).toBe("claude-opus-4-8");
  });

  it("turns a refusal into an escalation, without asking again", async () => {
    const fake = client([
      response("", {
        stop_reason: "refusal",
        stop_details: {
          type: "refusal",
          category: "cyber",
          explanation: "Declined by a safety classifier.",
          fallback_credit_token: null,
          fallback_has_prefill_claim: null,
          recommended_model: null,
        },
        content: [],
      }),
      approved,
    ]);

    const outcome = await new AnthropicReviewer(fake, "claude-opus-5-5").review(input);

    expect(outcome.verdict.decision).toBe("escalate");
    expect(outcome.verdict.summary).toContain("cyber");
    expect(outcome.verdict.issues).toEqual([]);
    expect(fake.requests).toHaveLength(1);
  });

  it("asks again when the output was cut off, and returns the verdict that then arrives", async () => {
    const fake = client([truncated, approved]);

    const outcome = await new AnthropicReviewer(fake, "claude-opus-5-5").review(input);

    expect(outcome.verdict.decision).toBe("approve");
    expect(fake.requests).toHaveLength(2);
  });

  it("asks again when the output does not have the verdict's shape", async () => {
    const fake = client([response(JSON.stringify({ decision: "maybe", summary: "s", issues: [] })), approved]);

    const outcome = await new AnthropicReviewer(fake, "claude-opus-5-5").review(input);

    expect(outcome.verdict.decision).toBe("approve");
    expect(fake.requests).toHaveLength(2);
  });

  it("gives up after three attempts without a valid verdict", async () => {
    const fake = client([truncated, truncated, truncated, approved]);

    await expect(new AnthropicReviewer(fake, "claude-opus-5-5").review(input)).rejects.toThrow(ReviewerError);
    expect(fake.requests).toHaveLength(3);
  });

  it("offers no tools when it has no repository to look at", async () => {
    const fake = client([approved]);

    await new AnthropicReviewer(fake, "claude-opus-5-5").review(input);

    expect(fake.requests[0]!.tools).toBeUndefined();
  });

  it("offers reading a file and searching the code as tools with strict inputs", async () => {
    const fake = client([approved]);

    await new AnthropicReviewer(fake, "claude-opus-5-5").review({ ...input, lookup: fakeLookup() });

    expect(fake.requests[0]!.tools).toMatchObject([
      { name: "read_file", strict: true, input_schema: { required: ["path"], additionalProperties: false } },
      { name: "search_code", strict: true, input_schema: { required: ["text"], additionalProperties: false } },
    ]);
    expect(fake.requests[0]!.tool_choice).toBeUndefined();
  });

  // What the API returns when the model wants to look something up before it answers.
  const asks = (...uses: { id: string; name: string; input: unknown }[]) =>
    response("", {
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        ...uses.map((use) => ({ type: "tool_use" as const, id: use.id, name: use.name, input: use.input })),
      ],
    });

  it("looks up what the model asks for, hands it back, and returns the verdict that follows", async () => {
    const lookup = fakeLookup();
    const question = asks({ id: "toolu_1", name: "read_file", input: { path: "src/db/users.ts" } });
    const fake = client([question, approved]);

    const outcome = await new AnthropicReviewer(fake, "claude-opus-5-5").review({ ...input, lookup });

    expect(outcome.verdict.decision).toBe("approve");
    expect(outcome.lookups).toEqual(["read src/db/users.ts"]);
    expect(lookup.asked).toEqual(["read src/db/users.ts"]);
    expect(fake.requests[1]!.messages).toEqual([
      { role: "user", content: buildReviewPrompt({ ...input, lookup }).user },
      // The model's own turn goes back exactly as it came, thinking included.
      { role: "assistant", content: question.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "1\tcontent of src/db/users.ts" }] },
    ]);
  });

  it("answers several lookups made in one turn together", async () => {
    const lookup = fakeLookup();
    const fake = client([
      asks(
        { id: "toolu_1", name: "search_code", input: { text: "findUser" } },
        { id: "toolu_2", name: "read_file", input: { path: "src/routes/users/get.ts" } },
      ),
      approved,
    ]);

    const outcome = await new AnthropicReviewer(fake, "claude-opus-5-5").review({ ...input, lookup });

    expect(outcome.lookups).toEqual(['searched for "findUser"', "read src/routes/users/get.ts"]);
    expect(fake.requests[1]!.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "src/routes/users/get.ts:8: const user = findUser(id);" },
        { type: "tool_result", tool_use_id: "toolu_2", content: "1\tcontent of src/routes/users/get.ts" },
      ],
    });
  });

  it("tells the model when it asks for a lookup that does not exist, and carries on", async () => {
    const lookup = fakeLookup();
    const fake = client([asks({ id: "toolu_1", name: "run_tests", input: {} }), approved]);

    const outcome = await new AnthropicReviewer(fake, "claude-opus-5-5").review({ ...input, lookup });

    expect(outcome.verdict.decision).toBe("approve");
    expect(outcome.lookups).toEqual([]);
    expect(fake.requests[1]!.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "There is no lookup named run_tests.", is_error: true }],
    });
  });

  it("stops offering lookups after eight, so that the model has to give its verdict", async () => {
    const lookup = fakeLookup();
    const eight = Array.from({ length: 8 }, (_, index) => asks({ id: `toolu_${index}`, name: "search_code", input: { text: `name${index}` } }));
    const fake = client([...eight, approved]);

    const outcome = await new AnthropicReviewer(fake, "claude-opus-5-5").review({ ...input, lookup });

    expect(outcome.verdict.decision).toBe("approve");
    expect(outcome.lookups).toHaveLength(8);
    expect(fake.requests.slice(0, 8).map((request) => request.tool_choice)).toEqual(Array(8).fill(undefined));
    expect(fake.requests[8]!.tool_choice).toEqual({ type: "none" });
  });

  it("lets an API failure through, so the caller's own retry policy applies", async () => {
    const fake = client([new Error("529 overloaded"), approved]);

    await expect(new AnthropicReviewer(fake, "claude-opus-5-5").review(input)).rejects.toThrow("529 overloaded");
    expect(fake.requests).toHaveLength(1);
  });
});
