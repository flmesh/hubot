# EMQX + MongoDB + Hubot Project Design

## 1. Overview

This document describes the proposed integration of EMQX, MongoDB and Hubot to support automated MQTT account provisioning and management for a Discord‑based user community.  It outlines the database schema, the authentication and authorization setup in EMQX, the command workflow in Hubot and the security and operational considerations.

## 2. Architecture

The system is composed of three main components:

- **EMQX** – acts as the MQTT broker.  Clients connect to it using username/password credentials.  EMQX authenticates against a MongoDB database and checks per‑client topic permissions.
- **MongoDB** – stores user credentials, access‑control rules and provisioning requests.  It is accessed read‑only by EMQX and read/write by Hubot.
- **Hubot** – a bot running in a Discord server.  It exposes commands to request, rotate and manage MQTT accounts.  Hubot writes to MongoDB when approving or updating accounts.

Workflow:

1. A Discord user submits a request to create an MQTT username via Hubot.
2. Hubot validates the request, writes a record to `requests`, generates a password and inserts the user and their ACL rules into `users` and `mqtt_acl` collections.
3. EMQX authenticates the user against MongoDB when the client connects and authorizes topic access using the ACL rules.
4. Administrators can disable, enable or rotate accounts via Hubot commands, which update MongoDB accordingly.

## 3. Database Design

All MQTT‑related data lives in a single database:

```mongosh
mqtt
```

The database has six collections: `users`, `profiles`, `mqtt_acl`, `requests`, `username_policy`, and `mqtt_audit`.

## 4. Collections

### 4.1 `users`

Stores credential data and ownership metadata for each MQTT user.  Required fields include:

- `username`: unique identifier used when connecting to EMQX.
- `password_hash`: hash of the client’s password.
- `salt`: random string appended to the password before hashing (optional but recommended).
- `is_superuser`: boolean indicating whether the account bypasses normal ACL checks (false for regular users).
- `discord_user_id`: ID of the Discord account that owns this MQTT user.
- `discord_tag`: the Discord tag (e.g. `user#1234`) for easier lookup.
- `profile`: name of an administrative profile (used if you want to categorize users).
- `status`: current account state, e.g. `active`, `disabled`.
- `created_at`: ISO date when the account was provisioned.
- `created_by`: record of who created the account (e.g. `hubot`).

Example document:

```json
{
  "username": "lonewolf",
  "password_hash": "<hash>",
  "salt": "<salt>",
  "is_superuser": false,
  "discord_user_id": "123456789012345678",
  "discord_tag": "user#1234",
  "profile": "lonewolf",
  "status": "active",
  "created_at": "2026-04-18T16:30:00Z",
  "created_by": "hubot"
}
```

Indexes:

- Unique index on `username` to prevent duplicates.
- Unique sparse index on `discord_user_id` to allow quick ownership lookups.
- Index on `profile` for queries based on administrative profile.

### 4.2 `profiles`

Stores admin-managed ACL templates that can be assigned to users. Regular requesters do not choose a profile and do not need to know profiles exist. New accounts receive the current default profile unless an administrator changes them later.

Required fields:

- `name`: unique profile identifier.
- `description`: human-readable description for admins.
- `status`: profile state, e.g. `active` or `disabled`.
- `is_default`: whether this is the default profile assigned during account creation.
- `rules`: richer ACL template entries Hubot compiles into `mqtt_acl` when provisioning or reapplying a profile.
- `created_at`, `created_by`, `updated_at`, `updated_by`: audit metadata.

Example document:

```json
{
  "name": "lonewolf",
  "description": "Allow access only to the Lone Wolf subtree",
  "status": "active",
  "is_default": false,
  "rules": [
    {
      "permission": "allow",
      "who": {
        "username": "${username}"
      },
      "action": {
        "type": "all"
      },
      "topics": [
        {
          "match": "filter",
          "value": "msh/US/FL/LWS/#"
        }
      ]
    }
  ],
  "created_at": "2026-04-19T12:00:00Z",
  "created_by": "admin#9999",
  "updated_at": "2026-04-19T12:00:00Z",
  "updated_by": "admin#9999"
}
```

Notes on the profile rule model:

- `profiles.rules` is the canonical policy template format managed by Hubot.
- `mqtt_acl` remains the flattened, EMQX-facing materialized form queried by the MongoDB authorizer.
- The current Hubot materializer supports selector fields `username`, `clientid`, and `ipaddress`; action type `publish`, `subscribe`, or `all`; optional `qos` and `retain`; and filter-style topic entries.
- The richer template format leaves room for future expansion, even though not every EMQX ACL language feature is materialized today.

