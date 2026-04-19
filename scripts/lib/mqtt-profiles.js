export async function getDefaultProfile(collections) {
  return collections.profiles.findOne({
    is_default: true,
    status: "active",
  });
}

export async function getProfileByName(collections, profileName) {
  return collections.profiles.findOne({ name: profileName });
}

export async function listProfiles(collections) {
  const cursor = collections.profiles.find({}, {
    projection: {
      name: 1,
      description: 1,
      status: 1,
      is_default: 1,
      rules: 1,
      created_at: 1,
      updated_at: 1,
    },
  });

  return cursor.sort({ name: 1 }).toArray();
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

export async function reapplyProfileToAssignedUsers({ collections, profile }) {
  const users = await collections.users.find({ profile: profile.name }).toArray();

  for (const user of users) {
    await replaceProfileManagedAcls({
      collections,
      username: user.username,
      profile,
    });
  }

  return {
    matchedUsers: users.length,
  };
}
