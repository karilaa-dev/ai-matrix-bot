# Matrix account and room setup

## Dedicated account

Create a normal, non-admin Matrix user for the bot. Do not use the owner's
account, a server-admin token, or an application-service token.

Choose one of two authentication modes.

### Existing access token

Log in once through a trusted Matrix client or the standard Matrix login API,
then store the bot account's token in `MATRIX_ACCESS_TOKEN`. Do not also set
`MATRIX_LOGIN` or `MATRIX_PASSWORD`.

You can validate the token before deployment:

```sh
export MATRIX_HOMESERVER_URL=https://matrix.example.org
export MATRIX_ACCESS_TOKEN='replace-me'
curl --fail --silent --show-error \
  -H "Authorization: Bearer $MATRIX_ACCESS_TOKEN" \
  "$MATRIX_HOMESERVER_URL/_matrix/client/v3/account/whoami"
```

The response must identify the dedicated bot account.

### Login and password

When no token is available, leave `MATRIX_ACCESS_TOKEN` empty and set:

```dotenv
MATRIX_LOGIN=@ai-bot:example.org
MATRIX_PASSWORD=replace-me
```

A full MXID is recommended for `MATRIX_LOGIN`; a localpart is also accepted.
The bot submits the credentials through Matrix `m.login.password`, validates
the response with `/whoami`, and stores the resulting access token and device
ID in `/app/data/matrix/session.json` with owner-only permissions. The password
is read from the environment and is never written into appdata.

On restart, the cached session preserves the Matrix device. Back up appdata to
preserve that session when moving the bot. After one successful start you may
clear the login and password fields; provide them again only to replace a
revoked cached token. The password is never copied into appdata.

In either mode, the application learns its bot MXID and device ID from Matrix,
so `MATRIX_BOT_USER_ID` and `MATRIX_DEVICE_ID` are not deployment settings.

## Encryption secret

Set `MATRIX_ENCRYPTION_SECRET` to one unique passphrase of at least 32
characters. `openssl rand -hex 32` can generate one. This is the only
encryption value needed in the normal deployment configuration.

On startup the bot prepares its local Matrix crypto store and then:

- creates passphrase-backed Matrix secret storage and a cryptographic identity
  when the account has none; or
- confirms the existing identity with the configured secret.

If the account already has recovery configured, use its existing recovery key
or passphrase as `MATRIX_ENCRYPTION_SECRET`. The bot does not reset an existing
identity when the value is wrong.

Keep the exact secret when moving the bot. It recovers secret-storage and
cross-signing identity, but it does not by itself restore every old Megolm room
key. Copy `/app/data/matrix` as part of a full migration when historical
encrypted events must remain readable.

If that crypto directory cannot be restored, create a genuinely new bot device:
use login/password mode or issue a new access token. Do not reuse an old device
token with an empty crypto store.

## First room

1. Start the bot and wait for a healthy sync.
2. From `MATRIX_OWNER_ID`, create a new one-to-one DM with the bot account.
3. Enable room encryption before sending private content.
4. Ensure the room contains exactly the owner and bot.
5. Send `!users` to confirm that the owner allowlist was initialized.

The owner may then use `!allow @user:server` and `!deny @user:server`.
Federated MXIDs work when explicitly allowlisted.

The bot joins invitations only from allowlisted users. `m.direct` metadata is
recorded for client behavior but never grants access. A third joined or invited
participant causes active work to be cancelled and the bot to leave.

## Threads and recovery checks

The main DM timeline is one Codex conversation. Each native Matrix thread maps
to a separate conversation. Threads cannot nest; `!fork` creates a sibling
thread from the main timeline.

After moving or restoring the bot, verify all of the following before normal
use:

- `!users` returns once;
- one existing thread still maps to its prior conversation;
- a newly encrypted message decrypts;
- an older encrypted message decrypts when the crypto store was restored;
- replayed Matrix events do not create duplicate replies.

Run only one bot process against a given cached session and crypto store.

## Homeserver requirements

The bot needs normal client API access to `/versions`, `/whoami`, `/sync`, room
state and membership, typing notifications, media upload/download, and event
sending. The homeserver must support Matrix client-server API v1.4 or newer for
threads.
