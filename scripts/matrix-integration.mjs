import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import MatrixBotSdk from "@vector-im/matrix-bot-sdk";
import { encryptMedia } from "../dist/matrix/mediaCrypto.js";
import { deterministicTransactionId } from "../dist/matrix/relations.js";

const {
  MatrixClient,
  RustSdkCryptoStorageProvider,
  SimpleFsStorageProvider,
} = MatrixBotSdk;
const SQLITE_CRYPTO_STORE = 0;

const execFile = promisify(execFileCallback);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const image = process.env.MATRIX_INTEGRATION_SYNAPSE_IMAGE ?? "matrixdotorg/synapse:v1.153.0";
const timeoutMs = 45_000;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const fakeCodexSource = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "integration-thread" } } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "integration-turn" } } });
    if (process.env.FAKE_CODEX_ACTIVE_MARKER) writeFileSync(process.env.FAKE_CODEX_ACTIVE_MARKER, "active\\n");
  }
});
`;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitUntil(label, predicate, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError}` : ""}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function databaseValue(databasePath, query, ...parameters) {
  const database = new DatabaseSync(databasePath);
  try {
    return database.prepare(query).get(...parameters);
  } finally {
    database.close();
  }
}

function databaseValues(databasePath, query, ...parameters) {
  const database = new DatabaseSync(databasePath);
  try {
    return database.prepare(query).all(...parameters);
  } finally {
    database.close();
  }
}

function updateDatabase(databasePath, action) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    return action(database);
  } finally {
    database.close();
  }
}

function relation(event) {
  const value = event.content?.["m.relates_to"];
  return value && typeof value === "object" ? value : {};
}

function replyTarget(event) {
  return relation(event)["m.in_reply_to"]?.event_id;
}

async function writeFakeCodex(root) {
  const executable = path.join(root, "fake-codex.mjs");
  await writeFile(executable, fakeCodexSource, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function sendWithTransaction(homeserverUrl, accessToken, roomId, type, transactionId, content) {
  const endpoint = `${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`
    + `/send/${encodeURIComponent(type)}/${encodeURIComponent(transactionId)}`;
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(content),
  });
  if (!response.ok) throw new Error(`Matrix transaction send failed: ${response.status} ${await response.text()}`);
  const result = await response.json();
  assert(typeof result.event_id === "string", "Matrix transaction send returned no event_id");
  return result.event_id;
}

async function register(container, username, password) {
  await execFile("docker", [
    "exec", container, "register_new_matrix_user", "-c", "/data/homeserver.yaml",
    "http://localhost:8008", "-u", username, "-p", password, "--no-admin",
  ]);
}

async function login(homeserverUrl, username, password, deviceId) {
  const response = await fetch(`${homeserverUrl}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: username },
      password,
      device_id: deviceId,
      initial_device_display_name: deviceId,
    }),
  });
  if (!response.ok) throw new Error(`Matrix login failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function sdkClient(homeserverUrl, loginResult, root, name, encrypted = true) {
  const storage = new SimpleFsStorageProvider(path.join(root, `${name}-sync.json`));
  const crypto = encrypted
    ? new RustSdkCryptoStorageProvider(path.join(root, `${name}-crypto`), SQLITE_CRYPTO_STORE)
    : undefined;
  const client = new MatrixClient(homeserverUrl, loginResult.access_token, storage, crypto);
  await client.start();
  await sleep(750);
  return client;
}

function waitForMessage(client, roomId, predicate, timeout = timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Timed out waiting for Matrix message")), timeout);
    const handler = (eventRoomId, event) => {
      if (eventRoomId === roomId && predicate(event)) finish(undefined, event);
    };
    client.on("room.message", handler);
    function finish(error, event) {
      clearTimeout(timer);
      client.off("room.message", handler);
      if (error) reject(error);
      else resolve(event);
    }
  });
}

