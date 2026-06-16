/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared bridge wiring: construct and start ONE bridge runner from a resolved
 * {@link SidecarConfig} + a bridge-scope token, over the loopback/daemon HTTP+SSE
 * contract. This is the construction the standalone sidecar entrypoint and (in a
 * follow-up) the in-process `cli.ts` blocks share — the runner only ever reaches
 * the gateway through the injected {@link BridgeClient} (bearer token), so the
 * same code runs in-process or out-of-process by changing only `gatewayUrl`.
 *
 * Thin glue: the bug-prone logic lives in the pure resolver / token bootstrap and
 * in each runner (all unit-tested). This switch is exercised end-to-end by the
 * sidecar spawn smoke (a bad token draws a 401 from the gateway's own auth).
 *
 * TODO (follow-up cycle): route the in-process bridge blocks in `cli.ts` through
 * this `startBridge` so the construction isn't duplicated. Deferred because the
 * cli.ts bridge path is not CI-exercised (its env gates are unset under test), so
 * that edit needs its own verification. The discord/matrix branches below are
 * verbatim copies of cli.ts construction (tsc guards option-name drift); only the
 * telegram branch is covered by the spawn smoke today — extend the smoke when the
 * de-dup lands.
 */

import { join } from 'node:path';
import { BridgeClient } from './client.js';
import type { SidecarConfig } from './sidecarConfig.js';
import { TelegramBotApi } from './telegram/botApi.js';
import { TelegramChatStore } from './telegram/chatStore.js';
import { TelegramBridge } from './telegram/runner.js';
import { DiscordRestApi } from './discord/restApi.js';
import { DiscordChannelStore } from './discord/channelStore.js';
import { DiscordBridge } from './discord/runner.js';
import { makeDiscordGateway } from './discord/gateway.js';
import { MatrixRestApi } from './matrix/restApi.js';
import { MatrixRoomStore } from './matrix/roomStore.js';
import { MatrixBridge } from './matrix/runner.js';
import {
  setupMatrixCrypto,
  createMatrixCryptoAdapter,
  type DecryptedMatrixMessage,
} from './matrix/cryptoAdapter.js';
import type { NormalizedMatrixReaction } from './matrix/dispatch.js';

export interface StartBridgeOptions {
  /** The resolved bridge-scope token (from {@link resolveBridgeToken}). */
  token: string;
  /** Logger for boot/error lines (never receives the token). */
  log?: (msg: string) => void;
  /** Injectable crypto-adapter factory (tests); defaults to the real one. */
  createCryptoAdapter?: typeof createMatrixCryptoAdapter;
}

/** A started bridge — call `stop()` to abort its loops. */
export interface StartedBridge {
  stop(): void;
}

/** Sleep `ms`, resolving early if `signal` aborts (so shutdown stays prompt). */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Construct the runner for `cfg.kind`, start its loops, and return a handle that
 * aborts them. The caller owns process lifecycle (signals, exit). For Matrix the
 * caller MUST have already validated `whoami` against `cfg.userId` (the spec's
 * MXID-mismatch fail-fast) — this only wires the validated identity in.
 */
export async function startBridge(
  cfg: SidecarConfig,
  opts: StartBridgeOptions,
): Promise<StartedBridge> {
  const { token, log } = opts;
  const client = new BridgeClient({ baseUrl: cfg.gatewayUrl, token });
  const abort = new AbortController();

  if (cfg.kind === 'telegram') {
    const runner = new TelegramBridge({
      botApi: new TelegramBotApi({ botToken: cfg.botToken }),
      client,
      chats: await TelegramChatStore.open(join(cfg.stateDir, 'chats.json')),
      baseUrl: cfg.gatewayUrl,
      log,
    });
    void runner.start(abort.signal);
    return { stop: () => abort.abort() };
  }

  if (cfg.kind === 'discord') {
    const runner = new DiscordBridge({
      client,
      rest: new DiscordRestApi({
        botToken: cfg.botToken,
        applicationId: cfg.applicationId,
      }),
      channels: await DiscordChannelStore.open(
        join(cfg.stateDir, 'channels.json'),
      ),
      makeGateway: makeDiscordGateway({
        botToken: cfg.botToken,
        applicationId: cfg.applicationId,
        guildId: cfg.guildId,
        log,
      }),
      baseUrl: cfg.gatewayUrl,
      log,
    });
    void runner.start(abort.signal);
    return { stop: () => abort.abort() };
  }

  // matrix — whoami already validated by the caller.
  const mxRest = new MatrixRestApi({
    homeserverUrl: cfg.homeserverUrl,
    accessToken: cfg.accessToken,
  });
  const rooms = await MatrixRoomStore.open(join(cfg.stateDir, 'rooms.json'));

  // E2EE (opt-in, OFF by default). When the crypto adapter is built it becomes
  // the SOLE /sync owner (a second sync on the same device would race it for the
  // to-device megolm keys) AND the outbound transport (the SDK encrypts iff the
  // room is encrypted — no plaintext into an encrypted room). setupMatrixCrypto
  // degrades any construction failure to null, so the plain bridge always boots.
  //
  // The adapter captures its callbacks at construction, but they must dispatch
  // into the runner built below — so they route through this sink, whose targets
  // are set once the runner exists (callbacks only fire after adapter.start()).
  const sink: {
    onMessage: (m: DecryptedMatrixMessage) => void | Promise<void>;
    onReaction: (r: NormalizedMatrixReaction) => void | Promise<void>;
  } = { onMessage: () => {}, onReaction: () => {} };
  const adapter = await setupMatrixCrypto(
    {
      e2eeEnabled: cfg.e2eeEnabled,
      homeserverUrl: cfg.homeserverUrl,
      accessToken: cfg.accessToken,
      stateDir: cfg.stateDir,
    },
    {
      log: (m) => log?.(m),
      warn: (m) => log?.(m),
    },
    opts.createCryptoAdapter ?? createMatrixCryptoAdapter,
    {
      onMessage: (m) => sink.onMessage(m),
      onReaction: (r) => sink.onReaction(r),
    },
  );

  const runner = new MatrixBridge({
    client,
    // When E2EE is on, outbound goes through the SDK client (encrypts); else the
    // plain fetch REST. Both satisfy MatrixInbound.
    rest: adapter ?? mxRest,
    rooms,
    botUserId: cfg.userId,
    baseUrl: cfg.gatewayUrl,
    commandPrefix: cfg.commandPrefix,
    syncOnce: (since, signal) =>
      mxRest.sync(since, 30000, signal).then((r) => r.body),
    // The adapter owns /sync when present; otherwise the fetch syncLoop runs.
    // adapter.start() makes a live network call (getJoinedRooms) that throws if
    // the homeserver is unreachable at boot. The fetch syncLoop self-catches and
    // backs off, so match that here: retry with backoff until success or abort,
    // never letting the rejection escape `void runner.start()` (an unhandled
    // rejection can crash the process). Once started, the SDK handles reconnects.
    ...(adapter
      ? {
          runInbound: async (signal: AbortSignal) => {
            let backoff = 1000;
            while (!signal.aborted) {
              try {
                await adapter.start();
                return;
              } catch (err) {
                log?.(
                  `matrix crypto start failed, retrying: ${
                    (err as Error).message ?? err
                  }`,
                );
                await abortableSleep(backoff, signal);
                backoff = Math.min(backoff * 2, 30_000);
              }
            }
          },
        }
      : {}),
    log,
  });
  // Now that the runner exists, point the adapter's callbacks at its dispatch.
  sink.onMessage = (m) => runner.dispatchDecryptedMessage(m, m.powerLevel);
  sink.onReaction = (r) => runner.dispatchReaction(r);
  void runner.start(abort.signal);
  // Stop the adapter's background sync on shutdown.
  if (adapter) {
    abort.signal.addEventListener('abort', () => void adapter.stop(), {
      once: true,
    });
  }
  return { stop: () => abort.abort() };
}
