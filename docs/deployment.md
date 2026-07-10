# Deployment and recovery

## Production layout

The supported base deployment is one `bot` container with one `/app/data`
volume. It exposes no port and needs no webhook, reverse proxy, homeserver
plugin, or Matrix appservice registration.

Docling is an optional, separately managed service selected with `DOCLING_URL`.
SQLite is built in. The optional `docker-compose.postgres.yml` override adds a
second container only when Postgres-backed core persistence is wanted.

The published image is
`ghcr.io/karilaa-dev/ai-matrix-bot:latest`, with immutable
`sha-<full-commit>` tags for `linux/amd64` and `linux/arm64`.

## Minimal configuration

Every deployment needs three common Matrix values:

| Variable | Purpose |
| --- | --- |
| `MATRIX_HOMESERVER_URL` | Matrix client API base URL |
| `MATRIX_OWNER_ID` | Full MXID that owns the allowlist |
| `MATRIX_ENCRYPTION_SECRET` | Stable passphrase for Matrix secret storage and identity recovery |

For a fresh deployment, choose exactly one authentication mode:

| Mode | Variables | Behavior |
| --- | --- | --- |
| Existing token | `MATRIX_ACCESS_TOKEN` | Smallest deployment: four total values |
| Login | `MATRIX_LOGIN` and `MATRIX_PASSWORD` | Logs in and caches the generated token/device |

Use the bot's full MXID for `MATRIX_LOGIN` when possible; a localpart is also
accepted by Matrix `m.id.user` login. In login mode the generated session is
stored owner-only at `/app/data/matrix/session.json`. The password stays in the
process environment and is never written to appdata.

Both modes cache the active access token and device in that session file. Once
a password login succeeds, `MATRIX_LOGIN` and `MATRIX_PASSWORD` may be removed;
the cached session is enough for later starts. Supply them again only when the
cached token needs replacement. A restored valid session likewise needs no
authentication environment value.

The bot learns its own MXID and device ID from the authenticated session. Do
not configure copies of those values.

Use a random encryption secret of at least 32 characters and keep it unchanged;
`openssl rand -hex 32` can generate one. If the Matrix account has no
recovery identity, first startup establishes one with this secret. If recovery
already exists, startup validates the same secret. An incorrect value is an
error and never triggers an automatic reset.

Optional integrations are independent:

- `DOCLING_URL` for DOCX and low-text PDF extraction;
- `OPENROUTER_API_KEY` for embeddings and semantic retrieval;
- `TAVILY_API_KEY` for web search and extraction.

Direct environment values, including login-mode passwords, are visible to
privileged Docker operators and may appear in `docker compose config`. Protect
`.env` with mode `0600` and do not share rendered container configuration.

## Compose start

```sh
cp .env.example .env
chmod 600 .env
# Edit the three common values, one authentication mode, and integrations.

docker compose pull bot
docker compose run --rm bot codex login --device-auth
docker compose up -d
docker compose exec -T bot npm run health --silent
```

Use `docker compose logs --tail=200 bot` for startup failures. Stop gracefully
with `docker compose stop`. Never use `docker compose down -v` in production,
because it deletes persistent state.

## Durable state

Everything owned by the bot is below `/app/data`:

| Path | Contents |
| --- | --- |
| `/app/data/matrix-bot.sqlite` | allowlist, room mappings, inbox, and delivery state |
| `/app/data/codex-core.sqlite` | conversations, memory, summaries, files, and embeddings |
| `/app/data/matrix/session.json` | cached Matrix access token and device ID |
| `/app/data/matrix` | Matrix sync cursor, device keys, and room sessions |
| `/app/data/codex` | Codex authentication and configuration |
| `/app/data/files` | uploads, generated files, and bash workspaces |
| `/app/data/home` | application home and cache files |

Compose persists this as `bot-data`. Unraid mounts
`/mnt/user/appdata/ai-matrix-bot` at `/app/data` and may overlay
`/mnt/user/ai-matrix-bot` at `/app/data/files` so large user files remain on a
separate share.

Back up while the bot is stopped, or use a storage snapshot that is consistent
across every path. With Postgres, include a matching `pg_dump` or stopped
Postgres volume snapshot.

## Moving to another host

1. Stop the old container and prevent it from restarting.
2. Copy `.env` or recreate the same common values on the new host. Authentication
   values are optional when a valid session file is restored.
3. Restore the `/app/data` backup to the new Compose volume or Unraid paths.
4. Start exactly one bot instance.
5. Check health, `!users`, one existing thread, an older encrypted event, and
   `codex login status`.

The same `MATRIX_ENCRYPTION_SECRET` lets a replacement installation recover or
confirm the account's Matrix secret-storage and cross-signing identity. It does
not contain every historical Megolm room session. If `/app/data/matrix/crypto`
is lost, older encrypted events may remain unreadable even with the correct
secret. Preserve the Matrix crypto directory whenever historical decryption
matters.

Do not copy one crypto store into two concurrently running containers.

Restoring `/app/data/matrix/session.json` preserves the same access token and
Matrix device. The configured password is never read from or written to that
file; it exists only in `.env` or the masked Unraid field while configured. A
blank appdata directory requires an access token or causes password mode to
create a new login/device, while the same encryption secret can recover the
account identity for new traffic. Historical decryption still depends on the
restored crypto store.

Do not reuse an old device access token with an empty Matrix crypto directory.
If the crypto directory cannot be restored, use login/password mode or issue a
new access token so Matrix sees a genuinely new device.

## Upgrade from the earlier three-volume Compose layout

Releases before the single-volume layout stored Matrix crypto and Codex login
in separate `matrix-state` and `codex-home` volumes, while Compose bash
workspaces lived at `/app/data/bash`. Before starting the new layout, stop the
old bot, copy the two volume contents, and copy the old bash directory to its
new location inside the existing `bot-data` volume:

```sh
docker compose stop
docker volume ls
```

Identify the three volumes for this Compose project, then run the following
with their real names substituted:

```sh
docker run --rm \
  -v OLD_BOT_DATA_VOLUME:/new \
  -v OLD_MATRIX_STATE_VOLUME:/old-matrix:ro \
  -v OLD_CODEX_HOME_VOLUME:/old-codex:ro \
  alpine:3.22 sh -c '
    mkdir -p /new/matrix /new/codex /new/files/bash
    cp -a /old-matrix/. /new/matrix/
    cp -a /old-codex/. /new/codex/
    if [ -d /new/bash ]; then cp -a /new/bash/. /new/files/bash/; fi
    chown -R 1000:1000 /new/matrix /new/codex /new/files/bash
  '
```

Set `MATRIX_ENCRYPTION_SECRET` to the exact former
`MATRIX_RECOVERY_KEY` value, if one was used. Quote it in `.env` when it
contains spaces. Then start the updated Compose file. Keep the old volumes
and `/app/data/bash` directory until an older encrypted event, Codex login, and
an existing bash workspace have all been verified.

The earlier Unraid template already stored these paths below its appdata mount,
so it needs no volume copy. Preserve its existing appdata and user-files paths
when updating the template.

## Postgres profile

The Matrix adapter remains in local SQLite; only core semantic persistence uses
Postgres. Use a strong URL-safe password and include both Compose files:

```sh
export POSTGRES_PASSWORD='replace-with-a-url-safe-secret'
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d
```

Stop the same profile with:

```sh
docker compose -f docker-compose.yml -f docker-compose.postgres.yml stop
```
