# Security model

## Trust boundaries

The bot account is a normal, non-admin Matrix user. Authorization is the local
durable allowlist, not room visibility, `m.direct`, encryption, or homeserver
membership alone. The configured owner is the only principal allowed to mutate
that allowlist.

An encrypted room protects traffic between Matrix devices and the homeserver,
but inference requires application-side decryption. The following data is
plaintext at rest from the application's point of view:

- message and reasoning text;
- downloaded and generated media;
- extracted document text, chunks, embeddings, and summaries;
- tool results and persistent bash files;
- Matrix adapter metadata and delivery history.

Use host/volume encryption, encrypted backups, least-privilege filesystem
ownership, and restricted operator access. Do not advertise this deployment as
end-to-end encrypted through the model/provider boundary.

## Secrets

- The single-container deployment stores `MATRIX_ENCRYPTION_SECRET` and either
  `MATRIX_ACCESS_TOKEN` or `MATRIX_PASSWORD` as direct values in an owner-only
  `.env` or masked Unraid fields. This matches `ai-tg-bot`'s simple
  configuration model, but privileged Docker operators can see environment
  values with container inspection and `docker compose config` can render
  them. Never paste either output into logs or support requests.
- Never commit `.env`, `/app/data`, a crypto store, or a SQLite database. The
  supplied deployment intentionally has one simple configuration surface and
  one application-data root.
- In login mode, the password remains in deployment configuration but is never
  written to `/app/data`. The generated access token and device ID are cached
  owner-only in `/app/data/matrix/session.json`. Protect both the configuration
  and appdata backup. The password fields may be cleared after the initial
  session is cached. Revoke exposed tokens and change an exposed password.
- Keep Codex credentials in `/app/data/codex` and never mount a developer's
  host-wide Codex home into the container.
- Tavily and embedding-provider keys are independent secrets with no Matrix
  privileges.
- The bot removes Matrix, provider, Docling, and database credentials from the
  direct environment passed to `codex app-server`. This prevents ordinary child
  environment inheritance, but it is defense in depth: processes sharing a UID
  are not a hard isolation boundary on every Linux host.
- Logs must redact access tokens, encryption and recovery secrets,
  authorization headers, media decryption keys, provider keys, and database
  credentials.

`MATRIX_ENCRYPTION_SECRET` protects and recovers the account's Matrix secret
storage and cross-signing identity. It is not a static replacement for the
crypto store: Megolm room sessions change as encrypted conversations continue.
Back up `/app/data/matrix` when historical decryption matters. Treat the secret
and crypto backup as complementary recovery material.

## Dependency audit boundary

The pinned Matrix SDK release still depends on the deprecated `request` family.
Package overrides keep its compatible `form-data` and `qs` dependencies on
patched releases, and CI rejects high or critical production advisories. The
remaining `npm audit` findings are moderate advisories in that SDK dependency
chain with no compatible upstream fix. Treat them as upgrade debt and rerun the
Matrix protocol, E2EE, media, and restart suites before changing the pinned SDK.

## Abuse controls

Unknown invitations are declined, group rooms are rejected, and membership
changes cancel active work. Files are limited to 20 MiB while streaming bytes,
not only after download. At most ten output artifacts are delivered for one
turn. Per-conversation serialization and a four-conversation global limit bound
concurrency; tool and inference timeouts bound abandoned work.

Persistent bash is scoped per core conversation. Treat its files and network
access as untrusted model output, preserve the core sandbox/private-network
controls, and never run the bot container as root.

## Incident response

1. Stop the bot without deleting volumes.
2. Revoke the Matrix access token, change the password when login-mode
   credentials were exposed, and rotate affected provider credentials.
3. Preserve redacted logs and delivery/event IDs for replay analysis.
4. Decide whether the crypto store and plaintext application data were exposed;
   rotate the Matrix device if necessary.
5. Issue and verify a replacement device token, recover it with the configured
   encryption secret, and restore only known-good state. Ensure the old
   process/device cannot sync before resuming.
