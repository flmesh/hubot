export async function getDefaultProfile(collections) {
  return collections.profiles.findOne({
    is_default: true,
    status: "active",
  });
}

export function buildAclDocuments({ username, profileName, rules }) {
  return (rules ?? []).map((rule) => ({
    username,
    permission: rule.permission,
    action: rule.action,
    topics: rule.topics,
    source_profile: profileName,
    managed_by: "hubot-profile",
  }));
}
