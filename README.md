# ai-matrix-bot

A private Matrix assistant that runs as a dedicated Matrix user and uses
[`@karilaa-dev/codex-core`](https://github.com/karilaa-dev/codex-core) for Codex
inference, tools, files, retrieval, memory, compaction, and persistent bash
workspaces. It syncs through the Matrix client API; no application service,
public listener, or admin access token is required.

## What it supports

- Encrypted and unencrypted one-to-one rooms.
- A durable owner-managed allowlist. Unknown invitations are declined and a
  room is left if it gains a third member.
- One core conversation for the DM timeline and a separate conversation for
  each native Matrix thread.
- Streamed answer/reasoning updates through `m.replace`, with a final
  authoritative replacement.
- Files and images up to 20 MiB each, generated artifacts, Docling extraction,
  Tavily search/extraction, retrieval, compaction, forks, and persistent bash.
- English/Russian preferences, timezone selection, stream controls, SQLite by
  default, and a separate Postgres deployment override for core persistence.
- At-least-once-safe Matrix processing: inbound event IDs and core source keys
  are deduplicated, while outbound sends use stable transaction IDs.

## Requirements

- A dedicated, non-admin Matrix account, a stable access token, and preferably
  its recovery key.
- Node.js 24 for a local install, or Docker with Compose.
- A Codex login in the same `CODEX_HOME` the bot will use.
- A separately managed Docling server reachable from the bot container.
- OpenRouter credentials for embeddings and Tavily credentials for web tools
  when those features are enabled.

The package consumes the public, tagged core library. Production lockfiles must
resolve `github:karilaa-dev/codex-core#v0.1.0`; do not deploy a mutable branch or
a developer `file:` dependency.

## Docker quick start

The default stack is deliberately one bot container, like the `ai-tg-bot`
single-container deployment. Docling is external and selected with
`DOCLING_URL`; there is no bundled Docling, public port, webhook, or appservice.

1. Copy [`.env.example`](./.env.example) to `.env`, restrict it, and fill in the
   Matrix identity, direct token/recovery values, provider keys, and external
   Docling URL:

   ```sh
   cp .env.example .env
   chmod 600 .env
   ```

   At minimum, replace:

   ```dotenv
   MATRIX_HOMESERVER_URL=https://matrix.example.org
   MATRIX_BOT_USER_ID=@ai-bot:example.org
   MATRIX_OWNER_ID=@owner:example.org
   MATRIX_DEVICE_ID=AI_MATRIX_BOT
   MATRIX_ACCESS_TOKEN=replace-me
   MATRIX_RECOVERY_KEY="replace me exactly"
   OPENROUTER_API_KEY=replace-me
   TAVILY_API_KEY=replace-me
   DOCLING_URL=http://192.168.1.10:5001
   ```

   Do not put the Matrix account password in `.env`. Quote the recovery key
   because it contains spaces.

2. Pull the published image, or build the same image from the checkout:

   ```sh
   docker compose pull bot
   # Alternatively: docker compose build bot
   ```

3. Validate the stable device and recovery identity once:

   ```sh
   docker compose run --rm --no-deps bot npm run matrix:bootstrap
   ```

   This direct-config flow does not create secret handoff files. If you only
   have the Matrix password or the account has no recovery identity yet, use
   the one-time credential flow in [Matrix setup](./docs/matrix-setup.md).

4. Authenticate Codex into its persistent Docker volume:

   ```sh
   docker compose run --rm bot codex login --device-auth
   ```

5. Start the one-container stack:

   ```sh
   docker compose up -d
   docker compose ps
   docker compose logs -f bot
   ```

The base stack exposes no host ports. It persists application data/files/bash
workspaces, Matrix sync and crypto state, and Codex authentication in named
volumes. The external Docling server owns its own model/cache state.

For Postgres-backed core persistence, use the explicit override with a
URL-safe password:

```sh
export POSTGRES_PASSWORD='replace-with-a-url-safe-secret'
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d --build
```

The Matrix adapter database remains local so sync and delivery state can be
recovered together with the crypto store. See [Deployment](./docs/deployment.md)
before backing up, restoring, or changing device credentials.

## Unraid single-container setup

The repository publishes `ghcr.io/karilaa-dev/ai-matrix-bot:latest` for
`linux/amd64` and `linux/arm64`, plus immutable full-commit SHA tags. Its Unraid
template mirrors the existing `ai-tg-bot` deployment: bridge networking, no
published ports, external Docling, direct masked configuration variables, and
two persistent mounts.

After the first publish workflow completes, set the GHCR package to public and
verify an unauthenticated `docker pull` before installing the template.

1. Prepare the final persistent paths. The one-time Matrix bootstrap must use
   this same appdata path so its device crypto store is not replaced later:

```sh
mkdir -p \
  /mnt/user/appdata/ai-matrix-bot/bootstrap-output \
  /mnt/user/appdata/ai-matrix-bot/home \
  /mnt/user/ai-matrix-bot
chown -R 99:100 /mnt/user/appdata/ai-matrix-bot /mnt/user/ai-matrix-bot
chmod -R u+rwX,g+rwX /mnt/user/appdata/ai-matrix-bot /mnt/user/ai-matrix-bot
```

2. If you only have the bot password, create the stable token, recovery key,
   and crypto identity directly in the final appdata mount. Replace the three
   public identity values; the password is read without echo and never stored:

```sh
MATRIX_HOMESERVER_URL=https://matrix.example.org
MATRIX_BOT_USER_ID=@ai-bot:example.org
MATRIX_OWNER_ID=@owner:example.org
MATRIX_DEVICE_ID=AI_MATRIX_BOT

read -rsp 'Matrix bot password: ' MATRIX_BOT_PASSWORD
printf '\n'
printf '%s' "$MATRIX_BOT_PASSWORD" | docker run --rm -i \
  --user 99:100 \
  -v /mnt/user/appdata/ai-matrix-bot:/app/data \
  -e HOME=/app/data/home \
  -e MATRIX_HOMESERVER_URL="$MATRIX_HOMESERVER_URL" \
  -e MATRIX_BOT_USER_ID="$MATRIX_BOT_USER_ID" \
  -e MATRIX_OWNER_ID="$MATRIX_OWNER_ID" \
  -e MATRIX_DEVICE_ID="$MATRIX_DEVICE_ID" \
  -e MATRIX_DATABASE_PATH=/app/data/matrix-bot.sqlite \
  -e MATRIX_STORAGE_PATH=/app/data/matrix/sync \
  -e MATRIX_CRYPTO_PATH=/app/data/matrix/crypto \
  ghcr.io/karilaa-dev/ai-matrix-bot:latest \
  npm run matrix:bootstrap -- \
    --user "$MATRIX_BOT_USER_ID" --password-stdin \
    --token-out /app/data/bootstrap-output/matrix_access_token \
    --recovery-key-out /app/data/bootstrap-output/matrix_recovery_key
unset MATRIX_BOT_PASSWORD
```

   If the account already has recovery configured, add
   `-e MATRIX_RECOVERY_KEY="$MATRIX_RECOVERY_KEY"` to `docker run` and omit
   `--recovery-key-out`. If the existing key is lost, deliberately reset the bot
   account's recovery first; old room keys may remain unrecoverable.

3. Install the template, refresh the Docker page, and select
   **ai-matrix-bot** in **Add Container**:

```sh
mkdir -p /boot/config/plugins/dockerMan/templates-user
wget -O /boot/config/plugins/dockerMan/templates-user/my-ai-matrix-bot.xml \
  https://raw.githubusercontent.com/karilaa-dev/ai-matrix-bot/main/templates/ai-matrix-bot.xml
```

   Copy the generated token and recovery key into their masked template fields,
   fill in OpenRouter/Tavily keys and `DOCLING_URL`, and then remove the two
   temporary credential-output files. Keep these mounts:

| Host path | Container path | Contents |
| --- | --- | --- |
| `/mnt/user/appdata/ai-matrix-bot` | `/app/data` | SQLite, Matrix sync/crypto, Codex auth/config, home/cache |
| `/mnt/user/ai-matrix-bot` | `/app/data/files` | uploads, generated files, and bash workspaces |

4. Start the container and authenticate Codex once from its console:

```sh
codex login --device-auth
codex login status
```

Unraid stores masked environment values in its user-template XML on the flash
drive. Protect flash backups accordingly. Stop the container and back up both
appdata and the user-files share at the same recovery point so SQLite/WAL,
Matrix crypto, files, and bash state remain consistent.

## Local development

```sh
npm ci
npm run check
npm test
npm run build
```

Copy `.env.example` to `.env`, adjust it, and restrict it to the owner. Export
that file in your shell (`set -a; source .env; set +a`), then use
`npm run matrix:bootstrap` once and `npm run dev` to start the sync loop.
The example uses local relative paths; Compose overrides them with container
paths. `npm run health` checks local readiness without exposing an HTTP endpoint.

## Matrix behavior

The initial owner is read from `MATRIX_OWNER_ID` and persisted in the
allowlist. Owner-only commands are:

- `!allow @user:server` — allow a user.
- `!deny @user:server` — revoke a user; the owner cannot be revoked.
- `!users` — list allowed users.

Conversation commands are `!help`, `!lang`, `!timezone`, `!stream`, `!stop`,
`!fork`, `!compact`, and `!retry`. A command issued in a thread affects that
thread's core conversation. `!fork` creates a sibling Matrix thread so forks
never become nested threads.

The bot ignores its own events, reactions, peer notices, and unsupported event
types. Edits replace queued text only before inference begins; later edits are
answered with an instruction to send a new message.

## Security and operations

Matrix E2EE protects data in transit and on the homeserver, but this application
must decrypt content to run inference. Decrypted messages, media, extracted
text, embeddings, summaries, and bash files are stored as application
plaintext. Use encrypted disks/volumes, protect backups, and never share the
Matrix crypto volume between running replicas. Read [Security](./docs/security.md)
and [Matrix setup](./docs/matrix-setup.md) before production use.

The supported deployment is one bot process per Matrix device store. Horizontal
replicas, group rooms, appservice mode, multiple identities, and npm-registry
publication are intentionally out of scope for v0.1.0.

## Reusing the core in `ai-tg-bot`

The Telegram repository remains unchanged. The exact no-data-migration adapter
and wrapper guide is maintained in
[`codex-core/docs/ai-tg-bot-migration.md`](https://github.com/karilaa-dev/codex-core/blob/v0.1.0/docs/ai-tg-bot-migration.md)
and is checked against `ai-tg-bot` revision `7eedd5f`.

Additional documentation:

- [Architecture and implementation map](./PLAN.md)
- [Deployment and recovery](./docs/deployment.md)
- [Matrix account and room setup](./docs/matrix-setup.md)
- [Security model](./docs/security.md)
- [Testing](./docs/testing.md)
