import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStorageKey } from "@matrix-org/matrix-sdk-crypto-nodejs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const accountData = new Map<string, unknown>();
  const state = {
    recoveryAvailable: false,
    crossSigningExists: false,
    accountData,
    getUserId: vi.fn(async () => "@bot:example.org"),
    prepare: vi.fn(async () => undefined),
    isRecoveryAvailable: vi.fn(async () => state.recoveryAvailable),
    confirmIdentityWithRecoveryKey: vi.fn(async () => undefined),
    createIdentity: vi.fn(async () => {
      state.recoveryAvailable = true;
      return "generated-recovery-key";
    }),
    importRoomKeys: vi.fn(async () => undefined),
    setAccountData: vi.fn(async (eventType: string, content: unknown) => {
      accountData.set(eventType, content);
    }),
    getAccountData: vi.fn(async (eventType: string) => {
      if (accountData.has(eventType)) return accountData.get(eventType);
      throw Object.assign(new Error("M_NOT_FOUND"), { errcode: "M_NOT_FOUND", statusCode: 404 });
    }),
    doRequest: vi.fn(async () => state.crossSigningExists
      ? {
          master_keys: { "@bot:example.org": { user_id: "@bot:example.org" } },
          self_signing_keys: {},
          user_signing_keys: {},
        }
      : { master_keys: {}, self_signing_keys: {}, user_signing_keys: {} }),
  };

  class MatrixClient {
    readonly crypto = {
      prepare: state.prepare,
      isRecoveryAvailable: state.isRecoveryAvailable,
      confirmIdentityWithRecoveryKey: state.confirmIdentityWithRecoveryKey,
      createIdentity: state.createIdentity,
      importRoomKeys: state.importRoomKeys,
    };

    readonly storageProvider = {
      getSyncToken: vi.fn(() => null),
      setSyncToken: vi.fn(),
    };

    getUserId = state.getUserId;
    setAccountData = state.setAccountData;
    getAccountData = state.getAccountData;
    doRequest = state.doRequest;
  }

  return {
    state,
    module: {
      MatrixClient,
      RustSdkCryptoStorageProvider: class {},
      SimpleFsStorageProvider: class {},
    },
  };
});

vi.mock("@vector-im/matrix-bot-sdk", () => ({ default: sdk.module }));

import type { Logger } from "../src/logging.js";
import { DedicatedMatrixClient } from "../src/matrix/client.js";

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const temporaryDirectories: string[] = [];
const ENCRYPTION_SECRET = "portable-matrix-encryption-secret-32";
const DIFFERENT_ENCRYPTION_SECRET = "different-portable-encryption-secret-32";

function seedSecretStorage(secret = ENCRYPTION_SECRET): string {
  const key = SecretStorageKey.createFromPassphrase(secret);
  sdk.state.accountData.set(key.eventType(), JSON.parse(key.accountDataContent()) as unknown);
  sdk.state.accountData.set("m.secret_storage.default_key", { key: key.keyId() });
  return key.keyId();
}

function createClient(): DedicatedMatrixClient {
  const directory = mkdtempSync(join(tmpdir(), "matrix-crypto-identity-"));
  temporaryDirectories.push(directory);
  return new DedicatedMatrixClient({
    homeserverUrl: "https://matrix.example.org",
    ownerId: "@owner:example.org",
    accessToken: "test-access-token",
    deviceId: "AI_MATRIX_BOT",
    storagePath: join(directory, "sync.json"),
    cryptoPath: join(directory, "crypto"),
    databasePath: join(directory, "adapter.sqlite"),
    globalConcurrency: 4,
    batchWindowMs: 750,
    maxEventBytes: 60_000,
  }, logger);
}

