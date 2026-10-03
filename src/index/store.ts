// The interface index of one repository, kept in the Coordinator's SQLite: for
// every file dibs can read, the interfaces it offers and what it uses of other
// files. It answers the questions that tie tasks together: what does this code
// rely on, and who relies on this interface.

import { parseTarget } from "../scopes";
import type { IndexedFile } from "./file";
import type { InterfaceKind } from "./typescript";

export interface StoredInterface {
  kind: InterfaceKind;
  signature: string;
  hash: string;
  // The commit of the main branch that gave the interface this signature.
  sinceSha: string;
}

export interface Named {
  path: string;
  name: string;
}

// The most a signature takes up in storage. Its hash is of the whole of it.
const MAX_SIGNATURE_CHARS = 2000;
// How far a name is followed through files that pass it on.
const MAX_HOPS = 6;
// The most names an interface is followed under, when looking for who uses it.
const MAX_ALIASES = 60;

const WHOLE = "*";
const byPathThenName = (a: Named, b: Named) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const key = (named: Named) => `${named.path}\0${named.name}`;

export class IndexStore {
  constructor(private readonly sql: SqlStorage) {}

  // Puts the files in the index as they are at `sha`, in place of what it held for them, and forgets `removed`.
  // Nothing here waits, so a caller can make it part of a change that must happen all at once.
  replace(files: IndexedFile[], removed: string[], sha: string): void {
    for (const path of [...removed, ...files.map((file) => file.path)]) {
      this.sql.exec("DELETE FROM refs_to WHERE path = ?", path);
      this.sql.exec("DELETE FROM indexed_files WHERE path = ?", path);
    }
    for (const path of removed) {
      this.sql.exec("DELETE FROM interfaces WHERE path = ?", path);
    }
    for (const file of files) {
      const before = new Map(
        this.sql
          .exec<{ name: string; hash: string; since_sha: string }>("SELECT name, hash, since_sha FROM interfaces WHERE path = ?", file.path)
          .toArray()
          .map((row) => [row.name, row]),
      );
      this.sql.exec("DELETE FROM interfaces WHERE path = ?", file.path);
      for (const entry of file.interfaces) {
        const was = before.get(entry.name);
        this.sql.exec(
          `INSERT INTO interfaces (path, name, kind, signature, hash, origin_path, origin_name, since_sha)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path, name) DO NOTHING`,
          file.path,
          entry.name,
          entry.kind,
          entry.signature.slice(0, MAX_SIGNATURE_CHARS),
          entry.hash,
          entry.origin?.path ?? null,
          entry.origin?.name ?? null,
          was !== undefined && was.hash === entry.hash ? was.since_sha : sha,
        );
      }
      for (const ref of file.refs) {
        this.sql.exec(
          "INSERT INTO refs_to (path, target_path, target_name, via) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
          file.path,
          ref.path,
          ref.name,
          ref.via,
        );
      }
      this.sql.exec("INSERT INTO indexed_files (path, digest, sha) VALUES (?, ?, ?)", file.path, file.digest, sha);
    }
  }

  clear(): void {
    this.sql.exec("DELETE FROM interfaces");
    this.sql.exec("DELETE FROM refs_to");
    this.sql.exec("DELETE FROM indexed_files");
  }

  status(): { files: number; interfaces: number; references: number } {
    const count = (table: string) => this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
    return { files: count("indexed_files"), interfaces: count("interfaces"), references: count("refs_to") };
  }

  has(path: string): boolean {
    return this.sql.exec("SELECT 1 FROM indexed_files WHERE path = ?", path).toArray().length > 0;
  }

  signature(path: string, name: string): StoredInterface | null {
    const row = this.sql
      .exec<{ kind: string; signature: string; hash: string; since_sha: string }>(
        "SELECT kind, signature, hash, since_sha FROM interfaces WHERE path = ? AND name = ?",
        path,
        name,
      )
      .toArray()[0];
    return row === undefined
      ? null
      : { kind: row.kind as InterfaceKind, signature: row.signature, hash: row.hash, sinceSha: row.since_sha };
  }

  // The commit of the main branch at which the index last read a file, or null if it has not read it.
  fileSha(path: string): string | null {
    return this.sql.exec<{ sha: string }>("SELECT sha FROM indexed_files WHERE path = ?", path).toArray()[0]?.sha ?? null;
  }

  // The files a file passes everything on from (`export * from`).
  private passedOnWhole(path: string): string[] {
    return this.sql
      .exec<{ target_path: string }>(
        "SELECT target_path FROM refs_to WHERE path = ? AND target_name = ? AND via = 'reexport' ORDER BY target_path",
        path,
        WHOLE,
      )
      .toArray()
      .map((row) => row.target_path);
  }

