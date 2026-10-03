// An end-to-end check against a deployed dibs: real Artifacts, the real decision
// model and the real reviewer. Scripted git pushes stand in for the agents.
//
//   DIBS_URL=https://dibs.<subdomain>.workers.dev DIBS_ADMIN_TOKEN=... node scripts/e2e.ts
//
// Outcomes that code decides (a refused claim, a change outside the claim, a
// protected path) are asserted exactly. Outcomes that a model decides are only
// required to reach a final state, and are printed.

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_NAMES, api, DIBS_URL, git, readTree, requireConfig, updateRef } from "./lib.ts";

requireConfig();

const repo = `e2e-${Date.now().toString(36)}`;
const root = join(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "dibs-e2e-"));
const passed: string[] = [];
const check = (label: string) => {
  passed.push(label);
  console.log(`  ok  ${label}`);
};

type Json = Record<string, any>;

interface AgentSession {
  name: string;
  call(tool: string, args: Json): Promise<{ isError: boolean; data: Json }>;
}

async function connect(name: string, key: string): Promise<AgentSession> {
  const client = new Client({ name: `e2e-${name}`, version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${DIBS_URL}/mcp/${repo}`), { authProvider: { token: async () => key } }),
  );
  return {
    name,
    call: async (tool, args) => {
      const result = await client.callTool({ name: tool, arguments: args });
      const [block] = result.content as { type: string; text: string }[];
      return { isError: result.isError === true, data: JSON.parse(block!.text) as Json };
    },
  };
}

// Clones a task's fork, applies file changes, commits and pushes. Returns the clone's directory.
function pushWork(task: Json, name: string, files: Record<string, string | null>, message: string): string {
  const dir = join(scratch, `${name}-${task.task_id}`);
  mkdirSync(dir, { recursive: true });
  git(dir, ["clone", "--quiet", task.remote, "."], task.token);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    if (content === null) {
      rmSync(full, { force: true });
    } else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", message]);
  git(dir, ["push", "--quiet", "origin", `HEAD:${task.branch}`], task.token);
  return dir;
}

// dibs merges by pushing a commit built on the head of main, and names that head
// in the push. This asks the git server what it does when the named head is out
// of date, on a spare branch of a task's fork: it has to refuse.
async function probeStalePush(task: Json, clone: string): Promise<void> {
  const branch = "refs/heads/dibs-probe";
  const tip = git(clone, ["rev-parse", "HEAD"]);
  const next = git(clone, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "probe"]);
  // The branch starts at the base commit and moves to the tip; the server also holds `next`, a child of the tip.
  git(clone, ["push", "--quiet", "origin", `${task.base_sha}:${branch}`, `${next}:${branch}-next`], task.token);
  git(clone, ["push", "--quiet", "origin", `${tip}:${branch}`], task.token);
  const head = () => git(clone, ["ls-remote", "origin", branch], task.token).split("\t")[0];

  const stale = await updateRef(task.remote, task.token, branch, task.base_sha, next);
  assert.equal(stale.accepted, false, `the server accepted a push built on an out-of-date head: ${stale.report}`);
  assert.equal(head(), tip, "the branch moved although the push named an out-of-date head");

  const current = await updateRef(task.remote, task.token, branch, tip, next);
  assert.equal(current.accepted, true, `the server refused a push built on the current head: ${current.report}`);
  assert.equal(head(), next);
}

// Waits until the review of a task has reached an outcome. Each get_verdict call itself waits for the review.
async function settle(agent: AgentSession, taskId: string): Promise<Json> {
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    const { isError, data } = await agent.call("get_verdict", { task_id: taskId, wait_seconds: 20 });
    assert.equal(isError, false, JSON.stringify(data));
    if (data.state !== "in_review") {
      return data;
    }
  }
  throw new Error(`task ${taskId} of ${agent.name} was still in review after eight minutes`);
}

async function main(): Promise<void> {
  console.log(`dibs end-to-end check against ${DIBS_URL}, repository ${repo}\n`);

  // 1. Register the repository; dibs writes the first commit itself.
  const registered = await api<Json>("POST", "/api/repos", { name: repo, files: readTree(join(root, "demo-app")) });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  assert.match(registered.body.head, /^[0-9a-f]{40}$/);
  check("registered a repository and wrote its first commit from the Worker");
  assert.ok(registered.body.index.files > 0 && registered.body.index.references > 0, JSON.stringify(registered.body.index));
  check(`read the repository into the interface index: ${registered.body.index.files} files, ${registered.body.index.interfaces} interfaces`);

  const agents: Record<string, AgentSession> = {};
  for (const name of AGENT_NAMES) {
    const created = await api<Json>("POST", `/api/repos/${repo}/agents`, { name });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    agents[name] = await connect(name, created.body.key);
  }
  const { "agent-one": one, "agent-two": two, "agent-three": three, "agent-four": four, "agent-five": five } = agents as Record<
    (typeof AGENT_NAMES)[number],
    AgentSession
  >;
  check("created five agents and connected each over MCP");

  // 2. A clean task.
  const users = await one.call("start_task", {
    goal: "Add GET /users/:id, which looks the user up with findUser",
    paths: ["src/routes/users/", "test/users-get.test.ts"],
  });
  assert.equal(users.isError, false, JSON.stringify(users.data));
  assert.equal(users.data.base_sha, registered.body.head);
  check("agent-one's claim was granted with a fork based on main");

  // 3. An overlapping claim is refused, and names the holder.
  const refused = await two.call("start_task", {
    goal: "Add rate limiting to the user routes",
    paths: ["src/routes/users/", "src/middleware/"],
  });
  assert.equal(refused.isError, true);
  assert.equal(refused.data.error.code, "conflict");
  assert.equal(refused.data.conflicts[0].agent, "agent-one");
  check("agent-two's overlapping claim was refused and named agent-one");

  // Waiting in line: the request holds nothing, and can be given up.
  const inLine = await two.call("start_task", {
    goal: "Add rate limiting to the user routes",
    paths: ["src/routes/users/", "src/middleware/"],
    wait_seconds: 2,
  });
  assert.equal(inLine.isError, false, JSON.stringify(inLine.data));
  assert.equal(inLine.data.status, "waiting", JSON.stringify(inLine.data));
  assert.equal(inLine.data.blocking[0].agent, "agent-one");
  const left = await two.call("abandon", { request_id: inLine.data.request_id });
  assert.equal(left.isError, false, JSON.stringify(left.data));
  check("agent-two waited in line for agent-one's paths, then left the line");

  const limiter = await two.call("start_task", { goal: "Add a rate limiting middleware", paths: ["src/middleware/"] });
  assert.equal(limiter.isError, false, JSON.stringify(limiter.data));
  check("agent-two's narrowed claim was granted");

  // A task that starts now, and does its work only after the others have landed (step 10).
  const notes = await four.call("start_task", { goal: "Describe the routes in docs/ROUTES.md", paths: ["docs/"] });
  assert.equal(notes.isError, false, JSON.stringify(notes.data));

  // A task that changes what agent-one's route calls. It starts while agent-one's task is live, so the
  // decision model is asked how the two relate. Its answer is a model's, so it is printed and not asserted.
  const lookup = await five.call("start_task", { goal: "Change findUser to return a result object", paths: ["src/db/users.ts", "test/users.test.ts"] });
  assert.equal(lookup.isError, false, JSON.stringify(lookup.data));
  assert.ok(["ok", "unavailable", "off"].includes(lookup.data.related_check), JSON.stringify(lookup.data));
  const related = lookup.data.related.map((other: Json) => `${other.relation} with ${other.agent} (${other.confidence})`);
  check(`agent-five's claim was granted; related-work check ${lookup.data.related_check}: ${related.join(", ") || "nothing reported"}`);
  // The index knows that agent-one's routes use src/db/users.ts, which agent-five now holds. No model is asked.
  const met = lookup.data.collisions.find((collision: Json) => collision.with.agent === "agent-one");
  assert.ok(met !== undefined, JSON.stringify(lookup.data.collisions));
  assert.equal(met.role, "provider");
  check(`agent-five was told that agent-one's work uses ${met.targets.join(", ")}, in a file it now holds (${met.state})`);

  const usersClone = pushWork(
    users.data,
    "agent-one",
    {
      "src/routes/users/get.ts": [
        'import { findUser } from "../../db/users.ts";',
        'import type { Route } from "../../router.ts";',
        "",
        "export const getUserRoute: Route = {",
        '  method: "GET",',
        '  path: "/users/:id",',
        "  handler: (_request, params) => {",
        "    const user = findUser(params.id ?? \"\");",
        '    return user === null ? Response.json({ error: "not found" }, { status: 404 }) : Response.json(user);',
        "  },",
        "};",
        "",
      ].join("\n"),
      "src/routes/users/index.ts": [
        'import type { Route } from "../../router.ts";',
        'import { getUserRoute } from "./get.ts";',
        'import { listUsersRoute } from "./list.ts";',
        "",
        "export const userRoutes: Route[] = [listUsersRoute, getUserRoute];",
        "",
      ].join("\n"),
      "test/users-get.test.ts": [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import { handle } from "../src/index.ts";',
        "",
        'test("GET /users/:id returns the user", async () => {',
        '  const response = await handle(new Request("http://localhost/users/u1"));',
        "  assert.equal(response.status, 200);",
        '  assert.equal((await response.json()).name, "Ada Lovelace");',
        "});",
        "",
        'test("GET /users/:id is 404 for an unknown id", async () => {',
        '  const response = await handle(new Request("http://localhost/users/nobody"));',
        "  assert.equal(response.status, 404);",
        "});",
        "",
      ].join("\n"),
    },
    "Add GET /users/:id",
  );
  const usersSubmitted = await one.call("submit", { task_id: users.data.task_id, summary: "Adds the route, lists it, and tests both cases." });
  assert.equal(usersSubmitted.data.status, "in_review", JSON.stringify(usersSubmitted.data));
  check("agent-one pushed to its fork with git and submitted");

  await probeStalePush(users.data, usersClone);
  check("the git server refuses a push built on an out-of-date head, and accepts one built on the current head");

  // 4. A change outside the claim is rejected by a check, without a model.
  const paging = await three.call("start_task", { goal: "Fix paginate so that page 1 is the first page", paths: ["src/services/"] });
  assert.equal(paging.isError, false, JSON.stringify(paging.data));
  const fixedPagination = readTree(join(root, "demo-app"))["src/services/pagination.ts"]!.replace(
    "const start = page * size;",
    "const start = (Math.max(1, page) - 1) * size;",
  );
  const fixedClamp = readTree(join(root, "demo-app"))["src/utils/numbers.ts"]!.replace("upper - 1", "upper");
  pushWork(
    paging.data,
    "agent-three",
    { "src/services/pagination.ts": fixedPagination, "src/utils/numbers.ts": fixedClamp },
    "Fix page numbering and the clamp bound",
  );
  await three.call("submit", { task_id: paging.data.task_id, summary: "Pages start at 1; clamp includes its upper bound." });
  const outside = await settle(three, paging.data.task_id);
  assert.equal(outside.state, "active");
  assert.equal(outside.verdict.source, "check");
  assert.equal(outside.verdict.details.check, "coverage");
  assert.deepEqual(outside.verdict.details.details.uncovered, ["src/utils/numbers.ts"]);
  check("agent-three's change outside its claim was rejected by the coverage check");

  const expanded = await three.call("expand_claim", { task_id: paging.data.task_id, paths: ["src/utils/numbers.ts"] });
  assert.deepEqual(expanded.data.paths, ["src/services/", "src/utils/numbers.ts"]);
  const again = await three.call("submit", { task_id: paging.data.task_id, summary: "Pages start at 1; clamp includes its upper bound." });
  assert.equal(again.data.cycle, 2, JSON.stringify(again.data));
  check("agent-three expanded its claim and submitted again as attempt 2");

  // 5. A change to an interface another task relies on.
  pushWork(
    lookup.data,
    "agent-five",
    {
      "src/db/users.ts": [
        'import { db, type User } from "./client.ts";',
        "",
        'export type FindUserResult = { ok: true; user: User } | { ok: false; reason: "not_found" };',
        "",
        "export function findUser(id: string): FindUserResult {",
        "  const user = db.users.get(id);",
        '  return user === undefined ? { ok: false, reason: "not_found" } : { ok: true, user };',
        "}",
        "",
        "export function listUsers(): User[] {",
        "  return [...db.users.values()];",
        "}",
        "",
      ].join("\n"),
      "test/users.test.ts": [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import { findUser, listUsers } from "../src/db/users.ts";',
        "",
        'test("findUser returns the user with that id", () => {',
        '  const found = findUser("u2");',
        "  assert.equal(found.ok && found.user.name, \"Grace Hopper\");",
        "});",
        "",
        'test("findUser says not_found for an id that does not exist", () => {',
        '  assert.deepEqual(findUser("nobody"), { ok: false, reason: "not_found" });',
        "});",
        "",
        'test("listUsers returns every user", () => {',
        "  assert.equal(listUsers().length, 3);",
        "});",
        "",
      ].join("\n"),
    },
    "Return a result object from findUser",
  );

  // 6. A change to a protected path.
  const version = await four.call("start_task", { goal: "Set the package version to 1.0.0", paths: ["package.json"] });
  assert.equal(version.isError, false, JSON.stringify(version.data));
  pushWork(
    version.data,
    "agent-four",
    { "package.json": readTree(join(root, "demo-app"))["package.json"]!.replace('"private": true,', '"version": "1.0.0",\n  "private": true,') },
    "Set the version to 1.0.0",
  );
  await four.call("submit", { task_id: version.data.task_id, summary: "Adds a version field." });

  pushWork(
    limiter.data,
    "agent-two",
    {
      "src/middleware/rate-limit.ts": [
        "type RequestHandler = (request: Request) => Promise<Response>;",
        "",
        "// At most `limit` requests per client in each window; further requests get 429.",
        "export function withRateLimit(handler: RequestHandler, limit = 60, windowMs = 60_000): RequestHandler {",
        "  const seen = new Map<string, { count: number; resetAt: number }>();",
        "  return async (request) => {",
        '    const client = request.headers.get("x-forwarded-for") ?? "unknown";',
        "    const now = Date.now();",
        "    const entry = seen.get(client);",
        "    if (entry === undefined || entry.resetAt <= now) {",
        "      seen.set(client, { count: 1, resetAt: now + windowMs });",
        "      return handler(request);",
        "    }",
        "    if (entry.count >= limit) {",
        '      return Response.json({ error: "rate limited" }, { status: 429 });',
        "    }",
        "    entry.count++;",
        "    return handler(request);",
        "  };",
        "}",
        "",
      ].join("\n"),
    },
    "Add a rate limiting middleware",
  );
  await two.call("submit", { task_id: limiter.data.task_id, summary: "A wrapper like withLogging; not wired into the routes yet." });
  check("agents two, four and five pushed and submitted");

  // 7. agent-one's route, which calls findUser as it was, lands first.
  let routeOutcome = await settle(one, users.data.task_id);
  if (routeOutcome.state === "escalated") {
    await api<Json>("POST", `/api/repos/${repo}/escalations/${users.data.task_id}`, { decision: "approve", note: "Approved by the end-to-end check" });
    routeOutcome = await settle(one, users.data.task_id);
  }
  assert.equal(routeOutcome.state, "merged", JSON.stringify(routeOutcome));

  // agent-five's change would now leave that route calling findUser in its old shape. It goes back before any model sees it.
  await five.call("submit", { task_id: lookup.data.task_id, summary: "findUser returns { ok, user } or { ok: false, reason }." });
  const sentBack = await settle(five, lookup.data.task_id);
  assert.equal(sentBack.state, "active", JSON.stringify(sentBack));
  assert.equal(sentBack.verdict.source, "check", JSON.stringify(sentBack.verdict));
  assert.equal(sentBack.verdict.details.check, "contract");
  assert.match(sentBack.verdict.details.message, /src\/routes\/users\/get\.ts/);
  check("agent-five's change was sent back before review: the route on main uses findUser and was not part of it");

  // agent-five does what the message says: catches up, takes the route into its scope, and updates it.
  const fiveSync = await five.call("sync_with_main", { task_id: lookup.data.task_id });
  assert.equal(fiveSync.isError, false, JSON.stringify(fiveSync.data));
  const grown = await five.call("expand_scope", { task_id: lookup.data.task_id, paths: ["src/routes/users/get.ts"] });
  assert.equal(grown.isError, false, JSON.stringify(grown.data));
  const fiveClone = join(scratch, `agent-five-${lookup.data.task_id}`);
  git(fiveClone, ["pull", "--quiet", "--no-rebase", "--no-edit", fiveSync.data.remote, fiveSync.data.branch], fiveSync.data.token);
  const route = join(fiveClone, "src/routes/users/get.ts");
  writeFileSync(
    route,
    readFileSync(route, "utf8")
      .replace('const user = findUser(params.id ?? "");', 'const found = findUser(params.id ?? "");')
      .replace(
        'return user === null ? Response.json({ error: "not found" }, { status: 404 }) : Response.json(user);',
        'return found.ok ? Response.json(found.user) : Response.json({ error: "not found" }, { status: 404 });',
      ),
  );
  git(fiveClone, ["add", "-A"]);
  git(fiveClone, ["commit", "--quiet", "-m", "Use the result object in GET /users/:id"]);
  git(fiveClone, ["push", "--quiet", "origin", `HEAD:${lookup.data.branch}`], lookup.data.token);
  await five.call("submit", { task_id: lookup.data.task_id, summary: "findUser returns a result object; the route that uses it is updated." });

  // 8. Let every review reach an outcome.
  const outcomes: Record<string, Json> = {
    "agent-one": routeOutcome,
    "agent-two": await settle(two, limiter.data.task_id),
    "agent-three": await settle(three, paging.data.task_id),
    "agent-four": await settle(four, version.data.task_id),
    "agent-five": await settle(five, lookup.data.task_id),
  };
  console.log("\n  Outcomes of the reviews:");
  for (const [name, outcome] of Object.entries(outcomes)) {
    const reasons = (outcome.verdict?.details?.reasons ?? []).map((reason: Json) => reason.kind).join(", ");
    console.log(`      ${name}: ${outcome.state}${reasons === "" ? "" : ` (${reasons})`}${outcome.merge_sha ? ` ${outcome.merge_sha.slice(0, 7)}` : ""}`);
    assert.ok(["merged", "active", "escalated"].includes(outcome.state), `${name} ended as ${outcome.state}`);
  }
  check("every review reached an outcome");
  assert.notEqual(outcomes["agent-five"]!.verdict?.source, "check", JSON.stringify(outcomes["agent-five"]));
  check(`agent-five's second attempt passed the contract check (${outcomes["agent-five"]!.state})`);

  // The reviewer decides approve or reject; if it approved the protected path, code must have escalated it.
  const protectedOutcome = outcomes["agent-four"]!;
  assert.notEqual(protectedOutcome.state, "merged", "a change to package.json must never merge without a person");
  if (protectedOutcome.state === "escalated" && protectedOutcome.verdict.source === "reviewer" && protectedOutcome.verdict.details.decision === "approve") {
    const kinds = (protectedOutcome.verdict.details.reasons ?? []).map((reason: Json) => reason.kind);
    assert.ok(kinds.includes("protected_path"), `expected protected_path among the reasons, got: ${kinds.join(", ")}`);
  }
  check("the change to a protected path did not merge by itself");

  // 9. A person approves everything that is waiting.
  for (const [name, outcome] of Object.entries(outcomes)) {
    if (outcome.state !== "escalated") {
      continue;
    }
    const decided = await api<Json>("POST", `/api/repos/${repo}/escalations/${outcome.task_id}`, {
      decision: "approve",
      note: "Approved by the end-to-end check",
    });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    outcomes[name] = await settle(agents[name]!, outcome.task_id);
    assert.equal(outcomes[name]!.state, "merged", `${name} after approval: ${JSON.stringify(outcomes[name])}`);
  }
  check("approving the escalated changes merged them");

  // 10. What landed on main, read with a plain git client.
  const merged = Object.values(outcomes).filter((outcome) => outcome.state === "merged");
  assert.ok(merged.length >= 1, "at least one task should have merged");
  const access = await api<Json>("POST", `/api/repos/${repo}/read-token`);
  const main = join(scratch, "main");
  mkdirSync(main);
  git(main, ["clone", "--quiet", access.body.remote, "."], access.body.token);
  const log = git(main, ["log", "--format=%H%n%B%n--"]);
  for (const outcome of merged) {
    assert.ok(log.includes(`Dibs-Task: ${outcome.task_id}`), `no commit on main carries Dibs-Task: ${outcome.task_id}`);
    assert.ok(log.includes(outcome.merge_sha), `main does not contain ${outcome.merge_sha}`);
  }
  check(`main has one commit per merged task (${merged.length}), each with its trailers`);

  git(main, ["fetch", "--quiet", "origin", "refs/notes/dibs:refs/notes/dibs"], access.body.token);
  const note = JSON.parse(git(main, ["notes", "--ref=dibs", "show", merged[0]!.merge_sha])) as Json;
  assert.equal(note.task, merged[0]!.task_id);
  check("the verdict is attached to the merge commit as a git note");

  git(main, ["fsck", "--strict", "--no-dangling"]);
  check("git fsck finds the repository intact");

  // 11. A task that started before all of that catches up with main and then does its work.
  const mainHead = git(main, ["rev-parse", "HEAD"]);
  const sync = await four.call("sync_with_main", { task_id: notes.data.task_id });
  assert.equal(sync.isError, false, JSON.stringify(sync.data));
  assert.equal(sync.data.main_head, mainHead);
  const notesClone = join(scratch, "notes");
  mkdirSync(notesClone);
  git(notesClone, ["clone", "--quiet", notes.data.remote, "."], notes.data.token);
  assert.equal(git(notesClone, ["rev-parse", "HEAD"]), registered.body.head, "the fork should still be where it started");
  // What sync_command does: merge the current main into the fork's work.
  git(notesClone, ["pull", "--quiet", "--no-rebase", "--no-edit", sync.data.remote, sync.data.branch], sync.data.token);
  assert.equal(git(notesClone, ["rev-parse", "HEAD"]), mainHead, "pulling main should bring the fork to main's head");
  mkdirSync(join(notesClone, "docs"));
  writeFileSync(join(notesClone, "docs/ROUTES.md"), "# Routes\n\n- `GET /health`\n- `GET /users`\n");
  git(notesClone, ["add", "-A"]);
  git(notesClone, ["commit", "--quiet", "-m", "Describe the routes"]);
  git(notesClone, ["push", "--quiet", "origin", `HEAD:${notes.data.branch}`], notes.data.token);
  const notesSubmitted = await four.call("submit", { task_id: notes.data.task_id, summary: "Lists the routes the service has." });
  assert.equal(notesSubmitted.isError, false, JSON.stringify(notesSubmitted.data));
  // Compared with the commit the fork started from, everything the other tasks merged would look like this task's doing.
  const notesDiff = await api<Json>("GET", `/api/repos/${repo}/tasks/${notes.data.task_id}/diff`);
  assert.deepEqual(
    notesDiff.body.files.map((file: Json) => file.path),
    ["docs/ROUTES.md"],
  );
  let notesOutcome = await settle(four, notes.data.task_id);
  assert.notEqual(notesOutcome.verdict?.source, "check", `a check stopped the caught-up task: ${JSON.stringify(notesOutcome.verdict)}`);
  if (notesOutcome.state === "escalated") {
    await api<Json>("POST", `/api/repos/${repo}/escalations/${notes.data.task_id}`, { decision: "approve", note: "Approved by the end-to-end check" });
    notesOutcome = await settle(four, notes.data.task_id);
  }
  console.log(`      the caught-up task: ${notesOutcome.state}${notesOutcome.merge_sha ? ` ${notesOutcome.merge_sha.slice(0, 7)}` : ""}`);
  check("a task that started before the others landed caught up with main, and only its own change was reviewed");

  // 12. Where the deployment can run the repository's checks (.dibs/checks.json), every change is checked
  // before it lands, and a change that breaks a test goes back with the test's output.
  const firstLanded = git(main, ["log", "-1", "--format=%B", outcomes["agent-one"]!.merge_sha]);
  const gateLine = /^Dibs-Gate: (.*)$/m.exec(firstLanded)?.[1] ?? null;
  if (gateLine === null) {
    console.log("      (this deployment does not run the repository's checks: no Dibs-Gate on the commits)");
  } else {
    assert.match(gateLine, /^pass; test; \d+s$/, firstLanded);
    check(`agent-one's change landed after the repository's checks passed on it (${gateLine})`);

    const health = await two.call("start_task", { goal: "Make GET /health answer with a status field", paths: ["src/routes/health.ts"] });
    assert.equal(health.isError, false, JSON.stringify(health.data));
    pushWork(
      health.data,
      "agent-two-health",
      { "src/routes/health.ts": readTree(join(root, "demo-app"))["src/routes/health.ts"]!.replace("{ ok: true }", '{ status: "ok" }') },
      "Answer /health with a status field",
    );
    await two.call("submit", { task_id: health.data.task_id, summary: "GET /health now answers { status: \"ok\" }." });
    const broken = await settle(two, health.data.task_id);
    assert.equal(broken.state, "active", JSON.stringify(broken));
    assert.equal(broken.verdict.source, "gate", JSON.stringify(broken.verdict));
    assert.match(broken.verdict.details.message, /GET \/health answers ok/);
    check("a change that broke a test was sent back by the checks, with the failing test named, before any model saw it");
    await two.call("abandon", { task_id: health.data.task_id });
  }

  // 13. Two tasks add a route each to the same list of routes, at once. Both hold the list to add to.
  // The routes sit outside /users/:id, which would otherwise catch them, and each comes with its test.
  const routeFile = (name: string, path: string, body: string) =>
    [
      'import type { Route } from "../../router.ts";',
      'import { listUsers } from "../../db/users.ts";',
      "",
      `export const ${name}: Route = {`,
      '  method: "GET",',
      `  path: "${path}",`,
      `  handler: () => Response.json(${body}),`,
      "};",
      "",
    ].join("\n");
  const testFile = (path: string, check: string) =>
    [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      'import { handle } from "../src/index.ts";',
      "",
      `test("GET ${path} answers", async () => {`,
      `  const response = await handle(new Request("http://localhost${path}"));`,
      "  assert.equal(response.status, 200);",
      `  ${check}`,
      "});",
      "",
    ].join("\n");
  const routes = [
    {
      agent: one,
      name: "userCountRoute",
      file: "count.ts",
      path: "/user-count",
      goal: "Add GET /user-count, which answers with the number of users, and list it in the user routes",
      body: "{ count: listUsers().length }",
      check: "assert.equal((await response.json()).count, 3);",
    },
    {
      agent: five,
      name: "userNamesRoute",
      file: "names.ts",
      path: "/user-names",
      goal: "Add GET /user-names, which answers with the names of all users, and list it in the user routes",
      body: "listUsers().map((user) => user.name)",
      check: "assert.equal((await response.json()).length, 3);",
    },
  ];
  const listed = readFileSync(join(main, "src/routes/users/index.ts"), "utf8");
  const started: Json[] = [];
  for (const route of routes) {
    const task = await route.agent.call("start_task", {
      goal: route.goal,
      scope: [
        { target: `src/routes/users/${route.file}`, relation: "change" },
        { target: `test/${route.file.replace(".ts", "")}-route.test.ts`, relation: "change" },
        { target: "src/routes/users/index.ts", relation: "add" },
      ],
    });
    assert.equal(task.isError, false, JSON.stringify(task.data));
    started.push(task.data);
  }
  check("two tasks hold the same list of routes to add to, at the same time");
  routes.forEach((route, index) => {
    pushWork(
      started[index]!,
      `${route.name}`,
      {
        [`src/routes/users/${route.file}`]: routeFile(route.name, route.path, route.body),
        [`test/${route.file.replace(".ts", "")}-route.test.ts`]: testFile(route.path, route.check),
        "src/routes/users/index.ts": listed
          .replace('import { getUserRoute } from "./get.ts";', `import { getUserRoute } from "./get.ts";\nimport { ${route.name} } from "./${route.file}";`)
          .replace("getUserRoute];", `getUserRoute, ${route.name}];`),
      },
      `Add GET ${route.path}`,
    );
  });
  const settled: Json[] = [];
  for (const [index, route] of routes.entries()) {
    await route.agent.call("submit", { task_id: started[index]!.task_id, summary: `Adds GET ${route.path}, lists it, and tests it.` });
    let outcome = await settle(route.agent, started[index]!.task_id);
    if (outcome.state === "escalated") {
      await api<Json>("POST", `/api/repos/${repo}/escalations/${started[index]!.task_id}`, { decision: "approve", note: "Approved by the end-to-end check" });
      outcome = await settle(route.agent, started[index]!.task_id);
    }
    settled.push(outcome);
  }
  console.log(`      the two routes: ${settled.map((outcome) => outcome.state).join(", ")}`);
  if (settled.every((outcome) => outcome.state === "merged")) {
    git(main, ["pull", "--quiet", "--no-rebase", access.body.remote, "main"], access.body.token);
    const both = readFileSync(join(main, "src/routes/users/index.ts"), "utf8");
    assert.match(both, /userCountRoute/);
    assert.match(both, /userNamesRoute/);
    assert.match(git(main, ["log", "-1", "--format=%B", settled[1]!.merge_sha]), /Dibs-Composed: src\/routes\/users\/index\.ts/);
    check("the second task's addition to the list was joined with the first's, and both routes are listed on main");
  } else {
    console.log(`      (a reviewer sent a route back, so the joining of the list was not exercised: ${settled.map((outcome) => outcome.verdict?.details?.summary ?? "").join(" | ").slice(0, 300)})`);
  }

  const state = await api<Json>("GET", `/api/repos/${repo}/state`);
  console.log(`\n  Shadow tally: Clef alone would have matched ${state.body.shadow.agreed} of ${state.body.shadow.reviewed} reviews.`);
  console.log(`\n${passed.length} checks passed. Board: ${DIBS_URL}/?repo=${repo}`);
}

try {
  await main();
} catch (error) {
  console.error(`\nFAILED after ${passed.length} checks:`, error);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
