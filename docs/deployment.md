# Deployment and recovery

## Production layout

The supported topology is one `bot` container and one Docling service. The base
Compose file uses SQLite. `docker-compose.postgres.yml` adds Postgres for core
semantic persistence; it does not merge into the base path automatically, so
always pass both files for every lifecycle command.

The image uses Node 24 on Debian Bookworm and installs
`@openai/codex@0.144.0`. Upgrading Codex is a compatibility change: run the core
app-server protocol suite and authenticated smoke before changing
`CODEX_RELEASE`.

## Durable state

Treat these as one recovery set:

| State | Compose volume | Contents |
| --- | --- | --- |
| Application | `bot-data` | adapter DB, core SQLite DB, files, bash workspaces |
| Matrix device | `matrix-state` | sync cursor, SDK state, E2EE crypto keys |
| Codex | `codex-home` | Docker-owned login and configuration |
| Extraction | `docling-cache` | downloaded Docling model/cache data |

The Postgres profile adds `postgres-data`; include a consistent `pg_dump` (or
volume snapshot with Postgres stopped) in the same recovery point. Docling cache
can be reconstructed, but preserving it avoids a cold model download.

Back up only while the bot is stopped or by using storage-level snapshots that
are consistent across the adapter DB and Matrix state. Encrypt backups and keep
the Matrix access token/recovery key in a separate secrets system.

The temporary writable bootstrap directory documented in the README is only an
output handoff for a newly generated recovery key. Move the key into the Docker
secret source immediately and remove the empty handoff directory; do not include
it in the application-volume backup set.

## Start and health

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=200 bot
```

The health command is local and side-effect free: it verifies configuration,
the single-process lock/readiness state, persistent paths, and recent sync
progress. It does not expose an HTTP endpoint. A failed health check should
trigger log inspection, not a second replica against the same device store.

Use graceful `docker compose stop` so active turns are cancelled, terminal
delivery state is flushed, and stores close cleanly. During upgrades, keep the
same device ID and volumes.

## Restore drill

1. Stop the old stack and prevent it from restarting.
2. Restore application, Matrix, Codex, and (when used) Postgres state from the
   same recovery point.
3. Re-provision secret files without placing them inside a volume snapshot.
4. Start exactly one bot instance with the same homeserver, MXID, and device ID.
5. Confirm health, decrypt an older message, and verify `!users` and one prior
   thread mapping before sending a new prompt.
6. Confirm history, retrieved files, bash workspace, and Codex login. Watch logs
   for replayed event IDs; they should be deduplicated without duplicate output.

If crypto state is lost, do not silently create a fresh device under the same
deployment. Re-run the documented bootstrap/recovery flow, verify the device,
and accept that unrecoverable historical events cannot be inferred from.

## Postgres profile

`POSTGRES_PASSWORD` is interpolated into a URL; use a strong URL-safe value or
provide an already URL-encoded value. Start and stop with both files:

```sh
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d
docker compose -f docker-compose.yml -f docker-compose.postgres.yml down
```

Never use `down -v` in production: it deletes the named recovery state.
