# dibs engine — Design Spec

**Date:** 2026-10-03
**Status:** draft for review
**Supersedes in part:** `2026-10-02-dibs-design.md` (§4, §6–§11 and §17 are revised here; everything not mentioned stands)

This is the design of dibs as an integration engine for a repository that many agents change at once. It starts from what git assumes about who writes code and how, says which of those assumptions agents break, and derives the engine from what is left. The result keeps what dibs already does well (claims before edits, a platform that owns `main`, verdicts written into git) and replaces the parts that the first version's own critique found wanting: file locks that are too coarse, coupling that is guessed rather than known, a reviewer that reads but never runs, a merge that cannot compose, a person who is asked too often, and a conflict that is a rejection instead of a shared problem.

## 1. Goal

A change made by an agent lands on `main` without a person unless a rule, backed by evidence from running the code, says a person is needed. An agent is never refused, held or sent back without being told exactly why and what to do next. Two agents whose work collides are both told, at the earliest moment the collision is knowable, and are given a resolution rather than a loser. Everything the engine decides, and the evidence it decided on, is written where plain git can read it.

The measure of the design is **person-decisions per landed change**, with the time from submit to landing second and wasted agent work third.

## 2. First principles

### 2.1 What git fixed, and what it assumes

Git made divergence cheap: a branch costs nothing, a snapshot is content-addressed, history is a graph. It left convergence to people: a merge is a textual three-way comparison, a conflict is a region a person edits by hand, and "ready" is a human judgement. The platforms built on it (GitHub and its kin) added the pull request: review by reading, checks by running, merge by a person's click.

That stack assumes:

1. **Few concurrent writers**, working at human speed, so collisions are rare and are found at merge time without much waste.
2. **A person resolves conflicts**, so a conflict costs ten minutes, not a whole task.
3. **A person decides readiness**, so changes are batched into pull requests large enough to be worth a person's attention.
4. **Review is reading**, by a person, so it is the scarce step; checks run after the fact and are advisory until a person looks.
5. **Ownership is static** (`CODEOWNERS`), because people's areas change slowly.
6. **Text is the unit of conflict**, because a person can see what two overlapping hunks mean.

### 2.2 What agents change

1. **Writers are many and fast.** Twenty agents on one repository produce in an hour what a team produces in a week. A collision found at merge time throws away a task, not ten minutes.
2. **Agents state intent before they start, and follow a protocol.** An agent calls `start_task` with a goal before it edits. It can be asked to say what it will change and what it relies on, and held to it. People cannot be held to that; agents can.
3. **An attempt is cheap, a loop is the failure.** One rework cycle costs minutes and tokens. Three in a row, each for a reason the agent could not see, is how agent systems fail. Every "try again" must carry the exact reason and the exact fix.
4. **Running is cheaper than reading, and more trustworthy.** A test run costs cents and seconds and does not have opinions. A model reading a diff is a judgement with variance; so is a person. For agents' code, evidence from execution should come before judgement.
5. **The scarce resource is a person's decision.** Not their reading time, their decision. A design is good to the degree that the person decides only what only a person can decide.
6. **Trust is measurable.** The engine sees every attempt and every outcome of every agent in every area. Policy can be a function of that record rather than a constant.
7. **The real conflict is between a contract and its dependents.** Two agents changing the same lines is the easy case and is rare once edits are claimed. The hard case is one agent changing what `findUser` returns while another writes a route that calls it: disjoint files, no textual conflict, broken `main`. Text is a proxy for the conflict that matters.

### 2.3 Why not the two obvious answers

**Fully optimistic (no claims; everyone branches; the engine merges and tests).** Maximises parallelism and wastes the most work: an agent learns at the end that its task is obsolete or must be redone. For human-speed writers that waste is acceptable; for twenty agents it dominates. It also does nothing about principle 7: the merge is clean and `main` is broken until a test says so.

**Fully pessimistic (lock everything you might touch).** No wasted work, no parallelism: every hub file (a routes index, a types file, `package.json`) serialises everyone, and agents cannot know up front everything they will touch.

**Patch theory (Pijul, Darcs) and CRDTs** remove the *textual* part of the problem: patches that do not overlap commute. They do not touch the semantic part, which is the one agents actually have.

The answer is to make the kind of concurrency control follow the **relation** a task has to a piece of code, not the file:

- what a task **changes**, it holds exclusively (nobody else may change it meanwhile);
- what a task **adds to**, it shares (others may add too; the engine composes);
- what a task **relies on**, it pins (nobody is stopped from changing it, but anyone who does is linked to the task, and both are told).

Everything else in this design follows from that and from the eight principles below.

### 2.4 Principles

- **P1 Coordination follows the kind of dependency, not the file.** Three relations: change, add, rely.
- **P2 A collision is found at the earliest moment it is knowable, and again at every later moment where more is known.** At claim time from declarations and the interface index; at submit from the diff; at projection when `main` moves; at the gate from running; last and least, from a model's reading.
- **P3 The engine integrates; agents author.** Carrying a change onto a moved `main` is mechanical and is the engine's job. An agent is asked to work only when meaning has to change.
- **P4 Run before you read.** Evidence from execution comes before a model's or a person's judgement, and is what they judge with.
- **P5 A collision is a shared object with a proposed resolution, not a rejection.**
- **P6 Autonomy is earned per area, from measured outcomes, under a ceiling a person sets.**
- **P7 Every decision and its evidence is written where plain git can read it.**
- **P8 Nobody waits on a person who is not needed, and nothing that needs a person is hidden from them.**

## 3. Concepts

