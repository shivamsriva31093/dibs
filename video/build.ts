// Makes the demo video from a recorded run (see record.ts): cards that say what dibs is,
// the run itself, cards that show what landed and how it is built.
//
//   node video/build.ts <repo-name>
//
// The cards are narrated by the voice that is set up when this runs (see voice.ts); use the one the run was recorded with.
//
// It writes into video/out/:
//   dibs-demo.mp4                 the video, narrated by a synthetic voice
//   dibs-demo-captions-only.mp4   the same pictures without sound, for recording your own voice over
//   dibs-demo-narration.md        every line of the narration with the moment it is said

import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStudio, root } from "./studio.ts";
import { cut, frames, join as joinParts, type Part } from "./timeline.ts";
import { openNarrator } from "./voice.ts";

const repo = process.argv[2];
if (repo === undefined) {
  console.error("usage: node video/build.ts <repo-name>   (the name given to video/record.ts)");
  process.exit(2);
}
const takeDir = join(root, "video/out", repo);
if (!existsSync(join(takeDir, "take.json"))) {
  console.error(`No recording in video/out/${repo}: run video/record.ts first.`);
  process.exit(2);
}
const take = JSON.parse(readFileSync(join(takeDir, "take.json"), "utf8")) as Part & {
  proof: { log: string; commit: string; note: string; tests: string };
  outcome: Record<string, string>;
};

const outDir = join(root, "video/out");
const work = join(takeDir, "cards");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const FPS = 30;
const SAMPLE_RATE = 48_000;
// The silence after a line, and the longer one before a card gives way to the next.
const PAUSE = 0.45;
const CARD_TAIL = 0.6;
// How much of the run is kept before its first line.
const RUN_LEAD = 0.8;

// ── What landed, as the two cards show it ─────────────────────────────────

const escapeHtml = (text: string) => text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);
const prompt = (command: string) => `<em>$ ${escapeHtml(command)}</em>`;

const commits = take.proof.log.split("\n").map((line) => {
  const [hash = "", author = "", subject = ""] = line.split("\t");
  return { hash, author, subject };
});
const byAgents = commits.filter((commit) => commit.author.startsWith("agent-"));
const testCount = (name: string) => Number(new RegExp(`^# ${name} (\\d+)`, "m").exec(take.proof.tests)?.[1] ?? Number.NaN);
const passed = testCount("pass");
const failed = testCount("fail");

const logHtml = [
  prompt(`git clone <${repo} on Artifacts> && cd ${repo}`),
  prompt("git log --format='%h %an %s'"),
  ...commits.map((commit) => `<i>${escapeHtml(commit.hash)}</i>  <b>${escapeHtml(commit.author.padEnd(11))}</b>  ${escapeHtml(clip(commit.subject, 76))}`),
].join("\n");
const testsHtml = ["", prompt("npm test"), ...take.proof.tests.split("\n").map((line) => (line.startsWith("# pass") ? `<i>${escapeHtml(line)}</i>` : escapeHtml(line)))].join("\n");

// How many characters and lines a terminal on a card holds.
const TERMINAL_WIDTH = 104;
const TERMINAL_LINES = 18;

// Breaks a line that is too wide between words, with what follows indented.
function wrapped(line: string, indent = ""): string[] {
  const lines: string[] = [];
  let rest = line;
  while (rest.length > TERMINAL_WIDTH) {
    const space = rest.lastIndexOf(" ", TERMINAL_WIDTH);
    const at = space > indent.length ? space : TERMINAL_WIDTH;
    lines.push(rest.slice(0, at));
    rest = indent + rest.slice(at).trimStart();
  }
  return [...lines, rest];
}
// As many lines as a terminal holds; the last one says so when there were more.
const fitted = (lines: string[], room: number) => (lines.length > room ? [...lines.slice(0, room - 1), "…"] : lines);