beforeEach(() => {
  sdk.state.recoveryAvailable = false;
  sdk.state.crossSigningExists = false;
  sdk.state.accountData.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("portable Matrix encryption identity", () => {
  it("confirms an existing recovery identity with the configured secret", async () => {
    sdk.state.recoveryAvailable = true;
    seedSecretStorage();
    const client = createClient();

    await expect(client.initializeCryptoIdentity(ENCRYPTION_SECRET)).resolves.toEqual({
      created: false,
    });

    expect(sdk.state.confirmIdentityWithRecoveryKey).toHaveBeenCalledOnce();
    expect(sdk.state.confirmIdentityWithRecoveryKey).toHaveBeenCalledWith(ENCRYPTION_SECRET);
    expect(sdk.state.createIdentity).not.toHaveBeenCalled();
    expect(sdk.state.setAccountData).not.toHaveBeenCalled();
  });

  it("creates passphrase-backed secret storage before creating a fresh identity", async () => {
    const client = createClient();

    await client.initializeCryptoIdentity(ENCRYPTION_SECRET);

    const accountDataCalls = sdk.state.setAccountData.mock.calls;
    expect(accountDataCalls).toHaveLength(2);
    expect(accountDataCalls[0]?.[0]).toMatch(/^m\.secret_storage\.key\./);
    expect(accountDataCalls[0]?.[1]).toMatchObject({
      algorithm: "m.secret_storage.v1.aes-hmac-sha2",
      passphrase: {
        algorithm: "m.pbkdf2",
      },
    });
    expect(accountDataCalls[1]).toEqual([
      "m.secret_storage.default_key",
      { key: expect.any(String) },
    ]);
    expect(accountDataCalls[1]?.[1]).toEqual({
      key: String(accountDataCalls[0]?.[0]).slice("m.secret_storage.key.".length),
    });
    expect(sdk.state.createIdentity).toHaveBeenCalledWith(ENCRYPTION_SECRET);
    expect(sdk.state.confirmIdentityWithRecoveryKey).not.toHaveBeenCalled();
  });

  it("does not replace existing recovery data when the configured secret is wrong", async () => {
    sdk.state.recoveryAvailable = true;
    seedSecretStorage();
    const client = createClient();

    await expect(client.initializeCryptoIdentity(DIFFERENT_ENCRYPTION_SECRET)).rejects.toThrow();

    expect(sdk.state.confirmIdentityWithRecoveryKey).not.toHaveBeenCalled();
    expect(sdk.state.createIdentity).not.toHaveBeenCalled();
    expect(sdk.state.setAccountData).not.toHaveBeenCalled();
  });

  it("resumes safely when a previous first run stored only the default secret-storage key", async () => {
    const keyId = seedSecretStorage();
    const client = createClient();

    await expect(client.initializeCryptoIdentity(ENCRYPTION_SECRET)).resolves.toMatchObject({ created: true });

    expect(sdk.state.getAccountData).toHaveBeenCalledWith("m.secret_storage.default_key");
    expect(sdk.state.getAccountData).toHaveBeenCalledWith(`m.secret_storage.key.${keyId}`);
    expect(sdk.state.setAccountData).not.toHaveBeenCalled();
    expect(sdk.state.createIdentity).toHaveBeenCalledWith(ENCRYPTION_SECRET);
  });

  it("is idempotent when restarted with the same portable secret", async () => {
    const client = createClient();

    await client.initializeCryptoIdentity(ENCRYPTION_SECRET);
    const firstAccountData = new Map(sdk.state.accountData);
    vi.clearAllMocks();

    await expect(client.initializeCryptoIdentity(ENCRYPTION_SECRET)).resolves.toEqual({ created: false });

    expect(sdk.state.accountData).toEqual(firstAccountData);
    expect(sdk.state.setAccountData).not.toHaveBeenCalled();
    expect(sdk.state.createIdentity).not.toHaveBeenCalled();
    expect(sdk.state.confirmIdentityWithRecoveryKey).toHaveBeenCalledWith(ENCRYPTION_SECRET);
  });

  it("fails closed when cross-signing exists but recovery metadata is incomplete", async () => {
    sdk.state.crossSigningExists = true;
    const client = createClient();

    await expect(client.initializeCryptoIdentity(ENCRYPTION_SECRET)).rejects.toThrow(
      "Matrix cross-signing already exists but recovery is incomplete",
    );

    expect(sdk.state.setAccountData).not.toHaveBeenCalled();
    expect(sdk.state.createIdentity).not.toHaveBeenCalled();
    expect(sdk.state.confirmIdentityWithRecoveryKey).not.toHaveBeenCalled();
  });

  it("fails closed when the default secret-storage key has no matching metadata", async () => {
    sdk.state.accountData.set("m.secret_storage.default_key", { key: "missing-key" });
    const client = createClient();

    await expect(client.initializeCryptoIdentity(ENCRYPTION_SECRET)).rejects.toThrow(
      "Matrix secret-storage metadata is incomplete",
    );

    expect(sdk.state.setAccountData).not.toHaveBeenCalled();
    expect(sdk.state.createIdentity).not.toHaveBeenCalled();
  });

  it("restores cross-signing only and does not claim to import historical Megolm sessions", async () => {
    sdk.state.recoveryAvailable = true;
    seedSecretStorage();
    const client = createClient();

    await client.initializeCryptoIdentity(ENCRYPTION_SECRET);

    expect(sdk.state.confirmIdentityWithRecoveryKey).toHaveBeenCalledWith(ENCRYPTION_SECRET);
    expect(sdk.state.importRoomKeys).not.toHaveBeenCalled();
  });
});
