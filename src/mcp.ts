// The MCP server agents connect to. One endpoint per repository, at /mcp/<repo>,
// authenticated by the agent's API key. It is stateless: every request builds a
// server for the calling agent. All behaviour lives in tools.ts.

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import * as z from "zod";
import {
  abandon,
  declareInterfaceChange,
  expandScope,
  getVerdict,
  peek,
  startTask,
  submit,
  syncWithMain,
  whatsHappening,
  type ToolDeps,
  type ToolResult,
} from "./tools";
import type { Agent } from "./types";

export interface McpOptions {
  tools: ToolDeps;
  authenticate(key: string): Promise<Agent | null>;
}

const INSTRUCTIONS = `dibs coordinates several coding agents working on one git repository at the same time.

The loop for every piece of work:
1. Call start_task with your goal and what you will hold. Do this before editing anything.
2. If it is granted you receive a private fork. Clone it with the given command, make your changes, commit, and push to the fork's branch.
3. Call submit. A review starts.
4. Call get_verdict, and call it again for as long as the state is in_review: the call waits for the review, so do not pause in between. If the verdict is reject, do what verdict.details says in the same fork, push, and submit again. If the state is merged, you are done. If it is escalated, a person is deciding; get_verdict waits for them too.

What you hold is your scope. Give it as \`paths\`, the paths you will change, or as \`scope\`, a list of entries that each name a target and how you hold it:
- "change": you will rewrite it, and no other task may write it meanwhile. The target is a path (one ending in "/" is a directory and everything under it), or one interface written path#name, such as src/users.ts#findUser, when you change one function in a file that others work in too.
- "add": a file or directory you only add to, such as a list of routes or a directory of tests. Other tasks can add to it at the same time.
- "rely": code you use and will not touch, written as a path or as path#name. Nobody is stopped from changing it, but you and whoever changes it are told of each other at once. dibs adds what your files already import; name what your new files will use.
Every path you change must be in your scope to change or to add to. Add to your scope with expand_scope before you edit anything outside it.

If what you ask for is held by another task, the call is refused and \`conflicts\` says who holds it and how. Ask for less, ask to "add" where you only add, or wait in line: pass wait_seconds, and if the answer has status "waiting", call the same tool again with its request_id until it is granted.

\`collisions\` in a tool's answer lists other tasks whose work meets yours, each with a \`brief\` that says what to do. \`dependents\` lists, for each interface you change, the files that use it and are not yours to write.

dibs keeps the main branch whole, and sends a change back when it would break it:
- when code your change relies on has changed on the main branch since your fork branched off: call sync_with_main, run the command it returns, change your code to fit, run the tests, push, and submit again;
- when your change alters an interface (its name, parameters or result) and leaves a file that uses it as it was: call sync_with_main, add that file to your scope with expand_scope, update it, and submit again.
Say that you will alter an interface as soon as you know it, with declare_interface_change: the tasks that use it are told while they can still adapt cheaply.

You never push to the main repository yourself: dibs merges approved work for you.`;

const taskId = z.string().describe("The task_id returned by start_task.");
const paths = z
  .array(z.string())
  .min(1)
  .describe(
    'Repository-relative paths you will change. A path ending in "/" is that directory and everything under it; any other path is exactly one file. No globs.',
  );
const scope = z
  .array(
    z.object({
      target: z.string().describe('A path, an interface written path#name (for example "src/users.ts#findUser"), or a route written "route:GET /users/:id".'),
      relation: z.enum(["change", "add", "rely"]).describe('"change": yours alone to rewrite. "add": you only add to it, and so may others. "rely": you use it and will not touch it.'),
    }),
  )
  .min(1)
  .describe("What you will hold and how. Use it in place of `paths`, or together with it, when you only add to a shared file, change one interface in a file, or rely on code you will not touch.");
const waitSeconds = z
  .number()
  .int()
  .min(0)
  .max(30)
  .optional()
  .describe('How long to wait in line for what another task holds, at most 30. Left out, the call is refused at once. If the answer has status "waiting", call again with its request_id.');