- **Repo, Agent:** as before.
- **Task:** one unit of work by one agent: a goal, a scope, a fork, and its changes.
- **Target:** something a scope entry names. A **path** (`src/auth/`, `src/users.ts`) or an **interface**: a named contract in the code, written `path#name` (`src/users.ts#findUser`) for an exported symbol, or `route:GET /users/:id` for an HTTP route.
- **Scope:** a task's set of entries `(target, relation)`, relation ∈ `change | add | rely`. Replaces the claim.
- **Interface index:** per repo, the exported interfaces of each file with a signature hash, and which files reference each one. Built at registration, updated at every merge.
- **Change:** one submission of a task: base, head, patch id, the scope at submit time, the interface changes declared and detected, the agent's summary. First-class, with its own ref.
- **Projection:** a change carried onto the current `main`: overlay for `change` paths, three-way for `add` paths. Recomputed whenever `main` moves. Status `clean`, `compose` (textual overlap on an `add` path), `stale` (an exclusive path changed under a lapsed scope), or `contract` (an interface the change relies on changed on `main`).
- **Collision:** a record linking two or more tasks over targets, with a kind, a proposed resolution, and a state.
- **Gate:** a run of the repository's declared checks against a candidate commit, in a sandbox. Produces evidence.
- **Evidence:** what was measured about a change, not judged: projection status, gate results, declared versus detected interface changes, dependents of changed interfaces, size.
- **Verdict:** as before: the judgement of a reviewer and of the rules.
- **Area:** a path prefix with a policy. `/` is the default area.
- **Level:** how much the engine may do alone in an area, L0–L3. Each area has a **ceiling** set by a person and, per agent, a **current level** earned from the ledger.
- **Ledger:** outcomes per (agent, area): landed, sent back by the gate, sent back by the reviewer, overridden by a person, reverted.

## 4. Scopes

### 4.1 Targets

Paths follow the rules of the earlier spec (§8 there): repository-relative, `/` for a directory, no globs. An interface target is `<path>#<name>` where `path` is a file and `name` an identifier the index knows or the agent declares, or `route:<METHOD> <pattern>`. Interface targets are normalised by the index (see §5); an unknown name is accepted as declared and marked `declared` rather than `indexed`.

### 4.2 Relations and the conflict matrix

| new ↓ · live → | change | add | rely |
|---|---|---|---|
| **change** | conflict: queue or refuse | conflict: queue or refuse | **link** (contract) |
| **add** | conflict: queue or refuse | allowed; composed at projection | allowed |
| **rely** | **link** (contract) | allowed | allowed |

Overlap of paths is as before (a directory contains what is under it). An interface target overlaps the same interface, and overlaps its file taken with relation `change` (a task that changes the whole file changes the interface too). Two tasks may both hold a file with `add` and each hold a *different* interface in it with `change`: that is function-level exclusivity inside a shared file, and the three-way projection composes their edits (§6.2).

A **link** is not a refusal. It creates a `contract` collision (§7) between the task changing the interface and every live task relying on it, declared or inferred, and both are told in the reply to the call that created the link.

### 4.3 Granting and waiting

A scope request is granted only if none of its `change` or `add` entries conflicts with any live task. Check and insert happen in one Coordinator call, as before.

A refused request may **wait**. `start_task` and `expand_scope` take `wait_seconds` (default 0; at most 30 per call, like `get_verdict`). While waiting, the request is queued per target in order of arrival; it is granted, atomically and all at once, the moment every blocking entry is released, and the waiting call returns the grant. If the call's time runs out first it returns `waiting` with the position, the blocking tasks (agent, goal, state, when their scope expires) and a `request_id` to keep waiting on. A waiting request expires after its own TTL (default the repo's claim TTL) and when its agent calls `abandon`.

Deadlock: a task that holds a scope and waits to expand it is holding-and-waiting. The Coordinator keeps the wait-for graph (which waiting task waits on which holder) and refuses, with the reason, any wait that would close a cycle. The graph is small (live tasks) and the check is a depth-first walk.

### 4.4 Enforcement

- **Coverage** (as before): every path a change touches must be covered by a `change` or `add` entry. Otherwise reject, naming the paths and `expand_scope`.
- **Declared interface changes:** on a file held with `add`, every interface whose signature the index sees changed in the diff must be a `change` target of the task. Otherwise reject: "you changed `findUser`'s signature in a file you hold as `add`; add `src/users.ts#findUser` as `change` (it is free / it is held by agent-two until …) or keep the signature."
- **On a file held with `change`,** no declaration is required: the file is the task's alone. Detected interface changes in it are still recorded as interface changes, so they link to reliers and count under the dependents rule (§7.2) exactly as declared ones do.
- **`rely` is never enforced on the relier.** It is enforced *for* it: any task that declares or is detected to change a relied-on interface is linked to it.

### 4.5 Inferred relations

Agents will not declare everything. The engine fills in what it can know:

- **Inferred `rely`:** every interface that the files in a task's `change`/`add` scope reference, from the index, at the moment the scope is granted or expanded. This is deterministic and needs no model. It is what makes the `findUser` case of the demo visible at claim time: agent-one holds `src/routes/users.ts`, which references `src/users.ts#findUser`; when agent-five asks to `change` that interface, the link exists before either has written a line.
- **Detected interface changes:** at submit, the index extracts signatures from the changed files at `head` and compares with `base`. Changed, removed or renamed exports are detected interface changes, merged with the declared ones and marked `detected`.
- **The decision model's related-work check** stays, as the last backstop for coupling that is neither declared nor visible in references (behaviour shared through configuration, data formats, timing). It now runs on `expand_scope` as well as `start_task`, and its state includes the declared interfaces. `duplicate` answers now have a consequence (§7.3).

Everything inferred is written into the task's scope, marked `inferred`, and shown to the agent in every tool reply and to the person on the board.

### 4.6 Lifetime

As before: a TTL per task, reset by `expand_scope` and `submit`, suspended while the task is in review, escalated or at the gate.

## 5. The interface index

Per repo, in the Coordinator's SQLite:

```sql
CREATE TABLE interfaces (
  path TEXT NOT NULL,
  name TEXT NOT NULL,               -- "findUser", or "GET /users/:id" for a route
  kind TEXT NOT NULL,               -- function | class | type | const | route | declared
  signature_hash TEXT NOT NULL,     -- SHA-256 of the normalised declaration
  since_sha TEXT NOT NULL,          -- the main commit that last changed the signature
  PRIMARY KEY (path, name)
);
CREATE TABLE refs_to (
  path TEXT NOT NULL,               -- the referencing file
  target_path TEXT NOT NULL,
  target_name TEXT NOT NULL,
  PRIMARY KEY (path, target_path, target_name)
);
```

**Extractors** are pure functions `(path, text) → { interfaces: [{name, kind, signature}], references: [name] }`, one per language family, chosen by file extension. Version one is deliberately simple and says so:

