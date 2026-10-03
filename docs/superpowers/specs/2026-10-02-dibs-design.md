# dibs — Design Spec

> **Status:** Approved 2026-10-02. Revised the same day to match what was built; §21 lists every change from the approved text.
> **Date:** 2026-10-02
> **Authors:** Shivam Srivastava, Claude
> **Working name:** `dibs` (agents call dibs on files before they edit them). Rename freely.

---

## 1. Goal

An entry for Cloudflare's "next Git platform" competition, built on Workers and Artifacts.

- **Deadline:** 14 October 2026. No timezone is stated, so plan to submit on 13 October.
- **Deliverables:** a 5–10 minute video, source under MIT, and run instructions.
- **Minimum bar set by Cloudflare:** multiple agents working on changes concurrently, and not "GitHub as it exists today with agents added on top".

dibs is a coordination layer for many coding agents working on one repository at the same time. It does two things:

1. **Intent before edit.** An agent declares its goal and the paths it will change before it gets anywhere to work. Overlapping intent is caught before any work is done.
2. **Verdicts instead of pull requests.** When the agent is done, the platform checks the change against the declared claim, has a reviewer model judge it, and then merges, sends it back, or escalates to a human. Humans see only escalations.

A decision model, Cloudflare's Clef, supplies fast typed signals in two places: a related-work warning at claim time (§8) and triage at review time (§10). It informs decisions. It never refuses a claim and never approves a merge on its own.

## 2. Positioning

| | How intent is known | When conflicts surface | Who decides the merge |
|---|---|---|---|
| GitHub pull requests | PR description, written after the work | At merge time | A human reviewer |
| Entire (entire.io) | Reconstructed after the fact from captured agent sessions | Not addressed in what has shipped | A human; `entire review` is advisory |
| **dibs** | Declared before the work, and binding | Before the work starts | The platform, from a verdict; humans on escalation |

Entire has shipped session capture (Checkpoints), blame, search, and advisory multi-agent review. Its vision names coordination ("without overwriting, colliding") but nothing shipped covers it as of its blog on 2026-09-28. dibs does not build provenance, session capture or search. It works alongside Entire: see §11.4.

## 3. Platform facts

Verified against the Artifacts docs on 2026-10-02:

- The Workers binding offers `create`, `get`, `list`, `import`, `delete` on a namespace, and `info`, `createToken`, `listTokens`, `revokeToken`, `fork`, `log`, `readCommit`, `readTree`, `readBlob`, `readFile` on a repo. It has no write, commit or merge method.
- There are no server-side merges and no push hooks. Writes happen only through `git push`.
- Tokens are scoped to one repo, `read` or `write`, with a TTL of 60 seconds to 1 year. They are not branch-scoped.
- `repo.pushed` events are scoped to a single repo; one subscription names one repo.
- A fork is asynchronous: the repo reports `forking` until ready, and reads fail with `FORK_IN_PROGRESS` meanwhile.
- Cloudflare documents pushing from a Worker using `isomorphic-git` with an in-memory filesystem.
- Push uses Git protocol v1 only. Clone and fetch support shallow fetches; `filter` (blobless clone) is not supported.
- Git notes are recommended for run metadata; they live on `refs/notes/*`.
- Limits: 1 GB per repo, 32 MB per blob, 2,000 requests per 10 seconds per repo.
- Pricing: Workers Paid only. 10,000 operations and 1 GB-month included, then $0.15 per 1,000 operations and $0.50 per GB-month. Billing starts 14 October 2026.
- Wrangler 4.145.0 or later is required for the binding types.
- Git routes take the token as `Authorization: Bearer <token>` (through `http.extraHeader`), or as the password of HTTP Basic auth.
- Binding errors carry a string `code` (`NOT_FOUND`, `FORK_IN_PROGRESS`, `ALREADY_EXISTS` and others). `fork()` fails with `FORK_IN_PROGRESS` while another fork is running. `log()` returns an empty list for a ref that does not resolve.
- `ArtifactsCommitMetadata` has `treeHash` (from the generated binding types).
- Repo names start with a letter or digit and may contain letters, digits, `.`, `_` and `-`.
- Neither Artifacts nor Workers AI has a local simulation. `wrangler dev` uses the real services.

Verified against the Workflows docs and the Wrangler source on 2026-10-02:

- A step's result is stored and may be at most 1 MiB. Steps are retried; a run survives restarts.
- An instance id may hold only letters, digits, `_` and `-`, and at most 100 characters.
- Workflows run locally under `wrangler dev`.
- When `secrets.required` is set, Wrangler refuses to create a Worker without those secrets. The first deploy has to pass them with `--secrets-file`.

Verified against the Workers AI docs for Clef on 2026-10-02:

- Clef is a decision model: it takes a `state` and 1 to 64 typed questions and returns a probability for every allowed answer. It generates no text.
- Question types: `noul` (yes/no; returns the probability of yes), `choice` (2 to 255 options; returns the chosen option, a probability per option, and a confidence), `score` (2 to 10 ordered levels indexed from 0; returns a probability-weighted score, a probability per level, and a confidence).
- Called as `env.AI.run("@cf/cloudflare/clef", { model: "clef", state, questions })`, or `clef-flash` for the smaller model.
- Context is 65,536 tokens. State that is too long is truncated without an error.
- Pricing: $0.24 per million input tokens for `clef`, $0.09 for `clef-flash`.
- Cloudflare's own benchmark reports a median latency of 209 ms for `clef` and 38.8 ms for `clef-flash`.
- No benchmark for judging code changes has been published, and Clef launched on 2026-10-01.

Measured on 2026-10-02 (`docs/clef-calibration.md`):

- Clef's `confidence` is not the probability of its answer. It measures how concentrated the answer is across the options, and matches `(Σp² − 1/n) / (1 − 1/n)`. It is not used for any decision.
- For the requests dibs sends, `clef-flash` answered in about 250 ms and `clef` in 0.5 to 1.3 seconds.

The assumptions this design rested on were checked against a deployment on 2026-10-02 with `scripts/e2e.ts`:

- **V1.** Changed paths can be computed with `readCommit` and `readTree`. Holds.
- **V2.** Artifacts accepts a pack built in the Worker and pushed with git's HTTP protocol, and refuses a push that names an out-of-date head. Both hold.
- **V3.** Artifacts accepts a push to `refs/notes/dibs`. Holds.
- **V4.** A Workflow step can use the Artifacts binding. Holds. A handle from the binding stops working the moment it is disposed, so nothing may be returned from a `using` block before it has finished using the handle.
- **V5.** The account is on Workers Paid. On the free plan Artifacts answers "Access denied [code: 10004]".
- **V6.** Clef gives usable answers to the related-work and triage questions. It does, once the thresholds read its probabilities and not its `confidence`, and once the interface question asks about signatures and not behaviour.

## 4. Concepts

