// Commit message trailers: the "Key: value" lines in the last paragraph of a
// commit message. dibs writes its own (Dibs-Task and friends) and carries over
// any others found on the task's commits, such as Entire's checkpoint link.

export interface Trailer {
  key: string;
  value: string;
}

const TRAILER_LINE = /^([A-Za-z0-9-]+):[ \t]*(.+)$/;
const DIBS_NAMESPACE = "dibs-";

export function parseTrailers(message: string): Trailer[] {
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
    lines.pop();
  }
  // The first paragraph is the subject and is never a trailer block.
  const lastBlank = lines.findLastIndex((line) => line.trim() === "");
  if (lastBlank === -1) {
    return [];
  }

  const trailers: Trailer[] = [];
  for (const line of lines.slice(lastBlank + 1)) {
    const match = TRAILER_LINE.exec(line);
    if (match !== null) {
      trailers.push({ key: match[1]!, value: match[2]!.trim() });
    } else if (/^[ \t]/.test(line) && trailers.length > 0) {
      trailers[trailers.length - 1]!.value += ` ${line.trim()}`;
    } else {
      return [];
    }
  }
  return trailers;
}

// Trailers from a task's own commits, oldest first, without exact repeats and
// without anything in the Dibs- namespace, which only dibs may write.
export function collectForeignTrailers(messagesNewestFirst: string[]): Trailer[] {
  const seen = new Set<string>();
  const out: Trailer[] = [];
  for (const message of [...messagesNewestFirst].reverse()) {
    for (const trailer of parseTrailers(message)) {
      const key = trailer.key.toLowerCase();
      const identity = `${key}\0${trailer.value}`;
      if (key.startsWith(DIBS_NAMESPACE) || seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      out.push(trailer);
    }
  }
  return out;
}

export interface MergeMessageInput {
  goal: string;
  summary: string;
  taskId: string;
  agent: string;
  claim: string[];
  // The task's scope on one line, when it holds more than paths to change.
  scope?: string | null;
  // The interfaces the change alters, each with how.
  interfaces?: string[];
  // How the repository's checks went on the tree this commit holds.
  gate?: string | null;
  verdict: { decision: string; reviewer: string; cycle: number };
  fork: string;
  headSha: string;
  foreignTrailers: Trailer[];
}

// The length git tools expect a subject line to fit in.
const SUBJECT_LIMIT = 72;

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function buildMergeMessage(input: MergeMessageInput): string {
  const firstLine = input.goal.split("\n").find((line) => line.trim() !== "") ?? "Merge task";
  let subject = oneLine(firstLine);
  if (subject.length > SUBJECT_LIMIT) {
    // Cut between words where there is a space to cut at.
    const cut = subject.slice(0, SUBJECT_LIMIT - 1);
    const lastSpace = subject[SUBJECT_LIMIT - 1] === " " ? cut.length : cut.lastIndexOf(" ");
    subject = `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
  }

  const trailers: Trailer[] = [
    { key: "Dibs-Task", value: input.taskId },
    { key: "Dibs-Agent", value: input.agent },
    { key: "Dibs-Claim", value: input.claim.join(", ") },
    ...(input.scope ? [{ key: "Dibs-Scope", value: input.scope }] : []),
    ...(input.interfaces !== undefined && input.interfaces.length > 0
      ? [{ key: "Dibs-Interfaces", value: input.interfaces.join(", ") }]
      : []),
    ...(input.gate ? [{ key: "Dibs-Gate", value: input.gate }] : []),
    {
      key: "Dibs-Verdict",
      value: `${input.verdict.decision}; reviewer=${input.verdict.reviewer}; cycle=${input.verdict.cycle}`,
    },
    { key: "Dibs-Fork", value: `${input.fork}@${input.headSha}` },
    ...input.foreignTrailers,
  ];

  const paragraphs = [subject];
  const summary = input.summary.trim();
  if (summary !== "") {
    paragraphs.push(summary);
  }
  paragraphs.push(trailers.map((trailer) => `${trailer.key}: ${oneLine(trailer.value)}`).join("\n"));
  return `${paragraphs.join("\n\n")}\n`;
}
