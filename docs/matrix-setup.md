# Matrix account and room setup

## Dedicated identity

Create a normal Matrix user for the bot on the homeserver you administer. Do
not grant it server-admin privileges and do not use an application-service or
server-admin access token. Log in once with a trusted client, record the access
token, and choose one stable device ID for this deployment.

Set:

- `MATRIX_HOMESERVER_URL` to the client API base URL.
- `MATRIX_BOT_USER_ID` to the dedicated bot's full MXID.
- `MATRIX_OWNER_ID` to the full MXID that controls the allowlist.
- `MATRIX_DEVICE_ID` to a stable value; changing it creates a new cryptographic
  device and requires a deliberate recovery/bootstrap operation.
- `MATRIX_ACCESS_TOKEN` to the stable device token.
- `MATRIX_RECOVERY_KEY` to the matching recovery key, quoted when stored in
  `.env` because it contains spaces.

Run `npm run matrix:bootstrap` (or the Docker command in the README). Bootstrap
validates the token with `/whoami`, rejects an identity mismatch, initializes
the durable SDK/crypto paths, and records the owner. It never stores an account
password.

Direct environment values are the supplied single-container path. The
application still supports `MATRIX_ACCESS_TOKEN_FILE` and
`MATRIX_RECOVERY_KEY_FILE` for custom orchestrators, but no second Compose
deployment mode is maintained.

## One-time password bootstrap

If only the account password is available, leave `MATRIX_ACCESS_TOKEN` and (for
a new recovery identity) `MATRIX_RECOVERY_KEY` empty, then pass the password on
stdin. A child process cannot update the parent Compose environment, so write
the generated credentials into a temporary owner-only handoff directory:

This command is for the named-volume Compose deployment. Unraid must use the
Unraid-specific command in the README so bootstrap and the final container share
the same `/mnt/user/appdata/ai-matrix-bot` crypto store.

```sh
mkdir -p .matrix-bootstrap
chmod 700 .matrix-bootstrap
# On Linux, make the temporary bind writable by the image's node user:
sudo chown 1000:1000 .matrix-bootstrap

set -a
. ./.env
set +a
read -rsp 'Matrix bot password: ' MATRIX_BOT_PASSWORD
printf '\n'
printf '%s' "$MATRIX_BOT_PASSWORD" | docker compose run --rm --no-deps -T \
  -v "$PWD/.matrix-bootstrap:/bootstrap-output" \
  bot npm run matrix:bootstrap -- \
    --user "$MATRIX_BOT_USER_ID" --password-stdin \
    --token-out /bootstrap-output/matrix_access_token \
    --recovery-key-out /bootstrap-output/matrix_recovery_key
unset MATRIX_BOT_PASSWORD
```

Copy the two exact values into the masked Unraid fields or into
`MATRIX_ACCESS_TOKEN` and quoted `MATRIX_RECOVERY_KEY` entries in `.env`, then
securely remove the temporary handoff directory. The output files are created
with mode `0600`; do not print them into logs or shell history.

If account recovery already exists, put its key in `MATRIX_RECOVERY_KEY` before
login and omit `--recovery-key-out`; bootstrap validates it rather than creating
a replacement. If the server reports existing recovery but the key is lost,
reset recovery/cross-signing deliberately from a trusted Matrix client first.
There is no bot CLI reset flag, and an account password cannot recover old
Megolm room keys.

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
