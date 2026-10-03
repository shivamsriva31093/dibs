import { describe, expect, it } from "vitest";
import { contractsBroken, coordinationFor, describeContract } from "../../src/contracts";
import type { CollisionView, ContractReport, InterfaceReport } from "../../src/types";

const WHOLE: ContractReport = { indexed: true, moved: [], unupdated: [], held: [], leaves: null };
const MOVED = { target: "src/db/users.ts#findUser", now: "export function findUser(id: string): Found", since: "abcdef0123456789abcdef0123456789abcdef01", by: "agent-five" };
const UNUPDATED = {
  target: "src/db/users.ts#findUser",
  change: "changed" as const,
  files: [
    { path: "src/routes/users/get.ts", heldBy: null },
    { path: "src/admin.ts", heldBy: "agent-two" },
  ],
};
const HELD = { target: "src/db/users.ts#findUser", by: "agent-one", taskId: "t-one" };

describe("contractsBroken", () => {
  it.each<[string, ContractReport, boolean]>([
    ["nothing is wrong", WHOLE, false],
    ["something it relies on has moved", { ...WHOLE, moved: [MOVED] }, true],
    ["it alters what another task holds", { ...WHOLE, held: [HELD] }, true],
    ["it leaves users of an interface as they were", { ...WHOLE, unupdated: [UNUPDATED] }, true],
    ["it leaves them and says why", { ...WHOLE, unupdated: [UNUPDATED], leaves: "they only read .ok" }, false],
    ["it says why but relies on something that moved", { ...WHOLE, moved: [MOVED], unupdated: [UNUPDATED], leaves: "x" }, true],
  ])("when %s -> %s", (_label, report, broken) => {
    expect(contractsBroken(report)).toBe(broken);
  });
});

describe("describeContract", () => {
  it("says what moved, who moved it, and what to do", () => {
    expect(describeContract({ ...WHOLE, moved: [MOVED] })).toBe(
      "Code your change relies on is not what it was when your fork branched off the main branch:\n" +
        "- src/db/users.ts#findUser, changed by agent-five in abcdef0. It is now: export function findUser(id: string): Found\n" +
        "Call sync_with_main, change your code to fit, run the tests, and submit again.",
    );
  });

  it("says when what was relied on is gone, or new, or changed by nobody it knows", () => {
    const text = describeContract({
      ...WHOLE,
      moved: [
        { target: "src/a.ts#gone", now: null, since: null, by: null },
        { target: "src/b.ts", now: null, since: "1234567890123456789012345678901234567890", by: null },
      ],
    });

    expect(text).toContain("- src/a.ts#gone. It is no longer there.");
    expect(text).toContain("- src/b.ts, changed in 1234567.");
  });

  it("lists the files that use an altered interface, and tells free ones from held ones", () => {
    expect(describeContract({ ...WHOLE, unupdated: [UNUPDATED] })).toBe(
      "Your change alters interfaces that files on the main branch use, and it does not change those files:\n" +
        "- src/db/users.ts#findUser is used by src/routes/users/get.ts, and by src/admin.ts (held by agent-two)\n" +
        "Call sync_with_main, add the files to your scope with expand_scope, update them to the new shape, and submit again. " +
        "A file that another task holds is yours to change only after that task ends: call expand_scope with wait_seconds to wait for it. " +
        "If the files need no change, say why in leaves_dependents when you submit, and a person decides.",
    );
  });

  it("says that a removed interface is still used", () => {
    expect(describeContract({ ...WHOLE, unupdated: [{ ...UNUPDATED, change: "removed", files: [UNUPDATED.files[0]!] }] })).toContain(
      "- src/db/users.ts#findUser is removed and still used by src/routes/users/get.ts\n",
    );
  });

  it("says which task holds an interface the change alters in a shared file", () => {
    expect(describeContract({ ...WHOLE, held: [HELD] })).toBe(
      "Your change alters an interface in a file you share with other tasks, and another task holds that interface:\n" +
        "- src/db/users.ts#findUser is held by agent-one\n" +
        "Leave it as it was, or wait for that task to end and submit again.",
    );
  });

  it("puts the parts one after another when several things are wrong", () => {
    const text = describeContract({ ...WHOLE, moved: [MOVED], unupdated: [UNUPDATED], held: [HELD] });

    expect(text.split("\n\n")).toHaveLength(3);
  });

  it("leaves out the files the agent has spoken for", () => {
    expect(describeContract({ ...WHOLE, unupdated: [UNUPDATED], leaves: "they only read .ok" })).toBe("");
  });
});

