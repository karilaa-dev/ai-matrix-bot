# Matrix account and room setup

## Dedicated identity

Create a normal Matrix user for the bot on the homeserver you administer. Do
not grant it server-admin privileges and do not use an application-service or
server-admin access token. Log in once with a trusted client, record the access
token, and choose one stable device ID for this deployment.

Set:

- `MATRIX_HOMESERVER_URL` to the client API base URL.
- `MATRIX_OWNER_ID` to the full MXID that controls the allowlist.
- `MATRIX_DEVICE_ID` to a stable value; changing it creates a new cryptographic
  device and requires a deliberate recovery/bootstrap operation.
- `MATRIX_ACCESS_TOKEN_FILE` and `MATRIX_RECOVERY_KEY_FILE` to owner-only secret
  files. Environment-token fallback is intended for bootstrap/development only.

Run `npm run matrix:bootstrap` (or the Docker command in the README). Bootstrap
validates the token with `/whoami`, rejects an identity mismatch, initializes
the durable SDK/crypto paths, and records the owner. It never stores an account
password.

To log in once instead of supplying a token, leave the access-token file absent,
export the remaining configuration, and pass the password only on stdin. The
token and newly created recovery key are written with owner-only permissions:

```sh
mkdir -p secrets
chmod 700 secrets
read -s MATRIX_BOT_PASSWORD
printf '%s' "$MATRIX_BOT_PASSWORD" | npm run matrix:bootstrap -- \
  --user "$MATRIX_BOT_USER_ID" --password-stdin \
  --token-out secrets/matrix_access_token \
  --recovery-key-out secrets/matrix_recovery_key
unset MATRIX_BOT_PASSWORD
```

If account recovery already exists, place its key in the configured recovery
file before login; bootstrap validates it rather than creating a replacement.

Docker secrets are read-only. When bootstrap creates a new recovery identity,
pass `--recovery-key-out` pointing at the temporary writable bind mount shown in
the README, then move that generated owner-only file into
`secrets/matrix_recovery_key` before starting the bot. Never point a newly
generated recovery-key output at `/run/secrets/matrix_recovery_key`.

## E2EE trust and recovery

Verify the new bot device from a trusted existing client and establish account
recovery/cross-signing before inviting it to important encrypted rooms. Keep the
recovery key outside the application-data volume. Back up the crypto store even
when a recovery key exists: recovery metadata does not replace all historical
room keys held by the device.

After a recovery, verify an older encrypted event before accepting new work.
Never copy one crypto store into two concurrently running bot instances.

## Authorization and room rules

On first start, the configured owner is inserted into the durable allowlist.
Only the owner may run `!allow`, `!deny`, and `!users`. Federated MXIDs may be
allowed explicitly; `m.direct` metadata alone never grants access.

The bot joins an invitation only when the inviter is allowlisted. After joining,
it requires exactly two participants: the bot and one peer. Inviting or joining
a third member causes active work to be cancelled and the bot to leave. This
rule applies to encrypted and unencrypted rooms.

Use native Matrix threads for parallel conversations. The main room timeline is
one conversation; each thread root maps to another. Threads cannot nest, so a
fork made from inside a thread is posted as a sibling root in the main timeline.

## Homeserver checks

The bot needs normal client API access to `/versions`, `/whoami`, `/sync`, room
membership/state, typing notifications, media upload/download, and message send.
The account must be able to send `m.room.message` and relation metadata
(`m.thread`, `m.replace`, and replies). Ensure reverse-proxy event/body
limits leave room for the configured `MATRIX_MAX_EVENT_BYTES`.

No inbound port, webhook, or appservice registration is used.
