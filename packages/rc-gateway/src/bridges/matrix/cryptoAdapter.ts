/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Matrix E2EE crypto adapter (`add-matrix-bridge`: "Persistent olm crypto store"
 * + encrypted-room participation) — the slice-2 transport the {@link
 * ./e2ee.js} scaffolding reserved. Opt-in via `MATRIX_ENABLE_E2EE`, OFF by
 * default; the tested `fetch`-based plain path is untouched and stays the default.
 *
 * VERIFICATION CEILING (chosen "compile-checked ceiling"): the matrix-bot-sdk
 * `MatrixClient` + `RustSdkCryptoStorageProvider` construction below is typed
 * against the REAL SDK (the `import('matrix-bot-sdk')` types flow through tsc and
 * the ctor calls are signature-checked — a wrong argument fails the build), but it
 * is NOT exercised at runtime: live olm/megolm decrypt needs a homeserver, an
 * encrypted room, and a verified device, none of which exist in CI. The genuinely
 * verifiable seams — olm-store presence, the store-missing warn decision, and the
 * `e2eeEnabled` gating — are pure and unit-tested. Routing the adapter's decrypted
 * events into the runner's existing dispatch (reconciling its `/sync` loop with the
 * SDK's own) is the residual integration, documented in docs/matrix-bridge.md.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { olmStoreDir, OLM_STORE_MISSING_LOG } from './e2ee.js';

/**
 * Does a non-empty olm/megolm store already exist? Drives the healthz
 * `olmStorePresent` field and the first-boot re-key warn. A real fs check.
 */
