import { useEffect, useMemo, useState } from "react";
import { ApiError, httpApi, type Api } from "./api";
import { Ground } from "./components/Ground";
import { Header } from "./components/Header";
import { Landed } from "./components/Landed";
import { Stream } from "./components/Stream";
import { TokenGate } from "./components/TokenGate";
import { Waiting } from "./components/Waiting";
import { useBoard } from "./hooks/useBoard";
import { refusalsFrom } from "./lib/describe";
import { stakes } from "./lib/stakes";
import { buildClaimRows } from "./lib/tree";
import { mockApi } from "./mock";

const TOKEN_KEY = "dibs.token";
const params = new URLSearchParams(location.search);
const MOCK = params.has("mock");

function Board({ api, repos }: { api: Api; repos: string[] }) {
  const [repo, setRepo] = useState(() => {
    const wanted = params.get("repo");
    return wanted !== null && repos.includes(wanted) ? wanted : repos[0]!;
  });
  const board = useBoard(api, repo);
  const { snapshot } = board;

  // In mock mode the clock is frozen, so the canned "just now" events stay recent.
  const now = MOCK ? (snapshot?.events.at(-1)?.createdAt ?? board.now) + 4000 : board.now;
  const stakeOf = useMemo(() => stakes(snapshot?.agents ?? []), [snapshot?.agents]);
  const rows = useMemo(
    () => (snapshot === null ? [] : buildClaimRows(snapshot.tasks, refusalsFrom(snapshot.events, now))),
    [snapshot, now],
  );

  return (
    <div className="min-h-screen">
      <Header repo={repo} repos={repos} onRepo={setRepo} live={board.live} snapshot={snapshot} />

      {board.error !== null && (
        <p className="border-b border-rule bg-wash px-6 py-2 text-[0.9375rem] text-signal" role="alert">
          The board could not load the latest state: {board.error}
        </p>
      )}

      {snapshot === null ? (
        <p className="px-6 py-8 text-[0.9375rem] text-ink-soft">Loading {repo}</p>
      ) : (
        <main className="grid gap-x-10 gap-y-10 px-6 py-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div className="space-y-10">
            <Ground rows={rows} waiting={snapshot.waiting} stakeOf={stakeOf} now={now} />
            <Stream events={snapshot.events} />
          </div>
          <div className="space-y-10">
            <Waiting
              tasks={snapshot.tasks.filter((task) => task.state === "escalated")}
              thresholds={snapshot.config.decider}
              stakeOf={stakeOf}
              loadDiff={(taskId) => api.diff(repo, taskId)}
              decide={async (taskId, decision, note) => {
                await api.decide(repo, taskId, decision, note);
                board.refresh();
              }}
            />
            <Landed
              tasks={snapshot.tasks.filter((task) => task.state === "merged").sort((a, b) => b.updatedAt - a.updatedAt)}
              stakeOf={stakeOf}
            />
          </div>
        </main>
      )}
    </div>
  );
}

export function App() {
  const [token, setToken] = useState<string | null>(() => (MOCK ? "mock" : localStorage.getItem(TOKEN_KEY)));
  const [rejected, setRejected] = useState(false);
  const [repos, setRepos] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const api = useMemo(() => (token === null ? null : MOCK ? mockApi() : httpApi(token)), [token]);

  useEffect(() => {
    if (api === null) {
      return;
    }
    let cancelled = false;
    api.repos().then(
      (names) => {
        if (!cancelled) {
          setRepos(names);
          setRejected(false);
          if (!MOCK && token !== null) {
            localStorage.setItem(TOKEN_KEY, token);
          }
        }
      },
      (caught: unknown) => {
        if (cancelled) {
          return;
        }
        if (caught instanceof ApiError && caught.status === 401) {
          localStorage.removeItem(TOKEN_KEY);
          setToken(null);
          setRejected(true);
        } else {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, token]);

  if (token === null || api === null) {
    return <TokenGate rejected={rejected} onToken={setToken} />;
  }
  if (error !== null) {
    return (
      <p className="px-6 py-8 text-[0.9375rem] text-signal" role="alert">
        The board could not reach dibs: {error}
      </p>
    );
  }
  if (repos === null) {
    return <p className="px-6 py-8 text-[0.9375rem] text-ink-soft">Opening the board</p>;
  }
  if (repos.length === 0) {
    return (
      <main className="mx-auto max-w-[60ch] px-6 py-16">
        <h1 className="wordmark text-[3rem] leading-none">dibs</h1>
        <p className="mt-4 text-[1.0625rem]">
          No repository is registered yet. Register one with <span className="mono">POST /api/repos</span>, then reload
          this page.
        </p>
      </main>
    );
  }
  return <Board api={api} repos={repos} />;
}
