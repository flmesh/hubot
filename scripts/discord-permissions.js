// Discord role permission provider for Hubot command bus.
//
// Description:
//   Installs a command-bus permission provider that checks Discord role IDs.
//   Command specs can use raw role IDs or env:VARIABLE tokens.
//
// Commands:
//   None

import { installDiscordRolePermissionProvider } from "./lib/discord-role-permissions.js";

export default (robot) => {
  installDiscordRolePermissionProvider(robot);
};