Indexes:

- Unique index on `name`.
- Index on `is_default` to find the current default profile quickly.
- Index on `status` for admin queries and validation.

Initial seeded profiles:

- `default`: the default profile for new accounts. It denies all actions to `msh/US/FL/LWS/#` and allows all actions to `msh/US/FL/#`.
- `lonewolf`: a restricted profile that allows all actions only to `msh/US/FL/LWS/#`.

### 4.3 `mqtt_acl`

One document per ACL rule.  Required fields:

- `username`: MQTT username this rule applies to.
- `permission`: either `allow` or `deny`.
- `action`: usually `all` to apply to both publish and subscribe.
- `topics`: list of topic patterns covered by this rule.
- Optional selector fields such as `clientid` and `ipaddress` may also be present when a profile rule is materialized with additional constraints.
- Optional `qos` and `retain` fields may also be present.

Example for a user named `lonewolf` allowed to access only the LWS subtree:

```json
{
  "username": "lonewolf",
  "permission": "allow",
  "action": "all",
  "topics": ["msh/US/FL/LWS/#"]
}
```

Example for an `uplink` user who can access `msh/US/FL/#` except the LWS subtree:

```json
{
  "username": "uplink",
  "permission": "deny",
  "action": "all",
  "topics": ["msh/US/FL/LWS/#"]
},
{
  "username": "uplink",
  "permission": "allow",
  "action": "all",
  "topics": ["msh/US/FL/#"]
}
```

Indexes:

- Index on `username` to speed up per‑user ACL lookups.

### 4.4 `requests`

Tracks provisioning workflow and audit history.  Fields include:

- `discord_user_id` and `discord_tag`: identify the requester.
- `requested_username`: the desired MQTT username.
- `status`: `pending`, `approved`, `rejected`, `disabled`, etc.
- `profile`: which administrative profile the account should use.
- `created_at`: when the request was made.
- `reviewed_at`: when an admin reviewed it.
- `reviewed_by`: which admin reviewed it.
- `provisioned_at`: when the account was created.

Example:

```json
{
  "discord_user_id": "123456789012345678",
  "discord_tag": "user#1234",
  "requested_username": "lonewolf",
  "status": "approved",
  "profile": "lonewolf",
  "created_at": "2026-04-18T15:35:00Z",
  "reviewed_at": "2026-04-18T15:36:00Z",
  "reviewed_by": "admin#9999",
  "provisioned_at": "2026-04-18T15:37:00Z"
}
```

### 4.5 `username_policy`

Stores username validation rules enforced by Hubot before a request is accepted. This allows administrative control over reserved names and banned terms without hardcoding every rule in the bot.

Suggested fields:

- `pattern`: regular expression describing the allowed username format.
- `min_length` and `max_length`: length constraints.
- `reserved_usernames`: exact usernames that may not be claimed.
- `banned_substrings`: case-insensitive substrings that may not appear anywhere in a username.
- `updated_at`, `updated_by`: audit metadata for policy changes.

Current implementation note:

- Hubot currently enforces a fixed safe username format of leading lowercase letter followed by lowercase letters, digits, underscores, or hyphens.
- `min_length`, `max_length`, `reserved_usernames`, and `banned_substrings` are enforced from MongoDB.
- The `pattern` field may still be stored for documentation or future expansion, but arbitrary runtime regex evaluation is not currently used by Hubot.

Example document:

```json
{
  "_id": "default",
  "pattern": "^[a-z][a-z0-9_-]{2,23}$",
  "min_length": 3,
  "max_length": 24,
  "reserved_usernames": [
    "admin",
    "root",
    "system",
    "emqx",
    "hubot",
    "floodgate",
    "uplink"
  ],
  "banned_substrings": [
    "bridge",
    "bridge_"
  ],
  "updated_at": "2026-04-19T12:15:00Z",
  "updated_by": "admin#9999"
}
```

## 5. MongoDB Roles

Two database users are created:

- **EMQX (read‑only)** – `emqx_ro`: granted the `read` role on `mqtt`.  EMQX uses this account to query the `users` and `mqtt_acl` collections but cannot write.
- **Hubot (read/write)** – `hubot_rw`: granted the `readWrite` role on `mqtt`.  Hubot inserts and updates documents in all MQTT-related collections.

## 6. EMQX Integration

EMQX uses its MongoDB authentication and authorization modules to query our database.

### Authentication

