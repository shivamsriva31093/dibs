// What the two video scripts share: a headless browser that shows the pages in this
// directory and can be filmed.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Shot } from "./timeline.ts";

export const root = join(import.meta.dirname, "..");
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Json = Record<string, any>;

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WIDTH = 1920;
const HEIGHT = 1080;
// How far a frame's own time may be from the clock here before the clock is used instead.
const CLOCK_TOLERANCE_SECONDS = 5;

export interface Film {
  // Seconds since filming began.
  now(): number;
  stop(): Promise<{ shots: Shot[]; duration: number }>;
}

export interface Studio {
  // Sends one command of the DevTools protocol.
  send(method: string, params?: Json): Promise<Json>;
  // Runs JavaScript on the page and returns what it evaluates to.
  evaluate<T = unknown>(expression: string): Promise<T>;
  // Calls a function of the page with values.
  call(name: string, ...args: unknown[]): Promise<unknown>;
  // Shows a page of this directory, for example open("cards.html?card=title").
  open(page: string): Promise<void>;
  // Saves what the page shows now.
  still(file: string): Promise<void>;
  // Saves every frame the page draws from now on into a directory, each with its moment.
  film(directory: string): Promise<Film>;
  close(): Promise<void>;
}

export async function openStudio(): Promise<Studio> {
  const assets = join(root, "board/dist/assets");
  const font = existsSync(assets) ? readdirSync(assets).find((name) => name.startsWith("recursive-latin-full")) : undefined;
  if (font === undefined) {
    throw new Error("The pages use the board's typeface. Build the board first: pnpm build:board");
  }
  const pages = createServer((request, response) => {
    const name = new URL(request.url ?? "/", "http://localhost").pathname.slice(1);
    if (name === "font.woff2") {
      response.writeHead(200, { "content-type": "font/woff2" }).end(readFileSync(join(assets, font)));
    } else if (/^[a-z-]+\.html$/.test(name) && existsSync(join(root, "video", name))) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(join(root, "video", name)));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => pages.listen(0, "127.0.0.1", resolve));
  const pagesPort = (pages.address() as { port: number }).port;

  const debugPort = 9400 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), "dibs-video-chrome-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--window-size=${WIDTH},${HEIGHT}`,
      // The stage reaches into the board's frame to sign in and to click as the person would.
      "--disable-web-security",
      "--disable-site-isolation-trials",
      "--disable-features=IsolateOrigins,site-per-process",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const chromeGone = new Promise<void>((resolve) => chrome.once("exit", () => resolve()));

  let address = "";
  for (let attempt = 0; attempt < 100 && address === ""; attempt++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()) as Json[];
      address = targets.find((target) => target.type === "page")?.webSocketDebuggerUrl ?? "";
    } catch {
      await sleep(100);
    }
  }
  if (address === "") {
    chrome.kill();
    throw new Error(`The browser did not start: ${CHROME}`);
  }
  const socket = new WebSocket(address);
  await new Promise((resolve) => socket.addEventListener("open", resolve));

  let nextId = 0;
  const waiting = new Map<number, (result: Json) => void>();
  const listeners = new Map<string, (params: Json) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Json;
    if (message.id !== undefined && waiting.has(message.id)) {
      waiting.get(message.id)!(message.result ?? message.error ?? {});
      waiting.delete(message.id);
    } else if (typeof message.method === "string") {
      listeners.get(message.method)?.(message.params ?? {});
    }
  });
  const send = (method: string, params: Json = {}) =>
    new Promise<Json>((resolve) => {
      const id = ++nextId;
      waiting.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });

  async function evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails !== undefined) {
      throw new Error(`on the page: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result?.value as T;
  }

  await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await send("Page.enable");

  return {
    send,
    evaluate,
    call: (name, ...args) => evaluate(`${name}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`),

    async open(page) {
      const loaded = new Promise<void>((resolve) => listeners.set("Page.loadEventFired", () => resolve()));
      await send("Page.navigate", { url: `http://127.0.0.1:${pagesPort}/${page}` });
      await loaded;
      listeners.delete("Page.loadEventFired");
      // A picture taken before the typeface has arrived shows the fallback one.
      await evaluate("document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
    },

    async still(file) {
      const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 95 });
      if (typeof shot.data !== "string") {
        throw new Error(`The browser gave no picture for ${file}`);
      }
      writeFileSync(file, Buffer.from(shot.data, "base64"));
    },

    async film(directory) {
      mkdirSync(directory, { recursive: true });
      const began = Date.now() / 1000;
      const shots: Shot[] = [];
      listeners.set("Page.screencastFrame", (params) => {
        const arrived = Date.now() / 1000;
        const drawn = Number(params.metadata?.timestamp);
        const at = Number.isFinite(drawn) && Math.abs(drawn - arrived) < CLOCK_TOLERANCE_SECONDS ? drawn : arrived;
        const file = join(directory, `f${String(shots.length).padStart(6, "0")}.jpg`);
        writeFileSync(file, Buffer.from(String(params.data), "base64"));
        shots.push({ file, t: Math.max(0, at - began) });
        // The browser sends the next frame only once this one is acknowledged.
        void send("Page.screencastFrameAck", { sessionId: params.sessionId });
      });
      // The browser sends a frame whenever the page changes, and none while it stands still.
      await send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });
      return {
        now: () => Date.now() / 1000 - began,
        async stop() {
          await send("Page.stopScreencast");
          listeners.delete("Page.screencastFrame");
          return { shots, duration: Date.now() / 1000 - began };
        },
      };
    },

    async close() {
      socket.close();
      chrome.kill();
      await chromeGone;
      pages.close();
      // The browser may still be letting go of its files.
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
