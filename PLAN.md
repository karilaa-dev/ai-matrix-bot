# Architecture and implementation map

## Repository boundary

`ai-matrix-bot` owns Matrix authentication, authorization, sync, room/thread
mapping, rendering, media transport, delivery receipts, and operational state.
It does not implement Codex inference. `@karilaa-dev/codex-core` owns inference,
tools, attachments, retrieval, compaction, semantic persistence, and the
transport-neutral event stream.

The dependency boundary is deliberate: Matrix events are normalized into core
actors/messages and core progress/results are rendered back into Matrix events.
Neither package imports the other package's platform types.

## Runtime data flow

1. The single durable sync loop receives an event and records its Matrix event
   ID before advancing the sync token.
2. Membership and the persisted allowlist are checked. Rooms must contain only
   the bot and one permitted peer.
3. The adapter maps `(room ID, main)` or `(room ID, thread root)` to a core
   conversation and batches adjacent text/media for 750 ms.
4. Core is invoked with a stable `matrix:<event-id>` source key. Work is
   serialized per conversation with four conversations allowed globally.
5. One `m.notice` placeholder is updated at most once per second. The terminal
   result always replaces the draft and artifacts are sent separately.
6. Inbound-event and outbound-delivery records make restart/replay safe. Matrix
   transaction IDs are derived deterministically from the logical delivery.

## Persistence ownership

- Matrix adapter DB: allowlist/preferences, room/conversation links, inbound
  events, sync state, outbound jobs, and delivery receipts.
- Matrix state under `/app/data/matrix`: cached access token/device, sync
  cursor, and E2EE crypto material. It is single-writer state and must be
  restored with the adapter DB.
- Core DB: conversations, messages, files, chunks, summaries, embeddings, and
  search indexes in `codex_*` tables.
- Application data: decrypted uploads, generated artifacts, and per-conversation
  bash workspaces.
- Codex home: Docker-owned Codex login and configuration below `/app/data`.

SQLite is the self-contained default. The Postgres override moves the core DB
to Postgres while retaining local adapter state next to the Matrix crypto store.
The base Compose deployment mounts one `/app/data` volume. Matrix
authentication accepts either an existing access token or login/password; the
latter is exchanged once for an owner-only cached device session.

## Stable interfaces

Core is consumed only through its explicit exports (`.`, `/app-server`,
`/providers`, `/storage`, `/storage/sqlite`, `/tools`, and `/testing`). The bot
uses `createCodexCore`, `startTurn`, `ingestAttachment`,
`compactConversation`, `createConversation`, and `forkConversation`; consumer
deep imports are unsupported.

The adapter preserves Matrix relations separately from inference text. Native
thread roots select conversations, rich-reply fallback quotations are removed
before inference, and generated relations are reapplied during delivery.

## v0.1.0 acceptance gates

- Node 24 typecheck, unit/integration tests, production build, image build, and
  the single-container and Postgres Compose models pass in CI.
- A clean install resolves the public `codex-core` v0.1.0 Git tag, not a local
  path, and the lockfile pins its commit.
- Encrypted and unencrypted DMs survive a restart without duplicate inference
  or delivery; group membership is rejected and unknown invitations declined.
- Main timelines, user-created threads, replies, edits, forks, batching,
  streaming replacements, cancellation, compaction, retry, and media limits
  have deterministic tests.
- A disposable homeserver run covers two client accounts and encrypted media;
  a final live smoke uses the owner's server and dedicated bot account.
- The application, Matrix, and Codex persistent state groups are backed up and
  restored together, and the
  bot resumes decryption, sync, history, files, bash state, and Codex auth.
- The tagged core package includes a compiling `ai-tg-bot` legacy-persistence
  adapter and migration guide checked against revision `7eedd5f`.
