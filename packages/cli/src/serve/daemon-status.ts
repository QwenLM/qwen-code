/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ServeProtocolVersions } from './capabilities.js';
import type { AcpHttpHandle } from './acp-http/index.js';
import type { DeviceFlowRegistry } from './auth/device-flow.js';
import type { DaemonLogger } from './daemon-logger.js';
import type {
  AcpSessionBridge,
  BridgeDaemonStatusSnapshot,
} from './acp-session-bridge.js';
import { isLoopbackBind } from './loopback-binds.js';
import type { RateLimiterInstance, RateLimitTier } from './rate-limit.js';
import type { ServeOptions } from './types.js';
import type { ChannelWorkerSnapshot } from './channel-worker-supervisor.js';
import type { DaemonMetricsBucket } from './daemon-metrics-ring.js';
import type {
  DaemonWorkspaceService,
  WorkspaceRequestContext,
} from './workspace-service/index.js';
import type { TotalSessionAdmissionSnapshot } from './total-session-admission.js';
import type { WorkspaceRegistry } from './workspace-registry.js';

// Re-export so downstream consumers (server.ts, routes, the SDK type mirror)
// import the bucket shape from the status module alongside the rest of the
// response contract, matching how DaemonPerfSnapshot is sourced.
export type { DaemonMetricsBucket };

const DEFAULT_LISTENER_MAX_CONNECTIONS = 256;
const SECTION_TIMEOUT_MS = 1_000;
const CAPACITY_WARNING_RATIO = 0.8;

export type DaemonStatusDetail = 'summary' | 'full';
export type DaemonStatusLevel = 'ok' | 'warning' | 'error';
type SectionStatus = DaemonStatusLevel | 'unavailable';
type IssueSeverity = 'warning' | 'error';
type SectionSummary = Record<string, string | number | boolean | null>;
type StatusRecord = Record<string, unknown>;

export type DaemonStartupPreheatStatus =
  | 'external_bridge'
  | 'not_scheduled'
  | 'scheduled'
  | 'running'
  | 'succeeded'
  | 'failed';

export interface DaemonStartupSnapshot {
  processStartedAt: string;
  listenerReadyAt?: string;
  processToListenMs?: number;
  runQwenServeToListenMs?: number;
  preheat: {
    status: DaemonStartupPreheatStatus;
    durationMs?: number;
    error?: string;
  };
}

export interface DaemonStatusIssue {
  code:
    | 'session_capacity_high'
    | 'total_session_capacity_high'
    | 'connection_capacity_high'
    | 'pending_permissions'
    | 'acp_channel_down'
    | 'preflight_error'
    | 'mcp_budget_warning'
    | 'mcp_budget_exhausted'
    | 'rate_limit_hits'
    | 'workspace_status_unavailable'
    | 'channel_worker_exited'
    | 'channel_worker_partial_connect'
    | 'daemon_runtime_starting'
    | 'daemon_runtime_failed';
  severity: IssueSeverity;
  message: string;
  section?: string;
}

export interface ParseDaemonStatusDetailResult {
  ok: boolean;
  detail?: DaemonStatusDetail;
}

export interface BuildDaemonStatusOptions {
  opts: ServeOptions;
  boundWorkspace: string;
  bridge: AcpSessionBridge;
  workspaceRegistry?: WorkspaceRegistry;
  workspace: DaemonWorkspaceService;
  daemonLog?: DaemonLogger;
  qwenCodeVersion?: string;
  acpHandle?: AcpHttpHandle;
  rateLimiter?: RateLimiterInstance;
  getRestSseActive: () => number;
  features: readonly string[];
  protocolVersions: ServeProtocolVersions;
  supportedDeviceFlowProviders: readonly string[];
  deviceFlowRegistry: DeviceFlowRegistry;
  sessionShellCommandEnabled: boolean;
  startup?: DaemonStartupSnapshot;
  getChannelWorkerSnapshot?: () => ChannelWorkerSnapshot;
  getPerfSnapshot?: () => DaemonPerfSnapshot;
  getMetricsSeries?: () => DaemonMetricsBucket[];
  getTotalSessionAdmissionSnapshot?: () => TotalSessionAdmissionSnapshot;
}

