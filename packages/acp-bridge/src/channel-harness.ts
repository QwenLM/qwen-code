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
import { writeStderrLine } from './internal/stderrLine.js';

interface ChannelWorkExclusions {
  ignoreCurrentSessionSpawn?: boolean;
  ignoreRestoreId?: string;
}

interface ChannelHarnessOptions
  extends Omit<
    ChannelStartupOptions,
    'channelLifecycle' | 'killChannelWithLog' | 'handleChannelExit'
  > {
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
  const channelLifecycle = createChannelLifecycle();
  let keepAliveUntil = 0;
  let runtimeOperationReservations = 0;
  const pendingKeepAliveDeadlines = new Map<symbol, number>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function liveHarnessChannel(): HarnessChannel | undefined {
    const channel = channelLifecycle.current;
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
      runtimeOperationReservations === 0
    );
  }

  function cancelIdleTimer(): void {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  }

  async function killChannelWithLog(
    ci: HarnessChannel,
    context?: string,
  ): Promise<void> {
    ci.isDying = true;
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

  function resolvedChannelIdleTimeoutMs(): number {
    const configured = configuredChannelIdleTimeoutMs();
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
  ): Promise<void> {
    if (ci.isDying || liveHarnessChannel() !== ci) return;
    const timeoutMs = resolvedChannelIdleTimeoutMs();
    if (timeoutMs <= 0) {
      await killChannelWithLog(ci, context);
      return;
    }
    cancelIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (hasNoChannelWork(ci)) {
        writeStderrLine(
          `qwen serve: idle timeout (${timeoutMs}ms) expired, killing channel`,
        );
        void killChannelWithLog(ci, 'idle timeout');
      }
    }, timeoutMs);
    idleTimer.unref();
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
  ): Promise<T> {
    if (liveHarnessChannel() === ci) cancelIdleTimer();
    ci.workspaceControlInFlight++;
    try {
      return await fn();
    } catch (error) {
      await retireChannelOnTimeout(ci, error, 'workspace control timeout');
      throw error;
    } finally {
      ci.workspaceControlInFlight = Math.max(
        0,
        ci.workspaceControlInFlight - 1,
      );
      await reapPendingEmptyChannel(ci);
      if (!ci.isDying && liveHarnessChannel() === ci && hasNoChannelWork(ci)) {
        await startIdleTimer(ci, 'workspace control');
      }
    }
  }

  async function settleReleasedRuntimeWork(
    context: string,
    armIdleTimer = true,
  ): Promise<void> {
    for (const ci of Array.from(channelLifecycle.values())) {
      await reapPendingEmptyChannel(ci);
    }
    if (!armIdleTimer) return;
    const ci = liveHarnessChannel();
    if (ci && hasNoChannelWork(ci)) {
      await startIdleTimer(ci, context);
    }
  }

  async function releaseRuntimeOperationReservation(
    context: string,
  ): Promise<void> {
    runtimeOperationReservations = Math.max(
      0,
      runtimeOperationReservations - 1,
    );
    await settleReleasedRuntimeWork(context);
  }

  /**
   * Get-or-create the daemon's single `qwen --acp` channel. N sessions
   * multiplex onto it via `connection.newSession()`. Concurrent callers
   * coalesce through `inFlightChannelSpawn` so we never spawn two
   * children. Wires up the one-and-only `channel.exited` cleanup on
   * first creation so the late-arriving event tears down ALL
   * multiplexed sessions.
   */
  async function ensureChannel(): Promise<HarnessChannel> {
    if (isShuttingDown()) {
      throw new Error('AcpSessionBridge is shutting down');
    }
    // Skip a channel that's marked dying — its underlying transport is
    // mid-SIGTERM-or-already-dead and `connection.newSession()` on it
    // would either hang or land the caller with a sessionId that
    // immediately 404s on every follow-up.
    cancelIdleTimer();
    if (channelLifecycle.current && !channelLifecycle.current.isDying)
      return channelLifecycle.current;
    if (channelLifecycle.starting) return await channelLifecycle.starting;

    const promise = channelLifecycle.startSpawn(channelStartup.start);
    try {
      return await promise;
    } finally {
      channelLifecycle.finishSpawn();
    }
  }

  const preheat: NonNullable<AcpSessionBridge['preheat']> = async (options) => {
    if (isShuttingDown()) {
      throw new Error('AcpSessionBridge is shutting down');
    }
    runtimeOperationReservations++;
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
    try {
      await telemetry.withSpan(
        'channel.preheat',
        { 'qwen-code.daemon.bridge.operation': 'channel.preheat' },
        async () => {
          await ensureChannel();
          if (keepAliveMs !== undefined) {
            keepAliveUntil = Math.max(keepAliveUntil, Date.now() + keepAliveMs);
          }
        },
      );
    } finally {
      if (pendingKeepAliveToken) {
        pendingKeepAliveDeadlines.delete(pendingKeepAliveToken);
      }
      runtimeOperationReservations = Math.max(
        0,
        runtimeOperationReservations - 1,
      );
      await settleReleasedRuntimeWork(
        'channel preheat',
        resolvedChannelIdleTimeoutMs() > 0,
      );
    }
  };

  const channelStartup = createChannelStartup({
    ...options,
    channelLifecycle,
    killChannelWithLog,
    handleChannelExit(info, exitInfo) {
      info.channelLiveness?.stop();
      options.handleChannelTransportUnavailable(info);
      if (channelLifecycle.current === info) cancelIdleTimer();
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
    get epoch() {
      return channelStartup.epoch;
    },
    get runtimeOperationReservations() {
      return runtimeOperationReservations;
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
    reserveRuntimeOperation() {
      runtimeOperationReservations++;
    },
    releaseRuntimeOperationReservation,
    settleReleasedRuntimeWork,
    preheat,
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
