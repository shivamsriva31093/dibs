// Records one real run of the demo for the video: five headless agents working on a
// repository of a deployed dibs, and the board they produce. The agents, the checks, the
// reviews and the landings are real. One agent is told to break a test in its first attempt
// (scripts/prompts/agent-four.md). Should a change be sent to a person, the person is played
// by this script, which approves it and says so.
//
//   DIBS_URL=https://dibs.<subdomain>.workers.dev DIBS_ADMIN_TOKEN=... node video/record.ts [repo-name]
//
// The narration is spoken by Fish Audio when FISH_API_KEY or FISH_ENV_FILE is set (see voice.ts).
//
// It writes video/out/<repo>/: the frames, the narration clips, and take.json, which says
// when each frame was drawn and when each line was spoken. build.ts makes the video from it.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { AGENT_NAMES, api, DIBS_URL, ADMIN_TOKEN, git, requireConfig } from "../scripts/lib.ts";
import { stepsFrom } from "./agent-log.ts";
import { LINES, likelyLines } from "./lines.ts";
import { openStudio, root, sleep } from "./studio.ts";
import type { Spoken } from "./timeline.ts";
import { openNarrator } from "./voice.ts";

requireConfig();

const repo = process.argv[2] ?? `demo-${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "")}`;
const out = join(root, "video/out", repo);
const POLL_MS = 600;
const MAX_RUN_MS = 16 * 60_000;
// The silence left after a line before the next one.
const PAUSE_MS = 450;
// How long nothing has to have been said before a line that only fills a silence is said.
const SILENCE_BEFORE_FILLER_SECONDS = 7;
// How far into the opening line the agents are started.
const START_AFTER_MS = 3500;
type Json = Record<string, any>;

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "audio"), { recursive: true });

// Before anything is registered or filmed, the lines the run is likely to need are spoken and kept.
const voice = openNarrator(join(root, "video/out/voice"));
console.log(`Narrated by ${voice.voice}.`);
console.log(`${await voice.prepare(likelyLines())} lines spoken ahead of the run; the rest were at hand.`);

// ── The agents: what each is doing, read from its own log ─────────────────

const TITLES: Record<string, string> = {
  "agent-one": "Add GET /users/:id",
  "agent-two": "Add rate limiting",
  "agent-three": "Fix pagination",
  "agent-four": "Add input validation",
  "agent-five": "Change what findUser returns",
};
// The board gives each agent a colour by the order it was created in; these are the same ones.
const PENCILS = ["#2356c7", "#b07a0a", "#3f8a2c", "#7446c9", "#0e7c86"];

function agentSteps(name: string): string[] {
  const path = join(root, ".demo", repo, "logs", `${name}.log`);
  return existsSync(path) ? stepsFrom(readFileSync(path, "utf8")) : [];
}

function agentState(task: Json | undefined, inLine: boolean): { state: string; kind: string } {
  if (task === undefined) {
    return { state: inLine ? "waiting in line" : "starting", kind: "" };
  }
  switch (task.state) {
    case "active":
      return { state: task.cycle > 1 ? `fixing, attempt ${task.cycle}` : "working", kind: "" };
    case "in_review":
      return { state: "in review", kind: "" };
    case "escalated":
      return { state: "waiting for a person", kind: "person" };
    case "merged":
      return { state: `merged ${String(task.mergeSha).slice(0, 7)}`, kind: "landed" };
    default:
      return { state: String(task.state), kind: "" };
  }
}

// ── The stage ─────────────────────────────────────────────────────────────

console.log(`Recording ${repo} on ${DIBS_URL} into ${relative(root, out)}`);
execFileSync(process.execPath, [join(root, "scripts/setup-demo.ts"), repo], { cwd: root, stdio: "inherit", env: process.env });

