// Claim paths. A path ending in "/" claims a directory and everything under it;
// any other path claims exactly one file.

export type NormalizedPath = { ok: true; path: string } | { ok: false; reason: string };

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function normalizePath(input: string): NormalizedPath {
  const trimmed = input.trim();
  if (trimmed === "") {
    return { ok: false, reason: "path must not be empty" };
  }
  if (trimmed.startsWith("/")) {
    return { ok: false, reason: "path must be repository-relative, without a leading slash" };
  }
  if (trimmed.includes("\\")) {
    return { ok: false, reason: "path must use forward slashes" };
  }
  if (CONTROL_CHARS.test(trimmed)) {
    return { ok: false, reason: "path must not contain control characters" };
  }

  const isDirectory = trimmed.endsWith("/");
  const segments = trimmed.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { ok: false, reason: 'path must not contain "." or ".." segments' };
  }

  return { ok: true, path: segments.join("/") + (isDirectory ? "/" : "") };
}

// A file cannot coexist with a directory of the same name, so a file path is
// also treated as holding everything under it.
function asDirectory(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

export function overlaps(a: string, b: string): boolean {
  return a === b || b.startsWith(asDirectory(a)) || a.startsWith(asDirectory(b));
}
