import { describe, expect, it } from "vitest";
import { signatureHash } from "../../src/index/signature";

describe("signatureHash", () => {
  it("is the SHA-256 of the signature, in hex", async () => {
    // printf 'export function f(a: string): number' | shasum -a 256
    expect(await signatureHash("export function f(a: string): number")).toBe(
      "b93f6da0f5fabc9a077942ac4ff776b8fa1aa5f47a7e85c31293c29925da837f",
    );
  });

  it("differs when one character of the signature differs", async () => {
    expect(await signatureHash("export function f(a: string): number")).not.toBe(
      await signatureHash("export function f(a: number): number"),
    );
  });
});