// The message of the newest commit as git prints it: its subject, what the agent said about it, and its trailers.
// The trailers are its last paragraph, when every line of that paragraph is one.
const paragraphs = take.proof.commit.trim().split(/\n\s*\n/);
const lastParagraph = paragraphs.at(-1)!.split("\n");
const trailers = paragraphs.length > 1 && lastParagraph.every((line) => /^[A-Za-z][A-Za-z-]*: /.test(line)) ? lastParagraph : [];
const messageLines = take.proof.commit.trim().split("\n");
const body = fitted(
  paragraphs
    .slice(1, trailers.length > 0 ? -1 : undefined)
    .join("\n\n")
    .split("\n")
    .flatMap((line) => wrapped(line)),
  TERMINAL_LINES - trailers.length - 4,
);
const commitHtml = [
  prompt("git log -1 --format=%B"),
  `<b>${escapeHtml(clip(messageLines[0] ?? "", TERMINAL_WIDTH))}</b>`,
  "",
  ...body.map(escapeHtml),
  "",
  ...trailers.map((line) => escapeHtml(clip(line, TERMINAL_WIDTH)).replace(/^([A-Za-z-]+:)/, "<u>$1</u>")),
].join("\n");

// The note as git prints it, one field to a line: long text is cut, and the scores of the triage are folded away.
const note = JSON.parse(take.proof.note) as Record<string, unknown>;
const FOLDED = new Set(["triage", "shadow"]);
function noteLine(key: string, value: unknown, summaryLength: number): string[] {
  const name = `  "${key}": `;
  if (FOLDED.has(key) && value !== null && typeof value === "object") {
    return [`${name}{ … },`];
  }
  // The scope is long: how many entries, and how many of them dibs found itself.
  if (key === "scope" && Array.isArray(value)) {
    const found = value.filter((entry) => (entry as { origin?: string }).origin !== "declared").length;
    return [`${name}[ … ${value.length} entries, ${found} of them found by dibs ],`];
  }
  // The checks: how they went, and how long they took, without their output.
  if (key === "gate" && value !== null && typeof value === "object") {
    const gate = value as { outcome?: string; steps?: { name: string }[]; seconds?: number };
    const checks = (gate.steps ?? []).map((step) => step.name).join(", ");
    return [`${name}{ "outcome": "${gate.outcome}", "ran": "${checks}", "seconds": ${Math.round(gate.seconds ?? 0)}, … },`];
  }
  if (key === "collisions" && Array.isArray(value)) {
    return [`${name}[ … ${value.length} with ${[...new Set(value.map((entry) => (entry as { with?: { agent?: string } }).with?.agent))].join(", ")} ],`];
  }
  if (key === "issues" && Array.isArray(value) && value.length > 0) {
    return [`${name}[ … ${value.length} that did not block it ],`];
  }
  // The goal is kept to one line. The summary is the reviewer's own words and gets the room that is left.
  const room = key === "summary" ? summaryLength : key === "goal" ? TERMINAL_WIDTH - name.length - 8 : 150;
  const text = JSON.stringify(typeof value === "string" ? clip(value, room) : value)
    // The spaces JSON leaves out, so that a long list can be broken between its items.
    .replace(/","/g, '", "');
  return wrapped(`${name}${text},`, " ".repeat(name.length + 1));
}
const noteLines = (summaryLength: number) => ["{", ...Object.entries(note).flatMap(([key, value]) => noteLine(key, value, summaryLength)), "}"];
// The longest cut of the summary with which the whole note still fits on the card.
const noteFitted = [340, 260, 170, 85].map(noteLines).find((lines) => lines.length <= TERMINAL_LINES - 1) ?? noteLines(85);
const noteHtml = [
  prompt("git notes --ref=dibs show HEAD"),
  ...fitted(noteFitted, TERMINAL_LINES - 1).map((line) => escapeHtml(line).replace(/^(\s*)("[a-z_]+":)/, "$1<u>$2</u>")),
].join("\n");
// A trailer that dibs did not write: it was on one of the agent's own commits and is carried over.
const carriedOver = trailers.map((line) => line.split(":")[0]!).find((name) => !name.startsWith("Dibs-"));

