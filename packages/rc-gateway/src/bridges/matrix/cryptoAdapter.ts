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
 * The construction is typed against the REAL SDK (the `import('matrix-bot-sdk')`
 * types flow through tsc and the ctor calls are signature-checked). The live
 * olm/megolm round-trip is exercised by the env-gated `crypto.integration.test.ts`
 * and has been RUN GREEN against a real Synapse: the bot decrypts an encrypted
 * message, a decrypted message reaches a BOUND SESSION through dispatch, the bot's
 * reply is real ciphertext the sender decrypts (no plaintext leak), and a 👍
 * reaction registers a vote. The pure seams — olm-store presence, the
 * store-missing warn, `e2eeEnabled` gating — are unit-tested.
 *
 * When E2EE is on, `startBridge` makes this adapter the SOLE `/sync` owner (a
 * second sync on the same device would race it for the to-device megolm keys) and
 * the bridge's outbound transport (the SDK encrypts iff the room is encrypted).
 * See docs/matrix-bridge.md.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { olmStoreDir, OLM_STORE_MISSING_LOG } from './e2ee.js';
import { senderPowerLevel, type NormalizedMatrixReaction } from './dispatch.js';
import type { MatrixInbound } from './runner.js';

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
  /**
   * The sender's power level in the room, resolved from `m.room.power_levels`
   * SDK state — so power-gated commands (`!qwen attach`) work in encrypted rooms
   * exactly as they do over the plain fetch path. Defaults to 0 if unresolved.
   */
  powerLevel: number;
}

/**
 * The crypto-enabled Matrix client, presented as the SAME {@link MatrixInbound}
 * the runner's outbound uses — so when E2EE is on, the bridge sends through the
 * SDK client (which encrypts iff the room is encrypted: no plaintext ever lands
 * in an encrypted room) and the SDK client is the SOLE `/sync` owner (running a
 * second sync on the same device would race it for the to-device megolm keys).
 */
export interface MatrixCryptoAdapter extends MatrixInbound {
  /** Crypto ready to decrypt/encrypt (after {@link start}). */
  isReady(): boolean;
  /** Prepare crypto for the joined rooms, then begin syncing. */
  start(): Promise<void>;
  /** Stop syncing and release the client. */
  stop(): Promise<void>;
}