function startBot(homeserverUrl, loginResult, root, options = {}) {
  const child = spawn(process.execPath, [path.join(repository, "dist/index.js")], {
    cwd: repository,
    env: {
      ...process.env,
      MATRIX_HOMESERVER_URL: homeserverUrl,
      MATRIX_BOT_USER_ID: loginResult.user_id,
      MATRIX_OWNER_ID: "@owner:localhost",
      MATRIX_ACCESS_TOKEN: loginResult.access_token,
      MATRIX_DEVICE_ID: loginResult.device_id,
      MATRIX_STORAGE_PATH: path.join(root, "bot-sync.json"),
      MATRIX_CRYPTO_PATH: path.join(root, "bot-crypto"),
      MATRIX_DATABASE_PATH: path.join(root, "matrix-adapter.sqlite"),
      MATRIX_BATCH_WINDOW_MS: String(options.batchWindowMs ?? 750),
      CORE_DATABASE_URL: `file:${path.join(root, "codex-core.sqlite")}`,
      FILE_ROOT: path.join(root, "files"),
      BASH_ROOT: path.join(root, "bash"),
      CODEX_PATH: options.codexPath,
      CODEX_WORKING_DIRECTORY: repository,
      SYSTEM_PROMPT_PATH: path.join(repository, "system_prompt.md"),
      FAKE_CODEX_ACTIVE_MARKER: path.join(root, "fake-codex-active"),
      DOCLING_URL: "",
      TAVILY_API_KEY: "",
      OPENROUTER_API_KEY: "",
      LOG_LEVEL: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { logs += String(chunk); });
  const ready = waitUntil("bot readiness", async () => {
    if (child.exitCode !== null) throw new Error(`bot exited ${child.exitCode}: ${logs}`);
    return logs.includes("AI Matrix bot is ready");
  });
  return { child, ready, logs: () => logs };
}

async function stopBot(bot) {
  if (!bot || bot.child.exitCode !== null) return;
  bot.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => bot.child.once("exit", resolve)),
    sleep(10_000).then(() => { bot.child.kill("SIGKILL"); }),
  ]);
}

async function crashBot(bot) {
  if (!bot || bot.child.exitCode !== null) return;
  bot.child.kill("SIGKILL");
  await Promise.race([
    new Promise((resolve) => bot.child.once("exit", resolve)),
    sleep(10_000).then(() => { throw new Error("Bot did not exit after SIGKILL"); }),
  ]);
}