- **Repo:** an Artifacts repository registered with dibs. Its default branch is `main`. Only dibs can write to it.
- **Agent:** any coding agent with an MCP client. It has a name and an API key.
- **Task:** one unit of work by one agent: a goal, a claim, a fork, and a history of submissions.
- **Claim:** the set of paths a task holds exclusively. No two live tasks hold overlapping paths.
- **Fork:** an Artifacts fork of the repo, created for one task. The agent has a write token for the fork and nothing else.
- **Submission:** the agent's statement that the fork's head is ready for review. It pins a commit SHA.
- **Verdict:** the structured result of reviewing a submission.
- **Escalation:** a submission that a human must decide.
- **Signal:** a typed answer from the decision model, with its probability or confidence.

## 5. Architecture

```
 coding agents (Claude Code, Codex, ...)            human
      │  MCP over HTTP        │ git push/clone        │ browser
      ▼                       ▼                       ▼
 ┌──────────────── Worker: dibs ─────────────────────────────┐
 │  /mcp/:repo        /api/*            / (board assets)     │
 └──────┬─────────────────┬──────────────────────────────────┘
        │                 │
        ▼                 ▼
 ┌─ Coordinator (Durable Object, one per repo) ─┐
 │  SQLite: agents, tasks, claims, submissions,  │──▶ WebSocket to board
 │  verdicts, events, merge lock                 │
 └──────┬────────────────────────────────────────┘
        │ creates
        ▼
 ┌─ ReviewWorkflow (one run per submission) ─┐      ┌─ Artifacts ──────────┐
 │ changes  checks  diff  triage  review      │◀────▶│ main repo            │
 │ decide  merge                              │      │ one fork per task    │
 └──────┬─────────────────────────────────────┘      └──────────────────────┘
        ▼
   Workers AI: Clef (triage)   ·   Anthropic API (reviewer)

 The Worker also calls Clef-flash directly during `start_task` for the related-work check.
```

Components, each with one job:

| Unit | Does | Depends on |
|---|---|---|
| `Coordinator` | Owns all state for one repo; grants and releases claims; runs the task state machine; holds the merge lock; pushes live updates | DO SQLite |
| `tools` | What each agent tool does: claim, fork, related-work check, submit, verdict | Coordinator, RepoHost, Decider |
| `mcp` | Offers the tools over MCP; authenticates the agent | `tools` |
| `RepoHost` | Thin wrapper over the Artifacts binding: fork, tokens, read commits, trees, files | Artifacts binding |
| `git/` | Git from first principles: objects, packfiles, the push protocol, tree diff (`changes`), tree overlay | none |
| `diff` | Unified diffs of the changed files, for the models and the board | RepoHost |
| `checks` | The mechanical checks (claim coverage, empty change, size cap) and the decision rules | none (pure) |
| `Decider` | Asks the decision model typed questions: related work at claim time, triage at review time | Workers AI binding |
| `Reviewer` | Turns goal, claim, diff and signals into a verdict | Anthropic API |
| `MergeEngine` | Applies an approved submission to `main` and writes the trailers and the note | RepoHost, `git/` |
| `pipeline` | The review of one submission as a sequence of named steps | all of the above |
| `ReviewWorkflow` | Runs the pipeline's steps durably, with retries | `pipeline`, Workflows |
| `seed` | Writes the first commit of a repository registered from files | RepoHost, `git/` |
| `api` + board | Human view and actions | Coordinator |

`RepoHost`, `Decider`, `Reviewer` and `MergeEngine` are interfaces, and the pipeline takes its step runner as an argument. Tests use in-memory stand-ins. A Sandbox-based `MergeEngine` that runs real git and tests can replace the in-Worker one later without touching anything else.

**Stack:** TypeScript; Workers; Durable Objects with SQLite; Workflows; Artifacts binding; Workers AI binding; `createMcpHandler` from Cloudflare's Agents SDK with `@modelcontextprotocol/server`, stateless over Streamable HTTP (`McpAgent` is deprecated); the Anthropic SDK; `diff` for unified diffs; React, Vite and Tailwind for the board, served as Workers static assets. The git layer has no dependencies.

## 6. Data model

All tables live in the Coordinator's SQLite. Times are Unix milliseconds.

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,            -- "a-" + short id
  name TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL UNIQUE,  -- SHA-256 of the API key
  created_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,            -- "t-" + short id
  agent_id TEXT NOT NULL REFERENCES agents(id),
  goal TEXT NOT NULL,
  state TEXT NOT NULL,            -- active | in_review | escalated | merged | expired | abandoned | closed
  fork_name TEXT NOT NULL,        -- "<repo>--<task id>"
  base_sha TEXT,                  -- fork head at creation; null until the fork is ready
  cycle INTEGER NOT NULL DEFAULT 1,
  claim_ttl_ms INTEGER NOT NULL,  -- the lifetime asked for, used each time the clock resets
  claim_expires_at INTEGER NOT NULL,
  merge_sha TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE claims (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  path TEXT NOT NULL,             -- normalised; a trailing "/" means a directory
  PRIMARY KEY (task_id, path)
);

CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  cycle INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  summary TEXT NOT NULL,
  triage TEXT,                    -- the triage answers as JSON, or null
  created_at INTEGER NOT NULL
);

-- A submission can collect several verdicts: an escalation, then a person's decision.
CREATE TABLE verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  decision TEXT NOT NULL,         -- approve | reject | escalate
  source TEXT NOT NULL,           -- check | reviewer | human | merge | system
  body TEXT NOT NULL,             -- full verdict JSON
  created_at INTEGER NOT NULL
);

CREATE TABLE related (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  other_task_id TEXT NOT NULL REFERENCES tasks(id),
  relation TEXT NOT NULL,         -- duplicate | coupled
  confidence REAL NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, other_task_id)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  task_id TEXT,
  agent_id TEXT,
  body TEXT NOT NULL,             -- JSON
  created_at INTEGER NOT NULL
);

CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- keys: repo_name, default_branch, protected_paths (JSON array),
--       claim_ttl_minutes, max_cycles, merge_lock (JSON: task id + expiry, or null),
--       decider (JSON: enabled, related_min_confidence, risk_high_min,
--                interface_change_min)
```

A claim is live when its task is `active`, `in_review` or `escalated`. An `active` task whose `claim_expires_at` has passed becomes `expired` on the next Coordinator call or alarm, which makes its claim dead.

Event types: `task_started`, `claim_conflict`, `related_work`, `claim_expanded`, `submitted`, `check_failed`, `triage`, `verdict`, `merged`, `escalated`, `human_decision`, `expired`, `abandoned`, `stale`, `catching_up`, `decider_unavailable`.

## 7. Task lifecycle

```
            start_task
                │
                ▼
   ┌───────▶ active ──── claim TTL passes ───▶ expired ──┐
   │            │  │                                      │ submit
   │     submit │  └── abandon ──▶ abandoned              │ (claim re-acquired
   │            ▼                                         │  if still free)
   │        in_review ◀──────────────────────────────────┘
   │        │   │   │
   │ reject │   │   └── escalate ──▶ escalated ── human: approve ──▶ merged
   │ (cycle+1)  │                         │
   └────────────┘                         ├── human: send back ──▶ active (cycle+1)
                │ approve                 └── human: close ──────▶ closed
                ▼
             merged
