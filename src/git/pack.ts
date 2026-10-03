// Writes a git packfile (version 2) holding whole, undeltified objects.

import { concatBytes, sha1, type GitObject, type GitObjectType } from "./objects";

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3 };

function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

// First byte: continuation bit, 3 bits of type, low 4 bits of size.
// Following bytes: continuation bit and 7 more bits of size, least significant first.
function objectHeader(type: GitObjectType, size: number): Uint8Array {
  const bytes: number[] = [];
  let current = (TYPE_CODE[type] << 4) | (size & 0x0f);
  let remaining = Math.floor(size / 16);
  while (remaining > 0) {
    bytes.push(current | 0x80);
    current = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(current);
  return new Uint8Array(bytes);
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const compressed = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

export async function buildPack(objects: GitObject[]): Promise<Uint8Array> {
  const unique = [...new Map(objects.map((object) => [object.oid, object])).values()];

  const parts: Uint8Array[] = [new TextEncoder().encode("PACK"), uint32(2), uint32(unique.length)];
  for (const object of unique) {
    parts.push(objectHeader(object.type, object.data.byteLength), await deflate(object.data));
  }

  const body = concatBytes(parts);
  return concatBytes([body, await sha1(body)]);
}