  // Where a name used from a file is declared: the file itself, or the file it is passed on from.
  // A name the index cannot place is answered as it was asked.
  origin(path: string, name: string): Named {
    const find = (at: Named, hops: number, seen: Set<string>): Named | null => {
      if (hops > MAX_HOPS || seen.has(key(at))) {
        return null;
      }
      seen.add(key(at));
      const row = this.sql
        .exec<{ origin_path: string | null; origin_name: string | null }>(
          "SELECT origin_path, origin_name FROM interfaces WHERE path = ? AND name = ?",
          at.path,
          at.name,
        )
        .toArray()[0];
      if (row !== undefined) {
        if (row.origin_path === null || row.origin_name === null || row.origin_name === WHOLE) {
          return at;
        }
        return find({ path: row.origin_path, name: row.origin_name }, hops + 1, seen) ?? { path: row.origin_path, name: row.origin_name };
      }
      for (const source of this.passedOnWhole(at.path)) {
        const found = find({ path: source, name: at.name }, hops + 1, seen);
        if (found !== null) {
          return found;
        }
      }
      return null;
    };
    return (name === WHOLE ? null : find({ path, name }, 0, new Set())) ?? { path, name };
  }

  // The interfaces of other files that the files under `paths` use, each at the place it is declared.
  // A file used as a whole is listed under the name "*".
  usedBy(paths: string[]): Named[] {
    const inside = (path: string) => paths.some((held) => (held.endsWith("/") ? path.startsWith(held) : held === path));
    const used = new Map<string, Named>();
    for (const held of paths) {
      const rows = held.endsWith("/")
        ? this.sql.exec<{ target_path: string; target_name: string }>(
            "SELECT target_path, target_name FROM refs_to WHERE substr(path, 1, ?) = ?",
            held.length,
            held,
          )
        : this.sql.exec<{ target_path: string; target_name: string }>(
            "SELECT target_path, target_name FROM refs_to WHERE path = ?",
            held,
          );
      for (const row of rows) {
        const origin = this.origin(row.target_path, row.target_name);
        if (!inside(origin.path)) {
          used.set(key(origin), origin);
        }
      }
    }
    return [...used.values()].sort(byPathThenName);
  }

  // The files that use an interface: those that import it by name or import its whole file,
  // from the file itself or from a file that passes it on. Files that only pass it on are
  // themselves left out unless `withPassers` is set.
  dependents(path: string, name: string, options: { withPassers?: boolean } = {}): string[] {
    // Every (file, name) the interface can be imported as.
    const aliases: Named[] = [{ path, name }];
    const seen = new Set([key(aliases[0]!)]);
    const add = (alias: Named) => {
      if (!seen.has(key(alias)) && aliases.length < MAX_ALIASES) {
        seen.add(key(alias));
        aliases.push(alias);
      }
    };
    for (let index = 0; index < aliases.length; index++) {
      const alias = aliases[index]!;
      const renamed = this.sql.exec<{ path: string; name: string }>(
        "SELECT path, name FROM interfaces WHERE origin_path = ? AND origin_name = ?",
        alias.path,
        alias.name,
      );
      for (const row of renamed) {
        add({ path: row.path, name: row.name });
      }
      const whole = this.sql.exec<{ path: string }>(
        "SELECT path FROM refs_to WHERE target_path = ? AND target_name = ? AND via = 'reexport'",
        alias.path,
        WHOLE,
      );
      for (const row of whole) {
        add({ path: row.path, name: alias.name });
      }
    }

    const files = new Set<string>();
    const vias = options.withPassers ? ["import", "reexport"] : ["import"];
    for (const alias of aliases) {
      const rows = this.sql.exec<{ path: string; via: string }>(
        "SELECT path, via FROM refs_to WHERE target_path = ? AND (target_name = ? OR target_name = ?)",
        alias.path,
        alias.name,
        WHOLE,
      );
      for (const row of rows) {
        if (vias.includes(row.via) && row.path !== path) {
          files.add(row.path);
        }
      }
    }
    return [...files].sort();
  }

  // The hash that tells whether what a target names is still what it was: the hash of the
  // signature for an interface, one hash over all its interfaces for a file. Null when it is
  // not in the index; undefined for a target that has no one shape to compare.
  hashOf(target: string): string | null | undefined {
    const parsed = parseTarget(target);
    if (!parsed.ok || parsed.target.kind === "route") {
      return undefined;
    }
    if (parsed.target.kind === "interface" && parsed.target.name !== WHOLE) {
      const origin = this.origin(parsed.target.path, parsed.target.name);
      return this.signature(origin.path, origin.name)?.hash ?? null;
    }
    if (parsed.target.path.endsWith("/")) {
      return undefined;
    }
    return (
      this.sql.exec<{ digest: string }>("SELECT digest FROM indexed_files WHERE path = ?", parsed.target.path).toArray()[0]?.digest ??
      null
    );
  }
}
