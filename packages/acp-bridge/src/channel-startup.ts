/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { PRIVATE_ACP_CAPABILITY_ENV } from '@qwen-code/qwen-code-core';
import type {
  AcpChannel,
  AcpChannelExitInfo,
  ChannelFactory,
  ChannelFactoryStartupContext,
} from './channel.js';
import type { HarnessChannel, ChannelLifecycle } from './channel-lifecycle.js';
import type {
  BridgeRuntimeEpochSource,
  BridgeTelemetry,
  BridgeExecutionEngine,
  BridgeOptions,
} from './bridgeOptions.js';
import type { NdJsonQueueLimitError } from './ndJsonStream.js';
import {
  BridgeChannelClosedError,
  BridgeTimeoutError,
  SERVE_STATUS_EXT_METHODS,
} from './status.js';
import { CHANNEL_LIVENESS_VERSION } from './bridgeTypes.js';
import {
  createChannelInitializeRequest,
  negotiateChannelCapabilities,
} from './channel-handshake.js';
import {
  terminateChannel,
  channelUnavailableReject,
} from './channel-transport.js';
import {
  startChannelLivenessMonitor,
  type ChannelLivenessFailure,
} from './channel-liveness.js';
import { getChannelStartupProfileAttributes } from './channel-startup-profile.js';
import { withTimeout } from './with-timeout.js';
import { writeStderrLine } from './internal/stderrLine.js';

export interface ChannelStartupOptions {
  channelFactory: ChannelFactory;
  executionEngines?: Pick<
    NonNullable<BridgeOptions['executionEngines']>,
    'legacy' | 'managed'
  >;
  boundWorkspace: string;
  childEnvOverrides: Readonly<Record<string, string | undefined>>;
  initTimeoutMs: number;
  telemetry: BridgeTelemetry;
  channelLifecycle: ChannelLifecycle;
  initialRuntimeEpoch: number;
  runtimeEpochSource: BridgeRuntimeEpochSource;
  delegateReadTextFileToClient: boolean;
  isExternalToolGuardRequired(): boolean;
  isShuttingDown(): boolean;
  constructHarnessChannel(
    channel: AcpChannel,
    id: string,
    engine?: BridgeExecutionEngine,
  ): HarnessChannel;
  handleChannelTransportUnavailable(info: HarnessChannel): void;
  handleChannelExit(
    info: HarnessChannel,
    exitInfo: AcpChannelExitInfo | undefined,
  ): void;
  killChannelWithLog(info: HarnessChannel, context: string): Promise<void>;
  sessionCount(info: HarnessChannel): number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeTransportFailureCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const code = error['code'];
  return typeof code === 'string' && /^[a-z0-9_.-]{1,64}$/iu.test(code)
    ? code
    : undefined;
}

function safeTransportFailureDetail(error: unknown): string | undefined {
  if (!isRecord(error) || error['code'] !== 'ndjson_queue_limit_exceeded') {
    return undefined;
  }
  const queueError = error as Partial<NdJsonQueueLimitError>;
  const budget =
    typeof queueError.budget === 'string' &&
    /^[a-z0-9_.-]{1,64}$/iu.test(queueError.budget)
      ? queueError.budget
      : 'unknown';
  const numbers: string[] = [];
  for (const value of [
    queueError.requiredBytes,
    queueError.availableBytes,
    queueError.maxQueuedBytes,
  ]) {
    numbers.push(
      typeof value === 'number' && Number.isFinite(value)
        ? String(Math.max(0, Math.floor(value)))
        : '?',
    );
  }
  return `${budget}:required=${numbers[0]}:available=${numbers[1]}:cap=${numbers[2]}`;
}

