// Chooses how a file is read for the interface index, by its name.
// Version one reads TypeScript and JavaScript. Other files have paths and no interfaces.

import { extractTypeScript, type Extracted, type ExtractOptions } from "./typescript";

export { DEFAULT_ROUTE_PATTERNS } from "./typescript";
export type { Extracted, ExtractedImport, ExtractedInterface, ExtractOptions, InterfaceKind } from "./typescript";

const TYPESCRIPT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
// A larger file is most likely generated, and reading it costs more than it tells.
const MAX_BYTES = 256 * 1024;

const supported = (path: string) => TYPESCRIPT.test(path);

// What a file offers and takes, or null if dibs has no way to read this kind of file.
export function extract(path: string, text: string, options: ExtractOptions = {}): Extracted | null {
  return supported(path) ? extractTypeScript(text, options) : null;
}

// Whether a file is worth reading: a kind dibs can read, of a sensible size, and written by the repository's own authors.
export function isIndexable(path: string, size: number): boolean {
  return (
    supported(path) &&
    size <= MAX_BYTES &&
    !path.endsWith(".min.js") &&
    !path.split("/").includes("node_modules")
  );
}
