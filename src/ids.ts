const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

// A short random id such as "t-7f3k2a9q".
export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let id = "";
  for (const byte of bytes) {
    id += ID_ALPHABET[byte % ID_ALPHABET.length];
  }
  return `${prefix}-${id}`;
}

// An API key: 32 random bytes, base64url encoded.
export function newApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...bytes));
  return `dibs_${base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
