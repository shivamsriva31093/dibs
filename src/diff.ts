// Renders a task's changes as a git-style unified diff for the reviewer and the
// decision model. Files that cannot be shown as text are reported, not rendered.

import { createTwoFilesPatch, OMIT_HEADERS } from "diff";
import { MAX_DIFF_BYTES } from "./checks";
import type { Change, Leaf } from "./git/changes";

export interface BlobReader {
  readBlob(oid: string): Promise<Uint8Array | null>;
}

export interface FileDiff {
  path: string;
  status: Change["status"];
  // Null when the file is binary or a submodule link.
  text: string | null;
}

export interface DiffResult {
  files: FileDiff[];
  // Size of all rendered text, in UTF-8 bytes. Over the limit when `truncated` is true.
  bytes: number;
  unreviewable: string[];
  // Rendering stopped early because the diff had already passed the size limit.
  truncated: boolean;
}

const GITLINK_MODE = "160000";
const SYMLINK_MODE = "120000";
const BINARY_SNIFF_BYTES = 8000;
const CONTEXT_LINES = 3;
// A pair of files this many times the limit cannot produce a diff under it; skip the work.
const SKIP_DIFF_FACTOR = 4;

const encoder = new TextEncoder();
// Keep a byte-order mark as part of the text, so the rendered diff stays faithful to the file.
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return null;
  }
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return null;
  }
}

const isSymlink = (leaf: Leaf) => leaf.mode === SYMLINK_MODE;

// One file section in git's patch format.
function section(path: string, base: Leaf | null, head: Leaf | null, oldText: string, newText: string): string {
  let out = `diff --git a/${path} b/${path}\n`;
  if (base === null && head !== null) {
    out += `new file mode ${head.mode}\n`;
  } else if (base !== null && head === null) {
    out += `deleted file mode ${base.mode}\n`;
  } else if (base !== null && head !== null && base.mode !== head.mode) {
    out += `old mode ${base.mode}\nnew mode ${head.mode}\n`;
  }

  const hunks = createTwoFilesPatch(`a/${path}`, `b/${path}`, oldText, newText, undefined, undefined, {
    context: CONTEXT_LINES,
    headerOptions: OMIT_HEADERS,
  });
  // With no differences the library returns only a blank line; a section then has no file headers.
  if (hunks.includes("@@")) {
    out += `--- ${base === null ? "/dev/null" : `a/${path}`}\n+++ ${head === null ? "/dev/null" : `b/${path}`}\n${hunks}`;
  }
  return out;
}

export async function buildDiff(
  repo: BlobReader,
  changes: Change[],
  options: { maxBytes?: number } = {},
): Promise<DiffResult> {
  const maxBytes = options.maxBytes ?? MAX_DIFF_BYTES;
  const result: DiffResult = { files: [], bytes: 0, unreviewable: [], truncated: false };

  const read = async (leaf: Leaf | null, path: string): Promise<Uint8Array> => {
    if (leaf === null) {
      return new Uint8Array(0);
    }
    const bytes = await repo.readBlob(leaf.oid);
    if (bytes === null) {
      throw new Error(`content of ${path} (${leaf.oid}) could not be read`);
    }
    return bytes;
  };

  for (const change of changes) {
    const { path, status, base, head } = change;
    const skip = () => {
      result.files.push({ path, status, text: null });
      result.unreviewable.push(path);
    };

    if (base?.mode === GITLINK_MODE || head?.mode === GITLINK_MODE) {
      skip();
      continue;
    }

    let text: string;
    const typeChanged = base !== null && head !== null && isSymlink(base) !== isSymlink(head);
    if (base !== null && head !== null && base.oid === head.oid && !typeChanged) {
      // Only the mode changed.
      text = section(path, base, head, "", "");
    } else {
      const [oldBytes, newBytes] = [await read(base, path), await read(head, path)];
      if (oldBytes.byteLength + newBytes.byteLength > SKIP_DIFF_FACTOR * maxBytes) {
        result.bytes += oldBytes.byteLength + newBytes.byteLength;
        result.truncated = true;
        break;
      }
      const oldText = decodeText(oldBytes);
      const newText = decodeText(newBytes);
      if (oldText === null || newText === null) {
        skip();
        continue;
      }
      // Git writes a file becoming a symlink, or the reverse, as a deletion followed by an addition.
      text = typeChanged
        ? section(path, base, null, oldText, "") + section(path, null, head, "", newText)
        : section(path, base, head, oldText, newText);
    }

    result.files.push({ path, status, text });
    result.bytes += encoder.encode(text).byteLength;
    if (result.bytes > maxBytes) {
      result.truncated = true;
      break;
    }
  }
  return result;
}
