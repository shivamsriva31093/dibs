import assert from "node:assert/strict";
import { test } from "node:test";
import { handle } from "../src/index.ts";

test("GET /health answers ok", async () => {
  const response = await handle(new Request("http://localhost/health"));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("an unknown path is not found", async () => {
  const response = await handle(new Request("http://localhost/nope"));

  assert.equal(response.status, 404);
});
