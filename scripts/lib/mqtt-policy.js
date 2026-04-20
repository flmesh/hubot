function normalizeUsername(value) {
  return String(value ?? "").trim().toLowerCase();
}

const USERNAME_FORMAT_REGEX = /^[a-z][a-z0-9_-]+$/;

export function validateUsernamePolicy(username, policy) {
  const normalized = normalizeUsername(username);

  if (!normalized) {
    throw new Error("username is required");
  }

  const minLength = Number(policy?.min_length ?? 3);
  const maxLength = Number(policy?.max_length ?? 24);
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new Error(`username must be between ${minLength} and ${maxLength} characters`);
  }

  if (!USERNAME_FORMAT_REGEX.test(normalized)) {
    throw new Error("username must start with a lowercase letter and contain only lowercase letters, digits, underscores, or hyphens");
  }

  const reserved = new Set((policy?.reserved_usernames ?? []).map((value) => String(value).toLowerCase()));
  if (reserved.has(normalized)) {
    throw new Error("username is reserved and cannot be used");
  }

  const bannedSubstrings = (policy?.banned_substrings ?? []).map((value) => String(value).toLowerCase());
  const matchedSubstring = bannedSubstrings.find((substring) => substring && normalized.includes(substring));
  if (matchedSubstring) {
    throw new Error(`username contains a banned term: ${matchedSubstring}`);
  }

  return normalized;
}
