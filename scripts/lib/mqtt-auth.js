import { pbkdf2Sync, randomBytes } from "node:crypto";

const PASSWORD_BYTES = 18;
const SALT_BYTES = 12;
const PBKDF2_ITERATIONS = 4096;
const PBKDF2_KEY_LENGTH = 32;
const PBKDF2_DIGEST = "sha256";

export function generatePassword() {
  return randomBytes(PASSWORD_BYTES).toString("base64url");
}

export function generateSalt() {
  return randomBytes(SALT_BYTES).toString("hex");
}

export function hashPasswordWithSalt(password, salt) {
  return pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_LENGTH,
    PBKDF2_DIGEST,
  ).toString("hex");
}

export function buildPasswordMaterial() {
  const password = generatePassword();
  const salt = generateSalt();
  const passwordHash = hashPasswordWithSalt(password, salt);
  return { password, salt, passwordHash };
}
