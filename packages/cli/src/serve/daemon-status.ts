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
import type {
  DaemonWorkspaceService,
  WorkspaceRequestContext,
} from './workspace-service/index.js';

const DEFAULT_LISTENER_MAX_CONNECTIONS = 256;
const SECTION_TIMEOUT_MS = 1_000;
const CAPACITY_WARNING_RATIO = 0.8;

export type DaemonStatusDetail = 'summary' | 'full';
type DaemonStatusLevel = 'ok' | 'warning' | 'error';
type SectionStatus = DaemonStatusLevel | 'unavailable';
type IssueSeverity = 'warning' | 'error';
type SectionSummary = Record<string, string | number | boolean | null>;
type StatusRecord = Record<string, unknown>;

export interface DaemonStatusIssue {
  code:
    | 'session_capacity_high'
    | 'connection_capacity_high'
    | 'pending_permissions'
    | 'acp_channel_down'
    | 'preflight_error'
    | 'mcp_budget_warning'
    | 'mcp_budget_exhausted'
    | 'rate_limit_hits'
    | 'workspace_status_unavailable';
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
): Promise<Record<string, unknown>> {
  const bridgeSnapshot = input.bridge.getDaemonStatusSnapshot();
  const acpSnapshot = input.acpHandle?.registry.getSnapshot();
  const rateLimitHits = input.rateLimiter?.getHitCounts() ?? zeroRateHits();
  const issues: DaemonStatusIssue[] = [];
  let full: FullDaemonStatus | undefined;

  pushRuntimeIssues(issues, bridgeSnapshot, acpSnapshot, rateLimitHits, input);

  if (detail === 'full') {
    full = await buildFullStatus(input, bridgeSnapshot, acpSnapshot);
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
      maxPendingPromptsPerSession:
        bridgeSnapshot.limits.maxPendingPromptsPerSession,
      listenerMaxConnections: listenerMaxConnections(input.opts.maxConnections),
      eventRingSize: bridgeSnapshot.limits.eventRingSize,
      promptDeadlineMs: positiveFiniteOrNull(input.opts.promptDeadlineMs),
      writerIdleTimeoutMs: positiveFiniteOrNull(input.opts.writerIdleTimeoutMs),
      channelIdleTimeoutMs: bridgeSnapshot.limits.channelIdleTimeoutMs,
      sessionIdleTimeoutMs: bridgeSnapshot.limits.sessionIdleTimeoutMs,
      acpConnectionCap: acpSnapshot?.connectionCap ?? null,
    },
    capabilities: {
      protocolVersions: input.protocolVersions,
      features: [...input.features],
    },
    runtime: {
      sessions: { active: bridgeSnapshot.sessionCount },
      permissions: {
        pending: bridgeSnapshot.pendingPermissionCount,
        policy: bridgeSnapshot.permissionPolicy,
      },
      channel: { live: bridgeSnapshot.channelLive },
      transport: {
        restSseActive: input.getRestSseActive(),
        acp: {
          enabled: acpSnapshot !== undefined,
          connections: acpSnapshot?.connectionCount ?? 0,
          connectionStreams: acpSnapshot?.connectionStreams ?? 0,
          sessionStreams: acpSnapshot?.sessionStreams ?? 0,
          sseStreams: acpSnapshot?.sseStreams ?? 0,
          wsStreams: acpSnapshot?.wsStreams ?? 0,
          pendingClientRequests: acpSnapshot?.pendingClientRequests ?? 0,
        },
      },
      rateLimit: {
        enabled: input.opts.rateLimit === true,
        rejectedSinceStart: rateLimitHits,
      },
      process: process.memoryUsage(),
    },
    ...(full ? { full } : {}),
  };
}

async function buildFullStatus(
  input: BuildDaemonStatusOptions,
  bridgeSnapshot: BridgeDaemonStatusSnapshot,
  acpSnapshot: ReturnType<AcpHttpHandle['registry']['getSnapshot']> | undefined,
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
    sessions: bridgeSnapshot.sessions,
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
  bridgeSnapshot: BridgeDaemonStatusSnapshot,
  acpSnapshot: ReturnType<AcpHttpHandle['registry']['getSnapshot']> | undefined,
  rateLimitHits: Record<RateLimitTier, number>,
  input: BuildDaemonStatusOptions,
): void {
  if (
    bridgeSnapshot.limits.maxSessions !== null &&
    bridgeSnapshot.limits.maxSessions > 0 &&
    bridgeSnapshot.sessionCount / bridgeSnapshot.limits.maxSessions >=
      CAPACITY_WARNING_RATIO
  ) {
    issues.push({
      code: 'session_capacity_high',
      severity: 'warning',
      message: `Active sessions are at ${bridgeSnapshot.sessionCount}/${bridgeSnapshot.limits.maxSessions}.`,
    });
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

  if (bridgeSnapshot.pendingPermissionCount > 0) {
    issues.push({
      code: 'pending_permissions',
      severity: 'warning',
      message: `${bridgeSnapshot.pendingPermissionCount} permission request(s) are pending.`,
    });
  }

  if (bridgeSnapshot.sessionCount > 0 && !bridgeSnapshot.channelLive) {
    issues.push({
      code: 'acp_channel_down',
      severity: 'error',
      message: 'Active sessions exist but the ACP channel is not live.',
    });
  }

  if (input.opts.rateLimit === true && sumRateHits(rateLimitHits) > 0) {
    issues.push({
      code: 'rate_limit_hits',
      severity: 'warning',
      message: `${sumRateHits(rateLimitHits)} request(s) have been rejected by rate limiting since start.`,
    });
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

  return summary;
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

function allowOriginMode(
  allowOrigins: readonly string[] | undefined,
): 'none' | 'specific' | 'any' {
  if (!allowOrigins || allowOrigins.length === 0) return 'none';
  return allowOrigins.includes('*') ? 'any' : 'specific';
}

function listenerMaxConnections(value: number | undefined): number | null {
  if (value === undefined) return DEFAULT_LISTENER_MAX_CONNECTIONS;
  if (value === 0 || value === Infinity) return null;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function positiveFiniteOrNull(value: number | undefined): number | null {
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