// ── The cards and what is said over each ──────────────────────────────────

interface Beat {
  // The line that is said, and shown as the caption. Empty for a moment of silence.
  text: string;
  // How much of the card is shown by then.
  step?: number;
  // How long a silent beat lasts, in seconds.
  hold?: number;
}
interface Card {
  name: string;
  beats: Beat[];
  // Terminals to fill before the pictures are taken: element id to HTML.
  fill?: Record<string, string>;
}

const lastAgent = String(note.agent ?? "its agent");
const approvedBy = note.approved_by === "human" ? "a person" : "the reviewer";

const OPENING: Card[] = [
  {
    name: "title",
    beats: [
      { text: "", hold: 1.2 },
      { text: "This is dibs, a git engine for many coding agents working on one repository at the same time, without pull requests." },
      { text: "It runs on Cloudflare Workers, Containers and Artifacts." },
    ],
  },
  {
    name: "problem",
    beats: [
      { text: "Git was built for a few people who talk to each other. Coding agents do not talk.", step: 0 },
      { text: "An agent's intent is invisible until its work is done. Two agents can rewrite the same file, and neither knows.", step: 1 },
      { text: "And the collisions that matter are not textual. One agent changes what a function returns, another calls it. The merge is clean, and the main branch is broken.", step: 2 },
      { text: "Meanwhile a person is asked to review everything, though agents write faster than people read.", step: 3 },
    ],
  },
  {
    name: "idea",
    beats: [
      { text: "dibs changes the order. An agent says what it will touch, and how, before it starts.", step: 0 },
      {
        text: "It holds code to change, which is exclusive; to add to, which is shared; or to rely on. Nobody is stopped from changing what another relies on, but both are told the moment it is about to move.",
        step: 1,
      },
      { text: "It works in a private fork on Artifacts, with plain git.", step: 2 },
      {
        text: "When it submits, dibs checks the contracts between the code, from an index of what every file exports and imports. Then it runs the repository's own tests, in a container.",
        step: 3,
      },
      { text: "A reviewer reads what the tests cannot see. Then dibs lands the change, sends it back with the exact reason, or asks a person, when a rule says it must.", step: 4 },
    ],
  },
  {
    name: "run",
    beats: [
      { text: "Here is a real run, on a deployed Worker: five Claude Code agents, real Artifacts repositories, real containers, and the real models.", step: 0 },
      { text: "One thing is arranged: one agent is told to break a test in its first attempt, so that the tests have something to catch.", step: 1 },
    ],
  },
];

