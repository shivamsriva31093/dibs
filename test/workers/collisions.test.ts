import { describe, expect, it } from "vitest";
import { describeCollision, landingOrder, type Party } from "../../src/collisions";

const party = (agent: string, over: Partial<Party> = {}): Party => ({
  taskId: `t-${agent}`,
  agent,
  goal: `${agent}'s goal`,
  state: "active",
  submittedAt: null,
  mergeSha: null,
  ...over,
});

describe("landingOrder", () => {
  it("puts the task that changes the interface first when neither has submitted", () => {
    expect(landingOrder(party("five"), party("one"))).toEqual({
      first: "provider",
      why: "neither task has submitted, and the one that changes the interface goes first so that the other can be written against it",
    });
  });

  it("puts the task that has submitted before the one still being worked on", () => {
    expect(landingOrder(party("five"), party("one", { state: "in_review", submittedAt: 10 }))).toMatchObject({ first: "relier" });
    expect(landingOrder(party("five", { state: "escalated", submittedAt: 10 }), party("one"))).toMatchObject({ first: "provider" });
  });

  it("puts the earlier submission first when both have submitted", () => {
    const provider = party("five", { state: "in_review", submittedAt: 20 });
    const relier = party("one", { state: "in_review", submittedAt: 10 });

    expect(landingOrder(provider, relier)).toEqual({ first: "relier", why: "both are in review, and it submitted first" });
    expect(landingOrder({ ...provider, submittedAt: 5 }, relier)).toMatchObject({ first: "provider" });
  });

  it("puts a task that has landed first", () => {
    const landed = { state: "merged" as const, mergeSha: "a".repeat(40), submittedAt: 5 };

    expect(landingOrder(party("five", landed), party("one", { state: "in_review", submittedAt: 1 }))).toEqual({
      first: "provider",
      why: "it has landed",
    });
    expect(landingOrder(party("five"), party("one", landed))).toEqual({ first: "relier", why: "it has landed" });
  });
});

describe("describeCollision", () => {
  const TARGETS = ["src/db/users.ts#findUser"];
  const brief = (input: Parameters<typeof describeCollision>[0]) => describeCollision(input).brief;

  it("tells a task that relies on a file another task holds that there is nothing to do yet", () => {
    const described = describeCollision({ kind: "contract", state: "possible", role: "relier", me: party("one"), other: party("five"), targets: TARGETS });

    expect(described.order).toBeNull();
    expect(described.brief).toBe(
      "five holds code that your work uses (src/db/users.ts#findUser) and has not said that it will change it. There is nothing to do; you will be told if that changes.",
    );
  });

  it("tells the task that holds the file to say so if it changes what the other uses", () => {
    expect(brief({ kind: "contract", state: "possible", role: "provider", me: party("five"), other: party("one"), targets: TARGETS })).toBe(
      "one's work uses src/db/users.ts#findUser, which is in code you hold. If you change its name, parameters or result, say so with declare_interface_change. Otherwise there is nothing to do.",
    );
  });

  it("tells a relier that the interface is being changed, and what each order means", () => {
    const described = describeCollision({ kind: "contract", state: "open", role: "relier", me: party("one"), other: party("five"), targets: TARGETS });

    expect(described.order).toEqual({ first: "five", why: expect.stringContaining("neither task has submitted") });
    expect(described.brief).toBe(
      'five is changing src/db/users.ts#findUser, which your work uses. Its goal: "five\'s goal". Call peek to read its change. ' +
        "If it lands before you, your submission is sent back to catch up with the main branch and adapt. If you land first, it has to update your code. " +
        "To avoid doing the work twice, write against the new shape, or wait for it to land and call sync_with_main.",
    );
  });

  it("tells a provider that another task relies on what it changes", () => {
    expect(brief({ kind: "contract", state: "open", role: "provider", me: party("five"), other: party("one"), targets: TARGETS })).toBe(
      "one's work uses src/db/users.ts#findUser, which you are changing. If you land first, it adapts. If it lands first, the files it adds that use the interface become yours to update before you can land.",
    );
  });

  it("tells a relier to adapt once the change has landed", () => {
    const landed = party("five", { state: "merged", mergeSha: "abcdef0123456789abcdef0123456789abcdef01", submittedAt: 3 });

    const described = describeCollision({ kind: "contract", state: "open", role: "relier", me: party("one"), other: landed, targets: TARGETS });

    expect(described.order).toEqual({ first: "five", why: "it has landed" });
    expect(described.brief).toBe(
      "src/db/users.ts#findUser changed on the main branch when five's task landed (abcdef0). Call sync_with_main, change your code to fit, run the tests, and submit.",
    );
  });

  it("tells a provider to take over the code that landed before it", () => {
    const landed = party("one", { state: "merged", mergeSha: "1234567890123456789012345678901234567890", submittedAt: 3 });

    expect(brief({ kind: "contract", state: "open", role: "provider", me: party("five"), other: landed, targets: TARGETS })).toBe(
      "one's task landed code that uses src/db/users.ts#findUser (1234567). Call sync_with_main, add the files that use it to your scope with expand_scope, update them to the new shape, and submit.",
    );
  });

  it("names several targets, and cuts a long list short", () => {
    const targets = ["a.ts#a", "a.ts#b", "a.ts#c", "a.ts#d", "a.ts#e", "a.ts#f"];

    expect(brief({ kind: "contract", state: "possible", role: "relier", me: party("one"), other: party("five"), targets })).toContain(
      "(a.ts#a, a.ts#b, a.ts#c, a.ts#d and 2 more)",
    );
  });

  it("asks the later of two tasks doing the same work to say that it is different, or stop", () => {
    const described = describeCollision({ kind: "duplicate", state: "open", role: "relier", me: party("two"), other: party("one"), targets: [] });

    expect(described.order).toBeNull();
    expect(described.brief).toBe(
      'one started what looks like the same work before you: "one\'s goal". If yours is different, pass confirm_distinct: true to submit and say how it differs in the summary. If it is the same, call abandon.',
    );
  });

  it("only informs the earlier of two tasks doing the same work", () => {
    expect(brief({ kind: "duplicate", state: "open", role: "provider", me: party("one"), other: party("two"), targets: [] })).toBe(
      "two started what looks like the same work as yours, after you. There is nothing to do.",
    );
  });
});
