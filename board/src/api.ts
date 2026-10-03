// The board's calls to the dibs HTTP API.

import type { Snapshot } from "../../src/types";

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted";
  text: string | null;
}

export interface TaskDiff {
  files: DiffFile[];
  bytes: number;
  unreviewable: string[];
  truncated: boolean;
}

export type Decision = "approve" | "send_back" | "close";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
  });
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!response.ok) {
    throw new ApiError(response.status, body?.error?.message ?? `the server answered ${response.status}`);
  }
  return body as T;
}

export interface Api {
  repos(): Promise<string[]>;
  snapshot(repo: string): Promise<Snapshot>;
  diff(repo: string, taskId: string): Promise<TaskDiff>;
  decide(repo: string, taskId: string, decision: Decision, note: string): Promise<void>;
  // Calls `onEvent` for every event the server pushes; returns a function that closes the connection.
  listen(repo: string, onEvent: () => void, onStatus: (live: boolean) => void): () => void;
}

export function httpApi(token: string): Api {
  return {
    repos: async () => (await call<{ repos: { name: string }[] }>(token, "/api/repos")).repos.map((repo) => repo.name),
    snapshot: (repo) => call<Snapshot>(token, `/api/repos/${repo}/state`),
    diff: (repo, taskId) => call<TaskDiff>(token, `/api/repos/${repo}/tasks/${taskId}/diff`),
    decide: async (repo, taskId, decision, note) => {
      await call(token, `/api/repos/${repo}/escalations/${taskId}`, {
        method: "POST",
        body: JSON.stringify({ decision, note }),
      });
    },
    listen: (repo, onEvent, onStatus) => {
      let socket: WebSocket | null = null;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let closed = false;

      const connect = () => {
        const scheme = location.protocol === "https:" ? "wss" : "ws";
        // A browser cannot set headers on a WebSocket, so the token travels as an offered subprotocol.
        // That keeps it out of the URL, and so out of the Worker's request logs.
        const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(token)))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
        socket = new WebSocket(`${scheme}://${location.host}/api/repos/${repo}/ws`, ["dibs", `token.${encoded}`]);
        socket.addEventListener("open", () => onStatus(true));
        socket.addEventListener("message", onEvent);
        socket.addEventListener("close", () => {
          onStatus(false);
          if (!closed) {
            retry = setTimeout(connect, 2000);
          }
        });
      };
      connect();

      return () => {
        closed = true;
        clearTimeout(retry);
        socket?.close();
      };
    },
  };
}