export function createChannelStartup({
  channelFactory,
  executionEngines,
  boundWorkspace,
  childEnvOverrides,
  initTimeoutMs,
  telemetry,
  channelLifecycle,
  initialRuntimeEpoch,
  runtimeEpochSource,
  delegateReadTextFileToClient,
  isExternalToolGuardRequired,
  isShuttingDown,
  constructHarnessChannel,
  handleChannelTransportUnavailable,
  handleChannelExit,
  killChannelWithLog,
  sessionCount,
}: ChannelStartupOptions) {
  let runtimeEpoch = initialRuntimeEpoch;

  async function start(
    engine?: BridgeExecutionEngine,
  ): Promise<HarnessChannel> {
    const factory =
      engine === undefined ? channelFactory : executionEngines![engine];
    const privateParentCapability = randomBytes(32).toString('base64url');
    const acpChannelId = randomUUID();
    const startupStartedAt = Date.now();
    const startupAbort = new AbortController();
    const startup: ChannelFactoryStartupContext = {};
    const factoryPromise = telemetry.withSpan(
      'channel.spawn',
      {
        'qwen-code.daemon.bridge.operation': 'channel.spawn',
        'qwen-code.daemon.channel.reused': false,
        'qwen-code.daemon.acp_channel.id': acpChannelId,
      },
      async () =>
        await factory(
          boundWorkspace,
          {
            ...childEnvOverrides,
            [PRIVATE_ACP_CAPABILITY_ENV]: privateParentCapability,
          },
          startupAbort.signal,
          startup,
        ),
    );
    let channel: AcpChannel;
    try {
      channel = await withTimeout(
        factoryPromise,
        initTimeoutMs,
        'channel factory',
      );
    } catch (error) {
      const failure =
        error instanceof BridgeTimeoutError
          ? (startup.getTimeoutError?.() ?? error)
          : error;
      startupAbort.abort(failure);
      void factoryPromise.then(
        (lateChannel) =>
          terminateChannel(
            lateChannel,
            initTimeoutMs,
            'late channel factory result',
          ).catch((teardownError) => {
            writeStderrLine(
              `qwen serve: late ACP channel teardown failed: ${String(teardownError)}`,
            );
          }),
        () => undefined,
      );
      throw failure;
    }
    let info: HarnessChannel;
    try {
      info = constructHarnessChannel(channel, acpChannelId, engine);
    } catch (error) {
      try {
        channel.killSync();
      } catch {
        // The asynchronous teardown below remains authoritative.
      }
      try {
        // Raw exit is successful teardown after the forced signal; kill()
        // supplies the bounded failure path when exit is never observed.
        await Promise.race([
          channel.exited.then(() => undefined),
          terminateChannel(
            channel,
            initTimeoutMs,
            'channel construction failure',
          ),
        ]);
      } catch (teardownError) {
        throw new AggregateError(
          [error, teardownError],
          'ACP channel construction and teardown failed',
        );
      }
      throw error;
    }

    const { connection } = info;
    const markTransportFailed = (error: unknown) => {
      if (!info.isDying) {
        info.transportFailureInitiatedTeardown = true;
      }
      info.transportFailed = true;
      info.transportFailureCode = safeTransportFailureCode(error);
      info.transportFailureDetail = safeTransportFailureDetail(error);
      info.isDying = true;
      info.channelLiveness?.stop();
      handleChannelTransportUnavailable(info);
    };
    void channel.transportFailed?.then(
      markTransportFailed,
      markTransportFailed,
    );
    channelLifecycle.track(info);
    // Belt-and-suspenders leak detection. The set is intentionally
    // multi-entry to cover the `killSession`-then-`spawnOrAttach`
    // overlap window (size 2 per engine is legitimate: one dying + one fresh
    // attach-target). Anything higher implies a `channel.exited`
    // handler never fired for some prior channel — a real leak we'd
    // otherwise notice only as gradually-growing RSS over hours.
    // The warning surfaces it the moment it happens. Threshold is
    // 2 per engine because that's the design ceiling; bumping it requires
    // updating both this guard and the comments around
    // `aliveChannels` declaration.
    const engineChannelCount = [...channelLifecycle.values()].filter(
      (candidate) => candidate.executionEngine === engine,
    ).length;
    if (engineChannelCount > 2) {
      writeStderrLine(
        `qwen serve: WARNING engine=${engine ?? 'single'} channelCount=${engineChannelCount} ` +
          `(expected 1, max 2 per engine during killSession-then-spawnOrAttach ` +
          `overlap) — possible channel leak; check that prior channels' ` +
          `channel.exited fired and the handler ran cleanup.`,
      );
    }

    // One-time channel.exited cleanup. The child dying takes ALL
    // multiplexed sessions with it — iterate `sessionIds` (snapshot
    // first to be safe against concurrent killSession during
    // iteration), publish `session_died` on each session's bus,
    // remove from byId / defaultEntry / pending tables.
    //
    // Registered BEFORE the `initialize` await so init-failure /
    // child-crash / late-shutdown all converge here. During
    // handshake `sessionIds` is empty — the cleanup loop no-ops,
    // the stderr line still fires, and `aliveChannels.delete(info)`
    // clears the entry through the normal exit path.
    //
    // BkUyD: drop from `aliveChannels` ONLY when the OS process is
    // actually gone. Async kill paths mark `isDying = true` but
    // leave the entry in `aliveChannels` until this handler fires,
    // so `killAllSync` still has a reference to fire SIGKILL during
    // the SIGTERM grace window — even if a concurrent `spawnOrAttach`
    // has already reassigned `channelInfo` to a fresh channel.
    void channel.exited.then((exitInfo) => {
      handleChannelExit(info, exitInfo);
    });

    // Initialize handshake. The channel is already in
    // `aliveChannels` and the `channel.exited` handler above is
    // registered, so failure paths (init throw, timeout, late
    // shutdown) only need to mark dying + kill — the handler does
    // the alive-set cleanup when the OS reaps the child.
    let channelLivenessNegotiated = false;
    try {
      await telemetry.withSpan(
        'channel.initialize',
        {
          'qwen-code.daemon.bridge.operation': 'channel.initialize',
          'qwen-code.daemon.acp_channel.id': acpChannelId,
        },
        async () => {
          const remainingStartupMs = Math.max(
            1,
            initTimeoutMs - (Date.now() - startupStartedAt),
          );
          const response = await withTimeout(
            Promise.race([
              connection.initialize(
                createChannelInitializeRequest(
                  privateParentCapability,
                  delegateReadTextFileToClient,
                ),
              ),
              channelUnavailableReject(channel, 'during initialize'),
            ]),
            remainingStartupMs,
            'initialize',
          );
          const capabilities = negotiateChannelCapabilities(
            response,
            isExternalToolGuardRequired(),
          );
          if (capabilities.activeWork) {
            info.activeWork = { ...capabilities.activeWork, seq: 0 };
          }
          channelLivenessNegotiated = capabilities.channelLiveness;
          try {
            const attributes = getChannelStartupProfileAttributes(
              response,
              Date.now(),
              initTimeoutMs,
            );
            if (attributes && telemetry.setActiveSpanAttributes) {
              telemetry.setActiveSpanAttributes(attributes);
            }
          } catch {
            // Startup profiling must not affect bridge behavior.
          }
          return response;
        },
      );
    } catch (err) {
      // Mark the half-initialized channel as dying/unavailable, then
      // kill it. Coalesced callers (`inFlightChannelSpawn` branch in
      // `ensureChannel`) observe the same rejection on this promise
      // and propagate it to their callers; the `inFlightSpawns`
      // tracker is cleared in `spawnOrAttach`'s finally so a follow-
      // up call retries cleanly. The `channel.exited` handler
      // registered earlier removes `info` from `aliveChannels` once
      // the OS reaps the child. `isDying` here is the cross-path
      // invariant marker (matches `killSession` / `doSpawn`-
      // newSession-failure / `shutdown`): "any channel in
      // `aliveChannels` with `isDying === true` is mid-teardown."
      info.isDying = true;
      startupAbort.abort(err);
      await terminateChannel(
        channel,
        initTimeoutMs,
        'channel initialization failure',
      ).catch(() => undefined);
      throw err;
    }

    if (info.isDying) {
      await channel.kill().catch(() => {});
      throw new BridgeChannelClosedError('during initialize');
    }

    // Late-shutdown re-check: if shutdown flipped during the
    // handshake, tear this channel down rather than leak past
    // `process.exit(0)`. Same cleanup pattern as the init-failure
    // path: mark dying + kill, let the exited handler reap.
    if (isShuttingDown()) {
      info.isDying = true;
      startupAbort.abort(new Error('AcpSessionBridge is shutting down'));
      await terminateChannel(channel, initTimeoutMs, 'late shutdown').catch(
        () => undefined,
      );
      throw new Error('AcpSessionBridge is shutting down');
    }
    if (!channelLifecycle.has(info)) {
      info.isDying = true;
      const error = new BridgeChannelClosedError(
        'during channel initialization',
      );
      startupAbort.abort(error);
      await terminateChannel(
        channel,
        initTimeoutMs,
        'exited during initialization',
      ).catch(() => undefined);
      throw error;
    }

    // Handshake succeeded — now publish the channel as the
    // attach-available slot. `channelInfo` is assigned LAST so
    // `ensureChannel`'s fast-path (`if (channelInfo && !.isDying)`)
    // never returns a still-handshaking channel to a concurrent
    // caller.
    const previousRuntimeEpoch = runtimeEpochSource.current();
    const nextRuntimeEpoch = runtimeEpochSource.allocate();
    if (
      !Number.isSafeInteger(previousRuntimeEpoch) ||
      previousRuntimeEpoch < runtimeEpoch ||
      !Number.isSafeInteger(nextRuntimeEpoch) ||
      nextRuntimeEpoch <= previousRuntimeEpoch
    ) {
      info.isDying = true;
      const epochError = new Error(
        `Runtime epoch source must increase monotonically (local=${runtimeEpoch}, current=${previousRuntimeEpoch}, next=${nextRuntimeEpoch}).`,
      );
      startupAbort.abort(epochError);
      await terminateChannel(
        channel,
        initTimeoutMs,
        'invalid runtime epoch',
      ).catch(() => undefined);
      throw epochError;
    }
    runtimeEpoch = nextRuntimeEpoch;
    info.lastUsedAt = Date.now();
    channelLifecycle.publish(info);
    info.handshakeComplete = true;
    if (channelLivenessNegotiated) {
      const failChannelLiveness = (error: ChannelLivenessFailure) => {
        if (info.isDying || !channelLifecycle.has(info)) return;
        markTransportFailed(error);
        telemetry.event('channel.liveness_failed', {
          'qwen-code.daemon.acp_channel.id': info.id,
          'qwen-code.daemon.channel.session_count': sessionCount(info),
          'qwen-code.daemon.channel.transport_error_code': error.code,
        });
        writeStderrLine(
          `qwen serve: channel liveness failed (${error.code}); killing channel`,
        );
        if (info.channel.transportGuard) {
          info.channel.transportGuard.fail(error);
        } else {
          void killChannelWithLog(info, 'channel liveness failure');
        }
      };
      info.channelLiveness = startChannelLivenessMonitor({
        probe: (nonce) =>
          info.connection.extMethod(SERVE_STATUS_EXT_METHODS.channelPing, {
            v: CHANNEL_LIVENESS_VERSION,
            nonce,
          }),
        onFailure: failChannelLiveness,
        isActive: () =>
          channelLifecycle.currentFor(engine) === info &&
          channelLifecycle.has(info) &&
          !info.isDying &&
          !isShuttingDown(),
      });
    }
    telemetry.metrics?.channelLifecycle('spawn');
    return info;
  }

  return {
    get epoch() {
      return runtimeEpoch;
    },
    start,
  };
}
