import type { TaskDiff } from "../api";

function lineClass(line: string): string {
  if (line.startsWith("diff --git")) {
    return "mt-3 font-semibold first:mt-0";
  }
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "text-ink-soft";
  }
  if (line.startsWith("@@")) {
    return "text-ink-soft";
  }
  if (line.startsWith("+")) {
    return "bg-land/12 text-land";
  }
  if (line.startsWith("-")) {
    return "bg-signal/10 text-signal";
  }
  return "";
}

export function Diff({ diff }: { diff: TaskDiff }) {
  const text = diff.files.map((file) => file.text ?? `Binary or submodule change: ${file.path}\n`).join("");
  return (
    <div className="max-h-96 overflow-auto rounded border border-rule bg-paper">
      <pre className="mono min-w-max p-3 text-[0.8125rem] leading-[1.5]">
        {text
          .replace(/\n$/, "")
          .split("\n")
          .map((line, index) => (
            <div key={index} className={lineClass(line)}>
              {line === "" ? " " : line}
            </div>
          ))}
      </pre>
      {diff.truncated && (
        <p className="border-t border-rule px-3 py-2 text-[0.8125rem] text-ink-soft">
          The change is larger than what is shown here.
        </p>
      )}
    </div>
  );
}