```

- A reject when `cycle` already equals `max_cycles` (default 3) escalates instead.
- A merge that finds its paths changed on `main` (§11.2, step 3) sends the task back: `in_review` → `active` with `cycle + 1`, with a reject verdict from the merge that tells the agent to catch up with `main` (§9, `sync_with_main`) and submit again.
- A review step that fails for good escalates the submission with the error attached, so `in_review` always ends.
- `merged`, `abandoned` and `closed` are final. Their claims are released. Forks are kept, never deleted.

## 8. Claims

**Paths.** A claim path is repository-relative, uses `/`, has no leading `/`, and contains no `.` or `..` segments. A path ending in `/` claims the directory and everything under it. Anything else claims exactly one file. No globs.

**Overlap.** Two paths overlap when they are equal, or when one of them, taken as a directory, contains the other. `src/api/` overlaps `src/api/users.ts`. So does `src/api`, claimed as a file: git cannot hold both a file `src/api` and anything under `src/api/`, so the two claims cannot both be carried out. `src/api` does not overlap `src/api2.ts`.

**Granting.** A claim request is granted only if none of its paths overlaps any path of any other live task. The check and the insert happen inside one Coordinator call. A Durable Object processes one call at a time and the call makes no awaits between check and insert, so two agents cannot both be granted the same path.

**Conflict response.** When a request is refused, the agent receives every blocking task: the holder's agent name, goal, the overlapping paths, when it started, and when its claim expires. It receives no fork. A `claim_conflict` event is recorded. The agent decides whether to narrow its paths, pick other work, or retry later.

**Lifetime.** `claim_ttl_minutes` defaults to 120. `start_task` may ask for up to 480. A successful `expand_claim` or `submit` resets the clock. While a task is `in_review` or `escalated` its claim does not expire.

**Coverage rule.** Every path a submission changes, adds or deletes must be covered by the task's claim. This is checked at review time (§10) and is what makes a claim binding.

**Related work.** Path overlap misses two agents doing connected work in different files. After a claim is granted, `start_task` asks `clef-flash` how the new task relates to each other live task, in one call:

- **State:** `{ new_task: { goal, paths }, live_tasks: [{ id, agent, goal, paths }] }`. At most the 64 most recently started live tasks, because a request holds 64 questions.
- **Questions:** one `choice` per live task, keyed by its task id, with these options:
  - `independent`: the two tasks do not affect each other;
  - `duplicate`: both tasks implement the same change;
  - `coupled`: one task relies on code or behaviour the other is changing.
- **Rule:** a live task is reported when its answer is not `independent` and the probability the model gives that answer is at least `related_min_confidence` (default 0.5). That probability is what the agent and the board are shown as the confidence. Clef's own `confidence` field is not used: it measures how concentrated the answer is across all the options, and is 0.28 for an answer that is 65% "coupled".

Each reported task is returned to the agent as a warning, stored in `related`, and recorded as a `related_work` event. The relation is stored for both tasks: the task that claimed first is told with the answer to its next `submit` or `get_verdict`, which return `related` as well. It is advisory: the claim stays granted whatever the answer.

The call is made by the Worker, in parallel with waiting for the fork, and never inside the Coordinator's grant. It has a 2-second timeout. If it fails or times out, `start_task` succeeds with no warnings and a `decider_unavailable` event is recorded.

## 9. Agent interface

Endpoint: `POST https://<worker>/mcp/<repo>` with `Authorization: Bearer <agent key>`.

| Tool | Input | Result |
|---|---|---|
| `start_task` | `goal` (string), `paths` (string[]), `ttl_minutes?` | Granted: `task_id`, `remote`, `token`, `branch`, `base_sha`, `paths`, `claim_expires_at`, `clone_command`, `push_command`, `related[]` (each with `task_id`, `agent`, `goal`, `paths`, `relation`, `confidence`), and `related_check` (`ok`, `unavailable` or `off`). Refused: `conflicts[]` |
| `expand_claim` | `task_id`, `paths` | Granted: the full claim and its new expiry. Refused: `conflicts[]`; the existing claim is unchanged |
| `submit` | `task_id`, `summary` | `submission_id`, `cycle`, `head_sha`, `status` (`in_review`, or `escalated` if the review could not be started), `related[]` |
| `get_verdict` | `task_id`, `wait_seconds?` | `state`, `cycle`, `paths`, `related[]`, and the latest verdict if any; `merge_sha` once merged. While the task is in review, or waiting for a person, the call waits for the state to change, for `wait_seconds` (default 20, at most 30) |
| `sync_with_main` | `task_id` | `remote`, `branch`, `main_head`, `token` (read-only, for the main repository, 10 minutes), and `sync_command`, a `git pull --no-rebase --no-edit` that merges the current `main` into the fork. Only for a task that is `active` or `expired` |
| `whats_happening` | none | Live tasks with agent, goal, paths and state; the last 10 merges |
| `abandon` | `task_id` | `abandoned: true` |

Every result is JSON in one text block. A refusal or failure is `{error: {code, message, retryable}}` with the tool call marked as an error.

Behaviour:

- `start_task` grants the claim first, then forks with `defaultBranchOnly: true`, waits for the fork to be ready (polling with backoff, up to 20 seconds), reads the fork's head as `base_sha`, and mints a write token for the fork with a 24-hour TTL. Artifacts runs one fork of a repository at a time, so a fork that is refused because another is running is tried again on the same schedule. If the fork does not become ready in time, the claim is released and the tool returns a retryable error.
- `clone_command` and `push_command` are complete git commands that carry the token in `http.extraHeader`, so the agent never puts it in a remote URL.
- `submit` records the fork's current head as `head_sha`. Review and merge use that exact commit; later pushes do not affect the submission. It fails if `head_sha` equals `base_sha`, or if a submission for the task is already in review.
- `submit` also sets the task's `base_sha` again: the newest commit of `main` that `head_sha` contains, found by walking back from `head_sha` over every parent until a commit of `main` is reached (`src/git/ancestry.ts`). For a fork that never merged `main` this is where it was forked. For one that caught up it is the commit it caught up to, so the review sees the task's own change and not what the merge brought in. If no commit of `main` is found within 500 commits, `submit` fails and names `sync_with_main`.
- `sync_with_main` gives the agent a way to read `main` and nothing more. The fork stays the only place the agent can write. A `catching_up` event is recorded.
- `submit` on an `expired` task re-requests the same claim. If it is still free the task continues to review; otherwise the tool returns the conflicts.
- A tool call for a task owned by a different agent is refused.
- Tool descriptions tell the agent the working loop: claim, clone, work, push to the fork's `main`, submit, call `get_verdict` until there is an outcome, and on reject fix and submit again.
- `get_verdict` waits on the server because a headless agent has no way to pause between calls: told to "check again in 15 seconds", it ends its turn and never sees the verdict. It waits while a person is deciding for the same reason: an agent that stops at `escalated` is not there to act on a note when its work is sent back.

