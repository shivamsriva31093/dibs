// The voice that reads the video's narration.
//
// With a Fish Audio key it is Fish Audio's text-to-speech API: the model named in a header, the voice
// given as a reference_id, and retries when the service says to wait. Without a key it is the `say`
// command of macOS.
//
//   FISH_API_KEY=...            the key, or
//   FISH_ENV_FILE=<path>        a file that holds a line FISH_API_KEY=..., such as an .env.local
//   DIBS_FISH_VOICE=<id>        the voice (a Fish reference_id); FISH_VOICE below if not given
//
// Every clip is kept under the name of what was said and in which voice, so a line is spoken once
// however often the video is recorded or built.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// ── How a line is said, where that differs from how it is written ─────────

export interface Pronunciation {
  term: string;
  say: string;
  note?: string;
}

// A line as it is sent to the voice. The captions keep the written form.
export function spokenForm(text: string, map: Pronunciation[]): string {
  const entries = map.filter((entry) => entry.term !== "" && entry.say !== entry.term).sort((a, b) => b.term.length - a.term.length);
  if (entries.length === 0) {
    return text;
  }
  // One pass over the line, so that what has been put in is not looked at again.
  const terms = new RegExp(entries.map((entry) => entry.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return text.replace(terms, (term) => entries.find((entry) => entry.term === term)!.say);
}

// ── Fish Audio ────────────────────────────────────────────────────────────

const FISH_URL = "https://api.fish.audio/v1/tts";
const FISH_MODEL = "s2.1-pro-free";
// The English voice the demo video is narrated in.
const FISH_VOICE = "933563129e564b19a115bedd57b7406a";
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 120_000;
const WAIT_WHEN_TOLD_MS = 30_000;
const WAIT_WHEN_FAILED_MS = 5_000;

export interface FishOptions {
  key: string;
  // A Fish reference_id.
  voice: string;
  model?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

// One line as an MP3. Answers that mean "wait" (429, and 402 when the credit is used up) are
// waited out, and a request that fails outright is made again, three attempts in all.
export async function fishSpeech(text: string, options: FishOptions): Promise<Uint8Array> {
  const ask = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    // A request that hangs is given up: without this, one stuck connection stalls everything.
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await ask(FISH_URL, {
        method: "POST",
        signal: control.signal,
        // The model is chosen by a header, not in the body.
        headers: { Authorization: `Bearer ${options.key}`, "Content-Type": "application/json", model: options.model ?? FISH_MODEL },
        body: JSON.stringify({ text, reference_id: options.voice, format: "mp3", mp3_bitrate: 128, normalize: true, latency: "normal" }),
      });
      if (response.ok) {
        return new Uint8Array(await response.arrayBuffer());
      }
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(`Fish Audio could not be reached: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      }
      await sleep(WAIT_WHEN_FAILED_MS);
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (response.status !== 402 && response.status !== 429) {
      const said = (await response.text()).slice(0, 300).replaceAll(options.key, "…");
      throw new Error(`Fish Audio answered HTTP ${response.status} ${said}`);
    }
    if (attempt >= MAX_ATTEMPTS) {
      throw new Error(`Fish Audio answered HTTP ${response.status} after ${attempt} attempts`);
    }
    await sleep(WAIT_WHEN_TOLD_MS);
  }
}

// ── The clips ─────────────────────────────────────────────────────────────

// The name a clip is kept under: the same for the same words in the same voice.
export function clipName(spoken: string, engine: string, voice: string): string {
  return createHash("sha256").update(`${engine}\n${voice}\n${spoken}`).digest("hex").slice(0, 24);
}

export interface Clip {
  file: string;
  // Seconds.
  duration: number;
}

export interface Narrator {
  // Which voice this is, in a few words.
  voice: string;
  // Reads a line into `<base>.<the voice's file type>` and says how long it takes to say.
  speak(text: string, base: string): Promise<Clip>;
  // Speaks lines ahead of time, so that they are at hand when they are needed. Returns how many were new.
  prepare(texts: string[]): Promise<number>;
}

async function seconds(file: string): Promise<number> {
  const probed = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  const duration = Number(probed.stdout);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not read the length of ${file}`);
  }
  return duration;
}

function fishKey(): string | undefined {
  if (process.env.FISH_API_KEY) {
    return process.env.FISH_API_KEY;
  }
  const file = process.env.FISH_ENV_FILE;
  if (file === undefined) {
    return undefined;
  }
  const key = readFileSync(file, "utf8")
    .match(/^FISH_API_KEY=(.+)$/m)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  if (!key) {
    throw new Error(`FISH_API_KEY not found in ${file}`);
  }
  return key;
}

// The narrator for this run: Fish Audio when there is a key for it, the computer's own voice otherwise.
// Clips are kept in `store` and reused.
export function openNarrator(store: string): Narrator {
  mkdirSync(store, { recursive: true });
  const pronunciations = JSON.parse(readFileSync(join(import.meta.dirname, "pronunciations.json"), "utf8")) as { entries: Pronunciation[] };
  const key = fishKey();
  const engine =
    key === undefined
      ? {
          name: "say",
          voice: process.env.DIBS_VOICE ?? "Samantha",
          type: "aiff",
          describe: (voice: string) => `the ${voice} voice of macOS`,
          make: (spoken: string, voice: string, file: string) => run("say", ["-v", voice, "-r", "182", "-o", file, spoken]).then(() => undefined),
        }
      : {
          name: `fish ${process.env.DIBS_FISH_MODEL ?? FISH_MODEL}`,
          voice: process.env.DIBS_FISH_VOICE ?? FISH_VOICE,
          type: "mp3",
          describe: (voice: string) => `Fish Audio, voice ${voice}`,
          make: async (spoken: string, voice: string, file: string) =>
            writeFileSync(file, await fishSpeech(spoken, { key, voice, ...(process.env.DIBS_FISH_MODEL ? { model: process.env.DIBS_FISH_MODEL } : {}) })),
        };

  // One request at a time, and one request for a line however many ask for it at once.
  const making = new Map<string, Promise<string>>();
  let last: Promise<unknown> = Promise.resolve();
  function kept(spoken: string): Promise<string> {
    const file = join(store, `${clipName(spoken, engine.name, engine.voice)}.${engine.type}`);
    if (existsSync(file)) {
      return Promise.resolve(file);
    }
    let pending = making.get(file);
    if (pending === undefined) {
      pending = last
        .catch(() => undefined)
        .then(async () => {
          const unfinished = `${file}.part.${engine.type}`;
          await engine.make(spoken, engine.voice, unfinished);
          // A clip appears under its name only when it is whole.
          renameSync(unfinished, file);
          return file;
        });
      last = pending;
      making.set(file, pending);
      void pending.catch(() => making.delete(file));
    }
    return pending;
  }

  return {
    voice: engine.describe(engine.voice),
    async speak(text, base) {
      const clip = await kept(spokenForm(text, pronunciations.entries));
      const file = `${base}.${engine.type}`;
      copyFileSync(clip, file);
      return { file, duration: await seconds(file) };
    },
    async prepare(texts) {
      let made = 0;
      for (const text of texts) {
        const spoken = spokenForm(text, pronunciations.entries);
        if (!existsSync(join(store, `${clipName(spoken, engine.name, engine.voice)}.${engine.type}`))) {
          made++;
        }
        await kept(spoken);
      }
      return made;
    },
  };
}
