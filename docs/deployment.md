# Deployment and recovery

## Production layout

The supported base topology is one `bot` container. Docling is a separately
managed service selected through `DOCLING_URL`; the bot exposes no port and does
not require a webhook, reverse-proxy route, or Matrix appservice registration.
The base Compose file uses SQLite. `docker-compose.postgres.yml` optionally adds
Postgres for core semantic persistence, so that override is intentionally no
longer a one-container deployment.

The published image is `ghcr.io/karilaa-dev/ai-matrix-bot:latest`, with immutable
`sha-<full-commit>` tags for `linux/amd64` and `linux/arm64`. The image uses Node
24 on Debian Bookworm and installs `@openai/codex@0.144.0`. Upgrading Codex is a
compatibility change: run the core app-server protocol suite and authenticated
smoke before changing `CODEX_RELEASE`.

The first GHCR package creation may require its visibility to be changed to
public in GitHub package settings. Treat an unauthenticated pull of both the
`latest` and selected immutable tag as a release gate before advertising the
Unraid template.

## Configuration and credentials

The default deployment reads `.env`, matching `ai-tg-bot`'s simple
single-container configuration. `MATRIX_ACCESS_TOKEN` and
`MATRIX_RECOVERY_KEY` are direct environment values; the recovery key should be
quoted because it contains spaces. Restrict `.env` to its owner and never put
the Matrix account password in it.

This convenience has an explicit tradeoff: direct environment values are
visible to privileged Docker operators through container inspection and can be
rendered by `docker compose config`. Do not paste either output into logs or
support requests. The bot passes an explicitly sanitized environment to the
Codex subprocess so Matrix/provider/database secrets are not directly inherited
there, but that is defense in depth rather than a separate security boundary.

The application-level `MATRIX_ACCESS_TOKEN_FILE` and
`MATRIX_RECOVERY_KEY_FILE` fallbacks remain available for custom orchestrators,
but the supplied Compose and Unraid deployments intentionally use direct config
values.

## Durable state

Treat these volumes as one recovery set:

| State | Compose volume | Contents |
| --- | --- | --- |
| Application | `bot-data` | adapter DB, core SQLite DB, files, bash workspaces |
| Matrix device | `matrix-state` | sync cursor, SDK state, E2EE crypto keys |
| Codex | `codex-home` | Docker-owned login and configuration |

The external Docling service owns its own cache. The Postgres profile adds
`postgres-data`; include a consistent `pg_dump` or a stopped-volume snapshot in
the same recovery point.

Back up only while the bot is stopped or by using storage-level snapshots that
are consistent across application and Matrix state. Encrypt backups. Keep `.env`
or file-backed credentials outside application-volume snapshots and protect them
in the host's normal configuration/secrets backup.

The Unraid template consolidates adapter/core/Matrix/Codex state beneath
`/mnt/user/appdata/ai-matrix-bot` and puts user files beneath
`/mnt/user/ai-matrix-bot`. Stop the container and back up both paths at the same
recovery point so the SQLite database, WAL, sync cursor, crypto store, files,
and bash workspaces are mutually consistent. Protect the Unraid flash backup
separately because its user-template XML contains the masked environment values.

## Start and health

```sh
docker compose pull bot
docker compose up -d
docker compose ps
docker compose logs --tail=200 bot
docker compose exec -T bot npm run health --silent
```

Use `docker compose up -d --build` when intentionally building the checkout
instead of pulling the published image. The local health command verifies
configuration, the single-process lock/readiness state, persistent paths, and
recent sync progress; it exposes no HTTP endpoint. A failed check should trigger
log inspection, not a second replica against the same device store.

Use graceful `docker compose stop` so active turns are cancelled, terminal
delivery state is flushed, and stores close cleanly. During upgrades, preserve
the same bot MXID, token/device identity, device ID, and volumes.

## Restore drill

1. Stop the old container and prevent it from restarting.
2. Restore application, Matrix, Codex, and optional Postgres state from the same
   recovery point.
3. Restore `.env` or file-backed credentials separately.
4. Start exactly one bot instance with the same homeserver, MXID, and device ID.
5. Confirm health, decrypt an older message, and verify `!users` and one prior
   thread mapping before sending a new prompt.
6. Confirm history, retrieved files, bash workspace, and Codex login. Replayed
   Matrix event IDs should be deduplicated without duplicate output.

If crypto state is lost, do not silently create a fresh deployment under the
same identity. Re-run the documented bootstrap/recovery flow, verify the device,
and accept that unrecoverable historical events cannot be reconstructed from the
account password.

## Postgres profile

`POSTGRES_PASSWORD` is interpolated into a URL; use a strong URL-safe value or
an already URL-encoded value. Always include both files:

```sh
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d
docker compose -f docker-compose.yml -f docker-compose.postgres.yml down
```

Never use `down -v` in production: it deletes the named recovery state.
