import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "../../../src/types";
import type { Api } from "../api";

export interface Board {
  snapshot: Snapshot | null;
  error: string | null;
  // Whether the live connection is up. The board still refreshes on a timer when it is not.
  live: boolean;
  // The current time, ticking once a second, so "time left" and short-lived notices stay current.
  now: number;
  refresh(): void;
}

const SAFETY_REFRESH_MS = 10_000;
const COALESCE_MS = 120;

// Loads the repository's state, then reloads it whenever the server pushes an event.
// Reloading on every event keeps one source of truth: the server's snapshot.
export function useBoard(api: Api, repo: string | null): Board {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    if (repo === null) {
      return;
    }
    try {
      setSnapshot(await api.snapshot(repo));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [api, repo]);

  // Several events often arrive together; one reload covers them.
  const refresh = useCallback(() => {
    clearTimeout(pending.current);
    pending.current = setTimeout(() => void load(), COALESCE_MS);
  }, [load]);

  useEffect(() => {
    if (repo === null) {
      return;
    }
    setSnapshot(null);
    void load();
    const stop = api.listen(repo, refresh, setLive);
    const safety = setInterval(() => void load(), SAFETY_REFRESH_MS);
    return () => {
      stop();
      clearInterval(safety);
      clearTimeout(pending.current);
    };
  }, [api, repo, load, refresh]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  return { snapshot, error, live, now, refresh };
}
