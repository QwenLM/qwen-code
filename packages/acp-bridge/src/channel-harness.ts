/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NewSessionRequest } from '@agentclientprotocol/sdk';
import {
  ShellExecutionService,
  type ShellOutputEvent,
} from '@qwen-code/qwen-code-core';
import { createHarnessConnection } from './channel-connection.js';
import {
  WORKTREE_MCP_DEFER_META_KEY,
  type ChangeSessionCwdRequest,
  type AcpSessionBridge,
} from './bridgeTypes.js';
import type { AcpChannelExitInfo } from './channel.js';
import {
  createChannelLifecycle,
  type HarnessChannel,
} from './channel-lifecycle.js';
import {
  createChannelStartup,
  type ChannelStartupOptions,
} from './channel-startup.js';
import { BridgeTimeoutError, SERVE_CONTROL_EXT_METHODS } from './status.js';
import { terminateChannel } from './channel-transport.js';
import { WorkspaceDrainingError } from './bridgeErrors.js';
import { writeStderrLine } from './internal/stderrLine.js';
import type { BridgeExecutionEngine } from './bridgeOptions.js';

export interface ChannelWorkExclusions {
  ignoreCurrentSessionSpawn?: boolean;
  ignoreRestoreId?: string;
}

interface ChannelHarnessOptions
  extends Omit<
    ChannelStartupOptions,
    'channelLifecycle' | 'killChannelWithLog' | 'handleChannelExit'
  > {
  isRuntimeStopping(): boolean;
  beforeChannelExit(info: HarnessChannel): void;
  handleChannelExit(
    info: HarnessChannel,
    exitInfo: AcpChannelExitInfo | undefined,
  ): void;
  hasNoSessionWork(
    info: HarnessChannel,
    exclusions?: ChannelWorkExclusions,
  ): boolean;
  hasNoWorkspaceWork(info: HarnessChannel): boolean;
  channelShouldReapWhenIdle(info: HarnessChannel): boolean;
  getChannelIdleTimeoutMs(): number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createChannelHarness(options: ChannelHarnessOptions) {
  const {
    initTimeoutMs,
    telemetry,
    isShuttingDown,
    hasNoSessionWork,
    hasNoWorkspaceWork,
    channelShouldReapWhenIdle,
    sessionCount,
  } = options;
  const defaultEngine = options.executionEngines ? 'legacy' : undefined;
  const channelLifecycle = createChannelLifecycle(defaultEngine);
  let keepAliveUntil = 0;
  const runtimeOperationReservations = new Map<
    BridgeExecutionEngine | undefined,
    number
  >();
  const pendingKeepAliveDeadlines = new Map<symbol, number>();
  const idleTimers = new Map<HarnessChannel, ReturnType<typeof setTimeout>>();
  const pendingIdleTimers = new Set<HarnessChannel>();

  function liveHarnessChannel(
    engine: BridgeExecutionEngine | undefined = defaultEngine,
  ): HarnessChannel | undefined {
    const channel = channelLifecycle.currentFor(engine);
    return channel && !channel.isDying ? channel : undefined;
  }

  function hasNoChannelWork(
    ci: HarnessChannel,
    exclusions?: ChannelWorkExclusions,
  ): boolean {
    if (!hasNoSessionWork(ci, exclusions)) return false;
    if (ci.retireWhenSessionsDrain) return true;
    return (
      ci.workspaceControlInFlight === 0 &&
      hasNoWorkspaceWork(ci) &&
      (runtimeOperationReservations.get(ci.executionEngine) ?? 0) === 0
    );
  }

  function cancelIdleTimer(channel?: HarnessChannel): void {
    if (channel) pendingIdleTimers.delete(channel);
    else pendingIdleTimers.clear();
    for (const [owner, timer] of idleTimers) {
      if (channel !== undefined && owner !== channel) continue;
      clearTimeout(timer);
      idleTimers.delete(owner);
    }
  }

  async function killChannelWithLog(
    ci: HarnessChannel,
    context?: string,
  ): Promise<void> {
    ci.isDying = true;
    cancelIdleTimer(ci);
    ci.channelLiveness?.stop();
    await terminateChannel(
      ci.channel,
      initTimeoutMs,
      context ?? 'channel kill',
    ).catch((err) => {
      writeStderrLine(
        `qwen serve: channel kill failed${context ? ` (${context})` : ''}: ${String(err)}`,
      );
    });
  }

  async function retireChannelAfterSessionsDrain(
    ci: HarnessChannel,
    context: string,
  ): Promise<void> {
    if (ci.isDying) return;
    if (hasNoSessionWork(ci)) {
      await killChannelWithLog(ci, context);
      return;
    }
    ci.retireWhenSessionsDrain = true;
    writeStderrLine(
      `qwen serve: ${context}; deferring channel retirement until ${sessionCount(ci)} active session(s) drain`,
    );
  }

  async function retireChannelOnTimeout(
    ci: HarnessChannel,
    error: unknown,
    context: string,
  ): Promise<void> {
    if (error instanceof BridgeTimeoutError && !ci.isDying) {
      await retireChannelAfterSessionsDrain(ci, context);
    }
  }

  function configuredChannelIdleTimeoutMs(): number {
    const raw = options.getChannelIdleTimeoutMs();
    return raw !== undefined && Number.isFinite(raw) && raw > 0
      ? Math.min(raw, 2_147_483_647)
      : 0;
  }

  function resolvedChannelIdleTimeoutMs(engine = defaultEngine): number {
    const configured = configuredChannelIdleTimeoutMs();
    if (engine !== defaultEngine) return configured;
    const now = Date.now();
    let pendingKeepAliveMs = 0;
    for (const deadline of pendingKeepAliveDeadlines.values()) {
      pendingKeepAliveMs = Math.max(pendingKeepAliveMs, deadline - now);
    }
    return Math.max(configured, keepAliveUntil - now, pendingKeepAliveMs);
  }

  async function startIdleTimer(
    ci: HarnessChannel,
    context?: string,
    exclusions?: ChannelWorkExclusions,
  ): Promise<void> {
    if (
      options.isRuntimeStopping() ||
      ci.isDying ||
      liveHarnessChannel(ci.executionEngine) !== ci
    )
      return;
    if (!hasNoChannelWork(ci, exclusions)) {
      pendingIdleTimers.add(ci);
      return;
    }
    cancelIdleTimer(ci);
    const timeoutMs = resolvedChannelIdleTimeoutMs(ci.executionEngine);
    if (timeoutMs <= 0) {
      await killChannelWithLog(ci, context);
      return;
    }
    const idleTimer = setTimeout(() => {
      idleTimers.delete(ci);
      if (hasNoChannelWork(ci)) {
        writeStderrLine(
          `qwen serve: idle timeout (${timeoutMs}ms) expired, killing channel`,
        );
        void killChannelWithLog(ci, 'idle timeout');
      } else {
        pendingIdleTimers.add(ci);
      }
    }, timeoutMs);
    idleTimers.set(ci, idleTimer);
    idleTimer.unref();
  }

  function retireChannel(info: HarnessChannel, context: string) {
    info.isDying = true;
    cancelIdleTimer(info);
    if (info.executionEngine === defaultEngine) keepAliveUntil = 0;
    info.channelLiveness?.stop();
    return terminateChannel(info.channel, initTimeoutMs, context);
  }

  async function reapPendingEmptyChannel(
    ci: HarnessChannel,
    opts?: { ignoreRestoreId?: string },
  ): Promise<void> {
    if (!channelShouldReapWhenIdle(ci) || !hasNoChannelWork(ci, opts)) return;
    ci.emptyReapPending = false;
    ci.isDying = true;
    ci.channelLiveness?.stop();
    await terminateChannel(
      ci.channel,
      initTimeoutMs,
      'pending empty channel',
    ).catch(() => {
      /* best-effort — channel.exited handler still runs */
    });
  }

  async function withWorkspaceControl<T>(
    ci: HarnessChannel,
    fn: () => Promise<T>,
    recordUse = true,
  ): Promise<T> {
    if (options.isRuntimeStopping())
      throw new WorkspaceDrainingError(options.boundWorkspace ?? '');
    if (liveHarnessChannel(ci.executionEngine) === ci) cancelIdleTimer(ci);
    if (recordUse) ci.lastUsedAt = Date.now();
    ci.workspaceControlInFlight++;
    try {
      return await fn();
    } catch (error) {
      await retireChannelOnTimeout(ci, error, 'workspace control timeout');
      throw error;
    } finally {
      if (recordUse) ci.lastUsedAt = Date.now();
      ci.workspaceControlInFlight = Math.max(
        0,
        ci.workspaceControlInFlight - 1,
      );
      await reapPendingEmptyChannel(ci);
      if (!ci.isDying && liveHarnessChannel(ci.executionEngine) === ci) {
        await startIdleTimer(ci, 'workspace control');
      }
    }
  }

  async function settleReleasedRuntimeWork(context: string): Promise<void> {
    const channels = Array.from(channelLifecycle.values());
    for (const ci of channels) {
      await reapPendingEmptyChannel(ci);
    }
    for (const ci of channels) {
      if (
        !ci.isDying &&
        pendingIdleTimers.has(ci) &&
        !idleTimers.has(ci) &&
        hasNoChannelWork(ci)
      ) {
        await startIdleTimer(ci, context);
      }
    }
  }

  function reserveRuntimeOperation(
    engine: BridgeExecutionEngine | undefined = defaultEngine,
  ): void {
    runtimeOperationReservations.set(
      engine,
      (runtimeOperationReservations.get(engine) ?? 0) + 1,
    );
  }

  function decrementRuntimeOperationReservation(
    engine: BridgeExecutionEngine | undefined = defaultEngine,
  ): void {
    const remaining = (runtimeOperationReservations.get(engine) ?? 0) - 1;
    if (remaining > 0) runtimeOperationReservations.set(engine, remaining);
    else runtimeOperationReservations.delete(engine);
  }

  async function releaseRuntimeOperationReservation(
    context: string,
    engine: BridgeExecutionEngine | undefined = defaultEngine,
  ): Promise<void> {
    decrementRuntimeOperationReservation(engine);
    const channel = liveHarnessChannel(engine);
    if (channel) pendingIdleTimers.add(channel);
    await settleReleasedRuntimeWork(context);
  }

  /**
   * Get-or-create the selected engine's ACP channel. N sessions
   * multiplex onto it via `connection.newSession()`. Concurrent callers
   * coalesce through `inFlightChannelSpawn` so we never spawn two
   * children. Wires up the one-and-only `channel.exited` cleanup on
   * first creation so the late-arriving event tears down ALL
   * multiplexed sessions.
   */
  async function ensureChannel(
    engine: BridgeExecutionEngine | undefined = defaultEngine,
  ): Promise<HarnessChannel> {
    if (options.isRuntimeStopping())
      throw new WorkspaceDrainingError(options.boundWorkspace ?? '');
    if (isShuttingDown()) {
      throw new Error('AcpSessionBridge is shutting down');
    }
    // Skip a channel that's marked dying — its underlying transport is
    // mid-SIGTERM-or-already-dead and `connection.newSession()` on it
    // would either hang or land the caller with a sessionId that
    // immediately 404s on every follow-up.
    const current = channelLifecycle.currentFor(engine);
    if (current) cancelIdleTimer(current);
    if (current && !current.isDying) return current;
    const starting = channelLifecycle.startingFor(engine);
    if (starting) return await starting;

    const promise = channelLifecycle.startSpawn(
      () => channelStartup.start(engine),
      engine,
    );
    try {
      return await promise;
    } finally {
      channelLifecycle.finishSpawn(engine);
    }
  }

  const preheat: NonNullable<AcpSessionBridge['preheat']> = async (options) => {
    if (isShuttingDown()) {
      throw new Error('AcpSessionBridge is shutting down');
    }
    reserveRuntimeOperation();
    const rawKeepAliveMs = options?.keepAliveMs;
    const keepAliveMs =
      rawKeepAliveMs !== undefined &&
      Number.isFinite(rawKeepAliveMs) &&
      rawKeepAliveMs > 0
        ? Math.min(rawKeepAliveMs, 2_147_483_647)
        : undefined;
    const pendingKeepAliveToken =
      keepAliveMs === undefined ? undefined : Symbol();
    if (pendingKeepAliveToken && keepAliveMs !== undefined) {
      pendingKeepAliveDeadlines.set(
        pendingKeepAliveToken,
        Date.now() + keepAliveMs,
      );
    }
    let channel: HarnessChannel | undefined;
    try {
      await telemetry.withSpan(
        'channel.preheat',
        { 'qwen-code.daemon.bridge.operation': 'channel.preheat' },
        async () => {
          const info = await ensureChannel();
          channel = info;
          info.lastUsedAt = Date.now();
          if (keepAliveMs !== undefined) {
            keepAliveUntil = Math.max(keepAliveUntil, Date.now() + keepAliveMs);
          }
        },
      );
    } finally {
      if (pendingKeepAliveToken) {
        pendingKeepAliveDeadlines.delete(pendingKeepAliveToken);
      }
      decrementRuntimeOperationReservation();
      if (
        channel &&
        channelLifecycle.has(channel) &&
        resolvedChannelIdleTimeoutMs() > 0
      ) {
        pendingIdleTimers.add(channel);
      }
      await settleReleasedRuntimeWork('channel preheat');
    }
  };

  const channelStartup = createChannelStartup({
    ...options,
    channelLifecycle,
    killChannelWithLog,
    handleChannelExit(info, exitInfo) {
      info.channelLiveness?.stop();
      options.handleChannelTransportUnavailable(info);
      cancelIdleTimer(info);
      options.beforeChannelExit(info);
      channelLifecycle.remove(info);
      options.handleChannelExit(info, exitInfo);
    },
  });

  return {
    get current() {
      return channelLifecycle.current;
    },
    get starting() {
      return channelLifecycle.starting;
    },
    currentFor: channelLifecycle.currentFor,
    startingFor: channelLifecycle.startingFor,
    startups: channelLifecycle.startups,
    get epoch() {
      return channelStartup.epoch;
    },
    get runtimeOperationReservations() {
      return Array.from(runtimeOperationReservations.values()).reduce(
        (total, count) => total + count,
        0,
      );
    },
    get pendingKeepAliveCount() {
      return pendingKeepAliveDeadlines.size;
    },
    createConnection: createHarnessConnection,
    withWorktreeInitialization(
      request: NewSessionRequest,
      worktree: boolean,
    ): NewSessionRequest {
      return worktree
        ? {
            ...request,
            _meta: {
              ...(isRecord(request._meta) ? request._meta : {}),
              [WORKTREE_MCP_DEFER_META_KEY]: true,
            },
          }
        : request;
    },
    changeSessionCwd(
      channel: HarnessChannel,
      sessionId: string,
      req: ChangeSessionCwdRequest,
    ) {
      return channel.connection.extMethod(SERVE_CONTROL_EXT_METHODS.sessionCd, {
        sessionId,
        path: req.path,
        ...(req.allowedRoots ? { allowedRoots: req.allowedRoots } : {}),
        ...(req.managedRelocation
          ? { managedRelocation: req.managedRelocation }
          : {}),
        ...(req.conversationDirectoryExpectation
          ? {
              conversationDirectoryExpectation:
                req.conversationDirectoryExpectation,
            }
          : {}),
      });
    },
    executeShell(
      command: string,
      cwd: string,
      onOutput: (event: ShellOutputEvent) => void,
      signal: AbortSignal,
    ) {
      return ShellExecutionService.execute(
        command,
        cwd,
        onOutput,
        signal,
        false,
        { terminalWidth: 120, terminalHeight: 40 },
        { streamStdout: true },
      );
    },
    values: channelLifecycle.values,
    has: channelLifecycle.has,
    ensure: ensureChannel,
    configuredChannelIdleTimeoutMs,
    cancelIdleTimer,
    startIdleTimer,
    killChannelWithLog,
    retireChannelAfterSessionsDrain,
    retireChannelOnTimeout,
    hasNoChannelWork,
    reapPendingEmptyChannel,
    withWorkspaceControl,
    reserveRuntimeOperation,
    releaseRuntimeOperationReservation,
    settleReleasedRuntimeWork,
    preheat,
    reclaimIdleChannel(info: HarnessChannel) {
      // Retire only this child; shutdown would permanently seal the bridge.
      writeStderrLine(`qwen serve: reclaiming idle ACP channel ${info.id}`);
      return retireChannel(info, 'capacity reclamation');
    },
    stopChannel(info: HarnessChannel) {
      return retireChannel(info, 'user-confirmed workspace stop');
    },
    markDying(channels: readonly HarnessChannel[]) {
      for (const ci of channels) {
        ci.isDying = true;
        ci.channelLiveness?.stop();
      }
    },
    killAllSync(channels: readonly HarnessChannel[]) {
      for (const info of channels) {
        info.channelLiveness?.stop();
        try {
          info.channel.killSync();
        } catch {
          /* best-effort — already-dead child / pid race */
        }
      }
    },
    terminate(channel: HarnessChannel) {
      return terminateChannel(
        channel.channel,
        initTimeoutMs,
        'bridge shutdown',
      );
    },
  };
}
