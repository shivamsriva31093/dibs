import type { Snapshot } from "../../../src/types";

interface Props {
  repo: string;
  repos: string[];
  onRepo(repo: string): void;
  live: boolean;
  snapshot: Snapshot | null;
}

const LIVE_STATES = new Set(["active", "in_review", "escalated"]);

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function Header({ repo, repos, onRepo, live, snapshot }: Props) {
  const liveTasks = snapshot?.tasks.filter((task) => LIVE_STATES.has(task.state)).length ?? 0;
  const shadow = snapshot?.shadow;

  return (
    <header className="flex flex-wrap items-baseline gap-x-8 gap-y-2 border-b border-rule px-6 py-4">
      <h1 className="wordmark text-[1.75rem] leading-none">dibs</h1>

      {repos.length > 1 ? (
        <label className="flex items-baseline gap-2 text-[0.9375rem]">
          <span className="text-ink-soft">Repository</span>
          <select
            className="mono rounded border border-rule bg-paper px-2 py-1"
            value={repo}
            onChange={(event) => onRepo(event.target.value)}
          >
            {repos.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
      ) : (
        <span className="mono text-[1.0625rem]">{repo}</span>
      )}

      {snapshot !== null && (
        <p className="text-[0.9375rem] text-ink-soft">
          {plural(snapshot.agents.length, "agent", "agents")}, {plural(liveTasks, "live task", "live tasks")}
        </p>
      )}

      {shadow !== undefined && shadow.reviewed > 0 && (
        <p className="text-[0.9375rem] text-ink-soft">
          Clef alone would have matched {shadow.agreed} of {plural(shadow.reviewed, "review", "reviews")}
        </p>
      )}

      <p className="ml-auto flex items-center gap-2 text-[0.9375rem]" role="status">
        <span
          aria-hidden="true"
          className={`inline-block size-2.5 rounded-full ${live ? "bg-land" : "bg-caution"}`}
        />
        {live ? "Live" : "Reconnecting"}
      </p>
    </header>
  );
}
