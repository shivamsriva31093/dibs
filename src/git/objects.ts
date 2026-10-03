// Git object encoding: enough to build blobs, trees and commits and to compute
// the ids git would give them. Uses only Web APIs, so it runs in Workers and Node.

export type GitObjectType = "commit" | "tree" | "blob";

export interface GitObject {
  type: GitObjectType;
  oid: string;
  // The object's content, without git's "<type> <size>\0" header.
  data: Uint8Array;
}

export interface TreeEntry {
  name: string;
  // Git file mode as octal digits: 100644, 100755, 120000, 160000 or 40000.
  mode: string;
  oid: string;
}

export interface Identity {
  name: string;
  email: string;
}

export interface CommitFields {
  tree: string;
  parents: string[];
  author: Identity;
  committer: Identity;
  // Unix seconds.
  authoredAt: number;
  committedAt: number;
  message: string;
}

export const ZERO_OID = "0".repeat(40);
export const TREE_MODE = "40000";

const OID_PATTERN = /^[0-9a-f]{40}$/;
const encoder = new TextEncoder();

export function isOid(value: string): boolean {
  return OID_PATTERN.test(value);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

export async function sha1(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", data));
}

export async function makeObject(type: GitObjectType, data: Uint8Array): Promise<GitObject> {
  const header = encoder.encode(`${type} ${data.byteLength}\0`);
  const oid = toHex(await sha1(concatBytes([header, data])));
  return { type, oid, data };
}

export function normalizeMode(mode: string): string {
  const normalized = mode.replace(/^0+/, "");
  if (!/^[0-7]+$/.test(normalized)) {
    throw new Error(`invalid git file mode: ${JSON.stringify(mode)}`);
  }
  return normalized;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.byteLength, b.byteLength);
  for (let index = 0; index < length; index++) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return a.byteLength - b.byteLength;
}

export function encodeTree(entries: TreeEntry[]): Uint8Array {
  const seen = new Set<string>();
  const prepared = entries.map((entry) => {
    if (entry.name === "" || entry.name.includes("/") || entry.name.includes("\0")) {
      throw new Error(`invalid tree entry name: ${JSON.stringify(entry.name)}`);
    }
    if (!isOid(entry.oid)) {
      throw new Error(`invalid object id for tree entry ${JSON.stringify(entry.name)}: ${JSON.stringify(entry.oid)}`);
    }
    if (seen.has(entry.name)) {
      throw new Error(`duplicate tree entry name: ${JSON.stringify(entry.name)}`);
    }
    seen.add(entry.name);

    const mode = normalizeMode(entry.mode);
    const name = encoder.encode(entry.name);
    // Git orders a directory as if its name ended in "/".
    const sortKey = mode === TREE_MODE ? concatBytes([name, encoder.encode("/")]) : name;
    return { mode, name, sortKey, oid: entry.oid };
  });

  prepared.sort((a, b) => compareBytes(a.sortKey, b.sortKey));

  const parts: Uint8Array[] = [];
  for (const entry of prepared) {
    parts.push(encoder.encode(`${entry.mode} `), entry.name, new Uint8Array([0]), fromHex(entry.oid));
  }
  return concatBytes(parts);
}

function cleanIdentityPart(value: string): string {
  return value.replace(/[<>\r\n\0]/g, "").trim();
}

function identityLine(kind: "author" | "committer", identity: Identity, timestamp: number): string {
  const name = cleanIdentityPart(identity.name) || "unknown";
  const email = cleanIdentityPart(identity.email);
  return `${kind} ${name} <${email}> ${Math.floor(timestamp)} +0000\n`;
}

export function encodeCommit(fields: CommitFields): Uint8Array {
  for (const oid of [fields.tree, ...fields.parents]) {
    if (!isOid(oid)) {
      throw new Error(`invalid object id in commit: ${JSON.stringify(oid)}`);
    }
  }
  const message = `${fields.message.replace(/\n+$/, "")}\n`;
  const text =
    `tree ${fields.tree}\n` +
    fields.parents.map((parent) => `parent ${parent}\n`).join("") +
    identityLine("author", fields.author, fields.authoredAt) +
    identityLine("committer", fields.committer, fields.committedAt) +
    `\n${message}`;
  return encoder.encode(text);
}
