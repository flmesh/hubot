import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPasswordMaterial,
  generateSalt,
  hashPasswordWithSalt,
} from "../scripts/lib/mqtt-auth.js";

test("hashPasswordWithSalt uses stable PBKDF2-SHA256 output", () => {
  const password = "example-password";
  const salt = "00112233445566778899aabb";

  const hash = hashPasswordWithSalt(password, salt);

  assert.equal(hash, "ce3e4db37c9b64bbe49c9a5dc8033da2cfc8c678e9c78b3052210f76cdc492c5");
  assert.equal(hash.length, 64);
  assert.match(hash, /^[a-f0-9]+$/);
});

test("buildPasswordMaterial returns a password, salt, and derived hash", () => {
  const result = buildPasswordMaterial();

  assert.ok(result.password);
  assert.ok(result.salt);
  assert.equal(result.passwordHash, hashPasswordWithSalt(result.password, result.salt));
});

test("generateSalt returns a hex-encoded salt", () => {
  const salt = generateSalt();
  assert.match(salt, /^[a-f0-9]+$/);
});