## 10. Review pipeline

One `ReviewWorkflow` run per submission. Each step is a Workflow step with retries. The steps themselves live in `pipeline.ts` as a plain function that takes a step runner, so the same code runs under a Workflow in production and under an immediate runner in tests. The run's id is derived from the repository and the submission, so a submission cannot be reviewed twice.

**Step 1: changes.** Compute the changed paths between `base_sha` and `head_sha` in the fork by walking both trees and skipping subtrees with equal hashes. Output: a list of `{path, status: added | modified | deleted, base, head}`, where `base` and `head` are each a file mode and blob id, or null.

**Step 2: mechanical checks.** No model call. The first failure ends the review. Coverage, emptiness and the file count are checked before any diff is built; the diff's size and content are checked once it exists.

| Check | Fails when | Outcome |
|---|---|---|
| Empty | No paths changed | `reject` |
| Coverage | A changed path is not covered by the claim | `reject`, listing the uncovered paths and suggesting `expand_claim` |
| Size | More than 50 changed files, or more than 100 KB of diff text, or a binary file or submodule link changed | `escalate`, with the reason |

A check failure is stored as a verdict with `source: "check"` and counts as a cycle.

The diff is a unified diff per changed file in git's patch format, built from the base and head blobs. The 100 KB cap keeps it near 30,000 tokens, well inside Clef's context, so the triage input is never silently truncated.

**Step 3: triage.** One call to `clef` with the state `{ goal, claim, summary, files: [{ path, status, diff }], related_tasks }` and five questions:

| Id | Type | Question | Levels |
|---|---|---|---|
| `goal_fit` | `score` | How well does the diff accomplish the stated goal? | 0 does not address it; 1 partly; 2 with gaps; 3 fully |
| `risk` | `score` | How risky is this change? | 0 cosmetic: comments, docs, formatting; 1 low: local logic; 2 medium: shared logic or data handling; 3 high: security, auth, data loss, irreversible effects |
| `unrelated_changes` | `noul` | Does the diff contain changes unrelated to the stated goal? | |
| `interface_change` | `noul` | Does the diff change the name, the parameters, the return type or the response shape of an existing exported function, type, route or schema? | |
| `leftovers` | `noul` | Does the diff contain debug output, commented-out code, placeholder TODOs, or credentials? | |

The answers are stored with the submission and recorded as a `triage` event. The call has a 5-second timeout and one retry. If it fails, triage is recorded as unavailable, the review continues without it, and the triage rule in step 5 does not apply.

Questions that need counting, arithmetic or dates are never asked of the model; those stay in `checks`.

**Step 4: review.** Send the reviewer the task goal, the claim, the agent's summary, the diffs, the triage answers, the related tasks, and the repo's `AGENTS.md` from `main` if it exists. When `interface_change` is at or above its threshold, the reviewer is told to look for callers that the change would break.

A diff alone leaves the reviewer guessing about the code around it, and its first real verdicts said so ("I cannot see the callers"). So it has two tools over the fork at the submitted commit (`src/lookup.ts`): `read_file`, which returns a file with numbered lines or lists a directory, and `search_code`, which returns the lines that contain a piece of text. It may make eight lookups; after that the request allows no tool and it must decide. What it looked up is stored in the verdict as `lookups` and shown on the board.

For a second or later attempt it is also given what the previous attempt was told, and by whom: the reviewer's issues, a check's message, the merge's message, or a person's note. It judges whether that was dealt with.

The reviewer returns:

```json
{
  "decision": "approve | reject | escalate",
  "summary": "one paragraph",
  "issues": [
    {
      "severity": "critical | major | minor",
      "path": "src/x.ts",
      "line": 47,
      "description": "what is wrong",
      "suggestion": "how to fix it"
    }
  ]
}
```

The stored verdict is the reviewer's output plus the triage and a shadow field:

```json
{
  "triage": {
    "model": "clef",
    "goal_fit": { "score": 2.8, "confidence": 0.81 },
    "risk": { "score": 1.1, "confidence": 0.58, "high": 0.03 },
    "unrelated_changes": 0.04,
    "interface_change": 0.12,
    "leftovers": 0.02
  },
  "shadow": { "would_auto_approve": true }
}
```

`risk.high` is the probability the model gives to the highest level of risk.

`would_auto_approve` is true when `risk.score` is below 1.5, `goal_fit.score` is at least 2.4, and each of the three `noul` answers is below 0.3. It has no effect on any decision. It exists so the board can show how often the decision model alone would have agreed with the final outcome, which is the evidence needed before ever letting it skip the reviewer.

The reviewer is the Anthropic Messages API with model `claude-opus-5-5`, set by the `REVIEW_MODEL` variable; the key is the `ANTHROPIC_API_KEY` secret. Output is constrained to the schema with structured outputs and then validated again in code. Output that fails validation is retried twice, then the submission escalates.

The request opts into the server-side fallback beta, which lets the API answer on another model when a safety classifier declines the request; the verdict records which model answered. If the reviewer still declines, that is treated as "cannot judge": the submission escalates with the reason.

A step that fails after its retries, in review or anywhere else, is stored as an `escalate` verdict with `source: "system"`, the step's name and the error.

**Step 5: decide.** The platform decides, using the verdict and the triage as input. The first rule that matches wins:

1. Reviewer says `reject`, or says `approve` with a `critical` issue → reject. If `cycle` equals `max_cycles`, escalate instead.
2. Reviewer says `escalate` → escalate.
3. Any changed path is under a protected path → escalate.
4. Triage flags the change → escalate, naming the signal and listing the task's related live tasks. A change is flagged when any of these holds:
   - `risk.high`, the probability that the change is high risk, is at least `risk_high_min` (default 0.3);
   - `interface_change` is at least `interface_change_min` (default 0.6).
5. Otherwise → merge.

So a human sees only changes the reviewer would have merged, or could not judge. Rejections go back to the agent first.

The thresholds, and the wording of the interface question, were set from Clef's answers on ten cases on 2026-10-02: `docs/clef-calibration.md` has the numbers. Ten cases is a small sample, so they stay config values, to be adjusted from the shadow data.

