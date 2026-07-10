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

- Use Docker/Kubernetes secret files for the Matrix access token and recovery
  key. Never commit `secrets/`, `.env`, a crypto store, or a SQLite database.
- Do not store the Matrix password. Revoke the access token if it appears in
  logs or shell history.
- Keep Codex credentials in the dedicated `codex-home` volume and never mount a
  developer's host-wide Codex home into the container.
- Tavily and embedding-provider keys are independent secrets with no Matrix
  privileges.
- Logs must redact access tokens, recovery keys, authorization headers, media
  decryption keys, provider keys, and database credentials.

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
2. Revoke the Matrix access token and affected provider credentials.
3. Preserve redacted logs and delivery/event IDs for replay analysis.
4. Decide whether the crypto store and plaintext application data were exposed;
   rotate the Matrix device if necessary.
5. Bootstrap and verify a replacement device, then restore only known-good
   state. Ensure the old process/device cannot sync before resuming.