const CLOSING: Card[] = [
  {
    name: "proof",
    fill: { "proof-log": logHtml, "proof-tests": testsHtml },
    beats: [
      {
        text: `This is the main branch afterwards, cloned with plain git. ${byAgents.length === 5 ? "Five commits, one for each task" : `${byAgents.length} commits by agents`}, each in the name of the agent that did the work.`,
        step: 0,
      },
      {
        text: failed === 0 && passed > 0 ? `And the tests of the merged main branch pass: all ${passed} of them.` : `The tests of the merged main branch: ${passed} pass and ${failed} fail.`,
        step: 1,
      },
    ],
  },
  {
    name: "trailers",
    fill: { "trailers-commit": commitHtml },
    beats: [
      {
        text: `This is the newest commit, ${lastAgent}'s. Its trailers name the task, its scope with what dibs found it relies on, ${trailers.some((line) => line.startsWith("Dibs-Interfaces")) ? "the interfaces it changed, " : ""}how the tests went, and the verdict.`,
      },
      ...(carriedOver === undefined
        ? []
        : [{ text: `The last trailer, ${carriedOver}, was on the agent's own commit. dibs carries such trailers over, so a link to a recorded session survives the merge.` }]),
    ],
  },
  {
    name: "note",
    fill: { "note-verdict": noteHtml },
    beats: [
      {
        text: `And the whole record is a git note on the commit: the scope, the tests that ran, who approved it, here ${approvedBy}, and what the reviewer concluded.`,
      },
      { text: "There is no pull request to go and find. The history explains itself." },
    ],
  },
  {
    name: "built",
    beats: [
      {
        text: "How it is built. One Durable Object for each repository holds the scopes, the line, and the index of the code. A scope is checked and granted in a single step, so two agents can never both change the same code.",
        step: 1,
      },
      { text: "A Workflow runs each review as durable steps: the contracts, the tests, the triage, the review, and the landing, under a lock.", step: 2 },
      { text: "The tests run in Cloudflare Containers, a fresh one for each run, with no secret inside. A Worker adds the token to its git requests on the way out.", step: 3 },
      {
        text: "Artifacts holds the repositories, a fork for each task, and the candidate commits on hidden refs. It has no merge call and a Worker has no git, so dibs builds commits and packfiles itself.",
        step: 4,
      },
      { text: "Workers AI runs Clef, a small decision model, for the coupling no import shows. It informs the decision, and never makes it alone.", step: 5 },
      { text: "And Claude is the reviewer. It reads the repository, and is told what the tests and the index have already checked.", step: 6 },
    ],
  },
  {
    name: "limits",
    beats: [
      {
        text: "What it does not do. The index sees signatures, not behaviour. The tests see behaviour, so a repository without tests has only the reviewer. And the index reads TypeScript and JavaScript today.",
        step: 1,
      },
      { text: "You can run all of it on your machine with one command: no account, and no keys.", step: 2 },
      { text: "The source is under the MIT licence, and it deploys to your own Cloudflare account.", step: 3 },
    ],
  },
  {
    name: "end",
    beats: [{ text: "dibs. Scopes before edits, tests before reviews, and verdicts in git." }, { text: "", hold: 1.5 }],
  },
];

// ── The pictures and the voice for the cards ──────────────────────────────

const voice = openNarrator(join(outDir, "voice"));
console.log(`Narrated by ${voice.voice}.`);
const studio = await openStudio();

async function cardPart(card: Card): Promise<Part> {
  await studio.open(`cards.html?card=${card.name}`);
  for (const [id, html] of Object.entries(card.fill ?? {})) {
    await studio.call("fill", id, html);
  }
  const part: Part = { duration: 0, shots: [], spoken: [] };
  for (const [index, beat] of card.beats.entries()) {
    const name = `${card.name}-${index}`;
    await studio.call("setStep", beat.step ?? 99);
    await studio.call("setCaption", beat.text);
    const picture = join(work, `${name}.jpg`);
    await studio.still(picture);
    part.shots.push({ file: picture, t: part.duration });
    if (beat.text === "") {
      part.duration += beat.hold ?? 1;
      continue;
    }
    const clip = await voice.speak(beat.text, join(work, name));
    part.spoken.push({ file: clip.file, start: part.duration, duration: clip.duration, text: beat.text });
    part.duration += clip.duration + PAUSE;
  }
  part.duration += CARD_TAIL;
  return part;
}

const opening: Part[] = [];
for (const card of OPENING) {
  opening.push(await cardPart(card));
}
const closing: Part[] = [];
for (const card of CLOSING) {
  closing.push(await cardPart(card));
}
await studio.close();

// ── The run, from just before its first line to its end ───────────────────

const recorded: Part = {
  duration: take.duration,
  shots: take.shots.map((shot) => ({ file: join(takeDir, shot.file), t: shot.t })),
  spoken: take.spoken.map((line) => ({ ...line, file: join(takeDir, line.file) })),
};
const run = cut(recorded, Math.max(0, (recorded.spoken[0]?.start ?? 0) - RUN_LEAD), recorded.duration);
const video = joinParts([...opening, run, ...closing]);