- TypeScript/JavaScript: `export` declarations (`function`, `class`, `const|let`, `type`, `interface`, `enum`, `default`) and re-exports; the signature is the declaration up to the body, whitespace-normalised. References: identifiers imported by name from a relative path, resolved to a file by the usual extension rules.
- Python: top-level `def` and `class`; the signature is the `def` line. References: `from .x import y` names.
- Go: exported (capitalised) top-level `func` and `type`; references: package-qualified identifiers from imports in the same module.
- Routes: a per-repo list of regular expressions in the repo's `.dibs/index.json`, with a default for the common `app.get("/path", …)` shapes; the signature is the handler's declaration line.
- Anything else: no interfaces, no references; the file still has path targets. Agents may declare interfaces anywhere.

A later version replaces the regular expressions with tree-sitter grammars compiled to WebAssembly; the table shapes do not change.

**Building:** at registration the engine walks the tree, skipping binary files and files over 256 KB, and extracts in Workflow steps of at most 200 files. **Updating:** at every merge, only the changed files are re-extracted; references *to* a renamed or removed interface are found by text search for the name across the repository (the existing `search_code`), bounded to files the index already lists as referencing that file.

**Limits, stated:** dynamic re-exports, barrels that re-export `*`, reflection and string-keyed dispatch are invisible to the index. The index is a lower bound on coupling. Where it is silent, the gate and the decision model still speak.

## 6. Projection: the engine integrates

### 6.1 What is projected and when

A projection is computed for every change that is submitted and not yet landed, every time `main` moves (after each landing, debounced to one recomputation per 2 seconds through a Coordinator alarm), and once at submit. Its result is stored on the change and shown to the agent and the board.

For every **active** task (not yet submitted), the engine does less and earlier: when a landing changes an interface the task relies on (declared or inferred), the task gets a `contract` collision with a brief (§7.2) and is told at its next tool call. It is not sent anywhere; it is informed while it can still act cheaply.

### 6.2 How

- **`change` paths: overlay**, exactly as in the earlier spec §11.2 step 3. The scope was exclusive, so a path on `main` is either as the change found it or as the change left it. Anything else is `stale`, which can now happen only when a scope expired and was taken by someone else.
- **`add` paths: three-way merge**, line-based (`diff3` semantics, implemented in `src/git/merge3.ts` with no dependencies, like the rest of `src/git/`). Base is the file at the change's base, ours is `main`, theirs is the change's head. Non-overlapping hunks compose; overlapping hunks make the projection `compose` and open a collision (§7.3) carrying the hunks.
- **Structured composition** for paths listed in `.dibs/index.json` as `compose: "json-map"` (the dependency maps of `package.json`, lockfile-free manifests): the three versions are parsed and keys merged; the same key changed to different values is a `compose` collision. This is what lets `package.json` stop being a protected path: dependency additions compose, and the gate runs the install.
- **Contract check:** after the textual step, the engine compares the interface signatures the change relies on at its base with those on the new `main`. Any difference marks the projection `contract` and opens or updates a collision.

A projection's output tree is the **candidate** for that change. It is also pushed to the task's fork as `refs/dibs/projected`, so `sync_with_main` becomes a fetch and a fast-forward of the agent's branch when the projection is clean, and the agent never resolves a textual conflict the engine has already resolved.

### 6.3 Why `main` stays linear

One commit per landed change, parent the previous `main`, as now. Agents reason better over a linear history, `git bisect` works, and reverts are overlays too (§10.4). The agent's own commits are not lost: they are kept under a change ref (§10.1).

## 7. Collisions

### 7.1 The object

