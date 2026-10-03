// A minimal git smart-HTTP client for pushing: read the refs a remote advertises,
// then send one ref update with a packfile (the receive-pack service, protocol v1).

import { concatBytes } from "./objects";

export interface RemoteAuth {
  token: string;
}

export interface RefAdvertisement {
  refs: Map<string, string>;
  capabilities: Set<string>;
}

export interface RefUpdate {
  ref: string;
  // The id the ref must currently have; ZERO_OID to create the ref.
  oldOid: string;
  newOid: string;
}

export type PushResult = { ok: true } | { ok: false; stage: "unpack" | "ref"; reason: string };

export class GitRemoteError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitRemoteError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FLUSH = encoder.encode("0000");

function pktLine(payload: string): Uint8Array {
  const bytes = encoder.encode(payload);
  const length = (bytes.byteLength + 4).toString(16).padStart(4, "0");
  return concatBytes([encoder.encode(length), bytes]);
}

// Yields each packet's payload as text, and null for a flush packet.
function* readPktLines(bytes: Uint8Array): Generator<string | null> {
  let offset = 0;
  while (offset + 4 <= bytes.byteLength) {
    const length = Number.parseInt(decoder.decode(bytes.subarray(offset, offset + 4)), 16);
    if (Number.isNaN(length)) {
      throw new Error("malformed pkt-line in git server response");
    }
    if (length < 4) {
      offset += 4;
      yield null;
      continue;
    }
    yield decoder.decode(bytes.subarray(offset + 4, offset + length));
    offset += length;
  }
}

function authHeaders(auth: RemoteAuth | undefined): Record<string, string> {
  return auth ? { authorization: `Bearer ${auth.token}` } : {};
}

function serviceUrl(remote: string, path: string): string {
  return `${remote.replace(/\/+$/, "")}/${path}`;
}

export async function listRefs(
  remote: string,
  auth?: RemoteAuth,
  fetchImpl: typeof fetch = fetch,
): Promise<RefAdvertisement> {
  const response = await fetchImpl(serviceUrl(remote, "info/refs?service=git-receive-pack"), {
    headers: authHeaders(auth),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new GitRemoteError(`listing refs failed: HTTP ${response.status}`, response.status);
  }

  const refs = new Map<string, string>();
  const capabilities = new Set<string>();
  for (const line of readPktLines(new Uint8Array(await response.arrayBuffer()))) {
    if (line === null || line.startsWith("# service=")) {
      continue;
    }
    const [refPart = "", capabilityPart] = line.split("\0");
    if (capabilityPart !== undefined) {
      for (const capability of capabilityPart.trim().split(" ")) {
        if (capability !== "") {
          capabilities.add(capability);
        }
      }
    }
    const [oid, name] = refPart.trim().split(" ");
    // An empty repository advertises a placeholder; "^{}" entries are peeled tags.
    if (oid === undefined || name === undefined || name.endsWith("^{}")) {
      continue;
    }
    refs.set(name, oid);
  }
  return { refs, capabilities };
}

export async function pushPack(
  remote: string,
  update: RefUpdate,
  pack: Uint8Array,
  auth?: RemoteAuth,
  fetchImpl: typeof fetch = fetch,
): Promise<PushResult> {
  const command = pktLine(`${update.oldOid} ${update.newOid} ${update.ref}\0 report-status agent=dibs/0.1\n`);
  const response = await fetchImpl(serviceUrl(remote, "git-receive-pack"), {
    method: "POST",
    headers: {
      ...authHeaders(auth),
      "content-type": "application/x-git-receive-pack-request",
      accept: "application/x-git-receive-pack-result",
    },
    body: concatBytes([command, FLUSH, pack]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new GitRemoteError(`push failed: HTTP ${response.status}`, response.status);
  }

  let unpack: string | undefined;
  let refStatus: PushResult | undefined;
  for (const packet of readPktLines(new Uint8Array(await response.arrayBuffer()))) {
    if (packet === null) {
      continue;
    }
    const line = packet.trim();
    if (line.startsWith("unpack ")) {
      unpack = line.slice("unpack ".length);
    } else if (line === `ok ${update.ref}`) {
      refStatus = { ok: true };
    } else if (line.startsWith(`ng ${update.ref}`)) {
      refStatus = { ok: false, stage: "ref", reason: line.slice(`ng ${update.ref}`.length).trim() || "rejected" };
    }
  }

  if (unpack !== "ok") {
    return { ok: false, stage: "unpack", reason: unpack ?? "server sent no unpack status" };
  }
  return refStatus ?? { ok: false, stage: "ref", reason: `server sent no status for ${update.ref}` };
}