async function main() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ai-matrix-integration-"));
  const synapseData = path.join(temporary, "synapse");
  const adapterDatabase = path.join(temporary, "matrix-adapter.sqlite");
  const coreDatabase = path.join(temporary, "codex-core.sqlite");
  const botSyncPath = path.join(temporary, "bot-sync.json");
  const fileRoot = path.join(temporary, "files");
  const fakeCodexMarker = path.join(temporary, "fake-codex-active");
  const container = `ai-matrix-synapse-${process.pid}`;
  const port = await freePort();
  const homeserverUrl = `http://127.0.0.1:${port}`;
  let bot;
  let owner;
  let outsider;
  try {
    await mkdir(synapseData, { recursive: true });
    const fakeCodex = await writeFakeCodex(temporary);
    await execFile("docker", ["pull", image]);
    await execFile("docker", [
      "run", "--rm", "-v", `${synapseData}:/data`,
      "-e", "SYNAPSE_SERVER_NAME=localhost", "-e", "SYNAPSE_REPORT_STATS=no", image, "generate",
    ]);
    await execFile("docker", [
      "run", "-d", "--rm", "--name", container, "-v", `${synapseData}:/data`,
      "-p", `127.0.0.1:${port}:8008`, image,
    ]);
    await waitUntil("Synapse", async () => (await fetch(`${homeserverUrl}/_matrix/client/versions`)).ok);
    await register(container, "owner", "owner-password");
    await register(container, "bot", "bot-password");
    await register(container, "outsider", "outsider-password");
    const ownerLogin = await login(homeserverUrl, "owner", "owner-password", "OWNER_DEVICE");
    const botLogin = await login(homeserverUrl, "bot", "bot-password", "BOT_DEVICE");
    const outsiderLogin = await login(homeserverUrl, "outsider", "outsider-password", "OUTSIDER_DEVICE");
    owner = await sdkClient(homeserverUrl, ownerLogin, temporary, "owner");
    outsider = await sdkClient(homeserverUrl, outsiderLogin, temporary, "outsider", false);
    const ownerMessages = [];
    owner.on("room.message", (roomId, event) => ownerMessages.push({ roomId, event }));
    bot = startBot(homeserverUrl, botLogin, temporary, { codexPath: fakeCodex });
    await bot.ready;

    const unencryptedRoom = await owner.createRoom({
      preset: "private_chat", is_direct: true, invite: [botLogin.user_id], name: "Unencrypted integration DM",
    });
    await waitUntil("bot joining unencrypted DM", async () => (await owner.getJoinedRoomMembers(unencryptedRoom)).includes(botLogin.user_id));
    const usersReply = waitForMessage(owner, unencryptedRoom, (event) => event.sender === botLogin.user_id
      && String(event.content?.body ?? "").includes("@owner:localhost"));
    await owner.sendText(unencryptedRoom, "!users");
    await usersReply;

    const threadedReply = waitForMessage(owner, unencryptedRoom, (event) => event.sender === botLogin.user_id
      && event.content?.["m.relates_to"]?.rel_type === "m.thread");
    await owner.sendText(unencryptedRoom, "!fork Integration fork");
    await threadedReply;

    let mainCompactEventId = "$pending-main-compact";
    const mainCompactReply = waitForMessage(owner, unencryptedRoom, (event) => event.sender === botLogin.user_id
      && replyTarget(event) === mainCompactEventId);
    mainCompactEventId = await owner.sendText(unencryptedRoom, "!compact");
    await mainCompactReply;
    const mainConversation = await waitUntil("main conversation mapping", () => databaseValue(
      adapterDatabase,
      "SELECT conversation_id, root_event_id FROM matrix_conversations WHERE room_id = ? AND thread_root = 'main'",
      unencryptedRoom,
    ));

    const fallbackMessageId = `integration-fallback-${process.pid}`;
    const fallbackMappingId = `$integration-fallback-${process.pid}`;
    const fallbackTimestamp = Date.now() - 5_000;
    updateDatabase(coreDatabase, (database) => {
      database.prepare(`
        INSERT INTO codex_messages
          (id, conversation_id, role, kind, text_plain, content_json, source_key, reasoning_markdown,
           attachment_ids_json, tokens_estimate, created_at)
        VALUES (?, ?, 'assistant', 'text', ?, '{}', NULL, NULL, '[]', 1, ?)
      `).run(fallbackMessageId, mainConversation.conversation_id, "Latest mapped main-timeline answer", fallbackTimestamp);
    });
    updateDatabase(adapterDatabase, (database) => {
      database.prepare(`
        INSERT INTO matrix_event_mappings
          (event_id, room_id, thread_root, conversation_id, core_message_id, direction, origin_server_ts, created_at)
        VALUES (?, ?, 'main', ?, ?, 'outbound', ?, ?)
      `).run(
        fallbackMappingId,
        unencryptedRoom,
        mainConversation.conversation_id,
        fallbackMessageId,
        fallbackTimestamp,
        fallbackTimestamp,
      );
    });

    const userThreadRoot = await owner.sendMessage(unencryptedRoom, {
      msgtype: "m.notice",
      body: "User-created integration thread",
    });
    let userThreadCommandId = "$pending-user-thread-command";
    const userThreadReply = waitForMessage(owner, unencryptedRoom, (event) => {
      const eventRelation = relation(event);
      return event.sender === botLogin.user_id
        && eventRelation.rel_type === "m.thread"
        && eventRelation.event_id === userThreadRoot
        && replyTarget(event) === userThreadCommandId;
    });
    userThreadCommandId = await owner.sendMessage(unencryptedRoom, {
      msgtype: "m.text",
      body: "!compact",
      "m.relates_to": {
        rel_type: "m.thread",
        event_id: userThreadRoot,
        is_falling_back: true,
        "m.in_reply_to": { event_id: userThreadRoot },
      },
    });
    await userThreadReply;
    const userThreadConversation = await waitUntil("user-created thread mapping", () => databaseValue(
      adapterDatabase,
      "SELECT conversation_id, root_event_id FROM matrix_conversations WHERE room_id = ? AND thread_root = ?",
      unencryptedRoom,
      userThreadRoot,
    ));
    assert(userThreadConversation.root_event_id === userThreadRoot, "User-created thread root was not persisted");
    assert(userThreadConversation.conversation_id !== mainConversation.conversation_id, "User-created thread reused the main conversation");
    const userThreadCore = databaseValue(
      coreDatabase,
      "SELECT parent_conversation_id, fork_point_message_id FROM codex_conversations WHERE id = ?",
      userThreadConversation.conversation_id,
    );
    assert(userThreadCore?.parent_conversation_id === mainConversation.conversation_id, "User-created Matrix thread was not forked from main");
    assert(userThreadCore?.fork_point_message_id === fallbackMessageId, "User-created thread did not use the latest main-timeline mapping fallback");

    const replaySyncSnapshot = await waitUntil("pre-replay sync token", async () => {
      const snapshot = await readJson(botSyncPath);
      return typeof snapshot.syncToken === "string" ? snapshot : undefined;
    });
    const replayObservedFrom = ownerMessages.length;
    let replayEventId = "$pending-replay-event";
    const replayReply = waitForMessage(owner, unencryptedRoom, (event) => event.sender === botLogin.user_id
      && replyTarget(event) === replayEventId);
    replayEventId = await owner.sendText(unencryptedRoom, "!users");
    await replayReply;
    const replayTransactionId = deterministicTransactionId(`matrix:${replayEventId}`, "command");
    await waitUntil("first replay-test delivery", () => {
      const inbox = databaseValue(adapterDatabase, "SELECT state FROM matrix_inbox WHERE event_id = ?", replayEventId);
      const outbox = databaseValue(adapterDatabase, "SELECT state FROM matrix_outbox WHERE transaction_id = ?", replayTransactionId);
      return inbox?.state === "done" && outbox?.state === "sent";
    });
    await stopBot(bot);
    bot = undefined;
    await writeFile(botSyncPath, `${JSON.stringify(replaySyncSnapshot, null, 2)}\n`, { mode: 0o600 });
    bot = startBot(homeserverUrl, botLogin, temporary, { codexPath: fakeCodex });
    await bot.ready;
    await waitUntil("replayed durable sync cycle", async () => (await readJson(botSyncPath)).syncToken !== replaySyncSnapshot.syncToken);
    await sleep(2_000);
    const replayVisibleIds = new Set(ownerMessages.slice(replayObservedFrom)
      .filter(({ roomId, event }) => roomId === unencryptedRoom
        && event.sender === botLogin.user_id
        && replyTarget(event) === replayEventId)
      .map(({ event }) => event.event_id));
    assert(replayVisibleIds.size === 1, `Replayed inbound event produced ${replayVisibleIds.size} visible replies`);
    assert(databaseValue(adapterDatabase, "SELECT COUNT(*) AS count FROM matrix_inbox WHERE event_id = ?", replayEventId)?.count === 1,
      "Replayed event duplicated the durable inbox row");
    assert(databaseValue(adapterDatabase, "SELECT COUNT(*) AS count FROM matrix_outbox WHERE transaction_id = ?", replayTransactionId)?.count === 1,
      "Replayed event duplicated the deterministic outbox row");

    const encryptedRoom = await owner.createRoom({
      preset: "private_chat",
      is_direct: true,
      invite: [botLogin.user_id],
      name: "Encrypted integration DM",
      initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
    });
    await waitUntil("bot joining encrypted DM", async () => (await owner.getJoinedRoomMembers(encryptedRoom)).includes(botLogin.user_id));
    await waitUntil("owner crypto seeing encryption", () => owner.crypto.isRoomEncrypted(encryptedRoom));
    await sleep(1_500);
    const encryptedReply = waitForMessage(owner, encryptedRoom, (event) => event.sender === botLogin.user_id
      && String(event.content?.body ?? "").includes("@owner:localhost"));
    await owner.sendText(encryptedRoom, "!users");
    await encryptedReply;

    const inboundMediaBytes = Buffer.from("encrypted Matrix integration attachment\n", "utf8");
    const inboundMedia = encryptMedia(inboundMediaBytes);
    const inboundMediaUrl = await owner.uploadContent(
      inboundMedia.ciphertext,
      "application/octet-stream",
      "encrypted-integration.txt",
    );
    let inboundMediaEventId = "$pending-encrypted-media";
    const mediaPlaceholder = waitForMessage(owner, encryptedRoom, (event) => event.sender === botLogin.user_id
      && event.content?.msgtype === "m.notice"
      && replyTarget(event) === inboundMediaEventId);
    inboundMediaEventId = await owner.sendMessage(encryptedRoom, {
      msgtype: "m.file",
      body: "encrypted-integration.txt",
      file: { ...inboundMedia.file, url: inboundMediaUrl },
      info: { mimetype: "text/plain", size: inboundMediaBytes.byteLength },
    });
    await mediaPlaceholder;
    const inboundFile = await waitUntil("encrypted media persistence", () => databaseValues(
      coreDatabase,
      "SELECT id, size, sha256, blob_key, source_json FROM codex_files",
    ).find((row) => {
      try {
        return JSON.parse(row.source_json ?? "null")?.id === inboundMediaEventId;
      } catch {
        return false;
      }
    }));
    const inboundSource = JSON.parse(inboundFile.source_json);
    assert(inboundSource.metadata?.encrypted === true, "Encrypted media source was not marked encrypted");
    assert(inboundFile.size === inboundMediaBytes.byteLength, "Encrypted media plaintext size was not preserved");
    assert(inboundFile.sha256 === createHash("sha256").update(inboundMediaBytes).digest("hex"), "Encrypted media plaintext hash mismatch");
    const storedInboundBytes = await readFile(path.join(fileRoot, inboundFile.blob_key));
    assert(storedInboundBytes.equals(inboundMediaBytes), "Encrypted media did not round-trip to the plaintext blob store");
    await waitUntil("fake Codex turn activation", async () => {
      try {
        return (await readFile(fakeCodexMarker, "utf8")).includes("active");
      } catch {
        return false;
      }
    });
    await sleep(100);
    let stopMediaEventId = "$pending-media-stop";
    const stopMediaReply = waitForMessage(owner, encryptedRoom, (event) => event.sender === botLogin.user_id
      && replyTarget(event) === stopMediaEventId);
    stopMediaEventId = await owner.sendText(encryptedRoom, "!stop");
    await stopMediaReply;
    await waitUntil("cancelled encrypted media turn", () => databaseValue(
      adapterDatabase,
      "SELECT state FROM matrix_inbox WHERE event_id = ?",
      inboundMediaEventId,
    )?.state === "done");

    await stopBot(bot);
    bot = undefined;
    let offlineReplies = 0;
    let offlineEventId = "$pending-offline-event";
    const offlineReply = waitForMessage(owner, encryptedRoom, (event) => {
      const replyTo = event.content?.["m.relates_to"]?.["m.in_reply_to"]?.event_id;
      if (event.sender === botLogin.user_id && replyTo === offlineEventId) {
        offlineReplies += 1;
        return true;
      }
      return false;
    });
    offlineEventId = await owner.sendText(encryptedRoom, "!users");
    await sleep(500);
    bot = startBot(homeserverUrl, botLogin, temporary, { codexPath: fakeCodex });
    await bot.ready;
    await offlineReply;
    await sleep(1_000);
    if (offlineReplies !== 1) throw new Error(`offline encrypted event produced ${offlineReplies} replies`);

    await stopBot(bot);
    bot = undefined;
    bot = startBot(homeserverUrl, botLogin, temporary, { codexPath: fakeCodex, batchWindowMs: 10_000 });
    await bot.ready;
    const crashObservedFrom = ownerMessages.length;
    const crashEventId = await owner.sendText(unencryptedRoom, "!users");
    await waitUntil("queued pre-crash input", () => databaseValue(
      adapterDatabase,
      "SELECT state FROM matrix_inbox WHERE event_id = ?",
      crashEventId,
    )?.state === "queued");
    await crashBot(bot);
    bot = undefined;

    const crashSourceKey = `matrix:${crashEventId}`;
    const crashTransactionId = deterministicTransactionId(crashSourceKey, "command");
    const crashContent = {
      msgtype: "m.text",
      body: "Recovered durable command delivery.",
      "m.relates_to": { "m.in_reply_to": { event_id: crashEventId } },
    };
    const crashTimestamp = Date.now();
    updateDatabase(adapterDatabase, (database) => {
      database.prepare("UPDATE matrix_inbox SET state = 'processing', updated_at = ? WHERE event_id = ?")
        .run(crashTimestamp, crashEventId);
      database.prepare(`
        INSERT INTO matrix_outbox
          (job_id, transaction_id, room_id, event_type, content_json, state, attempts, event_id, error, created_at, updated_at)
        VALUES (?, ?, ?, 'm.room.message', ?, 'sending', 1, NULL, NULL, ?, ?)
      `).run(
        randomUUID(),
        crashTransactionId,
        unencryptedRoom,
        JSON.stringify(crashContent),
        crashTimestamp,
        crashTimestamp,
      );
    });
    const ambiguousDeliveryEventId = await sendWithTransaction(
      homeserverUrl,
      botLogin.access_token,
      unencryptedRoom,
      "m.room.message",
      crashTransactionId,
      crashContent,
    );
    await waitUntil("ambiguous pre-crash delivery", () => ownerMessages.slice(crashObservedFrom)
      .some(({ roomId, event }) => roomId === unencryptedRoom
        && event.event_id === ambiguousDeliveryEventId
        && replyTarget(event) === crashEventId));
    bot = startBot(homeserverUrl, botLogin, temporary, { codexPath: fakeCodex });
    await bot.ready;
    await waitUntil("crash-recovered input completion", () => databaseValue(
      adapterDatabase,
      "SELECT state FROM matrix_inbox WHERE event_id = ?",
      crashEventId,
    )?.state === "done");
    const recoveredOutbox = databaseValue(
      adapterDatabase,
      "SELECT state, attempts, event_id FROM matrix_outbox WHERE transaction_id = ?",
      crashTransactionId,
    );
    assert(recoveredOutbox?.state === "sent", "Crash-recovered outbox row was not sent");
    assert(recoveredOutbox.event_id === ambiguousDeliveryEventId, "Retry did not resolve to the original Matrix transaction event");
    assert(recoveredOutbox.attempts >= 2, "Crash-recovered outbox row was not retried");
    const crashVisibleIds = new Set(ownerMessages.slice(crashObservedFrom)
      .filter(({ roomId, event }) => roomId === unencryptedRoom
        && event.sender === botLogin.user_id
        && replyTarget(event) === crashEventId)
      .map(({ event }) => event.event_id));
    assert(crashVisibleIds.size === 1, `Crash recovery produced ${crashVisibleIds.size} visible deliveries`);

    await owner.inviteUser(outsiderLogin.user_id, encryptedRoom);
    await waitUntil("bot leaving expanded room", async () => !(await owner.getJoinedRoomMembers(encryptedRoom)).includes(botLogin.user_id));

    const unknownRoom = await outsider.createRoom({ preset: "private_chat", invite: [botLogin.user_id], name: "Unknown invite" });
    await waitUntil("unknown invite rejection", async () => {
      const membership = await outsider.getRoomStateEvent(unknownRoom, "m.room.member", botLogin.user_id).catch(() => undefined);
      return membership?.membership === "leave";
    });

    process.stdout.write(JSON.stringify({
      ok: true,
      synapseImage: image,
      unencryptedDm: true,
      encryptedDm: true,
      encryptedRestartDecryption: true,
      encryptedMediaRoundTrip: true,
      inboundReplayDeduplicated: true,
      nativeForkThread: true,
      userCreatedThreadMapped: true,
      crashDeliveryRecovered: true,
      groupRejected: true,
      unknownInviteRejected: true,
    }, null, 2) + "\n");
  } catch (error) {
    if (bot) process.stderr.write(bot.logs());
    throw error;
  } finally {
    await stopBot(bot);
    owner?.stop();
    outsider?.stop();
    await execFile("docker", ["stop", container]).catch(() => undefined);
    // The pinned SDK's stop() is synchronous while its long-poll loop unwinds
    // asynchronously after the homeserver socket closes. Give the Rust crypto
    // runtime time to release its Tokio work before Node tears down N-API.
    await sleep(3_000);
    // Synapse writes its bind-mounted database as a container UID. Remove that
    // subdirectory as root in a one-shot container so Linux CI can then remove
    // the caller-owned temporary directory without an EACCES cleanup failure.
    await execFile("docker", [
      "run", "--rm", "--user", "0:0", "-v", `${temporary}:/cleanup`,
      "--entrypoint", "/bin/rm", image, "-rf", "/cleanup/synapse",
    ]).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  },
);