const studio = await openStudio();
await studio.open("stage.html");
await studio.call("openBoard", `${DIBS_URL}/?repo=${repo}`);
// Signing in happens before filming starts, so the form is never in the picture.
await studio.evaluate(`(async () => {
  const until = async (found) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (found()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("the board did not load");
  };
  await until(() => boardDocument()?.querySelector("#token"));
  typeInBoard(boardDocument().querySelector("#token"), ${JSON.stringify(ADMIN_TOKEN)});
  [...boardDocument().querySelectorAll("button")].find((button) => button.textContent.trim() === "Open the board").click();
  await until(() => boardDocument().body.textContent.includes("Who has dibs"));
})()`);
await studio.call(
  "setAgents",
  AGENT_NAMES.map((name, index) => ({ name, title: TITLES[name], color: PENCILS[index], state: "starting", kind: "", lines: [] })),
);
await sleep(800);
const film = await studio.film(join(out, "frames"));

// ── Narration: each line is spoken, and shown as a caption while it is ────

const spoken: Spoken[] = [];
const queue: { text: string; clip: Promise<{ file: string; duration: number }> }[] = [];
const said = new Set<string>();
let clips = 0;
let narrating = true;
let speaking = false;
let quietSince = 0;

const narrator = (async () => {
  while (narrating || queue.length > 0) {
    const line = queue.shift();
    if (line === undefined) {
      await sleep(100);
      continue;
    }
    speaking = true;
    const { file, duration } = await line.clip;
    await studio.call("setCaption", line.text);
    spoken.push({ file, start: film.now(), duration, text: line.text });
    await sleep(duration * 1000 + PAUSE_MS);
    if (queue.length === 0) {
      await studio.call("setCaption", "");
    }
    speaking = false;
    quietSince = film.now();
  }
})();

// Says a line once. A line that only adds colour is dropped when the narration is already behind.
function say(key: string, text: string, { optional = false } = {}): boolean {
  if (said.has(key) || (optional && queue.length > 0)) {
    return false;
  }
  said.add(key);
  // The voice starts on the line at once, so that it is ready when its turn comes.
  const clip = voice.speak(text, join(out, "audio", `n${String(clips++).padStart(3, "0")}`));
  queue.push({ text, clip: clip.then(({ file, duration }) => ({ file: relative(out, file), duration })) });
  console.log(`[${film.now().toFixed(0)}s] ${text}`);
  return true;
}
const quiet = () => queue.length === 0 && !speaking;

// ── The person: the pointer goes to a control of the board and presses it ─

// Each `find` is a function of the board's document, written out as text, that returns one of its elements.
const SCROLL_MS = 900;

// Scrolls the board until an element is in view, as a person would, and returns where it then is on the stage.
async function bringIntoView(find: string): Promise<{ x: number; y: number }> {
  const found = await studio.evaluate<boolean>(`(async () => {
    // The board hears of a change a moment after the API does.
    for (let attempt = 0; attempt < 50; attempt++) {
      const element = (${find})(boardDocument());
      if (element) {
        element.scrollIntoView({ block: "center", behavior: "smooth" });
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })()`);
  if (!found) {
    throw new Error(`nothing on the board matches ${find}`);
  }
  await sleep(SCROLL_MS);
  return studio.evaluate<{ x: number; y: number }>(`stagePoint((${find})(boardDocument()))`);
}

async function press(find: string): Promise<void> {
  const point = await bringIntoView(find);
  await studio.call("moveCursor", point.x, point.y);
  await sleep(1100);
  await studio.call("pressCursor", true);
  await sleep(160);
  await studio.evaluate(`(${find})(boardDocument()).click()`);
  await studio.call("pressCursor", false);
  await sleep(700);
}

// The person is done with a card: the pointer goes, and the board is back at its top.
async function leave(): Promise<void> {
  await studio.call("hideCursor");
  await studio.evaluate(`boardDocument().defaultView.scrollTo({ top: 0, behavior: "smooth" })`);
  await sleep(SCROLL_MS);
}

const cardOf = (agent: string) => `[...doc.querySelectorAll("li")].find((item) => item.querySelector("textarea") && item.textContent.includes("${agent} changed"))`;
const buttonOn = (agent: string, label: string) =>
  `(doc) => [...(${cardOf(agent)}?.querySelectorAll("button") ?? [])].find((button) => button.textContent.trim() === "${label}")`;
const noteOn = (agent: string) => `(doc) => ${cardOf(agent)}?.querySelector("textarea")`;

async function approve(agent: string): Promise<void> {
  await press(buttonOn(agent, "Approve and merge"));
  await leave();
}

