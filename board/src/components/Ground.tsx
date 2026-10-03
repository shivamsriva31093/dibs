import type { CSSProperties } from "react";
import type { BoardTask, CollisionView, WaitingView } from "../../../src/types";
import { groupRelated } from "../lib/describe";
import { timeLeft } from "../lib/format";
import type { StakeOf } from "../lib/stakes";
import type { ClaimRow } from "../lib/tree";

interface Props {
  rows: ClaimRow[];
  // The requests waiting in line for what the live tasks hold.
  waiting: WaitingView[];
  stakeOf: StakeOf;
  now: number;
}

// What a collision means for the task whose row it is shown under, in one line.
function meeting(collision: CollisionView): { text: string; quiet: boolean } {
  const what = collision.targets.join(", ");
  const other = collision.with.agent;
  if (collision.state === "possible") {
    return {
      quiet: true,
      text: collision.role === "relier" ? `Uses ${what}, in code ${other} holds` : `${other} uses ${what} here`,
    };
  }
  const first = collision.order === null ? "" : ` ${collision.order.first} goes first.`;
  return {
    quiet: false,
    text:
      collision.role === "relier"
        ? `Relies on ${what}, which ${other} ${collision.with.mergeSha === null ? "is changing" : "has changed"}.${first}`
        : `Changes ${what}, which ${other} relies on.${first}`,
  };
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth"];

function stateLabel(task: BoardTask): string {
  if (task.state === "in_review") {
    return "in review";
  }
  if (task.state === "escalated") {
    return "waiting for you";
  }
  return task.cycle > 1 ? `fixing, attempt ${task.cycle}` : "working";
}

function Row({ row, stakeOf, now }: { row: ClaimRow; stakeOf: StakeOf; now: number }) {
  const indent = { paddingLeft: `${0.75 + row.depth * 1.5}rem` };
  const task = row.holder;

  if (task === null) {
    return (
      <li className="mono py-1.5 text-[0.9375rem] text-ink-soft" style={indent}>
        {row.label}
      </li>
    );
  }

  const style = { "--stake": stakeOf(task.agent), ...indent } as CSSProperties;
  return (
    <li>
      <div
        className="stake grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-0.5 rounded-sm py-2 pr-3 md:grid-cols-[minmax(8rem,24%)_7rem_minmax(0,1fr)_12.5rem]"
        style={style}
      >
        <span className="mono order-1 truncate text-[0.9375rem] font-medium md:order-none" title={row.path}>
          {row.label}
          {row.relation === "add" && (
            <span className="ml-2 font-sans text-[0.75rem] font-normal text-ink-soft" title="Several tasks may add to this at once">
              shared
            </span>
          )}
        </span>
        <span className="order-3 col-span-2 text-[0.9375rem] font-semibold md:order-none md:col-span-1">
          <span style={{ color: stakeOf(task.agent) }}>{task.agent}</span>
          {row.sharers.map((sharer) => (
            <span key={sharer.id} className="block" style={{ color: stakeOf(sharer.agent) }} title={sharer.goal}>
              {sharer.agent}
            </span>
          ))}
        </span>
        <span className="order-4 col-span-2 line-clamp-2 text-[0.9375rem] leading-snug md:order-none md:col-span-1" title={task.goal}>
          {task.goal}
        </span>
        <span className="order-2 text-right text-[0.875rem] whitespace-nowrap md:order-none">
          <span className={task.state === "escalated" ? "font-semibold text-signal" : ""}>{stateLabel(task)}</span>
          {task.claimExpiresAt !== null && (
            <span className="ml-3 text-ink-soft tabular-nums">{timeLeft(task.claimExpiresAt - now)}</span>
          )}
        </span>

        {row.first && task.related.length > 0 && (
          <p className="order-5 col-span-2 mt-1 text-[0.8125rem] text-ink-soft md:order-none md:col-span-4">
            {groupRelated(task.related).map((group) => (
              <span key={group.lead} className="mr-4">
                {group.lead}{" "}
                {group.others.map((other, index) => (
                  <span key={other.taskId}>
                    {index > 0 && (index === group.others.length - 1 ? " and " : ", ")}
                    <span className="font-semibold" style={{ color: stakeOf(other.agent) }} title={other.goal}>
                      {other.agent}
                    </span>
                  </span>
                ))}
              </span>
            ))}
          </p>
        )}
        {row.first &&
          task.collisions
            .filter((collision) => collision.kind === "contract")
            .map((collision) => {
              const told = meeting(collision);
              return (
                <p
                  key={collision.id}
                  className={`order-6 col-span-2 mt-1 text-[0.8125rem] md:order-none md:col-span-4 ${told.quiet ? "text-ink-soft" : "text-caution"}`}
                  title={collision.brief}
                >
                  {told.text}
                </p>
              );
            })}
      </div>

      {row.refusals.map((refusal) => (
        <p
          key={refusal.id}
          className="refused mt-1 rounded-sm border border-dashed border-caution py-1.5 pr-3 text-[0.875rem] text-caution"
          style={{ ...indent, marginLeft: "1.5rem" }}
        >
          <span className="font-semibold" style={{ color: stakeOf(refusal.agent) }}>
            {refusal.agent}
          </span>{" "}
          asked for <span className="mono">{refusal.requested.join(", ")}</span> and was refused: {task.agent} has dibs
        </p>
      ))}
    </li>
  );
}

function Line({ waiting, stakeOf }: { waiting: WaitingView[]; stakeOf: StakeOf }) {
  return (
    <div className="mt-5">
      <h3 className="mb-2 text-[0.9375rem] font-semibold">In line</h3>
      <ul className="space-y-1.5">
        {waiting.map((request) => (
          <li key={request.requestId} className="text-[0.875rem]" title={request.goal}>
            <span className="font-semibold" style={{ color: stakeOf(request.agent) }}>
              {request.agent}
            </span>{" "}
            is {ORDINALS[request.position - 1] ?? `number ${request.position}`} in line for{" "}
            <span className="mono">{request.scope.map((entry) => entry.target).join(", ")}</span>
            {request.blockedBy.length > 0 && (
              <span className="text-ink-soft">
                , held by{" "}
                {request.blockedBy.map((blocker, index) => (
                  <span key={blocker.taskId}>
                    {index > 0 && " and "}
                    <span className="font-semibold" style={{ color: stakeOf(blocker.agent) }}>
                      {blocker.agent}
                    </span>
                  </span>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Ground({ rows, waiting, stakeOf, now }: Props) {
  return (
    <section aria-labelledby="ground-heading">
      <h2 id="ground-heading" className="mb-3 text-[1.0625rem] font-semibold">
        Who has dibs
      </h2>
      {rows.length === 0 ? (
        <p className="max-w-[60ch] text-[0.9375rem] text-ink-soft">
          Nothing is held. An agent says what it will change, add to and rely on by calling{" "}
          <span className="mono">start_task</span> before it edits anything.
        </p>
      ) : (
        <ul className="space-y-1">
          {rows.map((row) => (
            <Row key={row.path} row={row} stakeOf={stakeOf} now={now} />
          ))}
        </ul>
      )}
      {waiting.length > 0 && <Line waiting={waiting} stakeOf={stakeOf} />}
    </section>
  );
}
