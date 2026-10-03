// One file as the interface index keeps it: its interfaces with the hashes of their
// signatures, and what it uses of other files, named by the paths of those files.

import { extract, type ExtractOptions, type InterfaceKind } from "./extract";
import { resolveImport } from "./resolve";
import { signatureHash } from "./signature";

export interface IndexedInterface {
  name: string;
  kind: InterfaceKind;
  signature: string;
  hash: string;
  // For a name that is passed on: the file and the name it comes from. Null when it is the file's own.
  origin: { path: string; name: string } | null;
}

export interface IndexedRef {
  // The file that is used.
  path: string;
  // The name used from it: "default" for its default export, "*" for all of it.
  name: string;
  via: "import" | "reexport";
}

export interface IndexedFile {
  path: string;
  // One hash over all the file's interfaces, for a task that relies on the file as a whole.
  digest: string;
  interfaces: IndexedInterface[];
  refs: IndexedRef[];
}

// `exists` says whether a path is a file of the repository; imports are resolved against it.
export async function indexFile(
  path: string,
  text: string,
  exists: (path: string) => boolean,
  options: ExtractOptions = {},
): Promise<IndexedFile | null> {
  const extracted = extract(path, text, options);
  if (extracted === null) {
    return null;
  }

  const interfaces: IndexedInterface[] = [];
  for (const entry of extracted.interfaces) {
    const source = entry.from === undefined ? null : resolveImport(path, entry.from.specifier, exists);
    interfaces.push({
      name: entry.name,
      kind: entry.kind,
      signature: entry.signature,
      hash: await signatureHash(entry.signature),
      origin: entry.from === undefined || source === null ? null : { path: source, name: entry.from.name },
    });
  }

  const refs: IndexedRef[] = [];
  for (const used of extracted.imports) {
    const target = resolveImport(path, used.specifier, exists);
    if (target === null) {
      continue;
    }
    for (const name of used.names) {
      refs.push({ path: target, name, via: used.via });
    }
  }
  return { path, digest: await fileDigest(interfaces), interfaces, refs };
}

export function fileDigest(interfaces: { name: string; hash: string }[]): Promise<string> {
  return signatureHash(
    interfaces
      .map((entry) => `${entry.name}\0${entry.hash}`)
      .sort()
      .join("\n"),
  );
}
