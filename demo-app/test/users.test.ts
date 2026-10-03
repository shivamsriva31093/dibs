import assert from "node:assert/strict";
import { test } from "node:test";
import { findUser, listUsers } from "../src/db/users.ts";

test("findUser returns the user with that id", () => {
  assert.equal(findUser("u2")?.name, "Grace Hopper");
});

test("findUser returns null for an id that does not exist", () => {
  assert.equal(findUser("nobody"), null);
});

test("listUsers returns every user", () => {
  assert.equal(listUsers().length, 3);
});