interface DaemonStatusSection<T> {
  status: SectionStatus;
  durationMs: number;
  summary?: SectionSummary;
  data?: T;
  error?: {
    kind: 'timeout' | 'error';
    message: string;
  };
}

type WorkspaceStatusSection = DaemonStatusSection<unknown>;

interface FullDaemonStatus {
  sessions: BridgeDaemonStatusSnapshot['sessions'];
  acpConnections: NonNullable<
    ReturnType<AcpHttpHandle['registry']['getSnapshot']>
  >['connections'];
  workspace: Record<string, WorkspaceStatusSection>;
  auth: {
    supportedDeviceFlowProviders: string[];
    pendingDeviceFlowCount: number;
  };
}

interface WorkspaceBridgeStatusSnapshot {
  workspaceCwd: string;
  snapshot: BridgeDaemonStatusSnapshot;
  lastActivity: number | null;
}

interface DaemonStatusSecurity {
  tokenConfigured: boolean;
  requireAuth: boolean;
  loopbackBind: boolean;
  allowOriginConfigured: boolean;
  allowOriginMode: string;
  sessionShellCommandEnabled: boolean;
}

interface DaemonStatusLimits {
  maxSessions: number | null;
  maxTotalSessions: number | null;
  maxPendingPromptsPerSession: number | null;
  listenerMaxConnections: number | null;
  eventRingSize: number;
  compactedReplayMaxBytes: number;
  promptDeadlineMs: number | null;
  writerIdleTimeoutMs: number | null;
  channelIdleTimeoutMs: number;
  sessionIdleTimeoutMs: number;
  acpConnectionCap: number | null;
}

interface DaemonStatusRuntime {
  loading?: boolean;
  error?: string;
  sessions: { active: number; admissionInFlight?: number };
  permissions: {
    pending: number;
    policy: string;
  };
  channel: { live: boolean };
  channelWorker: ChannelWorkerSnapshot;
  transport: {
    restSseActive: number;
    acp: {
      enabled: boolean;
      connections: number;
      connectionStreams: number;
      sessionStreams: number;
      sseStreams: number;
      wsStreams: number;
      pendingClientRequests: number;
    };
  };
  rateLimit: {
    enabled: boolean;
    rejectedSinceStart: Record<RateLimitTier, number>;
  };
  perf?: DaemonPerfSnapshot;
  /**
   * Rolling per-interval activity series backing the Daemon Status charts
   * (requests, latency, tokens, memory over time). Optional/additive to v=1:
   * absent when the daemon predates it or the sampler has not sealed a bucket
   * yet. Ordered oldest→newest.
   */
  metrics?: { series: DaemonMetricsBucket[] };
  activity: {
    activePrompts: number;
    pendingPrompts: number;
    queuedPrompts: number;
    lastActivityAt: string | null;
    idleSinceMs: number | null;
  };
  process: NodeJS.MemoryUsage;
}

export interface DaemonPipeStatsSnapshot {
  count: number;
  totalBytes: number;
  maxBytes: number;
}

export interface DaemonPerfSnapshot {
  eventLoop: {
    meanMs: number;
    p50Ms: number;
    p99Ms: number;
    maxMs: number;
  };
  promptQueueWait: {
    count: number;
    meanMs: number;
    maxMs: number;
    lastMs: number | null;
  };
  pipe: {
    inbound: DaemonPipeStatsSnapshot;
    outbound: DaemonPipeStatsSnapshot;
  };
}

export interface DaemonStatusResponse {
  v: 1;
  detail: DaemonStatusDetail;
  generatedAt: string;
  status: DaemonStatusLevel;
  issues: DaemonStatusIssue[];
  daemon: StatusRecord & {
    pid: number;
    uptimeMs: number;
    mode: ServeOptions['mode'];
    workspaceCwd: string;
  };
  security: DaemonStatusSecurity;
  limits: DaemonStatusLimits;
  workspaces?: Array<{
    id: string;
    cwd: string;
    primary: boolean;
    trusted: boolean;
  }>;
  capabilities: {
    protocolVersions: ServeProtocolVersions;
    features: string[];
  };
  runtime: DaemonStatusRuntime;
  full?: FullDaemonStatus;
}

class SectionTimeoutError extends Error {
  constructor(
    readonly section: string,
    readonly timeoutMs: number,
  ) {
    super(`${section} status timed out after ${timeoutMs}ms`);
    this.name = 'SectionTimeoutError';
  }
}

