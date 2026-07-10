# ai-matrix-bot

A private Matrix assistant that runs as a dedicated Matrix user and uses
[`@karilaa-dev/codex-core`](https://github.com/karilaa-dev/codex-core) for
Codex chat, tools, files, retrieval, memory, compaction, image generation, and
persistent bash workspaces. It uses the normal Matrix client API, so it needs no
appservice registration, webhook, public port, or admin token.

## Features

- Encrypted and unencrypted one-to-one rooms.
- Owner-managed allowlisting and automatic group-room rejection.
- A separate Codex conversation for the main DM and every Matrix thread.
- Streaming through Matrix edits, plus deterministic retries and deduplication.
- Files and images up to 20 MiB, generated artifacts, retrieval, forks,
  compaction, Tavily tools, Docling extraction, and persistent bash.
- SQLite by default and an optional Postgres override for core persistence.

## Minimal Docker Compose deployment

Set the homeserver, owner, encryption secret, and one authentication mode:

```dotenv
MATRIX_HOMESERVER_URL=https://matrix.example.org
MATRIX_OWNER_ID=@owner:example.org
MATRIX_ENCRYPTION_SECRET=replace-with-output-of-openssl-command-below

# Authentication mode 1: existing token
MATRIX_ACCESS_TOKEN=replace-me
```

Token mode is the smallest deployment: four values total. If you do not have a
token, replace `MATRIX_ACCESS_TOKEN` with login mode:

```dotenv
MATRIX_LOGIN=@ai-bot:example.org
MATRIX_PASSWORD=replace-me
```

A full bot MXID is recommended for `MATRIX_LOGIN`; its localpart is also
accepted. The bot logs in once and caches the resulting access token and device
in `/app/data/matrix/session.json`. The password remains an environment value
and is never written into appdata. After the first successful start, the login
and password may be cleared; the owner-only cached session is sufficient for
later starts. Provide them again if the cached token is revoked. On a fresh
deployment, configure exactly one authentication mode.

Choose a unique `MATRIX_ENCRYPTION_SECRET` of at least 32 characters and
preserve it exactly. `openssl rand -hex 32` can generate one. On first start
the bot uses it to establish Matrix secret storage; on later starts or a new
host it confirms the same account identity. A wrong value fails safely instead
of resetting recovery.

Start the bot:

```sh
cp .env.example .env
chmod 600 .env
# Edit the common values and one authentication mode in .env.

docker compose pull bot
docker compose run --rm bot codex login --device-auth
docker compose up -d
docker compose logs -f bot
```

Verify readiness at any time:

```sh
docker compose exec -T bot npm run health --silent
```

The base deployment is one container and one persistent `bot-data` volume. All
SQLite databases, Matrix crypto/sync state, uploaded files, bash workspaces,
and Codex authentication live below `/app/data`.

### Optional integrations

Add any of these to `.env` when you want the corresponding feature:

```dotenv
DOCLING_URL=http://192.168.1.10:5001
OPENROUTER_API_KEY=replace-me
TAVILY_API_KEY=replace-me
```

- `DOCLING_URL` enables DOCX conversion and low-text PDF fallback through a
  separately managed Docling server.
- `OPENROUTER_API_KEY` enables embeddings and semantic retrieval.
- `TAVILY_API_KEY` enables web search and page extraction.

Model, timeout, concurrency, and logging overrides are listed as commented
options in [`.env.example`](./.env.example). Defaults work without copying
them into `.env`.

## Minimal Unraid deployment

1. Prepare the two writable bind-mount directories for Unraid's container UID:

   ```sh
   mkdir -p /mnt/user/appdata/ai-matrix-bot /mnt/user/ai-matrix-bot
   chown 99:100 /mnt/user/appdata/ai-matrix-bot /mnt/user/ai-matrix-bot
   chmod 0770 /mnt/user/appdata/ai-matrix-bot /mnt/user/ai-matrix-bot
   ```

2. Install the template:

   ```sh
   mkdir -p /boot/config/plugins/dockerMan/templates-user
   wget -O /boot/config/plugins/dockerMan/templates-user/my-ai-matrix-bot.xml \
     https://raw.githubusercontent.com/karilaa-dev/ai-matrix-bot/main/templates/ai-matrix-bot.xml
   ```

3. In **Docker → Add Container → ai-matrix-bot**, fill in:

   - Matrix Homeserver URL
   - Matrix Owner User ID
   - Matrix Encryption Secret
   - either Matrix Access Token, or Matrix Login plus Matrix Password

   Keep the default appdata and user-files paths. Docling, OpenRouter, and
   Tavily fields are optional. A full MXID is recommended for Matrix Login,
   though its localpart is accepted. After the first successful password-mode
   start, the login/password fields may be cleared because appdata contains the
   cached session.

4. Start the container, open its console, and authenticate Codex once:

   ```sh
   codex login --device-auth
   codex login status
   ```

5. Invite the bot account to a new encrypted DM from the owner account and send
   `!users`.

There is no separate Matrix bootstrap container, credential-output directory,
secret-file mount, port mapping, or Docling container in this deployment.

## Moving or restoring the bot

Stop the old instance first. Move the common Matrix settings and restore
`/app/data` (the Compose `bot-data` volume, or the Unraid appdata and user-files
paths). This preserves the cached token/device in
`/app/data/matrix/session.json`, so the password is not needed on the new host
unless that token must be replaced. Without a session backup, supply either an
access token or login/password again. Start exactly one new instance.

The encryption secret restores the bot's Matrix secret-storage and
cross-signing identity, but it is **not a complete backup of old Megolm room
sessions**. If the Matrix crypto directory is not restored, some historical
encrypted events can remain unreadable even with the correct secret. Back up
application data and Matrix crypto state together when old history matters.

See [Deployment and recovery](./docs/deployment.md) for backups, upgrades, and
the optional Postgres profile.

## Matrix behavior

The configured owner is inserted into the durable allowlist. Owner-only
commands are:

- `!allow @user:server`
- `!deny @user:server`
- `!users`

Conversation commands are `!help`, `!lang`, `!timezone`, `!stream`, `!stop`,
`!fork`, `!compact`, and `!retry`. A command in a Matrix thread affects that
thread's Codex conversation.

The bot joins invitations only from allowlisted users and requires exactly two
room participants. It ignores its own events, reactions, peer notices, and
unsupported message types.

## Local development

Node.js 24 is required outside Docker:

```sh
npm ci
npm run check
npm test
npm run build
```

Copy `.env.example` to `.env`, export it in your shell, authenticate Codex in
the configured `CODEX_HOME`, and run `npm run dev`.

## Security boundary

Matrix E2EE protects data in transit and on the homeserver. The bot must decrypt
messages to run inference, so messages, extracted text, files, embeddings,
summaries, and bash state are application plaintext. Use encrypted storage and
backups. Environment secrets are visible to privileged Docker operators and in
rendered Docker configuration; never paste `docker compose config` into public
logs.

Read [Security](./docs/security.md) and [Matrix setup](./docs/matrix-setup.md)
before production use.

## Reusing `codex-core`

The Telegram repository remains unchanged in this release. Its compiling,
no-data-migration adoption guide is in
[`codex-core/docs/ai-tg-bot-migration.md`](https://github.com/karilaa-dev/codex-core/blob/v0.1.0/docs/ai-tg-bot-migration.md).

Additional documentation:

- [Architecture and implementation map](./PLAN.md)
- [Deployment and recovery](./docs/deployment.md)
- [Matrix account and room setup](./docs/matrix-setup.md)
- [Security model](./docs/security.md)
- [Testing](./docs/testing.md)
