import { describe, expect, it } from "vitest";
import { isRepositoryRead, outputTail } from "../../src/gate-runner";

const REMOTE = "https://abc123.artifacts.cloudflare.net/git/dibs/demo-app.git";

describe("isRepositoryRead", () => {
  it.each([
    ["GET", `${REMOTE}/info/refs?service=git-upload-pack`, true],
    ["POST", `${REMOTE}/git-upload-pack`, true],
    // Writing is never let through.
    ["GET", `${REMOTE}/info/refs?service=git-receive-pack`, false],
    ["POST", `${REMOTE}/git-receive-pack`, false],
    // Nor reading another repository, a fork included.
    ["GET", "https://abc123.artifacts.cloudflare.net/git/dibs/demo-app--t-1.git/info/refs?service=git-upload-pack", false],
    ["POST", "https://abc123.artifacts.cloudflare.net/git/dibs/other.git/git-upload-pack", false],
    // Nor anything on another host.
    ["GET", "https://example.com/git/dibs/demo-app.git/info/refs?service=git-upload-pack", false],
    ["DELETE", `${REMOTE}/git-upload-pack`, false],
  ])("%s %s -> %s", (method, url, allowed) => {
    expect(isRepositoryRead(new Request(url, { method }), REMOTE)).toBe(allowed);
  });
});

describe("outputTail", () => {
  it("keeps the end of a long output, and says that it was cut", () => {
    const long = `${"x".repeat(9000)}\nlast line`;

    const tail = outputTail(new TextEncoder().encode(long).buffer as ArrayBuffer, 100);

    expect(tail.startsWith("(the first 8910 characters are left out)\n")).toBe(true);
    expect(tail.endsWith("x\nlast line")).toBe(true);
  });

  it("keeps a short output as it is", () => {
    expect(outputTail(new TextEncoder().encode("ok\n").buffer as ArrayBuffer, 100)).toBe("ok\n");
  });
});