const requestId = z.string().optional().describe("The request_id of an earlier call that answered with status \"waiting\". Give it alone to keep waiting.");

function toContent(result: ToolResult<unknown>) {
  const body = result.ok ? result.data : { error: result.error, ...(result.conflicts ? { conflicts: result.conflicts } : {}) };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    isError: !result.ok,
  };
}

export function buildServer(deps: ToolDeps, agent: Agent): McpServer {
  const server = new McpServer({ name: "dibs", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "start_task",
    {
      description:
        "Declare what you are about to do and what you will hold. Call this before editing anything. " +
        "If it is granted, you get a private fork of the repository (remote, token, clone_command), and what you hold to change is yours alone until your task ends. " +
        "If another live task holds something you asked for, the call is refused and `conflicts` says who holds it and how: ask for less, ask to add where you only add, or pass wait_seconds to wait in line. " +
        "`collisions` lists other tasks whose work meets yours, each with a brief on what to do. `dependents` lists the files that use an interface you change and are not yours to write. " +
        "`related` lists other agents' live tasks that appear connected to yours; read them and avoid breaking what they rely on.",
      inputSchema: z.object({
        goal: z
          .string()
          .min(1)
          .optional()
          .describe("What you intend to accomplish, in a sentence or two. Reviewers judge your change against this. Needed unless you give a request_id."),
        paths: paths.optional(),
        scope: scope.optional(),
        ttl_minutes: z
          .number()
          .int()
          .min(1)
          .max(480)
          .optional()
          .describe("How long the scope lasts without activity. Defaults to 120."),
        wait_seconds: waitSeconds,
        request_id: requestId,
      }),
    },
    async (input) => toContent(await startTask(deps, agent, input)),
  );

  const expandInput = z.object({ task_id: taskId, paths: paths.optional(), scope: scope.optional(), wait_seconds: waitSeconds, request_id: requestId });
  const expandDescription =
    "Add to what a task holds, when you find you need to change or add to more than you asked for, or rely on something new. " +
    "Every path you change must be in your scope, or the review sends the submission back. " +
    "If another task holds something you ask for, the call is refused and your scope is left as it was; pass wait_seconds to wait in line for it. " +
    "The answer says again how the task stands with the others: `collisions`, `dependents` and `related`.";
  server.registerTool("expand_scope", { description: expandDescription, inputSchema: expandInput }, async (input) =>
    toContent(await expandScope(deps, agent, input)),
  );
  // The name the tool had when a scope was a list of paths. Agents written for it keep working.
  server.registerTool(
    "expand_claim",
    { description: `The older name of expand_scope. ${expandDescription}`, inputSchema: expandInput },
    async (input) => toContent(await expandScope(deps, agent, input)),
  );

  server.registerTool(
    "declare_interface_change",
    {
      description:
        "Say that your task will change an interface: the name, the parameters or the result of something other files use. Call it as soon as you know. " +
        "The tasks that use the interface are told at once, while they can still adapt cheaply. " +
        "`dependents` in the answer lists the files that use it and are not yours to write: they have to be updated as part of your change, so add them to your scope with expand_scope.",
      inputSchema: z.object({
        task_id: taskId,
        target: z.string().describe('The interface, written path#name. For example "src/users.ts#findUser".'),
      }),
    },
    async (input) => toContent(await declareInterfaceChange(deps, agent, input)),
  );

  server.registerTool(
    "peek",
    {
      description:
        "Read the work of another task that yours meets, as it stands in that task's fork right now: its goal, the files it changes, and the diff. " +
        "Use it when a collision says another task is changing something you rely on, so that you can write against the new shape before it lands. " +
        "It only reads: you cannot write to the other task's fork. The other task must be listed in your `collisions` or `related`.",
      inputSchema: z.object({
        task_id: taskId,
        other_task_id: z.string().describe("The task_id of the other task, as given in `collisions` or `related`."),
      }),
    },
    async (input) => toContent(await peek(deps, agent, input)),
  );

  server.registerTool(
    "submit",
    {
      description:
        "Submit a task for review once your work is committed and pushed to the fork. The fork's current head is what gets reviewed; later pushes are not included. " +
        "After this, call get_verdict to learn the outcome. " +
        "`collisions` and `related` in the result list other agents' tasks that meet yours, including ones that started after you.",
      inputSchema: z.object({
        task_id: taskId,
        summary: z.string().describe("What you changed and why, for the reviewer and for the commit message."),
        leaves_dependents: z
          .string()
          .optional()
          .describe(
            "Only when your change alters an interface and you leave files that use it as they are: why those files need no change. A person then decides whether that holds. Better: update the files.",
          ),
        confirm_distinct: z
          .boolean()
          .optional()
          .describe("Set to true when you were told that an earlier task does the same work, and yours is different. Say how it differs in the summary."),
      }),
    },
    async (input) => toContent(await submit(deps, agent, input)),
  );

  server.registerTool(
    "get_verdict",
    {
      description:
        "Get a task's state and its latest verdict. While a review is running or a person is deciding, the call itself waits for the next change, so there is no need to pause between calls. " +
        "States: in_review (the review is still running; call again right away); " +
        "active with a reject verdict (do what verdict.details says: fix the issues it lists, follow its message, or do what a person's note says; push to the same fork, and submit again); " +
        "merged (done; merge_sha is the commit on the main branch); " +
        "escalated (a person is deciding; call again to keep waiting for them, or stop and come back later); " +
        "expired, abandoned or closed (the task is over). " +
        "`collisions` and `related` list other agents' tasks that meet this one, including ones that started after it.",
      inputSchema: z.object({
        task_id: taskId,
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(30)
          .optional()
          .describe("How long to wait for a review or a person's decision, at most 30. Defaults to 20; 0 answers at once."),
      }),
    },
    async (input) => toContent(await getVerdict(deps, agent, input)),
  );

  server.registerTool(
    "sync_with_main",
    {
      description:
        "Bring your fork up to date with the main branch, which has other agents' merged work that your fork does not have. " +
        "Use it when a verdict or a person's note says that code you rely on has changed, or that your work is out of date. " +
        "It returns sync_command: commit your own work first, then run that command in your clone. It merges the current main branch into your work. " +
        "Then fix your code against what changed, run the tests, push, and submit again. Only your own changes are reviewed.",
      inputSchema: z.object({ task_id: taskId }),
    },
    async (input) => toContent(await syncWithMain(deps, agent, input)),
  );

  server.registerTool(
    "whats_happening",
    {
      description:
        "See what every agent is working on right now in this repository (goal, scope, state), the requests waiting in line, and the ten most recent merges. " +
        "Use it to choose work that does not collide with others.",
      inputSchema: z.object({}),
    },
    async () => toContent(await whatsHappening(deps)),
  );

  server.registerTool(
    "abandon",
    {
      description:
        "Give up a task and release what it holds, so that other agents can take it. Or, with a request_id, give up a place in the line.",
      inputSchema: z.object({ task_id: taskId.optional(), request_id: requestId }),
    },
    async (input) => toContent(await abandon(deps, agent, input)),
  );

  return server;
}

function bearerKey(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match === null ? null : match[1]!;
}

export async function handleMcp(
  request: Request,
  env: unknown,
  ctx: ExecutionContext,
  options: McpOptions,
): Promise<Response> {
  const route = new URL(request.url).pathname;
  // A browser's CORS preflight carries no credentials; it reaches no tool.
  if (request.method === "OPTIONS") {
    return createMcpHandler(() => new McpServer({ name: "dibs", version: "0.1.0" }), { route })(request, env, ctx);
  }

  const key = bearerKey(request);
  const agent = key === null ? null : await options.authenticate(key);
  if (agent === null) {
    return Response.json(
      { error: { code: "unauthorized", message: "send the agent's API key as a bearer token" } },
      { status: 401, headers: { "www-authenticate": "Bearer" } },
    );
  }
  return createMcpHandler(() => buildServer(options.tools, agent), { route })(request, env, ctx);
}
