import type { BoardTask } from "../../../src/types";
import { shortSha } from "../lib/format";
import type { StakeOf } from "../lib/stakes";

export function Landed({ tasks, stakeOf }: { tasks: BoardTask[]; stakeOf: StakeOf }) {
  if (tasks.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="landed-heading">
      <h2 id="landed-heading" className="mb-3 text-[1.0625rem] font-semibold">
        Landed on main
      </h2>
      <ol className="space-y-1.5">
        {tasks.map((task) => (
          <li key={task.id} className="grid grid-cols-[4.5rem_minmax(6.5rem,auto)_minmax(0,1fr)] items-baseline gap-x-4 text-[0.9375rem]">
            <span className="mono text-land">{shortSha(task.mergeSha ?? "")}</span>
            <span className="font-semibold" style={{ color: stakeOf(task.agent) }}>
              {task.agent}
            </span>
            <span className="truncate" title={task.goal}>
              {task.goal}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
