# Testing

## Local and CI suites

```sh
npm ci
npm run check
npm test
npm run test:deployment
npm run build
docker build -t ai-matrix-bot:test .
```

CI also asserts that the base Compose model contains only the bot service and
validates both the base and Postgres Compose models. Unit tests must not use a
real Matrix token, provider key, network, or the operator's Codex home.

High-value deterministic coverage includes:

- owner bootstrap, allow/deny/list authorization, unknown invitation decline,
  exact two-member enforcement, and cancellation after membership expansion;
- event-ID/source-key replay, sync restart, deterministic transaction IDs,
  crash recovery, and one active worker per conversation;
- main timeline/thread mapping, user-created thread fallback, replies, queued
  versus in-flight edits, sibling forks, retry, stop, and compaction;
- one-second replacement coalescing, streaming-disabled behavior, authoritative
  final replacement, block-aware splitting, and preserved Matrix relations;
- authenticated media fetch, encrypted descriptors, streaming 20 MiB limits,
  sanitized filenames, hashes, upload relations, and the ten-artifact cap;
- English/Russian preferences, timezone offsets, Markdown/plaintext and safe
  HTML rendering, unsupported events, and peer-notice filtering.

Core protocol, storage, retrieval, tool, package, and authenticated Codex smoke
tests live in `codex-core`; the Matrix suite uses its `/testing` exports instead
of duplicating the app-server implementation.

## Disposable homeserver acceptance

Before a release, run a disposable Matrix homeserver with a bot account and two
client accounts. Exercise an encrypted DM, unencrypted DM, encrypted file,
restart/decryption, event replay, user-created thread, fork, and attempted third
member. Stop the bot between input and delivery once to verify recovery.

Docker must be running. The repository script starts an isolated pinned Synapse
container, provisions the accounts, runs the scenarios, and removes its test
state afterward:

```sh
npm run test:integration:matrix
```

The final live smoke uses the dedicated production-like account on the owner's
server. It must confirm `/whoami`, device verification, an old-message decrypt,
one streamed answer, one file round trip, one thread, `!users`, and clean restart
without duplicate delivery. Do not use an admin token for the smoke.