- **Backend:** MongoDB (single mode)  
- **Database:** `mqtt`  
- **Collection:** `users`  
- **Filter:** `{ username = "${username}" }`  
- **Password fields:** `password_hash` and `salt`  
- **Hash algorithm:** `pbkdf2` using `sha256`, `4096` iterations, and a 32-byte derived key.

EMQX retrieves the record for the connecting client and compares the supplied password (hashed with the stored salt) against the stored `password_hash`.  If `is_superuser` is true, all topics are allowed; otherwise EMQX consults the authorizer.

### Authorization

- **Backend:** MongoDB  
- **Collection:** `mqtt_acl`  
- **Filter:** `{ username = "${username}" }`

Each document in `mqtt_acl` is evaluated in order of insertion (deny rules should be inserted before allow rules).  EMQX stops at the first matching rule, so rule order matters. Hubot preserves the order of `profiles.rules` when materializing those rows.

## 7. Authorization Model for Hubot Commands

Hubot exposes commands for account provisioning and maintenance.  Not all commands should be available to regular users.  This section defines who may run each command.

### Self‑service commands

These commands are intended for regular Discord users.  They can create a new account and rotate their own password, but cannot affect other users.

- **`/mqtt request <username>`** – Create a new MQTT account.  Hubot checks that the username is valid and not already taken, looks up the current default profile, generates credentials and ACL rules from that profile, and returns the password via direct message. Requesters do not choose the profile.
- **`/mqtt my-account`** – Show the caller’s current MQTT account details, including username, status and assigned profile (if desired).
- **`/mqtt rotate`** – Generate a new password for the caller’s own account.  Hubot updates the `users` record with a new `salt` and `password_hash` and sends the new password via direct message.

### Admin‑only commands

Only users with the designated Discord admin role (for example “MQTT Admin”) may run these commands.  Each action should be logged to an audit log for accountability.

- **`/mqtt approve <username>`** – When requests require manual approval, an admin may approve a pending request.  This inserts the user into `users` and their rules into `mqtt_acl`, and sets the request’s status to `approved`.
- **`/mqtt reject <username>`** – Rejects a pending request.  Marks the request record as `rejected` and notifies the requester.
- **`/mqtt disable <username>`** – Disables an existing MQTT account by updating its `status` to `disabled`.  Clients using that username will fail authentication.
- **`/mqtt enable <username>`** – Re‑enables a previously disabled account by setting `status` back to `active`.
- **`/mqtt rotate <username>`** – Rotates another user’s password.  Generates a new password and updates the `users` record.  This should be used when an admin must revoke or change a password on behalf of a user.
- **`/mqtt whois <username>`** – Displays ownership information for a given MQTT username, including the Discord user ID and tag, profile and account status.
- **`/mqtt set-profile <username> <profile>`** – Changes the administrative profile for an existing account.  Hubot updates the `profile` field in `users` and may update the corresponding ACL rules if profile templates are used.
- **`/mqtt profile list`** – Lists available profiles and highlights which one is the default.
- **`/mqtt profile show <profile>`** – Displays the stored rules and metadata for a profile.
- **`/mqtt profile create <profile>`** – Creates a new profile definition and its ACL template. Planned for a later phase.
- **`/mqtt profile update <profile>`** – Updates a profile’s metadata or ACL template. Planned for a later phase.
- **`/mqtt profile disable <profile>`** – Prevents a profile from being assigned to newly provisioned accounts. Planned for a later phase.
- **`/mqtt profile enable <profile>`** – Re-enables a previously disabled profile. Planned for a later phase.
- **`/mqtt profile set-default <profile>`** – Marks one profile as the default used for new accounts. Planned for a later phase.
- **`/mqtt profile apply <profile>`** – Reapplies the current ACL template for a profile to users already assigned to it.

## 8. Hubot Commands Implementation

Below is a high‑level outline of the MongoDB operations performed by each command.  Pseudocode is shown for clarity.

### `/mqtt request <username>` (Self‑service)

1. Validate the username against the stored policy (format, length, reserved names, banned substrings and uniqueness).

   ```js
   const policy = db.username_policy.findOne({ _id: "default" });
   db.users.findOne({ username });
   ```

2. Insert a new request record in `requests` with status `pending` (or auto‑approve directly).
3. Load the current default profile from `profiles` and validate that it is active.
4. Generate a strong password and random salt; compute the `password_hash` using SHA‑256.
5. Insert a document into `users` and corresponding ACL documents into `mqtt_acl`.

   ```js
   const profile = db.profiles.findOne({ is_default: true, status: "active" });
   db.users.insertOne({
     username,
     password_hash,
     salt,
     is_superuser: false,
     discord_user_id,
     discord_tag,
     profile: profile.name,
     status: "active",
     created_at: new Date(),
     created_by: "hubot"
   });
   db.mqtt_acl.insertMany(materialize(profile.rules, username));
   ```