export function parseDaemonStatusDetail(
  raw: unknown,
): ParseDaemonStatusDetailResult {
  if (raw === undefined) return { ok: true, detail: 'summary' };
  if (raw === 'summary' || raw === 'full') {
    return { ok: true, detail: raw };
  }
  return { ok: false };
}

export async function buildDaemonStatusResponse(
  detail: DaemonStatusDetail,
  input: BuildDaemonStatusOptions,
): Promise<DaemonStatusResponse> {
  const bridgeSnapshot = input.bridge.getDaemonStatusSnapshot();
  const lastActivity = input.bridge.lastActivityAt ?? null;
  const workspaceRuntimes = input.workspaceRegistry?.list();
  const workspaceSnapshots: WorkspaceBridgeStatusSnapshot[] =
    workspaceRuntimes?.map((runtime) => ({
      workspaceCwd: runtime.workspaceCwd,
      snapshot:
        runtime.bridge === input.bridge
          ? bridgeSnapshot
          : runtime.bridge.getDaemonStatusSnapshot(),
      lastActivity:
        runtime.bridge === input.bridge
          ? lastActivity
          : (runtime.bridge.lastActivityAt ?? null),
    })) ?? [
      {
        workspaceCwd: input.boundWorkspace,
        snapshot: bridgeSnapshot,
        lastActivity,
      },
    ];
  const aggregatedSessionCount = workspaceSnapshots.reduce(
    (sum, item) => sum + item.snapshot.sessionCount,
    0,
  );
  const aggregatedPendingPermissionCount = workspaceSnapshots.reduce(
    (sum, item) => sum + item.snapshot.pendingPermissionCount,
    0,
  );
  const aggregatedChannelLive = workspaceSnapshots.some(
    (item) => item.snapshot.channelLive,
  );
  const aggregatedLastActivity = workspaceSnapshots.reduce<number | null>(
    (latest, item) =>
      item.lastActivity !== null &&
      (latest === null || item.lastActivity > latest)
        ? item.lastActivity
        : latest,
    null,
  );
  const acpSnapshot = input.acpHandle?.registry.getSnapshot();
  // Aggregate across all mounts (primary + trusted secondaries) so the transport
  // summary matches the metrics sampler; the per-connection diagnostics and the
  // connection cap below stay primary-scoped.
  const acpAggregate = input.acpHandle?.getSnapshot();
  const rateLimitHits = input.rateLimiter?.getHitCounts() ?? zeroRateHits();
  let pendingPrompts = 0;
  let derivedQueuedPrompts = 0;
  const derivedQueuedPromptsByWorkspace: number[] = [];
  for (const [index, { snapshot }] of workspaceSnapshots.entries()) {
    let derivedQueuedPromptsForWorkspace = 0;
    for (const session of snapshot.sessions) {
      pendingPrompts += session.pendingPromptCount;
      const sessionQueuedPrompts = Math.max(
        0,
        session.pendingPromptCount - (session.hasActivePrompt ? 1 : 0),
      );
      derivedQueuedPrompts += sessionQueuedPrompts;
      derivedQueuedPromptsForWorkspace += sessionQueuedPrompts;
    }
    derivedQueuedPromptsByWorkspace[index] = derivedQueuedPromptsForWorkspace;
  }
  const queuedPrompts =
    workspaceRuntimes?.reduce(
      (sum, runtime, index) =>
        sum +
        (runtime.bridge.pendingPromptTotal ??
          derivedQueuedPromptsByWorkspace[index] ??
          0),
      0,
    ) ??
    input.bridge.pendingPromptTotal ??
    derivedQueuedPrompts;
  const channelWorker = input.getChannelWorkerSnapshot?.() ?? {
    enabled: false,
    state: 'disabled',
    channels: [],
  };
  const totalAdmissionSnapshot = input.getTotalSessionAdmissionSnapshot?.();
  const issues: DaemonStatusIssue[] = [];
  let full: FullDaemonStatus | undefined;

  pushRuntimeIssues(
    issues,
    acpSnapshot,
    rateLimitHits,
    input,
    channelWorker,
    totalAdmissionSnapshot,
    workspaceSnapshots,
  );

  if (detail === 'full') {
    full = await buildFullStatus(
      input,
      acpSnapshot,
      workspaceSnapshots.flatMap((item) => item.snapshot.sessions),
    );
    pushFullIssues(issues, full);
  }

  return {
    v: 1,
    detail,
    generatedAt: new Date().toISOString(),
    status: rollupStatus(issues),
    issues,
    daemon: {
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
      mode: input.opts.mode,
      workspaceCwd: input.boundWorkspace,
      ...(input.startup ? { startup: cloneStartup(input.startup) } : {}),
      ...(input.qwenCodeVersion
        ? { qwenCodeVersion: input.qwenCodeVersion }
        : {}),
      ...(input.daemonLog?.getDaemonId()
        ? { daemonId: input.daemonLog.getDaemonId() }
        : {}),
      ...(detail === 'full' && input.daemonLog?.getLogPath()
        ? { logPath: input.daemonLog.getLogPath() }
        : {}),
    },
    security: {
      tokenConfigured: Boolean(input.opts.token),
      requireAuth: input.opts.requireAuth === true,
      loopbackBind: isLoopbackBind(input.opts.hostname),
      allowOriginConfigured:
        input.opts.allowOrigins !== undefined &&
        input.opts.allowOrigins.length > 0,
      allowOriginMode: allowOriginMode(input.opts.allowOrigins),
      sessionShellCommandEnabled: input.sessionShellCommandEnabled,
    },
    limits: {
      maxSessions: bridgeSnapshot.limits.maxSessions,
      maxTotalSessions: positiveFiniteOrNull(input.opts.maxTotalSessions),
      maxPendingPromptsPerSession:
        bridgeSnapshot.limits.maxPendingPromptsPerSession,
      listenerMaxConnections: listenerMaxConnections(input.opts.maxConnections),
      eventRingSize: bridgeSnapshot.limits.eventRingSize,
      compactedReplayMaxBytes: bridgeSnapshot.limits.compactedReplayMaxBytes,
      promptDeadlineMs: positiveFiniteOrNull(input.opts.promptDeadlineMs),
      writerIdleTimeoutMs: positiveFiniteOrNull(input.opts.writerIdleTimeoutMs),
      channelIdleTimeoutMs: bridgeSnapshot.limits.channelIdleTimeoutMs,
      sessionIdleTimeoutMs: bridgeSnapshot.limits.sessionIdleTimeoutMs,
      acpConnectionCap: acpSnapshot?.connectionCap ?? null,
    },
    ...(workspaceRuntimes && workspaceRuntimes.length > 1
      ? {
          workspaces: workspaceRuntimes.map((runtime) => ({
            id: runtime.workspaceId,
            cwd: runtime.workspaceCwd,
            primary: runtime.primary,
            trusted: runtime.trusted,
          })),
        }
      : {}),
    capabilities: {
      protocolVersions: input.protocolVersions,
      features: [...input.features],
    },
    runtime: {
      sessions: {
        active: aggregatedSessionCount,
        ...(totalAdmissionSnapshot
          ? { admissionInFlight: totalAdmissionSnapshot.inFlight }
          : {}),
      },
      permissions: {
        pending: aggregatedPendingPermissionCount,
        policy: bridgeSnapshot.permissionPolicy,
      },
      channel: { live: aggregatedChannelLive },
      channelWorker,
      transport: {
        restSseActive: input.getRestSseActive(),
        acp: {
          enabled: acpSnapshot !== undefined,
          connections: acpAggregate?.connectionCount ?? 0,
          connectionStreams: acpAggregate?.connectionStreams ?? 0,
          sessionStreams: acpAggregate?.sessionStreams ?? 0,
          sseStreams: acpAggregate?.sseStreams ?? 0,
          wsStreams: acpAggregate?.wsStreams ?? 0,
          pendingClientRequests: acpAggregate?.pendingClientRequests ?? 0,
        },
      },
      rateLimit: {
        enabled: input.opts.rateLimit === true,
        rejectedSinceStart: rateLimitHits,
      },
      ...(input.getPerfSnapshot ? { perf: input.getPerfSnapshot() } : {}),
      ...(input.getMetricsSeries
        ? { metrics: { series: input.getMetricsSeries() } }
        : {}),
      activity: {
        activePrompts:
          workspaceRuntimes?.reduce(
            (sum, runtime) => sum + (runtime.bridge.activePromptCount ?? 0),
            0,
          ) ??
          input.bridge.activePromptCount ??
          0,
        pendingPrompts,
        queuedPrompts,
        lastActivityAt:
          aggregatedLastActivity !== null
            ? new Date(aggregatedLastActivity).toISOString()
            : null,
        idleSinceMs:
          aggregatedLastActivity !== null
            ? Date.now() - aggregatedLastActivity
            : null,
      },
      process: process.memoryUsage(),
    },
    ...(full ? { full } : {}),
  };
}

