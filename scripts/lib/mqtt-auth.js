import { createHash, randomBytes } from "node:crypto";

const PASSWORD_BYTES = 18;
const SALT_BYTES = 12;

export function generatePassword() {
  return randomBytes(PASSWORD_BYTES).toString("base64url");
}

export function generateSalt() {
  return randomBytes(SALT_BYTES).toString("hex");
}

export function hashPasswordWithSalt(password, salt) {
  return createHash("sha256").update(`${password}${salt}`, "utf8").digest("hex");
}

export function buildPasswordMaterial() {
  const password = generatePassword();
  const salt = generateSalt();
  const passwordHash = hashPasswordWithSalt(password, salt);
  return { password, salt, passwordHash };
}
