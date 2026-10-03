// The name an interface's shape is stored under. Two signatures that read the
// same hash the same, so "did the contract change?" is a comparison of two strings.

import { sha256Hex } from "../ids";

export function signatureHash(signature: string): Promise<string> {
  return sha256Hex(signature);
}
