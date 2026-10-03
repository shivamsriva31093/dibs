// Turns the specifier of a relative import into the path of the file it names,
// the way TypeScript and Node do it: as written, then with an extension added,
// then the TypeScript twin of a `.js` import, then the directory's index file.
// Only relative specifiers are resolved; a package import names nothing in the repository.

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

// TypeScript projects import `./x.js` and mean `./x.ts`.
const TWINS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

// The repository-relative path a specifier points at, or null when it leaves the repository.
function join(fromPath: string, specifier: string): string | null {
  const segments = fromPath.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

// Every path a relative specifier could mean, in the order they are tried. Empty for a
// specifier that is not relative or that leaves the repository.
export function importCandidates(fromPath: string, specifier: string): string[] {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return [];
  }
  const base = join(fromPath, specifier);
  if (base === null) {
    return [];
  }

  const candidates: string[] = [];
  if (base !== "" && !specifier.endsWith("/")) {
    candidates.push(base);
    candidates.push(...EXTENSIONS.map((extension) => base + extension));
    const dot = base.lastIndexOf(".");
    const extension = dot === -1 ? "" : base.slice(dot);
    for (const twin of TWINS[extension] ?? []) {
      candidates.push(base.slice(0, dot) + twin);
    }
  }
  const index = base === "" ? "index" : `${base}/index`;
  candidates.push(...EXTENSIONS.map((extension) => index + extension));
  return candidates;
}

export function resolveImport(fromPath: string, specifier: string, exists: (path: string) => boolean): string | null {
  return importCandidates(fromPath, specifier).find((candidate) => exists(candidate)) ?? null;
}