```sql
CREATE TABLE collisions (
  id TEXT PRIMARY KEY,              -- "c-" + short id
  kind TEXT NOT NULL,               -- contract | compose | duplicate | stale
  targets TEXT NOT NULL,            -- JSON: the interfaces or paths involved
  task_ids TEXT NOT NULL,           -- JSON: two or more
  state TEXT NOT NULL,              -- open | proposed | accepted | overridden | resolved
  proposal TEXT,                    -- JSON: {order: [task ids], adapts: task id, why}
  resolution TEXT,                  -- JSON: what happened, by whom (engine | agent | person)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

A collision is visible to every task in it (through `get_verdict`, `submit` and `whats_happening`), and on the board's inbox with both changes side by side.

### 7.2 `contract`: provider and relier

Opened when a live task changes an interface another live task relies on, at claim time (declared), at expansion, at submit (detected), or at projection (the interface changed on `main` under a submitted change).

**Proposal rule, deterministic:**

1. If one task has landed, the other adapts. (Nothing to order.)
2. Otherwise the task further along lands first: at the gate before in review before active. The other adapts.
3. Ties: the task that submitted first lands first; if neither has submitted, the **provider** (the one changing the interface) lands first, because the relier then codes against a contract that exists.

The adapting task receives a **brief**: the interface and the diff of its declaration, the provider's summary and goal, the lines in the adapter's own files that reference the interface (from the index and from its diff), and whether the provider has landed. If the provider has not landed, the relier may **peek** (§11): read the provider's current diff, so it can write against the new contract before it lands. The brief is appended to the next verdict the adapting task receives, or returned at once if the task is active.

A `contract` collision resolves itself when the adapting task's next projection is clean and its gate passes. A person may override the order from the board; the override is recorded in both tasks' notes.

**Dependents nobody owns.** When the index shows references to a changed interface in files no live task holds, those are the provider's problem: at level L1 and above the provider is told the files and asked to `expand_scope` to them (they are free) and update them, before any person is asked. The gate then says whether it worked. A person sees this case only at L0, or when the provider says in its summary that the dependents are intentionally left (a `Dibs-Leaves:` trailer the agent may write), which the reviewer then reads.

### 7.3 `compose`, `duplicate`, `stale`

- **`compose`:** two `add` changes overlap textually in a projection. The later-submitted task adapts; its brief carries the overlapping hunks of both and the composed file with conflict markers under `refs/dibs/projected`. The earlier task is not held up.
- **`duplicate`:** the related-work check answers `duplicate` with probability at least `related_min_confidence`. Both are told. The later task is asked, in the reply, to confirm it is distinct (`confirm_distinct`, a flag on its next `submit` or `expand_scope`) or to `abandon`. If both submit without confirming, the later change is held until the earlier lands, then re-projected; a projection with no remaining changes lands as nothing and the task closes as `duplicate`.
- **`stale`:** an exclusive path changed on `main` because the scope lapsed and another task took it. Rare by construction. The lapsed task's change is sent back with the brief of what changed, as now.

## 8. The gate: run before you read

### 8.1 Declaration

A repository declares its checks in `.dibs/checks.json`, a protected path:

```json
{
  "image": "node:22-bookworm-slim",
  "instance": "basic",
  "setup": "corepack enable && pnpm install --frozen-lockfile",
  "checks": [
    { "name": "test", "run": "pnpm test" },
    { "name": "types", "run": "pnpm typecheck" }
  ],
  "timeout_seconds": 600,
  "outputs": [".dibs/out/"]
}
```

A repository without this file has no gate. Its areas are capped at L1 (§9) and the board says why.

### 8.2 Candidates

The engine writes a projection's tree as a commit on a hidden ref of the main repository, `refs/dibs/candidates/<batch id>`, with the existing pack push. The commit is the merge commit that would land: same message, same trailers. If the gate passes, landing is a fast-forward of `main` to that commit with the old value named, as in the earlier spec §11.2 step 6; nothing is rebuilt between passing and landing.

### 8.3 Running

The gate runs on Cloudflare Containers through the Sandbox SDK. One `Sandbox` Durable Object per run, with the Durable Object scheduling policy; the image is the repository's declared image on a dibs base layer that holds git. The run:

1. clones `refs/dibs/candidates/<batch id>` with `--filter=blob:none --depth 1`; the token never enters the container: the Worker's outbound handler adds it to requests for the Artifacts host, as Cloudflare's own sandbox guidance prescribes;
2. runs `setup` once, then each check in order, capturing exit code, duration, and the last 64 KB of output;
3. reads the declared `outputs` (JUnit XML, coverage summaries) if present;
4. stops. The engine records a `gate_runs` row and emits a `gate` event per check.

The container has no secrets, and its network is limited by the outbound handler to the Artifacts host and the package registries named in `.dibs/checks.json` (default: npm, PyPI, the Go proxy).

### 8.4 Batches: scopes as the independence oracle

Speculative merge queues (Zuul, Bors) test changes in queue order because they cannot know which changes are independent. dibs knows: two changes whose scopes do not conflict under the matrix of §4.2, whose projections are both clean, and that have no open collision with each other, are independent by construction.

A **batch** is the set of changes that are ready for the gate (approved by the reviewer, or in an area whose level needs no reviewer), pairwise independent, and at most 8 in number, in submit order. The candidate is a chain: one commit per change, each on the previous. One run tests the head.

- **Pass:** `main` fast-forwards to the head; every change in the batch lands with its own commit; the ledger counts each.
- **Fail:** each change in the batch is run alone, in parallel, in its own candidate on the current `main`. Changes that pass alone form the next batch. Changes that fail receive a `check_failed` verdict with the failing check's output and go back to the agent (cycle + 1). A check that failed in the batch and passed for every member alone is recorded as an **interaction** failure: a `compose`-style collision between the members whose scopes are closest (shared `rely` targets first), for a person if no pairing is found.

Green costs one run per batch; red costs the batch plus one run per member. Containers run in parallel, so the wall time of a red batch is two runs.

**Flakiness:** a check that fails alone and had passed on the current `main`'s own gate is re-run once. A check that passes on re-run is recorded `flaky` and does not block; the board shows a flakiness count per check.

### 8.5 Cost

A `basic` instance is billed for memory provisioned (1 GiB) and CPU used while running. A gate of two minutes is on the order of a tenth of a cent in CPU and under a cent in memory; the first 25 GiB-hours and 375 vCPU-minutes a month are included in the paid plan. Cold starts of a few seconds are hidden behind the review step that precedes the gate; a snapshot of the image after `setup` (Containers snapshots, 30-day retention) cuts them further and is an optimisation, not a dependency.

## 9. Decision: levels and the ledger

### 9.1 Levels

The fixed thresholds of the first version become a policy per **area**. Areas are path prefixes in the repo config; a path belongs to the longest prefix that matches; `/` is the default.

| Level | The engine runs | A person decides when |
|---|---|---|
| **L0** | gate, reviewer | always |
| **L1** | gate, reviewer | the reviewer escalates; a protected path changed; a `contract` collision is open with no accepted proposal; the change alters an interface with dependents no live task owns and the provider has not updated them; P(high risk) ≥ `risk_high_min` |
| **L2** | gate, reviewer | the reviewer escalates; a protected path changed |
| **L3** | gate, decision model; the reviewer only when the model's signals are not clearly benign (the `wouldAutoApprove` predicate of the first version) | the reviewer escalates; a protected path changed |

At every level: a gate failure goes back to the agent, never to a person; a reviewer rejection goes back to the agent; `max_cycles` still escalates. Without a gate, the ceiling is L1.

### 9.2 Ceilings and earning

Each area has a **ceiling** set by a person (default L1). Each (agent, area) has a **current level**, starting at L1 or the ceiling, whichever is lower, and moving by the ledger:

- **Promote one level** when, in the agent's last 10 landed changes in the area, no person overrode the engine (rejected or sent back what the engine would have merged), at most one change was sent back by the gate, and none was reverted within 7 days.
- **Demote one level** on any person override or any revert of the agent's change in the area.
- **L3 readiness** uses the shadow tally of the first version, now kept per area: the decision model alone agreed with the final outcome on at least 95% of the last 40 reviewed changes.

A promotion is **proposed** on the board and takes effect when a person accepts it, unless the area has `auto_promote: true`. A demotion is immediate. Every level change is an event, and every note records the level a change landed under and the ceiling at the time.

### 9.3 What a person sees

The inbox shows only what the level says a person decides, each item with the engine's **proposal** (land; send back with this brief; order these two this way; promote this agent here) and the evidence behind it, and a single accept. An item waiting longer than `person_sla_minutes` (default 60) is marked on the board; it never auto-applies. Agents keep waiting through `get_verdict`.

## 10. Provenance: written where git can read it

### 10.1 Change refs

At landing, the change's own commits (from `head_sha` back to `base_sha`, excluding commits of `main`) are pushed into the main repository in the same pack, and `refs/dibs/changes/<task id>/<cycle>` points at the head. At most 50 commits are carried; beyond that only the head commit is, and the note says so. Forks can then be deleted after 30 days without losing history.

### 10.2 Trailers

The existing trailers stay (`Dibs-Task`, `Dibs-Agent`, `Dibs-Verdict`, `Dibs-Fork`; `Dibs-Claim` becomes `Dibs-Scope`), and these are added:

```
Dibs-Scope: change=src/users.ts#findUser; add=src/users.ts; rely=src/db.ts#query(inferred)
Dibs-Change: <patch id>
Dibs-Interfaces: changed=src/users.ts#findUser; dependents=src/routes/users.ts(agent-one)
Dibs-Gate: pass; batch=b-9k2; checks=test,types; 1m42s
Dibs-Level: L2; ceiling=L3
Dibs-Collisions: c-4a1(contract, provider-first, accepted by engine)
```

### 10.3 The note

The note under `refs/notes/dibs` on each landed commit holds, as JSON: the change (base, head, patch id, scope with each entry's origin), the interface changes declared and detected with their dependents, every projection with its status and time, every collision with proposal and resolution, the gate runs (checks, exit codes, durations, the output excerpt of any failure, flakiness), the triage signals, the reviewer's verdict and lookups, the level and ceiling, and every person's decision with its note. It is the same object the board shows.

### 10.4 Revert

`revert` (a tool and a board action) builds the inverse overlay of a landed change against the current `main`, runs it through the gate in its own batch, and lands it with `Dibs-Reverts: <sha>`. A revert within 7 days is a ledger event for the original change's agent and area.

## 11. Agent interface

Endpoint and authentication as before. Every reply is JSON in one text block; refusals are `{error: {code, message, retryable}}`.

| Tool | Input | Result |
|---|---|---|
| `start_task` | `goal`, `scope: [{target, relation}]` (or `paths: string[]`, meaning `change`), `interfaces_changed?: [{target, how}]`, `ttl_minutes?`, `wait_seconds?` | Granted: as before plus `scope` (with `inferred` entries), `collisions[]`, `related[]`. Waiting: `request_id`, `position`, `blocking[]`. Refused (only when `wait_seconds` is 0): `conflicts[]` |
| `expand_scope` | `task_id`, `scope`, `wait_seconds?` | As `start_task`'s grant or wait. Re-runs the related-work check and the contract linking. `expand_claim` remains as an alias taking `paths` |
| `declare_interface_change` | `task_id`, `target`, `how` | The task's interface changes and any new `collisions[]` |
| `peek` | `task_id`, `other_task_id` | The other task's current diff and summary, read-only, only when a collision or relation links the two tasks. Never a token |
| `submit` | `task_id`, `summary`, `interfaces_changed?`, `confirm_distinct?` | `submission_id`, `cycle`, `head_sha`, `status`, `projection`, `collisions[]`, `related[]` |
| `get_verdict` | `task_id`, `wait_seconds?` | As before plus `projection`, `collisions[]` with briefs, `evidence` (gate), `level`. Waits through review, the gate and a person's decision |
| `sync_with_main` | `task_id` | When the projection is clean: `remote`, `token` (read-only), and a `sync_command` that fetches `refs/dibs/projected` and fast-forwards. Otherwise the collision's brief and the composed file with markers |
| `whats_happening` | none | Live tasks with scopes and states, the queue, open collisions, the last 10 landings |
| `revert` | `task_id`, `sha` | A new task that reverts a landed change, at the agent's current level |
| `abandon` | `task_id` | `abandoned: true` |

The tool descriptions teach the loop and the three relations in a few sentences: *claim what you change as `change`, hub files you only add to as `add`, and what you call but will not touch as `rely`; the engine fills in what you forget and tells you when something you rely on moves.*

## 12. Board

- **Scopes** replaces Claims: one row per live task, entries grouped by relation, inferred entries dimmed, the queue beneath it with positions.
- **Stream** gains `projection`, `collision`, `gate` (per check, with duration) and `level` events.
- **Inbox** shows collisions with both changes side by side and the proposal, escalations with the proposal and the evidence (gate output first), and promotion proposals. One accept per item; override opens the alternatives.
- **Policy** is new: areas, ceilings, current levels per agent, the ledger, flakiness per check, and the model's agreement per area (the shadow tally, grown up).

## 13. Architecture

```
 coding agents ──MCP──▶ Worker ──▶ Coordinator DO (per repo)
                                     │ scopes · queue · index · collisions
                                     │ changes · projections · ledger · events
                                     ├─▶ ReviewWorkflow (per change): changes → checks → diff
                                     │       → index diff → triage → review → decide
                                     ├─▶ GateWorkflow (per batch): plan → candidate → run → land
                                     │       │                                    │
                                     │       ▼                                    ▼
                                     │   Sandbox DO (Containers)            Artifacts (main, forks,
                                     │   clone candidate · setup · checks   refs/dibs/*, notes)
                                     └─▶ board (WebSocket)
 Workers AI: Clef (related work, triage) · Anthropic API (reviewer)
```

New units, each with one job and a pure core:

| Unit | Does | Depends on |
|---|---|---|
| `scopes` | Targets, relations, the conflict matrix, coverage, declared-interface enforcement | none (pure) |
| `queue` | Waiting requests, FIFO per target, atomic grant, wait-for graph | Coordinator |
| `index/` | Extractors per language, signatures, references, build and update | `git/changes`, RepoHost |
| `git/merge3` | Line-based three-way merge and JSON-map composition | none (pure) |
| `projection` | Overlay + three-way + contract check over a `TreeReader`; candidate trees | `git/`, `index` |
| `collisions` | Kinds, proposal rules, briefs | `index`, Coordinator |
| `gate` | Batch planning, candidate push, sandbox run, result parsing, flakiness | Sandbox binding, MergeEngine |
| `policy` | Levels, ceilings, ledger rules, promotion proposals | Coordinator |

`checks` keeps the mechanical checks and `decide()`, which now takes the area's level and the evidence. `MergeEngine` gains `candidate()` and `land()`; `merge()` becomes the two in sequence for repositories without a gate. `Reviewer` receives the gate's evidence in its prompt and is told to spend its lookups on what the tests did not cover.

## 14. Data model additions

```sql
CREATE TABLE scopes (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  target TEXT NOT NULL,             -- path, "path#name", or "route:METHOD pattern"
  relation TEXT NOT NULL,           -- change | add | rely
  origin TEXT NOT NULL,             -- declared | inferred | detected
  PRIMARY KEY (task_id, target, relation)
);
CREATE TABLE waiting (
  request_id TEXT PRIMARY KEY,
  task_id TEXT,                     -- null for a start_task that has no task yet
  agent_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  scope TEXT NOT NULL,              -- JSON
  arrived_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE changes (
  id TEXT PRIMARY KEY,              -- "ch-" + short id; one per submission
  task_id TEXT NOT NULL REFERENCES tasks(id),
  cycle INTEGER NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  patch_id TEXT NOT NULL,
  interfaces TEXT NOT NULL,         -- JSON: declared + detected changes with dependents
  projection TEXT,                  -- JSON: status, candidate tree, collisions, main_sha, at
  created_at INTEGER NOT NULL
);
CREATE TABLE gate_runs (
  id TEXT PRIMARY KEY,              -- batch id
  change_ids TEXT NOT NULL,         -- JSON
  candidate_sha TEXT NOT NULL,
  main_sha TEXT NOT NULL,
  results TEXT,                     -- JSON per check: exit, seconds, excerpt, flaky
  outcome TEXT,                     -- pass | fail | error | running
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE areas (
  prefix TEXT PRIMARY KEY,
  ceiling INTEGER NOT NULL,
  auto_promote INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE ledger (
  agent_id TEXT NOT NULL,
  prefix TEXT NOT NULL,
  level INTEGER NOT NULL,
  landed INTEGER NOT NULL DEFAULT 0,
  gate_failures INTEGER NOT NULL DEFAULT 0,
  reviewer_rejections INTEGER NOT NULL DEFAULT 0,
  person_overrides INTEGER NOT NULL DEFAULT 0,
  reverts INTEGER NOT NULL DEFAULT 0,
  recent TEXT NOT NULL,             -- JSON: the last 10 outcomes
  PRIMARY KEY (agent_id, prefix)
);
```

`claims` is replaced by `scopes`. `related` stays. New event types: `waiting`, `granted_after_wait`, `collision`, `collision_resolved`, `projection`, `gate`, `landed` (replaces `merged`), `level_proposed`, `level_changed`, `reverted`, `index_updated`.

## 15. Task lifecycle

```
 start_task ──▶ waiting ──(granted)──▶ active ◀──────────────────────────┐
                  │ expires/abandon        │ submit                        │ gate fail / reviewer reject /
                  ▼                        ▼                               │ collision brief (cycle+1)
               closed                 in_review ──▶ gated ──▶ landed      │
                                           │          │                    │
                                           │          └── interaction ─────┤
                                           └── escalate ──▶ escalated ─────┤
                                                              │ person: land ──▶ gated
                                                              └ person: close ──▶ closed
```

- `waiting` is the state of a **request**, not of a task: a `start_task` that waits has no task until it is granted, and an `expand_scope` that waits leaves its task `active` with its present scope. The diagram shows it for the flow; the `waiting` table (§14) holds it.
- `gated` is new: approved, waiting for or in a gate batch. A task's scope does not expire in `gated`.
- `landed` replaces `merged` in names; `merge_sha` keeps its name in replies for compatibility.
- A `contract` brief for an **active** task does not change its state; it is information.

## 16. Failure handling

- **Decision model unavailable:** as before; related work and triage are skipped and recorded.
- **Index cannot extract a file** (unsupported language, too large): the file has path targets only; interface targets in it are `declared` only. The board shows index coverage per repo.
- **Sandbox unavailable or image build fails:** the gate records `error`; the area's effective level is L1 until a run succeeds; the board says so; nothing lands without a person in areas whose ceiling is above L1, and L0–L1 areas proceed with the reviewer alone as today, with `Dibs-Gate: unavailable` in the trailer.
- **Gate timeout:** `error` for the batch; members are retried alone once; a member that times out alone fails with the output excerpt.
- **Coordinator stall** (as seen once during recording): projections and queue grants are idempotent and driven by alarms, so a stall delays and does not corrupt. Tool calls keep their timeouts.
- **Large repositories:** index build is bounded by file size and runs in Workflow steps; projection cost follows the change, not the repository; the gate's clone is blob-less and shallow.
- **A lying agent** (declares `add`, rewrites the file): the declared-interface check (§4.4) catches changed signatures; the three-way merge catches overlapping hunks; the gate catches the rest. `rely` cannot be lied about to anyone's harm.

## 17. Security

- Fork tokens are scoped to the fork and never leave the Worker and the agent that owns the task. `peek` returns a diff, never a token or a remote.
- The sandbox receives no secrets; the Worker's outbound handler adds the Artifacts token to requests for that host only, and the allowlist of registries is in the protected `.dibs/checks.json`.
- `.dibs/` is a protected path; levels, ceilings and areas are changed only through the board by a signed-in person; agents cannot call them.
- Per-agent keys as before; `revert` is logged like any landing.

## 18. Testing

- **Pure units with case tables:** the conflict matrix (every cell, paths and interfaces, directories against files); coverage and declared-interface enforcement; `merge3` against the classic diff3 cases and the JSON-map composition; the proposal rules of §7.2; the batch planner (independence, ordering, the 8 cap, red-batch splitting, interaction attribution); the level rules of §9.2 with ledgers that promote, hold and demote; extractors against fixture files per language with expected interfaces, signatures and references.
- **Coordinator in `vitest-pool-workers`:** atomic grant under concurrent waiters, FIFO fairness, wait-for cycle refusal, waiting expiry, projection recomputation after a landing, the alarm debounce.
- **A collision corpus:** the `findUser`/route case recorded from the three takes, plus hand-made cases (rename with a barrel, route added by two tasks, two `add`s to a routes index, a duplicate pair). Each case is a scripted pair of tasks against a seeded repo and asserts *where* the collision was found (claim, expand, submit, projection, gate) and the proposal.
- **Gate integration** behind `DIBS_GATE_TEST=1`: one real sandbox run against a seeded repository, green and red.
- **End to end:** `scripts/e2e.ts` extended with waiting, a contract collision and a gate; the five-agent demo re-recorded.

## 19. Metrics

Recorded per repo and shown on the Policy panel; the first three are the design's success criteria.

- Person-decisions per landed change (target below 0.2 in L2 areas).
- Time from submit to landing, median and p90.
- Rework cycles per landed change.
- Where collisions were found: claim, expand, submit, projection, gate, reviewer (earlier is better).
- Gate catch rate against reviewer catch rate.
- False `contract` collisions (adapting task's projection was clean and its gate passed without any change).
- Decision-model agreement (the shadow tally) per area.

## 20. What is borrowed and what is new

| Borrowed | From | Here |
|---|---|---|
| Changes as first-class objects, not branches | Gerrit, Phabricator | §3, §10.1 |
| Speculative gating of a merged candidate | Zuul, Bors, merge queues | §8 |
| Conflicts as data with a resolution, not a failure | Jujutsu | §7 |
| Dynamic ownership, presubmit before landing | the kernel's maintainer tree, Google's TAP | §4, §8 |
| Session provenance left to the agent's tooling | Entire | §10.2 (`Dibs-Fork` kept) |

| New | Where |
|---|---|
| Concurrency control that follows the relation (change / add / rely), not the file | §2.3, §4.2 |
| Function-level exclusivity inside a shared file through `add` + interface `change` | §4.2 |
| Inferred `rely` from the interface index, so a contract collision is known at claim time without a model | §4.5 |
| Scope disjointness as the independence oracle for gate batches, replacing queue order | §8.4 |
| Provider-first contract collisions with briefs and `peek`, so the relier codes against the pending contract | §7.2 |
| Engine-side projection pushed into the agent's fork; `sync_with_main` becomes a fast-forward | §6.2 |
| Per-area levels earned per agent from a ledger, under a person's ceiling, with the decision model's agreement as the L3 test | §9 |
| All of the above written into trailers, change refs and notes that plain git reads | §10 |

## 21. Staging

The competition closes on 2026-10-14. What follows is ordered by value per day and honest about risk.

**Stage 1 — scopes, collisions, waiting (target 2026-10-09).**
Scopes with the three relations on paths; interface targets with the TypeScript/JavaScript extractor only; inferred `rely`; `expand_scope` re-running the related-work check; waiting with the queue and the cycle check; `contract` collisions with provider-first proposals, briefs and `peek`; the dependents rule routing interface changes to the provider instead of a person; change refs, the new trailers and the note; `duplicate` consequences. Projections in Stage 1 are computed at submit and at landing only (today's overlay plus the contract check of §6.2); recomputation on every landing, the three-way step and the `refs/dibs/projected` ref in forks are Stage 3, so `sync_with_main` keeps today's behaviour until then. The reviewer unchanged. This changes the demo's two best moments: the `findUser` collision is known at claim time and resolved by the engine's order, and agent-two waits for its paths instead of narrowing. Narration lines change, so a new take is needed.

**Stage 2 — the gate, single candidates (target 2026-10-12).**
`.dibs/checks.json`, candidates on `refs/dibs/candidates/*`, one sandbox run per approved change, landing by fast-forward, `Dibs-Gate` evidence into the reviewer's prompt and the note. No batching yet. Risk: Containers need Docker at deploy time and an image build; a day of platform friction is likely. If this lands, the video's strongest beat becomes "the engine ran the tests before anything reached main", and the README's honesty line about the reviewer only reading can go.

**Stage 3 — after the competition.**
Batches and interaction attribution; the three-way projection for `add` and JSON-map composition (and `package.json` leaving the protected list); levels, ceilings and the ledger; `revert`; Python and Go extractors, then tree-sitter; projected refs pushed into forks; container snapshots.

**Recommendation:** commit the current working state first as the baseline, then do Stage 1 in full and Stage 2 if it is green by the evening of the 12th; otherwise record with Stage 1 and keep the honesty line. Nothing in Stage 1 touches the merge path, so the current demo keeps working while it is built.

## 22. Decisions taken (2026-10-03)

1. **Stage 2 before the deadline:** yes, with the evening of 2026-10-12 as the cut-off.
2. **Interface targets and inferred `rely`:** both in Stage 1. Inferred `rely` from paths gives the claim-time contract collision for the demo; declared interface targets add function-level exclusivity and declared changes; the extractor serves both.
3. **Containers:** Docker is installed on the deploying machine; the gate is built on Containers through the Sandbox SDK as §8 describes.

## 23. What Stage 1 built, and where it differs from the above (2026-10-03)

Stage 1 is built, deployed (version `ba1588bf`) and checked end to end on Cloudflare with the real reviewer and Clef: `scripts/e2e.ts` passes 23 checks there and 25 locally (the local run adds the shared-file step below). `pnpm test` passes 1068 tests.

| Section | As designed | As built, and why |
|---|---|---|
| §7.2 | A deterministic proposal decides which of two colliding tasks lands first, and the engine holds the other back. | The proposal is only advice (`order` and `brief` in every tool answer). What keeps `main` whole is an **invariant** checked mechanically: *no file on `main` uses an interface in a shape it was not written for.* Two checks enforce it, once before the review (no model is called for a change that fails) and again under the merge lock: **C1**, nothing the change relies on has a different signature on `main` than at the change's base; **C2**, every file on `main` that uses an interface the change alters is part of the change. Either landing order is then safe: if the relier lands first, the provider fails C2 and must take the relier's file into its scope; if the provider lands first, the relier fails C1 and must adapt. Holding tasks back is unnecessary, so it was not built. |
| §7.1 | Collision states `open`, `proposed`, `accepted`, `overridden`, `resolved`. | `possible` (a task holds a whole file whose interface another relies on, and has said nothing), `open` (the change is declared, detected in a submission, or has landed), `resolved` (with how: `no change`, `adapted`, `landed`, `ended`, `said to be different`). A person overriding the order is not built; there is no order to override. |
| §7.2 | Dependents nobody owns are routed to the provider at L1 and above. | Always, by C2. An agent that believes the files need no change says so in `leaves_dependents`; the change is then reviewed with that claim put to the reviewer, and goes to a person (`interface_change`). |
| §4.3 | A waiting request expires after its TTL. | A waiting request is kept while its agent keeps asking: it is dropped three minutes after the last `start_task`/`expand_scope` call that named it. A task granted from the line has three minutes to be picked up (its fork made), then gets its whole lifetime. A waiting request reserves nothing: what it waits for stays open to others meanwhile, and the line decides only who gets a freed target first. |
| §4.4 | An undeclared interface change in a file held with `add` is rejected. | It is added to the task's scope as `detected` if no other task holds that interface; it is rejected (`held`, through C1/C2's report) only if another task does. |
| §6 | Projection is recomputed on every landing; the three-way step is Stage 3. | Projection is the two contract checks plus the merge. The three-way merge for `add` paths was **moved into Stage 1** (`src/git/merge3.ts`): changes to different parts of a file are joined as git joins them; two additions at the same place are both kept; two changes to one line that only add to it are joined token by token (`[a]` + `[a, b]` + `[a, c]` gives `[a, b, c]`); anything else is a conflict and the change goes back as stale. A joined file gets a `Dibs-Composed` trailer and a `composed` field in the note. `refs/dibs/projected` in forks is not built. |
| §9 | Levels L0–L3 and the ledger. | Stage 3, as planned. Stage 1 changes one rule of `decide()`: where the index can speak for a change (it has read the repository, and the change touches code it can read), the decision model's `interface_change` probability is no longer a reason to ask a person; C2 and `leaves_dependents` are. Elsewhere the model's rule applies as before. |
| §10.1 | Change refs `refs/dibs/changes/*`. | Not built; forks are kept and `Dibs-Fork` names the head. Stage 3. |
| §10.2 | `Dibs-Scope` replaces `Dibs-Claim`. | `Dibs-Claim` stays (the paths the task could write), so v1 tooling keeps working. `Dibs-Scope` is added only when the scope says more than paths to change; `Dibs-Interfaces` lists the interfaces the change altered; `Dibs-Composed` the files joined. `Dibs-Change`, `Dibs-Gate`, `Dibs-Level`, `Dibs-Collisions` are not written (the note carries collisions). |
| §11 | `declare_interface_change(task_id, target, how)`. | No `how`: the change itself is what the review reads. `abandon` takes a `request_id` to leave the line. `expand_claim` is kept as a second name for `expand_scope`. `start_task` with `wait_seconds` 0 (the default) is refused at once, as before. |
| §5 | Built at registration in Workflow steps of 200 files; routes from `.dibs/index.json`. | Built at registration in the request, for up to 400 code files (`unread` says how many more there are), and again on `POST /api/repos/:repo/index`. Updated at every landing from the files as they landed. Route patterns are the two defaults; `.dibs/index.json` is not read. Re-exports and `export *` barrels are followed when relying and when finding dependents. |
| §14 | A `changes` table. | The interface report is a column of `submissions` (`interfaces`, `leaves`); `indexed_files` holds each file's digest and the commit it was read at. |

Known limits of what Stage 1 checks, beyond those of §5:
- The index compares signatures, not behaviour. A change that keeps a signature and alters what the function does is invisible to C1 and C2; the reviewer, and in Stage 2 the gate, are what see it.
- A class is known by its heading only, so a change to a method's signature is not an interface change to the index.
- C2 asks for every file that uses an altered interface to be part of the change. A compatible change (an optional parameter added) is treated like any other; the agent can say why the files need no change, and a person decides. With the gate, a passing run is the better answer, and Stage 2 uses it.

## 24. What Stage 2 built (2026-10-03)

The gate is built, deployed (version `c5588632`) and checked on Cloudflare: `scripts/e2e.ts` passes 26 checks there. Every change of the e2e repository ran the demo app's `npm test` in its own container before review (12 s for the first, cold one; 2–4 s after), a change that broke `GET /health` was sent back with the failing test's output before any model saw it, and the landed commits carry `Dibs-Gate: pass; test; …`. A run with five real Claude Code agents (`v2-dry-1`) landed all five changes in 3 minutes 40 seconds with no person asked: agent-four's first attempt failed the tests and its fix landed; agent-one's approved route was sent back by C1 at the last check because agent-five's `findUser` change had landed meanwhile, caught up, and landed; agent-two waited in line for agent-one's routes and got them the moment agent-one landed.

| Section | As designed | As built, and why |
|---|---|---|
| §8.1 | `image`, `instance`, `setup`, `checks`, `timeout_seconds`, `outputs`. | `setup`, `checks` (at most 10), `timeout_seconds` (at most 900), and `internet` (off unless asked). One image for every repository, `gate/Dockerfile` (Node.js and git), built at deploy; per-repository images and `outputs` are not built. `.dibs/` is a protected path. |
| §8.2 | Candidates on `refs/dibs/candidates/<batch>`; landing by fast-forward. | `refs/dibs/candidates/<task>`, one per task, replaced on each build. The merge engine now has `candidate()` (build the commit, push it to the hidden ref) and `land()` (move `main` to it with an empty pack, naming the old head). Checks depend on the tree, not the message, so the commit that lands is rebuilt with the `Dibs-Gate` trailer over the same tree and no second run. |
| §8.3 | Sandbox SDK; the token added by an outbound handler. | The Durable Object container API directly (`ctx.container`, the `durable_object` scheduling policy, public beta), which is what Sandbox SDK 1.0 is now. `interceptOutboundHttps` sends the container's requests to the Artifacts host through `GitGateway`, a Worker entrypoint given its one repository through `ctx.exports.GitGateway({ props })`; it lets through only `git-upload-pack` reads of that repository and adds a five-minute read token. A fresh Durable Object, and so a fresh container, per run; destroyed in `finally`. |
| §8 timing | The gate after the reviewer's approval. | The checks run **before** the reviewer (after the contracts and the size checks), so a failing change costs no model call, and the reviewer is told how they went. Under the merge lock the candidate is rebuilt; if its tree differs from the one checked (`main` moved during the review) the checks run again (`gate-again`). The merge lock is held for up to 18 minutes when checks run under it. |
| §8.4 | Batches of up to 8. | Not built: one candidate per change. Stage 3. |
| §9 | Levels decide what a passing gate allows. | One rule: a passing gate stands in for the two interface rules (the decision model's guess where the index cannot see, and `leaves_dependents` where it can). Levels are Stage 3. |
| §16 | Sandbox unavailable means L1. | Checks that cannot run (no container, a container error, an invalid `.dibs/checks.json`) are recorded as `error`, the review goes on without them, and the commit says `Dibs-Gate: error; …`. |
| §9, P3 | A gate failure goes back to the agent, never to a person; `max_cycles` still escalates. | Decided on 2026-10-03: every send-back counts toward `max_cycles`, whatever sent it. That covers the scope check, the contract checks (before review and under the merge lock), the gate, a stale `main`, and the reviewer. On the last allowed attempt the change goes to a person with `reasons: [max_cycles]` and what it was last sent back for. Before this, contract and stale send-backs never escalated, so an agent that could not adapt looped until its scope expired. |

Operational note: the deploy builds the image for `linux/amd64` with Docker. On the build machine Docker Desktop's credential helper hung, which stalled every pull of the public base image; the deploy succeeded with a throwaway `DOCKER_CONFIG` that has no credential helper.
