/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared bridge wiring: construct and start ONE bridge runner from a resolved
 * {@link SidecarConfig} + a bridge-scope token, over the loopback/daemon HTTP+SSE
 * contract. BOTH the standalone sidecar entrypoint and the in-process `cli.ts`
 * path go through here (cli.ts resolves which bridges to start via the unit-tested
 * `resolveInProcessBridges`, then hands each plan to `startBridge`) — the runner
 * only ever reaches the gateway through the injected {@link BridgeClient} (bearer
 * token), so the same code runs in-process or out-of-process by changing only
 * `gatewayUrl` (transport) and `deeplinkUrl`.
 *
 * Thin glue: the bug-prone logic lives in the pure resolver / token bootstrap and
 * in each runner (all unit-tested). This switch is exercised end-to-end by the
 * sidecar spawn smoke (a bad token draws a 401 from the gateway's own auth); the
 * telegram branch is the one the smoke spawns, and tsc guards option-name drift
 * across the discord/matrix branches.
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
import {
  initialMatrixHealthState,
  buildMatrixHealthReport,
  startMatrixHealthServer,
  type MatrixHealthServer,
} from './matrix/health.js';

export interface StartBridgeOptions {
  /** The resolved bridge-scope token (from {@link resolveBridgeToken}). */
  token: string;
  /** Logger for boot/error lines (never receives the token). */
  log?: (msg: string) => void;
  /**
   * User-reachable base for deeplinks. Defaults to `cfg.gatewayUrl` (the sidecar
   * case, where transport and deeplink collapse). In-process the transport is
   * loopback (`cfg.gatewayUrl`) but deeplinks must be reachable, so the caller
   * passes `QWEN_DAEMON_URL || loopback` here — distinct from the transport.
   */
  deeplinkUrl?: string;
  /**
   * Port for the Matrix bridge's `GET /healthz` server (loopback). When set (the
   * sidecar defaults it to 9100), the Matrix bridge exposes the spec's healthz;
   * ignored for non-Matrix bridges. A bind failure never crashes the bridge.
   */
  healthzPort?: number;
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
  // Transport is always cfg.gatewayUrl (loopback in-process; the remote gateway
  // for a sidecar). Deeplinks default to the same, but in-process they differ.
  const client = new BridgeClient({ baseUrl: cfg.gatewayUrl, token });
  const deeplinkUrl = opts.deeplinkUrl ?? cfg.gatewayUrl;
  const abort = new AbortController();

  // Launch a runner's loops without letting a boot-time rejection escape as an
  // UNHANDLED rejection. A runner's start() awaits registerSelf(), which THROWS
  // when the gateway is unreachable (the BridgeClient propagates fetch errors) —
  // and these are launched fire-and-forget, so an unguarded throw would crash the
  // host process (the gateway itself, for an in-process bridge). In-process the
  // gateway is loopback (never unreachable), so this only bites a sidecar whose
  // gateway is down at boot; it then logs and stays inert (a supervisor restarts
  // it) rather than taking the process down. Mirrors the runInbound hardening.
  const launch = (r: { start(signal: AbortSignal): Promise<void> }): void => {
    void r.start(abort.signal).catch((err) => {
      log?.(
        `${cfg.kind} bridge: start failed (${
          (err as Error).message ?? err
        }) — not started`,
      );
    });
  };

  if (cfg.kind === 'telegram') {
    const runner = new TelegramBridge({
      botApi: new TelegramBotApi({ botToken: cfg.botToken }),
      client,
      chats: await TelegramChatStore.open(join(cfg.stateDir, 'chats.json')),
      baseUrl: deeplinkUrl,
      log,
    });
    launch(runner);
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
      baseUrl: deeplinkUrl,
      log,
    });
    launch(runner);
    return { stop: () => abort.abort() };
  }

  // matrix — whoami already validated by the caller.
  const mxRest = new MatrixRestApi({
    homeserverUrl: cfg.homeserverUrl,
    accessToken: cfg.accessToken,
  });
  const rooms = await MatrixRoomStore.open(join(cfg.stateDir, 'rooms.json'));

  // Healthz liveness state (only when a healthz port is configured): the runner
  // updates registeredId/daemonReachable/homeserverReachable; the GET /healthz
  // server reports it + a fresh olm-store check.
  const startedAtMs = Date.now();
  const health =
    opts.healthzPort != null ? initialMatrixHealthState() : undefined;

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
    baseUrl: deeplinkUrl,
    commandPrefix: cfg.commandPrefix,
    ...(health ? { health } : {}),
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
                // The SDK owns /sync from here; reflect "reachable at start"
                // (it hides later reconnects from the runner — see health.ts).
                if (health) health.homeserverReachable = true;
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
  launch(runner);

  // Start the loopback /healthz server (when configured); close it on shutdown.
  // Never throws — a bind failure degrades to a no-op handle.
  let healthServer: MatrixHealthServer | undefined;
  if (health && opts.healthzPort != null) {
    healthServer = await startMatrixHealthServer(
      opts.healthzPort,
      () =>
        buildMatrixHealthReport(health, {
          stateDir: cfg.stateDir,
          startedAtMs,
          nowMs: Date.now(),
        }),
      { log },
    );
  }

  // Stop the adapter's background sync + the healthz server on shutdown.
  abort.signal.addEventListener(
    'abort',
    () => {
      if (adapter) void adapter.stop();
      if (healthServer) void healthServer.close();
    },
    { once: true },
  );
  return { stop: () => abort.abort() };
}
