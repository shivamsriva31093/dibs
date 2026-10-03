import { useState } from "react";
import type { BoardTask, DeciderConfig, Triage } from "../../../src/types";
import type { Decision, TaskDiff } from "../api";
import { escalationReasons, lookedUp } from "../lib/describe";
import type { StakeOf } from "../lib/stakes";
import { Diff } from "./Diff";

interface Props {
  tasks: BoardTask[];
  thresholds: DeciderConfig;
  stakeOf: StakeOf;
  loadDiff(taskId: string): Promise<TaskDiff>;
  decide(taskId: string, decision: Decision, note: string): Promise<void>;
}

type Body = Record<string, unknown>;
const asRecord = (value: unknown): Body => (typeof value === "object" && value !== null ? (value as Body) : {});
const asList = (value: unknown): Body[] => (Array.isArray(value) ? value.map(asRecord) : []);
const asText = (value: unknown): string => (typeof value === "string" ? value : "");

function Meter({ label, value, max, text, flagged }: { label: string; value: number; max: number; text: string; flagged: boolean }) {
  return (
    <div className="grid grid-cols-[9.5rem_minmax(0,1fr)_3.5rem] items-center gap-3 text-[0.8125rem]">
      <span className={flagged ? "font-semibold text-signal" : "text-ink-soft"}>{label}</span>
      <span className="h-1.5 rounded-full bg-rule" role="presentation">
        <span
          className={`block h-full rounded-full ${flagged ? "bg-signal" : "bg-ink"}`}
          style={{ width: `${Math.min(100, Math.max(0, (value / max) * 100))}%` }}
        />
      </span>
      <span className="mono text-right tabular-nums">{text}</span>
    </div>
  );
}

function Signals({ triage, thresholds }: { triage: Triage; thresholds: DeciderConfig }) {
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  return (
    <div className="space-y-1.5">
      <Meter label="Fits the goal" value={triage.goal_fit.score} max={3} text={`${triage.goal_fit.score.toFixed(1)} / 3`} flagged={false} />
      <Meter label="Risk" value={triage.risk.score} max={3} text={`${triage.risk.score.toFixed(1)} / 3`} flagged={false} />
      <Meter
        label="Chance of high risk"
        value={triage.risk.high}
        max={1}
        text={percent(triage.risk.high)}
        flagged={triage.risk.high >= thresholds.riskHighMin}
      />
      <Meter
        label="Changes an interface"
        value={triage.interface_change}
        max={1}
        text={percent(triage.interface_change)}
        flagged={triage.interface_change >= thresholds.interfaceChangeMin}
      />
      <Meter label="Unrelated changes" value={triage.unrelated_changes} max={1} text={percent(triage.unrelated_changes)} flagged={false} />
      <Meter label="Leftovers" value={triage.leftovers} max={1} text={percent(triage.leftovers)} flagged={false} />
    </div>
  );
}

