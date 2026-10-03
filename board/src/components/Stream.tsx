import { useRef } from "react";
import type { DibsEvent } from "../../../src/types";
import { describeEvent, type EventLine } from "../lib/describe";
import { clockTime } from "../lib/format";

const TONE: Record<EventLine["tone"], string> = {
  plain: "bg-rule",
  good: "bg-land",
  warn: "bg-caution",
  human: "bg-signal",
};

export function Stream({ events }: { events: DibsEvent[] }) {
  // Events that were already there when the board opened do not animate; ones that arrive later do.
  const openedAt = useRef<number | null>(null);
  if (openedAt.current === null && events.length > 0) {
    openedAt.current = Math.max(...events.map((event) => event.id));
  }

  return (
    <section aria-labelledby="stream-heading">
      <h2 id="stream-heading" className="mb-3 text-[1.0625rem] font-semibold">
        What just happened
      </h2>
      {events.length === 0 ? (
        <p className="text-[0.9375rem] text-ink-soft">Nothing yet. Events appear here as agents claim, submit and merge.</p>
      ) : (
        <ol className="space-y-px" aria-live="polite">
          {[...events].reverse().map((event) => {
            const line = describeEvent(event);
            const isNew = openedAt.current !== null && event.id > openedAt.current;
            return (
              <li
                key={event.id}
                className={`grid grid-cols-[4.25rem_0.375rem_minmax(0,1fr)] gap-x-3 rounded-sm py-1.5 pr-2 ${isNew ? "arrived" : ""}`}
              >
                <time className="mono pt-px text-[0.8125rem] text-ink-soft tabular-nums">{clockTime(event.createdAt)}</time>
                <span aria-hidden="true" className={`mt-1.5 h-[0.75em] rounded-full ${TONE[line.tone]}`} />
                <p className="text-[0.9375rem] leading-snug">
                  {line.text}
                  {line.detail !== undefined && (
                    <span className="line-clamp-2 text-[0.875rem] text-ink-soft" title={line.detail}>
                      {line.detail}
                    </span>
                  )}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