export function olmStorePresent(stateDir: string): boolean {
  const dir = olmStoreDir(stateDir);
  try {
    return existsSync(dir) && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Whether to emit the first-boot `olm_store_missing` re-key warning: ONLY when
 * E2EE is enabled AND no store is present yet (with the adapter built, a missing
 * store means encrypted rooms re-key, which is the truthful warning — never warn
 * when E2EE is off, since there is no crypto and nothing to re-key).
 */
export function shouldWarnOlmMissing(input: {
  e2eeEnabled: boolean;
  olmStorePresent: boolean;
}): boolean {
  return input.e2eeEnabled && !input.olmStorePresent;
}

/** The inbound decrypted-message shape the adapter forwards to the bridge. */
export interface DecryptedMatrixMessage {
  roomId: string;
  sender: string;
  body: string;
}

export interface MatrixCryptoAdapter {
  /** Crypto ready to decrypt/encrypt (after {@link start}). */
  isReady(): boolean;
  /** Join a room (so its messages sync + its megolm sessions are received). */
  joinRoom(roomId: string): Promise<string>;
  /** Prepare crypto for the joined rooms, then begin syncing. */
  start(): Promise<void>;
  /** Stop syncing and release the client. */
  stop(): Promise<void>;
  /** Send an encrypted formatted message; resolves with the event id. */
  sendEncrypted(roomId: string, text: string, html: string): Promise<string>;
}

export interface CryptoAdapterDeps {
  homeserverUrl: string;
  accessToken: string;
  /** `$QWEN_BRIDGE_STATE_DIR` — the olm store lives at `<stateDir>/olm/`. */
  stateDir: string;
  /** Sink for inbound decrypted room messages (route into the bridge dispatch). */
  onMessage: (msg: DecryptedMatrixMessage) => void | Promise<void>;
  log?: (m: string) => void;
}

/**
 * Construct the crypto-enabled Matrix client, or `null` when the optional
 * `matrix-bot-sdk` dependency is not installed (E2EE then stays off; the plain
 * bridge is unaffected — mirrors the other optional-dep loaders).
 *
 * The body is typed against the real SDK but not runtime-verified (the ceiling).
 */
export async function createMatrixCryptoAdapter(
  deps: CryptoAdapterDeps,
): Promise<MatrixCryptoAdapter | null> {
  // ONE boundary over import + construction + wiring: a missing module, a failed
  // native @matrix-org/matrix-sdk-crypto-nodejs init, or an unwritable
  // <stateDir>/olm/ ALL degrade to null (E2EE off) rather than throwing — so
  // flipping MATRIX_ENABLE_E2EE can never crash the working plain bridge.
  try {
    const sdk = await import('matrix-bot-sdk');
    const {
      MatrixClient,
      RustSdkCryptoStorageProvider,
      RustSdkCryptoStoreType,
      SimpleFsStorageProvider,
    } = sdk;

    // SQLite-backed olm/megolm store at <stateDir>/olm/ (survives restart, so
    // encrypted-room messages remain decryptable without re-keying — the spec's
    // "Persistent olm crypto store" requirement).
    const cryptoStore = new RustSdkCryptoStorageProvider(
      olmStoreDir(deps.stateDir),
      RustSdkCryptoStoreType.Sqlite,
    );
    const storage = new SimpleFsStorageProvider(
      join(deps.stateDir, 'matrix-sync.json'),
    );
    const client = new MatrixClient(
      deps.homeserverUrl,
      deps.accessToken,
      storage,
      cryptoStore,
    );

    // matrix-bot-sdk decrypts `m.room.encrypted` events IN PLACE and re-emits the
    // plaintext as `room.message` (MatrixClient processSync: decrypt → fall through
    // to the m.room.message emit), so this one handler covers BOTH cleartext and
    // decrypted encrypted-room messages — no manual decryptRoomEvent needed.
    client.on('room.message', (roomId: string, event: unknown) => {
      const e = event as { sender?: string; content?: { body?: string } };
      if (typeof e.content?.body !== 'string') return;
      void deps.onMessage({
        roomId,
        sender: e.sender ?? '',
        body: e.content.body,
      });
    });

    return {
      isReady: () => client.crypto?.isReady ?? false,
      joinRoom: (roomId) => client.joinRoom(roomId),
      start: async () => {
        const joined = await client.getJoinedRooms();
        await client.crypto.prepare(joined);
        await client.start();
        deps.log?.(
          'matrix crypto: prepared + syncing (live decrypt unverified)',
        );
      },
      stop: async () => {
        client.stop();
      },
      sendEncrypted: (roomId, text, html) =>
        client.sendMessage(roomId, {
          msgtype: 'm.text',
          body: text,
          format: 'org.matrix.custom.html',
          formatted_body: html,
        }),
    };
  } catch (err) {
    deps.log?.(
      `matrix crypto unavailable: ${(err as Error).message ?? String(err)}`,
    );
    return null;
  }
}

export interface MatrixCryptoSetupCfg {
  e2eeEnabled: boolean;
  homeserverUrl: string;
  accessToken: string;
  stateDir: string;
}

/**
 * Boot-time crypto setup, extracted so both invariants are unit-tested without a
 * homeserver: (1) E2EE OFF → the adapter is NEVER constructed (plain bridge
 * untouched); (2) construction failure → degrades to null and NEVER propagates
 * (the plain bridge keeps booting). Also emits the truthful first-boot
 * `olm_store_missing` re-key warning. `createAdapter` is injectable for tests.
 */
export async function setupMatrixCrypto(
  cfg: MatrixCryptoSetupCfg,
  io: { log: (m: string) => void; warn: (m: string) => void },
  createAdapter: typeof createMatrixCryptoAdapter = createMatrixCryptoAdapter,
): Promise<MatrixCryptoAdapter | null> {
  if (!cfg.e2eeEnabled) return null;
  if (
    shouldWarnOlmMissing({
      e2eeEnabled: true,
      olmStorePresent: olmStorePresent(cfg.stateDir),
    })
  ) {
    io.warn(OLM_STORE_MISSING_LOG);
  }
  let adapter: MatrixCryptoAdapter | null = null;
  try {
    adapter = await createAdapter({
      homeserverUrl: cfg.homeserverUrl,
      accessToken: cfg.accessToken,
      stateDir: cfg.stateDir,
      onMessage: () => {
        // Residual: route decrypted messages into the bridge dispatch.
      },
      log: io.log,
    });
  } catch (err) {
    // createAdapter already self-catches to null; this is belt-and-suspenders so
    // crypto setup can never propagate and crash the plain bridge.
    io.warn(`matrix crypto setup failed: ${(err as Error).message ?? err}`);
    return null;
  }
  if (!adapter) {
    io.warn(
      'matrix crypto unavailable (matrix-bot-sdk not installed or failed to ' +
        'initialize) — encrypted rooms refused; plain bridge continues',
    );
  } else {
    io.log(
      'matrix crypto transport constructed + olm store initialized ' +
        '(compile-checked; live decrypt + dispatch routing are the documented ' +
        'residual integration — see docs/matrix-bridge.md)',
    );
  }
  return adapter;
}