function Escalation({ task, thresholds, stakeOf, loadDiff, decide }: Omit<Props, "tasks"> & { task: BoardTask }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<TaskDiff | "loading" | null>(null);

  const body = asRecord(task.verdict?.body);
  const reviewerDecision = asText(body.decision);
  const summary = asText(body.summary);
  const issues = asList(body.issues);
  const triage = task.submission?.triage ?? null;

  const act = async (decision: Decision) => {
    setBusy(decision);
    setError(null);
    try {
      await decide(task.id, decision, note);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(null);
    }
  };

  const showDiff = async () => {
    setDiff("loading");
    try {
      setDiff(await loadDiff(task.id));
    } catch (caught) {
      setDiff(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <li className="space-y-4 border-l-4 border-signal bg-wash py-4 pr-4 pl-5">
      <div>
        <p className="line-clamp-3 text-[1.0625rem] leading-snug font-semibold" title={task.goal}>
          {task.goal}
        </p>
        <p className="mt-1 text-[0.875rem] text-ink-soft">
          <span className="font-semibold" style={{ color: stakeOf(task.agent) }}>
            {task.agent}
          </span>{" "}
          changed <span className="mono">{task.paths.join(", ")}</span>
          {task.cycle > 1 && `, attempt ${task.cycle}`}
        </p>
      </div>

      <div>
        <h3 className="text-[0.875rem] font-semibold">Why it needs you</h3>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[0.9375rem]">
          {escalationReasons(body).map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </div>

      {summary !== "" && (
        <div>
          <h3 className="text-[0.875rem] font-semibold">
            {reviewerDecision === "approve"
              ? "The reviewer would have approved it"
              : reviewerDecision === "reject"
                ? "The reviewer rejected it"
                : "The reviewer could not decide"}
          </h3>
          <p className="mt-1 max-w-[68ch] text-[0.9375rem]">{summary}</p>
          {lookedUp(body) !== "" && <p className="mt-1 max-w-[68ch] text-[0.8125rem] text-ink-soft">{lookedUp(body)}</p>}
          {issues.length > 0 && (
            <ul className="mt-2 space-y-1.5 text-[0.875rem]">
              {issues.map((issue, index) => (
                <li key={index}>
                  <span className="font-semibold">{asText(issue.severity)}</span>{" "}
                  <span className="mono">
                    {asText(issue.path)}
                    {typeof issue.line === "number" ? `:${issue.line}` : ""}
                  </span>{" "}
                  {asText(issue.description)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {triage !== null && (
        <div>
          <h3 className="mb-2 text-[0.875rem] font-semibold">What Clef saw</h3>
          <Signals triage={triage} thresholds={thresholds} />
        </div>
      )}

      {diff === null ? (
        <button type="button" className="text-[0.9375rem] underline underline-offset-4" onClick={() => void showDiff()}>
          Show the diff
        </button>
      ) : diff === "loading" ? (
        <p className="text-[0.875rem] text-ink-soft">Loading the diff</p>
      ) : (
        <Diff diff={diff} />
      )}

      <div className="space-y-3">
        <label className="block text-[0.875rem]">
          <span className="font-semibold">Note</span>
          <span className="text-ink-soft"> (goes to the agent if you send it back)</span>
          <textarea
            className="mt-1 block w-full rounded border border-rule bg-paper px-3 py-2 text-[0.9375rem]"
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className="rounded bg-ink px-4 py-2 text-[0.9375rem] font-semibold text-paper disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => void act("approve")}
          >
            {busy === "approve" ? "Merging" : "Approve and merge"}
          </button>
          <button
            type="button"
            className="rounded border border-ink px-4 py-2 text-[0.9375rem] font-semibold disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => void act("send_back")}
          >
            {busy === "send_back" ? "Sending back" : "Send back"}
          </button>
          <button
            type="button"
            className="rounded px-4 py-2 text-[0.9375rem] text-ink-soft underline underline-offset-4 disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => void act("close")}
          >
            {busy === "close" ? "Closing" : "Close task"}
          </button>
        </div>
        {error !== null && (
          <p className="text-[0.875rem] text-signal" role="alert">
            That did not go through: {error}
          </p>
        )}
      </div>
    </li>
  );
}

export function Waiting({ tasks, ...rest }: Props) {
  return (
    <section aria-labelledby="waiting-heading">
      <h2 id="waiting-heading" className="mb-3 flex items-baseline gap-3 text-[1.0625rem] font-semibold">
        Waiting for you
        {tasks.length > 0 && (
          <span className="rounded-full bg-signal px-2 py-0.5 text-[0.8125rem] leading-none font-semibold text-paper tabular-nums">
            {tasks.length}
          </span>
        )}
      </h2>
      {tasks.length === 0 ? (
        <p className="text-[0.9375rem] text-ink-soft">Nothing needs you. Changes the review can settle are merged or sent back without you.</p>
      ) : (
        <ul className="space-y-4">
          {tasks.map((task) => (
            <Escalation key={task.id} task={task} {...rest} />
          ))}
        </ul>
      )}
    </section>
  );
}
