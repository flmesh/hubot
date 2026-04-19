export async function getDefaultProfile(collections) {
  return collections.profiles.findOne({
    is_default: true,
    status: "active",
  });
}

export async function getProfileByName(collections, profileName) {
  return collections.profiles.findOne({ name: profileName });
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

export async function replaceProfileManagedAcls({ collections, username, profile }) {
  await collections.mqttAcl.deleteMany({
    username,
    managed_by: "hubot-profile",
  });

  const documents = buildAclDocuments({
    username,
    profileName: profile.name,
    rules: profile.rules,
  });

  if (documents.length > 0) {
    await collections.mqttAcl.insertMany(documents);
  }
}