function cloneStartup(startup: DaemonStartupSnapshot): DaemonStartupSnapshot {
  return {
    processStartedAt: startup.processStartedAt,
    ...(startup.listenerReadyAt
      ? { listenerReadyAt: startup.listenerReadyAt }
      : {}),
    ...(startup.processToListenMs !== undefined
      ? { processToListenMs: startup.processToListenMs }
      : {}),
    ...(startup.runQwenServeToListenMs !== undefined
      ? { runQwenServeToListenMs: startup.runQwenServeToListenMs }
      : {}),
    preheat: {
      status: startup.preheat.status,
      ...(startup.preheat.durationMs !== undefined
        ? { durationMs: startup.preheat.durationMs }
        : {}),
      ...(startup.preheat.error ? { error: startup.preheat.error } : {}),
    },
  };
}

async function buildFullStatus(
  input: BuildDaemonStatusOptions,
  acpSnapshot: ReturnType<AcpHttpHandle['registry']['getSnapshot']> | undefined,
  sessions: BridgeDaemonStatusSnapshot['sessions'],
): Promise<FullDaemonStatus> {
  const ctx: WorkspaceRequestContext = {
    route: 'GET /daemon/status',
    workspaceCwd: input.boundWorkspace,
  };
  const [mcp, skills, tools, providers, env, preflight, hooks, extensions] =
    await Promise.all([
      collectSection('workspace.mcp', () =>
        input.workspace.getWorkspaceMcpStatus(ctx),
      ),
      collectSection('workspace.skills', () =>
        input.workspace.getWorkspaceSkillsStatus(ctx),
      ),
      collectSection('workspace.tools', () =>
        input.bridge.getWorkspaceToolsStatus(),
      ),
      collectSection('workspace.providers', () =>
        input.workspace.getWorkspaceProvidersStatus(ctx),
      ),
      collectSection('workspace.env', () =>
        input.workspace.getWorkspaceEnvStatus(ctx),
      ),
      collectSection('workspace.preflight', () =>
        input.workspace.getWorkspacePreflightStatus(ctx),
      ),
      collectSection('workspace.hooks', () =>
        input.workspace.getWorkspaceHooksStatus(ctx),
      ),
      collectSection('workspace.extensions', () =>
        input.workspace.getWorkspaceExtensionsStatus(ctx),
      ),
    ]);

  return {
    sessions,
    acpConnections: acpSnapshot?.connections ?? [],
    workspace: {
      mcp,
      skills,
      tools,
      providers,
      env,
      preflight,
      hooks,
      extensions,
    },
    auth: {
      supportedDeviceFlowProviders: [...input.supportedDeviceFlowProviders],
      pendingDeviceFlowCount: input.deviceFlowRegistry.listPending().length,
    },
  };
}