// ── The sound: every line at its moment, on one track ─────────────────────

const track = new Int16Array(Math.ceil((video.duration + 1) * SAMPLE_RATE));
for (const line of video.spoken) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", line.file, "-f", "s16le", "-ac", "1", "-ar", String(SAMPLE_RATE), "-"], { maxBuffer: 1 << 28 });
  const samples = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
  const offset = Math.round(line.start * SAMPLE_RATE);
  for (let index = 0; index < samples.length && offset + index < track.length; index++) {
    track[offset + index] = Math.max(-32768, Math.min(32767, track[offset + index]! + samples[index]!));
  }
}
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + track.byteLength, 4);
header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // one channel
header.writeUInt32LE(SAMPLE_RATE, 24);
header.writeUInt32LE(SAMPLE_RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(track.byteLength, 40);
const narration = join(work, "narration.wav");
writeFileSync(narration, Buffer.concat([header, Buffer.from(track.buffer, track.byteOffset, track.byteLength)]));

// ── The video: every frame is handed to ffmpeg, a picture as many times as it is shown ─

const target = join(outDir, "dibs-demo.mp4");
const encoder = spawn(
  "ffmpeg",
  [
    "-y",
    "-v",
    "error",
    "-f",
    "image2pipe",
    "-framerate",
    String(FPS),
    "-c:v",
    "mjpeg",
    "-i",
    "-",
    "-i",
    narration,
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "18",
    // The pictures are JPEGs: full-range, with the older colour matrix. Players expect neither of a video.
    "-vf",
    "scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p",
    "-color_range",
    "tv",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-r",
    String(FPS),
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ac",
    "2",
    "-af",
    "loudnorm=I=-16:TP=-1.5:LRA=11",
    // loudnorm works at a higher rate and would leave the sound there.
    "-ar",
    String(SAMPLE_RATE),
    "-shortest",
    "-movflags",
    "+faststart",
    target,
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);
const encoded = once(encoder, "exit");
const runs = frames(video, FPS);
let written = 0;
for (const { file, count } of runs) {
  const picture = readFileSync(file);
  for (let copy = 0; copy < count; copy++) {
    if (!encoder.stdin.write(picture)) {
      await once(encoder.stdin, "drain");
    }
    written++;
  }
}
encoder.stdin.end();
const [code] = await encoded;
if (code !== 0) {
  console.error(`ffmpeg stopped with ${code}`);
  process.exit(1);
}

const silent = join(outDir, "dibs-demo-captions-only.mp4");
execFileSync("ffmpeg", ["-y", "-v", "error", "-i", target, "-c:v", "copy", "-an", "-movflags", "+faststart", silent]);

// ── The narration as text, for anyone who records it in their own voice ───

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const runStart = opening.reduce((sum, part) => sum + part.duration, 0);
const runEnd = runStart + run.duration;
writeFileSync(
  join(outDir, "dibs-demo-narration.md"),
  [
    "# dibs demo: the narration",
    "",
    `Every line of \`dibs-demo.mp4\`, with the moment it starts. The video is ${clock(video.duration)} long; the recorded run is from ${clock(runStart)} to ${clock(runEnd)}.`,
    "The lines are burned into the picture as captions, so `dibs-demo-captions-only.mp4` can be narrated afresh: read each line when its caption appears.",
    "",
    "| At | Line |",
    "| --- | --- |",
    ...video.spoken.map((line) => `| ${clock(line.start)} | ${line.text.replaceAll("|", "\\|")} |`),
    "",
  ].join("\n"),
);

console.log(`${clock(video.duration)} of video (${written} frames from ${runs.length} pictures), ${video.spoken.length} lines.`);
console.log(`  ${target}\n  ${silent}\n  ${join(outDir, "dibs-demo-narration.md")}`);
process.exit(0);