export interface CryptoAdapterDeps {
  homeserverUrl: string;
  accessToken: string;
  /** `$QWEN_BRIDGE_STATE_DIR` — the olm store lives at `<stateDir>/olm/`. */
  stateDir: string;
  /** Sink for inbound decrypted room messages (route into the bridge dispatch). */
  onMessage: (msg: DecryptedMatrixMessage) => void | Promise<void>;
  /** Sink for inbound reactions (👍/👎 → votes), normalized like the fetch path. */
  onReaction?: (r: NormalizedMatrixReaction) => void | Promise<void>;
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
      SimpleFsStorageProvider,
      AutojoinRoomsMixin,
    } = sdk;
    // matrix-bot-sdk re-exports the store-type enum as a TYPE only
    // (`RustSdkCryptoStoreType` is a `const enum`, erased at runtime → `undefined`
    // under esbuild). Source the real runtime value from the native package, which
    // exports `StoreType` as an actual object — both type-correct and present at
    // runtime, no cast.
    const { StoreType } = await import('@matrix-org/matrix-sdk-crypto-nodejs');

    // SQLite-backed olm/megolm store at <stateDir>/olm/ (survives restart, so
    // encrypted-room messages remain decryptable without re-keying — the spec's
    // "Persistent olm crypto store" requirement).
    const cryptoStore = new RustSdkCryptoStorageProvider(
      olmStoreDir(deps.stateDir),
      StoreType.Sqlite,
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
    // Invites → auto-join, so the bot is in the room (and receives its megolm
    // sessions) by the time messages arrive — the same effect the fetch
    // syncLoop's explicit join had, but driven by the SDK's sole sync.
    AutojoinRoomsMixin.setupOnClient(client);

    // The sender's power level comes from the room's `m.room.power_levels` state
    // (best-effort: a missing/erroring lookup → 0, sufficient for plain prompts;
    // gated commands then correctly deny). Mirrors senderPowerLevel on the fetch
    // path so attach/detach behave identically in encrypted rooms.
    const resolvePower = async (
      roomId: string,
      sender: string,
    ): Promise<number> => {
      try {
        const pl = await client.getRoomStateEvent(
          roomId,
          'm.room.power_levels',
          '',
        );
        return senderPowerLevel(pl, sender);
      } catch {
        return 0;
      }
    };

    // matrix-bot-sdk decrypts `m.room.encrypted` events IN PLACE and re-emits the
    // plaintext as `room.message` (MatrixClient processSync: decrypt → fall through
    // to the m.room.message emit), so this one handler covers BOTH cleartext and
    // decrypted encrypted-room messages — no manual decryptRoomEvent needed.
    client.on('room.message', (roomId: string, event: unknown) => {
      const e = event as { sender?: string; content?: { body?: string } };
      if (typeof e.content?.body !== 'string') return;
      const sender = e.sender ?? '';
      const body = e.content.body;
      void (async () => {
        const powerLevel = await resolvePower(roomId, sender);
        await deps.onMessage({ roomId, sender, body, powerLevel });
      })();
    });

    // Reactions are plain `m.reaction` timeline events (annotations are not
    // encrypted), delivered via the generic `room.event` emit. Normalize 👍/👎
    // on a tracked permission_request into the dispatcher's reaction shape.
    client.on('room.event', (roomId: string, event: unknown) => {
      const e = event as {
        type?: string;
        sender?: string;
        content?: Record<string, unknown>;
      };
      if (e.type !== 'm.reaction') return;
      const relates = e.content?.['m.relates_to'] as
        | { event_id?: unknown; key?: unknown }
        | undefined;
      if (
        typeof e.sender === 'string' &&
        typeof relates?.event_id === 'string' &&
        typeof relates?.key === 'string'
      ) {
        void deps.onReaction?.({
          roomId,
          sender: e.sender,
          targetEventId: relates.event_id,
          key: relates.key,
        });
      }
    });

    return {
      isReady: () => client.crypto?.isReady ?? false,
      // MatrixInbound.joinRoom (the runner's contract) — `{ok,status}`, not the
      // SDK's raw roomId string; never throws (degrade to a failed result).
      joinRoom: async (roomId) => {
        try {
          await client.joinRoom(roomId);
          return { ok: true, status: 200 };
        } catch (err) {
          deps.log?.(
            `matrix crypto join failed: ${(err as Error).message ?? err}`,
          );
          return { ok: false, status: 0 };
        }
      },
      // Outbound: send as `m.room.message`; the SDK encrypts iff the room is
      // encrypted — so this is the ONE outbound path (correct for plain AND
      // encrypted rooms) and never leaks plaintext into an encrypted room.
      sendMessage: async (roomId, content) => {
        try {
          const eventId = await client.sendEvent(
            roomId,
            'm.room.message',
            content,
          );
          return { ok: true, status: 200, eventId };
        } catch (err) {
          deps.log?.(
            `matrix crypto send failed: ${(err as Error).message ?? err}`,
          );
          return { ok: false, status: 0 };
        }
      },
      start: async () => {
        const joined = await client.getJoinedRooms();
        await client.crypto.prepare(joined);
        await client.start();
        deps.log?.('matrix crypto: prepared + syncing');
      },
      stop: async () => {
        client.stop();
      },
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
  callbacks: {
    onMessage?: (msg: DecryptedMatrixMessage) => void | Promise<void>;
    onReaction?: (r: NormalizedMatrixReaction) => void | Promise<void>;
  } = {},
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
      // Default to a no-op message sink so a caller that only wants the boot
      // safety/warn behavior (no live routing) still constructs safely.
      onMessage: callbacks.onMessage ?? (() => {}),
      ...(callbacks.onReaction ? { onReaction: callbacks.onReaction } : {}),
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
        '(the caller wires its callbacks + start() — see startBridge)',
    );
  }
  return adapter;
}