describe("coordinationFor", () => {
  const OLD = "export function findUser(id: string): User | null";
  const NEW = "export function findUser(id: string): Found";
  const REPORT: InterfaceReport = {
    changedPaths: ["src/db/users.ts", "test/users.test.ts"],
    changed: [
      { path: "src/db/users.ts", name: "findUser", kind: "function", change: "changed", before: OLD, after: NEW },
      { path: "src/db/users.ts", name: "createUser", kind: "function", change: "added", after: "export function createUser()" },
    ],
    relied: [],
  };
  const collision = (over: Partial<CollisionView>): CollisionView => ({
    id: "c-1",
    kind: "contract",
    state: "open",
    role: "provider",
    with: { taskId: "t-one", agent: "agent-one", goal: "Add GET /users/:id", state: "active", mergeSha: null },
    targets: ["src/db/users.ts#findUser"],
    order: null,
    brief: "",
    ...over,
  });

  it("has nothing to say about a change that alters no interface and meets no other task", () => {
    expect(coordinationFor({ ...REPORT, changed: [REPORT.changed[1]!] }, WHOLE, [])).toBeNull();
    expect(coordinationFor(null, null, [])).toBeNull();
  });

  it("names the interfaces the change alters, and says that every file that uses them is in the change", () => {
    expect(coordinationFor(REPORT, WHOLE, [])).toBe(
      "This change alters these interfaces:\n" +
        `- src/db/users.ts#findUser: \`${OLD}\` becomes \`${NEW}\`\n` +
        "Every file on the main branch that uses them is part of this change. Check that each one is updated to the new shape.",
    );
  });

  it("says that an interface is removed", () => {
    const removed: InterfaceReport = { ...REPORT, changed: [{ path: "src/a.ts", name: "old", kind: "function", change: "removed", before: "export function old()" }] };

    expect(coordinationFor(removed, WHOLE, [])).toContain("- src/a.ts#old is removed (it was `export function old()`)\n");
  });

  it("names the files that use an altered interface and are left as they were, with what the agent says about them", () => {
    const contracts = { ...WHOLE, unupdated: [UNUPDATED], leaves: "they only read .ok" };

    expect(coordinationFor(REPORT, contracts, [])).toContain(
      "These files on the main branch use them and are not part of this change: src/routes/users/get.ts, src/admin.ts. " +
        'The agent says they need no change: "they only read .ok". Read those files and say whether that holds. A person decides after you.',
    );
  });

  it("asks the reviewer to look for callers itself when the index cannot speak for the change", () => {
    expect(coordinationFor(REPORT, { ...WHOLE, indexed: false }, [])).toContain(
      "dibs could not work out which files use them. Look for callers that the change would break.",
    );
    expect(coordinationFor(REPORT, null, [])).toContain("dibs could not work out which files use them.");
  });

  it("tells the reviewer about the tasks this one meets, and not to hold the change back for them", () => {
    const text = coordinationFor(REPORT, WHOLE, [
      collision({}),
      collision({ role: "relier", targets: ["src/router.ts#Route"], with: { taskId: "t-five", agent: "agent-five", goal: "Rework routes", state: "in_review", mergeSha: null } }),
    ]);

    expect(text).toContain(
      "Other agents' tasks meet this one:\n" +
        '- agent-one ("Add GET /users/:id", active) uses src/db/users.ts#findUser, which this change alters.\n' +
        '- agent-five ("Rework routes", in_review) is changing src/router.ts#Route, which this change uses.\n' +
        "Do not hold this change back because of them. When each change lands, dibs checks that no file on the main branch is left using an interface in a shape it was not written for, and sends the later change back to adapt.",
    );
  });

  it("leaves out tasks that are only watched, that have landed, or that do the same work", () => {
    const merged = { taskId: "t-x", agent: "agent-x", goal: "g", state: "merged" as const, mergeSha: "a".repeat(40) };

    expect(
      coordinationFor({ ...REPORT, changed: [] }, WHOLE, [collision({ state: "possible" }), collision({ with: merged }), collision({ kind: "duplicate", targets: [] })]),
    ).toBeNull();
  });
});