Default protected paths: `.github/`, `wrangler.jsonc`, `wrangler.toml`, `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `.env`, `migrations/`. Set per repo at registration.

**Step 6: merge.** See §11.

An escalation ends the workflow run. When a human approves it, the Coordinator starts a new run for the same submission that performs only step 6. `send_back` stores the human's note as a reject verdict with `source: "human"`; `close` ends the task.

On reject, the task returns to `active` with `cycle + 1`, the claim clock resets, and the agent reads the issues through `get_verdict`.

## 11. Merge

### 11.1 Why no three-way merge

The claim is exclusive and the coverage check has passed, so every changed path belongs to this task alone. Nobody else can have changed those paths on `main` since the fork was taken. Merging is therefore an overlay: take the current `main` tree and replace only the changed paths with the fork's versions. Other agents' merges touch other paths and are preserved untouched. There is no textual conflict to resolve.

### 11.2 Algorithm

Artifacts has no merge, and a Worker has no git. The merge is done with git's own formats, written from first principles in `src/git/`, and it never clones: it reads the trees along the changed paths, builds the new objects itself, and pushes them in one small pack.

1. Acquire the repo's merge lock from the Coordinator. One merge at a time; the lock expires after 2 minutes. A run that cannot get the lock sleeps 2 seconds and asks again.
2. Mint a write token for the main repo with a 300-second TTL. Read the refs the git server advertises to find the head of `main`, and read that commit's tree id through the binding.
3. **Overlay with a base drift check.** Walk the tree of `main` along each changed path, reading only the trees on the way. For each changed path, compare what `main` holds (file mode and blob id) with the submission:
   - equal to `base` (or absent, if the path was added): untouched; replace it with `head`, or remove it;
   - equal to `head` (or absent, if the path was deleted): already applied by an earlier attempt of this merge;
   - anything else: the claim lapsed and someone else changed the path. The submission is stale: the task goes back to its agent with a reject verdict telling it to call `sync_with_main`, merge the current `main` into its work, and submit again.

   If every path is already applied, find the commit on `main` carrying this task's `Dibs-Task` trailer and continue from step 7.
4. Build the objects: a blob for each added or modified file (its content read from the fork through the binding and checked against its id), every tree from the changed paths up to the root, and the commit. File modes are carried. A submodule link has no content to carry and is copied as a link.
5. The commit's author is the agent (`<agent name> <agent-name@agents.dibs.invalid>`); its committer is `dibs`; its one parent is the head read in step 2. The message is the first line of the goal, the agent's summary, and the trailers in §11.3.
6. Write the objects into a packfile and push it to `main` with git's HTTP push protocol. The push names the head read in step 2 as the old value of the ref, so the server refuses it if `main` has moved. If it is refused for that reason, repeat from step 2 once.
7. Add a note on the merge commit in `refs/notes/dibs` holding the verdict JSON, pushed the same way.
8. Tell the Coordinator: task becomes `merged` with `merge_sha`, the claim is released, the lock is released, a `merged` event is broadcast.

If step 7 fails, the merge stands; the verdict is still in the Coordinator, and the `merged` event says the note was not written. If the workflow dies holding the lock, the lock expires and the retried step starts again from step 1. The retry is safe because step 3 recognises a change that has already landed and does not commit it twice.

The pack holds only objects that are new, so the cost of a merge follows the size of the change and not the size of the repository.

### 11.3 Trailers

```
Dibs-Task: t-7f3k2a
Dibs-Agent: claude-auth
Dibs-Claim: src/auth/, test/auth.test.ts
Dibs-Verdict: approve; reviewer=claude-opus-5-5; cycle=2
Dibs-Fork: demo-app--t-7f3k2a@<head_sha>
```

Trailers travel with every clone and show in `git log`. The note carries the detail.

### 11.4 Working alongside Entire

Every trailer found on the task's own commits is copied onto the merge commit, de-duplicated. Those are the fork's commits from `head_sha` back to `base_sha`, stopping at any commit that is on `main`: a fork that caught up holds other tasks' merge commits too, and their trailers are not this task's. This keeps Entire's checkpoint link intact through the merge. Forks are kept, so session data an agent pushed there stays reachable through `Dibs-Fork`.

### 11.5 Known limits

- A task lands as one commit. The agent's own commits stay in its fork.
- The merge holds the changed files and the trees along their paths in memory. That is bounded by the review's own limits (50 files, 100 KB of diff), not by the size of the repository.
- The list of changed paths is the result of one Workflow step, which may be at most 1 MiB. A submission that changes several thousand paths exceeds it and escalates as a failed step, before the size check can say so more helpfully.
- A fork does not follow `main` on its own. An agent catches up when a verdict or a person tells it to (`sync_with_main`, §9); nothing does it for the agent, and a conflict in that merge is the agent's to resolve.
- Path claims do not prevent semantic breaks, such as one task changing a function that another task's files call. Two things reduce the risk without removing it: the related-work warning at claim time, and the `interface_change` signal, which escalates such a change to a human. Both depend on a model that is unproven on code. Running tests is the real fix and is out of scope (§17).

## 12. Board and HTTP API

All `/api` routes require `Authorization: Bearer <ADMIN_TOKEN>`.

| Route | Purpose |
|---|---|
| `POST /api/repos` | Register a repo from `files` (dibs writes the first commit) or from `import_url`, an HTTPS git URL. Optional: `protected_paths`, `max_cycles`, `claim_ttl_minutes`, `decider_enabled`. Safe to repeat |
| `GET /api/repos` | List registered repos |
| `POST /api/repos/:repo/agents` | Create an agent; returns its key once, with the MCP URL |
| `GET /api/repos/:repo/state` | Snapshot: config, agents, tasks with claims and latest verdicts, recent events, the shadow tally |
| `GET /api/repos/:repo/ws` | WebSocket; one message per new event. A browser cannot set a header on a WebSocket, so the board offers the token as a subprotocol (`dibs`, `token.<base64url>`). It is never put in the URL, where it would be written to request logs |
| `POST /api/repos/:repo/escalations/:taskId` | `{decision: "approve" \| "send_back" \| "close", note?}` |
| `GET /api/repos/:repo/tasks/:taskId/diff` | The diff of the task's latest submission, for the board |
| `POST /api/repos/:repo/read-token` | A read-only git token for the main repo, valid for an hour |

The list of repos is kept in a small registry Durable Object.

The board is one page per repo. Its regions, by the names they carry on screen:

- **Who has dibs:** the claimed paths as a tree, one row per claim: path, agent, goal, state, time left. A refused claim appears for a short while under the row that blocked it. Related tasks are named on the row, as a duplicate or as coupled.
- **What just happened:** events as they happen: refusals, related-work warnings, submissions, failed checks, triage signals, verdicts, merges.
- **Waiting for you:** each escalation with the reason it escalated, the reviewer's verdict, the triage signals against their thresholds, the diff, and approve, send back, and close. This is the one place the board uses its loud colour.
- **Landed on main:** recent merges with their commits.
- **Shadow tally:** one line in the header: in how many reviewed submissions `would_auto_approve` matched the final outcome.

The board loads a snapshot and reloads it on each WebSocket event. The human signs in by pasting the admin token, which is kept in `localStorage`. `/?mock` shows the board on built-in sample data without a server.

## 13. Authentication

- **Agents:** an API key per agent, shown once at creation, stored as a SHA-256 hash. Scoped to one repo.
- **Humans:** one `ADMIN_TOKEN` secret.
- **Git:** agents receive a write token for their own fork only. Write tokens for the main repo are minted by dibs for its own use, live 300 seconds, and are never returned to any caller. Agents that need to read `main` directly get nothing extra: their fork already contains it. A person can ask the API for a read-only token for the main repo, to look at it with their own git.

## 14. Error handling

- Tool errors return `{error: {code, message, retryable}}`. Codes: `conflict`, `not_found`, `not_owner`, `bad_state`, `invalid_path`, `invalid_input`, `already_exists`, `fork_not_ready`, `nothing_to_submit`, `not_registered`, `internal`.
- Artifacts errors `FORK_IN_PROGRESS`, `IMPORT_IN_PROGRESS` and `CREATE_IN_PROGRESS` are retried with backoff. `MEMORY_LIMIT` during a merge escalates the submission with that reason.
- A Workflow step that exhausts its retries escalates the submission with the error attached, so no task is left stuck in `in_review`. Triage is the exception: its failure is recorded and the review continues. A review that cannot even be started escalates the submission in the same way.
- The decision model is never required. With `decider.enabled` false, or when a call fails, `start_task` returns no warnings and step 5 skips its triage rule. Every other behaviour is unchanged.
- The Coordinator sets an alarm for the moment the next claim runs out, and expires claims then. It also expires them at the start of any call that depends on them. A merge lock carries its own expiry and is checked when the next merge asks for it.

## 15. Testing

The suite runs in two places, as two Vitest projects.

In workerd, with the Coordinator as a real Durable Object on real SQLite, and stand-ins for what cannot run in a test (Artifacts, Workers AI, Workflows, the Anthropic API):

- **Pure:** path normalisation and overlap; trailer parsing and de-duplication; the decision rules in §10 step 5, including each triage threshold at and either side of its boundary; the `would_auto_approve` rule; building the related-work and triage questions and reading their answers; the mechanical checks; the reviewer's prompt and its handling of invalid output and refusals.
- **Coordinator:** grant and refuse; two simultaneous overlapping requests yield exactly one grant; expiry; every transition in §7 and every illegal transition refused; merge lock exclusivity and expiry; the queries the board uses; events over a WebSocket.
- **Pipeline, with stand-ins for `RepoHost`, `Decider`, `Reviewer`, `MergeEngine`:** each outcome path: coverage reject, size escalate, reviewer approve, reviewer reject, max cycles, protected path, each triage flag, triage unavailable, stale base, human approve, human send back, and a failure in each step.
- **Tools:** a coupled task is reported, to both tasks; a low-confidence answer is not; a failing or slow `Decider` still returns a granted claim; a fork that is not ready, or a repository busy with another fork, is waited for; `get_verdict` waits through a review and through a person's decision; `sync_with_main` and the base a submission is given after a catch-up.
- **The reviewer's lookups:** reading a file, listing a directory, searching, the limits on each, and that every tree and file is read once however many lookups are made; the tool loop of the reviewer, including its limit of eight lookups.
- **MCP and HTTP:** the tools through a real MCP client over Streamable HTTP; every API route, including authentication.

In Node, where the real git is the oracle for `src/git/`:

- objects against `git hash-object`, `git write-tree` and `git commit-tree`; packs through `git unpack-objects --strict` and `git fsck`;
- tree diff against `git diff-tree`, overlay against `git merge-tree`, unified diffs through `git apply`;
- the push, the refusal of a push that names an out-of-date head, the merge engine and the seeding of a first commit, all against `git http-backend` served over HTTP.

**The whole loop on one machine:** `pnpm local` runs the Worker as deployed under `wrangler dev`, with the real Durable Objects and the real Workflow, and stand-ins for the three services that cannot run locally (`test/local/`). The Artifacts stand-in keeps real bare repositories behind the binding's own methods and error codes and serves them with `git http-backend`, with repo-scoped tokens. The Clef and reviewer stand-ins follow fixed rules. `pnpm test:local` runs `scripts/e2e.ts` against it. This exercises everything in `src/` together, including the pack push from the Workers runtime to a real git server. It says nothing about how the real services behave.

**End to end, against a real Artifacts namespace:** `scripts/e2e.ts` registers a repo, creates agents, and drives the demo scenario, plus one change to a protected path, with scripted git pushes in place of real agents. It uses the real reviewer and the real Clef. It asserts exact outcomes for the paths decided by code (refused claim, coverage reject, protected path) and only that a final state is reached for the paths decided by a model. It also asks Artifacts directly whether it refuses a push that names an out-of-date head. This is the check that V1 to V4 hold.

The stand-ins for the binding's handles refuse to be used after they are disposed, as the real ones do (`test/helpers/disposable.ts`). The first run on real Artifacts failed on exactly that, in a step that returned a promise from inside a `using` block, and no test could have seen it before.

The demo video's scripts are tested where they can leak or mislead (§16): what is shown of an agent's log, and the arithmetic that puts the pictures and the narration on one clock.

Tests are written before the code they cover.

## 16. Demo scenario

A seeded repo, `demo-app`: a small TypeScript HTTP service with a router, a data layer and tests. Five agents are launched together, each as a headless local coding agent with one goal. The goals are chosen so the video shows every path:

| Agent | Goal | What the board shows |
|---|---|---|
| 1 | Add `GET /users/:id` under `src/routes/users/`, calling `findUser` | Clean: claim, approve, merge |
| 2 | Add rate limiting, also wanting `src/routes/users/` | Refused on overlap with agent 1; narrows to `src/middleware/` and proceeds |
| 3 | Fix pagination in `src/services/`; the second cause of the bug is in `src/utils/numbers.ts`, outside its claim | Coverage reject; calls `expand_claim`; resubmits; merges. An agent that notices in time expands its claim before submitting, which is the intended behaviour and shows the same thing |
| 4 | Add input validation with a deliberate flaw in the first attempt | Reviewer reject with issues; fixes; approved on cycle 2 |
| 5 | Change `findUser` in `src/db/users.ts` to return a result object | Warned at claim time that it is coupled with agent 1, and agent 1 is told as well. At review, whichever of the two would break the other goes to a person, or both do. The person sends one back with a note; its agent catches up with `main`, changes its code to fit, and submits again |

The protected-path rule is covered by the end-to-end test and not shown in the video.

It ends with `git log` on `main` showing five commits with trailers, and `git notes --ref=dibs show` on one of them.

`scripts/setup-demo.ts` registers the repo from `demo-app/` and creates the five agents with an MCP configuration each. `scripts/demo.sh` launches them as headless Claude Code sessions, a few seconds apart so that agent 1's claim is in place before agent 2 asks. Their goals are in `scripts/prompts/`. The same scenario with scripted pushes is the end-to-end test.

What the models do is not scripted. The refused claim and the coverage check are decided by code and happen every time; the rest depends on the agents, Clef and the reviewer, and a run can differ from the table.

**The video.** `video/record.ts` registers a fresh repository on a deployment, starts the five agents, and films a page that shows three things: what each agent is doing, read from its session log; the live board; and the narration as captions. The narration follows the events of the run, so it says what happened in that run and not what was expected to. A person's decisions are played by the script, through the board's own buttons: it approves the change to `findUser` and sends the route back with a note to catch up with `main`, or, when the route has already landed, sends the change to `findUser` back with a note to update the route as well. The video says that this part is scripted, and that agent 4 is told to leave a check out. `video/build.ts` adds cards before and after the run, among them `git log`, the trailers and the note of what landed, read from a plain clone of `main`.

The narration is spoken by Fish Audio, asked in the way an earlier project's scripts ask it: the model named in a header, the reply the sound itself, and patience when it says to wait (`video/voice.ts`). The lines depend on what happens, so they are spoken while the run is filmed; the ones a run is likely to need are spoken before it starts, and every clip is kept under the name of its words and its voice. Without a key the `say` command of macOS is used. The recorder waits for a line to end before the person acts, so the length of the voice's clips sets the pace of that part of the run. For that reason a different voice means a new recording, not a new sound track.

An agent's log holds the tokens it was handed. What the video shows of a log is therefore built from it and never copied: a step is described from its name and a few chosen fields, and a command is shown without its credentials and addresses (`video/agent-log.ts`).

## 17. Out of scope

- A task queue or orchestrator. Humans launch agents with goals.
- Running tests or builds as part of review.
- Refusing a claim because of related work. The related-work check only warns.
- Letting the decision model approve a merge without the reviewer. Its agreement is recorded in shadow only.
- Fine-tuning Clef on the recorded human decisions.
- Agents hosted by the platform.
- Session capture, blame, and search over agent history.
- Glob patterns in claims; waiting queues for contested paths.
- Multiple human users, roles, or single sign-on.
- Event subscriptions. Review is triggered by `submit`; nothing needs push events.

## 18. Build order

The plan was to start with a spike against a real namespace. The account was not available when the build started, so the order changed: everything was built behind interfaces and tested without the platform, with the real git as the oracle for the git layer, and the check against a live account moved to the end.

Built, in this order:

1. The git layer (`src/git/`), `RepoHost` and the merge engine.
2. Coordinator: schema, claims, state machine.
3. `checks`, `diff`, `Decider`, `Reviewer`, then the pipeline.
4. The agent tools and the MCP server.
5. HTTP API, the Workflow and the Worker entry.
6. The board.
7. Demo repo, `scripts/setup-demo.ts`, `scripts/demo.sh`, `scripts/e2e.ts`.
8. README with run instructions, MIT licence.
9. The local stand-ins (`pnpm local`), then `scripts/e2e.ts` and the five-agent demo run against them.

10. **The check against a live account.** Deployed, and `scripts/e2e.ts` passes against it. It found one bug the stand-ins could not show: two review steps returned a promise from inside a `using` block, so the Artifacts handle was released while still in use. The test doubles now fail after disposal, as the real handle does. None of the fallbacks below was needed:

   | Assumption | If it fails |
   |---|---|
   | V1 changed paths through `readCommit` and `readTree` | `changes` reads the trees from a fetched pack instead; its interface is unchanged |
   | V2 Artifacts accepts the pack push | The `MergeEngine` falls back to `isomorphic-git` with an in-memory filesystem, the way Cloudflare documents; if that fails too, to a Sandbox container with real git. Nothing outside the engine changes |
   | V2 Artifacts refuses a push that names an out-of-date head | The merge lock becomes the only guard. Its expiry is raised above the longest a merge step can run, and the engine re-reads the head after pushing |
   | V3 push to `refs/notes/dibs` | The note is dropped; trailers and the Coordinator still hold the verdict |
   | V4 binding inside a Workflow | The pipeline runs from a Queue consumer instead, one message per step |
   | V5 Workers Paid | The account is upgraded before any further work |
   | V6 Clef is usable on these questions | `decider.enabled` is set to false and the two features are left out of the video; nothing else depends on them |
11. The related-work and triage questions were run through Clef on ten cases, five of them the real diffs of the end-to-end run, and the thresholds were set from the answers (`docs/clef-calibration.md`).

12. The reviews were run with the real reviewer, and the five-agent demo was run against the deployment (2026-10-03). Every path in §16 happened as designed: the refused claim, the expanded claim, two rejections fixed and merged on a second attempt, and the two coupled changes escalated by the reviewer, which named the collision. Real reviewer output also showed two things to tidy, both done: the board repeated the reviewer's summary, and commit subjects ran past 72 characters.

Still to do:

13. The video.

## 19. Repository layout

```
dibs/
├── src/
│   ├── index.ts              # Worker entry: routes /mcp and /api; the board is served as static assets
│   ├── deps.ts               # builds the real implementations from the Worker's bindings
│   ├── coordinator.ts        # Durable Object
│   ├── registry.ts           # Durable Object: list of repos
│   ├── tools.ts              # what each agent tool does
│   ├── mcp.ts                # the tools as an MCP server
│   ├── api.ts                # human routes
│   ├── pipeline.ts           # the review, as named steps
│   ├── workflow.ts           # ReviewWorkflow: runs the pipeline durably
│   ├── paths.ts              # normalise, overlap
│   ├── checks.ts             # mechanical checks, decision rules
│   ├── diff.ts               # unified diffs
│   ├── decider.ts            # Decider interface + Workers AI (Clef) implementation, question builders
│   ├── reviewer.ts           # Reviewer interface + Anthropic implementation, with its two lookup tools
│   ├── lookup.ts             # read a file or search the repository at one commit
│   ├── merge.ts              # MergeEngine interface + the pack-push implementation
│   ├── seed.ts               # the first commit of a repository registered from files
│   ├── repo-host.ts          # RepoHost interface
│   ├── artifacts-host.ts     # RepoHost on the Artifacts binding
│   ├── trailers.ts
│   ├── types.ts  ids.ts
│   └── git/                  # objects.ts, pack.ts, remote.ts, changes.ts, overlay.ts, ancestry.ts
├── board/                    # React + Vite + Tailwind
├── test/
│   ├── workers/              # runs in workerd
│   ├── node/                 # runs in Node, against the real git
│   └── local/                # stand-ins for Artifacts, Clef and the reviewer; `pnpm local`
├── scripts/                  # setup-demo.ts, demo.sh, e2e.ts, prompts/
├── video/                    # record.ts films a run of the demo; build.ts makes the video
├── demo-app/                 # the seeded repository's contents
├── docs/superpowers/specs/
├── wrangler.jsonc
├── LICENSE                   # MIT
└── README.md
```

## 20. Prerequisites and cost

- A Cloudflare account on Workers Paid; Wrangler 4.145.0 or later; an Anthropic API key; Node 22.18 or later for the scripts.
- The first deploy passes the two secrets in a file (`pnpm run deploy:first`), because Wrangler will not create a Worker whose required secrets are missing.
- A task costs a few tens of Artifacts operations: the fork, the agent's clone and pushes, the binding reads of the review (commits, trees and blobs along the changed paths), and the merge's two pushes. How Artifacts counts binding reads is not stated in its pricing page, so the number of tasks the included 10,000 operations cover is to be measured on the first real run.
- Each review is one reviewer call over a diff capped at 100 KB.
- The decision model adds little: a related-work check is a few thousand tokens on `clef-flash` (under $0.001), and a triage of a full 100 KB diff on `clef` is about 30,000 tokens (under $0.01).

## 21. Changes made during the build

What differs from the text that was approved, and why.

| Area | Approved | Built | Why |
|---|---|---|---|
| Merge | Shallow clone, commit and push with `isomorphic-git` and an in-memory filesystem | No clone. Trees are read through the binding, objects and a packfile are built in `src/git/`, and the pack is pushed with git's HTTP protocol (§11.2) | It needs no dependency and no filesystem, costs in proportion to the change, and makes the push conditional on the head it was built on. It could also be verified without the platform, against the real git |
| MCP server | "Exact class confirmed when the plan is written" | `createMcpHandler`, stateless | `McpAgent` is deprecated, and the tools need no session |
| Overlap rule | A file claim does not overlap paths under it | It does (§8) | Git cannot hold a file and a directory of the same name, so both claims could not be carried out |
| Stale merge | "A reject verdict telling the agent to start a new task" | The same verdict, and the task is closed (§7) | The task's base is out of date; a new attempt in the same fork would be stale again |
| `tasks.base_sha` | `NOT NULL` | Nullable until the fork is ready | The claim is granted before the fork exists |
| `verdicts` | One per submission | Several per submission, with their own ids, and two more sources: `merge` and `system` | An escalation followed by a person's decision is two verdicts; a stale merge and a failed step need to be told apart from a review |
| Pipeline | Lives in the Workflow | A plain function (`pipeline.ts`) that the Workflow runs | Workflows cannot run in the test pool; this way every path of the review is tested |
| `start_task` | Returns the remote and a token | Also returns ready-made clone and push commands, and says whether the related-work check ran | Agents should not have to work out how to pass a token to git |
| Registering a repo | Empty, or imported | From files (dibs writes the first commit), or imported | A repository with no commit cannot be forked into anything useful |
| HTTP API | Six routes | Two more: the diff of a submission, and a read-only git token (§12) | The board shows the diff; a person can inspect `main` with their own git |
| Alarm | Every minute | At the next claim expiry | Nothing to do in between |
| File modes | Not carried | Carried | The objects are built directly, so it costs nothing |
| Demo, agent 3 | Also edits `src/utils/date.ts` | The second cause of its bug is in `src/utils/numbers.ts` | The agent has a real reason to leave its claim, rather than an instruction to |
| `get_verdict` | Answers at once | Waits for a review that is running (§9) | Found by running real agents: one told to poll every 15 seconds ended its turn instead and never saw its verdict |
| Local run | Not planned | `pnpm local`: the deployed Worker with stand-ins for Artifacts, Clef and the reviewer (§15) | The account was not available, and the first run of the composed system should not also be the first deploy. It found nothing wrong in the Worker and several things wrong in the demo |
| Demo launcher | Not specified | Agents start without the operator's own Claude Code settings, in working directories outside the repository | Personal instructions and plugins leaked into the agents; a git command run before the clone would have landed in dibs's own repository |
| Triage rules | Escalate on a risk score of 2.5, on a risk confidence below 0.5, or on an interface change of 0.7 | Escalate on a probability of high risk of 0.3, or on an interface change of 0.6 (§10) | Clef's confidence turned out to measure concentration, not certainty: the confidence rule would have sent seven of ten ordinary changes to a person. The probability of "high" separates the one dangerous case (0.89) from the rest (0.09 at most) |
| Interface question | "the signature or behaviour of anything that code outside the changed files may call" | "the name, the parameters, the return type or the response shape of an existing exported function, type, route or schema" | Asked about behaviour, Clef called a bug fix an interface change (0.77). With the new wording it scores 0.03, and the real interface changes stay at 0.87 and above |
| Related-work rule | Clef's confidence of at least 0.6 | The probability of the chosen relation of at least 0.5 (§8) | The clearest coupled pair has a probability of 0.65 and a confidence of 0.28, and was never reported |
| Shadow rule | Risk below 1, goal fit at least 2.5, the three probabilities below 0.2 | Risk below 1.5, goal fit at least 2.4, the three probabilities below 0.3 | Ordinary low-risk changes score about 1.0 to 1.4 on risk, so the first rule agreed with almost no approval |
| Build order | Spike first | Platform check last (§18) | The account was not available at the start |
| A fork and `main` | A fork never follows `main`; a stale merge closes the task | `sync_with_main` lets an agent merge `main` into its fork; `submit` finds the task's base again; a stale merge sends the task back (§7, §9, §11) | The first real run ended with two changes that collided and no way for the second to adapt except a new task. This was the limit most worth removing |
| Related work | Reported to the task that claims second | Stored for both; the first is told on its next `submit` or `get_verdict` (§8) | The agent that claimed first is the one whose code will break, and it was the one that was not told |
| `get_verdict` | Waits for a review | Also waits while a person is deciding (§9) | Real agents reported "escalated" and stopped, so nobody was there to act when a person sent the work back |
| Reviewer | Sees the diff | Can also read and search the repository at the submitted commit, eight lookups at most, and is told what the previous attempt was sent back for (§10) | Its real verdicts said "I cannot see the callers". With lookups it names them, and a second review can tell whether a note was followed |
| Workflow run id | `review-<repo>-<submission>` | The repository's name is cut to a slug and followed by a hash of the name | A run id may hold no dots, and a repository name may |
| Board socket | Token in the query string | Token offered as a WebSocket subprotocol (§12) | A token in a URL ends up in request logs |
| Demo video | "A 5 to 10 minute video" | `video/record.ts` films a real run on a deployment and `video/build.ts` assembles the video, narrated by Fish Audio (§16) | A recording made by hand cannot be repeated when the system changes, and this one had to be repeated: three runs, and a change of voice |