async function sendBack(agent: string, note: string): Promise<void> {
  const area = await bringIntoView(noteOn(agent));
  await studio.call("moveCursor", area.x, area.y);
  await sleep(1100);
  await studio.evaluate(`(async () => {
    const area = (${noteOn(agent)})(boardDocument());
    const note = ${JSON.stringify(note)};
    for (let length = 2; length < note.length + 2; length += 2) {
      typeInBoard(area, note.slice(0, length));
      await new Promise((r) => setTimeout(r, 40));
    }
  })()`);
  await sleep(1200);
  await press(buttonOn(agent, "Send back"));
  await leave();
}


// ── The run ───────────────────────────────────────────────────────────────

say("start", LINES.start());
// The agents need a few seconds before their first step shows; the opening line uses them.
await sleep(START_AFTER_MS);
const agents = spawn("bash", [join(root, "scripts/demo.sh"), repo], {
  cwd: root,
  env: { ...process.env, DIBS_AGENT_OUTPUT: "stream-json" },
  stdio: ["ignore", "ignore", "inherit"],
});
await studio.call("startClock");
let agentsDone = false;
agents.once("exit", () => {
  agentsDone = true;
});

const askedAbout = new Set<string>();
const approved = new Set<string>();
// Agents whose work was sent back by a check, and what sent it back.
const sentBack = new Map<string, "gate" | "contract" | "dependents" | "reviewer">();
// A refusal is told only if its agent does not go on to wait in line.
let refusal: { agent: string; holder: string; at: number } | null = null;
let waitedFor = "another agent";
const landedBy = new Map<string, string>();
// The paths each agent's task may write, to tell a scope that grew from one that only gained an interface.
const pathsOf = new Map<string, string[]>();
let seen = 0;
const taskOf = (state: Json, agent: string): Json | undefined => state.tasks.filter((task: Json) => task.agent === agent).at(-1);
const began = Date.now();
let settledAt = 0;

// Shows where each agent stands and its latest steps, in the colour the board gives it.
function showAgents(state: Json): Promise<unknown> {
  const pencil = new Map<string, number>(state.agents.map((agent: Json, index: number) => [agent.name, index]));
  return studio.call(
    "setAgents",
    AGENT_NAMES.map((name) => ({
      name,
      title: TITLES[name],
      color: PENCILS[pencil.get(name) ?? 0],
      ...agentState(
        taskOf(state, name),
        (state.waiting ?? []).some((request: Json) => request.agent === name),
      ),
      lines: agentSteps(name),
    })),
  );
}