async function collectSection<T>(
  name: string,
  read: () => Promise<T>,
): Promise<DaemonStatusSection<T>> {
  const startMs = Date.now();
  try {
    const data = await withTimeout(read(), name, SECTION_TIMEOUT_MS);
    return {
      status: inferSectionStatus(data),
      durationMs: Date.now() - startMs,
      summary: summarizeStatusData(data),
      data,
    };
  } catch (err) {
    return {
      status: 'unavailable',
      durationMs: Date.now() - startMs,
      error: {
        kind: err instanceof SectionTimeoutError ? 'timeout' : 'error',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  section: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SectionTimeoutError(section, timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pushRuntimeIssues(
  issues: DaemonStatusIssue[],
  acpSnapshot: ReturnType<AcpHttpHandle['registry']['getSnapshot']> | undefined,
  rateLimitHits: Record<RateLimitTier, number>,
  input: BuildDaemonStatusOptions,
  channelWorker: ChannelWorkerSnapshot,
  totalAdmissionSnapshot: TotalSessionAdmissionSnapshot | undefined,
  workspaceSnapshots: readonly WorkspaceBridgeStatusSnapshot[],
): void {
  for (const { workspaceCwd, snapshot } of workspaceSnapshots) {
    if (
      snapshot.limits.maxSessions !== null &&
      snapshot.limits.maxSessions > 0 &&
      snapshot.sessionCount / snapshot.limits.maxSessions >=
        CAPACITY_WARNING_RATIO
    ) {
      issues.push({
        code: 'session_capacity_high',
        severity: 'warning',
        message:
          workspaceSnapshots.length > 1
            ? `Workspace ${workspaceCwd} active sessions are at ${snapshot.sessionCount}/${snapshot.limits.maxSessions}.`
            : `Active sessions are at ${snapshot.sessionCount}/${snapshot.limits.maxSessions}.`,
      });
    }
  }

  const maxTotalSessions = positiveFiniteOrNull(input.opts.maxTotalSessions);
  if (maxTotalSessions !== null) {
    const fallbackLiveCount = workspaceSnapshots.reduce(
      (sum, item) => sum + item.snapshot.sessionCount,
      0,
    );
    const totalActive =
      (totalAdmissionSnapshot?.liveCount ?? fallbackLiveCount) +
      (totalAdmissionSnapshot?.inFlight ?? 0);
    if (totalActive / maxTotalSessions >= CAPACITY_WARNING_RATIO) {
      issues.push({
        code: 'total_session_capacity_high',
        severity: 'warning',
        message: `Total active and in-flight sessions are at ${totalActive}/${maxTotalSessions}.`,
      });
    }
  }

  if (
    acpSnapshot !== undefined &&
    acpSnapshot.connectionCap !== null &&
    acpSnapshot.connectionCap > 0 &&
    acpSnapshot.connectionCount / acpSnapshot.connectionCap >=
      CAPACITY_WARNING_RATIO
  ) {
    issues.push({
      code: 'connection_capacity_high',
      severity: 'warning',
      message: `ACP connections are at ${acpSnapshot.connectionCount}/${acpSnapshot.connectionCap}.`,
    });
  }

  const pendingPermissionCount = workspaceSnapshots.reduce(
    (sum, item) => sum + item.snapshot.pendingPermissionCount,
    0,
  );
  if (pendingPermissionCount > 0) {
    issues.push({
      code: 'pending_permissions',
      severity: 'warning',
      message: `${pendingPermissionCount} permission request(s) are pending.`,
    });
  }

  const downWorkspaces = workspaceSnapshots.filter(
    (item) => item.snapshot.sessionCount > 0 && !item.snapshot.channelLive,
  );
  if (downWorkspaces.length > 0) {
    issues.push({
      code: 'acp_channel_down',
      severity: 'error',
      message:
        downWorkspaces.length === 1
          ? `Active sessions exist but the ACP channel is not live for ${downWorkspaces[0]!.workspaceCwd}.`
          : `Active sessions exist but the ACP channel is not live for ${downWorkspaces.length} workspace(s).`,
    });
  }

  if (input.opts.rateLimit === true && sumRateHits(rateLimitHits) > 0) {
    issues.push({
      code: 'rate_limit_hits',
      severity: 'warning',
      message: `${sumRateHits(rateLimitHits)} request(s) have been rejected by rate limiting since start.`,
    });
  }

  if (
    channelWorker.enabled &&
    (channelWorker.state === 'exited' || channelWorker.state === 'failed')
  ) {
    const detailParts = [
      channelWorker.pid !== undefined ? `pid=${channelWorker.pid}` : undefined,
      channelWorker.exitCode !== undefined
        ? `code=${channelWorker.exitCode ?? 'null'}`
        : undefined,
      channelWorker.signal ? `signal=${channelWorker.signal}` : undefined,
      channelWorker.restartCount !== undefined
        ? `restarts=${channelWorker.restartCount}`
        : undefined,
      channelWorker.lastExitAt
        ? `lastExitAt=${channelWorker.lastExitAt}`
        : undefined,
      channelWorker.lastRestartAt
        ? `lastRestartAt=${channelWorker.lastRestartAt}`
        : undefined,
      channelWorker.nextRestartAt
        ? `nextRestartAt=${channelWorker.nextRestartAt}`
        : undefined,
      channelWorker.lastHeartbeatAt
        ? `lastHeartbeatAt=${channelWorker.lastHeartbeatAt}`
        : undefined,
      channelWorker.staleHeartbeatAt
        ? `staleHeartbeatAt=${channelWorker.staleHeartbeatAt}`
        : undefined,
    ].filter(Boolean);
    const details =
      detailParts.length > 0 ? ` (${detailParts.join(', ')})` : '';
    const error = channelWorker.error ? `: ${channelWorker.error}` : '';
    const isPermanentFailure =
      channelWorker.state === 'failed' && !channelWorker.nextRestartAt;
    issues.push({
      code: 'channel_worker_exited',
      severity: isPermanentFailure ? 'error' : 'warning',
      message: `Channel worker is ${channelWorker.state}${details}${error}.`,
      section: 'runtime.channelWorker',
    });
  }

  if (
    channelWorker.enabled &&
    channelWorker.state === 'running' &&
    channelWorker.requestedChannels !== undefined
  ) {
    const connected = new Set(channelWorker.channels);
    const failed = channelWorker.requestedChannels.filter(
      (channel) => !connected.has(channel),
    );
    if (failed.length > 0) {
      issues.push({
        code: 'channel_worker_partial_connect',
        severity: 'warning',
        message:
          `Channel worker connected ${channelWorker.channels.length}/${channelWorker.requestedChannels.length} channel(s). ` +
          `Failed: ${failed.join(', ')}.`,
        section: 'runtime.channelWorker',
      });
    }
  }
}

function pushFullIssues(
  issues: DaemonStatusIssue[],
  full: FullDaemonStatus,
): void {
  for (const [name, section] of Object.entries(full.workspace)) {
    if (section.status === 'unavailable') {
      issues.push({
        code: 'workspace_status_unavailable',
        severity: 'warning',
        section: name,
        message: `${name} status is unavailable.`,
      });
    }
  }

  const preflight = full.workspace['preflight'];
  if (preflight && sectionHasStatus(preflight, 'error')) {
    issues.push({
      code: 'preflight_error',
      severity: 'error',
      section: 'preflight',
      message: 'Workspace preflight reports an error.',
    });
  }

  const mcp = full.workspace['mcp'];
  const mcpBudget = mcp ? inspectMcpBudget(mcp) : undefined;
  if (mcpBudget === 'exhausted') {
    issues.push({
      code: 'mcp_budget_exhausted',
      severity: 'error',
      section: 'mcp',
      message: 'MCP client budget is exhausted.',
    });
  } else if (mcpBudget === 'warning') {
    issues.push({
      code: 'mcp_budget_warning',
      severity: 'warning',
      section: 'mcp',
      message: 'MCP client budget is near capacity.',
    });
  }
}

function inferSectionStatus(data: unknown): DaemonStatusLevel {
  const statuses = collectStatuses(data);
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('warning')) return 'warning';
  return 'ok';
}

function summarizeStatusData(data: unknown): SectionSummary {
  const summary: SectionSummary = {};
  if (!isRecord(data)) return summary;

  copyBoolean(data, summary, 'initialized');
  copyBoolean(data, summary, 'acpChannelLive');
  copyString(data, summary, 'discoveryState');
  copyString(data, summary, 'budgetMode');
  copyNumber(data, summary, 'clientCount');
  copyNumber(data, summary, 'clientBudget');

  for (const key of [
    'cells',
    'errors',
    'servers',
    'budgets',
    'skills',
    'tools',
    'providers',
    'hooks',
    'extensions',
  ]) {
    const value = data[key];
    if (Array.isArray(value)) {
      summary[`${key}Count`] = value.length;
    }
  }

  summarizeMcpServers(data, summary);

  return summary;
}

function summarizeMcpServers(
  data: StatusRecord,
  summary: SectionSummary,
): void {
  const servers = data['servers'];
  if (!Array.isArray(servers)) return;
  let connected = 0;
  let errored = 0;
  let disabled = 0;
  for (const server of servers) {
    if (!isRecord(server)) continue;
    if (server['disabled'] === true) {
      disabled++;
    } else if (server['status'] === 'error') {
      errored++;
    } else if (server['mcpStatus'] === 'connected') {
      connected++;
    }
  }
  summary['serversConnected'] = connected;
  summary['serversErrored'] = errored;
  summary['serversDisabled'] = disabled;
}

function collectStatuses(data: unknown): string[] {
  const statuses: string[] = [];
  visitStatusContainers(data, (record) => {
    const status = record['status'];
    if (typeof status === 'string') statuses.push(status);
  });
  return statuses;
}

function sectionHasStatus(
  section: WorkspaceStatusSection,
  status: string,
): boolean {
  return collectStatuses(section.data).includes(status);
}

function inspectMcpBudget(
  section: WorkspaceStatusSection,
): 'warning' | 'exhausted' | undefined {
  const data = section.data;
  if (!isRecord(data)) return undefined;
  const budgetIssue = inspectBudgetContainers(data);
  if (budgetIssue) return budgetIssue;

  const clientCount = numberValue(data['clientCount']);
  const clientBudget = numberValue(data['clientBudget']);
  if (
    clientCount !== undefined &&
    clientBudget !== undefined &&
    clientBudget > 0
  ) {
    const ratio = clientCount / clientBudget;
    if (ratio >= 1) return 'exhausted';
    if (ratio >= 0.75) return 'warning';
  }
  return undefined;
}

function inspectBudgetContainers(
  data: unknown,
): 'warning' | 'exhausted' | undefined {
  let result: 'warning' | 'exhausted' | undefined;
  visitStatusContainers(data, (record) => {
    if (result === 'exhausted') return;
    const errorKind = record['errorKind'];
    const disabledReason = record['disabledReason'];
    const status = record['status'];
    const kind = record['kind'];
    const refusedCount = numberValue(record['refusedCount']);
    if (
      errorKind === 'budget_exhausted' ||
      disabledReason === 'budget' ||
      (kind === 'mcp_budget' && status === 'error') ||
      (refusedCount !== undefined && refusedCount > 0)
    ) {
      result = 'exhausted';
      return;
    }
    if (kind === 'mcp_budget' && status === 'warning') {
      result = 'warning';
    }
  });
  return result;
}

function visitStatusContainers(
  data: unknown,
  visit: (record: StatusRecord) => void,
): void {
  if (!isRecord(data)) return;
  visit(data);
  for (const key of [
    'cells',
    'errors',
    'servers',
    'budgets',
    'skills',
    'tools',
    'providers',
    'hooks',
    'extensions',
  ]) {
    const value = data[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) visitStatusContainers(item, visit);
  }
}

function rollupStatus(issues: readonly DaemonStatusIssue[]): DaemonStatusLevel {
  if (issues.some((issue) => issue.severity === 'error')) return 'error';
  if (issues.length > 0) return 'warning';
  return 'ok';
}

export function allowOriginMode(
  allowOrigins: readonly string[] | undefined,
): 'none' | 'specific' | 'any' {
  if (!allowOrigins || allowOrigins.length === 0) return 'none';
  return allowOrigins.includes('*') ? 'any' : 'specific';
}

export function listenerMaxConnections(
  value: number | undefined,
): number | null {
  if (value === undefined) return DEFAULT_LISTENER_MAX_CONNECTIONS;
  if (value === 0 || value === Infinity) return null;
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function positiveFiniteOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function zeroRateHits(): Record<RateLimitTier, number> {
  return { prompt: 0, mutation: 0, read: 0 };
}

function sumRateHits(hits: Record<RateLimitTier, number>): number {
  return hits.prompt + hits.mutation + hits.read;
}

function isRecord(value: unknown): value is StatusRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function copyBoolean(
  from: StatusRecord,
  to: SectionSummary,
  key: string,
): void {
  const value = from[key];
  if (typeof value === 'boolean') to[key] = value;
}

function copyString(from: StatusRecord, to: SectionSummary, key: string): void {
  const value = from[key];
  if (typeof value === 'string') to[key] = value;
}

function copyNumber(from: StatusRecord, to: SectionSummary, key: string): void {
  const value = numberValue(from[key]);
  if (value !== undefined) to[key] = value;
}