6. Update the request record to `approved` and set `provisioned_at`.
7. Send the credentials to the user via direct message.

Username validation should reject names that:

- do not match the allowed pattern;
- are shorter or longer than the configured limits;
- exactly match a reserved username;
- contain a banned substring such as `bridge` or `bridge_`;
- are already in use or pending.

### `/mqtt my-account` (Self‑service)

Looks up the caller’s Discord user ID in `users` and returns the corresponding record.

### `/mqtt rotate` (Self‑service)

1. Locate the caller’s record in `users`.  
2. Generate a new password and salt and update `password_hash` and `salt`.

   ```js
   db.users.updateOne(
     { username: callerUsername },
     { $set: { password_hash: newHash, salt: newSalt } }
   );
   ```

3. DM the new password to the user.

### `/mqtt disable <username>` (Admin)

Sets the user’s `status` field to `disabled`.

```js
db.users.updateOne({ username }, { $set: { status: "disabled" } });
```

### `/mqtt enable <username>` (Admin)

Sets the user’s `status` field back to `active`.

### `/mqtt rotate <username>` (Admin)

Same as the self‑service rotate, but selects a different user’s record.

### `/mqtt whois <username>` (Admin)

Finds the record in `users` and displays the Discord ownership and status.

### `/mqtt set-profile <username> <profile>` (Admin)

Updates the user’s `profile` field and regenerates their ACL rules from the selected profile template.

### `/mqtt profile list` (Admin)

Lists configured profiles in name order and includes whether each profile is active and whether it is the current default.

### `/mqtt profile show <profile>` (Admin)

Returns the selected profile’s metadata and ACL rules for administrator review.

### `/mqtt profile set-default <profile>` (Admin)

Clears `is_default` from the current default profile, then sets it on the selected active profile.

### `/mqtt profile apply <profile>` (Admin)

Finds all users assigned to the profile, deletes their Hubot-managed ACL rows, and recreates them from the profile’s current `rules` template.

## 9. Security Considerations

- **Password storage:** Always store only hashed passwords.  Use a strong hash algorithm (e.g. SHA‑256) with a per‑user salt.  Never store passwords in plaintext.  
- **TLS:** Require clients to connect to EMQX over TLS (port 8883).  Disable the unencrypted port if possible.  
- **Least privilege:** Grant EMQX only read access to the database.  Hubot writes only what it needs.  Do not grant unnecessary privileges.  
- **Audit trail:** Record all admin actions (approvals, rejections, disables, etc.) in the `requests` collection or a separate audit log to maintain accountability.  
- **Admin role in Discord:** Restrict admin commands to a specific role and check membership before executing potentially destructive actions.
- **Username abuse prevention:** Enforce reserved names and banned substrings such as `bridge` / `bridge_` to prevent impersonation of infrastructure or service identities.

## 10. Operational Notes

- **MongoDB version:** Use MongoDB 8.0.x (e.g. `8.0.20`) to avoid the `buildInfo` authentication breakage introduced in MongoDB 8.1+.  Versions 8.1 and later require clients to authenticate before issuing the `buildInfo` command, which EMQX currently does not handle.  
- **Docker deployment:** Run EMQX and MongoDB in Docker Compose on an internal network.  Bind MongoDB to localhost to avoid exposing it publicly.  Use persistent volumes for data.  
- **Password rotation:** Provide mechanisms for users and admins to rotate passwords.  Encourage regular rotations.  
- **Index maintenance:** Ensure that indexes remain healthy; monitor MongoDB performance since EMQX relies on quick lookups in `users` and `mqtt_acl`.
- **Default profile safety:** Keep exactly one active default profile.  Hubot should fail provisioning if no active default exists rather than creating users with undefined ACLs.

## 11. Future Enhancements

- **Expiration and suspension:** Add `expires_at` fields to `users` or `requests` to automatically expire accounts.  Hubot can then disable or warn users when credentials are near expiry.  
- **Alerting:** Use the stored Discord user ID to send automated alerts (e.g. expiring accounts, suspicious activity) via Discord.  
- **Web interface:** Build a simple web dashboard for administrators to view and manage requests and accounts.  This could be separate from Hubot for better visibility.