while (Date.now() - began < MAX_RUN_MS) {
  const { body: state } = await api<Json>("GET", `/api/repos/${repo}/state`);
  await showAgents(state);
  const landedNow = () => AGENT_NAMES.filter((name) => taskOf(state, name)?.state === "merged").length;

  for (const event of state.events.filter((candidate: Json) => candidate.id > seen).sort((a: Json, b: Json) => a.id - b.id)) {
    seen = event.id;
    const body = event.body as Json;
    switch (event.type) {
      case "task_started":
        pathsOf.set(body.agent, body.paths ?? []);
        if (body.agent === "agent-one") {
          say("claim", LINES.claim(body.agent));
        } else if (said.has(`waiting-${body.agent}`)) {
          const holder = said.has("waiting-holder") ? waitedFor : "another agent";
          say(`granted-${body.agent}`, LINES.granted(body.agent, holder));
        }
        break;
      case "claim_conflict":
        refusal ??= { agent: body.agent, holder: body.blockedBy?.[0]?.agent ?? "another agent", at: Date.now() };
        break;
      case "waiting": {
        refusal = null;
        const holder = body.blockedBy?.[0]?.agent ?? "another agent";
        // A task sent back to update a file that another task holds by now waits for it too.
        if (sentBack.has(body.agent)) {
          say(`waiting-again-${body.agent}`, LINES.waitingAgain(body.agent, holder));
          break;
        }
        waitedFor = holder;
        said.add("waiting-holder");
        said.add(`waiting-${body.agent}`);
        say("waiting", LINES.waiting(body.agent, waitedFor));
        break;
      }
      case "collision":
        if (body.kind === "contract" && body.state === "open") {
          say("collision", LINES.collision(body.provider?.agent ?? "", body.relier?.agent ?? "", String(body.target ?? "")));
        }
        break;
      case "claim_expanded": {
        // Declaring an interface change also expands a scope, without adding a file to write.
        const before = pathsOf.get(body.agent) ?? [];
        const grew = (body.paths ?? []).some((path: string) => !before.includes(path));
        pathsOf.set(body.agent, body.paths ?? before);
        if (said.has(`waiting-again-${body.agent}`)) {
          say(`granted-again-${body.agent}`, LINES.grantedAgain(body.agent));
        } else if (grew && !sentBack.has(body.agent)) {
          say("expanded", LINES.expanded(body.agent), { optional: true });
        }
        break;
      }
      case "submitted":
        say("submitted", LINES.submitted());
        break;
      case "gate":
        if (body.outcome === "pass") {
          say("gate-first", LINES.gateFirst());
        }
        break;
      case "check_failed": {
        const verdict = body.verdict ?? {};
        if (body.source === "gate") {
          sentBack.set(body.agent, "gate");
          say(`gate-failed-${body.agent}`, LINES.gateFailed(body.agent));
        } else if (verdict.check === "contract") {
          sentBack.set(body.agent, "dependents");
          const altered = verdict.details?.contract?.unupdated?.[0]?.target ?? "src/db/users.ts#findUser";
          say(`dependents-${body.agent}`, LINES.dependents(body.agent, String(altered)));
        }
        break;
      }
      case "contract": {
        // Which check sent the change back decides the line: what it relies on moved (C1), or it left a file that uses what it alters (C2).
        sentBack.set(body.agent, "contract");
        const moved = body.contract?.moved?.[0];
        const left = body.contract?.unupdated?.[0];
        if (moved !== undefined) {
          say(`contract-${body.agent}`, LINES.contract(body.agent, String(moved.by ?? "another agent"), String(moved.target)));
        } else if (left !== undefined) {
          const user = left.files?.[0]?.path ?? "";
          const owner = landedBy.get(user) ?? "another agent";
          say(`contract-${body.agent}`, LINES.dependentsAtLanding(body.agent, owner, String(left.target)));
        }
        break;
      }
      case "verdict":
        if (body.decision === "reject" && body.source === "reviewer") {
          sentBack.set(body.agent, "reviewer");
          say(`reject-${body.agent}`, LINES.reject(body.agent));
        }
        break;
      case "escalated":
        askedAbout.add(body.agent);
        break;
      case "merged": {
        // Which agent's work put each file on main, for saying whose route another change has to take over.
        for (const path of taskOf(state, body.agent)?.paths ?? []) {
          landedBy.set(path, body.agent);
        }
        const last = landedNow() === AGENT_NAMES.length;
        const why = sentBack.get(body.agent);
        if (!said.has("merged-first")) {
          said.add("merged-first");
          say(`merged-${body.agent}`, LINES.mergedFirst(body.agent));
        } else if (why === "contract" || why === "dependents") {
          say(`merged-${body.agent}`, LINES.adapted(body.agent, last));
        } else if (why === "gate" || why === "reviewer") {
          say(`merged-${body.agent}`, LINES.mergedFixed(body.agent));
        } else if (said.has(`granted-${body.agent}`) || last) {
          say(`merged-${body.agent}`, LINES.lands(body.agent, last));
        }
        break;
      }
      case "catching_up": {
        // Only an agent sent back because main moved under it has code to change to fit; others catch up out of habit.
        const why = sentBack.get(body.agent);
        if (why === "contract" || why === "dependents") {
          say(`catching-${body.agent}`, LINES.catching(body.agent));
        }
        break;
      }
    }
  }

  // A refusal its agent did not follow by waiting in line.
  if (refusal !== null && Date.now() - refusal.at > 6000) {
    say("refused", LINES.refused(refusal.agent, refusal.holder));
    refusal = null;
  }

  // Anything that waits for a person is let through, and the narration says that the script did it.
  if (quiet()) {
    const waits = state.tasks.find((task: Json) => task.state === "escalated" && !approved.has(task.agent));
    if (waits !== undefined) {
      approved.add(waits.agent);
      console.log(`NOTE: ${waits.agent}'s work was sent to a person. Read its card before using this take.`);
      say(`approve-other-${waits.agent}`, LINES.approveOther(waits.agent));
      await approve(waits.agent);
    }
  }

  // Lines that explain what is on the screen, said only when nothing else is being said.
  if (quiet() && film.now() - quietSince > SILENCE_BEFORE_FILLER_SECONDS) {
    const backInReview = [...sentBack.keys()].some((agent) => {
      const task = taskOf(state, agent);
      return task?.state === "in_review" && task.cycle > 1;
    });
    if (said.has("claim") && !said.has("submitted")) {
      say("forks", LINES.forks(), { optional: true }) || say("board", LINES.board(), { optional: true });
    } else if (said.has("submitted") && !said.has("merged-first")) {
      say("scores", LINES.scores(), { optional: true });
    } else if (backInReview) {
      say("second-review", LINES.secondReview(), { optional: true });
    }
  }

  const states = AGENT_NAMES.map((name) => taskOf(state, name)?.state);
  if (states.every((taskState) => taskState === "merged")) {
    break;
  }
  // With every agent gone and no review running, nothing more can happen.
  if (agentsDone && !states.includes("in_review")) {
    settledAt ||= Date.now();
    if (Date.now() - settledAt > 20_000) {
      break;
    }
  } else {
    settledAt = 0;
  }
  await sleep(POLL_MS);
}

