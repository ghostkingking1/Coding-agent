import assert from "node:assert/strict";
import { test } from "node:test";
import { authenticate } from "./auth.mjs";

test("authenticates an active user with the correct password", () => {
  assert.equal(authenticate({ password: "secret", locked: false }, "secret"), true);
});