await studio.call("stopClock");
const finalState = (await api<Json>("GET", `/api/repos/${repo}/state`)).body;
const outcome = Object.fromEntries(AGENT_NAMES.map((name) => [name, taskOf(finalState, name)?.state ?? "none"]));
const landed = Object.values(outcome).filter((taskState) => taskState === "merged").length;
if (landed === AGENT_NAMES.length) {
  say("end", LINES.end(askedAbout.size));
}
// The agents' last steps are still being written to their logs while the closing line is said.
for (let settled = 0; settled < 2500; settled += POLL_MS) {
  while (!quiet()) {
    await showAgents(finalState);
    await sleep(POLL_MS);
  }
  await showAgents(finalState);
  await sleep(POLL_MS);
}
narrating = false;
await narrator;
const filmed = await film.stop();

// ── What landed, read with plain git, for the card that follows the run ───

const access = (await api<Json>("POST", `/api/repos/${repo}/read-token`)).body;
const clone = mkdtempSync(join(tmpdir(), "dibs-video-main-"));
git(clone, ["clone", "--quiet", access.remote, "."], access.token);
git(clone, ["fetch", "--quiet", "origin", "refs/notes/dibs:refs/notes/dibs"], access.token);
let tests = "";
try {
  tests = execFileSync("npm", ["test"], { cwd: clone, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (error) {
  tests = String((error as { stdout?: string }).stdout ?? error);
}
const proof = {
  log: git(clone, ["log", "--format=%h%x09%an%x09%s"]),
  commit: git(clone, ["log", "-1", "--format=%B"]),
  note: git(clone, ["notes", "--ref=dibs", "show", "HEAD"]),
  tests: tests
    .split("\n")
    .filter((line) => /^# (tests|pass|fail)/.test(line))
    .join("\n"),
};
rmSync(clone, { recursive: true, force: true });

writeFileSync(
  join(out, "take.json"),
  `${JSON.stringify(
    {
      repo,
      url: DIBS_URL,
      recorded: new Date().toISOString(),
      duration: filmed.duration,
      shots: filmed.shots.map((shot) => ({ file: relative(out, shot.file), t: shot.t })),
      spoken,
      proof,
      outcome,
      askedAbout: [...askedAbout],
    },
    null,
    2,
  )}\n`,
);
console.log(`\n${filmed.shots.length} frames, ${spoken.length} lines of narration, ${filmed.duration.toFixed(0)} seconds.`);
console.log(JSON.stringify(outcome));

if (!agentsDone) {
  agents.kill();
}
await studio.close();
process.exit(landed === AGENT_NAMES.length ? 0 : 1);
