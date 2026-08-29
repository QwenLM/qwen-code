/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { X509Certificate, createHash, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import express, {
  type Application,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { writeStderrLine, writeStdoutLine } from '../utils/stdioHelpers.js';
import { isWithinRoot } from '../config/path-comparison.js';
import {
  acquireInheritedLoaderEnvScrub,
  clearLoaderKeyRejectionReporterIfCurrent,
  scrubInheritedLoaderEnv,
  setLoaderKeyRejectionReporter,
  type LoaderKeyRejectionReporter,
} from '../config/shared-env-keys.js';
import {
  DEFAULT_COMPACTED_REPLAY_MAX_BYTES,
  DEFAULT_MAX_JOURNAL_BYTES,
  DEFAULT_MAX_JOURNAL_EVENTS,
  JOURNAL_GROWTH_HARD_CAP_BYTES,
  normalizeCompactedReplayMaxBytes,
  normalizeMaxJournalBytes,
  normalizeMaxJournalEvents,
  type JournalGrowthSessionLimit,
} from '@qwen-code/acp-bridge/replayWindowLimits';
import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import { resolveSessionRestoreTimeoutMs } from '@qwen-code/acp-bridge/sessionRestoreTimeout';
import type { NdJsonMessageObservation } from '@qwen-code/acp-bridge/ndJsonStream';
import { getDeviceFlowRegistry } from './auth/device-flow.js';
import {
  consumeServeFastPathRejectedLoaderKeys,
  loadServeFastPathSettings,
  preResolveServeFastPathHomeEnvOverrides,
  type ServeFastPathSettings,
} from './fast-path-settings.js';
import {
  MAX_REGISTERED_WORKSPACES,
  resolveWorkspaceInputs,
} from './workspace-inputs.js';
import type { AcpSessionBridge } from '@qwen-code/acp-bridge/bridgeTypes';
import {
  formatMemoryBudgetStderr,
  resolveDaemonMemoryBudget,
  serveJournalGrowthPoolMb,
} from '@qwen-code/acp-bridge/daemonMemoryBudget';
import {
  createChildHeapPolicy,
  type ChildHeapPolicy,
} from '@qwen-code/acp-bridge/childHeapPolicy';
import {
  canonicalizeWorkspace,
  translateAndCheckAbsoluteWorkspacePath,
} from '@qwen-code/acp-bridge/workspacePaths';
import type {
  AuthType,
  ProviderSetupInputs,
  TelemetryRuntimeConfig,
  TelemetrySettings,
} from '@qwen-code/qwen-code-core';
import { MEMORY_PROJECT_SCOPES } from '@qwen-code/qwen-code-core/memoryScopes';
import { createBridgeFileSystemAdapter } from './bridge-file-system-adapter.js';
// Dynamic-imported below (not at module scope) so the serve fast-path bundle
// closure check doesn't trace create-sub-session's transitive deps through
// the run-qwen-serve chunk. The launcher is only needed after listen().
import { PathMutexRegistry } from './fs/path-mutex-registry.js';
import { isDeepHealthQuery } from './health-query.js';
import {
  hostAssignsIpv6Loopback,
  isOwnInterfaceAddress,
} from './local-bind-addresses.js';
import { isHostGateLoopback, isLoopbackBind } from './loopback-binds.js';
import { RUNTIME_STARTUP_CANCELLED_MESSAGE } from './runtime-startup-errors.js';
import { resolveWebShellDir } from './web-shell-resolver.js';
import { resolveServeToken } from './serve-token.js';
import { acpChildExtraArgs } from './acp-child-extra-args.js';
import {
  allowOriginCors,
  bearerAuth,
  denyBrowserOriginCors,
  hostAllowlist,
  parseAllowOriginPatterns,
} from './auth.js';
import type { LocalControlService } from './local-control/index.js';
import {
  createPermissionAuditPublisher,
  PermissionAuditRing,
} from './permission-audit.js';
import { ClientMcpSenderRegistry } from './acp-http/client-mcp-sender-registry.js';
import {
  initDaemonLogger,
  resolveDaemonLogBaseDir,
  type DaemonLogger,
} from './daemon-logger.js';
import {
  getAdvertisedServeFeatures,
  getServeProtocolVersions,
  SERVE_CAPABILITY_REGISTRY,
} from './capabilities.js';
import {
  EXTERNAL_TOOL_GUARD_PROVIDER_ATTACHED_VALUE,
  EXTERNAL_TOOL_GUARD_REQUIRED_VALUE,
  EXTERNAL_TOOL_GUARD_TOKEN_ENV,
  PRIVATE_EXTERNAL_TOOL_GUARD_ENV,
  PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER_ENV,
} from '@qwen-code/acp-bridge/externalToolGuard';
import {
  CAPABILITIES_SCHEMA_VERSION,
  type CapabilitiesEnvelope,
  type ServeAuthProviderInstallRequest,
  type ServeAuthProviderInstallResult,
  type ServeOptions,
  type ServeChannelSelection,
  type ChannelWebhookConfigSource,
} from './types.js';
import type { WorkspaceFileSystemFactory } from './fs/index.js';
import type {
  WorkspaceGenerationGuard,
  WorkspaceRegistry,
  WorkspaceRuntime,
} from './workspace-registry.js';
import type { SessionArchiveCoordinator } from './server/session-archive.js';
import type {
  DaemonTrustPolicySnapshot,
  DaemonWorkspaceTrustDecision,
} from '../config/daemon-trust-policy.js';
import {
  isManagedScratchChild,
  prepareManagedScratchRoot,
  type ManagedScratchRoot,
  type WorkspaceRuntimeProvenance,
} from './managed-scratch-workspace.js';
import { ConversationRuntimeOwnershipError } from './conversations/conversation-runtime-errors.js';
import { ConversationWorkspace } from './conversations/conversation-workspace.js';
import { LIVE_HOST_PROTOCOL_VERSION } from './live/types.js';
import { ServeAppLifecycleController } from './serve-app-lifecycle.js';
import {
  workspaceRegistrationId,
  type WorkspaceRegistrationStore,
} from './workspace-registration-store.js';
import type { PermissionPolicy } from '@qwen-code/acp-bridge';
import type {
  ChannelDeliveryHandler,
  ChannelDeliveryHostResult,
  CurrentSessionScheduledTaskCreateHandler,
  ExternalToolGuardHandler,
} from '@qwen-code/acp-bridge/bridgeOptions';
import { getCliVersion } from '../utils/version.js';
import { getRateLimiter } from './rate-limit.js';
import type { AcpHttpHandle } from './acp-http/index.js';
import { resolveAcpHttpEnabled } from './acp-http-enabled.js';
import type { ChannelManagementService } from './channel-management-service.js';
import type { WorkspaceRuntimeRemovalController } from './routes/workspace-management.js';
import {
  allowOriginMode,
  listenerMaxConnections,
  parseDaemonStatusDetail,
  positiveFiniteOrNull,
  toDaemonStatusMemoryLimits,
  type DaemonStatusIssue,
  type DaemonPerfSnapshot,
  type DaemonStartupSnapshot,
  type DaemonStatusResponse,
} from './daemon-status.js';
import { DaemonMetricsRing } from './daemon-metrics-ring.js';
import { computeCpuPercent } from '../runtime/cpu-percent.js';
import { createLargePipeFrameObserver } from './large-pipe-frame-observer.js';
import type {
  ChannelWorkerSupervisor,
  ChannelWorkerSnapshot,
  CreateChannelWorkerSupervisorOptions,
} from './channel-worker-supervisor.js';
import {
  ExtraCaInspectionError,
  loadableCertificates,
} from './pem-certificate-blocks.js';
import { QWEN_SERVER_TOKEN_ENV } from './channel-worker-env.js';
import { ChannelWebhookEnqueueError } from './channel-webhook-ipc.js';
import {
  ChannelDeliveryError,
  isChannelDeliveryError,
} from '../runtime/channel-delivery-ipc.js';
import { ChannelDeliveryAuthorizationStore } from './channel-delivery-authorization.js';
import {
  normalizeWorkerDiagnostic,
  sanitizeWorkerDiagnostic,
  type WorkerDiagnosticRedactionOptions,
} from './channel-worker-diagnostics.js';
import { channelSelectionNames } from './channel-selection.js';
import {
  resolveChannelWorkspaceGroups,
  type ChannelWorkspaceGroup,
} from './channel-workspace-grouping.js';
import { type ChannelWorkerGroupSnapshot } from './channel-worker-group.js';
import type {
  ChannelWorkerControlState,
  ChannelWorkerManager,
  ChannelWorkerSetResult,
  ChannelWorkerStopResult,
  CreateChannelWorkerManagerOptions,
} from './channel-worker-manager.js';
import {
  finalizeStartupProfile,
  profileCheckpoint,
} from '../utils/startupProfiler.js';
import type {
  ServiceInfo,
  ServiceInfoWorker,
} from '../commands/channel/pidfile.js';
import { sanitizeLogText } from '@qwen-code/channel-base';
import { isBrowserAutomationMcpAvailable } from './cdp-mcp-command.js';
import { WorkspaceVoiceCoordinator } from './voice/workspace-voice-coordinator.js';
import {
  ACCESS_LOG_CONTROLLER_LOCAL,
  type AccessLogAppLocals,
} from './server/access-log.js';
import {
  setDeferredRuntimeRequestTiming,
  type DeferredRuntimeRequestTiming,
} from './server/request-helpers.js';

// Reverse MCP channel; enabled only by explicit option or env opt-in.
const QWEN_SERVE_CLIENT_MCP_OVER_WS_ENV = 'QWEN_SERVE_CLIENT_MCP_OVER_WS';
// CDP tunnel; default-on for Chrome-extension origins or explicit env opt-in.
const QWEN_SERVE_CDP_TUNNEL_OVER_WS_ENV = 'QWEN_SERVE_CDP_TUNNEL_OVER_WS';
const QWEN_SERVE_PROMPT_DEADLINE_MS_ENV = 'QWEN_SERVE_PROMPT_DEADLINE_MS';
const QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS_ENV =
  'QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS';
const SHUTDOWN_FORCE_CLOSE_MS = 5_000;
const DAEMON_LOG_FORCED_FLUSH_BUDGET_MS = 250;
const DEFAULT_LIVE_DISCOVERY_RETRY_MS = 5_000;

function channelDeliveryPublicError(
  code: Extract<ChannelDeliveryHostResult, { status: 'failed' }>['code'],
): string {
  switch (code) {
    case 'channel_worker_unavailable':
      return 'Channel worker is unavailable.';
    case 'channel_delivery_timeout':
      return 'Channel delivery timed out.';
    case 'channel_delivery_invalid':
      return 'Channel delivery is invalid.';
    case 'channel_delivery_rejected':
      return 'Channel delivery was rejected.';
    case 'channel_delivery_queue_full':
      return 'Channel delivery queue is full.';
    case 'channel_delivery_failed':
      return 'Channel delivery failed.';
    default:
      return 'Channel delivery failed.';
  }
}

export function createBoundChannelDeliveryHandler(
  boundWorkspace: string,
  getManager: () => ChannelWorkerManager | undefined,
  authorizations: ChannelDeliveryAuthorizationStore,
  daemonLog?: Pick<DaemonLogger, 'warn'>,
  diagnosticRedaction: WorkerDiagnosticRedactionOptions = {
    workerEnv: {},
  },
): ChannelDeliveryHandler {
  return async (info): Promise<ChannelDeliveryHostResult> => {
    const failed = (
      code: Extract<ChannelDeliveryHostResult, { status: 'failed' }>['code'],
      error: string,
      diagnostic?: unknown,
    ): ChannelDeliveryHostResult => {
      writeDaemonLifecycleBestEffort(() => {
        if (!daemonLog) return;
        let diagnosticText: string | undefined;
        if (diagnostic !== undefined) {
          const message =
            diagnostic instanceof Error
              ? diagnostic.message
              : String(diagnostic);
          const sanitized = sanitizeWorkerDiagnostic(
            message,
            512,
            diagnosticRedaction,
          );
          const targetId = normalizeWorkerDiagnostic(info.target.id);
          diagnosticText = sanitizeLogText(
            targetId.length > 0
              ? sanitized.replaceAll(targetId, '<redacted>')
              : sanitized,
            512,
          );
        }
        daemonLog.warn('channel delivery failed', {
          sessionId: info.sessionId,
          deliveryId: info.deliveryId,
          source: info.source,
          channelName: info.target.channelName,
          code,
          ...(diagnosticText ? { diagnostic: diagnosticText } : {}),
        });
      });
      return { status: 'failed', code, error };
    };
    if (!authorizations.consume(boundWorkspace, info)) {
      return failed(
        'channel_delivery_invalid',
        'Channel delivery is not authorized.',
      );
    }
    if (info.text.trim().length === 0) {
      return { status: 'skipped' };
    }
    const manager = getManager();
    if (!manager) {
      return failed(
        'channel_worker_unavailable',
        'Channel worker is not running.',
      );
    }
    try {
      await manager.deliverChannelMessage(boundWorkspace, {
        deliveryId: info.deliveryId,
        channelName: info.target.channelName,
        target: { type: info.target.type, id: info.target.id },
        text: info.text,
      });
      return { status: 'delivered' };
    } catch (err) {
      if (isChannelDeliveryError(err)) {
        return failed(err.code, channelDeliveryPublicError(err.code), err);
      }
      return failed('channel_delivery_failed', 'Channel delivery failed.', err);
    }
  };
}

async function flushDaemonLogBounded(
  daemonLog: DaemonLogger,
  budgetMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      daemonLog.flush().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function writeDaemonLifecycleBestEffort(write: () => void): void {
  try {
    write();
  } catch {
    // Best-effort lifecycle diagnostics must not make shutdown throw.
  }
}

function daemonPipeDirection(
  direction: NdJsonMessageObservation['direction'],
): 'inbound' | 'outbound' {
  switch (direction) {
    case 'sent':
      return 'outbound';
    case 'received':
      return 'inbound';
    default: {
      const exhaustive: never = direction;
      return exhaustive;
    }
  }
}

// Daemon Status metrics ring: seal one bucket every SAMPLE_MS and retain
// CAPACITY of them (5s × 180 ≈ 15 min of history), matching the dashboard's
// own 5s poll so each poll surfaces roughly one fresh bucket.
const DAEMON_METRICS_SAMPLE_MS = 5_000;
const DAEMON_METRICS_CAPACITY = 180;

// `process.cpuUsage()` can throw in restricted containers that lack the
// syscall; return null so the sampler can skip the delta (and leave its
// baseline untouched) rather than treating a failed read as zero usage —
// which would turn the next successful read's since-start total into a spike.
function safeCpuUsage(): NodeJS.CpuUsage | null {
  try {
    return process.cpuUsage();
  } catch {
    return null;
  }
}
const DEFAULT_RUNTIME_STARTUP_TIMEOUT_MS = 120_000;
// Let the first /health response flush before evaluating the runtime graph.
const FAST_PATH_RUNTIME_START_AFTER_HEALTH_MS = 50;
// Keep manual/non-probed starts moving; health probes cancel this fallback.
const FAST_PATH_RUNTIME_START_FALLBACK_MS = 1_000;
const RUNTIME_STARTUP_TIMEOUT_ENV = 'QWEN_SERVE_RUNTIME_STARTUP_TIMEOUT_MS';
const MAX_EVENT_RING_SIZE = 1_000_000;
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION = 5;
const DEFAULT_EVENT_RING_SIZE = 8000;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
const WORKSPACE_SETTING_SCOPE =
  'Workspace' as import('../config/settings.js').SettingScope;

type RunQwenServeOptions = Omit<ServeOptions, 'token' | 'workspace'> & {
  token?: string;
  workspace?: string | string[];
  requireWebShell?: boolean;
};
type WorkspaceSettingsWrite =
  import('./workspace-service/types.js').WorkspaceSettingsWrite;
type PersistDisabledSkillsBatchResult =
  import('./workspace-service/types.js').PersistDisabledSkillsBatchResult;
type ChannelWebhookConfigRuntime = {
  loadChannelsConfig: typeof import('../commands/channel/runtime.js').loadChannelsConfig;
  parseChannelWebhookConfig: typeof import('../commands/channel/config-utils.js').parseChannelWebhookConfig;
};

function isPositiveIntegerMs(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function isNonNegativeIntegerOrInfinity(value: number): boolean {
  return (
    value === Number.POSITIVE_INFINITY ||
    (Number.isFinite(value) && Number.isInteger(value) && value >= 0)
  );
}

function deriveDefaultMaxTotalSessions(
  maxSessionsPerWorkspace: number | undefined,
  workspaceCount: number,
): number | undefined {
  if (workspaceCount <= 1) return undefined;
  const perWorkspace = maxSessionsPerWorkspace ?? DEFAULT_MAX_SESSIONS;
  if (perWorkspace === 0 || perWorkspace === Number.POSITIVE_INFINITY) {
    return undefined;
  }
  return perWorkspace * workspaceCount;
}

function isNonNegativeIntegerMs(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

const MAX_PORT_ATTEMPTS = 10;

function assertTimerDelayInRange(name: string, value: number): void {
  if (value > MAX_TIMEOUT_MS) {
    throw new TypeError(
      `Invalid ${name}: ${value}. Exceeds maximum JS timer delay of ` +
        `${MAX_TIMEOUT_MS} ms (~24.8 days); Node would silently ` +
        `compress longer delays to 1ms.`,
    );
  }
}

/**
 * Resolve a positive-integer millisecond value from an env var.
 * Returns `undefined` when the var is absent (caller falls back to the
 * CLI option / `ServeOptions` field), throws when the var is present
 * but malformed so a typo fails the boot loudly instead of silently
 * disabling the deadline.
 */
function parseDeadlineEnv(
  envName: string,
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined;
  // Don't early-return on empty/whitespace: `Number('')` and
  // `Number(' ')` both yield `0`, which the positive-integer check
  // below rejects with the standard error message. Silently treating
  // `QWEN_SERVE_PROMPT_DEADLINE_MS=" "` as "not set" would let a
  // shell-substitution typo slip past.
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (!isPositiveIntegerMs(parsed)) {
    throw new Error(
      `Invalid ${envName}="${raw}": must be a positive integer (milliseconds).`,
    );
  }
  return parsed;
}

function envFlagDisabled(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '0' || normalized === 'false';
}

function hasChromeExtensionOrigin(origins: readonly string[] | undefined) {
  return (
    origins?.some((origin) =>
      origin.trim().toLowerCase().startsWith('chrome-extension://'),
    ) === true
  );
}

function createDaemonTelemetryRuntimeConfig(
  telemetry: TelemetrySettings,
  cliVersion: string,
  daemonSessionId: string,
  defaults: {
    otlpEndpoint: string;
    telemetryTarget: NonNullable<TelemetrySettings['target']>;
  },
): TelemetryRuntimeConfig {
  return {
    getTelemetryEnabled: () => telemetry.enabled ?? false,
    getTelemetryOtlpEndpoint: () =>
      telemetry.otlpEndpoint ?? defaults.otlpEndpoint,
    getTelemetryOtlpProtocol: () => telemetry.otlpProtocol ?? 'grpc',
    getTelemetryOtlpTracesEndpoint: () => telemetry.otlpTracesEndpoint,
    getTelemetryOtlpLogsEndpoint: () => telemetry.otlpLogsEndpoint,
    getTelemetryOtlpMetricsEndpoint: () => telemetry.otlpMetricsEndpoint,
    getTelemetryTarget: () => telemetry.target ?? defaults.telemetryTarget,
    getTelemetryOutfile: () => telemetry.outfile,
    getTelemetryIncludeSensitiveSpanAttributes: () =>
      telemetry.includeSensitiveSpanAttributes ?? false,
    getTelemetryResourceAttributes: () => ({
      'service.instance.id': daemonSessionId,
      ...(telemetry.resourceAttributes ?? {}),
    }),
    getTelemetryMetricsIncludeSessionId: () =>
      telemetry.metrics?.includeSessionId ?? false,
    getTelemetryResourceAttributeWarnings: () =>
      telemetry.resourceAttributeWarnings ?? [],
    getCliVersion: () => cliVersion,
    getSessionId: () => daemonSessionId,
    isInteractive: () => false,
    getOutboundCorrelationPropagateTraceContext: () => false,
  };
}

/**
 * Boot-time policy validation error. The catch block in `runQwenServe`
 * matches with `instanceof InvalidPolicyConfigError` to distinguish
 * operator-misconfiguration (rethrow → fail boot loudly) from
 * settings-read failures (fall back to defaults).
 */
export class InvalidPolicyConfigError extends Error {
  override readonly name = 'InvalidPolicyConfigError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * Parse + validate the `policy.*` section of merged daemon settings.
 * Returns the resolved `permissionPolicy` /
 * `permissionConsensusQuorum` for `BridgeOptions`, or throws
 * `InvalidPolicyConfigError` for operator misconfiguration.
 *
 * - `permissionStrategy` must be one of the four `PermissionPolicy`
 *   literals if present.
 * - `consensusQuorum` must be a positive integer if present.
 * - When `consensusQuorum` is set but `permissionStrategy` is not
 *   `'consensus'`, the override is silently ignored — emit a
 *   stderr warning so the operator notices.
 *
 * The mismatch warning runs through `onWarning` so tests can
 * capture it; production passes `writeStderrLine`.
 *
 * The runtime valid-policy set is derived from
 * `SERVE_CAPABILITY_REGISTRY.permission_mediation.modes` (single
 * source of truth) instead of repeating the four literals.
 */
export function validatePolicyConfig(
  policyConfig: {
    permissionStrategy?: unknown;
    consensusQuorum?: unknown;
  } = {},
  onWarning: (message: string) => void = writeStderrLine,
): {
  permissionPolicy: PermissionPolicy | undefined;
  permissionConsensusQuorum: number | undefined;
} {
  // Derive from the capability registry so the runtime set, the
  // settings schema enum, the `PermissionPolicy` union, and the
  // capability advertisement all stay aligned through a single
  // edit point. The cast asserts every `modes` entry is a
  // `PermissionPolicy` — TypeScript's `satisfies Record<string,
  // ServeCapabilityDescriptor>` on the registry doesn't narrow
  // `modes` to the union, so the assertion is necessary here. The
  // `permissionMediation.test.ts` capability-suite asserts the
  // modes list is exhaustive over `PermissionPolicy`, providing
  // the runtime guarantee.
  const validSet: ReadonlySet<string> = new Set<string>(
    SERVE_CAPABILITY_REGISTRY.permission_mediation.modes,
  );
  const permissionStrategy = policyConfig.permissionStrategy;
  const consensusQuorum = policyConfig.consensusQuorum;
  if (
    permissionStrategy !== undefined &&
    (typeof permissionStrategy !== 'string' ||
      !validSet.has(permissionStrategy))
  ) {
    throw new InvalidPolicyConfigError(
      `qwen serve: invalid policy.permissionStrategy ` +
        `"${String(permissionStrategy)}"; must be one of ` +
        `${Array.from(validSet).join(', ')}`,
    );
  }
  if (
    consensusQuorum !== undefined &&
    (typeof consensusQuorum !== 'number' ||
      !Number.isInteger(consensusQuorum) ||
      consensusQuorum < 1)
  ) {
    throw new InvalidPolicyConfigError(
      `qwen serve: invalid policy.consensusQuorum ` +
        `${String(consensusQuorum)}; must be a positive integer`,
    );
  }
  // When consensusQuorum is set but the active strategy doesn't
  // use it, drop the value so the public contract matches the
  // warning. Operators reading the warning at boot now see
  // consistent behavior all the way down.
  const consensusQuorumActive =
    consensusQuorum !== undefined && permissionStrategy === 'consensus';
  if (consensusQuorum !== undefined && permissionStrategy !== 'consensus') {
    onWarning(
      'qwen serve: policy.consensusQuorum is set but ' +
        'policy.permissionStrategy is not "consensus"; the override will ' +
        'be ignored.',
    );
  }
  return {
    permissionPolicy: permissionStrategy as PermissionPolicy | undefined,
    permissionConsensusQuorum: consensusQuorumActive
      ? consensusQuorum
      : undefined,
  };
}

/**
 * Wrap raw IPv6 literals in brackets so the printed URL is a valid RFC 3986
 * authority. `host:port` is ambiguous when host contains `:`, so the URL
 * form requires `[host]:port` for IPv6. Pass-through for IPv4 and DNS
 * names. Already-bracketed input is left alone.
 *
 * RFC 6874 also requires the `%` in an IPv6 zone identifier (e.g.
 * `fe80::1%lo0`) to be percent-encoded as `%25` so the printed URL is
 * copy-paste-valid. We do that on raw IPv6 only — already-bracketed
 * input is the operator's responsibility (don't double-encode if they
 * pre-formed the URL part themselves).
 */
function formatHostForUrl(host: string): string {
  if (host.startsWith('[')) return host;
  if (host.includes(':')) {
    const encoded = host.includes('%') ? host.replace(/%/g, '%25') : host;
    return `[${encoded}]`;
  }
  return host;
}

function workspaceRuntimeEffectiveEnv(
  runtime: WorkspaceRuntime,
  daemonEnv: Readonly<NodeJS.ProcessEnv>,
): Readonly<NodeJS.ProcessEnv> {
  if (runtime.env.mode === 'runtime-overlay') {
    return runtime.env.effectiveEnv ?? {};
  }
  return runtime.env.effectiveEnv ?? daemonEnv;
}

function canonicalIpLiteral(host: string): string | undefined {
  const inner =
    host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  try {
    const hostname = new URL(
      `http://${inner.includes(':') ? `[${inner}]` : inner}`,
    ).hostname;
    const canonical =
      hostname.startsWith('[') && hostname.endsWith(']')
        ? hostname.slice(1, -1)
        : hostname;
    return isIP(canonical) === 0 ? undefined : canonical;
  } catch {
    return undefined;
  }
}

export function formatChannelWorkerDaemonUrl(
  host: string,
  port: number,
  tls = false,
  boundFamily?: 'IPv4' | 'IPv6',
  ipv6LoopbackAssigned: boolean = hostAssignsIpv6Loopback(),
): string {
  const scheme = tls ? 'https' : 'http';
  const normalized = host.trim().toLowerCase();
  const canonicalIp = canonicalIpLiteral(normalized);
  // R7-7: the loopback an IPv6 wildcard bind is dialled back on follows what
  // the host ASSIGNS, not the bind spelling. Node keeps such sockets
  // dual-stack (libuv pins `IPV6_V6ONLY=0` unless `ipv6Only` is requested,
  // so `net.ipv6.bindv6only` never reaches this listener), so both loopbacks
  // usually reach it — but an IPv4-less host has only `::1`, and a host that
  // binds `::` while its loopback carries no `::1` (e.g.
  // `net.ipv6.conf.lo.disable_ipv6=1`) has only `127.0.0.1`. The old
  // spelling-based rule handed the latter `[::1]`, and the first worker's
  // `fetch failed` exited the daemon. The v4 wildcard keeps v4 loopback:
  // measured against `0.0.0.0`, `dial ::1` is ECONNREFUSED.
  //
  // An EMPTY --hostname decides by the socket that actually bound, not by
  // spelling (R10-1): Node's `_listen2` tries the IPv6 unspecified address
  // for it and falls back to `0.0.0.0` when IPv6 is unavailable, so on the
  // fallback host the socket is IPv4 while the spelling said IPv6 — handing
  // workers `[::1]` there dialled an address nothing listens on, and the
  // first worker's failure exited the daemon. Explicit `::`/`[::]` and
  // `0.0.0.0` keep their spelling-based family mapping: those binds fail
  // loud when their family is unavailable, so the spelling cannot lie about
  // them.
  const v6Loopback = ipv6LoopbackAssigned
    ? `${scheme}://[::1]:${port}`
    : `${scheme}://127.0.0.1:${port}`;
  if (normalized === '') {
    return boundFamily === 'IPv4'
      ? `${scheme}://127.0.0.1:${port}`
      : v6Loopback;
  }
  if (canonicalIp === '::') {
    return v6Loopback;
  }
  // The v4 wildcard's IPv4-mapped spelling `::ffff:0.0.0.0` canonicalizes to
  // `::ffff:0:0` (WHATWG URL serializes the mapped form by dropping the
  // dotted quad), so it matches neither wildcard above. Node binds it as a
  // WORKING wildcard (R14-2): measured on this Node, the socket reports
  // family IPv6 yet serves v4 loopback — `dial 127.0.0.1` -> ok while
  // `dial ::1` -> ECONNREFUSED — so it maps to v4 loopback, NOT `[::1]`,
  // and an operator who copied the address from `ss`/`netstat` (which render
  // v4 connections on dual-stack sockets as `::ffff:...`) gets channels
  // that start instead of a boot refusal.
  if (canonicalIp === '0.0.0.0' || canonicalIp === '::ffff:0:0') {
    return `${scheme}://127.0.0.1:${port}`;
  }
  return `${scheme}://${formatHostForUrl(host)}:${port}`;
}

/**
 * Refuse a channel boot whose worker URL this host cannot answer.
 *
 * Workers run on the daemon's own machine and dial the address it actually
 * bound. Loopback is not a fallback: `--hostname 192.168.1.100` binds that
 * socket ONLY, so a worker sent to `127.0.0.1` gets `ECONNREFUSED`. A bind
 * this host cannot certify as its own — a DNS name, or a literal on no local
 * interface — passes every other boot check and then throws inside each
 * worker: the first one's failure exits the daemon, and channels added later
 * restart-loop while `/health` stays green. Name it once, at boot.
 */
export function assertChannelWorkerDaemonUrlIsLocal(
  workerDaemonUrl: string,
  hostname: string,
): void {
  let host: string;
  try {
    host = new URL(workerDaemonUrl).hostname;
  } catch {
    // A zone-scoped bind (`fe80::1%eth0`) arrives percent-encoded and WHATWG
    // URL rejects zone IDs outright, so the worker pipeline cannot carry it
    // even though this host answers on the address — refuse with the named
    // boot diagnostic instead of a raw ERR_INVALID_URL.
    throw new Error(
      `Channels cannot start: --hostname "${hostname}" cannot be carried in ` +
        `a worker URL (a zone-scoped address has no spelling the URL parser ` +
        `accepts). Bind to loopback, to the wildcard (0.0.0.0 / ::), or to ` +
        `a zone-less literal address of one of this machine's interfaces.`,
    );
  }
  if (isHostGateLoopback(host)) return;
  if (isLoopbackBind(host)) {
    // A wide 127/8 bind passes `isLoopbackBind` and the kernel routes it to
    // loopback, but the primary Host gate answers only the spellings in
    // `LOOPBACK_BINDS` — every other 127.x.y.z gets 403 before a route.
    // Order matters: this refusal must run BEFORE the own-interface escape
    // below — a wide loopback address can be assigned to a local interface
    // (`ip addr add 127.0.0.2/8 dev lo`), and the gate 403s it either way.
    throw new Error(
      `Channels cannot start: --hostname "${hostname}" is a loopback ` +
        `address the daemon's Host header gate refuses (it answers only ` +
        `127.0.0.1, localhost, and [::1]), so channel workers cannot reach ` +
        `the daemon on it. Bind to one of those spellings, to the wildcard ` +
        `(0.0.0.0 / ::), or to a literal address of one of this machine's ` +
        `interfaces.`,
    );
  }
  if (isOwnInterfaceAddress(host)) return;
  throw new Error(
    `Channels cannot start: --hostname "${hostname}" is not a loopback bind ` +
      `and does not name an address on this host, so channel workers have no ` +
      `local URL to reach the daemon on. Bind to loopback, to the wildcard ` +
      `(0.0.0.0 / ::), or to a literal address of one of this machine's ` +
      `interfaces.`,
  );
}

export interface WorkerTlsTrustFailure {
  code: string;
  message: string;
}

const WORKER_TLS_TRUST_PROBE = `
import { isIP } from 'node:net';
import * as tls from 'node:tls';
const url = new URL(process.argv[1]);
const timeoutMs = Number(process.argv[2]);
const hostname = url.hostname.replace(/^\\[|\\]$/g, '');
let socket;
let settled = false;
const finish = (result) => {
  if (settled) return;
  settled = true;
  process.stdout.write(JSON.stringify(result));
  socket?.destroy();
};
try {
  socket = tls.connect({
    host: hostname,
    port: Number(url.port || '443'),
    rejectUnauthorized: true,
    ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
  }, () => finish({ ok: true }));
  socket.once('error', (error) => finish({
    ok: false,
    code: error.code ?? 'WORKER_TLS_VERIFY_FAILED',
    message: error.message,
  }));
  socket.setTimeout(timeoutMs, () => finish({
    ok: false,
    code: 'WORKER_TLS_VERIFY_TIMEOUT',
    message: 'TLS verification probe timed out.',
  }));
} catch (error) {
  finish({
    ok: false,
    code: error.code ?? 'WORKER_TLS_VERIFY_FAILED',
    message: error.message,
  });
}
`;

export async function verifyWorkerTlsTrust(opts: {
  daemonUrl: string;
  caCertPath: string;
  timeoutMs?: number;
}): Promise<WorkerTlsTrustFailure | undefined> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        WORKER_TLS_TRUST_PROBE,
        opts.daemonUrl,
        String(timeoutMs),
      ],
      {
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: opts.caCertPath,
        },
        encoding: 'utf8',
        timeout: timeoutMs + 1_000,
      },
      (error, stdout) => {
        try {
          const result = JSON.parse(stdout) as
            | { ok: true }
            | { ok: false; code: string; message: string };
          resolve(result.ok ? undefined : result);
        } catch {
          const failure = error as NodeJS.ErrnoException | null;
          resolve({
            code:
              failure?.code != null
                ? String(failure.code)
                : 'WORKER_TLS_VERIFY_FAILED',
            message: failure?.message ?? 'TLS verification probe failed.',
          });
        }
      },
    );
  });
}

/**
 * Two TLS misconfigurations boot green and break only the channel workers:
 * a serving cert that is not its own trust anchor (workers fail
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE`) and one whose SANs do not cover the
 * loopback host workers dial (`ERR_TLS_CERT_ALTNAME_INVALID`). In both cases
 * the daemon listens, browsers connect and `/health` stays green while every
 * worker restart-loops, so name them at boot the way the expiry guard does.
 */
export function describeWorkerTlsTrustGaps(opts: {
  cert: Buffer;
  certPath: string;
  /** Existing source file for loader inspection; omit for in-memory callers. */
  certSourcePath?: string;
  daemonUrl: string;
  operatorCaCertPath?: string;
  /** Existing operator source file for loader inspection. */
  operatorCaCertSourcePath?: string;
  /**
   * Contents of `operatorCaCertPath`, when it was readable. A path alone says
   * nothing — a typo'd, unrelated or unloadable NODE_EXTRA_CA_CERTS anchors
   * exactly as little as no CA at all, and treating "the variable is set" as
   * coverage is what silenced the warning in the cases it was written for.
   */
  operatorCaCert?: Buffer;
  /**
   * The error code from reading `operatorCaCertPath`, when the read failed.
   * Passing the path through as if its contents had been inspected is how the
   * gap below came to assert an unknowable content fact ("does not carry a
   * certificate that anchors it") and prescribe an action the operator had
   * already taken, when the file holds exactly the issuing CA and only its
   * permissions are wrong.
   */
  operatorCaCertReadError?: string;
}): string[] {
  // A serving file is routinely a fullchain (leaf + issuing CA in one PEM),
  // and the supervisor injects the whole file as the workers'
  // NODE_EXTRA_CA_CERTS — so the trust question is about the file, not about
  // its first block alone.
  const chain = parseCertChain(opts.cert);
  // The leaf is whatever BOOT parsed, not whatever the loose split matched
  // first. `parseCertChain`'s regex is unanchored, so an indented leading
  // block — prose to the column-0 readers, i.e. to `new X509Certificate` here
  // and to the workers' loader — still matched it, and every leaf-dependent
  // check below (SAN gap, expiry skip, issuer message) then judged a
  // certificate the daemon never serves: measured `gaps: []` at boot against
  // ERR_TLS_CERT_ALTNAME_INVALID on every worker handshake.
  const x509 = bootParsedLeaf(opts.cert);
  if (!x509) {
    // Boot validation already rejected unparseable certs with a better message.
    return [];
  }
  const gaps: string[] = [];
  // Exactly what a worker gets: the serving file merged with the operator's
  // CA file (see resolveWorkerCaCertPath in channel-worker-supervisor.ts).
  //
  // The merge is all-or-nothing, and judges both files with the loader's own
  // rules — so an operator file Node cannot load contributes NOTHING to the
  // workers' trust and makes the merge hand them the daemon cert alone.
  // Judging it here with the looser `parseCertChain` (which also falls back to
  // DER, a format NODE_EXTRA_CA_CERTS never reads) is how a fused or DER
  // operator bundle got counted as an anchor at boot: the daemon log stayed
  // clean while every worker handshake failed UNABLE_TO_VERIFY_LEAF_SIGNATURE.
  const operatorChain = opts.operatorCaCert
    ? loadableCertificates(
        opts.operatorCaCert.toString('utf8'),
        opts.operatorCaCertSourcePath,
      )
    : undefined;
  // Same rule for the serving file — and when it fails, the merge does NOT
  // merge. `resolveWorkerCaCertPath` finds `daemonBlocks === undefined`,
  // discards the operator CA and hands workers the serving file alone, so
  // modelling a merged store here would report no gap while every worker
  // handshake fails. (A serving file that fails extraction can still serve:
  // `createSecureContext` accepts shapes the loader's framing rejects, so the
  // "it would have thrown at boot" premise this fallback used to carry was
  // false.)
  const servingBlocks = loadableCertificates(
    opts.cert.toString('utf8'),
    opts.certSourcePath,
  );
  // An unreadable serving file is a gap on its own terms: the workers receive
  // it as their whole bundle and their loader takes NOTHING from it, whether
  // or not an operator CA was set. Gating this on `operatorChain` reported
  // zero gaps on the no-operator path while every worker restart-looped —
  // the same hole that was closed, and tested, only for the with-operator case.
  const operatorDiscarded = !servingBlocks && operatorChain !== undefined;
  // The fallback keeps a leaf to reason about rather than reporting phantom
  // gaps, but it must not pretend the operator CA reached the workers — and it
  // must reason from the SAME leaf boot parsed, so the loose split only ever
  // supplies the rest of the chain.
  const servingChain =
    servingBlocks === undefined
      ? [
          x509,
          ...chain.filter(
            (member) => member.fingerprint256 !== x509.fingerprint256,
          ),
        ]
      : // The loader can read blocks out of the file and still not read the
        // block the daemon SERVES — a leaf exported by `openssl x509
        // -trustout` carries the `TRUSTED CERTIFICATE` label, which is not one
        // the loader takes a certificate from, so a `trusted leaf + plain root`
        // serving file yields `servingBlocks = [root]`. Starting the walk at
        // that root put it at depth 0, where the leaf-depth exemption below
        // waives the CA-capability check, and the walk returned anchored with
        // zero gaps: measured `gaps: []` at boot for a CA:FALSE root
        // (handshake INVALID_PURPOSE) and for a CA:TRUE root without
        // keyCertSign (handshake UNSPECIFIED), while `createSecureContext`
        // accepts the file and the daemon boots green and silent.
        //
        // So anchor the walk at the certificate boot parsed, the way the
        // `servingBlocks === undefined` fallback above already does; the
        // remaining blocks supply the rest of the chain.
        servingBlocks.some(
            (block) => block.fingerprint256 === x509.fingerprint256,
          )
        ? servingBlocks
        : [x509, ...servingBlocks];
  // Whether the leaf the walk starts from is one the workers' loader actually
  // gives them. It is not when the block the daemon serves is a block the
  // loader skips and the leaf had to be prepended above — a distinction that
  // only bites a SELF-SIGNED leaf, which anchors nothing it is absent from.
  const leafHeldByWorkers =
    servingBlocks !== undefined &&
    servingBlocks.some((block) => block.fingerprint256 === x509.fingerprint256);
  const workerTrustStore =
    operatorChain && servingBlocks
      ? [...operatorChain, ...servingChain]
      : servingChain;
  // A leaf in NODE_EXTRA_CA_CERTS is a usable trust anchor only when it signed
  // itself: chain verification has no PARTIAL_CHAIN flag here, so a CA-issued
  // leaf (what the `mkcert` flow this project documents produces) never
  // terminates the chain — unless something else in the worker's bundle
  // carries the issuer that does.
  const anchorPath = walkWorkerAnchorPath(
    x509,
    workerTrustStore,
    // The `servingBlocks === undefined` fallback prepends the leaf too, but
    // that file already reports its own gap below and the workers receive it
    // verbatim; only the partial-read case needs the distinction.
    servingBlocks === undefined || leafHeldByWorkers,
  );
  // R7-2: this gap is pushed only after the anchor walk, because the read
  // error alone does not decide the outcome. `resolveWorkerCaCertPath`'s catch
  // hands the workers the SERVING file as their extra-CA store, and a
  // fullchain (certbot/mkcert's normal shape) anchors itself through it — the
  // walk above returns `anchored: true` for exactly that shape while this
  // message used to announce a certain UNABLE_TO_VERIFY_LEAF_SIGNATURE outage
  // that never happens.
  if (opts.operatorCaCertReadError !== undefined) {
    // The reassurance is only true when the fallback the workers get is
    // loadable: with `servingBlocks === undefined` the merge hands them the
    // serving file itself, their loader takes nothing from it, and
    // `anchored: true` above judged a certificate they never receive.
    const servingFallbackAnchors =
      anchorPath.anchored && servingBlocks !== undefined;
    gaps.push(
      `NODE_EXTRA_CA_CERTS "${opts.operatorCaCertPath}" could not be read by ` +
        `the daemon (${opts.operatorCaCertReadError}), so channel workers ` +
        `receive no CA from it — a root-owned or mode-600 file is the usual ` +
        `cause, and its contents are not the problem. ` +
        (servingFallbackAnchors
          ? `--tls-cert "${opts.certPath}" carries an anchor of its own, and ` +
            `that file is what the workers fall back to, so their trust does ` +
            `not rest on this one today — whatever it was meant to add ` +
            `reaches nobody. Fix that file's permissions or path and restart.`
          : servingBlocks === undefined
            ? `--tls-cert "${opts.certPath}" itself holds no block the ` +
              `workers' loader can read, so their fallback bundle is that ` +
              `file alone and it anchors nothing — fixing this CA file's ` +
              `permissions changes nothing; re-export the serving file as ` +
              `the gap below describes and restart.`
            : `Every worker handshake to the daemon will fail ` +
              `UNABLE_TO_VERIFY_LEAF_SIGNATURE unless the issuing CA is ` +
              `already in the workers' default trust store. Fix that file's ` +
              `permissions or path and restart.`),
    );
  } else if (opts.operatorCaCert && !operatorChain) {
    gaps.push(
      `NODE_EXTRA_CA_CERTS "${opts.operatorCaCertPath}" holds no PEM ` +
        `certificate block Node's loader can read — every ` +
        `-----BEGIN/END CERTIFICATE----- marker must sit alone on its own ` +
        `line and every block must decode, and a DER file is never read at ` +
        `all. Channel workers therefore receive the daemon cert alone and ` +
        `anchor nothing through this file. Re-export it as PEM and restart.`,
    );
  }
  if (!servingBlocks) {
    gaps.push(
      `--tls-cert "${opts.certPath}" holds no PEM certificate block Node's ` +
        `loader can read, so ` +
        (operatorDiscarded
          ? `the channel workers' bundle cannot be merged: they receive that ` +
            `file alone and NODE_EXTRA_CA_CERTS "${opts.operatorCaCertPath}" ` +
            `is discarded. `
          : `the channel workers receive a bundle their loader takes nothing ` +
            `from. `) +
        `Every worker handshake to the daemon will fail ` +
        `UNABLE_TO_VERIFY_LEAF_SIGNATURE. Re-export --tls-cert as PEM with ` +
        `every -----BEGIN/END CERTIFICATE----- marker alone on its own line ` +
        `and restart.`,
    );
  }
  const leafPurposeDefect = tlsServerPurposeDefect(x509);
  if (leafPurposeDefect) {
    gaps.push(
      `--tls-cert "${opts.certPath}" cannot be used as a TLS server ` +
        `certificate because ${leafPurposeDefect}. Every worker handshake ` +
        `to the daemon will fail INVALID_PURPOSE. Reissue the leaf with a ` +
        `TLS-server keyUsage and serverAuth extendedKeyUsage, then restart.`,
    );
  }
  if (anchorPath.nonCaTerminator) {
    // `cannotIssueCertificates` refuses a terminator for THREE independent
    // reasons, and naming only the basicConstraints one sent the operator of a
    // CA:TRUE root whose keyUsage omits keyCertSign round a reissue/restart
    // loop: it was told its root "carries basicConstraints CA:FALSE" (false),
    // that handshakes fail INVALID_PURPOSE (measured: "key usage does not
    // include certificate signing"), and to reissue with CA:TRUE — which it
    // already is. Same split the sibling `incapableIssuer` branch makes.
    const terminatorSubject = anchorPath.nonCaTerminator.subject.replace(
      /\r?\n/g,
      ', ',
    );
    gaps.push(
      issuerRefusedForKeyUsage(anchorPath.nonCaTerminator)
        ? `--tls-cert "${opts.certPath}" chains up to ` +
            `"${terminatorSubject}", which is self-signed but whose keyUsage ` +
            `does not include keyCertSign, so OpenSSL refuses to let it issue ` +
            `the certificates below it however its basicConstraints reads. ` +
            `Every worker handshake to the daemon will fail "key usage does ` +
            `not include certificate signing" even though the chain terminates ` +
            `on a self-signed certificate. Reissue that certificate with ` +
            `keyCertSign in its keyUsage and restart — CA:TRUE alone does not ` +
            `fix it, and no NODE_EXTRA_CA_CERTS can anchor a self-signed ` +
            `certificate through anything but itself.`
        : `--tls-cert "${opts.certPath}" chains up to ` +
            `"${terminatorSubject}", which is self-signed but is not a CA — it ` +
            `carries basicConstraints CA:FALSE or, as an X.509 v3 certificate, ` +
            `no basicConstraints at all, and OpenSSL refuses to let it issue ` +
            `the certificates below it, so every worker handshake to the ` +
            `daemon will fail INVALID_PURPOSE ("unsuitable certificate ` +
            `purpose"). Reissue that certificate with CA:TRUE, or point ` +
            `NODE_EXTRA_CA_CERTS at a real CA that anchors the chain, and ` +
            `restart.`,
    );
  } else if (anchorPath.incapableIssuer) {
    const keyUsageIsTheCause = issuerRefusedForKeyUsage(
      anchorPath.incapableIssuer,
    );
    gaps.push(
      `--tls-cert "${opts.certPath}" chains through ` +
        `"${anchorPath.incapableIssuer.subject.replace(/\r?\n/g, ', ')}", ` +
        (keyUsageIsTheCause
          ? `whose keyUsage does not include keyCertSign, so OpenSSL refuses ` +
            `to let it issue the certificate below it however its ` +
            `basicConstraints reads. Every worker handshake to the daemon ` +
            `will fail with an invalid-CA error even though the chain looks ` +
            `complete, and the issuing CA IS in their bundle. Reissue that ` +
            `intermediate with keyCertSign in its keyUsage and restart — ` +
            `pointing NODE_EXTRA_CA_CERTS elsewhere cannot fix it.`
          : `which is not a CA — it carries basicConstraints CA:FALSE or, as ` +
            `an X.509 v3 certificate, no basicConstraints at all, and ` +
            `OpenSSL refuses to let it issue the certificate below it. Every ` +
            `worker handshake to the daemon will fail INVALID_PURPOSE or ` +
            `INVALID_CA even though the chain looks complete. Reissue that ` +
            `intermediate with CA:TRUE, or point NODE_EXTRA_CA_CERTS at a ` +
            `chain whose intermediates are real CAs, and restart.`),
    );
  } else if (anchorPath.pathLengthViolation) {
    const { cert, constraint } = anchorPath.pathLengthViolation;
    gaps.push(
      `--tls-cert "${opts.certPath}" chains through ` +
        `"${cert.subject.replace(/\r?\n/g, ', ')}", whose basicConstraints ` +
        `carries pathlen:${constraint} — it permits at most ${constraint} ` +
        `intermediate CA${constraint === 1 ? '' : 's'} below it, and this ` +
        `chain has more. Every worker handshake to the daemon will fail ` +
        `PATH_LENGTH_EXCEEDED even though every certificate in the bundle ` +
        `verifies. Reissue that CA with a pathlen that covers the chain, or ` +
        `shorten the chain, and restart.`,
    );
  } else if (anchorPath.unheldSelfSignedLeaf) {
    gaps.push(
      `--tls-cert "${opts.certPath}" serves a self-signed certificate whose ` +
        `own PEM block is not one Node's NODE_EXTRA_CA_CERTS loader takes ` +
        `(a -----BEGIN TRUSTED CERTIFICATE----- block, as \`openssl x509 ` +
        `-trustout\` writes, is the usual cause), so the channel workers ` +
        `never receive that certificate — and a self-signed certificate ` +
        `verifies only when it is itself in the trust store. The daemon ` +
        `serves it fine, but every worker handshake will fail ` +
        `DEPTH_ZERO_SELF_SIGNED_CERT with nothing logged. Re-export ` +
        `--tls-cert with a plain -----BEGIN CERTIFICATE----- block and ` +
        `restart.`,
    );
  } else if (!anchorPath.anchored) {
    gaps.push(
      `--tls-cert "${opts.certPath}" is issued by another CA ` +
        `(${x509.issuer.replace(/\r?\n/g, ', ')}), not self-signed, and ` +
        `${
          !opts.operatorCaCertPath
            ? `no NODE_EXTRA_CA_CERTS is set`
            : opts.operatorCaCertReadError !== undefined
              ? `NODE_EXTRA_CA_CERTS "${opts.operatorCaCertPath}" could not ` +
                `be read, so whatever it carries reached nobody`
              : operatorDiscarded
                ? `NODE_EXTRA_CA_CERTS "${opts.operatorCaCertPath}" was ` +
                  `discarded together with the unloadable serving file ` +
                  `above, whatever it carries`
                : `NODE_EXTRA_CA_CERTS "${opts.operatorCaCertPath}" does not ` +
                  `carry a certificate that anchors it`
        }, so nothing in the channel workers' bundle anchors their trust — ` +
        `every worker handshake to the daemon will fail ` +
        `UNABLE_TO_VERIFY_LEAF_SIGNATURE unless the issuing CA is already in ` +
        `the workers' default trust store. ` +
        (operatorDiscarded
          ? `Re-export --tls-cert as described above and restart; ` +
            `NODE_EXTRA_CA_CERTS is not the file to change.`
          : opts.operatorCaCertReadError !== undefined
            ? `Make NODE_EXTRA_CA_CERTS readable by the daemon as described ` +
              `above and restart.`
            : `Point NODE_EXTRA_CA_CERTS at the issuing CA (for mkcert: ` +
              `"$(mkcert -CAROOT)/rootCA.pem") and restart.`),
    );
  }
  // `X509Certificate.verify` checks signatures only and never consults dates,
  // so an expired root or intermediate anchors "fine" here while every worker
  // handshake fails CERT_HAS_EXPIRED. Boot validation covers the leaf alone.
  const now = Date.now();
  for (const member of anchorPath.path) {
    if (member.fingerprint256 === x509.fingerprint256) continue;
    const subject = member.subject.replace(/\r?\n/g, ', ');
    // OpenSSL applies the server-purpose test to EVERY chain member, not
    // just the leaf (`check_purpose_ssl_server`), and `anyExtendedKeyUsage`
    // does not satisfy it in-chain — measured on Node v22.23.2: a CA:TRUE
    // keyCertSign intermediate carrying only clientAuth walks to anchored
    // here while every worker handshake fails INVALID_PURPOSE. `keyUsage`
    // is undefined when the certificate carries no extendedKeyUsage at all,
    // which OpenSSL accepts in a CA.
    if (member.keyUsage && !member.keyUsage.includes(TLS_SERVER_AUTH_OID)) {
      gaps.push(
        `--tls-cert "${opts.certPath}" chains through "${subject}", whose ` +
          `extendedKeyUsage does not include serverAuth — every worker ` +
          `handshake to the daemon will fail INVALID_PURPOSE. Reissue that ` +
          `chain member with serverAuth in its extendedKeyUsage and ` +
          `restart.`,
      );
      continue;
    }
    if (new Date(member.validTo).getTime() < now) {
      gaps.push(
        `--tls-cert "${opts.certPath}" chains through "${subject}", which ` +
          `expired on ${member.validTo} — every worker handshake to the ` +
          `daemon will fail CERT_HAS_EXPIRED. Renew that chain member and ` +
          `restart.`,
      );
    } else if (new Date(member.validFrom).getTime() > now) {
      gaps.push(
        `--tls-cert "${opts.certPath}" chains through "${subject}", which is ` +
          `not yet valid (validFrom: ${member.validFrom}) — every worker ` +
          `handshake to the daemon will fail CERT_NOT_YET_VALID. Check that ` +
          `chain member's notBefore date or the system clock.`,
      );
    }
  }
  const host = workerDialHost(opts.daemonUrl);
  if (host && !certCoversHost(x509, host)) {
    gaps.push(
      `--tls-cert "${opts.certPath}" has no subjectAltName covering ` +
        `"${host}", the host channel workers dial — every worker handshake ` +
        `will fail ERR_TLS_CERT_ALTNAME_INVALID. Reissue the certificate ` +
        `with that host in its SANs and restart.`,
    );
  }
  return gaps;
}

/** basicConstraints, 2.5.29.19, as the contents of its OBJECT IDENTIFIER. */
const BASIC_CONSTRAINTS_OID = Buffer.from([0x55, 0x1d, 0x13]);
/** keyUsage, 2.5.29.15, likewise. */
const KEY_USAGE_OID = Buffer.from([0x55, 0x1d, 0x0f]);
/** `keyCertSign` is bit 5 of the keyUsage BIT STRING, counted from the MSB. */
const KEY_CERT_SIGN_MASK = 0x04;
/** TLS server key usages: digitalSignature, keyEncipherment, keyAgreement. */
const TLS_SERVER_KEY_USAGE_MASK = 0xa8;
const TLS_SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1';
/** `[0] EXPLICIT Version DEFAULT v1` — the first TBSCertificate member. */
const VERSION_TAG = 0xa0;
/** `[3] EXPLICIT Extensions OPTIONAL` — the last one. */
const EXTENSIONS_TAG = 0xa3;
const SEQUENCE_TAG = 0x30;
const BOOLEAN_TAG = 0x01;
const INTEGER_TAG = 0x02;

/** The tag of the DER element at `at`, and the `[start, end)` of its contents. */
function derElementAt(
  der: Buffer,
  at: number,
): { tag: number; start: number; end: number } | undefined {
  const tag = der[at];
  const header = der[at + 1];
  if (tag === undefined || header === undefined) return undefined;
  let start = at + 2;
  let length = header & 0x7f;
  if ((header & 0x80) !== 0) {
    // Long form: the low bits count the length's own bytes. Certificates use
    // neither the indefinite form (zero bytes) nor more than four.
    if (length === 0 || length > 4) return undefined;
    let value = 0;
    for (let index = 0; index < length; index += 1) {
      const byte = der[start + index];
      if (byte === undefined) return undefined;
      value = value * 0x100 + byte;
    }
    start += length;
    length = value;
  }
  const end = start + length;
  return end <= der.length ? { tag, start, end } : undefined;
}

/** The TBSCertificate of `cert`: the first member of the outer SEQUENCE. */
function tbsCertificateOf(
  cert: X509Certificate,
): { tag: number; start: number; end: number } | undefined {
  const certificate = derElementAt(cert.raw, 0);
  if (certificate?.tag !== SEQUENCE_TAG) return undefined;
  const tbs = derElementAt(cert.raw, certificate.start);
  return tbs?.tag === SEQUENCE_TAG ? tbs : undefined;
}

/**
 * The value bytes of `cert`'s `oid` extension, or `undefined` when it carries
 * none. Searching `cert.raw` for the OID bytes instead — what this file did
 * for basicConstraints — also matches them inside a signature or a key.
 */
function certificateExtension(
  cert: X509Certificate,
  oid: Buffer,
): Buffer | undefined {
  const der = cert.raw;
  const tbs = tbsCertificateOf(cert);
  if (!tbs) return undefined;
  let at = tbs.start;
  while (at < tbs.end) {
    const member = derElementAt(der, at);
    if (!member) return undefined;
    if (member.tag !== EXTENSIONS_TAG) {
      at = member.end;
      continue;
    }
    const list = derElementAt(der, member.start);
    if (list?.tag !== SEQUENCE_TAG) return undefined;
    let entry = list.start;
    while (entry < list.end) {
      // Extension ::= SEQUENCE { extnID OID, critical BOOLEAN DEFAULT FALSE,
      // extnValue OCTET STRING }.
      const extension = derElementAt(der, entry);
      if (extension?.tag !== SEQUENCE_TAG) return undefined;
      const id = derElementAt(der, extension.start);
      if (!id) return undefined;
      let valueAt = id.end;
      const critical = derElementAt(der, valueAt);
      if (critical?.tag === BOOLEAN_TAG) valueAt = critical.end;
      const value = derElementAt(der, valueAt);
      if (!value) return undefined;
      if (der.subarray(id.start, id.end).equals(oid)) {
        return der.subarray(value.start, value.end);
      }
      entry = extension.end;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Whether a keyUsage extension whose value is `der` allows `keyCertSign`.
 * The value wraps `BIT STRING { unusedBits, bits… }`; a certificate that
 * encodes no bit at all cannot allow it.
 */
function keyUsageAllowsCertSign(der: Buffer): boolean {
  const bits = derElementAt(der, 0);
  if (!bits) return false;
  const first = der[bits.start + 1];
  return first !== undefined && (first & KEY_CERT_SIGN_MASK) !== 0;
}

function tlsServerPurposeDefect(cert: X509Certificate): string | undefined {
  const keyUsage = certificateExtension(cert, KEY_USAGE_OID);
  if (keyUsage !== undefined) {
    const bits = derElementAt(keyUsage, 0);
    const first = bits ? keyUsage[bits.start + 1] : undefined;
    if (first === undefined || (first & TLS_SERVER_KEY_USAGE_MASK) === 0) {
      return 'its keyUsage permits none of digitalSignature, keyEncipherment, or keyAgreement';
    }
  }
  if (cert.keyUsage && !cert.keyUsage.includes(TLS_SERVER_AUTH_OID)) {
    return 'its extendedKeyUsage does not include serverAuth';
  }
  return undefined;
}

/**
 * Whether `cert` is an X.509 v1 certificate. `version` is `[0] EXPLICIT …
 * DEFAULT v1`, and DER omits a member at its default, so a v1 certificate's
 * TBSCertificate opens straight on the serial number.
 */
function isV1Certificate(cert: X509Certificate): boolean {
  const tbs = tbsCertificateOf(cert);
  return tbs !== undefined && cert.raw[tbs.start] !== VERSION_TAG;
}

/**
 * Whether OpenSSL would refuse to let the SELF-SIGNED `cert` issue the
 * certificate below it — `check_ca()` in `v3_purp.c`, in the same order.
 *
 * `X509Certificate.ca` alone is not that answer: it is `false` for an explicit
 * `basicConstraints CA:FALSE`, for an X.509 v1 / no-extension root (old
 * internal PKIs, `openssl x509 -req -signkey`) that OpenSSL accepts, and for a
 * v3 root carrying only `keyUsage keyCertSign` that OpenSSL also accepts.
 * Reading basicConstraints' presence alone is not it either: a v3 root with
 * other extensions but no basicConstraints and no keyCertSign is one OpenSSL
 * refuses, and this diagnostic reported it anchored.
 *
 * Every branch is measured on Node v22.23.0 / OpenSSL 3.0.13 as a real
 * `tls.connect` against a server holding a leaf the root signed, with the
 * fullchain as the trust store — the shape a channel worker gets:
 *
 * - v3, subjectKeyIdentifier only …………………… INVALID_PURPOSE  (refused)
 * - v3, keyUsage keyCertSign, no basicConstraints … authorized (accepted)
 * - v3, basicConstraints CA:TRUE + keyCertSign …… authorized (accepted)
 * - v1, no extensions ……………………………………… authorized (accepted)
 * - v3, CA:TRUE but keyUsage WITHOUT keyCertSign … refused (keyUsage first)
 * - v3, CA:FALSE but keyUsage WITH keyCertSign …… INVALID_PURPOSE (refused)
 */
function cannotIssueCertificates(cert: X509Certificate): boolean {
  const keyUsage = certificateExtension(cert, KEY_USAGE_OID);
  // keyUsage, where present, must allow certificate signing whatever
  // basicConstraints goes on to say.
  if (keyUsage !== undefined && !keyUsageAllowsCertSign(keyUsage)) return true;
  if (certificateExtension(cert, BASIC_CONSTRAINTS_OID) !== undefined) {
    return !cert.ca;
  }
  // No basicConstraints: a self-signed v1 root is still a CA (`X509_check_ca`
  // returns 3), and so is a certificate whose keyUsage allows certificate
  // signing (4). Nothing else is.
  return !isV1Certificate(cert) && keyUsage === undefined;
}

function isSelfSignedCert(x509: X509Certificate): boolean {
  if (x509.subject !== x509.issuer) return false;
  try {
    return x509.verify(x509.publicKey);
  } catch {
    // Unsupported key type: assume self-signed rather than warn on a guess.
    return true;
  }
}

// Base64 never contains `-`, so the body match cannot run past its own
// end marker and cannot backtrack.
const PEM_CERTIFICATE_BLOCK =
  /-----BEGIN CERTIFICATE-----[^-]*-----END CERTIFICATE-----/g;

/**
 * Every certificate in a PEM serving file, leaf first. `X509Certificate` reads
 * only the first block of a bundle, so a fullchain file has to be split before
 * any of it past the leaf can be reasoned about. A non-PEM (DER) buffer has no
 * blocks to split and is handed over whole.
 */
function parseCertChain(cert: Buffer): X509Certificate[] {
  const blocks = cert.toString('utf8').match(PEM_CERTIFICATE_BLOCK);
  if (!blocks) {
    try {
      return [new X509Certificate(cert)];
    } catch {
      return [];
    }
  }
  const chain: X509Certificate[] = [];
  for (const block of blocks) {
    try {
      chain.push(new X509Certificate(block));
    } catch {
      // One malformed block does not make the rest of the file unusable.
    }
  }
  return chain;
}

/**
 * The leaf boot validation and the workers' loader both read out of a serving
 * file: `X509Certificate` takes the FIRST column-0 block and nothing else.
 * `parseCertChain` deliberately reads more loosely so the rest of the chain can
 * be reasoned about; only this is the certificate the daemon actually serves.
 */
function bootParsedLeaf(cert: Buffer): X509Certificate | undefined {
  try {
    return new X509Certificate(cert);
  } catch {
    return undefined;
  }
}

/**
 * Whether `issuer` signed `cert` — name match plus signature, the two questions
 * OpenSSL asks before it asks whether the issuer is ALLOWED to issue.
 *
 * `X509Certificate.checkIssued` folds the third question in: it enforces the
 * issuer's keyUsage and returns false for an issuer whose keyUsage lacks
 * `keyCertSign`. Using it as the search predicate meant such an issuer was
 * never FOUND, so the walk fell through to the generic unanchored gap, whose
 * cause, predicted error code and remedy are all wrong for that shape (the
 * issuing chain IS in the bundle, the handshake fails `key usage does not
 * include certificate signing`, and no NODE_EXTRA_CA_CERTS change can fix it).
 * Splitting the questions lets `cannotIssueAsIntermediate` name it instead.
 */
function certIssuedBy(cert: X509Certificate, issuer: X509Certificate): boolean {
  try {
    return cert.issuer === issuer.subject && cert.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

/**
 * Why OpenSSL refuses to let `cert` issue the certificate below it — the two
 * causes `X509Certificate.ca === false` folds together, which the gap message
 * has to tell apart because they take different fixes.
 *
 * Measured on Node v22.23.0 / OpenSSL 3.0.13 as real worker-shape handshakes:
 * a CA:TRUE intermediate whose keyUsage omits `keyCertSign` reports
 * `ca === false` and fails `invalid CA certificate` — reissuing it "with
 * CA:TRUE", what this message used to advise, changes nothing.
 */
function issuerRefusedForKeyUsage(cert: X509Certificate): boolean {
  const keyUsage = certificateExtension(cert, KEY_USAGE_OID);
  return keyUsage !== undefined && !keyUsageAllowsCertSign(keyUsage);
}

/**
 * The `pathLenConstraint` of `cert`'s basicConstraints, or `undefined` when it
 * carries none. `BasicConstraints ::= SEQUENCE { cA BOOLEAN DEFAULT FALSE,
 * pathLenConstraint INTEGER (0..MAX) OPTIONAL }`, and DER omits `cA` at its
 * default — so the INTEGER is either the first member or the second.
 */
function pathLengthConstraint(cert: X509Certificate): number | undefined {
  const value = certificateExtension(cert, BASIC_CONSTRAINTS_OID);
  if (!value) return undefined;
  const sequence = derElementAt(value, 0);
  if (sequence?.tag !== SEQUENCE_TAG) return undefined;
  let at = sequence.start;
  const first = derElementAt(value, at);
  if (!first) return undefined;
  if (first.tag === BOOLEAN_TAG) at = first.end;
  const integer = derElementAt(value, at);
  if (integer?.tag !== INTEGER_TAG) return undefined;
  let length = 0;
  for (let index = integer.start; index < integer.end; index += 1) {
    const byte = value[index];
    if (byte === undefined) return undefined;
    length = length * 0x100 + byte;
  }
  return length;
}

/**
 * Walks the leaf up through the certificates the workers actually hold, and
 * reports both whether the walk terminated on a self-signed anchor and the
 * certificates it relied on. Workers get the whole bundle as their trust
 * store, so a fullchain that walks up to a self-signed root anchors fine even
 * though the leaf never could alone — and every member the walk leaned on is
 * a member whose own validity window the handshake will enforce.
 */
function walkWorkerAnchorPath(
  leaf: X509Certificate,
  chain: readonly X509Certificate[],
  /**
   * Whether `leaf` is a certificate the workers' loader actually hands them.
   * It is not when the caller had to PREPEND the boot-parsed leaf because the
   * serving file's own block is not one the loader takes.
   */
  leafHeldByWorkers = true,
): {
  anchored: boolean;
  path: readonly X509Certificate[];
  /** Set when the walk terminated on a self-signed cert that is not a CA. */
  nonCaTerminator?: X509Certificate;
  /** Set when the walk reached an issuer OpenSSL will not let issue. */
  incapableIssuer?: X509Certificate;
  /** Set when a CA's basicConstraints pathLenConstraint is exceeded. */
  pathLengthViolation?: { cert: X509Certificate; constraint: number };
  /**
   * Set when the walk would have terminated on a self-signed LEAF the workers
   * do not hold — an anchor that exists only in this model.
   */
  unheldSelfSignedLeaf?: X509Certificate;
} {
  let next: X509Certificate | undefined = leaf;
  const walked = new Set<string>();
  const path: X509Certificate[] = [];
  let pathLengthViolation:
    | { cert: X509Certificate; constraint: number }
    | undefined;
  while (next) {
    const current: X509Certificate = next;
    path.push(current);
    // `pathLenConstraint` caps how many intermediates may sit BELOW this CA.
    // It rides inside the same basicConstraints value the capability checks
    // already read, and went unread: a `pathlen:0` root over one intermediate
    // walked to `anchored: true` with zero gaps while every worker handshake
    // failed PATH_LENGTH_EXCEEDED (measured, exact worker shape).
    if (path.length > 1 && pathLengthViolation === undefined) {
      const constraint = pathLengthConstraint(current);
      const intermediatesBelow = path.length - 2;
      if (constraint !== undefined && intermediatesBelow > constraint) {
        pathLengthViolation = { cert: current, constraint };
      }
    }
    if (isSelfSignedCert(current)) {
      // OpenSSL applies its CA test to certificates that sign OTHER
      // certificates, not to a self-signed leaf trusted at depth 0. Measured
      // on Node 22: a CA:FALSE self-signed leaf in its own trust store
      // handshakes fine, while the same shape used as an issuer fails
      // INVALID_PURPOSE — so the constraint binds only past the leaf.
      if (path.length > 1 && cannotIssueCertificates(current)) {
        return { anchored: false, path, nonCaTerminator: current };
      }
      // R8-1: a self-signed certificate verifies only when it is ITSELF in
      // the trust store, so a leaf the workers never receive cannot terminate
      // their walk — however completely it terminates this one. The
      // fingerprint check upstream only decides whether to prepend it; once
      // prepended it self-anchored at path length 1 and boot reported zero
      // gaps. Measured on Node v22.23.0: a self-signed loopback leaf exported
      // with `openssl x509 -trustout` (a `TRUSTED CERTIFICATE` block, which
      // `createSecureContext` accepts and the loader skips) plus an unrelated
      // root is served green while every worker handshake fails
      // DEPTH_ZERO_SELF_SIGNED_CERT with an EMPTY stderr — the silent-green
      // outage this diagnostic exists to catch.
      if (path.length === 1 && !leafHeldByWorkers) {
        return { anchored: false, path, unheldSelfSignedLeaf: current };
      }
      return pathLengthViolation
        ? { anchored: false, path, pathLengthViolation }
        : { anchored: true, path };
    }
    walked.add(current.fingerprint256);
    const issuer: X509Certificate | undefined = chain.find(
      (candidate) =>
        !walked.has(candidate.fingerprint256) &&
        certIssuedBy(current, candidate),
    );
    // `certIssuedBy` asks only "did this sign that": name match plus signature.
    // OpenSSL asks a second question of every certificate it uses AS an issuer,
    // and answering only the first is how a chain that walks THROUGH an
    // incapable intermediate got reported anchored while every worker
    // handshake failed. Measured on Node 22 / OpenSSL 3 with real handshakes:
    // an explicit CA:FALSE intermediate and a v3 intermediate with no
    // basicConstraints both fail INVALID_PURPOSE, and a keyCertSign-only v3
    // intermediate fails INVALID_CA.
    if (issuer && !isSelfSignedCert(issuer) && !issuer.ca) {
      return { anchored: false, path, incapableIssuer: issuer };
    }
    next = issuer;
  }
  return pathLengthViolation
    ? { anchored: false, path, pathLengthViolation }
    : { anchored: false, path };
}

/**
 * WHATWG `URL.hostname` keeps the brackets on an IPv6 literal (`[::1]`), and
 * `isIP` does not recognise the bracketed form — so an unstripped host falls
 * through to the DNS-name branch of the SAN check, where it can never match
 * the iPAddress SAN such a certificate actually carries.
 */
function workerDialHost(daemonUrl: string): string | undefined {
  try {
    const hostname = new URL(daemonUrl).hostname;
    if (!hostname) return undefined;
    return hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  } catch {
    return undefined;
  }
}

function certCoversHost(x509: X509Certificate, host: string): boolean {
  try {
    // IP literals need an iPAddress SAN — checkServerIdentity has no CN
    // fallback for them — while names go through the normal host match.
    return isIP(host)
      ? Boolean(x509.checkIP(host))
      : Boolean(x509.checkHost(host));
  } catch {
    return true;
  }
}

/**
 * Pull the `context.fileName` snapshot out of merged settings into a
 * typed string, falling back to `undefined` when the value is missing
 * or malformed.
 *
 * Validation contract:
 *   - non-empty string after trim → returned trimmed
 *   - array → first non-empty string element after trim, or undefined
 *   - anything else (object, number, boolean, undefined) → undefined
 *
 * Returning `undefined` leaves the workspace on the daemon's init-default
 * chain — the primary workspace's configured `context.fileName` snapshot
 * (`contextFilenameForInit`), then the hard-coded `QWEN.md` — so a malformed
 * value keeps the daemon alive rather than producing a garbage filename.
 */
export function extractContextFilename(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (trimmed !== '') return trimmed;
      }
    }
    return undefined;
  }
  return undefined;
}

function sessionArtifactsPersistenceAvailableFromSettings(
  settings: { general?: { chatRecording?: unknown } } | undefined,
): boolean {
  return settings?.general?.chatRecording !== false;
}

/**
 * Reads the optional `serve.maxConcurrentSubSessions*` overrides. Only
 * positive integers are honored; anything else falls back to the launcher's
 * built-in defaults. A present-but-invalid value is reported through
 * `onWarning` (matching the other settings-load fallback sites in this file)
 * so an operator who mistypes a cap sees the fallback instead of silently
 * running on the default. Caps are a daemon-resource control, so an untrusted
 * workspace's settings (skipped at load time) must not raise them — the
 * caller passes the already trust-filtered merged settings.
 */
export function subSessionConcurrencyCapsFromSettings(
  serve: {
    maxConcurrentSubSessionsPerCaller?: unknown;
    maxConcurrentSubSessionsTotal?: unknown;
  },
  onWarning: (message: string) => void = writeStderrLine,
): {
  maxConcurrentPerCaller?: number;
  maxConcurrentTotal?: number;
} {
  const asCap = (key: string, value: unknown): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
      return value;
    }
    onWarning(
      `qwen serve: ignoring invalid ${key} (${JSON.stringify(value)}); ` +
        `expected a positive integer, falling back to the built-in default.`,
    );
    return undefined;
  };
  const maxConcurrentPerCaller = asCap(
    'maxConcurrentSubSessionsPerCaller',
    serve.maxConcurrentSubSessionsPerCaller,
  );
  const maxConcurrentTotal = asCap(
    'maxConcurrentSubSessionsTotal',
    serve.maxConcurrentSubSessionsTotal,
  );
  return {
    ...(maxConcurrentPerCaller !== undefined ? { maxConcurrentPerCaller } : {}),
    ...(maxConcurrentTotal !== undefined ? { maxConcurrentTotal } : {}),
  };
}

/**
 * Per-workspace promise chain that serializes settings read-modify-write
 * cycles inside this process.
 *
 * Both `persistApprovalMode` and `persistDisabledTools` re-read
 * `tools.disabled` (or `tools.approvalMode`) from disk before writing
 * the merged result back, which is a textbook lost-update window if
 * two concurrent HTTP requests land at the same workspace. Threading
 * each call through this lock collapses the window.
 *
 * Scope is INTRA-process: per-workspace single-daemon is the supported
 * deployment shape. Errors propagate to the caller; the chain advances
 * to the next waiter regardless via the `.then(fn, fn)` pattern, so a
 * single failed write doesn't permanently stall persistence.
 */
const settingsWriteLocks = new Map<string, Promise<unknown>>();
function withSettingsLock<T>(
  workspace: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = settingsWriteLocks.get(workspace) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  settingsWriteLocks.set(workspace, next);
  return next;
}

export interface RunHandle {
  server: Server;
  url: string;
  bridge: AcpSessionBridge;
  /**
   * Whether the Web Shell UI was actually mounted (assets resolved and
   * `serveWebShell !== false`). The `--open` launcher checks this so it never
   * points a browser at an API-only daemon.
   */
  webShellMounted: boolean;
  /**
   * The bearer token the daemon actually authenticates against (already
   * trimmed), or undefined when none is configured. `--open` reads this so the
   * URL it hands the browser always matches the server's value instead of
   * re-deriving it from argv/env.
   */
  resolvedToken?: string;
  /** Resolves when the full REST/Web/ACP runtime has been mounted. */
  runtimeReady: Promise<void>;
  /**
   * The Local Control service, once the runtime app exists.
   *
   * A getter rather than a field because the runtime app is mounted after the
   * listener is up: at the moment this handle is constructed there is nothing
   * to hand back. Callers await `runtimeReady` first — before that it is
   * undefined, which is also what an API-only daemon returns forever.
   */
  getLocalControl(): LocalControlService | undefined;
  /** Resolves when the listener has fully closed and the bridge is drained. */
  close(): Promise<void>;
}

const retryableChannelWorkerShutdownErrors = new WeakSet<Error>();

function hasRetryableChannelWorkerShutdownError(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some(hasRetryableChannelWorkerShutdownError);
  }
  return (
    error instanceof Error && retryableChannelWorkerShutdownErrors.has(error)
  );
}

type CoreRuntime = typeof import('./core-runtime.js');
type LiveDiscoveryRuntime = typeof import('./live/discovery.js');
type ProviderConfig = NonNullable<ReturnType<CoreRuntime['findProviderById']>>;
type SettingsRuntime = typeof import('../config/settings.js');
type EnvironmentRuntime = typeof import('../config/environment.js');
type LoadedSettingsAdapterRuntime =
  typeof import('../config/loadedSettingsAdapter.js');
type TrustedFoldersRuntime = typeof import('../config/trustedFolders.js');
type ChannelServicePidfile = {
  readServiceInfo(): ServiceInfo | null;
  writeServeServiceInfo(opts: {
    channels: string[];
    servePid?: number;
    workerPid?: number;
    workers?: ServiceInfoWorker[];
  }): void;
  reserveServeServiceInfo(opts: {
    channels: string[];
    servePid?: number;
  }): void;
  removeServiceInfo(): void;
  removeServeServiceInfo?(servePid?: number): boolean;
};
type ChannelWorkerRuntime = {
  createChannelWorkerSupervisor(
    opts: CreateChannelWorkerSupervisorOptions,
  ): ChannelWorkerSupervisor;
  channelServicePidfile: ChannelServicePidfile;
  loadChannelsConfig: (typeof import('../commands/channel/runtime.js'))['loadChannelsConfig'];
  createChannelWorkerGroup: (typeof import('./channel-worker-group.js'))['createChannelWorkerGroup'];
  createChannelWorkerManager: (
    opts: CreateChannelWorkerManagerOptions,
  ) => ChannelWorkerManager;
  findCliEntryPath(): string;
  resolveWorkerCaCertPath(
    daemonCertPath: string,
    existing: string | undefined,
  ): string;
};

let channelWorkerRuntimePromise: Promise<ChannelWorkerRuntime> | undefined;
async function loadChannelWorkerRuntime(): Promise<ChannelWorkerRuntime> {
  channelWorkerRuntimePromise ??= Promise.all([
    import('./channel-worker-supervisor.js'),
    import('../commands/channel/pidfile.js'),
    import('../commands/channel/runtime.js'),
    import('../commands/channel/cli-entry-path.js'),
    import('./channel-worker-group.js'),
    import('./channel-worker-manager.js'),
  ])
    .then(
      ([
        supervisor,
        pidfile,
        channelRuntime,
        cliEntryPath,
        workerGroup,
        workerManager,
      ]) => ({
        createChannelWorkerSupervisor: supervisor.createChannelWorkerSupervisor,
        resolveWorkerCaCertPath: supervisor.resolveWorkerCaCertPath,
        channelServicePidfile: pidfile,
        loadChannelsConfig: channelRuntime.loadChannelsConfig,
        createChannelWorkerGroup: workerGroup.createChannelWorkerGroup,
        createChannelWorkerManager: workerManager.createChannelWorkerManager,
        findCliEntryPath: cliEntryPath.findCliEntryPath,
      }),
    )
    .catch((err: unknown) => {
      channelWorkerRuntimePromise = undefined;
      throw err;
    });
  return channelWorkerRuntimePromise;
}

export function createDisabledChannelWorkerSupervisor(): ChannelWorkerSupervisor {
  const snapshot = {
    enabled: false,
    state: 'disabled' as const,
    channels: [],
  };
  return {
    async start() {},
    async stop() {},
    async restart() {
      return { ...snapshot, channels: [] };
    },
    killAllSync() {},
    snapshot: () => ({ ...snapshot, channels: [] }),
    async enqueueWebhookTask() {
      throw new ChannelWebhookEnqueueError(
        'channel_worker_unavailable',
        'Channel worker is not running.',
      );
    },
  };
}

function writeServeChannelReservation(
  channelServicePidfile: ChannelServicePidfile,
  channels: string[],
): void {
  channelServicePidfile.reserveServeServiceInfo({
    channels,
    servePid: process.pid,
  });
}

function channelServicePidfileConflictError(info: ServiceInfo): Error {
  const owner = info.owner === 'serve' ? 'qwen serve' : 'qwen channel start';
  return Object.assign(
    new Error(
      `Channel service is already running under ${owner} (PID ${info.pid}). Stop it before enabling daemon-managed channels.`,
    ),
    { code: 'channel_service_conflict', owner: info.owner, pid: info.pid },
  );
}

function channelServiceStartingConflictError(): Error {
  return Object.assign(
    new Error(
      'Channel service is already starting. Retry after the current startup finishes.',
    ),
    { code: 'channel_service_conflict' },
  );
}

function normalizeInstallModelIds(
  req: ServeAuthProviderInstallRequest,
  provider: ProviderConfig,
  getDefaultModelIds: CoreRuntime['getDefaultModelIds'],
): string[] {
  const fromRequest = req.modelIds
    ?.map((id) => id.trim())
    .filter((id) => id.length > 0);
  const modelIds =
    fromRequest && fromRequest.length > 0
      ? fromRequest
      : getDefaultModelIds(provider);
  return [...new Set(modelIds)];
}

function buildProviderSetupInputs(
  req: ServeAuthProviderInstallRequest,
  provider: ProviderConfig,
  helpers: {
    getDefaultModelIds: CoreRuntime['getDefaultModelIds'];
    resolveBaseUrl: CoreRuntime['resolveBaseUrl'];
  },
): ProviderSetupInputs {
  const protocol = (req.protocol ?? provider.protocol) as AuthType;
  const baseUrl = helpers.resolveBaseUrl(provider, req.baseUrl);
  return {
    ...(provider.protocolOptions ? { protocol } : {}),
    baseUrl,
    apiKey: req.apiKey.trim(),
    modelIds: normalizeInstallModelIds(
      req,
      provider,
      helpers.getDefaultModelIds,
    ),
    ...(req.advancedConfig ? { advancedConfig: req.advancedConfig } : {}),
  };
}

export interface RunQwenServeDeps {
  /** Bridge instance; tests inject a fake. Defaults to a fresh real one. */
  bridge?: AcpSessionBridge;
  /** Test/embed override for the plain HTTP server constructor. */
  httpServerFactory?: (app: Application) => Server;
  /**
   * Whether to start the real ACP child eagerly after listen. Production
   * keeps this on; tests can disable it so boot-path assertions do not wait
   * on a real child bridge.
   */
  preheatBridge?: boolean;
  /**
   * Workspace filesystem factory. When omitted, `runQwenServe`
   * constructs one using `boundWorkspace`, `trustedWorkspace`, and a
   * default warning-emit hook. Tests inject a real factory + custom
   * emit to capture audit events.
   */
  fsFactory?: WorkspaceFileSystemFactory;
  /**
   * Trust snapshot for the bound workspace at boot. Drives the
   * `WorkspaceFileSystem`'s `assertTrustedForIntent` gate — read
   * intents always pass; mutating intents (`write`, `edit`) throw
   * `untrusted_workspace` when this is false. Defaults to true:
   * the daemon binds at boot to a workspace the operator
   * explicitly chose, and the trust dialog flow that ungates write
   * permissions in the interactive CLI is not used by the daemon.
   * When omitted, the daemon evaluates the current trust policy and
   * hot-reloads runtime generations as that policy changes. Tests can pin
   * this value to disable hot reload and assert a fixed trust state.
   */
  trustedWorkspace?: boolean;
  /**
   * Audit-emit hook for `fs.access` / `fs.denied`. Defaults to a
   * stderr warning every 100 events so a regression that drops
   * audit emission stays visible in the operator log.
   */
  fsAuditEmit?: (event: BridgeEvent) => void;
  /**
   * Lightweight settings summary already loaded by the serve fast path.
   * Reusing it avoids a second pre-listen settings/env scan.
   */
  bootSettings?: ServeFastPathSettings;
  /**
   * Pre-resolved daemon debug directory. The full CLI/exported API can pass
   * Storage.getGlobalDebugDir(); the serve fast path intentionally avoids
   * importing core before listen and instead derives this from bootSettings.
   */
  daemonLogBaseDir?: string;
  /**
   * Internal CLI fast-path mode: resolve once the TCP listener is ready.
   * The default preserves the embedded API contract by resolving only after
   * the runtime bridge and routes are mounted.
   */
  resolveOnListen?: boolean;
  /**
   * Internal serve fast-path mode: keep bootstrap /health responsive before
   * starting the heavier runtime graph. A fallback timer still starts runtime
   * when no health probe arrives. Only applies with resolveOnListen.
   */
  deferRuntimeUntilFirstHealth?: boolean;
  /**
   * Bounds background runtime mounting after the listener is ready. Defaults to
   * QWEN_SERVE_RUNTIME_STARTUP_TIMEOUT_MS, then 120s. Use 0 to disable.
   */
  runtimeStartupTimeoutMs?: number;
  channelWorkerSupervisorFactory?: (
    opts: CreateChannelWorkerSupervisorOptions,
  ) => ChannelWorkerSupervisor;
  workerTlsTrustVerifier?: typeof verifyWorkerTlsTrust;
  /**
   * Test/embed override for the boot-time certification that the channel
   * worker daemon URL is local to this host. Production refuses a bind the
   * host cannot answer through `assertChannelWorkerDaemonUrlIsLocal`; tests
   * inject a recorder to pin that boot runs the certification before
   * starting workers.
   */
  channelWorkerUrlCertifier?: typeof assertChannelWorkerDaemonUrlIsLocal;
  channelServicePidfile?: ChannelServicePidfile;
  workspaceRegistrationStore?: WorkspaceRegistrationStore;
  /** Test/embed override; production uses the private user Conversations root. */
  liveConversationWorkspace?: ConversationWorkspace;
  /** Test/embed override; production uses ~/.qwen for the Live Host locator. */
  liveDiscoveryStableBaseDir?: string;
  /** Test/embed override for stable Live locator ownership handoff. */
  liveDiscoveryRetryDelayMs?: number;
  /** Test/embed override; production uses process.platform. */
  runtimePlatform?: NodeJS.Platform;
}

function shouldPreheatBridge(deps: RunQwenServeDeps): boolean {
  if (deps.preheatBridge !== undefined) return deps.preheatBridge;
  return process.env['VITEST_WORKER_ID'] === undefined;
}

let coreRuntimePromise: Promise<CoreRuntime> | undefined;
function loadCoreRuntime(): Promise<CoreRuntime> {
  coreRuntimePromise ??= import('./core-runtime.js');
  return coreRuntimePromise;
}

let liveDiscoveryRuntimePromise: Promise<LiveDiscoveryRuntime> | undefined;
function loadLiveDiscoveryRuntime(): Promise<LiveDiscoveryRuntime> {
  liveDiscoveryRuntimePromise ??= import('./live/discovery.js');
  return liveDiscoveryRuntimePromise;
}

async function resolveDaemonLogBaseDirForRun(input: {
  deps: RunQwenServeDeps;
  bootSettings: ServeFastPathSettings | undefined;
  boundWorkspace: string;
}): Promise<string> {
  if (input.deps.daemonLogBaseDir) {
    return input.deps.daemonLogBaseDir;
  }
  if (input.deps.bootSettings === undefined) {
    const core = await loadCoreRuntime();
    if (core.Storage.getRuntimeBaseDir() !== core.Storage.getGlobalQwenDir()) {
      return core.Storage.getGlobalDebugDir();
    }
  }
  if (input.bootSettings?.advanced?.runtimeOutputDir !== undefined) {
    return resolveDaemonLogBaseDir(
      input.bootSettings.advanced.runtimeOutputDir,
      input.boundWorkspace,
    );
  }
  if (input.deps.bootSettings !== undefined) {
    return resolveDaemonLogBaseDir(undefined, input.boundWorkspace);
  }
  const core = await loadCoreRuntime();
  return core.Storage.getGlobalDebugDir();
}

let settingsRuntimePromise:
  | Promise<{
      settings: SettingsRuntime;
      environment: EnvironmentRuntime;
      loadedSettingsAdapter: LoadedSettingsAdapterRuntime;
      trustedFolders: TrustedFoldersRuntime;
    }>
  | undefined;
function loadSettingsRuntimeModules(): Promise<{
  settings: SettingsRuntime;
  environment: EnvironmentRuntime;
  loadedSettingsAdapter: LoadedSettingsAdapterRuntime;
  trustedFolders: TrustedFoldersRuntime;
}> {
  settingsRuntimePromise ??= Promise.all([
    import('../config/settings.js'),
    import('../config/environment.js'),
    import('../config/loadedSettingsAdapter.js'),
    import('../config/trustedFolders.js'),
  ]).then(([settings, environment, loadedSettingsAdapter, trustedFolders]) => ({
    settings,
    environment,
    loadedSettingsAdapter,
    trustedFolders,
  }));
  return settingsRuntimePromise;
}

let channelWebhookConfigRuntimePromise:
  | Promise<ChannelWebhookConfigRuntime>
  | undefined;
function loadChannelWebhookConfigRuntime(): Promise<ChannelWebhookConfigRuntime> {
  channelWebhookConfigRuntimePromise ??= Promise.all([
    import('../commands/channel/runtime.js'),
    import('../commands/channel/config-utils.js'),
  ])
    .then(([channelRuntime, configUtils]) => ({
      loadChannelsConfig: channelRuntime.loadChannelsConfig,
      parseChannelWebhookConfig: configUtils.parseChannelWebhookConfig,
    }))
    .catch((err: unknown) => {
      channelWebhookConfigRuntimePromise = undefined;
      throw err;
    });
  return channelWebhookConfigRuntimePromise;
}

async function loadServeRuntimeModules() {
  const [
    serverModule,
    bridgeModule,
    spawnChannelModule,
    processRegistryModule,
    workspaceModule,
    workspaceTypesModule,
    daemonStatusProviderModule,
    workspaceProvidersStatusModule,
    workspaceSkillsStatusModule,
    totalSessionAdmissionModule,
    workspaceRegistryModule,
    promptLedgerModule,
  ] = await Promise.all([
    import('./server.js'),
    import('@qwen-code/acp-bridge/bridge'),
    import('@qwen-code/acp-bridge/spawnChannel'),
    import('@qwen-code/acp-bridge/processRegistry'),
    import('./workspace-service/index.js'),
    import('./workspace-service/types.js'),
    import('./daemon-status-provider.js'),
    import('./workspace-providers-status.js'),
    import('./workspace-skills-status.js'),
    import('./total-session-admission.js'),
    import('./workspace-registry.js'),
    import('./prompt-terminal-ledger.js'),
  ]);
  return {
    createServeApp: serverModule.createServeApp,
    getActiveSseCount: serverModule.getActiveSseCount,
    resolveBoundWorkspacesFromIdeEnv:
      serverModule.resolveBoundWorkspacesFromIdeEnv,
    resolveBridgeFsFactory: serverModule.resolveBridgeFsFactory,
    createAcpSessionBridge: bridgeModule.createAcpSessionBridge,
    createSpawnChannelFactory: spawnChannelModule.createSpawnChannelFactory,
    daemonAcpNdJsonLimits: spawnChannelModule.DAEMON_ACP_NDJSON_LIMITS,
    ProcessRegistry: processRegistryModule.ProcessRegistry,
    createDaemonWorkspaceService: workspaceModule.createDaemonWorkspaceService,
    WorkspaceSettingsPartialPersistError:
      workspaceTypesModule.WorkspaceSettingsPartialPersistError,
    createDaemonStatusProvider:
      daemonStatusProviderModule.createDaemonStatusProvider,
    createWorkspaceProvidersStatusProvider:
      workspaceProvidersStatusModule.createWorkspaceProvidersStatusProvider,
    createWorkspaceSkillsStatusProvider:
      workspaceSkillsStatusModule.createWorkspaceSkillsStatusProvider,
    createTotalSessionAdmissionController:
      totalSessionAdmissionModule.createTotalSessionAdmissionController,
    createWorkspaceRegistry: workspaceRegistryModule.createWorkspaceRegistry,
    createWorkspaceSessionOwnerIndex:
      workspaceRegistryModule.createWorkspaceSessionOwnerIndex,
    createWorkspaceGenerationGuard:
      workspaceRegistryModule.createWorkspaceGenerationGuard,
    createPromptLedgerSink: promptLedgerModule.createPromptLedgerSink,
  };
}

function advertisedMaxSessions(value: number | undefined): number | null {
  if (value === undefined) return DEFAULT_MAX_SESSIONS;
  if (value === 0 || value === Number.POSITIVE_INFINITY) return null;
  return value;
}

function advertisedMaxPendingPromptsPerSession(
  value: number | undefined,
): number | null {
  if (value === undefined) return DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION;
  if (value === 0 || value === Number.POSITIVE_INFINITY) return null;
  return value;
}

function channelIdleTimeoutMs(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_TIMEOUT_MS)
    : 0;
}

function sessionIdleTimeoutMs(value: number | undefined): number {
  return value !== undefined
    ? channelIdleTimeoutMs(value)
    : DEFAULT_SESSION_IDLE_TIMEOUT_MS;
}

function currentServeFeaturesForRunQwenServe(
  opts: ServeOptions,
  sessionShellCommandEnabled: boolean,
  sessionArtifactsPersistenceAvailable: boolean,
  currentSessionSchedulingAvailable: boolean,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return getAdvertisedServeFeatures(undefined, {
    requireAuth: opts.requireAuth === true,
    mcpPoolActive: opts.mcpPoolActive !== false,
    externalToolGuardActive: opts.externalToolGuard?.mode === 'required',
    allowOriginActive:
      opts.allowOrigins !== undefined && opts.allowOrigins.length > 0,
    ...(opts.promptDeadlineMs !== undefined
      ? { promptDeadlineMs: opts.promptDeadlineMs }
      : {}),
    ...(opts.writerIdleTimeoutMs !== undefined
      ? { writerIdleTimeoutMs: opts.writerIdleTimeoutMs }
      : {}),
    persistSettingAvailable: true,
    sessionShellCommandEnabled,
    sessionArtifactsPersistenceAvailable,
    sessionGenerationAvailable: true,
    currentSessionSchedulingAvailable,
    workspaceGenerationAvailable: true,
    rateLimit: opts.rateLimit === true,
    reloadAvailable: true,
    channelReloadAvailable: opts.channelSelection !== undefined,
    channelControlAvailable: true,
    channelManagementAvailable: true,
    persistentWorkspaceRegistrationAvailable: true,
    workspaceRuntimeRemovalAvailable: true,
    // Advertise the same WS feature flags as the runtime path (serve-features.ts)
    // so the bootstrap `/capabilities` window doesn't briefly under-report them.
    clientMcpOverWsEnabled: opts.clientMcpOverWs === true,
    cdpTunnelOverWsEnabled: opts.cdpTunnelOverWs === true,
    browserAutomationMcpAvailable: isBrowserAutomationMcpAvailable(opts, env),
  });
}

function createBootstrapCapabilities(input: {
  opts: ServeOptions;
  boundWorkspace: string;
  qwenCodeVersion?: string;
  sessionShellCommandEnabled: boolean;
  sessionArtifactsPersistenceAvailable: boolean;
  currentSessionSchedulingAvailable: boolean;
  permissionPolicy: PermissionPolicy | undefined;
  env: Readonly<Record<string, string | undefined>>;
}): CapabilitiesEnvelope {
  return {
    v: CAPABILITIES_SCHEMA_VERSION,
    protocolVersions: getServeProtocolVersions(),
    ...(input.qwenCodeVersion
      ? { qwenCodeVersion: input.qwenCodeVersion }
      : {}),
    mode: input.opts.mode,
    features: currentServeFeaturesForRunQwenServe(
      input.opts,
      input.sessionShellCommandEnabled,
      input.sessionArtifactsPersistenceAvailable,
      input.currentSessionSchedulingAvailable,
      input.env,
    ),
    modelServices: [],
    workspaceCwd: input.boundWorkspace,
    transports: ['rest'],
    policy: { permission: input.permissionPolicy ?? 'first-responder' },
    limits: {
      maxPendingPromptsPerSession: advertisedMaxPendingPromptsPerSession(
        input.opts.maxPendingPromptsPerSession,
      ),
      sessionRestoreTimeoutMs: resolveSessionRestoreTimeoutMs(input.opts),
    },
  };
}

function validateRateLimitOptions(opts: ServeOptions): void {
  if (opts.rateLimit !== true) return;
  for (const [name, value] of [
    ['rateLimitPrompt', opts.rateLimitPrompt],
    ['rateLimitMutation', opts.rateLimitMutation],
    ['rateLimitRead', opts.rateLimitRead],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0)
    ) {
      throw new TypeError(
        `Invalid ${name}: ${value}. Must be a positive integer.`,
      );
    }
  }
  if (
    opts.rateLimitWindowMs !== undefined &&
    (!Number.isFinite(opts.rateLimitWindowMs) ||
      !Number.isInteger(opts.rateLimitWindowMs) ||
      opts.rateLimitWindowMs < 1000)
  ) {
    throw new TypeError(
      `Invalid rateLimitWindowMs: ${opts.rateLimitWindowMs}. Must be an integer >= 1000.`,
    );
  }
}

function installSameOriginOriginStrip(
  app: Application,
  getPort: () => number,
): void {
  let cachedStripPort = -1;
  let cachedSelfOrigins: Set<string> = new Set();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin) {
      const port = getPort();
      if (port !== cachedStripPort) {
        cachedStripPort = port;
        // Both schemes: under `--tls-cert/--tls-key` the loopback web
        // shell is served over https, so its same-origin requests carry
        // an `https://` Origin. Loopback hosts are trusted as same-origin
        // regardless of scheme, so listing both is safe even on plain HTTP
        // (the https entries simply never match without TLS).
        cachedSelfOrigins = new Set([
          `http://127.0.0.1:${port}`,
          `http://localhost:${port}`,
          `http://[::1]:${port}`,
          `http://host.docker.internal:${port}`,
          `https://127.0.0.1:${port}`,
          `https://localhost:${port}`,
          `https://[::1]:${port}`,
          `https://host.docker.internal:${port}`,
        ]);
        // RFC 7230 §5.4: browsers omit the port in the Origin header when
        // it matches the scheme default (http→80, https→443). Accept the
        // port-less forms so the origin check doesn't fail on port 443.
        if (port === 80 || port === 443) {
          for (const host of [
            '127.0.0.1',
            'localhost',
            '[::1]',
            'host.docker.internal',
          ]) {
            cachedSelfOrigins.add(`http://${host}`);
            cachedSelfOrigins.add(`https://${host}`);
          }
        }
      }
      if (cachedSelfOrigins.has(origin)) {
        delete req.headers.origin;
      }
    }
    next();
  });
}

export function createLazyBridgeProxy(
  getBridge: () => AcpSessionBridge | undefined,
  getStartupError: () => string | undefined = () => undefined,
): AcpSessionBridge {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        const bridge = getBridge();
        if (!bridge) {
          const startupError = getStartupError();
          if (startupError) {
            throw new Error(
              `Daemon bridge runtime is not available: ${startupError}`,
            );
          }
          throw new Error('Daemon bridge runtime is still starting.');
        }
        const value = Reflect.get(bridge, prop, bridge) as unknown;
        return typeof value === 'function' ? value.bind(bridge) : value;
      },
    },
  ) as AcpSessionBridge;
}

export function resolveRuntimeStartupTimeoutMs(
  override: number | undefined,
): number {
  if (override !== undefined) {
    return Number.isFinite(override) && override > 0 ? override : 0;
  }
  const raw = process.env[RUNTIME_STARTUP_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_RUNTIME_STARTUP_TIMEOUT_MS;
  }
  const trimmed = raw.trim();
  if (trimmed === '0') return 0;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RUNTIME_STARTUP_TIMEOUT_MS;
}

export async function waitForRuntimeStartingForShutdown(
  runtimeStarting: Promise<void> | undefined,
  daemonLog: Pick<DaemonLogger, 'warn'>,
  timeoutMs = SHUTDOWN_FORCE_CLOSE_MS,
): Promise<void> {
  if (!runtimeStarting) return;

  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    runtimeStarting,
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        daemonLog.warn(
          `${timeoutMs}ms runtime-startup wait reached during shutdown; continuing listener close`,
        );
        resolve();
      }, timeoutMs);
      timer.unref();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const BOOTSTRAP_HEALTH_PATH = '/health';
const BOOTSTRAP_CAPABILITIES_PATH = '/capabilities';
const BOOTSTRAP_DAEMON_STATUS_PATH = '/daemon/status';
const BOOTSTRAP_SERVE_PATHS = new Set([
  BOOTSTRAP_HEALTH_PATH,
  BOOTSTRAP_CAPABILITIES_PATH,
  BOOTSTRAP_DAEMON_STATUS_PATH,
]);

const RUNTIME_STARTUP_FAILED_ENVELOPE = {
  error: 'Daemon runtime failed to start',
  code: 'daemon_runtime_failed',
} as const;
const RUNTIME_STARTUP_STARTING_ENVELOPE = {
  error: 'Daemon runtime is still starting',
  code: 'daemon_runtime_starting',
} as const;

function runtimeStartupEnvelope(runtimeError: string | undefined) {
  return runtimeError
    ? RUNTIME_STARTUP_FAILED_ENVELOPE
    : RUNTIME_STARTUP_STARTING_ENVELOPE;
}

function createBootstrapServeApp(input: {
  opts: ServeOptions;
  getPort: () => number;
  boundWorkspace: string;
  startup: DaemonStartupSnapshot;
  daemonLog: DaemonLogger;
  qwenCodeVersion?: string;
  sessionShellCommandEnabled: boolean;
  sessionArtifactsPersistenceAvailable: boolean;
  currentSessionSchedulingAvailable: boolean;
  permissionPolicy: PermissionPolicy | undefined;
  multiWorkspaceCapabilitiesRequireRuntime: boolean;
  getRuntimeError: () => string | undefined;
  getChannelWorkerSnapshot: () => ReturnType<
    ChannelWorkerSupervisor['snapshot']
  >;
  getChannelWorkerSnapshots: () => ChannelWorkerGroupSnapshot[];
  onHealthServed?: () => void;
}): Application {
  const {
    opts,
    getPort,
    boundWorkspace,
    startup,
    daemonLog,
    qwenCodeVersion,
    sessionShellCommandEnabled,
    sessionArtifactsPersistenceAvailable,
    currentSessionSchedulingAvailable,
    permissionPolicy,
    multiWorkspaceCapabilitiesRequireRuntime,
    getRuntimeError,
    getChannelWorkerSnapshot,
    getChannelWorkerSnapshots,
    onHealthServed,
  } = input;
  const app = express();

  installSameOriginOriginStrip(app, getPort);
  if (opts.allowOrigins && opts.allowOrigins.length > 0) {
    app.use(allowOriginCors(parseAllowOriginPatterns(opts.allowOrigins)));
  } else {
    app.use(denyBrowserOriginCors);
  }
  app.use(hostAllowlist(opts.hostname, getPort));

  const healthHandler = (req: Request, res: Response): void => {
    const runtimeError = getRuntimeError();
    if (runtimeError !== undefined) {
      res.status(503).json({
        status: 'degraded',
        error: runtimeError,
      });
      return;
    }

    if (onHealthServed) {
      res.once('finish', onHealthServed);
    }
    if (isDeepHealthQuery(req.query['deep'])) {
      res.setHeader('Retry-After', '1');
      res.status(503).json({ status: 'degraded', reason: 'bootstrap' });
      return;
    }
    res.status(200).json({ status: 'ok' });
  };
  const loopback = isLoopbackBind(opts.hostname);
  const exposeHealthPreAuth = loopback && !opts.requireAuth;
  if (exposeHealthPreAuth) {
    app.get(BOOTSTRAP_HEALTH_PATH, healthHandler);
  }

  app.use(bearerAuth(opts.token));

  if (!exposeHealthPreAuth) {
    app.get(BOOTSTRAP_HEALTH_PATH, healthHandler);
  }

  app.get(BOOTSTRAP_CAPABILITIES_PATH, (_req: Request, res: Response): void => {
    if (multiWorkspaceCapabilitiesRequireRuntime) {
      const runtimeError = getRuntimeError();
      if (runtimeError === undefined) {
        res.setHeader('Retry-After', '1');
      }
      res.status(503).json(runtimeStartupEnvelope(runtimeError));
      return;
    }
    res.status(200).json(
      createBootstrapCapabilities({
        opts,
        boundWorkspace,
        qwenCodeVersion,
        sessionShellCommandEnabled,
        sessionArtifactsPersistenceAvailable,
        currentSessionSchedulingAvailable,
        permissionPolicy,
        env: process.env,
      }),
    );
  });

  app.get(BOOTSTRAP_DAEMON_STATUS_PATH, (req: Request, res: Response): void => {
    const detail = parseDaemonStatusDetail(req.query['detail']);
    if (!detail.ok || !detail.detail) {
      res.status(400).json({
        error: 'detail must be one of: summary, full',
        code: 'invalid_detail',
      });
      return;
    }
    const runtimeError = getRuntimeError();
    // Same gate the runtime applies (see runQwenServeImpl): pinned journal
    // flags or a budget with no usable pool disable growth, so the
    // bootstrap response matches what the runtime will wire.
    const bootstrapJournalGrowthPoolMb =
      opts.daemonMemoryBudget !== undefined
        ? serveJournalGrowthPoolMb({
            budget: opts.daemonMemoryBudget,
            maxJournalEvents: opts.maxJournalEvents,
            maxJournalBytes: opts.maxJournalBytes,
          })
        : 0;
    const channelWorker = getChannelWorkerSnapshot();
    const channelWorkers = getChannelWorkerSnapshots();
    const runtimeFailed = runtimeError !== undefined;
    const issue: DaemonStatusIssue = runtimeError
      ? {
          code: 'daemon_runtime_failed',
          severity: 'error',
          message: runtimeError,
        }
      : {
          code: 'daemon_runtime_starting',
          severity: 'warning',
          message: 'Daemon runtime is still starting.',
        };
    const daemonLogStatus = daemonLog.getStatus();
    const issues: DaemonStatusIssue[] = [issue];
    if (daemonLogStatus.health === 'degraded') {
      issues.push({
        code: 'daemon_log_degraded',
        severity: 'warning',
        message:
          'Daemon file logging is degraded; inspect full status for details.',
      });
    }
    const response: DaemonStatusResponse = {
      v: 1,
      detail: detail.detail,
      generatedAt: new Date().toISOString(),
      status: runtimeFailed ? 'error' : 'warning',
      issues,
      daemon: {
        pid: process.pid,
        uptimeMs: Math.round(process.uptime() * 1000),
        mode: opts.mode,
        workspaceCwd: boundWorkspace,
        startup: {
          ...startup,
          preheat: { ...startup.preheat },
        },
        ...(qwenCodeVersion ? { qwenCodeVersion } : {}),
        ...(daemonLog.getDaemonId()
          ? { daemonId: daemonLog.getDaemonId() }
          : {}),
        runId: daemonLogStatus.runId,
        logMode: daemonLogStatus.mode,
        logHealth: daemonLogStatus.health,
        ...(detail.detail === 'full' && daemonLog.getLogPath()
          ? { logPath: daemonLog.getLogPath() }
          : {}),
        ...(detail.detail === 'full'
          ? {
              logIssues: daemonLogStatus.issues,
              logDroppedRecords: daemonLogStatus.droppedRecords,
              logDroppedBytes: daemonLogStatus.droppedBytes,
            }
          : {}),
      },
      security: {
        tokenConfigured: Boolean(opts.token),
        requireAuth: opts.requireAuth === true,
        loopbackBind: loopback,
        allowOriginConfigured:
          opts.allowOrigins !== undefined && opts.allowOrigins.length > 0,
        allowOriginMode: allowOriginMode(opts.allowOrigins),
        sessionShellCommandEnabled,
      },
      limits: {
        maxSessions: advertisedMaxSessions(opts.maxSessions),
        maxTotalSessions: positiveFiniteOrNull(opts.maxTotalSessions),
        maxPendingPromptsPerSession: advertisedMaxPendingPromptsPerSession(
          opts.maxPendingPromptsPerSession,
        ),
        listenerMaxConnections: listenerMaxConnections(opts.maxConnections),
        eventRingSize: opts.eventRingSize ?? DEFAULT_EVENT_RING_SIZE,
        compactedReplayMaxBytes:
          opts.compactedReplayMaxBytes ?? DEFAULT_COMPACTED_REPLAY_MAX_BYTES,
        maxJournalEvents: opts.maxJournalEvents ?? DEFAULT_MAX_JOURNAL_EVENTS,
        maxJournalBytes: opts.maxJournalBytes ?? DEFAULT_MAX_JOURNAL_BYTES,
        promptDeadlineMs: positiveFiniteOrNull(opts.promptDeadlineMs),
        writerIdleTimeoutMs: positiveFiniteOrNull(opts.writerIdleTimeoutMs),
        channelIdleTimeoutMs: channelIdleTimeoutMs(opts.channelIdleTimeoutMs),
        sessionIdleTimeoutMs: sessionIdleTimeoutMs(opts.sessionIdleTimeoutMs),
        acpConnectionCap: null,
        acpPreAttachMaxFramesPerStream: null,
        acpPreAttachMaxFramesPerConnection: null,
        acpPreAttachMaxFramesGlobal: null,
        acpPreAttachMaxPayloadBytesPerConnection: null,
        acpPreAttachMaxPayloadBytesGlobal: null,
        // No child-heap policy during bootstrap: it is built with the
        // runtime, so `enforced` is correctly false and `childHeap` null in
        // this window even when the flag says `enforce`.
        memory: toDaemonStatusMemoryLimits(
          opts.daemonMemoryBudget,
          undefined,
          bootstrapJournalGrowthPoolMb > 0
            ? {
                poolBytes: bootstrapJournalGrowthPoolMb * 1024 * 1024,
                hardCapBytes: JOURNAL_GROWTH_HARD_CAP_BYTES,
                baselineMaxEvents:
                  opts.maxJournalEvents ?? DEFAULT_MAX_JOURNAL_EVENTS,
                baselineMaxBytes:
                  opts.maxJournalBytes ?? DEFAULT_MAX_JOURNAL_BYTES,
              }
            : null,
        ),
      },
      capabilities: {
        protocolVersions: getServeProtocolVersions(),
        features: currentServeFeaturesForRunQwenServe(
          opts,
          sessionShellCommandEnabled,
          sessionArtifactsPersistenceAvailable,
          currentSessionSchedulingAvailable,
          process.env,
        ),
      },
      runtime: {
        loading: runtimeError === undefined,
        ...(runtimeError ? { error: runtimeError } : {}),
        sessions: { active: 0 },
        permissions: {
          pending: 0,
          policy: permissionPolicy ?? 'first-responder',
        },
        channel: { live: false },
        channelWorker,
        ...(channelWorkers.length > 0 ? { channelWorkers } : {}),
        transport: {
          restSseActive: 0,
          acp: {
            enabled: false,
            connections: 0,
            connectionStreams: 0,
            sessionStreams: 0,
            sseStreams: 0,
            wsStreams: 0,
            pendingClientRequests: 0,
            preAttach: {
              bufferedConnectionFrames: 0,
              bufferedSessionFrames: 0,
              pendingDeliveryFrames: 0,
              usedFrames: 0,
              usedBytes: 0,
              highWaterFrames: 0,
              highWaterBytes: 0,
              guardFailures: 0,
            },
          },
        },
        rateLimit: {
          enabled: opts.rateLimit === true,
          rejectedSinceStart: {
            prompt: 0,
            mutation: 0,
            read: 0,
          },
        },
        activity: {
          activePrompts: 0,
          pendingPrompts: 0,
          queuedPrompts: 0,
          lastActivityAt: null,
          idleSinceMs: null,
        },
        process: process.memoryUsage(),
      },
      ...(detail.detail === 'full'
        ? {
            full: {
              sessions: [],
              acpMounts: [],
              acpConnections: [],
              workspace: {},
              auth: {
                supportedDeviceFlowProviders: [],
                pendingDeviceFlowCount: 0,
              },
            },
          }
        : {}),
    };

    res.status(200).json(response);
  });

  app.use((_req: Request, res: Response): void => {
    res.status(503).json(runtimeStartupEnvelope(getRuntimeError()));
  });

  return app;
}

function createDelegatingServeApp(
  bootstrapApp: Application,
  getRuntimeApp: () => Application | undefined,
  options: {
    waitForDeferredRuntimeRoutes?: boolean;
    startRuntime?: () => boolean;
    runtimeReady?: Promise<void>;
    authenticateDeferredRuntimeRequest?: RequestHandler;
    authenticateDeferredChannelWebhookRequest?: RequestHandler;
    isPreAuthRequest?: (req: Request) => boolean | Promise<boolean>;
  } = {},
): Application {
  const app = express();
  app.use((req: Request, res: Response, next: NextFunction) => {
    const dispatch = async (): Promise<void> => {
      let target = getRuntimeApp();
      if (
        !target &&
        options.waitForDeferredRuntimeRoutes === true &&
        !isBootstrapServeRoute(req) &&
        !isCorsPreflightRequest(req) &&
        options.startRuntime &&
        options.runtimeReady
      ) {
        const waitStartedAt = performance.now();
        const timing: DeferredRuntimeRequestTiming = {
          startedAt: new Date(),
          path: 'joined',
        };
        const webhookRequest = isChannelWebhookRequest(req);
        const authGate = webhookRequest
          ? (options.authenticateDeferredChannelWebhookRequest ??
            options.authenticateDeferredRuntimeRequest)
          : options.authenticateDeferredRuntimeRequest;
        // A rejecting predicate must not 500 every deferred request —
        // fail closed to the bearer gate instead.
        const preAuthExempted =
          authGate !== undefined &&
          (await Promise.resolve(options.isPreAuthRequest?.(req)).catch(
            () => false,
          )) === true;
        if (authGate && !preAuthExempted) {
          if (!runSynchronousRequestGate(authGate, req, res, next)) {
            return;
          }
        }
        setDeferredRuntimeRequestTiming(req, timing);
        if (options.startRuntime()) {
          timing.path = 'started_on_request';
        }
        try {
          await options.runtimeReady;
        } catch {
          if (preAuthExempted) {
            // The bootstrap app serves the failure envelope only behind its
            // bearer gate, which a pre-auth navigation cannot pass — answer
            // here so the browser sees the startup failure, not a 401.
            res.status(503).json(RUNTIME_STARTUP_FAILED_ENVELOPE);
            return;
          }
          // Fall through to the bootstrap app so it can report the startup error.
        } finally {
          timing.waitMs =
            Math.round((performance.now() - waitStartedAt) * 100) / 100;
        }
        target = getRuntimeApp();
      }
      const handler = (target ?? bootstrapApp) as unknown as (
        req: Request,
        res: Response,
        next: NextFunction,
      ) => void;
      handler(req, res, next);
    };
    void dispatch().catch(next);
  });
  return app;
}

function isBootstrapServeRoute(req: Request): boolean {
  const path =
    req.path.length > 1 && req.path.endsWith('/')
      ? req.path.slice(0, -1)
      : req.path;
  return BOOTSTRAP_SERVE_PATHS.has(path);
}

function isChannelWebhookRequest(req: Request): boolean {
  return (
    req.method === 'POST' &&
    /^\/channels\/[^/]+\/webhooks\/[^/]+\/?$/u.test(req.path)
  );
}

function createDeferredChannelWebhookAuth(
  resolveSource: (channelName: string) => ChannelWebhookConfigSource,
  runtime: ChannelWebhookConfigRuntime,
  daemonLog: Pick<DaemonLogger, 'warn'>,
): RequestHandler {
  return (req, res, next) => {
    const match = /^\/channels\/([^/]+)\/webhooks\/([^/]+)\/?$/u.exec(req.path);
    const channelName = decodeDeferredWebhookPathSegment(match?.[1]);
    const source = decodeDeferredWebhookPathSegment(match?.[2]);
    if (!channelName || !source) {
      daemonLog.warn('deferred webhook auth failed', {
        channelName: channelName ?? 'unknown',
        source: source ?? 'unknown',
        reason: 'invalid webhook path',
      });
      res.status(401).json({ error: 'Invalid webhook secret' });
      return;
    }

    const configSource = resolveSource(channelName);
    const secret = readDeferredWebhookSecret(
      runtime,
      configSource.workspaceCwd,
      channelName,
      source,
      configSource.env,
    );
    if (!matchesWebhookSecret(req.get('x-qwen-webhook-secret'), secret)) {
      daemonLog.warn('deferred webhook auth failed', {
        channelName,
        source,
        reason: secret ? 'secret mismatch' : 'source not configured',
      });
      res.status(401).json({ error: 'Invalid webhook secret' });
      return;
    }

    next();
  };
}

function decodeDeferredWebhookPathSegment(
  segment: string | undefined,
): string | undefined {
  if (segment === undefined) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function readDeferredWebhookSecret(
  runtime: ChannelWebhookConfigRuntime,
  workspace: string,
  channelName: string,
  source: string,
  env?: Readonly<Record<string, string | undefined>>,
): string | undefined {
  try {
    const rawConfig = runtime.loadChannelsConfig(workspace)[channelName];
    if (typeof rawConfig !== 'object' || rawConfig === null) {
      return undefined;
    }
    return runtime.parseChannelWebhookConfig(
      channelName,
      rawConfig as Record<string, unknown>,
      env,
    )?.sources[source]?.secret;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    writeStderrLine(
      `[webhook-secret] failed to read deferred webhook secret for ${sanitizeLogText(channelName, 128)}/${sanitizeLogText(source, 128)}: ${sanitizeLogText(reason, 512)}`,
    );
    return undefined;
  }
}

function matchesWebhookSecret(
  candidate: string | undefined,
  expected: string | undefined,
): boolean {
  if (
    typeof candidate !== 'string' ||
    typeof expected !== 'string' ||
    expected.length === 0
  ) {
    return false;
  }

  const expectedDigest = createHash('sha256').update(expected).digest();
  const candidateDigest = createHash('sha256').update(candidate).digest();
  return timingSafeEqual(expectedDigest, candidateDigest);
}

function isCorsPreflightRequest(req: Request): boolean {
  return (
    req.method === 'OPTIONS' &&
    Boolean(req.headers.origin) &&
    Boolean(
      req.headers['access-control-request-method'] ||
        req.headers['access-control-request-headers'],
    )
  );
}

function runSynchronousRequestGate(
  handler: RequestHandler,
  req: Request,
  res: Response,
  next: NextFunction,
): boolean {
  let passed = false;
  handler(req, res, (err?: unknown) => {
    if (err) {
      next(err);
      return;
    }
    passed = true;
  });
  return passed;
}

/**
 * Validate options + start the listener. Resolves once the server is ready
 * to accept connections.
 *
 * Token resolution order:
 *   1. explicit `opts.token`
 *   2. `QWEN_SERVER_TOKEN` env var
 *
 * Boot refuses to start when bound beyond loopback without a token; this is a
 * hard rule, not a warning, per the threat model in the design issue.
 */
interface DaemonLoggerLifecycleCallbacks {
  initialized(logger: DaemonLogger): void;
  published(): void;
  signalOwned(): void;
  // Called once the startup scrub has mutated the host process.env, with
  // the restore close() would run. runQwenServe's catch invokes it when
  // startup fails after the scrub — the close() path is unreachable then,
  // and an embedded caller must not keep a permanently scrubbed env.
  scrubApplied(restoreScrubbedLoaderEnv: () => void): void;
  // Called with the loader-key rejection reporter this run installed, so the
  // startup-failure catch can clear it only when it is still the active one —
  // a co-resident daemon that installed after us must keep its own reporter.
  reporterInstalled(reporter: LoaderKeyRejectionReporter): void;
}

/**
 * Validates and canonicalizes a `--workspace` boot argument. Extracted to
 * module scope (from the runQwenServe closure) so the #7139 sandbox path
 * translation ahead of the absolute-path guard is testable — this is the
 * primary reproduction path of that issue.
 */
export function validateAndCanonicalizeWorkspaceInput(
  rawWorkspace: string,
): string {
  // #7139: inside a Linux container sandbox a Windows host forwards
  // `--workspace C:\…` in host shape; translate to the bind-mount
  // location BEFORE the absolute-path guard, which would otherwise
  // reject it (`path.isAbsolute('C:\…')` is false on POSIX).
  const workspace = translateAndCheckAbsoluteWorkspacePath(rawWorkspace);
  if (workspace === null) {
    throw new Error(
      `Invalid --workspace "${rawWorkspace}": must be an absolute path.`,
    );
  }
  try {
    const stats = fs.statSync(workspace);
    if (!stats.isDirectory()) {
      throw new Error(
        `Invalid --workspace "${workspace}": exists but is not a directory.`,
      );
    }
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err) {
      const code = (err as { code?: unknown }).code;
      if (code === 'ENOENT') {
        throw new Error(
          `Invalid --workspace "${workspace}": directory does not exist.`,
        );
      }
      // EACCES / EPERM: the path exists but the current user can't
      // stat it (typical for SIP-protected paths on macOS, root-owned
      // dirs the daemon's user can't traverse, etc.). The raw Node
      // SystemError has the path AND the syscall but no operator-
      // facing breadcrumb that this came from `--workspace`. Wrap
      // both codes so the boot failure points at the flag the
      // operator actually set.
      if (code === 'EACCES' || code === 'EPERM') {
        throw new Error(
          `Invalid --workspace "${workspace}": permission denied ` +
            `(${String(code)}). The path exists but cannot be stat'd ` +
            `by the current user.`,
        );
      }
    }
    throw err;
  }
  return canonicalizeWorkspace(workspace);
}

export async function runQwenServe(
  optsIn: RunQwenServeOptions,
  deps: RunQwenServeDeps = {},
): Promise<RunHandle> {
  let daemonLog: DaemonLogger | undefined;
  let owner: 'startup' | 'handle' | 'signal' = 'startup';
  let restoreScrubbedLoaderEnv: (() => void) | undefined;
  let installedLoaderRejectionReporter: LoaderKeyRejectionReporter | undefined;
  try {
    return await runQwenServeImpl(optsIn, deps, {
      initialized: (logger) => {
        daemonLog = logger;
      },
      published: () => {
        if (owner === 'startup') owner = 'handle';
      },
      signalOwned: () => {
        if (owner === 'startup') owner = 'signal';
      },
      scrubApplied: (restore) => {
        restoreScrubbedLoaderEnv = restore;
      },
      reporterInstalled: (reporter) => {
        installedLoaderRejectionReporter = reporter;
      },
    });
  } catch (error) {
    // Startup failed after the scrub and (when the logger was up) the
    // reporter install; the close() path that reverts both is unreachable.
    // Clear only our own reporter so a co-resident daemon keeps its own.
    if (installedLoaderRejectionReporter) {
      clearLoaderKeyRejectionReporterIfCurrent(
        installedLoaderRejectionReporter,
      );
    }
    if (daemonLog && owner === 'startup') {
      const startupLog = daemonLog;
      writeDaemonLifecycleBestEffort(() =>
        startupLog.error(
          'daemon startup failed',
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
      await startupLog.close();
    }
    restoreScrubbedLoaderEnv?.();
    throw error;
  }
}

async function runQwenServeImpl(
  optsIn: RunQwenServeOptions,
  deps: RunQwenServeDeps,
  loggerLifecycle: DaemonLoggerLifecycleCallbacks,
): Promise<RunHandle> {
  const runStartedAt = performance.now();
  // Embedded callers pass the credential through `optsIn`. Remove any ambient
  // copy before freezing runtime environments or starting auxiliary workers.
  delete process.env[EXTERNAL_TOOL_GUARD_TOKEN_ENV];
  const channelDeliveryAuthorizations = new ChannelDeliveryAuthorizationStore();
  const shouldPreheat = !deps.bridge && shouldPreheatBridge(deps);
  const startup: DaemonStartupSnapshot = {
    processStartedAt: new Date(
      Date.now() - Math.round(process.uptime() * 1000),
    ).toISOString(),
    preheat: {
      status: deps.bridge
        ? 'external_bridge'
        : shouldPreheat
          ? 'scheduled'
          : 'not_scheduled',
    },
  };
  // Validate before freezing the value into the immutable daemon base env so a
  // bad scope can never be baked into a runtime, even transiently.
  if (
    optsIn.memoryProjectScope !== undefined &&
    !(MEMORY_PROJECT_SCOPES as readonly string[]).includes(
      optsIn.memoryProjectScope,
    )
  ) {
    throw new TypeError(
      `Invalid memoryProjectScope: ${String(optsIn.memoryProjectScope)}. ` +
        'Must be "git-root" or "workspace".',
    );
  }
  preResolveServeFastPathHomeEnvOverrides();
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  const launchMemoryProjectScopeValue =
    baseEnv['QWEN_CODE_MEMORY_PROJECT_SCOPE'];
  const launchMemoryProjectScope = launchMemoryProjectScopeValue?.trim()
    ? launchMemoryProjectScopeValue
    : undefined;
  const memoryProjectScopeValue =
    optsIn.memoryProjectScope ?? launchMemoryProjectScope ?? 'workspace';
  const memoryProjectScopeSource =
    optsIn.memoryProjectScope !== undefined
      ? 'option'
      : launchMemoryProjectScope !== undefined
        ? 'environment'
        : 'default';
  const resolvedMemoryProjectScope =
    memoryProjectScopeValue.trim().toLowerCase() === 'workspace'
      ? 'workspace'
      : 'git-root';
  baseEnv['QWEN_CODE_MEMORY_PROJECT_SCOPE'] = memoryProjectScopeValue;
  // The dev harness (scripts/dev.js) stamps DEV=true into the same env that
  // carries the tsx loader's NODE_OPTIONS, so only then does the base env
  // keep loader vars — dev-mode ACP children and channel workers need the
  // loader to boot their .ts entries. DEV is hardcoded-excluded from
  // project .env/settings.env (shared-env-keys.ts), so this consults the
  // launch environment only. Every other launch scrubs them here, before
  // the freeze: the base env is what session-hosting children (the ACP
  // child, channel daemon workers) spawn with, and a loader var that
  // reaches them runs during Node bootstrap — before the child's own
  // post-boot scrub could ever remove it.
  if (process.env['DEV'] !== 'true') {
    scrubInheritedLoaderEnv(baseEnv);
  }
  const daemonRuntimeBaseEnv: Readonly<NodeJS.ProcessEnv> =
    Object.freeze(baseEnv);
  // The daemon process itself is done with loader vars either way:
  // session-shell subprocesses run here with process.env while their cwd is
  // another workspace. The scrub is reference-counted (see
  // acquireInheritedLoaderEnvScrub) so overlapping embedded daemons in one
  // process do not restore each other's loader vars mid-flight, and reverted
  // on close() so an embedded caller reusing the host process gets its launch
  // environment back.
  const loaderEnvScrub = acquireInheritedLoaderEnvScrub(
    process.env,
    'qwen serve',
    'daemon',
  );
  const scrubbedLoaderEnvKeys = loaderEnvScrub.removedKeys;
  const restoreScrubbedLoaderEnv = (): void => {
    loaderEnvScrub.release();
  };
  loggerLifecycle.scrubApplied(restoreScrubbedLoaderEnv);

  const token = resolveServeToken(optsIn.token);
  const channelDeliveryDiagnosticRedaction: WorkerDiagnosticRedactionOptions = {
    workerEnv: daemonRuntimeBaseEnv,
    ...(token ? { daemonToken: token } : {}),
  };
  const sessionShellCommandEnabled =
    optsIn.enableSessionShell === true && token !== undefined;
  if (optsIn.enableSessionShell === true && token === undefined) {
    writeStderrLine(
      `qwen serve: --enable-session-shell ignored because no bearer token ` +
        `is configured. Set ${QWEN_SERVER_TOKEN_ENV} or pass --token to ` +
        `enable direct session shell.`,
    );
  }
  // Env-var fallback for the deadline options. Explicit option
  // beats the env beats unset (= unlimited). `parseDeadlineEnv` throws
  // on malformed values so an `export QWEN_SERVE_PROMPT_DEADLINE_MS=abc`
  // typo fails boot loudly instead of silently disabling the cap.
  const promptDeadlineMs =
    optsIn.promptDeadlineMs ??
    parseDeadlineEnv(
      QWEN_SERVE_PROMPT_DEADLINE_MS_ENV,
      process.env[QWEN_SERVE_PROMPT_DEADLINE_MS_ENV],
    );
  const writerIdleTimeoutMs =
    optsIn.writerIdleTimeoutMs ??
    parseDeadlineEnv(
      QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS_ENV,
      process.env[QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS_ENV],
    );
  const clientMcpOverWsEnv = process.env[QWEN_SERVE_CLIENT_MCP_OVER_WS_ENV];
  const cdpTunnelOverWsEnv = process.env[QWEN_SERVE_CDP_TUNNEL_OVER_WS_ENV];
  const chromeExtensionOriginAllowed = hasChromeExtensionOrigin(
    optsIn.allowOrigins,
  );
  const rawWorkspaces = resolveWorkspaceInputs(optsIn.workspace);
  const rawWorkspace = rawWorkspaces[0]!;
  // daemonMemoryBudget is assigned after construction, once the budget is
  // resolved below.
  const opts: ServeOptions = {
    ...optsIn,
    token,
    promptDeadlineMs,
    writerIdleTimeoutMs,
    workspace: rawWorkspace,
    clientMcpOverWs:
      optsIn.clientMcpOverWs ??
      (!envFlagDisabled(clientMcpOverWsEnv) &&
        clientMcpOverWsEnv !== undefined),
    cdpTunnelOverWs:
      optsIn.cdpTunnelOverWs ??
      (!envFlagDisabled(cdpTunnelOverWsEnv) &&
        (cdpTunnelOverWsEnv !== undefined || chromeExtensionOriginAllowed)),
  };
  let channelRuntime = opts.channelSelection
    ? await loadChannelWorkerRuntime()
    : undefined;
  let channelServicePidfile =
    deps.channelServicePidfile ?? channelRuntime?.channelServicePidfile;
  const ensureChannelRuntime = async (): Promise<ChannelWorkerRuntime> => {
    channelRuntime ??= await loadChannelWorkerRuntime();
    channelServicePidfile ??= channelRuntime.channelServicePidfile;
    return channelRuntime;
  };
  let channelPidfileReserved = false;
  const removeCurrentServePidfile = (): void => {
    if (!channelServicePidfile) return;
    if (!channelPidfileReserved) return;
    if (channelServicePidfile.removeServeServiceInfo) {
      if (channelServicePidfile.removeServeServiceInfo(process.pid)) {
        channelPidfileReserved = false;
      } else {
        const info = channelServicePidfile.readServiceInfo();
        if (
          !info ||
          info.owner !== 'serve' ||
          info.pid !== process.pid ||
          info.servePid !== process.pid
        ) {
          channelPidfileReserved = false;
        }
      }
      return;
    }
    const info = channelServicePidfile.readServiceInfo();
    if (
      info?.owner === 'serve' &&
      info.pid === process.pid &&
      info.servePid === process.pid
    ) {
      channelServicePidfile.removeServiceInfo();
      const remaining = channelServicePidfile.readServiceInfo();
      channelPidfileReserved =
        remaining?.owner === 'serve' &&
        remaining.pid === process.pid &&
        remaining.servePid === process.pid;
    } else {
      channelPidfileReserved = false;
    }
  };
  const reserveChannelServicePidfile = (
    selection: ServeChannelSelection,
  ): void => {
    if (!channelServicePidfile) {
      throw new Error('Channel service pidfile runtime is not available.');
    }
    const channelPidfileNames = channelSelectionNames(selection);
    const existingChannelService = channelServicePidfile.readServiceInfo();
    if (existingChannelService) {
      throw channelServicePidfileConflictError(existingChannelService);
    }
    try {
      writeServeChannelReservation(channelServicePidfile, channelPidfileNames);
      channelPidfileReserved = true;
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err) {
        const code = (err as { code?: unknown }).code;
        if (code === 'EEXIST') {
          const info = channelServicePidfile.readServiceInfo();
          if (info) {
            throw channelServicePidfileConflictError(info);
          }
          try {
            writeServeChannelReservation(
              channelServicePidfile,
              channelPidfileNames,
            );
            channelPidfileReserved = true;
            return;
          } catch (retryErr) {
            if (
              retryErr &&
              typeof retryErr === 'object' &&
              'code' in retryErr &&
              (retryErr as { code?: unknown }).code === 'EEXIST'
            ) {
              throw channelServiceStartingConflictError();
            }
            throw retryErr;
          }
        }
      }
      throw err;
    }
  };
  validateRateLimitOptions(opts);

  // Catch the `--hostname localhost:4170` / `127.0.0.1:4170`
  // typo BEFORE the loopback / token check so the operator sees a
  // useful "did you mean --port?" message instead of "Refusing to
  // bind localhost:4170:0 without a bearer token". Unbracketed input
  // with exactly one `:` is the unambiguous host:port shape — raw
  // IPv6 literals always have two-or-more `:` (the shortest is `::`),
  // and bracketed IPv6 is handled by its own form check below.
  if (!opts.hostname.startsWith('[') && opts.hostname.split(':').length === 2) {
    const [host, port] = opts.hostname.split(':');
    throw new Error(
      `Invalid --hostname "${opts.hostname}": looks like a "host:port" ` +
        `combination. Use --port for the port, e.g. ` +
        `"--hostname ${host} --port ${port}".`,
    );
  }

  // TLS is both-or-nothing: a cert without a key (or vice versa) can't
  // start an HTTPS listener, so fail loud at boot instead of silently
  // falling back to plain HTTP — the operator asked for TLS and a silent
  // downgrade would serve the web shell over an insecure transport they
  // believe is encrypted.
  let tlsOptions: { cert: Buffer; key: Buffer } | undefined;
  let tlsCertPath: string | undefined;
  if ((opts.tlsCert && !opts.tlsKey) || (!opts.tlsCert && opts.tlsKey)) {
    throw new Error(
      `--tls-cert and --tls-key must be provided together (got only ` +
        `--tls-${opts.tlsCert ? 'cert' : 'key'}).`,
    );
  }
  if (opts.tlsCert && opts.tlsKey) {
    let cert: Buffer;
    let key: Buffer;
    try {
      cert = fs.readFileSync(opts.tlsCert);
    } catch (err) {
      throw new Error(
        `Failed to read --tls-cert "${opts.tlsCert}": ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      key = fs.readFileSync(opts.tlsKey);
    } catch (err) {
      throw new Error(
        `Failed to read --tls-key "${opts.tlsKey}": ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Fail loud at boot on an expired (or unparseable) certificate. Node's
    // https.createServer happily starts with an expired cert, then every TLS
    // handshake is rejected client-side (NET::ERR_CERT_DATE_INVALID) while
    // /health stays green — a silent outage that's hard to diagnose. Surface
    // it here with an actionable message instead.
    let x509: X509Certificate;
    try {
      x509 = new X509Certificate(cert);
    } catch (err) {
      throw new Error(
        `--tls-cert "${opts.tlsCert}" is not a valid certificate: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const now = Date.now();
    if (new Date(x509.validTo).getTime() < now) {
      throw new Error(
        `--tls-cert "${opts.tlsCert}" expired on ${x509.validTo}. ` +
          `Renew the certificate and restart.`,
      );
    }
    // Symmetric to the expiry guard: a cert whose validity window hasn't
    // started yet (notBefore > now, e.g. clock skew or a freshly minted
    // cert) also boots cleanly but fails every handshake client-side with
    // NET::ERR_CERT_DATE_INVALID. Fail loud here too.
    if (new Date(x509.validFrom).getTime() > now) {
      throw new Error(
        `--tls-cert "${opts.tlsCert}" is not yet valid (validFrom: ` +
          `${x509.validFrom}). Check the certificate's notBefore date or ` +
          `the system clock.`,
      );
    }
    tlsOptions = { cert, key };
    // Workers are forked with `cwd: opts.workspace`, so a relative --tls-cert
    // would resolve against the worker's cwd instead of the daemon's and load
    // nothing. Resolve once here, against the cwd the daemon just read it with.
    tlsCertPath = path.resolve(opts.tlsCert);
  }

  if (!isLoopbackBind(opts.hostname) && !token) {
    throw new Error(
      `Refusing to bind ${opts.hostname}:${opts.port} without a bearer token. ` +
        `Set ${QWEN_SERVER_TOKEN_ENV} or pass --token, or rebind to loopback ` +
        `(127.0.0.1, localhost, ::1, or [::1]).`,
    );
  }
  // `--require-auth` extends the "must have a token" rule to loopback
  // as well. Boot-loud, like the non-loopback check
  // above: silently dropping the flag when no token is configured
  // would leave the operator believing the deployment is hardened
  // when it isn't. Mention both the env var and the flag so log
  // readers don't have to read the source to learn the fix.
  if (opts.requireAuth && !token) {
    throw new Error(
      `Refusing to start with --require-auth set but no bearer token ` +
        `configured. Set ${QWEN_SERVER_TOKEN_ENV} or pass --token, or omit ` +
        `--require-auth to keep the loopback developer default.`,
    );
  }

  // Validate `--allow-origin` patterns at boot so
  // operators discover typos before the daemon advertises
  // `allow_origin` to clients. Each entry must be either `*` or a value
  // that round-trips through `new URL(...).origin` — see
  // `parseAllowOriginPatterns` JSDoc for the strict-by-intent rationale.
  // The parsed `ParsedAllowOriginPatterns` is then re-derived in
  // `createServeApp` to avoid threading an extra option shape through;
  // re-parsing is O(n) over operator-listed patterns and only happens
  // once at boot.
  if (opts.allowOrigins && opts.allowOrigins.length > 0) {
    // `InvalidAllowOriginPatternError` already names the bad pattern
    // and the canonical form; surface it verbatim.
    const parsed = parseAllowOriginPatterns(opts.allowOrigins);
    // `*` admits cross-origin requests from any browser tab on the
    // host. On a token-less loopback default that's a wide-open API
    // surface — any page (https://evil.example.com, attacker-controlled
    // ad-frame) can read every route. Refuse to start so operators
    // don't ship this combination by accident. Mirrors the
    // `--require-auth + no token` boot-refusal above. A token (any
    // source: --token, env, --require-auth) makes the bearer the
    // security boundary, so `*` is acceptable under that posture.
    if (parsed.allowAny && !token) {
      throw new Error(
        `Refusing to start with --allow-origin '*' but no bearer token ` +
          `configured. '*' admits any cross-origin browser to the API; ` +
          `without a token, any local page can drive the daemon. Set ` +
          `${QWEN_SERVER_TOKEN_ENV} or pass --token, or list specific ` +
          `origins instead of '*'.`,
      );
    }
    writeStderrLine(
      `qwen serve: --allow-origin: ${opts.allowOrigins.join(', ')}` +
        (parsed.allowAny
          ? ' (WARNING: `*` admits any cross-origin browser — bearer ' +
            'token gates API routes; the Web Shell static assets stay ' +
            'pre-auth in every mode unless --no-web, and /health stays ' +
            'pre-auth on loopback unless --require-auth is set)'
          : ''),
    );
  }
  if (opts.allowPrivateAuthBaseUrl) {
    writeStderrLine(
      'qwen serve: --allow-private-auth-base-url enabled; ' +
        '/workspace/auth/provider may install localhost/private-network ' +
        'model endpoints. Use only for local development with trusted clients.',
    );
  }

  const validateAndCanonicalizeWorkspace =
    validateAndCanonicalizeWorkspaceInput;

  // Resolve the bound workspace list. The first explicit workspace remains the
  // primary workspace for legacy APIs; later workspaces are isolated secondary
  // runtimes.
  const liveConversationWorkspace =
    deps.liveConversationWorkspace ?? new ConversationWorkspace();
  const isReservedConversationWorkspace = (candidate: string): boolean => {
    const resolvedCandidate = path.resolve(candidate);
    const resolvedRoot = path.resolve(liveConversationWorkspace.rootPath);
    let canonicalRoot = resolvedRoot;
    try {
      canonicalRoot = fs.realpathSync.native(resolvedRoot);
    } catch {
      // The reserved root is intentionally not materialized during startup.
    }
    return (
      resolvedCandidate === resolvedRoot ||
      isWithinRoot(resolvedCandidate, resolvedRoot) ||
      resolvedCandidate === canonicalRoot ||
      isWithinRoot(resolvedCandidate, canonicalRoot)
    );
  };
  const reservedRawWorkspace = rawWorkspaces.find((workspace) =>
    isReservedConversationWorkspace(workspace),
  );
  if (reservedRawWorkspace) {
    throw new Error(
      `Workspace ${JSON.stringify(
        reservedRawWorkspace,
      )} is reserved for Conversations.`,
    );
  }
  const workspaceInputs = rawWorkspaces.map((workspace) => ({
    raw: workspace,
    cwd: validateAndCanonicalizeWorkspace(workspace),
    displayName: undefined as string | undefined,
    removable: false,
    registrationIds: [] as string[],
  }));
  const boundWorkspace = workspaceInputs[0]!.cwd;

  // Keep duplicate/nested rejection after realpath canonicalization so symlink
  // aliases cannot create two runtimes for one physical workspace.
  const seenCanonicalWorkspaces = new Set<string>();
  for (const workspace of workspaceInputs) {
    if (seenCanonicalWorkspaces.has(workspace.cwd)) {
      throw new Error(
        `Duplicate --workspace value resolves to ${JSON.stringify(
          workspace.cwd,
        )}.`,
      );
    }
    seenCanonicalWorkspaces.add(workspace.cwd);
  }
  for (let i = 0; i < workspaceInputs.length; i++) {
    for (let j = i + 1; j < workspaceInputs.length; j++) {
      const first = workspaceInputs[i]!.cwd;
      const second = workspaceInputs[j]!.cwd;
      const firstRel = path.relative(first, second);
      const secondRel = path.relative(second, first);
      if (
        firstRel &&
        !firstRel.startsWith('..') &&
        !path.isAbsolute(firstRel)
      ) {
        throw new Error(
          `Nested --workspace values are not supported: ` +
            `${JSON.stringify(second)} is inside ${JSON.stringify(first)}.`,
        );
      }
      if (
        secondRel &&
        !secondRel.startsWith('..') &&
        !path.isAbsolute(secondRel)
      ) {
        throw new Error(
          `Nested --workspace values are not supported: ` +
            `${JSON.stringify(first)} is inside ${JSON.stringify(second)}.`,
        );
      }
    }
  }
  if (workspaceInputs.length > MAX_REGISTERED_WORKSPACES) {
    throw new Error(
      `At most ${MAX_REGISTERED_WORKSPACES} --workspace values may be registered.`,
    );
  }
  // Resolve the daemon's memory figures once. Nothing downstream consumes
  // them to size a child: dividing a pool by a workspace count is unsound
  // while registration does not spawn a child, and bounding the aggregate
  // needs admission at spawn time keyed on live children. The one consumer
  // today is the adaptive live-journal growth pool below.
  opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
    budgetMb: opts.memoryBudgetMb,
  });
  if (
    opts.daemonMemoryBudget.budgetSource === 'flag' ||
    opts.daemonMemoryBudget.insufficientMemory
  ) {
    writeStderrLine(formatMemoryBudgetStderr(opts.daemonMemoryBudget));
  }
  // Adaptive live-journal growth: sessions whose in-flight turn outgrows
  // the journal caps can grow into a daemon-wide pool (derived once from
  // the memory budget and shared by every bridge), instead of silently
  // truncating the live replay window (the canonical case: one turn fanning
  // out many concurrent subagents). An operator-pinned journal flag
  // disables growth — explicit config wins — as does a budget with no
  // usable pool (insufficient host, no headroom after the root reserve).
  const journalGrowthPoolMbValue =
    opts.daemonMemoryBudget !== undefined
      ? serveJournalGrowthPoolMb({
          budget: opts.daemonMemoryBudget,
          maxJournalEvents: opts.maxJournalEvents,
          maxJournalBytes: opts.maxJournalBytes,
        })
      : 0;
  const journalGrowthPoolBytes =
    journalGrowthPoolMbValue > 0
      ? journalGrowthPoolMbValue * 1024 * 1024
      : undefined;
  // ONE aggregate pool for the whole daemon: every bridge registers its
  // live-session cap enumerator here and receives the aggregator, so each
  // bridge's growth advisor accounts every sharing session — across all
  // workspaces — against the same pool instead of holding its own copy.
  const journalGrowthSessionLimitProviders = new Set<
    () => readonly JournalGrowthSessionLimit[]
  >();
  const journalGrowthSessionLimits =
    (): readonly JournalGrowthSessionLimit[] => {
      const limits: JournalGrowthSessionLimit[] = [];
      for (const provider of journalGrowthSessionLimitProviders) {
        limits.push(...provider());
      }
      return limits;
    };
  const registerJournalGrowthSessionLimits = (
    provider: () => readonly JournalGrowthSessionLimit[],
  ): (() => void) => {
    journalGrowthSessionLimitProviders.add(provider);
    return () => {
      journalGrowthSessionLimitProviders.delete(provider);
    };
  };
  const reservedStartupWorkspace = workspaceInputs.find((workspace) =>
    isReservedConversationWorkspace(workspace.cwd),
  );
  if (reservedStartupWorkspace) {
    throw new Error(
      `Workspace ${JSON.stringify(
        reservedStartupWorkspace.raw,
      )} is reserved for Conversations.`,
    );
  }
  let workspaceRegistrationStore = deps.workspaceRegistrationStore;
  if (
    workspaceRegistrationStore === undefined &&
    process.env['QWEN_SERVE_NO_PERSISTENT_REGISTRATION'] !== '1'
  ) {
    const { WorkspaceRegistrationStore } = await import(
      './workspace-registration-store.js'
    );
    workspaceRegistrationStore = new WorkspaceRegistrationStore(boundWorkspace);
  }
  if (workspaceRegistrationStore) {
    try {
      const stored = await workspaceRegistrationStore.read();
      for (const storedWorkspace of stored.workspaces) {
        const registrationId = workspaceRegistrationId(storedWorkspace);
        const displayName = stored.displayNames?.[registrationId];
        if (isReservedConversationWorkspace(storedWorkspace)) {
          writeStderrLine(
            `qwen serve: skipping persisted workspace registration ${JSON.stringify(
              storedWorkspace,
            )}: path is reserved for Conversations`,
          );
          continue;
        }
        let cwd: string;
        try {
          cwd = validateAndCanonicalizeWorkspace(storedWorkspace);
        } catch (err) {
          writeStderrLine(
            `qwen serve: skipping persisted workspace registration ${JSON.stringify(
              storedWorkspace,
            )}: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        if (isReservedConversationWorkspace(cwd)) {
          writeStderrLine(
            `qwen serve: skipping persisted workspace registration ${JSON.stringify(
              storedWorkspace,
            )}: path is reserved for Conversations`,
          );
          continue;
        }
        const existingInput = workspaceInputs.find(
          (workspace) => workspace.cwd === cwd,
        );
        if (existingInput) {
          existingInput.registrationIds.push(registrationId);
          existingInput.displayName ??= displayName;
          continue;
        }
        const nested = workspaceInputs.some(
          (workspace) =>
            isWithinRoot(cwd, workspace.cwd) ||
            isWithinRoot(workspace.cwd, cwd),
        );
        if (nested) {
          writeStderrLine(
            `qwen serve: skipping persisted workspace registration ${JSON.stringify(
              storedWorkspace,
            )}: path nests with an explicit or earlier restored workspace`,
          );
          continue;
        }
        if (workspaceInputs.length >= MAX_REGISTERED_WORKSPACES) {
          writeStderrLine(
            `qwen serve: skipping persisted workspace registration ${JSON.stringify(
              storedWorkspace,
            )}: workspace limit reached`,
          );
          continue;
        }
        workspaceInputs.push({
          raw: storedWorkspace,
          cwd,
          displayName,
          removable: true,
          registrationIds: [registrationId],
        });
      }
    } catch (err) {
      writeStderrLine(
        `qwen serve: failed to read persisted workspace registrations: ${
          err instanceof Error ? err.message : String(err)
        }; continuing with explicit workspaces only`,
      );
    }
  }
  if (workspaceInputs.length > 1 && deps.bridge) {
    throw new Error(
      'Injected bridge dependencies are only supported with a single workspace; ' +
        'multiple --workspace values require runQwenServe to construct one bridge per workspace.',
    );
  }
  // Canonicalize ONCE here so `/capabilities` and the POST /session
  // fallback (both via server.ts) AND the bridge agree on the same
  // path. Without this, server.ts and the bridge each compute
  // `boundWorkspace` independently; on symlinks or case-insensitive
  // filesystems the bridge's `realpathSync.native` form diverges from
  // server.ts's raw `opts.workspace` and clients see one path on
  // `/capabilities` but another on `POST /session` responses.

  // Read a lightweight settings summary once at boot for startup-time fields
  // used before the full runtime settings loader is allowed onto the hot path.
  let contextFilenameForInit: string | undefined;
  let permissionPolicy: PermissionPolicy | undefined;
  let permissionConsensusQuorum: number | undefined;
  let bootSettings: ServeFastPathSettings | undefined;
  let sessionArtifactsPersistenceAvailable = true;
  try {
    bootSettings =
      deps.bootSettings ?? loadServeFastPathSettings(boundWorkspace);
    sessionArtifactsPersistenceAvailable =
      sessionArtifactsPersistenceAvailableFromSettings(bootSettings);
    contextFilenameForInit = extractContextFilename(
      bootSettings.context?.fileName,
    );
    const policyConfig = bootSettings.policy ?? {};
    const resolved = validatePolicyConfig(policyConfig);
    permissionPolicy = resolved.permissionPolicy;
    permissionConsensusQuorum = resolved.permissionConsensusQuorum;
  } catch (err) {
    // Invalid policy values must fail startup loudly. Discriminate by
    // error class rather than substring-matching the message.
    if (err instanceof InvalidPolicyConfigError) {
      throw err;
    }
    // All other settings-read failures (corrupted JSON, transient
    // disk IO) fall back to defaults so the daemon stays bootable.
    writeStderrLine(
      `qwen serve: could not read settings for context.fileName / ` +
        `policy.* (${err instanceof Error ? err.message : String(err)}); ` +
        `falling back to defaults. Restart with a valid settings.json ` +
        `to apply context.fileName / policy.* overrides.`,
    );
  }

  // Init daemon logger early so all subsequent lifecycle events
  // (bridge spawn diagnostics, shutdown errors) are captured to file.
  const daemonLogBaseDir = await resolveDaemonLogBaseDirForRun({
    deps,
    bootSettings,
    boundWorkspace,
  });
  const daemonLog: DaemonLogger = await initDaemonLogger({
    boundWorkspace,
    baseDir: daemonLogBaseDir,
  });
  loggerLifecycle.initialized(daemonLog);
  daemonLog.info('project memory scope resolved', {
    projectMemoryScope: resolvedMemoryProjectScope,
    projectMemoryScopeSource: memoryProjectScopeSource,
    projectMemoryScopeRaw: memoryProjectScopeValue,
  });
  // Per-workspace .env loads keep running after boot (skill status, voice
  // capability checks, settings reloads); boot stderr is long gone by then,
  // so fresh loader-key rejections must land in the durable daemon log or
  // they vanish without a diagnostic.
  const loaderRejectionReporter: LoaderKeyRejectionReporter = (
    source,
    freshKeys,
  ) => {
    daemonLog.warn(
      'rejected loader-affecting env keys; they were not applied',
      {
        source,
        rejectedKeys: freshKeys,
      },
    );
  };
  setLoaderKeyRejectionReporter(loaderRejectionReporter);
  loggerLifecycle.reporterInstalled(loaderRejectionReporter);
  // Boot stderr rarely survives desktop/systemd daemon launches, so persist
  // the scrub decision in the durable daemon log as well.
  if (scrubbedLoaderEnvKeys.length > 0) {
    daemonLog.info(
      'scrubbed inherited loader env vars from the daemon process; ' +
        'session subprocesses will not inherit them',
      { removedKeys: scrubbedLoaderEnvKeys },
    );
  }
  // The serve fast path rejects loader keys before this logger exists, and
  // its stderr warnings rarely survive desktop/systemd launches either.
  const fastPathRejectedLoaderKeys = consumeServeFastPathRejectedLoaderKeys();
  if (fastPathRejectedLoaderKeys.length > 0) {
    daemonLog.info(
      'rejected loader-affecting env keys during serve fast-path boot; ' +
        'they were not applied to the daemon process',
      { rejectedKeys: fastPathRejectedLoaderKeys },
    );
  }
  let loggerPublished = false;
  let loggerSignalOwned = false;
  writeStderrLine(
    `qwen serve: daemon log → ${daemonLog.getLogPath() || '(disabled)'}`,
  );

  // The MCP client guardrails enforce in the ACP child process (where
  // `McpClientManager` lives), not the daemon. Forward the budget
  // config via env vars so the child's `readBudgetFromEnv()` picks
  // them up. Use per-handle env overrides via
  // `BridgeOptions.childEnvOverrides` instead of mutating global
  // `process.env`, so concurrent embedded daemons don't race.
  if (opts.mcpClientBudget !== undefined) {
    if (
      !Number.isFinite(opts.mcpClientBudget) ||
      !Number.isInteger(opts.mcpClientBudget) ||
      opts.mcpClientBudget <= 0
    ) {
      throw new TypeError(
        `Invalid mcpClientBudget: ${opts.mcpClientBudget}. Must be a positive integer.`,
      );
    }
  }
  if (opts.mcpBudgetMode === 'enforce' && opts.mcpClientBudget === undefined) {
    throw new Error(
      'mcpBudgetMode="enforce" requires a positive mcpClientBudget. ' +
        'Pass mcpClientBudget=N, or set mcpBudgetMode to "warn" or "off".',
    );
  }
  // Validate the deadline options on the explicit option path.
  // The env path is already validated inside `parseDeadlineEnv`. Boot-
  // loud so an embedded caller passing `{ promptDeadlineMs: -5 }`
  // doesn't end up with a daemon that silently fails to enforce the
  // cap, leaving the operator believing the timeout is active.
  if (opts.promptDeadlineMs !== undefined) {
    if (!isPositiveIntegerMs(opts.promptDeadlineMs)) {
      throw new TypeError(
        `Invalid promptDeadlineMs: ${opts.promptDeadlineMs}. Must be a positive integer (milliseconds).`,
      );
    }
    assertTimerDelayInRange('promptDeadlineMs', opts.promptDeadlineMs);
  }
  if (opts.maxSessions !== undefined) {
    if (Number.isNaN(opts.maxSessions) || opts.maxSessions < 0) {
      throw new TypeError(
        `Invalid maxSessions: ${opts.maxSessions}. Must be a number >= 0 ` +
          `(0 / Infinity = unlimited).`,
      );
    }
  }
  if (opts.maxTotalSessions !== undefined) {
    if (!isNonNegativeIntegerOrInfinity(opts.maxTotalSessions)) {
      throw new TypeError(
        `Invalid maxTotalSessions: ${opts.maxTotalSessions}. Must be a non-negative integer ` +
          `(0 / Infinity = unlimited).`,
      );
    }
  }
  if (opts.maxPendingPromptsPerSession !== undefined) {
    if (!isNonNegativeIntegerOrInfinity(opts.maxPendingPromptsPerSession)) {
      throw new TypeError(
        `Invalid maxPendingPromptsPerSession: ${opts.maxPendingPromptsPerSession}. Must be a non-negative integer (0 / Infinity = unlimited).`,
      );
    }
  }
  if (opts.eventRingSize !== undefined) {
    if (
      !Number.isInteger(opts.eventRingSize) ||
      opts.eventRingSize < 1 ||
      opts.eventRingSize > MAX_EVENT_RING_SIZE
    ) {
      throw new TypeError(
        `Invalid eventRingSize: ${opts.eventRingSize}. ` +
          `Must be a positive integer in [1, ${MAX_EVENT_RING_SIZE}].`,
      );
    }
  }
  if (opts.compactedReplayMaxBytes !== undefined) {
    normalizeCompactedReplayMaxBytes(opts.compactedReplayMaxBytes);
  }
  if (opts.maxJournalEvents !== undefined) {
    normalizeMaxJournalEvents(opts.maxJournalEvents);
  }
  if (opts.maxJournalBytes !== undefined) {
    normalizeMaxJournalBytes(opts.maxJournalBytes);
  }
  if (opts.writerIdleTimeoutMs !== undefined) {
    if (!isPositiveIntegerMs(opts.writerIdleTimeoutMs)) {
      throw new TypeError(
        `Invalid writerIdleTimeoutMs: ${opts.writerIdleTimeoutMs}. Must be a positive integer (milliseconds).`,
      );
    }
  }
  if (opts.channelIdleTimeoutMs !== undefined) {
    if (
      !Number.isFinite(opts.channelIdleTimeoutMs) ||
      !Number.isInteger(opts.channelIdleTimeoutMs) ||
      opts.channelIdleTimeoutMs < 0
    ) {
      throw new TypeError(
        `Invalid channelIdleTimeoutMs: ${opts.channelIdleTimeoutMs}. Must be a non-negative integer (milliseconds, 0 = immediate kill).`,
      );
    }
  }
  if (opts.sessionReapIntervalMs !== undefined) {
    if (!isNonNegativeIntegerMs(opts.sessionReapIntervalMs)) {
      throw new TypeError(
        `Invalid sessionReapIntervalMs: ${opts.sessionReapIntervalMs}. Must be a non-negative integer (milliseconds, 0 = disabled).`,
      );
    }
  }
  if (opts.sessionIdleTimeoutMs !== undefined) {
    if (!isNonNegativeIntegerMs(opts.sessionIdleTimeoutMs)) {
      throw new TypeError(
        `Invalid sessionIdleTimeoutMs: ${opts.sessionIdleTimeoutMs}. Must be a non-negative integer (milliseconds, 0 = disabled).`,
      );
    }
  }
  if (opts.initializeTimeoutMs !== undefined) {
    if (!isPositiveIntegerMs(opts.initializeTimeoutMs)) {
      throw new TypeError(
        `Invalid initializeTimeoutMs: ${opts.initializeTimeoutMs}. Must be a positive integer (milliseconds).`,
      );
    }
    assertTimerDelayInRange('initializeTimeoutMs', opts.initializeTimeoutMs);
  }
  const sessionRestoreTimeoutMs = resolveSessionRestoreTimeoutMs(opts);
  opts.sessionRestoreTimeoutMs = sessionRestoreTimeoutMs;
  // Validate here (not just in the yargs handler) so embedded callers of
  // `runQwenServe({ permissionResponseTimeoutMs })` also fail loud: the
  // bridge treats a non-finite / negative value as the "disabled"
  // sentinel, which would silently drop the permission deadline. Mirrors
  // `channelIdleTimeoutMs`; out-of-range values are clamped by the bridge.
  if (opts.permissionResponseTimeoutMs !== undefined) {
    if (
      !Number.isFinite(opts.permissionResponseTimeoutMs) ||
      !Number.isInteger(opts.permissionResponseTimeoutMs) ||
      opts.permissionResponseTimeoutMs < 0
    ) {
      throw new TypeError(
        `Invalid permissionResponseTimeoutMs: ${opts.permissionResponseTimeoutMs}. Must be a non-negative integer (milliseconds, 0 = disabled / wait forever).`,
      );
    }
  }
  const rawExternalToolGuard = (opts as { externalToolGuard?: unknown })
    .externalToolGuard;
  if (
    rawExternalToolGuard !== undefined &&
    (typeof rawExternalToolGuard !== 'object' ||
      rawExternalToolGuard === null ||
      (rawExternalToolGuard as { mode?: unknown }).mode !== 'required')
  ) {
    throw new TypeError(
      "Invalid externalToolGuard: omit it for off mode or set mode to 'required'.",
    );
  }
  opts.maxTotalSessions ??= deriveDefaultMaxTotalSessions(
    opts.maxSessions,
    workspaceInputs.length,
  );
  // Per-handle env overrides: `undefined` value means "scrub this
  // var from the child env" — important when a different daemon
  // in the same process set the var globally previously. Always
  // set both keys explicitly (to value or `undefined`) so each
  // child's MCP budget env is fully determined by this handle's
  // options, with no inheritance from process.env's current state.
  //
  // If the daemon parent process has the pool kill switch
  // (`QWEN_SERVE_NO_MCP_POOL=1`) in its own env, infer
  // `mcpPoolActive: false` so the capabilities envelope drops the
  // `mcp_workspace_pool` + `mcp_pool_restart` tags.
  const inheritedNoPool = process.env['QWEN_SERVE_NO_MCP_POOL'] === '1';
  if (opts.mcpPoolActive === undefined && inheritedNoPool) {
    opts.mcpPoolActive = false;
  }
  let externalToolGuardHandler: ExternalToolGuardHandler | undefined;
  if (opts.externalToolGuard?.mode === 'required') {
    if (deps.bridge) {
      throw new Error(
        'Required external tool guarding cannot be combined with an injected bridge.',
      );
    }
    const { RequiredExternalToolGuard } = await import(
      './external-tool-guard-provider.js'
    );
    const provider = new RequiredExternalToolGuard({
      endpoint: opts.externalToolGuard.endpoint,
      token: opts.externalToolGuard.token,
      ...(opts.externalToolGuard.timeoutMs !== undefined
        ? { timeoutMs: opts.externalToolGuard.timeoutMs }
        : {}),
    });
    await provider.initialize();
    externalToolGuardHandler = provider.prepare;
    writeStderrLine(
      'qwen serve: required external tool guard handshake succeeded.',
    );
  }
  // Keep the guard's core helper imports out of the serve fast-path bundle.
  const { createDaemonToolGuard } = await import(
    './daemon-git-worktree-guard.js'
  );
  const daemonToolGuardHandler = createDaemonToolGuard(
    externalToolGuardHandler,
  );
  const childEnvOverrides: Record<string, string | undefined> = {
    QWEN_SERVE_MCP_CLIENT_BUDGET:
      opts.mcpClientBudget !== undefined
        ? String(opts.mcpClientBudget)
        : undefined,
    QWEN_SERVE_MCP_BUDGET_MODE: opts.mcpBudgetMode,
    QWEN_SERVE_CDP_TUNNEL_OVER_WS: opts.cdpTunnelOverWs ? '1' : undefined,
    [PRIVATE_EXTERNAL_TOOL_GUARD_ENV]: EXTERNAL_TOOL_GUARD_REQUIRED_VALUE,
    [PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER_ENV]: externalToolGuardHandler
      ? EXTERNAL_TOOL_GUARD_PROVIDER_ATTACHED_VALUE
      : undefined,
  };

  const cliVersionPromise = getCliVersion();
  let cliVersion: string | undefined;

  const diagnosticSink = (line: string, level?: 'info' | 'warn' | 'error') =>
    daemonLog.raw(line, level);

  let actualPort = opts.port;

  // Resolve the built Web Shell SPA so createServeApp can mount the UI at the
  // daemon root. --no-web (serveWebShell=false) skips it. Absent assets (e.g.
  // a --cli-only build that omits packages/web-shell) degrade to API-only
  // with a breadcrumb rather than failing the boot.
  const webShellDir =
    opts.serveWebShell === false ? undefined : resolveWebShellDir();
  if (optsIn.requireWebShell && !webShellDir) {
    throw new Error('--open-with-auth requires built Web Shell assets.');
  }
  if (opts.serveWebShell !== false) {
    if (!webShellDir) {
      writeStderrLine(
        'qwen serve: Web Shell assets not found; serving API only. ' +
          'Build the web-shell workspace (npm run build) or pass --no-web to silence this.',
      );
    } else {
      // Positive happy-path breadcrumb so operators can confirm the UI is live
      // (the only other lines are negative-path warnings).
      writeStderrLine(`qwen serve: Web Shell UI served from ${webShellDir}`);
      if (!isLoopbackBind(opts.hostname)) {
        writeStderrLine(
          'qwen serve: Web Shell UI is served WITHOUT auth on a non-loopback ' +
            'bind (the static shell has no secrets; the API stays token-gated). ' +
            'Pass --no-web to disable the UI.',
        );
        // The shell HTML/JS loads (GET carries no Origin), but its same-origin
        // POSTs (create session, prompt, permission vote) send an Origin the
        // daemon's CORS wall rejects with 403 unless allow-listed — so without
        // --allow-origin the UI is effectively read-only on a non-loopback
        // bind. Front the daemon with a same-origin reverse proxy, or pass
        // --allow-origin <origin>, to make mutations work.
        if (!opts.allowOrigins || opts.allowOrigins.length === 0) {
          writeStderrLine(
            'qwen serve: without --allow-origin the Web Shell is read-only on a ' +
              'non-loopback bind — same-origin POSTs are blocked by CORS (403). ' +
              'Pass --allow-origin <origin> or front it with a same-origin proxy.',
          );
        }
      }
    }
  }
  // webShellDir is already undefined whenever serveWebShell === false, so this
  // collapses to "did we resolve real assets".
  const webShellMounted = !!webShellDir;
  const serveAppLifecycle = new ServeAppLifecycleController();
  const liveDiscoveryStableBaseDir = path.resolve(
    deps.liveDiscoveryStableBaseDir ?? path.join(os.homedir(), '.qwen'),
  );
  let resolveServeAppStartup!: () => void;
  let rejectServeAppStartup!: (error: Error) => void;
  let serveAppStartupSettled = false;
  const serveAppStartupReady = new Promise<void>((resolve, reject) => {
    resolveServeAppStartup = resolve;
    rejectServeAppStartup = reject;
  });
  void serveAppStartupReady.catch(() => undefined);
  const markServeAppStartupReady = (): void => {
    if (serveAppStartupSettled) return;
    serveAppStartupSettled = true;
    resolveServeAppStartup();
  };
  const markServeAppStartupFailed = (error: Error): void => {
    if (serveAppStartupSettled) return;
    serveAppStartupSettled = true;
    rejectServeAppStartup(error);
  };
  let runtimeApp: Application | undefined;
  let runtimeAppForCleanup: Application | undefined;
  let bridgeRef: AcpSessionBridge | undefined = deps.bridge;
  let managedProcessRegistry:
    | {
        shutdown(): Promise<void>;
        killAllSync(): void;
      }
    | undefined;
  // Held for daemon status: `observe` mode's whole product is the would-be
  // refusal count, which is useless unless it can be read back out.
  let managedChildHeapPolicy: ChildHeapPolicy | undefined;
  const internalRuntimeBridgesForCleanup: AcpSessionBridge[] = [];
  let daemonEventLoopMonitor:
    | ReturnType<CoreRuntime['startEventLoopLagMonitor']>
    | undefined;
  // Daemon Status metrics-ring sampler: a fixed-cadence timer that seals a
  // bucket plus the window-scoped event-loop histogram it resets each seal.
  // Torn down together with the event-loop monitor on runtime restart/stop.
  let daemonMetricsSampler: { dispose(): void } | undefined;
  // Low-frequency sweep refreshing bound-PR state snapshots (open → merged).
  // The refresh module loads via dynamic import (see start site) because it
  // pulls the SessionService chain, which must stay out of the pre-listen
  // static closure; the generation guards dispose-vs-async-start races.
  let sessionPrRefreshTimer: { dispose(): void } | undefined;
  let sessionPrRefreshGeneration = 0;
  let runtimeStartupError: string | undefined;
  let runtimeStarting: Promise<void> | undefined;
  let markRuntimeReady!: () => void;
  let markRuntimeFailed!: (err: Error) => void;
  let runtimeStartupSettled = false;
  let startRuntimeAfterHealth: (() => void) | undefined;
  let startRuntimeForRequest: (() => boolean) | undefined;
  const deferRuntimeUntilFirstHealth =
    deps.resolveOnListen === true && deps.deferRuntimeUntilFirstHealth === true;
  const runtimeReady = new Promise<void>((resolve, reject) => {
    markRuntimeReady = resolve;
    markRuntimeFailed = reject;
  });
  void runtimeReady.catch(() => {});
  const disposeDaemonEventLoopMonitor = (): void => {
    const eventLoopMonitor = daemonEventLoopMonitor;
    daemonEventLoopMonitor = undefined;
    const metricsSampler = daemonMetricsSampler;
    daemonMetricsSampler = undefined;
    const prRefreshTimer = sessionPrRefreshTimer;
    sessionPrRefreshTimer = undefined;
    sessionPrRefreshGeneration += 1;
    prRefreshTimer?.dispose();
    try {
      eventLoopMonitor?.dispose();
    } catch (err) {
      daemonLog.warn(
        `event loop monitor dispose error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    try {
      metricsSampler?.dispose();
    } catch (err) {
      daemonLog.warn(
        `metrics sampler dispose error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
  let channelWorkerManager: ChannelWorkerManager | undefined;
  let channelWorkerManagerStarting: Promise<ChannelWorkerManager> | undefined;
  let channelControlDraining = false;
  let channelWorkspaceGroups: readonly ChannelWorkspaceGroup[] | undefined;
  const channelWebhookEnvByWorkspace = new Map<
    string,
    Readonly<Record<string, string | undefined>>
  >();
  let channelWebhookConfigVersion = 0;
  let refreshChannelWebhookConfigs: (() => void) | undefined;
  let ensureChannelWorkerManager:
    | (() => Promise<ChannelWorkerManager>)
    | undefined;
  const getChannelWebhookConfigSources = (): ChannelWebhookConfigSource[] => {
    const app = runtimeApp ?? runtimeAppForCleanup;
    const registry = app?.locals?.['workspaceRegistry'] as
      | WorkspaceRegistry
      | undefined;
    return (channelWorkspaceGroups ?? []).map((group) => {
      const env =
        registry?.getByWorkspaceCwd(group.workspaceCwd)?.env.effectiveEnv ??
        channelWebhookEnvByWorkspace.get(group.workspaceCwd);
      return {
        workspaceCwd: group.workspaceCwd,
        ...(group.selection.mode === 'names'
          ? { channelNames: group.selection.names }
          : {}),
        ...(env ? { env } : {}),
      };
    });
  };
  const resolveChannelWebhookConfigSource = (
    channelName: string,
  ): ChannelWebhookConfigSource => {
    const source = getChannelWebhookConfigSources().find(
      (source) =>
        !source.channelNames || source.channelNames.includes(channelName),
    );
    if (source) return source;
    const env = channelWebhookEnvByWorkspace.get(boundWorkspace);
    return {
      workspaceCwd: boundWorkspace,
      ...(env ? { env } : {}),
    };
  };
  let closeServerAfterChannelWorkerStartupFailure = false;
  const getChannelWorkerSnapshot = (): ChannelWorkerSnapshot =>
    channelWorkerManager?.primarySnapshot() ?? {
      enabled: false,
      state: 'disabled',
      channels: [],
    };
  const getChannelWorkerSnapshots = (): ChannelWorkerGroupSnapshot[] =>
    channelWorkerManager?.snapshots() ?? [];
  const getChannelWorkerControl = (): ChannelWorkerControlState =>
    channelWorkerManager?.state() ?? {
      enabled: false,
      selection: null,
      transition: 'idle',
      workers: [],
    };
  const daemonDrainingError = () =>
    Object.assign(new Error('Daemon is shutting down.'), {
      code: 'daemon_draining',
    });
  const setChannelWorkerSelection = async (
    selection: ServeChannelSelection,
  ): Promise<ChannelWorkerSetResult> => {
    if (channelControlDraining) throw daemonDrainingError();
    const manager = await ensureChannelWorkerManager?.();
    if (!manager) throw new Error('Channel worker manager is unavailable.');
    if (channelControlDraining) {
      await manager.shutdown().catch(() => undefined);
      throw daemonDrainingError();
    }
    return manager.setSelection(selection);
  };
  const stopChannelWorker = async (): Promise<ChannelWorkerStopResult> => {
    if (channelControlDraining) throw daemonDrainingError();
    const manager =
      channelWorkerManager ?? (await channelWorkerManagerStarting);
    if (channelControlDraining) {
      await manager?.shutdown().catch(() => undefined);
      throw daemonDrainingError();
    }
    if (!manager) {
      return { changed: false, state: getChannelWorkerControl() };
    }
    return manager.stopSelection();
  };
  const reloadChannelWorker = async (): Promise<ChannelWorkerSnapshot> => {
    if (channelControlDraining) throw daemonDrainingError();
    const manager =
      channelWorkerManager ?? (await channelWorkerManagerStarting);
    if (channelControlDraining) {
      await manager?.shutdown().catch(() => undefined);
      throw daemonDrainingError();
    }
    if (!manager) {
      return { enabled: false, state: 'disabled' as const, channels: [] };
    }
    try {
      return await manager.reload();
    } finally {
      writeChannelWorkerPidfile();
    }
  };
  // Rewrite the full worker list from the current group snapshots on every
  // ready/exit. A synchronous full rewrite (rather than a read-modify-write of
  // a single entry) keeps concurrent per-worker updates from losing each other.
  const isLiveWorker = (snapshot: ChannelWorkerGroupSnapshot): boolean =>
    snapshot.state === 'running' || snapshot.state === 'starting';
  let channelWorkerPidfileUsesWorkers = workspaceInputs.length > 1;
  const writeChannelWorkerPidfile = (): void => {
    if (runtimeStartupError !== undefined) return;
    if (!channelPidfileReserved || !channelServicePidfile) return;
    const snapshots = getChannelWorkerSnapshots();
    const workers: ServiceInfoWorker[] = snapshots.map((snapshot) => ({
      workspaceId: snapshot.workspaceId,
      workspaceCwd: snapshot.workspaceCwd,
      channels: snapshot.channels,
      // Drop a stale pid (worker exited/failed/stopped) so readers never signal
      // a dead process — mirrors the pre-4b clear-on-exit behavior.
      ...(isLiveWorker(snapshot) && snapshot.pid !== undefined
        ? { workerPid: snapshot.pid }
        : {}),
    }));
    const channels = [
      ...new Set(snapshots.flatMap((snapshot) => snapshot.channels)),
    ];
    const primary = snapshots.find((snapshot) => snapshot.primary);
    // Only surface the per-workspace worker list in multi-workspace mode; a
    // single-workspace daemon keeps the byte-identical channels/workerPid shape.
    if (workers.length > 1 || snapshots.some((snapshot) => !snapshot.primary)) {
      channelWorkerPidfileUsesWorkers = true;
    }
    const includeWorkers =
      channelWorkerPidfileUsesWorkers && workers.length > 0;
    try {
      channelServicePidfile.writeServeServiceInfo({
        channels,
        servePid: process.pid,
        ...(primary && isLiveWorker(primary) && primary.pid !== undefined
          ? { workerPid: primary.pid }
          : {}),
        ...(includeWorkers ? { workers } : {}),
      });
    } catch (err) {
      daemonLog.warn(
        `failed to write channel worker pidfile metadata: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  const handleBridge =
    deps.bridge ??
    createLazyBridgeProxy(
      () => bridgeRef,
      () => runtimeStartupError,
    );
  const shutdownBridges = new WeakSet<AcpSessionBridge>();
  const disposedRuntimeApps = new WeakSet<Application>();
  const stoppedRuntimeAppProducers = new WeakSet<Application>();
  const stoppedExtensionReconcilers = new WeakSet<Application>();
  const stoppedTrustPolicyMonitors = new WeakSet<Application>();
  const stopTrustPolicyMonitor = (app: Application | undefined): void => {
    if (!app || stoppedTrustPolicyMonitors.has(app)) return;
    stoppedTrustPolicyMonitors.add(app);
    const stop = app.locals?.['stopTrustPolicyMonitor'] as
      | (() => void)
      | undefined;
    try {
      stop?.();
    } catch (err) {
      daemonLog.warn(
        `trust policy monitor dispose error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
  const stopExtensionReconciler = (app: Application | undefined): void => {
    if (!app || stoppedExtensionReconcilers.has(app)) return;
    stoppedExtensionReconcilers.add(app);
    const stopExtensionGenerationReconciler = app.locals?.[
      'stopExtensionGenerationReconciler'
    ] as (() => void) | undefined;
    try {
      stopExtensionGenerationReconciler?.();
    } catch (err) {
      daemonLog.warn(
        `extension generation reconciler dispose error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
  const stopRuntimeAppProducers = (app: Application | undefined): void => {
    if (!app || stoppedRuntimeAppProducers.has(app)) return;
    stoppedRuntimeAppProducers.add(app);
    const locals = app.locals as {
      stopScheduledTaskKeepalive?: () => void;
      stopWorkspaceGitState?: () => void;
      stopLiveCoordinator?: () => void;
      stopWebTerminalRegistry?: () => void;
      subSessionStoppers?: Array<() => void>;
    };
    const stopSafely = (name: string, stop: (() => void) | undefined) => {
      try {
        stop?.();
      } catch (err) {
        daemonLog.warn(
          `${name} dispose error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    };
    stopSafely('scheduled-task keepalive', locals.stopScheduledTaskKeepalive);
    stopSafely('workspace git state', locals.stopWorkspaceGitState);
    stopSafely('Live Host coordinator', locals.stopLiveCoordinator);
    stopSafely('web terminal registry', locals.stopWebTerminalRegistry);
    stopTrustPolicyMonitor(app);
    for (const stop of locals.subSessionStoppers ?? []) {
      stopSafely('sub-session launcher', stop);
    }
    stopExtensionReconciler(app);
  };
  const disposeRuntimeAppResources = (app: Application | undefined): void => {
    if (!app || disposedRuntimeApps.has(app)) return;
    disposedRuntimeApps.add(app);
    stopRuntimeAppProducers(app);

    // Cancel IdP polling before disposing transports that may share its HTTP
    // agents.
    const deviceFlowRegistry = getDeviceFlowRegistry(app);
    if (deviceFlowRegistry) {
      try {
        deviceFlowRegistry.dispose();
      } catch (err) {
        daemonLog.warn(
          `device-flow registry dispose error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Queue Local Control teardown before disposing the ACP handle. The
    // serialized disable runs on the next microtask and wins before further IO;
    // ACP disposal below also removes the upgrade listeners while the daemon
    // mount is being torn down.
    const localControlService = app.locals?.['localControlService'] as
      | LocalControlService
      | undefined;
    if (localControlService) {
      void localControlService.dispose().catch((err: unknown) => {
        daemonLog.warn(
          `Local Control dispose error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }

    const acpHandle = app.locals?.['acpHandle'] as AcpHttpHandle | undefined;
    if (acpHandle?.dispose) {
      try {
        acpHandle.dispose();
      } catch (err) {
        daemonLog.warn(
          `ACP handle dispose error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const rateLimiter = getRateLimiter(app);
    if (rateLimiter) {
      try {
        rateLimiter.setDraining(true);
        rateLimiter.dispose();
      } catch (err) {
        daemonLog.warn(
          `rate limiter dispose error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    disposeDaemonEventLoopMonitor();
  };
  const getRuntimeBridgesForCleanup = (): AcpSessionBridge[] => {
    const appForCleanup = runtimeApp ?? runtimeAppForCleanup;
    const registry = appForCleanup?.locals?.['workspaceRegistry'] as
      | WorkspaceRegistry
      | undefined;
    const bridges = [
      ...(registry
        ? registry.listManaged().map((runtime) => runtime.bridge)
        : []),
      ...(bridgeRef ? [bridgeRef] : []),
      ...internalRuntimeBridgesForCleanup,
    ];
    return [...new Set(bridges)];
  };

  const buildRuntime = async (): Promise<{
    app: Application;
    bridge: AcpSessionBridge | undefined;
  }> => {
    const [runtime, core, settingsRuntime, resolvedCliVersion, trustPolicy] =
      await Promise.all([
        loadServeRuntimeModules(),
        loadCoreRuntime(),
        loadSettingsRuntimeModules(),
        cliVersionPromise,
        import('../config/daemon-trust-policy.js'),
      ]);
    cliVersion = resolvedCliVersion;
    settingsRuntime.environment.preResolveHomeEnvOverrides();
    const bootTrustSnapshot = await trustPolicy.readDaemonTrustPolicySnapshot();
    let latestTrustPolicySnapshot = bootTrustSnapshot;
    const bootPrimaryTrustDecision = trustPolicy.evaluateDaemonWorkspaceTrust(
      bootTrustSnapshot,
      boundWorkspace,
    );
    const trustedWorkspace =
      deps.trustedWorkspace ?? bootPrimaryTrustDecision.targetTrusted;
    const workspaceTrustHotReloadAvailable =
      deps.trustedWorkspace === undefined &&
      deps.bridge === undefined &&
      deps.fsFactory === undefined;
    let managedScratchRoot: ManagedScratchRoot | undefined;
    try {
      // Root acceptance is fail-closed and happens only after every startup
      // workspace (including restored registrations) has been resolved.
      managedScratchRoot = prepareManagedScratchRoot(
        path.join(core.Storage.getGlobalQwenDir(), 'scratch-workspaces'),
        workspaceInputs.map((workspace) => workspace.cwd),
      );
    } catch (err) {
      writeStderrLine(
        `qwen serve: managed scratch workspaces are unavailable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    let runtimeBootSettings:
      | ReturnType<SettingsRuntime['loadSettings']>
      | undefined;
    try {
      runtimeBootSettings = settingsRuntime.settings.loadSettings(
        boundWorkspace,
        {
          skipLoadEnvironment: true,
          skipWorkspaceSettings: !trustedWorkspace,
          workspaceTrusted: trustedWorkspace,
        },
      );
    } catch (err) {
      writeStderrLine(
        `qwen serve: could not read full settings for runtime startup ` +
          `(${err instanceof Error ? err.message : String(err)}); falling back to defaults.`,
      );
    }
    if (
      deps.trustedWorkspace === undefined &&
      runtimeBootSettings &&
      !trustedWorkspace
    ) {
      daemonLog.warn(
        'workspace file writes are disabled because the bound workspace is not trusted',
        { workspace: boundWorkspace },
      );
    }
    const runtimeEnvSnapshot = runtimeBootSettings
      ? settingsRuntime.environment.buildRuntimeEnvironment(
          runtimeBootSettings.merged,
          boundWorkspace,
          daemonRuntimeBaseEnv,
          trustedWorkspace,
        )
      : {
          effectiveEnv: { ...daemonRuntimeBaseEnv },
          overlayKeys: Object.freeze([] as string[]),
          envFilePaths: Object.freeze([] as string[]),
          envFileReadFailed: false,
          envFileReadFailures: Object.freeze([]),
        };
    const resolveSessionRuntimeBaseDir = (
      workspace: string,
      settings: ReturnType<SettingsRuntime['loadSettings']> | undefined,
      effectiveEnv: Readonly<NodeJS.ProcessEnv>,
    ): string => {
      const resolveConfiguredPath = (
        configuredPath: string,
        relativeTo: string,
      ): string => {
        const expanded =
          configuredPath === '~'
            ? os.homedir()
            : configuredPath.startsWith('~/') ||
                configuredPath.startsWith('~\\')
              ? path.join(
                  os.homedir(),
                  ...configuredPath
                    .slice(2)
                    .split(/[/\\]+/)
                    .filter(Boolean),
                )
              : configuredPath;
        return path.resolve(relativeTo, expanded);
      };
      const runtimeDir = effectiveEnv['QWEN_RUNTIME_DIR'];
      if (runtimeDir) {
        return resolveConfiguredPath(runtimeDir, process.cwd());
      }
      const settingsDir = settings?.merged.advanced?.runtimeOutputDir;
      if (settingsDir) {
        return resolveConfiguredPath(settingsDir, workspace);
      }
      const qwenHome = effectiveEnv['QWEN_HOME'];
      if (qwenHome) {
        return resolveConfiguredPath(qwenHome, process.cwd());
      }
      const homeDir = os.homedir();
      return homeDir
        ? path.join(homeDir, '.qwen')
        : path.join(os.tmpdir(), '.qwen');
    };
    const logRuntimeEnvFileReadFailures = (
      workspace: string,
      snapshot: {
        readonly envFileReadFailed: boolean;
        readonly envFileReadFailures?: ReadonlyArray<{
          readonly path: string;
          readonly error: string;
        }>;
      },
    ): void => {
      if (!snapshot.envFileReadFailed) return;
      const failedFiles = snapshot.envFileReadFailures ?? [];
      daemonLog.warn('one or more runtime env files could not be read', {
        workspace,
        ...(failedFiles.length > 0 ? { failedFiles } : {}),
      });
    };
    logRuntimeEnvFileReadFailures(boundWorkspace, runtimeEnvSnapshot);
    const primarySessionRuntimeBaseDir = resolveSessionRuntimeBaseDir(
      boundWorkspace,
      runtimeBootSettings,
      runtimeEnvSnapshot.effectiveEnv,
    );
    const sessionAttachmentsRoot = (
      workspace: string,
      runtimeBaseDir: string,
    ): string =>
      path.join(
        new core.Storage(workspace, runtimeBaseDir).getProjectTempDir(),
        'attachments',
      );
    const runtimeEffectiveEnv: NodeJS.ProcessEnv = {
      ...runtimeEnvSnapshot.effectiveEnv,
      QWEN_RUNTIME_DIR: primarySessionRuntimeBaseDir,
    };
    const replaceRuntimeEffectiveEnv = (
      nextEnv: Readonly<NodeJS.ProcessEnv>,
    ): void => {
      for (const key of Object.keys(runtimeEffectiveEnv)) {
        delete runtimeEffectiveEnv[key];
      }
      Object.assign(runtimeEffectiveEnv, nextEnv);
      runtimeEffectiveEnv['QWEN_RUNTIME_DIR'] = primarySessionRuntimeBaseDir;
    };
    const primaryRuntimeEnv: {
      mode: 'runtime-overlay';
      overlayKeys: string[];
      envFilePaths: string[];
      effectiveEnv: NodeJS.ProcessEnv;
      envFileReadFailed: boolean;
      envFileReadFailures: Array<{ path: string; error: string }>;
      fallbackReason?: string;
    } = {
      mode: 'runtime-overlay' as const,
      overlayKeys: [...runtimeEnvSnapshot.overlayKeys],
      effectiveEnv: runtimeEffectiveEnv,
      envFilePaths: [...runtimeEnvSnapshot.envFilePaths],
      envFileReadFailed: runtimeEnvSnapshot.envFileReadFailed,
      envFileReadFailures: [...runtimeEnvSnapshot.envFileReadFailures],
    };
    const daemonWorkspaceHash = core.hashDaemonWorkspace(boundWorkspace);
    let daemonTelemetrySettings: TelemetrySettings;
    try {
      daemonTelemetrySettings = await core.resolveTelemetrySettings({
        env: process.env,
        settings: runtimeBootSettings?.merged.telemetry,
      });
    } catch (err) {
      if (err instanceof core.FatalConfigError) {
        throw new core.FatalConfigError(
          `Invalid telemetry configuration: ${err.message}.`,
        );
      }
      throw err;
    }
    // Must settle before initializeDaemonMetrics(): metrics.getMeter() caches
    // a noop meter permanently if called before the SDK registers the global
    // MeterProvider. This runs in the deferred runtime load, off the fast path.
    await core.initializeTelemetry(
      createDaemonTelemetryRuntimeConfig(
        daemonTelemetrySettings,
        resolvedCliVersion,
        `daemon:${process.pid}`,
        {
          otlpEndpoint: core.DEFAULT_OTLP_ENDPOINT,
          telemetryTarget: core.DEFAULT_TELEMETRY_TARGET,
        },
      ),
    );
    core.initializeDaemonMetrics();
    daemonEventLoopMonitor?.dispose();
    daemonEventLoopMonitor = core.startEventLoopLagMonitor({
      onNewMaxStall: (maxMs) => {
        daemonLog.warn('daemon event loop stall detected', { maxMs });
      },
    });
    const currentDaemonEventLoopMonitor = daemonEventLoopMonitor;
    core.registerDaemonEventLoopLagGauge(() =>
      currentDaemonEventLoopMonitor.snapshot(),
    );
    // Daemon Status metrics ring (time-series charts). Bounded so ~15 min of
    // per-interval history survives dialog close / page reload — the point of
    // doing this in the daemon rather than accumulating in the browser. Fed from
    // the telemetry middleware (request rate/latency), the bridge telemetry
    // hooks (queue-wait/duration, token burn, LLM round-trip), the pipe recorder
    // (IPC bytes), and the sampler's gauge reads (CPU / memory / connections /
    // pending prompts / event-loop lag). Declared before `recordPipeMessage` so
    // that recorder can fold pipe bytes straight in.
    const metricsRing = new DaemonMetricsRing({
      capacity: DAEMON_METRICS_CAPACITY,
    });
    const pipeStats: DaemonPerfSnapshot['pipe'] = {
      inbound: { count: 0, totalBytes: 0, maxBytes: 0 },
      outbound: { count: 0, totalBytes: 0, maxBytes: 0 },
    };
    const promptQueueWaitStats = {
      count: 0,
      totalMs: 0,
      maxMs: 0,
      lastMs: null as number | null,
    };
    const recordPipeMessage = (
      direction: keyof DaemonPerfSnapshot['pipe'],
      bytes: number,
    ): void => {
      const stats = pipeStats[direction];
      stats.count += 1;
      stats.totalBytes += bytes;
      stats.maxBytes = Math.max(stats.maxBytes, bytes);
      core.recordDaemonPipeMessage(direction, bytes);
      metricsRing.recordPipe(direction, bytes);
    };
    const observeLargePipeFrame = createLargePipeFrameObserver({
      daemonLog,
      emitTelemetryLog: core.emitDaemonLog,
    });
    const recordPromptQueueWait = (durationMs: number): void => {
      promptQueueWaitStats.count += 1;
      promptQueueWaitStats.totalMs += durationMs;
      promptQueueWaitStats.maxMs = Math.max(
        promptQueueWaitStats.maxMs,
        durationMs,
      );
      promptQueueWaitStats.lastMs = durationMs;
      core.recordDaemonPromptQueueWait(durationMs);
    };
    const createRuntimeBridgeTelemetry = (workspaceHash: string) => {
      const telemetry = core.createDaemonBridgeTelemetry();
      telemetry.metrics = {
        sessionLifecycle(action) {
          core.recordDaemonSessionLifecycle(action);
          core.emitDaemonLog(
            `Session ${action}.`,
            {
              'qwen-code.workspace.hash': workspaceHash,
            },
            {
              eventName: `qwen-code.daemon.session.${action}`,
            },
          );
        },
        channelLifecycle(action, expected) {
          core.recordDaemonChannelLifecycle(action, expected);
          core.emitDaemonLog(
            action === 'spawn'
              ? 'ACP channel spawned.'
              : `ACP channel exited (expected=${expected ?? true}).`,
            {
              ...(action === 'exit'
                ? { 'qwen-code.daemon.channel.expected': expected ?? true }
                : {}),
            },
            {
              eventName: `qwen-code.daemon.channel.${action}`,
              ...(expected === false && action === 'exit'
                ? { severityNumber: 13 }
                : {}),
            },
          );
        },
        promptQueueWait(durationMs) {
          recordPromptQueueWait(durationMs);
          metricsRing.recordPromptQueueWait(durationMs);
        },
        promptDuration(durationMs) {
          core.recordDaemonPromptDuration(durationMs);
          metricsRing.recordPromptDuration(durationMs);
        },
        cancelled: core.recordDaemonCancel,
        // Per-round model token usage + LLM round-trip time sniffed off
        // `agent_message_chunk._meta` (`usage` + `durationMs`) at the bridge's
        // single session/update fan-in. Increments (not cumulative), so the ring
        // sums tokens per window (token-burn chart) and pools the round-trip times
        // for the LLM-latency percentiles. `apiErrors` / `apiRetries` ride the
        // same frame (per-round increments, 0 when none) and window into the
        // model-API-health chart.
        tokenUsage(
          inputTokens,
          outputTokens,
          durationMs,
          apiErrors,
          apiRetries,
        ) {
          metricsRing.recordTokens(inputTokens, outputTokens);
          if (typeof durationMs === 'number') {
            metricsRing.recordLlmDuration(durationMs);
          }
          metricsRing.recordApiActivity(apiErrors ?? 0, apiRetries ?? 0);
        },
      };
      return telemetry;
    };
    const daemonTelemetry = createRuntimeBridgeTelemetry(daemonWorkspaceHash);
    // Allocate the audit ring + publisher in the daemon host (here)
    // rather than inside the bridge factory, because the ring is the
    // seam for exposing `GET /workspace/permission/audit` in the future.
    const permissionAuditRing = new PermissionAuditRing();
    const permissionAuditPublisher = createPermissionAuditPublisher({
      ring: permissionAuditRing,
    });
    const customIgnoreFiles =
      runtimeBootSettings?.merged.context?.fileFiltering?.customIgnoreFiles;
    const boundWorkspaces = runtime.resolveBoundWorkspacesFromIdeEnv(
      boundWorkspace,
      undefined,
      (workspace: string, index: number) => {
        if (index === 0) return true;
        const trustedSecondary = trustPolicy.evaluateDaemonWorkspaceTrust(
          bootTrustSnapshot,
          workspace,
        ).targetTrusted;
        if (!trustedSecondary) {
          daemonLog.warn(
            'excluding untrusted secondary workspace root from file-system access',
            { workspace },
          );
        }
        return trustedSecondary;
      },
    );
    daemonLog.info('daemon workspace roots initialized', {
      primary: boundWorkspaces[0],
      secondary: boundWorkspaces.slice(1),
      ideEnvPresent: !!process.env['QWEN_CODE_IDE_WORKSPACE_PATH'],
    });
    const primaryGenerationGuard = runtime.createWorkspaceGenerationGuard();
    const primaryTrustMaterialization = JSON.stringify({
      trusted: trustedWorkspace,
      boundWorkspaces: [...boundWorkspaces].sort(),
    });
    const sharedPathLocks = new PathMutexRegistry();
    const workspaceTrustOperationGate = new PathMutexRegistry();
    const runWorkspaceTrustOperation = <T>(operation: () => Promise<T>) =>
      workspaceTrustOperationGate.runExclusive('runtime-topology', operation);
    const processRegistry = new runtime.ProcessRegistry();
    managedProcessRegistry = processRegistry;
    // One policy for the whole daemon, beside the one registry it reads. Both
    // must be shared: a per-factory registry would report a concurrent count
    // of 1 on every spawn and hand each child the entire pool.
    // Not built for an injected bridge: `deps.bridge` brings its own channel
    // and never goes through the factory this policy rides on, so a policy
    // here would size nothing while `limits.memory.enforced` claimed
    // otherwise — a status field asserting enforcement that is not happening.
    const childHeapPolicy: ChildHeapPolicy | undefined =
      opts.daemonMemoryBudget && !deps.bridge
        ? createChildHeapPolicy({
            budget: opts.daemonMemoryBudget,
            mode: opts.childHeapMode ?? 'observe',
          })
        : undefined;
    managedChildHeapPolicy = childHeapPolicy;
    const fsFactory = runtime.resolveBridgeFsFactory({
      // Secondary roots share a write-capable factory only after their own
      // folder trust check passes; untrusted secondary roots stay outside.
      boundWorkspaces,
      injected: deps.fsFactory,
      trusted: trustedWorkspace,
      emit: deps.fsAuditEmit,
      pathLocks: sharedPathLocks,
      generationGuard: primaryGenerationGuard,
      ...(customIgnoreFiles !== undefined ? { customIgnoreFiles } : {}),
    });
    const routeFsFactory = runtime.resolveBridgeFsFactory({
      // REST routes still return primary-relative paths, so keep their
      // filesystem boundary primary-only until responses carry root IDs.
      boundWorkspaces: [boundWorkspace],
      trusted: trustedWorkspace,
      emit: deps.fsAuditEmit,
      pathLocks: sharedPathLocks,
      generationGuard: primaryGenerationGuard,
      ...(customIgnoreFiles !== undefined ? { customIgnoreFiles } : {}),
    });
    const channelFactory = runtime.createSpawnChannelFactory({
      processRegistry,
      childHeapPolicy,
      pipeLimits: runtime.daemonAcpNdJsonLimits,
      sourceEnv: runtimeEffectiveEnv,
      onDiagnosticLine: diagnosticSink,
      pipeHooks: {
        onMessageSent: (bytes) => recordPipeMessage('outbound', bytes),
        onMessageReceived: (bytes) => recordPipeMessage('inbound', bytes),
        onMessageObserved: ({ direction, bytes, message }) =>
          observeLargePipeFrame({
            direction: daemonPipeDirection(direction),
            bytes,
            message,
          }),
      },
      ...(acpChildExtraArgs(opts)
        ? { extraArgs: acpChildExtraArgs(opts) }
        : {}),
    });
    const statusProvider = runtime.createDaemonStatusProvider({
      env: runtimeEffectiveEnv,
    });
    const workspaceProvidersStatusProvider =
      runtime.createWorkspaceProvidersStatusProvider({
        env: runtimeEffectiveEnv,
        workspaceTrusted: trustedWorkspace,
      });
    const workspaceSkillsStatusProvider =
      runtime.createWorkspaceSkillsStatusProvider({
        workspaceTrusted: trustedWorkspace,
      });
    // Reverse tool channel (issue #5626, Phase 2). ONE sender registry shared
    // between the bridge (which answers the ACP child's `client_mcp/message`
    // ext-method via `clientMcpSender`) and the WS provider in `createServeApp`
    // (which registers a per-connection `ClientMcpRegistrar`'s sender on
    // `mcp_register`). Inert unless `opts.clientMcpOverWs` is on.
    const clientMcpSenderRegistry = new ClientMcpSenderRegistry();
    const runtimeBridges: AcpSessionBridge[] = [];
    const totalSessionAdmission = runtime.createTotalSessionAdmissionController(
      {
        maxTotalSessions: opts.maxTotalSessions,
        getBridges: () =>
          runtimeBridges.length > 0
            ? runtimeBridges
            : bridgeRef
              ? [bridgeRef]
              : [],
      },
    );
    const sessionOwnerIndex = runtime.createWorkspaceSessionOwnerIndex();
    const workspaceRegistryForPersistence: {
      current: WorkspaceRegistry | undefined;
    } = { current: undefined };
    const isWorkspaceTrustedForPersistence = (workspace: string): boolean =>
      workspaceRegistryForPersistence.current?.getByWorkspaceCwd(workspace)
        ?.trusted ??
      (workspaceRegistryForPersistence.current === undefined &&
        workspace === boundWorkspace &&
        trustedWorkspace);
    const loadSettingsForPersistence = (workspace: string) => {
      const trusted = isWorkspaceTrustedForPersistence(workspace);
      return settingsRuntime.settings.loadSettings(workspace, {
        skipLoadEnvironment: true,
        skipWorkspaceSettings: !trusted,
        workspaceTrusted: trusted,
      });
    };
    const persistDisabledToolsFn = (
      workspace: string,
      toolName: string,
      enabled: boolean,
      assertGenerationOpen?: () => void,
    ): Promise<void> =>
      withSettingsLock(workspace, async () => {
        assertGenerationOpen?.();
        const fresh = loadSettingsForPersistence(workspace);
        const wsScope = fresh.forScope(WORKSPACE_SETTING_SCOPE).settings;
        const wsDisabled = wsScope.tools?.disabled;
        const current = Array.isArray(wsDisabled)
          ? wsDisabled.filter((v): v is string => typeof v === 'string')
          : [];
        const next = new Set(current);
        if (enabled) next.delete(toolName);
        else next.add(toolName);
        assertGenerationOpen?.();
        fresh.setValue(
          WORKSPACE_SETTING_SCOPE,
          'tools.disabled',
          [...next].sort(),
          assertGenerationOpen,
        );
      });
    const persistDisabledSkillsFn = (
      workspace: string,
      skillName: string,
      enabled: boolean,
      assertGenerationOpen?: () => void,
    ) =>
      withSettingsLock(workspace, async () => {
        assertGenerationOpen?.();
        const {
          resolveSkillSettings,
          skillSettingStrings,
          updateWorkspaceSkillSettingLists,
        } = await import('../config/skill-settings.js');
        const fresh = loadSettingsForPersistence(workspace);
        const normalizedName = skillName.trim().toLowerCase();
        const resolved = resolveSkillSettings(fresh);
        const workspaceDisabled = skillSettingStrings(
          fresh,
          WORKSPACE_SETTING_SCOPE,
          'disabled',
        );
        const workspaceEnabled = skillSettingStrings(
          fresh,
          WORKSPACE_SETTING_SCOPE,
          'enabled',
        );
        const next = updateWorkspaceSkillSettingLists(
          { disabled: workspaceDisabled, enabled: workspaceEnabled },
          skillName,
          enabled,
          resolved.defaultDisabledNames.has(normalizedName) &&
            !resolved.enabledNames.has(normalizedName),
        );
        const settingsChanges: Array<{
          key: 'skills.disabled' | 'skills.enabled';
          value: string[] | undefined;
        }> = [];
        if (
          JSON.stringify(next.disabled) !== JSON.stringify(workspaceDisabled)
        ) {
          settingsChanges.push({
            key: 'skills.disabled',
            value: next.disabled.length > 0 ? next.disabled : undefined,
          });
        }
        if (JSON.stringify(next.enabled) !== JSON.stringify(workspaceEnabled)) {
          settingsChanges.push({
            key: 'skills.enabled',
            value: next.enabled.length > 0 ? next.enabled : undefined,
          });
        }
        if (settingsChanges.length === 0) {
          return { changed: false, disabled: workspaceDisabled };
        }

        assertGenerationOpen?.();
        fresh.setValues(
          settingsChanges.map((change) => ({
            scope: WORKSPACE_SETTING_SCOPE,
            ...change,
          })),
          undefined,
          assertGenerationOpen,
        );
        return {
          changed: true,
          disabled: next.disabled,
          settingsChanges,
        };
      });
    const persistDisabledSkillsBatchFn = (
      workspace: string,
      skillNames: readonly string[],
      enabled: boolean,
      assertGenerationOpen?: () => void,
    ): Promise<PersistDisabledSkillsBatchResult> =>
      withSettingsLock(workspace, async () => {
        assertGenerationOpen?.();
        const {
          resolveSkillSettings,
          skillSettingStrings,
          updateWorkspaceSkillSettingLists,
        } = await import('../config/skill-settings.js');
        const fresh = loadSettingsForPersistence(workspace);
        const resolved = resolveSkillSettings(fresh);
        const initialDisabled = skillSettingStrings(
          fresh,
          WORKSPACE_SETTING_SCOPE,
          'disabled',
        );
        const initialEnabled = skillSettingStrings(
          fresh,
          WORKSPACE_SETTING_SCOPE,
          'enabled',
        );
        let next = { disabled: initialDisabled, enabled: initialEnabled };
        const outcomes: PersistDisabledSkillsBatchResult['outcomes'] = [];

        for (const skillName of skillNames) {
          const normalizedName = skillName.trim().toLowerCase();
          const updated = updateWorkspaceSkillSettingLists(
            next,
            skillName,
            enabled,
            resolved.defaultDisabledNames.has(normalizedName) &&
              !resolved.enabledNames.has(normalizedName),
          );
          const changed =
            JSON.stringify(updated.disabled) !==
              JSON.stringify(next.disabled) ||
            JSON.stringify(updated.enabled) !== JSON.stringify(next.enabled);
          next = updated;
          outcomes.push({ skillName, changed });
        }

        const settingsChanges: PersistDisabledSkillsBatchResult['settingsChanges'] =
          [];
        if (JSON.stringify(next.disabled) !== JSON.stringify(initialDisabled)) {
          settingsChanges.push({
            key: 'skills.disabled',
            value: next.disabled.length > 0 ? next.disabled : undefined,
          });
        }
        if (JSON.stringify(next.enabled) !== JSON.stringify(initialEnabled)) {
          settingsChanges.push({
            key: 'skills.enabled',
            value: next.enabled.length > 0 ? next.enabled : undefined,
          });
        }
        if (settingsChanges.length > 0) {
          assertGenerationOpen?.();
          fresh.setValues(
            settingsChanges.map((change) => ({
              scope: WORKSPACE_SETTING_SCOPE,
              ...change,
            })),
            undefined,
            assertGenerationOpen,
          );
        }
        return { outcomes, settingsChanges };
      });
    const persistSettingFn = (
      workspace: string,
      scope: import('../config/settings.js').SettingScope,
      key: string,
      value: unknown,
      assertGenerationOpen?: () => void,
    ) =>
      withSettingsLock(workspace, async () => {
        assertGenerationOpen?.();
        const fresh = loadSettingsForPersistence(workspace);
        assertGenerationOpen?.();
        fresh.setValue(scope, key, value, assertGenerationOpen);
        return fresh;
      });
    const persistSettingsFn = (
      workspace: string,
      writes: WorkspaceSettingsWrite[],
      assertGenerationOpen?: () => void,
    ): Promise<void> =>
      withSettingsLock(workspace, async () => {
        assertGenerationOpen?.();
        const fresh = loadSettingsForPersistence(workspace);
        const writesByScope = new Map<
          import('../config/settings.js').SettingScope,
          number
        >();
        for (const write of writes) {
          writesByScope.set(
            write.scope,
            (writesByScope.get(write.scope) ?? 0) + 1,
          );
        }
        const committedScopes = new Set<
          import('../config/settings.js').SettingScope
        >();
        let committed = 0;
        try {
          assertGenerationOpen?.();
          fresh.setValues(
            writes,
            (scope) => {
              committedScopes.add(scope);
              committed += writesByScope.get(scope) ?? 0;
            },
            assertGenerationOpen,
          );
        } catch (err) {
          const failedWrite =
            writes.find((write) => !committedScopes.has(write.scope)) ??
            writes[committed];
          const message = `persistSettings partial failure (workspace=${workspace}, committed=${committed}/${writes.length}, failedKey=${failedWrite?.key ?? '<unknown>'}, failedScope=${failedWrite?.scope ?? '<unknown>'}): ${
            err instanceof Error ? err.message : String(err)
          }`;
          writeStderrLine(`qwen serve: ${message}`);
          throw new runtime.WorkspaceSettingsPartialPersistError(
            message,
            writes.filter((write) => committedScopes.has(write.scope)),
            err,
          );
        }
      });
    // `create_sub_session` tool: spawn a fresh top-level sub-session on request
    // from a child's agent turn and (for 'first-turn') return its result.
    // Dynamic-imported (not at module scope) so the serve fast-path bundle
    // closure check doesn't trace create-sub-session's transitive deps.
    const [{ createSubSessionLauncher }, scheduledTaskRoutes] =
      await Promise.all([
        import('./create-sub-session.js'),
        import('./routes/scheduled-tasks.js'),
      ]);
    const createCurrentSessionScheduledTaskHandler =
      (
        workspaceCwd: string,
        runtimeBaseDir: string,
        getBridge: () => AcpSessionBridge | undefined,
        assertGenerationOpen: () => void,
      ): CurrentSessionScheduledTaskCreateHandler =>
      async ({
        callerSessionId,
        cron,
        prompt,
        recurring,
        assertCallerPromptActive,
      }) => {
        const targetBridge = getBridge();
        if (!targetBridge) {
          throw new Error(
            'Current-session scheduling is unavailable while the workspace runtime is starting.',
          );
        }
        const task =
          await scheduledTaskRoutes.createScheduledTaskWithExistingSession(
            {
              workspaceCwd,
              runtimeBaseDir,
              bridge: targetBridge,
              assertGenerationOpen,
              resolveLiveSessionOwner: (sessionId) =>
                workspaceRegistryForPersistence.current === undefined
                  ? { kind: 'unavailable' }
                  : workspaceRegistryForPersistence.current.resolveLiveSessionOwner(
                      sessionId,
                    ),
            },
            {
              sessionId: callerSessionId,
              cron,
              prompt,
              recurring,
            },
            { source: 'cron-tool', assertCallerPromptActive },
          );
        return { id: task.id, cron: task.cron };
      };
    // Late-binds the bridge (constructed just below) via `() => bridgeRef`. Only
    // wired on the daemon-created bridge — an injected `deps.bridge` (embed/test)
    // brings its own options.
    const subSessionLauncher = createSubSessionLauncher({
      getBridge: () => bridgeRef,
      boundWorkspace,
      ...subSessionConcurrencyCapsFromSettings(
        runtimeBootSettings?.merged.serve ?? {},
      ),
    });
    const bridge =
      deps.bridge ??
      runtime.createAcpSessionBridge({
        sessionAttachmentsRoot: sessionAttachmentsRoot(
          boundWorkspace,
          primarySessionRuntimeBaseDir,
        ),
        // Reverse tool channel: let `BridgeClient.extMethod` reach the WS
        // connection that hosts a named client MCP server (#5626).
        clientMcpSender: clientMcpSenderRegistry.lookup,
        onCreateSubSession: subSessionLauncher.launch,
        onCreateCurrentSessionScheduledTask:
          createCurrentSessionScheduledTaskHandler(
            boundWorkspace,
            primarySessionRuntimeBaseDir,
            () => bridgeRef,
            () => primaryGenerationGuard.assertOpen(),
          ),
        onChannelDelivery: createBoundChannelDeliveryHandler(
          boundWorkspace,
          () => channelWorkerManager,
          channelDeliveryAuthorizations,
          daemonLog,
          channelDeliveryDiagnosticRedaction,
        ),
        maxSessions: opts.maxSessions,
        ...(opts.restoreAskUserQuestion === true
          ? { restoreAskUserQuestion: true }
          : {}),
        freshSessionAdmission: totalSessionAdmission.admit,
        sessionLifecycle: (event) => {
          if (event.type === 'registered' && primaryGenerationGuard.closed) {
            return;
          }
          sessionOwnerIndex.handleBridgeSessionLifecycle(event);
        },
        ...(opts.maxPendingPromptsPerSession !== undefined
          ? { maxPendingPromptsPerSession: opts.maxPendingPromptsPerSession }
          : {}),
        ...(opts.eventRingSize !== undefined
          ? { eventRingSize: opts.eventRingSize }
          : {}),
        ...(opts.compactedReplayMaxBytes !== undefined
          ? { compactedReplayMaxBytes: opts.compactedReplayMaxBytes }
          : {}),
        ...(opts.maxJournalEvents !== undefined
          ? { maxJournalEvents: opts.maxJournalEvents }
          : {}),
        ...(opts.maxJournalBytes !== undefined
          ? { maxJournalBytes: opts.maxJournalBytes }
          : {}),
        ...(journalGrowthPoolBytes !== undefined
          ? {
              journalGrowthPoolBytes,
              journalGrowthSessionLimits,
              registerJournalGrowthSessionLimits,
            }
          : {}),
        ...(opts.channelIdleTimeoutMs !== undefined
          ? { channelIdleTimeoutMs: opts.channelIdleTimeoutMs }
          : {}),
        ...(opts.initializeTimeoutMs !== undefined
          ? { initializeTimeoutMs: opts.initializeTimeoutMs }
          : {}),
        sessionRestoreTimeoutMs,
        ...(opts.sessionReapIntervalMs !== undefined
          ? { sessionReapIntervalMs: opts.sessionReapIntervalMs }
          : {}),
        ...(opts.sessionIdleTimeoutMs !== undefined
          ? { sessionIdleTimeoutMs: opts.sessionIdleTimeoutMs }
          : {}),
        ...(opts.permissionResponseTimeoutMs !== undefined
          ? { permissionResponseTimeoutMs: opts.permissionResponseTimeoutMs }
          : {}),
        boundWorkspace,
        // Prompt terminal ledger: persisted beside the transcript so a
        // restarted daemon can reconcile dangling prompts on cold load.
        promptLedger: runtime.createPromptLedgerSink(
          boundWorkspace,
          primarySessionRuntimeBaseDir,
        ),
        sessionShellCommandEnabled,
        childEnvOverrides,
        channelFactory,
        externalToolGuard: daemonToolGuardHandler,
        onDiagnosticLine: diagnosticSink,
        telemetry: daemonTelemetry,
        ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
        ...(permissionConsensusQuorum !== undefined
          ? { permissionConsensusQuorum }
          : {}),
        permissionAudit: permissionAuditPublisher,
        statusProvider,
        delegateReadTextFileToClient: false,
        fileSystem: createBridgeFileSystemAdapter(fsFactory, {
          allowSameHostToolWritesOutsideWorkspace: deps.fsFactory === undefined,
        }),
        persistApprovalMode: (workspace, mode) =>
          withSettingsLock(workspace, async () => {
            primaryGenerationGuard.assertOpen();
            if (!trustedWorkspace) {
              throw new Error(
                'Cannot persist approval mode for an untrusted workspace.',
              );
            }
            const fresh = settingsRuntime.settings.loadSettings(workspace, {
              skipLoadEnvironment: true,
              workspaceTrusted: trustedWorkspace,
            });
            primaryGenerationGuard.assertOpen();
            fresh.setValue(
              WORKSPACE_SETTING_SCOPE,
              'tools.approvalMode',
              mode,
              () => primaryGenerationGuard.assertOpen(),
            );
          }),
      });
    if (!deps.bridge) {
      bridgeRef = bridge;
      internalRuntimeBridgesForCleanup.push(bridge);
    }
    runtimeBridges.push(bridge);
    let invalidatePrimaryServeFeaturesCache = () => {};
    const workspaceService = runtime.createDaemonWorkspaceService({
      boundWorkspace,
      isWorkspaceTrusted: () => trustedWorkspace,
      assertGenerationOpen: () => primaryGenerationGuard.assertOpen(),
      contextFilename: contextFilenameForInit ?? 'QWEN.md',
      statusProvider,
      workspaceProvidersStatusProvider,
      workspaceSkillsStatusProvider,
      skillInstallEnv: runtimeEffectiveEnv,
      voiceEnv: runtimeEffectiveEnv,
      isChannelLive: () => bridge.isChannelLive(),
      persistDisabledTools: persistDisabledToolsFn,
      persistDisabledSkills: persistDisabledSkillsFn,
      persistDisabledSkillsBatch: persistDisabledSkillsBatchFn,
      persistSetting: persistSettingFn,
      persistSettings: persistSettingsFn,
      preheatAcpChild: () => bridge.preheat(),
      reloadDaemonEnv: (workspace, assertGenerationOpen) =>
        withSettingsLock(workspace, async () => {
          assertGenerationOpen?.();
          const fresh = settingsRuntime.settings.loadSettings(workspace, {
            skipLoadEnvironment: true,
            skipWorkspaceSettings: !trustedWorkspace,
            workspaceTrusted: trustedWorkspace,
          });
          assertGenerationOpen?.();
          const result = settingsRuntime.settings.reloadEnvironment(
            fresh.merged,
            workspace,
            trustedWorkspace,
          );
          let refreshedRuntimeEnv: ReturnType<
            EnvironmentRuntime['buildRuntimeEnvironment']
          >;
          let fallbackReason: string | undefined;
          try {
            refreshedRuntimeEnv =
              settingsRuntime.environment.buildRuntimeEnvironment(
                fresh.merged,
                workspace,
                daemonRuntimeBaseEnv,
                trustedWorkspace,
              );
          } catch (err) {
            fallbackReason = err instanceof Error ? err.message : String(err);
            daemonLog.warn(
              'failed to rebuild runtime env snapshot after daemon env reload; preserving previous runtime env',
              {
                error: fallbackReason,
              },
            );
            refreshedRuntimeEnv = {
              effectiveEnv: { ...runtimeEffectiveEnv },
              overlayKeys: [...primaryRuntimeEnv.overlayKeys],
              envFilePaths: [...primaryRuntimeEnv.envFilePaths],
              envFileReadFailed: primaryRuntimeEnv.envFileReadFailed ?? false,
              envFileReadFailures: [
                ...(primaryRuntimeEnv.envFileReadFailures ?? []),
              ],
            };
          }
          logRuntimeEnvFileReadFailures(workspace, refreshedRuntimeEnv);
          replaceRuntimeEffectiveEnv(refreshedRuntimeEnv.effectiveEnv);
          if (fallbackReason) {
            primaryRuntimeEnv.fallbackReason = fallbackReason;
          } else {
            delete primaryRuntimeEnv.fallbackReason;
          }
          primaryRuntimeEnv.envFileReadFailed =
            refreshedRuntimeEnv.envFileReadFailed;
          primaryRuntimeEnv.envFileReadFailures.splice(
            0,
            primaryRuntimeEnv.envFileReadFailures.length,
            ...refreshedRuntimeEnv.envFileReadFailures,
          );
          primaryRuntimeEnv.overlayKeys.splice(
            0,
            primaryRuntimeEnv.overlayKeys.length,
            ...refreshedRuntimeEnv.overlayKeys,
          );
          primaryRuntimeEnv.envFilePaths.splice(
            0,
            primaryRuntimeEnv.envFilePaths.length,
            ...refreshedRuntimeEnv.envFilePaths,
          );
          return result;
        }),
      queryWorkspaceStatus: (method, idle) =>
        bridge.queryWorkspaceStatus(method, idle),
      invokeWorkspaceCommand: (method, params, invokeOpts) =>
        bridge.invokeWorkspaceCommand(method, params, invokeOpts),
      refreshExtensionsForAllSessions: () =>
        bridge.refreshExtensionsForAllSessions(),
      publishWorkspaceEvent: (event) => {
        if (
          event.type === 'settings_changed' ||
          event.type === 'settings_reloaded'
        ) {
          invalidatePrimaryServeFeaturesCache();
        }
        bridge.publishWorkspaceEvent(event);
      },
    });

    const workspaceRuntimes: WorkspaceRuntime[] = [
      {
        workspaceId: daemonWorkspaceHash,
        workspaceCwd: boundWorkspace,
        sessionRuntimeBaseDir: primarySessionRuntimeBaseDir,
        ...(workspaceInputs[0]?.displayName
          ? { displayName: workspaceInputs[0].displayName }
          : {}),
        primary: true,
        trusted: trustedWorkspace,
        removable: false,
        registrationIds: workspaceInputs[0]?.registrationIds ?? [],
        env: primaryRuntimeEnv,
        bridge,
        workspaceService,
        routeFileSystemFactory: routeFsFactory,
        clientMcpSenderRegistry,
        generationGuard: primaryGenerationGuard,
        trustMaterialization: primaryTrustMaterialization,
      },
    ];

    const createRuntimeEnvMetadata = (
      workspace: string,
      settings: ReturnType<SettingsRuntime['loadSettings']> | undefined,
      trusted: boolean,
    ): {
      metadata: {
        mode: 'runtime-overlay';
        overlayKeys: string[];
        envFilePaths: string[];
        effectiveEnv: NodeJS.ProcessEnv;
        envFileReadFailed: boolean;
        envFileReadFailures: Array<{ path: string; error: string }>;
        fallbackReason?: string;
      };
      effectiveEnv: NodeJS.ProcessEnv;
      sessionRuntimeBaseDir: string;
      replace: (nextEnv: Readonly<NodeJS.ProcessEnv>) => void;
    } => {
      const snapshot = settings
        ? settingsRuntime.environment.buildRuntimeEnvironment(
            settings.merged,
            workspace,
            daemonRuntimeBaseEnv,
            trusted,
          )
        : {
            effectiveEnv: { ...daemonRuntimeBaseEnv },
            overlayKeys: Object.freeze([] as string[]),
            envFilePaths: Object.freeze([] as string[]),
            envFileReadFailed: false,
            envFileReadFailures: Object.freeze([]),
          };
      logRuntimeEnvFileReadFailures(workspace, snapshot);
      const sessionRuntimeBaseDir = resolveSessionRuntimeBaseDir(
        workspace,
        settings,
        snapshot.effectiveEnv,
      );
      const effectiveEnv: NodeJS.ProcessEnv = {
        ...snapshot.effectiveEnv,
        QWEN_RUNTIME_DIR: sessionRuntimeBaseDir,
      };
      const metadata: {
        mode: 'runtime-overlay';
        overlayKeys: string[];
        envFilePaths: string[];
        effectiveEnv: NodeJS.ProcessEnv;
        envFileReadFailed: boolean;
        envFileReadFailures: Array<{ path: string; error: string }>;
        fallbackReason?: string;
      } = {
        mode: 'runtime-overlay',
        overlayKeys: [...snapshot.overlayKeys],
        effectiveEnv,
        envFilePaths: [...snapshot.envFilePaths],
        envFileReadFailed: snapshot.envFileReadFailed,
        envFileReadFailures: [...snapshot.envFileReadFailures],
      };
      return {
        metadata,
        effectiveEnv,
        sessionRuntimeBaseDir,
        replace(nextEnv) {
          for (const key of Object.keys(effectiveEnv)) {
            delete effectiveEnv[key];
          }
          Object.assign(effectiveEnv, nextEnv);
          effectiveEnv['QWEN_RUNTIME_DIR'] = sessionRuntimeBaseDir;
        },
      };
    };

    const readLiveConversationScheduledTasks = async () => {
      if (!fs.existsSync(liveConversationWorkspace.rootPath)) return [];
      const { canonicalRoot } = await liveConversationWorkspace.revalidate();
      let settings: ReturnType<SettingsRuntime['loadSettings']> | undefined;
      try {
        settings = settingsRuntime.settings.loadSettings(canonicalRoot, {
          skipLoadEnvironment: true,
          skipWorkspaceSettings: false,
          workspaceTrusted: true,
        });
      } catch (err) {
        writeStderrLine(
          `qwen serve: could not read full settings for Conversations ` +
            `(${err instanceof Error ? err.message : String(err)}); falling back to defaults.`,
        );
      }
      const env = createRuntimeEnvMetadata(canonicalRoot, settings, true);
      return core.Storage.runWithResolvedRuntimeBaseDir(
        env.sessionRuntimeBaseDir,
        () => core.readCronTasks(canonicalRoot),
      );
    };

    // Collects stop() callbacks from every per-workspace sub-session launcher
    // (primary + secondaries). Called during shutdown so no new sub-sessions
    // are admitted while bridges are being torn down.
    const subSessionStoppers: Array<() => void> = [];
    const subSessionStoppersByRuntime = new WeakMap<
      WorkspaceRuntime,
      () => void
    >();
    const runtimeCleanupPromises = new WeakMap<
      WorkspaceRuntime,
      Promise<void>
    >();
    const removeArrayValue = <T>(values: T[], value: T): void => {
      const index = values.indexOf(value);
      if (index >= 0) values.splice(index, 1);
    };

    for (const workspaceInput of workspaceInputs.slice(1)) {
      const secondaryDecision = trustPolicy.evaluateDaemonWorkspaceTrust(
        bootTrustSnapshot,
        workspaceInput.cwd,
      );
      const secondaryTrusted = secondaryDecision.targetTrusted;
      let secondarySettings:
        | ReturnType<SettingsRuntime['loadSettings']>
        | undefined;
      try {
        secondarySettings = settingsRuntime.settings.loadSettings(
          workspaceInput.cwd,
          {
            skipLoadEnvironment: true,
            skipWorkspaceSettings: !secondaryTrusted,
            workspaceTrusted: secondaryTrusted,
          },
        );
      } catch (err) {
        writeStderrLine(
          `qwen serve: could not read full settings for secondary workspace ` +
            `${workspaceInput.cwd} (${err instanceof Error ? err.message : String(err)}); ` +
            `falling back to defaults.`,
        );
      }
      if (!secondaryTrusted) {
        daemonLog.warn('secondary workspace is not trusted', {
          workspace: workspaceInput.cwd,
          trustSettingsAvailable: secondarySettings !== undefined,
        });
      }
      const secondaryEnv = createRuntimeEnvMetadata(
        workspaceInput.cwd,
        secondarySettings,
        secondaryTrusted,
      );
      const secondaryCustomIgnoreFiles =
        secondarySettings?.merged.context?.fileFiltering?.customIgnoreFiles;
      const secondaryContextFilename =
        extractContextFilename(secondarySettings?.merged.context?.fileName) ??
        contextFilenameForInit ??
        'QWEN.md';
      const secondaryWorkspaceHash = core.hashDaemonWorkspace(
        workspaceInput.cwd,
      );
      const secondaryGenerationGuard = runtime.createWorkspaceGenerationGuard();
      const secondaryStatusProvider = runtime.createDaemonStatusProvider({
        env: secondaryEnv.effectiveEnv,
      });
      const secondaryBridgeFsFactory = runtime.resolveBridgeFsFactory({
        boundWorkspaces: [workspaceInput.cwd],
        trusted: secondaryTrusted,
        emit: deps.fsAuditEmit,
        pathLocks: sharedPathLocks,
        generationGuard: secondaryGenerationGuard,
        ...(secondaryCustomIgnoreFiles !== undefined
          ? { customIgnoreFiles: secondaryCustomIgnoreFiles }
          : {}),
      });
      const secondaryChannelFactory = runtime.createSpawnChannelFactory({
        processRegistry,
        childHeapPolicy,
        pipeLimits: runtime.daemonAcpNdJsonLimits,
        sourceEnv: secondaryEnv.effectiveEnv,
        onDiagnosticLine: diagnosticSink,
        pipeHooks: {
          onMessageSent: (bytes) => recordPipeMessage('outbound', bytes),
          onMessageReceived: (bytes) => recordPipeMessage('inbound', bytes),
          onMessageObserved: ({ direction, bytes, message }) =>
            observeLargePipeFrame({
              direction: daemonPipeDirection(direction),
              bytes,
              message,
            }),
        },
        ...(acpChildExtraArgs(opts)
          ? { extraArgs: acpChildExtraArgs(opts) }
          : {}),
      });
      const secondaryClientMcpSenderRegistry = new ClientMcpSenderRegistry();
      // Wire sub-session support for the secondary workspace too — without
      // this, create_sub_session calls from sessions bound to a secondary
      // workspace hit methodNotFound.
      // eslint-disable-next-line prefer-const -- assigned once after bridge creation; `let` required because the launcher closure captures it before the assignment.
      let secondaryBridgeRef:
        | ReturnType<typeof runtime.createAcpSessionBridge>
        | undefined;
      const secondarySubSessionLauncher = createSubSessionLauncher({
        getBridge: () => secondaryBridgeRef,
        boundWorkspace: workspaceInput.cwd,
        ...subSessionConcurrencyCapsFromSettings(
          secondarySettings?.merged.serve ?? {},
        ),
      });
      const secondaryBridge = runtime.createAcpSessionBridge({
        sessionAttachmentsRoot: sessionAttachmentsRoot(
          workspaceInput.cwd,
          secondaryEnv.sessionRuntimeBaseDir,
        ),
        clientMcpSender: secondaryClientMcpSenderRegistry.lookup,
        onCreateSubSession: secondarySubSessionLauncher.launch,
        onCreateCurrentSessionScheduledTask:
          createCurrentSessionScheduledTaskHandler(
            workspaceInput.cwd,
            secondaryEnv.sessionRuntimeBaseDir,
            () => secondaryBridgeRef,
            () => secondaryGenerationGuard.assertOpen(),
          ),
        onChannelDelivery: createBoundChannelDeliveryHandler(
          workspaceInput.cwd,
          () => channelWorkerManager,
          channelDeliveryAuthorizations,
          daemonLog,
          channelDeliveryDiagnosticRedaction,
        ),
        maxSessions: opts.maxSessions,
        ...(opts.restoreAskUserQuestion === true
          ? { restoreAskUserQuestion: true }
          : {}),
        freshSessionAdmission: totalSessionAdmission.admit,
        sessionLifecycle: (event) => {
          if (event.type === 'registered' && secondaryGenerationGuard.closed) {
            return;
          }
          sessionOwnerIndex.handleBridgeSessionLifecycle(event);
        },
        ...(opts.maxPendingPromptsPerSession !== undefined
          ? { maxPendingPromptsPerSession: opts.maxPendingPromptsPerSession }
          : {}),
        ...(opts.eventRingSize !== undefined
          ? { eventRingSize: opts.eventRingSize }
          : {}),
        ...(opts.compactedReplayMaxBytes !== undefined
          ? { compactedReplayMaxBytes: opts.compactedReplayMaxBytes }
          : {}),
        ...(opts.maxJournalEvents !== undefined
          ? { maxJournalEvents: opts.maxJournalEvents }
          : {}),
        ...(opts.maxJournalBytes !== undefined
          ? { maxJournalBytes: opts.maxJournalBytes }
          : {}),
        ...(journalGrowthPoolBytes !== undefined
          ? {
              journalGrowthPoolBytes,
              journalGrowthSessionLimits,
              registerJournalGrowthSessionLimits,
            }
          : {}),
        ...(opts.channelIdleTimeoutMs !== undefined
          ? { channelIdleTimeoutMs: opts.channelIdleTimeoutMs }
          : {}),
        ...(opts.initializeTimeoutMs !== undefined
          ? { initializeTimeoutMs: opts.initializeTimeoutMs }
          : {}),
        sessionRestoreTimeoutMs,
        ...(opts.sessionReapIntervalMs !== undefined
          ? { sessionReapIntervalMs: opts.sessionReapIntervalMs }
          : {}),
        ...(opts.sessionIdleTimeoutMs !== undefined
          ? { sessionIdleTimeoutMs: opts.sessionIdleTimeoutMs }
          : {}),
        ...(opts.permissionResponseTimeoutMs !== undefined
          ? { permissionResponseTimeoutMs: opts.permissionResponseTimeoutMs }
          : {}),
        boundWorkspace: workspaceInput.cwd,
        promptLedger: runtime.createPromptLedgerSink(
          workspaceInput.cwd,
          secondaryEnv.sessionRuntimeBaseDir,
        ),
        sessionShellCommandEnabled,
        childEnvOverrides,
        channelFactory: secondaryChannelFactory,
        externalToolGuard: daemonToolGuardHandler,
        onDiagnosticLine: diagnosticSink,
        telemetry: createRuntimeBridgeTelemetry(secondaryWorkspaceHash),
        ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
        ...(permissionConsensusQuorum !== undefined
          ? {
              permissionConsensusQuorum,
            }
          : {}),
        permissionAudit: permissionAuditPublisher,
        statusProvider: secondaryStatusProvider,
        delegateReadTextFileToClient: false,
        fileSystem: createBridgeFileSystemAdapter(secondaryBridgeFsFactory, {
          allowSameHostToolWritesOutsideWorkspace: true,
        }),
        persistApprovalMode: (workspace, mode) =>
          withSettingsLock(workspace, async () => {
            secondaryGenerationGuard.assertOpen();
            if (!secondaryTrusted) {
              throw new Error(
                'Cannot persist approval mode for an untrusted workspace.',
              );
            }
            const fresh = settingsRuntime.settings.loadSettings(workspace, {
              skipLoadEnvironment: true,
              workspaceTrusted: secondaryTrusted,
            });
            secondaryGenerationGuard.assertOpen();
            fresh.setValue(
              WORKSPACE_SETTING_SCOPE,
              'tools.approvalMode',
              mode,
              () => secondaryGenerationGuard.assertOpen(),
            );
          }),
      });
      secondaryBridgeRef = secondaryBridge;
      runtimeBridges.push(secondaryBridge);
      internalRuntimeBridgesForCleanup.push(secondaryBridge);
      subSessionStoppers.push(secondarySubSessionLauncher.stop);
      const secondaryWorkspaceService = runtime.createDaemonWorkspaceService({
        boundWorkspace: workspaceInput.cwd,
        isWorkspaceTrusted: () => secondaryTrusted,
        assertGenerationOpen: () => secondaryGenerationGuard.assertOpen(),
        contextFilename: secondaryContextFilename,
        statusProvider: secondaryStatusProvider,
        workspaceProvidersStatusProvider:
          runtime.createWorkspaceProvidersStatusProvider({
            env: secondaryEnv.effectiveEnv,
            workspaceTrusted: secondaryTrusted,
          }),
        workspaceSkillsStatusProvider:
          runtime.createWorkspaceSkillsStatusProvider({
            workspaceTrusted: secondaryTrusted,
          }),
        skillInstallEnv: secondaryEnv.effectiveEnv,
        voiceEnv: secondaryEnv.effectiveEnv,
        voiceSettingsScope: WORKSPACE_SETTING_SCOPE,
        isChannelLive: () => secondaryBridge.isChannelLive(),
        preheatAcpChild: () => secondaryBridge.preheat(),
        persistDisabledTools: persistDisabledToolsFn,
        persistDisabledSkills: persistDisabledSkillsFn,
        persistDisabledSkillsBatch: persistDisabledSkillsBatchFn,
        persistSetting: persistSettingFn,
        persistSettings: persistSettingsFn,
        reloadDaemonEnv: (workspace, assertGenerationOpen) =>
          withSettingsLock(workspace, async () => {
            assertGenerationOpen?.();
            const fresh = settingsRuntime.settings.loadSettings(workspace, {
              skipLoadEnvironment: true,
              skipWorkspaceSettings: !secondaryTrusted,
              workspaceTrusted: secondaryTrusted,
            });
            assertGenerationOpen?.();
            const result = settingsRuntime.settings.reloadEnvironment(
              fresh.merged,
              workspace,
              secondaryTrusted,
            );
            try {
              const refreshedRuntimeEnv =
                settingsRuntime.environment.buildRuntimeEnvironment(
                  fresh.merged,
                  workspace,
                  daemonRuntimeBaseEnv,
                  secondaryTrusted,
                );
              logRuntimeEnvFileReadFailures(workspace, refreshedRuntimeEnv);
              secondaryEnv.replace(refreshedRuntimeEnv.effectiveEnv);
              secondaryEnv.metadata.envFileReadFailed =
                refreshedRuntimeEnv.envFileReadFailed;
              secondaryEnv.metadata.envFileReadFailures.splice(
                0,
                secondaryEnv.metadata.envFileReadFailures.length,
                ...refreshedRuntimeEnv.envFileReadFailures,
              );
              secondaryEnv.metadata.overlayKeys.splice(
                0,
                secondaryEnv.metadata.overlayKeys.length,
                ...refreshedRuntimeEnv.overlayKeys,
              );
              secondaryEnv.metadata.envFilePaths.splice(
                0,
                secondaryEnv.metadata.envFilePaths.length,
                ...refreshedRuntimeEnv.envFilePaths,
              );
              delete secondaryEnv.metadata.fallbackReason;
            } catch (err) {
              secondaryEnv.metadata.fallbackReason =
                err instanceof Error ? err.message : String(err);
              daemonLog.warn(
                'failed to rebuild secondary runtime env snapshot after daemon env reload; preserving previous runtime env',
                {
                  workspace,
                  error: secondaryEnv.metadata.fallbackReason,
                },
              );
            }
            return result;
          }),
        queryWorkspaceStatus: (method, idle) =>
          secondaryBridge.queryWorkspaceStatus(method, idle),
        invokeWorkspaceCommand: (method, params, invokeOpts) =>
          secondaryBridge.invokeWorkspaceCommand(method, params, invokeOpts),
        refreshExtensionsForAllSessions: () =>
          secondaryBridge.refreshExtensionsForAllSessions(),
        publishWorkspaceEvent: (event) =>
          secondaryBridge.publishWorkspaceEvent(event),
      });
      const secondaryRuntime: WorkspaceRuntime = {
        workspaceId: secondaryWorkspaceHash,
        workspaceCwd: workspaceInput.cwd,
        sessionRuntimeBaseDir: secondaryEnv.sessionRuntimeBaseDir,
        ...(workspaceInput.displayName
          ? { displayName: workspaceInput.displayName }
          : {}),
        primary: false,
        trusted: secondaryTrusted,
        removable: workspaceInput.removable,
        registrationIds: workspaceInput.registrationIds,
        env: secondaryEnv.metadata,
        bridge: secondaryBridge,
        workspaceService: secondaryWorkspaceService,
        routeFileSystemFactory: secondaryBridgeFsFactory,
        clientMcpSenderRegistry: secondaryClientMcpSenderRegistry,
        generationGuard: secondaryGenerationGuard,
        trustMaterialization: JSON.stringify({
          trusted: secondaryTrusted,
          boundWorkspaces: [workspaceInput.cwd],
        }),
      };
      subSessionStoppersByRuntime.set(
        secondaryRuntime,
        secondarySubSessionLauncher.stop,
      );
      workspaceRuntimes.push(secondaryRuntime);
    }

    const workspaceRegistry: WorkspaceRegistry =
      runtime.createWorkspaceRegistry(workspaceRuntimes, {
        sessionOwnerIndex,
        scanUnindexedOwners: deps.bridge !== undefined,
      });
    workspaceRegistryForPersistence.current = workspaceRegistry;
    const workspaceVoiceCoordinator = new WorkspaceVoiceCoordinator();

    core.registerDaemonGaugeCallbacks({
      sessionCount: () =>
        workspaceRegistry
          .listAll()
          .reduce((sum, item) => sum + item.bridge.sessionCount, 0),
      sseCount: () => runtime.getActiveSseCount(),
      heapUsed: () => process.memoryUsage().heapUsed,
    });

    // Start the metrics-ring sampler now that `bridge` exists: seal a bucket
    // every DAEMON_METRICS_SAMPLE_MS, reading memory / active sessions+prompts
    // and a window-scoped event-loop lag p99 (its own histogram, reset each
    // seal so the charted lag is per-interval, not the since-start average the
    // shared monitor reports). `unref()` so sampling never keeps the process
    // alive; torn down by `disposeDaemonEventLoopMonitor`.
    // Retire any prior sampler before building a new one so a runtime rebuild
    // (buildRuntime re-entry) can't leak the old interval + histogram —
    // symmetric with the `daemonEventLoopMonitor?.dispose()` above.
    daemonMetricsSampler?.dispose();
    const metricsLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    metricsLoopDelay.enable();
    // Delta state for the cumulative counters. CPU% = delta CPU-µs over delta
    // wall-ms, normalized by core count (same formula as memoryPressureMonitor);
    // clamped to [0,100] to absorb non-monotonic cpuUsage on some VMs and
    // CPU-bursting. Rate-limit rejects are diffed against the prior total.
    const cpuCoreCount = os.availableParallelism?.() ?? os.cpus().length ?? 1;
    let prevCpu = safeCpuUsage();
    let prevCpuAt = Date.now();
    // undefined until the first tick sets the baseline, so the first sealed
    // window reports 0 rejects instead of the entire since-start backlog as a
    // y-axis-flattening spike.
    let prevRateRejected: number | undefined;
    const metricsSamplerTimer = setInterval(() => {
      const nowMs = Date.now();
      // Read the window lag BEFORE the try: a tick that throws is exactly when
      // the daemon is overloaded and lag is most diagnostic, so the catch path
      // must chart the real accumulated lag, not a misleading 0.
      const eventLoopLagP99Ms = metricsLoopDelay.percentile(99) / 1_000_000;
      try {
        const mem = process.memoryUsage();
        // CPU%: computeCpuPercent returns 0 (and we leave the baseline
        // untouched) when cpuUsage() throws, so a transient failure can't turn
        // the next successful read's since-start total into one giant spike.
        const cpu = safeCpuUsage();
        const cpuPercent = computeCpuPercent(
          prevCpu,
          cpu,
          nowMs - prevCpuAt,
          cpuCoreCount,
        );
        if (cpu) {
          prevCpu = cpu;
          prevCpuAt = nowMs;
        }
        // Connections + rate limiter live on `app` (the createServeApp const
        // just below); read lazily — the first tick is ≥5s out, so the forward
        // reference is assigned by call time. Guard with `?.` (ACP HTTP and the
        // limiter are both toggleable).
        const acp = (
          app.locals?.['acpHandle'] as AcpHttpHandle | undefined
        )?.getSnapshot();
        const hits = getRateLimiter(app)?.getHitCounts();
        const rejectedTotal = hits
          ? hits.prompt + hits.mutation + hits.read
          : 0;
        const rateLimitRejected =
          prevRateRejected === undefined
            ? 0
            : Math.max(0, rejectedTotal - prevRateRejected);
        prevRateRejected = rejectedTotal;
        // ACP child resource: read this tick's cached snapshot synchronously
        // and kick an async refresh for the next tick, keeping the sampler
        // sync. Optional-chained: an injected bridge (RunQwenServeDeps.bridge)
        // built against the older contract may not implement these hooks.
        const primaryEntry = workspaceRegistry.primaryEntry;
        const primaryRuntimeBridge =
          primaryEntry.state === 'active'
            ? primaryEntry.current?.runtime.bridge
            : undefined;
        // The ring's `childRssBytes` gauge stays the PRIMARY child's reading —
        // its published meaning is "ACP child process RSS", singular. The
        // aggregate across every workspace is reported separately, under
        // `runtime.memory.children` in daemon status.
        const child = primaryRuntimeBridge?.getChildResourceSnapshot?.();
        // Only poll the child's resources when someone is watching: the
        // staleness guard already drops the reading to 0 when idle, so gating
        // avoids a 5s RPC round-trip (pipe + child CPU) for a chart nobody has
        // open.
        if (runtime.getActiveSseCount() > 0 || (acp?.wsStreams ?? 0) > 0) {
          // Refresh EVERY managed workspace, not just the primary: the caches
          // this warms are what `runtime.memory.children` sums, and a child
          // nobody refreshed reads as unmeasured there. No `isChannelLive`
          // filter is needed — `refreshChildResource` already no-ops without a
          // live channel — and no concurrency limit is added, because the call
          // is single-flight per bridge and the number of bridges is capped by
          // MAX_DAEMON_WORKSPACES.
          for (const managed of workspaceRegistry.listManaged()) {
            // The shipped bridge's `refreshChildResource` never rejects: it
            // catches the RPC failure itself, keeps the last good cache, and
            // tees the reason to the serve debug log — which is why this
            // handler has never fired and why the fan-out cannot turn it into
            // 25 warnings a tick. It stays as a backstop rather than being
            // deleted, because the method is an optional interface member and
            // an `async` one, so any other implementation throwing before its
            // own try block would surface here as an unhandled rejection and
            // take the daemon down.
            //
            // Carrying the workspace matters for exactly that case: an
            // unattributable warning repeated across a 25-workspace fan-out is
            // the shape that is impossible to act on.
            void managed.bridge.refreshChildResource?.().catch((err) => {
              daemonLog.warn('ACP child resource refresh failed', {
                workspaceId: managed.workspaceId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        }
        metricsRing.sample(nowMs, {
          cpuPercent,
          rssBytes: mem.rss,
          heapUsedBytes: mem.heapUsed,
          activeSessions: workspaceRegistry
            .listAll()
            .reduce((sum, item) => sum + item.bridge.sessionCount, 0),
          activePrompts: workspaceRegistry
            .listAll()
            .reduce(
              (sum, item) => sum + (item.bridge.activePromptCount ?? 0),
              0,
            ),
          queuedPrompts: workspaceRegistry
            .listAll()
            .reduce(
              (sum, item) => sum + (item.bridge.pendingPromptTotal ?? 0),
              0,
            ),
          eventLoopLagP99Ms,
          sseConnections: runtime.getActiveSseCount(),
          wsConnections: acp?.wsStreams ?? 0,
          acpConnections: acp?.connectionCount ?? 0,
          rateLimitRejected,
          childCpuPercent: child?.cpuPercent ?? 0,
          childRssBytes: child?.rssBytes ?? 0,
        });
      } catch (err) {
        // A gauge getter threw (e.g. process.memoryUsage() in a restricted
        // container, or a bridge getter mid-teardown). Never let it surface as
        // an uncaughtException that takes down the daemon; seal a zeroed bucket
        // so the timeline stays contiguous rather than silently gapping.
        daemonLog.warn(
          `metrics sampler tick failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        try {
          metricsRing.sample(nowMs, {
            cpuPercent: 0,
            rssBytes: 0,
            heapUsedBytes: 0,
            activeSessions: 0,
            activePrompts: 0,
            queuedPrompts: 0,
            eventLoopLagP99Ms,
            sseConnections: 0,
            wsConnections: 0,
            acpConnections: 0,
            rateLimitRejected: 0,
            childCpuPercent: 0,
            childRssBytes: 0,
          });
        } catch {
          // The ring is pure data; a throw here is unexpected, but never let
          // the fallback path crash the timer either.
        }
      } finally {
        // Reset the window histogram AFTER sampling (or after a failed tick) so
        // a thrown tick can't permanently discard event-loop lag — which would
        // otherwise leave the chart reading a healthy 0ms while the daemon was
        // actually stalling.
        metricsLoopDelay.reset();
      }
    }, DAEMON_METRICS_SAMPLE_MS);
    metricsSamplerTimer.unref();
    daemonMetricsSampler = {
      dispose(): void {
        clearInterval(metricsSamplerTimer);
        metricsLoopDelay.disable();
      },
    };

    // Same lifecycle as the metrics sampler above: retire any prior timer
    // before starting a new one (buildRuntime re-entry), unref'd inside.
    // Dynamic import on purpose: session-pr-refresh statically pulls the
    // SessionService chain (glob et al.), which the serve fast-path bundle
    // closure check forbids in this pre-listen root's static closure.
    sessionPrRefreshTimer?.dispose();
    const refreshGeneration = ++sessionPrRefreshGeneration;
    void import('./server/session-pr-refresh.js')
      .then((mod) => {
        if (refreshGeneration !== sessionPrRefreshGeneration) return;
        sessionPrRefreshTimer = mod.startSessionPrRefreshTimer({
          workspaceRegistry,
          // The coordinator lives on the serve app (createServeApp below),
          // which is built after this timer starts; read it per tick like
          // the metrics sampler reads `acpHandle`.
          getArchiveCoordinator: () =>
            (
              app.locals as {
                sessionArchiveCoordinator?: SessionArchiveCoordinator;
              }
            ).sessionArchiveCoordinator,
        });
      })
      .catch((error) => {
        // Degrade to "no PR-state sweep" instead of leaking an unhandled
        // rejection: the serve fast path installs no process-level
        // unhandledRejection handler before this runs, and Node's default
        // for one is to exit — a failed chunk load (e.g. an in-place
        // upgrade replacing dist/ under the running daemon) would take
        // down every runtime, session, and connection the daemon serves.
        daemonLog.warn(
          `session-pr-refresh load failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });

    // Factory for dynamically creating workspace runtimes (POST /workspaces).
    interface WorkspaceRuntimeBuildOptions {
      readonly provenance?: WorkspaceRuntimeProvenance;
      readonly trusted?: boolean;
      readonly snapshot?: DaemonTrustPolicySnapshot;
      readonly decision?: DaemonWorkspaceTrustDecision;
      readonly generationGuard?: WorkspaceGenerationGuard;
      readonly primary?: boolean;
      readonly removable?: boolean;
      readonly displayName?: string;
      readonly registrationIds?: readonly string[];
      readonly boundWorkspaces?: readonly string[];
      readonly trustMaterialization?: string;
      readonly validationAttempt?: number;
    }
    const createDynamicWorkspaceRuntime = async (
      cwd: string,
      buildOptions?: WorkspaceRuntimeBuildOptions,
    ): Promise<import('./workspace-registry.js').WorkspaceRuntime> => {
      const provenance = buildOptions?.provenance ?? 'existing';
      // HTTP clients cannot choose provenance. This second boundary prevents a
      // future caller from granting managed trust to an arbitrary directory.
      if (
        provenance === 'managed-scratch' &&
        (!managedScratchRoot ||
          !isManagedScratchChild(cwd, managedScratchRoot.canonicalRoot))
      ) {
        throw new Error(
          'Managed scratch runtime must use an accepted direct child directory',
        );
      }
      if (provenance === 'live-conversation') {
        await liveConversationWorkspace.assertExactRoot(cwd);
      }
      const snapshot =
        buildOptions?.snapshot ??
        (await trustPolicy.readDaemonTrustPolicySnapshot());
      const decision =
        buildOptions?.decision ??
        trustPolicy.evaluateDaemonWorkspaceTrust(snapshot, cwd);
      const trusted =
        provenance === 'managed-scratch' || provenance === 'live-conversation'
          ? true
          : (buildOptions?.trusted ?? decision.targetTrusted);
      let wsSettings: ReturnType<SettingsRuntime['loadSettings']> | undefined;
      try {
        wsSettings = settingsRuntime.settings.loadSettings(cwd, {
          skipLoadEnvironment: true,
          skipWorkspaceSettings: !trusted,
          workspaceTrusted: trusted,
        });
      } catch (err) {
        // Match the startup secondary-workspace path: surface why full settings
        // couldn't be read instead of silently falling back to defaults.
        writeStderrLine(
          `qwen serve: could not read full settings for dynamic workspace ` +
            `${cwd} (${err instanceof Error ? err.message : String(err)}); ` +
            `falling back to defaults.`,
        );
      }
      const wsEnv = createRuntimeEnvMetadata(cwd, wsSettings, trusted);
      const wsCustomIgnoreFiles =
        wsSettings?.merged.context?.fileFiltering?.customIgnoreFiles;
      const wsContextFilename =
        extractContextFilename(wsSettings?.merged.context?.fileName) ??
        contextFilenameForInit ??
        'QWEN.md';
      const wsHash = core.hashDaemonWorkspace(cwd);
      const generationGuard =
        buildOptions?.generationGuard ??
        runtime.createWorkspaceGenerationGuard();
      const runtimeBoundWorkspaces = buildOptions?.boundWorkspaces ?? [cwd];
      const wsFsFactory = runtime.resolveBridgeFsFactory({
        boundWorkspaces: runtimeBoundWorkspaces,
        trusted,
        emit: deps.fsAuditEmit,
        pathLocks: sharedPathLocks,
        generationGuard,
        ...(wsCustomIgnoreFiles !== undefined
          ? { customIgnoreFiles: wsCustomIgnoreFiles }
          : {}),
      });
      const wsRouteFsFactory =
        buildOptions?.primary === true && runtimeBoundWorkspaces.length > 1
          ? runtime.resolveBridgeFsFactory({
              boundWorkspaces: [cwd],
              trusted,
              emit: deps.fsAuditEmit,
              pathLocks: sharedPathLocks,
              generationGuard,
              ...(wsCustomIgnoreFiles !== undefined
                ? { customIgnoreFiles: wsCustomIgnoreFiles }
                : {}),
            })
          : wsFsFactory;
      const wsChannelFactory = runtime.createSpawnChannelFactory({
        processRegistry,
        childHeapPolicy,
        pipeLimits: runtime.daemonAcpNdJsonLimits,
        sourceEnv: wsEnv.effectiveEnv,
        onDiagnosticLine: diagnosticSink,
        pipeHooks: {
          onMessageSent: (bytes) => recordPipeMessage('outbound', bytes),
          onMessageReceived: (bytes) => recordPipeMessage('inbound', bytes),
          onMessageObserved: ({ direction, bytes, message }) =>
            observeLargePipeFrame({
              direction: daemonPipeDirection(direction),
              bytes,
              message,
            }),
        },
        ...(acpChildExtraArgs(opts)
          ? { extraArgs: acpChildExtraArgs(opts) }
          : {}),
      });
      const wsClientMcpRegistry = new ClientMcpSenderRegistry();
      // eslint-disable-next-line prefer-const
      let wsBridgeRef:
        | ReturnType<typeof runtime.createAcpSessionBridge>
        | undefined;
      const wsSubSessionLauncher = createSubSessionLauncher({
        getBridge: () => wsBridgeRef,
        boundWorkspace: cwd,
        ...(provenance === 'live-conversation'
          ? {
              notifySentCompletion: true,
              getStandaloneSessionService: () =>
                (runtimeApp ?? runtimeAppForCleanup)?.locals?.[
                  'standaloneSessionService'
                ],
              isolatedWorkspace: {
                materializeDirectory: (sessionId: string) =>
                  liveConversationWorkspace.materializeConversationDirectory(
                    sessionId,
                  ),
                discardEmptyDirectory: (sessionId: string) =>
                  liveConversationWorkspace.discardEmptyConversationDirectory(
                    sessionId,
                  ),
              },
            }
          : {}),
        ...subSessionConcurrencyCapsFromSettings(
          wsSettings?.merged.serve ?? {},
        ),
      });
      let wsBridge: ReturnType<typeof runtime.createAcpSessionBridge>;
      try {
        wsBridge = runtime.createAcpSessionBridge({
          sessionAttachmentsRoot: sessionAttachmentsRoot(
            cwd,
            wsEnv.sessionRuntimeBaseDir,
          ),
          clientMcpSender: wsClientMcpRegistry.lookup,
          onCreateSubSession: wsSubSessionLauncher.launch,
          onCreateCurrentSessionScheduledTask:
            createCurrentSessionScheduledTaskHandler(
              cwd,
              wsEnv.sessionRuntimeBaseDir,
              () => wsBridgeRef,
              () => generationGuard.assertOpen(),
            ),
          onChannelDelivery: createBoundChannelDeliveryHandler(
            cwd,
            () => channelWorkerManager,
            channelDeliveryAuthorizations,
            daemonLog,
            channelDeliveryDiagnosticRedaction,
          ),
          maxSessions: opts.maxSessions,
          ...(opts.restoreAskUserQuestion === true
            ? { restoreAskUserQuestion: true }
            : {}),
          freshSessionAdmission: totalSessionAdmission.admit,
          sessionLifecycle: (event) => {
            if (event.type === 'registered' && generationGuard.closed) return;
            sessionOwnerIndex.handleBridgeSessionLifecycle(event);
          },
          ...(opts.maxPendingPromptsPerSession !== undefined
            ? { maxPendingPromptsPerSession: opts.maxPendingPromptsPerSession }
            : {}),
          ...(opts.eventRingSize !== undefined
            ? { eventRingSize: opts.eventRingSize }
            : {}),
          ...(opts.compactedReplayMaxBytes !== undefined
            ? { compactedReplayMaxBytes: opts.compactedReplayMaxBytes }
            : {}),
          ...(opts.maxJournalEvents !== undefined
            ? { maxJournalEvents: opts.maxJournalEvents }
            : {}),
          ...(opts.maxJournalBytes !== undefined
            ? { maxJournalBytes: opts.maxJournalBytes }
            : {}),
          ...(journalGrowthPoolBytes !== undefined
            ? {
                journalGrowthPoolBytes,
                journalGrowthSessionLimits,
                registerJournalGrowthSessionLimits,
              }
            : {}),
          ...(opts.channelIdleTimeoutMs !== undefined
            ? { channelIdleTimeoutMs: opts.channelIdleTimeoutMs }
            : {}),
          ...(opts.initializeTimeoutMs !== undefined
            ? { initializeTimeoutMs: opts.initializeTimeoutMs }
            : {}),
          sessionRestoreTimeoutMs,
          ...(opts.sessionReapIntervalMs !== undefined
            ? { sessionReapIntervalMs: opts.sessionReapIntervalMs }
            : {}),
          ...(opts.sessionIdleTimeoutMs !== undefined
            ? { sessionIdleTimeoutMs: opts.sessionIdleTimeoutMs }
            : {}),
          ...(opts.permissionResponseTimeoutMs !== undefined
            ? { permissionResponseTimeoutMs: opts.permissionResponseTimeoutMs }
            : {}),
          boundWorkspace: cwd,
          // Live-conversation workspaces keep transcripts outside the
          // runtime storage layout, so no ledger sink is wired there.
          ...(provenance === 'live-conversation'
            ? {}
            : {
                promptLedger: runtime.createPromptLedgerSink(
                  cwd,
                  wsEnv.sessionRuntimeBaseDir,
                ),
              }),
          sessionShellCommandEnabled,
          childEnvOverrides,
          channelFactory: wsChannelFactory,
          externalToolGuard: daemonToolGuardHandler,
          onDiagnosticLine: diagnosticSink,
          telemetry: createRuntimeBridgeTelemetry(wsHash),
          ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
          ...(permissionConsensusQuorum !== undefined
            ? {
                permissionConsensusQuorum,
              }
            : {}),
          permissionAudit: permissionAuditPublisher,
          statusProvider: runtime.createDaemonStatusProvider({
            env: wsEnv.effectiveEnv,
          }),
          delegateReadTextFileToClient: false,
          fileSystem: createBridgeFileSystemAdapter(wsFsFactory, {
            allowSameHostToolWritesOutsideWorkspace: true,
          }),
          persistApprovalMode: (workspace, mode) =>
            withSettingsLock(workspace, async () => {
              generationGuard.assertOpen();
              if (!trusted) {
                throw new Error(
                  'Cannot persist approval mode for an untrusted workspace.',
                );
              }
              const fresh = settingsRuntime.settings.loadSettings(workspace, {
                skipLoadEnvironment: true,
                workspaceTrusted: trusted,
              });
              generationGuard.assertOpen();
              fresh.setValue(
                WORKSPACE_SETTING_SCOPE,
                'tools.approvalMode',
                mode,
                () => generationGuard.assertOpen(),
              );
            }),
        });
      } catch (err) {
        wsSubSessionLauncher.stop();
        throw err;
      }
      wsBridgeRef = wsBridge;
      let wsService: ReturnType<typeof runtime.createDaemonWorkspaceService>;
      try {
        wsService = runtime.createDaemonWorkspaceService({
          boundWorkspace: cwd,
          isWorkspaceTrusted: () => trusted,
          assertGenerationOpen: () => generationGuard.assertOpen(),
          contextFilename: wsContextFilename,
          statusProvider: runtime.createDaemonStatusProvider({
            env: wsEnv.effectiveEnv,
          }),
          workspaceProvidersStatusProvider:
            runtime.createWorkspaceProvidersStatusProvider({
              env: wsEnv.effectiveEnv,
              workspaceTrusted: trusted,
            }),
          workspaceSkillsStatusProvider:
            runtime.createWorkspaceSkillsStatusProvider({
              workspaceTrusted: trusted,
            }),
          skillInstallEnv: wsEnv.effectiveEnv,
          voiceEnv: wsEnv.effectiveEnv,
          ...(buildOptions?.primary === true
            ? {}
            : { voiceSettingsScope: WORKSPACE_SETTING_SCOPE }),
          isChannelLive: () => wsBridge.isChannelLive(),
          preheatAcpChild: () => wsBridge.preheat(),
          persistDisabledTools: persistDisabledToolsFn,
          persistDisabledSkills: persistDisabledSkillsFn,
          persistDisabledSkillsBatch: persistDisabledSkillsBatchFn,
          persistSetting: persistSettingFn,
          persistSettings: persistSettingsFn,
          reloadDaemonEnv: (workspace, assertGenerationOpen) =>
            withSettingsLock(workspace, async () => {
              assertGenerationOpen?.();
              const fresh = settingsRuntime.settings.loadSettings(workspace, {
                skipLoadEnvironment: true,
                skipWorkspaceSettings: !trusted,
                workspaceTrusted: trusted,
              });
              assertGenerationOpen?.();
              const result = settingsRuntime.settings.reloadEnvironment(
                fresh.merged,
                workspace,
                trusted,
              );
              // Mirror the startup secondary-workspace path: rebuild the runtime
              // env snapshot and update the metadata so `.env` changes actually
              // propagate to child processes spawned by this workspace's bridge.
              try {
                const refreshedRuntimeEnv =
                  settingsRuntime.environment.buildRuntimeEnvironment(
                    fresh.merged,
                    workspace,
                    daemonRuntimeBaseEnv,
                    trusted,
                  );
                logRuntimeEnvFileReadFailures(workspace, refreshedRuntimeEnv);
                wsEnv.replace(refreshedRuntimeEnv.effectiveEnv);
                wsEnv.metadata.envFileReadFailed =
                  refreshedRuntimeEnv.envFileReadFailed;
                wsEnv.metadata.envFileReadFailures.splice(
                  0,
                  wsEnv.metadata.envFileReadFailures.length,
                  ...refreshedRuntimeEnv.envFileReadFailures,
                );
                wsEnv.metadata.overlayKeys.splice(
                  0,
                  wsEnv.metadata.overlayKeys.length,
                  ...refreshedRuntimeEnv.overlayKeys,
                );
                wsEnv.metadata.envFilePaths.splice(
                  0,
                  wsEnv.metadata.envFilePaths.length,
                  ...refreshedRuntimeEnv.envFilePaths,
                );
                delete wsEnv.metadata.fallbackReason;
              } catch (err) {
                wsEnv.metadata.fallbackReason =
                  err instanceof Error ? err.message : String(err);
                daemonLog.warn(
                  'failed to rebuild dynamic runtime env snapshot after daemon env reload; preserving previous runtime env',
                  {
                    workspace,
                    error: wsEnv.metadata.fallbackReason,
                  },
                );
              }
              return result;
            }),
          queryWorkspaceStatus: (method, idle) =>
            wsBridge.queryWorkspaceStatus(method, idle),
          invokeWorkspaceCommand: (method, params, invokeOpts) =>
            wsBridge.invokeWorkspaceCommand(method, params, invokeOpts),
          refreshExtensionsForAllSessions: () =>
            wsBridge.refreshExtensionsForAllSessions(),
          publishWorkspaceEvent: (event) => {
            if (
              buildOptions?.primary === true &&
              (event.type === 'settings_changed' ||
                event.type === 'settings_reloaded')
            ) {
              invalidatePrimaryServeFeaturesCache();
            }
            wsBridge.publishWorkspaceEvent(event);
          },
        });
      } catch (err) {
        wsSubSessionLauncher.stop();
        await wsBridge.shutdown().catch(() => {
          try {
            wsBridge.killAllSync();
          } catch {
            // Preserve the workspace-service construction error.
          }
        });
        throw err;
      }
      // Register shared-array cleanup only after the runtime is fully built, so
      // a throw during createDaemonWorkspaceService (or any later step) can't
      // leave an orphaned bridge/channel in the shutdown arrays.
      runtimeBridges.push(wsBridge);
      internalRuntimeBridgesForCleanup.push(wsBridge);
      subSessionStoppers.push(wsSubSessionLauncher.stop);
      const wsRuntime: WorkspaceRuntime = {
        workspaceId: wsHash,
        workspaceCwd: cwd,
        sessionRuntimeBaseDir: wsEnv.sessionRuntimeBaseDir,
        ...(buildOptions?.displayName !== undefined
          ? { displayName: buildOptions.displayName }
          : provenance === 'live-conversation'
            ? { displayName: 'Conversations' }
            : {}),
        primary: buildOptions?.primary ?? false,
        trusted,
        provenance,
        removable:
          buildOptions?.removable ?? provenance !== 'live-conversation',
        registrationIds: [...(buildOptions?.registrationIds ?? [])],
        env: wsEnv.metadata,
        bridge: wsBridge,
        workspaceService: wsService,
        routeFileSystemFactory: wsRouteFsFactory,
        clientMcpSenderRegistry: wsClientMcpRegistry,
        generationGuard,
        trustMaterialization:
          buildOptions?.trustMaterialization ??
          JSON.stringify({
            trusted,
            boundWorkspaces: [...runtimeBoundWorkspaces].sort(),
          }),
      };
      subSessionStoppersByRuntime.set(wsRuntime, wsSubSessionLauncher.stop);
      if (provenance === 'existing' && !buildOptions?.snapshot) {
        const latest = await trustPolicy.readDaemonTrustPolicySnapshot();
        if (latest.revision !== snapshot.revision) {
          generationGuard.close();
          wsSubSessionLauncher.stop();
          await wsBridge
            .shutdown({ reason: 'trust_reconfigured' })
            .catch(() => {
              try {
                wsBridge.killAllSync();
              } catch {
                // Continue removing the stale unpublished runtime.
              }
            });
          subSessionStoppersByRuntime.delete(wsRuntime);
          removeArrayValue(subSessionStoppers, wsSubSessionLauncher.stop);
          removeArrayValue(runtimeBridges, wsBridge);
          removeArrayValue(internalRuntimeBridgesForCleanup, wsBridge);
          if ((buildOptions?.validationAttempt ?? 0) >= 2) {
            throw new Error(
              'Workspace trust policy kept changing during runtime creation.',
            );
          }
          const { generationGuard: _staleGuard, ...retryOptions } =
            buildOptions ?? {};
          return createDynamicWorkspaceRuntime(cwd, {
            ...retryOptions,
            validationAttempt: (buildOptions?.validationAttempt ?? 0) + 1,
          });
        }
      }
      return wsRuntime;
    };

    const serveAppForRuntimeLifecycle: {
      current: Application | undefined;
    } = { current: undefined };
    const workspaceRuntimeRemoval = {
      async runtimeAdded(runtimeAdded: WorkspaceRuntime): Promise<void> {
        const app =
          serveAppForRuntimeLifecycle.current ??
          runtimeApp ??
          runtimeAppForCleanup;
        const startScheduledTaskKeepaliveForWorkspace = app?.locals?.[
          'startScheduledTaskKeepaliveForWorkspace'
        ] as ((runtime: WorkspaceRuntime) => void) | undefined;
        startScheduledTaskKeepaliveForWorkspace?.(runtimeAdded);
        if (runtimeAdded.provenance === 'live-conversation') return;
        channelWebhookEnvByWorkspace.set(
          runtimeAdded.workspaceCwd,
          workspaceRuntimeEffectiveEnv(runtimeAdded, daemonRuntimeBaseEnv),
        );
        channelWebhookConfigVersion += 1;
        refreshChannelWebhookConfigs?.();
        if (!channelWorkerManager) return;
        try {
          if (runtimeAdded.trusted) {
            await channelWorkerManager.restoreWorkspace(
              runtimeAdded.workspaceCwd,
            );
          }
          await channelWorkerManager.refreshWorkspaces();
        } catch (err) {
          daemonLog.error(
            'workspace channel worker startup error',
            err instanceof Error ? err : null,
          );
        } finally {
          writeChannelWorkerPidfile();
        }
      },
      beginDrain(runtimeToDrain: WorkspaceRuntime): void {
        if (runtimeToDrain.primary) {
          if (bridgeRef === runtimeToDrain.bridge) bridgeRef = undefined;
          invalidatePrimaryServeFeaturesCache();
        }
        totalSessionAdmission.beginWorkspaceDrain(runtimeToDrain.workspaceCwd);
        if (runtimeToDrain.provenance !== 'live-conversation') {
          channelWorkerManager?.beginWorkspaceDrain(
            runtimeToDrain.workspaceCwd,
          );
        }
        workspaceVoiceCoordinator.beginWorkspaceDrain(runtimeToDrain);
        channelWebhookEnvByWorkspace.delete(runtimeToDrain.workspaceCwd);
        channelWebhookConfigVersion += 1;
        refreshChannelWebhookConfigs?.();
        const app =
          serveAppForRuntimeLifecycle.current ??
          runtimeApp ??
          runtimeAppForCleanup;
        const stopScheduledTaskKeepaliveForWorkspace = app?.locals?.[
          'stopScheduledTaskKeepaliveForWorkspace'
        ] as ((workspaceCwd: string) => void) | undefined;
        try {
          stopScheduledTaskKeepaliveForWorkspace?.(runtimeToDrain.workspaceCwd);
        } catch (err) {
          daemonLog.error(
            'workspace scheduled-task drain error',
            err instanceof Error ? err : null,
          );
        }
      },
      cancelDrain(runtimeToDrain: WorkspaceRuntime): void {
        if (runtimeToDrain.primary && bridgeRef === undefined) {
          bridgeRef = runtimeToDrain.bridge;
          invalidatePrimaryServeFeaturesCache();
        }
        if (runtimeToDrain.provenance !== 'live-conversation') {
          channelWorkerManager?.cancelWorkspaceDrain(
            runtimeToDrain.workspaceCwd,
          );
        }
        totalSessionAdmission.cancelWorkspaceDrain(runtimeToDrain.workspaceCwd);
        workspaceVoiceCoordinator.cancelWorkspaceDrain(runtimeToDrain);
        if (runtimeToDrain.provenance !== 'live-conversation') {
          channelWebhookEnvByWorkspace.set(
            runtimeToDrain.workspaceCwd,
            workspaceRuntimeEffectiveEnv(runtimeToDrain, daemonRuntimeBaseEnv),
          );
          channelWebhookConfigVersion += 1;
          refreshChannelWebhookConfigs?.();
        }
        const app =
          serveAppForRuntimeLifecycle.current ??
          runtimeApp ??
          runtimeAppForCleanup;
        const startScheduledTaskKeepaliveForWorkspace = app?.locals?.[
          'startScheduledTaskKeepaliveForWorkspace'
        ] as ((runtime: WorkspaceRuntime) => void) | undefined;
        try {
          startScheduledTaskKeepaliveForWorkspace?.(runtimeToDrain);
        } catch (err) {
          daemonLog.error(
            'workspace scheduled-task drain rollback error',
            err instanceof Error ? err : null,
          );
        }
      },
      completeDrain(runtimeToDrain: WorkspaceRuntime): void {
        totalSessionAdmission.completeWorkspaceDrain(
          runtimeToDrain.workspaceCwd,
        );
        workspaceVoiceCoordinator.completeWorkspaceDrain(runtimeToDrain);
      },
      getActivity(runtimeToDrain: WorkspaceRuntime) {
        return {
          pendingSessionStarts: totalSessionAdmission.snapshotForWorkspace(
            runtimeToDrain.workspaceCwd,
          ).inFlight,
          channelWorkers:
            runtimeToDrain.provenance === 'live-conversation'
              ? 0
              : (channelWorkerManager?.workspaceActivity(
                  runtimeToDrain.workspaceCwd,
                ) ?? 0),
          voiceSessions:
            workspaceVoiceCoordinator.getWorkspaceActivity(runtimeToDrain),
        };
      },
      disposeRuntime(
        runtimeToDrain: WorkspaceRuntime,
        reason:
          | 'daemon_shutdown'
          | 'workspace_removed'
          | 'trust_reconfigured' = 'workspace_removed',
      ): Promise<void> {
        const existing = runtimeCleanupPromises.get(runtimeToDrain);
        if (existing) return existing;
        const cleanup = (async () => {
          const containmentErrors: Error[] = [];
          try {
            await workspaceVoiceCoordinator.disposeRuntime(
              runtimeToDrain,
              reason,
            );
          } catch (err) {
            daemonLog.error(
              'workspace voice cleanup error',
              err instanceof Error ? err : null,
            );
          }
          if (
            reason === 'trust_reconfigured' &&
            workspaceVoiceCoordinator.getWorkspaceActivity(runtimeToDrain) > 0
          ) {
            containmentErrors.push(
              new Error('Workspace voice sessions are still active.'),
            );
          }
          const stopSubSessions =
            subSessionStoppersByRuntime.get(runtimeToDrain);
          try {
            stopSubSessions?.();
          } catch {
            // Continue to bridge teardown.
          }
          if (
            reason !== 'daemon_shutdown' &&
            channelWorkerManager &&
            runtimeToDrain.provenance !== 'live-conversation'
          ) {
            await channelWorkerManager
              .removeWorkspace(runtimeToDrain.workspaceCwd)
              .catch((err) => {
                daemonLog.error(
                  'workspace channel worker cleanup error',
                  err instanceof Error ? err : null,
                );
              });
            try {
              await channelWorkerManager.refreshWorkspaces();
            } catch (err) {
              channelWorkspaceGroups = (channelWorkspaceGroups ?? []).filter(
                (group) => group.workspaceCwd !== runtimeToDrain.workspaceCwd,
              );
              channelWebhookConfigVersion += 1;
              refreshChannelWebhookConfigs?.();
              daemonLog.error(
                'workspace channel worker topology refresh error',
                err instanceof Error ? err : null,
              );
            }
            writeChannelWorkerPidfile();
            if (
              reason === 'trust_reconfigured' &&
              channelWorkerManager.workspaceActivity(
                runtimeToDrain.workspaceCwd,
              ) > 0
            ) {
              containmentErrors.push(
                new Error('Workspace channel workers are still active.'),
              );
            }
          }
          if (reason !== 'daemon_shutdown') {
            const app =
              serveAppForRuntimeLifecycle.current ??
              runtimeApp ??
              runtimeAppForCleanup;
            const stopWorkspaceGitStateForWorkspace = app?.locals?.[
              'stopWorkspaceGitStateForWorkspace'
            ] as ((workspaceCwd: string) => void) | undefined;
            const stopScheduledTaskKeepaliveForWorkspace = app?.locals?.[
              'stopScheduledTaskKeepaliveForWorkspace'
            ] as ((workspaceCwd: string) => void) | undefined;
            const releaseWebTerminalsForWorkspace = app?.locals?.[
              'releaseWebTerminalsForWorkspace'
            ] as ((workspaceCwd: string) => void) | undefined;
            try {
              stopWorkspaceGitStateForWorkspace?.(runtimeToDrain.workspaceCwd);
            } catch (err) {
              daemonLog.error(
                'workspace git-state cleanup error',
                err instanceof Error ? err : null,
              );
            }
            try {
              stopScheduledTaskKeepaliveForWorkspace?.(
                runtimeToDrain.workspaceCwd,
              );
            } catch (err) {
              daemonLog.error(
                'workspace scheduled-task cleanup error',
                err instanceof Error ? err : null,
              );
            }
            try {
              releaseWebTerminalsForWorkspace?.(runtimeToDrain.workspaceCwd);
            } catch (err) {
              daemonLog.error(
                'workspace web-terminal cleanup error',
                err instanceof Error ? err : null,
              );
            }
          }
          let bridgeStopped = false;
          try {
            if (!shutdownBridges.has(runtimeToDrain.bridge)) {
              try {
                await runtimeToDrain.bridge.shutdown({ reason });
              } catch (shutdownError) {
                try {
                  runtimeToDrain.bridge.killAllSync();
                  daemonLog.warn(
                    'workspace bridge required forceful shutdown',
                    {
                      workspace: runtimeToDrain.workspaceCwd,
                      reason,
                      error:
                        shutdownError instanceof Error
                          ? shutdownError.message
                          : String(shutdownError),
                    },
                  );
                } catch (killError) {
                  throw new AggregateError(
                    [shutdownError, killError],
                    'Workspace bridge shutdown could not be confirmed.',
                  );
                }
              }
            }
            bridgeStopped = true;
          } finally {
            if (bridgeStopped) {
              subSessionStoppersByRuntime.delete(runtimeToDrain);
              if (stopSubSessions) {
                removeArrayValue(subSessionStoppers, stopSubSessions);
              }
              removeArrayValue(runtimeBridges, runtimeToDrain.bridge);
              removeArrayValue(
                internalRuntimeBridgesForCleanup,
                runtimeToDrain.bridge,
              );
              shutdownBridges.add(runtimeToDrain.bridge);
            }
          }
          if (containmentErrors.length > 0) {
            throw new AggregateError(
              containmentErrors,
              'Workspace runtime containment could not be confirmed.',
            );
          }
        })();
        runtimeCleanupPromises.set(runtimeToDrain, cleanup);
        void cleanup.catch(() => {
          if (runtimeCleanupPromises.get(runtimeToDrain) === cleanup) {
            runtimeCleanupPromises.delete(runtimeToDrain);
          }
        });
        return cleanup;
      },
    };

    const channelManagementServices = new WeakMap<
      WorkspaceRuntime,
      Promise<ChannelManagementService>
    >();
    const channelManagementService = (
      targetRuntime: WorkspaceRuntime,
    ): Promise<ChannelManagementService> => {
      const existing = channelManagementServices.get(targetRuntime);
      if (existing) return existing;
      const pending = (async () => {
        if (!ensureChannelWorkerManager) {
          throw Object.assign(
            new Error('Channel worker manager is unavailable.'),
            { code: 'channel_worker_unavailable' },
          );
        }
        const [
          { createChannelManagementService },
          { WorkspaceChannelSettingsStore },
        ] = await Promise.all([
          import('./channel-management-service.js'),
          import('./channel-settings-store.js'),
        ]);
        return createChannelManagementService({
          workspaceCwd: targetRuntime.workspaceCwd,
          store: new WorkspaceChannelSettingsStore(targetRuntime.workspaceCwd),
          manager: await ensureChannelWorkerManager(),
        });
      })();
      channelManagementServices.set(targetRuntime, pending);
      void pending.catch(() => {
        if (channelManagementServices.get(targetRuntime) === pending) {
          channelManagementServices.delete(targetRuntime);
        }
      });
      return pending;
    };

    const validateWorkspaceRuntimeForPublication = async (
      runtimeForPublication: WorkspaceRuntime,
    ): Promise<WorkspaceRuntime> => {
      let candidate = runtimeForPublication;
      for (let attempt = 0; attempt < 3; attempt++) {
        const snapshot = await trustPolicy.readDaemonTrustPolicySnapshot();
        const decision = trustPolicy.evaluateDaemonWorkspaceTrust(
          snapshot,
          candidate.workspaceCwd,
        );
        const materialization = JSON.stringify({
          trusted: decision.targetTrusted,
          boundWorkspaces: [candidate.workspaceCwd],
        });
        if (candidate.trustMaterialization === materialization) {
          return candidate;
        }

        candidate.generationGuard?.close();
        await workspaceRuntimeRemoval.disposeRuntime(
          candidate,
          'trust_reconfigured',
        );
        if (attempt === 2) {
          throw new Error(
            'Workspace trust policy kept changing before runtime publication.',
          );
        }
        candidate = await createDynamicWorkspaceRuntime(
          runtimeForPublication.workspaceCwd,
          {
            primary: runtimeForPublication.primary,
            removable: runtimeForPublication.removable,
            displayName: runtimeForPublication.displayName,
            registrationIds: runtimeForPublication.registrationIds,
          },
        );
      }
      throw new Error('Workspace runtime publication validation failed.');
    };

    const app = runtime.createServeApp(opts, () => actualPort, {
      serveAppLifecycle,
      liveDiscoveryStableBaseDir,
      workspaceRegistry,
      getSessionBridges: () => runtimeBridges,
      createWorkspaceRuntime: createDynamicWorkspaceRuntime,
      ...(workspaceTrustHotReloadAvailable
        ? {
            validateWorkspaceRuntimeForPublication,
            runWorkspaceTrustOperation,
            getWorkspaceTrustPolicySnapshot: () => latestTrustPolicySnapshot,
          }
        : {}),
      managedScratchRoot,
      liveConversationWorkspace,
      readLiveConversationScheduledTasks,
      workspaceRegistrationStore,
      workspaceRuntimeRemoval,
      workspaceTrustHotReloadAvailable,
      voiceCoordinator: workspaceVoiceCoordinator,
      bridge,
      webShellDir,
      boundWorkspace,
      qwenCodeVersion: resolvedCliVersion,
      startup,
      // The real long-running daemon keeps scheduled-task sessions resident
      // (keepalive) and reloads them on boot (rehydration). Off by default so
      // direct createServeApp embeds/tests don't spawn sessions.
      manageScheduledTaskSessions: true,
      currentSessionSchedulingAvailable: deps.bridge === undefined,
      fsFactory: routeFsFactory,
      primaryWorkspaceTrusted: trustedWorkspace,
      primaryRuntimeEnv,
      daemonEnv: daemonRuntimeBaseEnv,
      runtimePlatform: deps.runtimePlatform,
      daemonLog,
      getChannelWorkerSnapshot,
      getChannelWorkerSnapshots,
      getChannelWorkerControl,
      isChannelControlDraining: () => channelControlDraining,
      isChannelControlInitializing: () =>
        channelWorkerManagerStarting !== undefined,
      setChannelWorkerSelection,
      stopChannelWorker,
      getChannelWebhookConfigSources,
      getChannelWebhookConfigVersion: () => channelWebhookConfigVersion,
      registerChannelWebhookConfigRefresh: (refresh) => {
        refreshChannelWebhookConfigs = refresh;
      },
      enqueueChannelWebhookTask: async (task) => {
        if (!channelWorkerManager) {
          throw new ChannelWebhookEnqueueError(
            'channel_worker_unavailable',
            'Channel worker is not running.',
          );
        }
        return channelWorkerManager.enqueueWebhookTask(task);
      },
      deliverChannelMessage: async (workspaceCwd, request) => {
        if (!channelWorkerManager) {
          throw new ChannelDeliveryError(
            'channel_worker_unavailable',
            'Channel worker is not running.',
          );
        }
        return channelWorkerManager.deliverChannelMessage(
          workspaceCwd,
          request,
        );
      },
      channelDeliveryAuthorizations,
      reloadChannelWorker,
      channelManagementService,
      getPerfSnapshot: () => ({
        eventLoop: currentDaemonEventLoopMonitor.snapshot(),
        promptQueueWait: {
          count: promptQueueWaitStats.count,
          meanMs:
            promptQueueWaitStats.count === 0
              ? 0
              : promptQueueWaitStats.totalMs / promptQueueWaitStats.count,
          maxMs: promptQueueWaitStats.maxMs,
          lastMs: promptQueueWaitStats.lastMs,
        },
        pipe: {
          inbound: { ...pipeStats.inbound },
          outbound: { ...pipeStats.outbound },
        },
      }),
      getMetricsSeries: () => metricsRing.snapshot(),
      getTotalSessionAdmissionSnapshot: totalSessionAdmission.snapshot,
      getChildHeapPolicySnapshot: () => managedChildHeapPolicy?.snapshot(),
      recordDaemonRequest: (durationMs, statusCode) =>
        metricsRing.recordRequest(durationMs, statusCode),
      workspace: workspaceService,
      // Reverse tool channel (#5626): the SAME registry wired into `bridge` above,
      // so the WS provider and the child-answering bridge share one sender map.
      clientMcpSenderRegistry,
      persistDisabledTools: persistDisabledToolsFn,
      persistDisabledSkills: persistDisabledSkillsFn,
      persistDisabledSkillsBatch: persistDisabledSkillsBatchFn,
      persistSetting: persistSettingFn,
      persistSettings: persistSettingsFn,
      sessionArtifactsPersistenceAvailable:
        sessionArtifactsPersistenceAvailableFromSettings(
          runtimeBootSettings?.merged,
        ),
      installAuthProvider: (req, assertGenerationOpen) =>
        withSettingsLock(
          boundWorkspace,
          async (): Promise<ServeAuthProviderInstallResult> => {
            assertGenerationOpen?.();
            const provider = core.findProviderById(req.providerId);
            if (!provider) {
              throw new Error(`Unsupported auth provider: ${req.providerId}`);
            }
            const inputs = buildProviderSetupInputs(req, provider, {
              getDefaultModelIds: core.getDefaultModelIds,
              resolveBaseUrl: core.resolveBaseUrl,
            });
            const plan = core.buildInstallPlan(provider, inputs);
            const fresh = loadSettingsForPersistence(boundWorkspace);
            const adapter =
              settingsRuntime.loadedSettingsAdapter.createLoadedSettingsAdapter(
                fresh,
              );
            await core.applyProviderInstallPlan(plan, {
              settings: adapter,
              doRefreshAuth: false,
            });
            assertGenerationOpen?.();
            core.emitDaemonLog('Auth provider installed.', {
              'qwen-code.daemon.auth.provider_id': provider.id,
              'qwen-code.daemon.auth.auth_type': plan.authType,
            });
            const effectiveModelId =
              (adapter.getValue('model.name') as string | undefined) ??
              plan.modelSelection?.modelId;
            const effectiveBaseUrl =
              (adapter.getValue('model.baseUrl') as string | undefined) ??
              plan.modelSelection?.baseUrl ??
              inputs.baseUrl;
            return {
              v: 1,
              providerId: provider.id,
              providerLabel: provider.label,
              authType: plan.authType,
              ...(effectiveModelId ? { modelId: effectiveModelId } : {}),
              ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
              message: `Successfully configured ${provider.label}. Use /model to switch models.`,
            };
          },
        ),
    });
    serveAppForRuntimeLifecycle.current = app;
    invalidatePrimaryServeFeaturesCache =
      (
        app.locals as {
          invalidateServeFeaturesCache?: () => void;
        }
      ).invalidateServeFeaturesCache ?? invalidatePrimaryServeFeaturesCache;
    // Park the sub-session launcher's stop on app.locals so the close handler
    // can flip it off before tearing down the bridge it spawns into (symmetric
    // with stopScheduledTaskKeepalive). Defensive: a launch during drain would
    // otherwise just fail its spawnOrAttach against the shutting-down bridge.
    (
      app.locals as { subSessionStoppers?: Array<() => void> }
    ).subSessionStoppers = subSessionStoppers;
    subSessionStoppers.push(subSessionLauncher.stop);
    subSessionStoppersByRuntime.set(
      workspaceRegistry.primary,
      subSessionLauncher.stop,
    );
    if (workspaceTrustHotReloadAvailable) {
      const [
        { createWorkspaceTrustReconciler },
        { createDaemonTrustPolicyMonitor },
      ] = await Promise.all([
        import('./workspace-trust-reconciler.js'),
        import('../config/daemon-trust-policy-monitor.js'),
      ]);
      const materializationFor = (
        entry: import('./workspace-registry.js').WorkspaceEntry,
        snapshot: DaemonTrustPolicySnapshot,
        decision: DaemonWorkspaceTrustDecision,
      ): { key: string; boundWorkspaces: readonly string[] } => {
        const boundWorkspaces =
          entry.primary && decision.targetTrusted
            ? runtime.resolveBoundWorkspacesFromIdeEnv(
                entry.workspaceCwd,
                undefined,
                (workspace: string, index: number) =>
                  index === 0 ||
                  trustPolicy.evaluateDaemonWorkspaceTrust(snapshot, workspace)
                    .targetTrusted,
              )
            : [entry.workspaceCwd];
        return {
          key: JSON.stringify({
            trusted: decision.targetTrusted,
            boundWorkspaces: [...boundWorkspaces].sort(),
          }),
          boundWorkspaces,
        };
      };
      const acpHandle = () =>
        app.locals?.['acpHandle'] as AcpHttpHandle | undefined;
      const trustReconciler = createWorkspaceTrustReconciler({
        registry: workspaceRegistry,
        readLatestSnapshot: trustPolicy.readDaemonTrustPolicySnapshot,
        materializationKey: ({ entry, snapshot, decision }) =>
          materializationFor(entry, snapshot, decision).key,
        isTrustDecrease: ({
          runtime: current,
          nextMaterialization,
          decision,
        }) => {
          if (current.trusted && !decision.targetTrusted) return true;
          if (!current.primary || !current.trusted) return false;
          try {
            const previous = JSON.parse(
              current.trustMaterialization ?? '{}',
            ) as {
              boundWorkspaces?: unknown;
            };
            const next = JSON.parse(nextMaterialization) as {
              boundWorkspaces?: unknown;
            };
            if (
              !Array.isArray(previous.boundWorkspaces) ||
              !Array.isArray(next.boundWorkspaces)
            ) {
              return true;
            }
            const nextRoots = new Set(
              next.boundWorkspaces.filter(
                (value): value is string => typeof value === 'string',
              ),
            );
            return previous.boundWorkspaces.some(
              (value) => typeof value !== 'string' || !nextRoots.has(value),
            );
          } catch {
            return true;
          }
        },
        buildRuntime: async ({
          entry,
          trusted,
          snapshot,
          decision,
          generationGuard,
        }) => {
          const materialized = materializationFor(
            entry,
            snapshot,
            trusted === decision.targetTrusted
              ? decision
              : { ...decision, targetTrusted: trusted },
          );
          return createDynamicWorkspaceRuntime(entry.workspaceCwd, {
            trusted,
            snapshot,
            decision,
            generationGuard,
            primary: entry.primary,
            removable: entry.removable,
            displayName: entry.displayName,
            registrationIds: entry.registrationIds,
            boundWorkspaces: materialized.boundWorkspaces,
            trustMaterialization: materialized.key,
          });
        },
        drainRuntime: async (runtimeToDrain) => {
          workspaceRuntimeRemoval.beginDrain(runtimeToDrain);
          acpHandle()?.beginWorkspaceDrain(runtimeToDrain.workspaceId);
        },
        disposeRuntime: async (runtimeToDispose, reason) => {
          const errors: unknown[] = [];
          try {
            await workspaceRuntimeRemoval.disposeRuntime(
              runtimeToDispose,
              reason,
            );
          } catch (error) {
            errors.push(error);
          }
          try {
            const handle = acpHandle();
            if (!runtimeToDispose.primary) {
              handle?.commitWorkspaceRemoval(runtimeToDispose.workspaceId);
            }
            handle?.disposeWorkspace(runtimeToDispose.workspaceId);
            const deadline = Date.now() + 1000;
            while (
              (handle?.getWorkspaceActivity(runtimeToDispose.workspaceId)
                .memoryTasks ?? 0) > 0 &&
              Date.now() < deadline
            ) {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            if (
              (handle?.getWorkspaceActivity(runtimeToDispose.workspaceId)
                .memoryTasks ?? 0) > 0
            ) {
              throw new Error(
                'Workspace memory tasks did not stop after runtime disposal.',
              );
            }
          } catch (error) {
            errors.push(error);
          }
          if (errors.length === 1) throw errors[0];
          if (errors.length > 1) {
            throw new AggregateError(
              errors,
              'Workspace runtime and ACP cleanup failed.',
            );
          }
        },
        runtimeActivated: async (runtimeAdded) => {
          workspaceRuntimeRemoval.cancelDrain(runtimeAdded);
          acpHandle()?.cancelWorkspaceDrain(runtimeAdded.workspaceId);
          if (runtimeAdded.primary) {
            bridgeRef = runtimeAdded.bridge;
            invalidatePrimaryServeFeaturesCache();
          }
          await workspaceRuntimeRemoval.runtimeAdded(runtimeAdded);
        },
        onError: (entry, error) => {
          daemonLog.error(
            `workspace trust reconciliation failed for ${entry.workspaceCwd}`,
            error instanceof Error ? error : null,
          );
        },
      });
      const trustMonitor = createDaemonTrustPolicyMonitor({
        onSnapshot: (snapshot) => {
          latestTrustPolicySnapshot = snapshot;
          return runWorkspaceTrustOperation(() =>
            trustReconciler.reconcile(snapshot),
          );
        },
        onError: (error) => {
          daemonLog.error(
            'workspace trust policy monitor failed',
            error instanceof Error ? error : null,
          );
        },
      });
      (
        app.locals as {
          stopTrustPolicyMonitor?: () => void;
          requestTrustReconcile?: () => Promise<void>;
          waitForTrustPolicyIdle?: () => Promise<void>;
        }
      ).stopTrustPolicyMonitor = () => trustMonitor.stop();
      (
        app.locals as {
          requestTrustReconcile?: () => Promise<void>;
        }
      ).requestTrustReconcile = () => trustMonitor.requestReconcile('manual');
      (
        app.locals as {
          waitForTrustPolicyIdle?: () => Promise<void>;
        }
      ).waitForTrustPolicyIdle = () =>
        runWorkspaceTrustOperation(async () => undefined);
      await trustMonitor.start();
    }
    const activePrimaryBridge =
      workspaceRegistry.primaryEntry.current?.runtime.bridge;
    bridgeRef = activePrimaryBridge;
    return { app, bridge: activePrimaryBridge };
  };

  if (deps.bridge) {
    const runtime = await buildRuntime();
    runtimeAppForCleanup = runtime.app;
    bridgeRef = runtime.bridge;
    if (!opts.channelSelection) {
      runtimeApp = runtime.app;
      runtimeStartupSettled = true;
      markRuntimeReady();
    }
  }

  cliVersion ??= await cliVersionPromise;

  const bootstrapApp = createBootstrapServeApp({
    opts,
    getPort: () => actualPort,
    boundWorkspace,
    startup,
    daemonLog,
    qwenCodeVersion: cliVersion,
    sessionShellCommandEnabled,
    sessionArtifactsPersistenceAvailable,
    currentSessionSchedulingAvailable: false,
    permissionPolicy,
    multiWorkspaceCapabilitiesRequireRuntime: workspaceInputs.length > 1,
    getRuntimeError: () => runtimeStartupError,
    getChannelWorkerSnapshot,
    getChannelWorkerSnapshots,
    onHealthServed: deferRuntimeUntilFirstHealth
      ? () => startRuntimeAfterHealth?.()
      : undefined,
  });
  const deferredChannelWebhookAuth = deferRuntimeUntilFirstHealth
    ? createDeferredChannelWebhookAuth(
        resolveChannelWebhookConfigSource,
        await loadChannelWebhookConfigRuntime(),
        daemonLog,
      )
    : undefined;
  const app =
    runtimeApp ??
    createDelegatingServeApp(bootstrapApp, () => runtimeApp, {
      waitForDeferredRuntimeRoutes: deferRuntimeUntilFirstHealth,
      startRuntime: () => startRuntimeForRequest?.() ?? false,
      runtimeReady,
      authenticateDeferredRuntimeRequest: bearerAuth(opts.token),
      authenticateDeferredChannelWebhookRequest: deferredChannelWebhookAuth,
      // The runtime app serves these before bearerAuth; a browser navigation
      // cannot attach the bearer header, so the cold gate must let them
      // through (and start the runtime) exactly like the warm app would.
      // Dynamic import keeps web-shell-static out of the serve fast-path
      // static closure (see the import-boundary guards in fast-path.test.ts).
      isPreAuthRequest: webShellMounted
        ? (req) =>
            import('./web-shell-static.js').then((webShellStatic) =>
              webShellStatic.isPreAuthWebShellRequest(req),
            )
        : undefined,
    });

  // Node's `app.listen()` wants the unbracketed IPv6 literal (`::1`) but
  // operators conventionally type `[::1]` (or copy/paste from URLs that
  // need the brackets to disambiguate the port). Strip brackets at
  // bind-time, keep them for the printed URL — without this fixup
  // `qwen serve --hostname [::1]` would pass the loopback/token check
  // and then fail to start with ENOTFOUND.
  //
  // Only accept *pure* bracketed forms: `[…]` with no trailing `:port`
  // suffix. `[2001:db8::1]:8080` is operator-error (port goes through
  // `--port`, not the hostname) — fail loudly with a useful error
  // instead of silently stripping to a malformed `2001:db8::1]:8080`.
  let listenHostname = opts.hostname;
  if (opts.hostname.startsWith('[')) {
    const inner = opts.hostname.slice(1, -1);
    if (
      !opts.hostname.endsWith(']') ||
      inner.length === 0 ||
      inner.includes(']')
    ) {
      throw new Error(
        `Invalid --hostname "${opts.hostname}": brackets indicate an ` +
          `IPv6 literal but the value isn't a clean [addr] form. Pass the ` +
          `address without a trailing :port (use --port for that), e.g. ` +
          `"--hostname [::1] --port 4170".`,
      );
    }
    // Empty brackets `[]` would have stripped to `''`, which Node treats
    // as "bind to all interfaces" — the operator's intent was specific,
    // not wildcard. The check above (`inner.length === 0`) rejects.
    listenHostname = inner;
  }

  // Validate maxConnections BEFORE binding so a typo fails the
  // promise instead of escaping as an uncaught exception inside the
  // listen callback (which fires from the `listening` event after the
  // outer promise has already resolved). Silent fail-OPEN on NaN /
  // negative would weaken the DoS/FD-exhaustion guard the cap exists
  // for.
  if (
    opts.maxConnections !== undefined &&
    (Number.isNaN(opts.maxConnections) || opts.maxConnections < 0)
  ) {
    throw new TypeError(
      `Invalid maxConnections: ${opts.maxConnections}. Must be >= 0 ` +
        `(0 / Infinity = unlimited).`,
    );
  }

  const channelValidationSettingsRuntime = opts.channelSelection
    ? await loadSettingsRuntimeModules()
    : undefined;
  const channelValidationTrustPolicy = opts.channelSelection
    ? await import('../config/daemon-trust-policy.js')
    : undefined;
  const channelValidationTrustSnapshot = channelValidationTrustPolicy
    ? await channelValidationTrustPolicy.readDaemonTrustPolicySnapshot()
    : undefined;
  const resolveChannelWorkspaceGroupsAtListen = () => {
    if (
      !opts.channelSelection ||
      !channelValidationSettingsRuntime ||
      !channelRuntime
    ) {
      return undefined;
    }
    const registry = (runtimeApp ?? runtimeAppForCleanup)?.locals?.[
      'workspaceRegistry'
    ] as WorkspaceRegistry | undefined;
    const resolveRuntime = (workspaceCwd: string) => {
      const runtime = registry?.getByWorkspaceCwd(workspaceCwd);
      if (registry && !runtime) {
        throw Object.assign(
          new Error(`Workspace "${workspaceCwd}" is unavailable.`),
          { code: 'workspace_unavailable' },
        );
      }
      return runtime;
    };
    const resolveTrusted = (
      workspaceCwd: string,
      primary: boolean,
      runtime: WorkspaceRuntime | undefined,
    ): boolean => {
      if (runtime) return runtime.trusted;
      if (primary && deps.trustedWorkspace !== undefined) {
        return deps.trustedWorkspace;
      }
      if (!channelValidationTrustPolicy || !channelValidationTrustSnapshot) {
        return false;
      }
      return channelValidationTrustPolicy.evaluateDaemonWorkspaceTrust(
        channelValidationTrustSnapshot,
        workspaceCwd,
      ).targetTrusted;
    };
    const settingsByWorkspace = new Map<
      string,
      ReturnType<SettingsRuntime['loadSettings']>
    >();
    if (workspaceInputs.length === 1) {
      const workspace = workspaceInputs[0]!;
      const runtime = resolveRuntime(workspace.cwd);
      const trusted = resolveTrusted(workspace.cwd, true, runtime);
      if (!trusted) {
        throw Object.assign(
          new Error(
            `Primary workspace "${workspace.cwd}" is not trusted; cannot host channels.`,
          ),
          { code: 'untrusted_workspace' },
        );
      }
      const effectiveEnv = runtime
        ? workspaceRuntimeEffectiveEnv(runtime, daemonRuntimeBaseEnv)
        : channelValidationSettingsRuntime.environment.buildRuntimeEnvironment(
            channelValidationSettingsRuntime.settings.loadSettings(
              workspace.cwd,
              {
                skipLoadEnvironment: true,
                skipWorkspaceSettings: false,
                workspaceTrusted: true,
              },
            ).merged,
            workspace.cwd,
            daemonRuntimeBaseEnv,
            trusted,
          ).effectiveEnv;
      channelWebhookEnvByWorkspace.set(workspace.cwd, effectiveEnv);
      return undefined;
    }
    const workspaces = workspaceInputs.map((workspace, index) => {
      const runtime = resolveRuntime(workspace.cwd);
      const trusted = resolveTrusted(workspace.cwd, index === 0, runtime);
      const settings = channelValidationSettingsRuntime.settings.loadSettings(
        workspace.cwd,
        {
          skipLoadEnvironment: true,
          skipWorkspaceSettings: !trusted,
          workspaceTrusted: trusted,
        },
      );
      settingsByWorkspace.set(workspace.cwd, settings);
      channelWebhookEnvByWorkspace.set(
        workspace.cwd,
        runtime
          ? workspaceRuntimeEffectiveEnv(runtime, daemonRuntimeBaseEnv)
          : channelValidationSettingsRuntime.environment.buildRuntimeEnvironment(
              settings.merged,
              workspace.cwd,
              daemonRuntimeBaseEnv,
              trusted,
            ).effectiveEnv,
      );
      return {
        workspaceCwd: workspace.cwd,
        primary: runtime?.primary ?? index === 0,
        trusted,
      };
    });
    const grouping = resolveChannelWorkspaceGroups({
      workspaces,
      selection: opts.channelSelection,
      loadChannelsConfig: (cwd) => {
        const settings = settingsByWorkspace.get(cwd);
        if (!settings) return {};
        return channelRuntime!.loadChannelsConfig(cwd, settings);
      },
    });
    if (!grouping.ok) {
      throw Object.assign(new Error(grouping.error.message), {
        code: grouping.error.code,
        ...(grouping.error.channel ? { channel: grouping.error.channel } : {}),
      });
    }
    return grouping.groups;
  };

  if (opts.channelSelection) {
    reserveChannelServicePidfile(opts.channelSelection);
  }

  return await new Promise<RunHandle>((resolve, reject) => {
    // When TLS is configured, wrap the Express app in an HTTPS listener
    // (`https.Server extends http.Server`, so everything downstream —
    // `server.maxConnections`, `server.address()`, `attachServer(server)`,
    // graceful close — is unchanged). Plain HTTP uses the same explicitly
    // lifecycle-bound server shape.
    let closeHost: (() => Promise<void>) | undefined;
    const onListening = (error?: Error) => {
      // Error handling (retry/reject) is owned by tryListen's
      // server.once('error') handler.
      if (error) return;

      startup.listenerReadyAt = new Date().toISOString();
      startup.processToListenMs = Math.round(process.uptime() * 1000);
      startup.runQwenServeToListenMs = Math.round(
        performance.now() - runStartedAt,
      );
      profileCheckpoint('serve_listener_ready');
      finalizeStartupProfile(`serve-${process.pid}`);

      // Listener-level connection cap, set inside the listen callback after
      // Node has opened the underlying `Server`. Each session's `EventBus`
      // already refuses to admit more than `DEFAULT_MAX_SUBSCRIBERS` (64), but
      // an attacker can still open *connections* that never finish
      // their headers, never reach the bus, and just sit consuming
      // socket descriptors. The default of 256 leaves room for many
      // sessions × many legitimate clients while keeping the FD count
      // bounded; operators with high-concurrency deployments raise it
      // via `--max-connections`.
      //
      // `0` and `Infinity` are operator-visible
      // "disable the cap" sentinels — but on Node 22 setting
      // `server.maxConnections = 0` causes the listener to refuse
      // EVERY connection (verified on v22.15.0: every fetch fails
      // with `SocketError: other side closed`). Treat 0 / Infinity
      // as "leave the property unset" so the documented disable
      // path actually disables instead of silently bricking the
      // daemon. NaN / negative are rejected upstream so
      // they never reach here.
      const cap = opts.maxConnections ?? 256;
      if (cap > 0 && Number.isFinite(cap)) {
        server.maxConnections = cap;
      }
      // else: leave unset (Node's default = unlimited at this layer).
      const addr = server.address();
      actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;
      const scheme = tlsOptions ? 'https' : 'http';
      const url = `${scheme}://${formatHostForUrl(opts.hostname)}:${actualPort}`;
      const liveRuntimeBaseDir = path.dirname(daemonLogBaseDir);
      const liveDiscoveryOwners: Array<{
        runtimeBaseDir: string;
        instanceNonce: string;
        pid: number;
      }> = [];
      const rememberLiveDiscoveryOwner = (owner: {
        runtimeBaseDir: string;
        instanceNonce: string;
        pid: number;
      }): void => {
        if (
          liveDiscoveryOwners.some(
            (candidate) =>
              candidate.runtimeBaseDir === owner.runtimeBaseDir &&
              candidate.instanceNonce === owner.instanceNonce &&
              candidate.pid === owner.pid,
          )
        ) {
          return;
        }
        liveDiscoveryOwners.push(owner);
      };
      let liveDiscoveryPublish: Promise<void> | undefined;
      let liveDiscoveryRetryTimer: NodeJS.Timeout | undefined;
      let liveDiscoveryRetryTask: Promise<void> | undefined;
      let liveDiscoveryBootRetryApp: Application | undefined;
      let liveDiscoveryEnabled = false;
      let liveDiscoveryShuttingDown = false;
      let liveDiscoveryToggle: Promise<void> = Promise.resolve();
      let attemptPendingLiveDiscovery: (() => Promise<void>) | undefined;
      const pendingLiveDiscoveryBaseDirs = new Set<string>();
      const warnedLiveDiscoveryOwners = new Set<string>();
      let warnedLiveDiscoveryBootFailure = false;
      const liveDiscoveryRetryDelayMs =
        deps.liveDiscoveryRetryDelayMs !== undefined &&
        Number.isFinite(deps.liveDiscoveryRetryDelayMs) &&
        deps.liveDiscoveryRetryDelayMs >= 10
          ? Math.min(deps.liveDiscoveryRetryDelayMs, 60_000)
          : DEFAULT_LIVE_DISCOVERY_RETRY_MS;
      const scheduleLiveDiscoveryRetry = (): void => {
        if (
          liveDiscoveryShuttingDown ||
          !liveDiscoveryEnabled ||
          liveDiscoveryRetryTimer ||
          liveDiscoveryRetryTask ||
          (!liveDiscoveryBootRetryApp &&
            (pendingLiveDiscoveryBaseDirs.size === 0 ||
              !attemptPendingLiveDiscovery))
        ) {
          return;
        }
        liveDiscoveryRetryTimer = setTimeout(() => {
          liveDiscoveryRetryTimer = undefined;
          if (liveDiscoveryShuttingDown || !liveDiscoveryEnabled) {
            return;
          }
          const retryApp = liveDiscoveryBootRetryApp;
          liveDiscoveryBootRetryApp = undefined;
          const retryOperation = retryApp
            ? publishLiveDiscovery(retryApp)
            : attemptPendingLiveDiscovery?.();
          if (!retryOperation) return;
          const retry = retryOperation.finally(() => {
            if (liveDiscoveryRetryTask === retry) {
              liveDiscoveryRetryTask = undefined;
            }
            scheduleLiveDiscoveryRetry();
          });
          liveDiscoveryRetryTask = retry;
        }, liveDiscoveryRetryDelayMs);
        liveDiscoveryRetryTimer.unref();
      };
      const cancelLiveDiscoveryRetry = (): void => {
        if (!liveDiscoveryRetryTimer) return;
        clearTimeout(liveDiscoveryRetryTimer);
        liveDiscoveryRetryTimer = undefined;
      };
      const publishLiveDiscovery = (
        candidateApp: Application,
      ): Promise<void> => {
        if (liveDiscoveryShuttingDown) return Promise.resolve();
        if (!resolveAcpHttpEnabled()) return Promise.resolve();
        if (candidateApp.locals?.['liveVoiceEnabled'] !== true)
          return Promise.resolve();
        liveDiscoveryEnabled = true;
        if (liveDiscoveryPublish) return liveDiscoveryPublish;
        const coordinator = candidateApp.locals?.['liveCoordinator'] as
          | { daemonInstanceNonce?: unknown }
          | undefined;
        const instanceNonce = coordinator?.daemonInstanceNonce;
        if (typeof instanceNonce !== 'string') return Promise.resolve();
        let publicationFailed = false;
        let publicationRetryable = false;
        const publication = serveAppLifecycle
          .startBoot()
          .then(() => loadLiveDiscoveryRuntime())
          .then(
            async ({
              handoffLiveDiscoveryOwner,
              LiveDiscoveryOwnerActiveError,
              LiveDiscoveryPublicationError,
              removeLiveDiscoveryFile,
              writeLiveDiscoveryFile,
            }) => {
              if (liveDiscoveryShuttingDown || !liveDiscoveryEnabled) return;
              liveDiscoveryBootRetryApp = undefined;
              warnedLiveDiscoveryBootFailure = false;
              const stableBaseDir = liveDiscoveryStableBaseDir;
              const runtimeBaseDir = path.resolve(liveRuntimeBaseDir);
              const targetBaseDirs = new Set<string>();
              if (runtimeBaseDir !== stableBaseDir) {
                targetBaseDirs.add(runtimeBaseDir);
              }
              targetBaseDirs.add(stableBaseDir);
              for (const baseDir of targetBaseDirs) {
                pendingLiveDiscoveryBaseDirs.add(baseDir);
              }
              const record = {
                url,
                ...(token ? { token } : {}),
                protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
                pid: process.pid,
                instanceNonce,
              };
              attemptPendingLiveDiscovery = async () => {
                const targets = [...pendingLiveDiscoveryBaseDirs];
                const published: Array<{
                  runtimeBaseDir: string;
                  instanceNonce: string;
                  pid: number;
                }> = [];
                const rollbackPublished = async (): Promise<void> => {
                  for (const owner of published.splice(0)) {
                    try {
                      await removeLiveDiscoveryFile(
                        owner.runtimeBaseDir,
                        owner,
                      );
                    } catch (cleanupError) {
                      rememberLiveDiscoveryOwner(owner);
                      daemonLog.warn(
                        `failed to roll back Live Host discovery at ${owner.runtimeBaseDir}: ${
                          cleanupError instanceof Error
                            ? cleanupError.message
                            : String(cleanupError)
                        }`,
                      );
                    }
                  }
                };
                for (const runtimeBaseDir of targets) {
                  if (liveDiscoveryShuttingDown || !liveDiscoveryEnabled) {
                    await rollbackPublished();
                    return;
                  }
                  try {
                    if (runtimeBaseDir !== stableBaseDir) {
                      await handoffLiveDiscoveryOwner(
                        runtimeBaseDir,
                        record,
                        async () => undefined,
                      );
                    }
                    await writeLiveDiscoveryFile(runtimeBaseDir, record);
                    published.push({
                      runtimeBaseDir,
                      instanceNonce,
                      pid: process.pid,
                    });
                  } catch (err) {
                    if (
                      err instanceof LiveDiscoveryPublicationError &&
                      err.published
                    ) {
                      published.push({
                        runtimeBaseDir,
                        instanceNonce,
                        pid: process.pid,
                      });
                    }
                    await rollbackPublished();
                    if (err instanceof LiveDiscoveryOwnerActiveError) {
                      if (!warnedLiveDiscoveryOwners.has(runtimeBaseDir)) {
                        warnedLiveDiscoveryOwners.add(runtimeBaseDir);
                        daemonLog.warn(
                          `failed to publish Live Host discovery at ${runtimeBaseDir}: ${err.message}`,
                        );
                      }
                      return;
                    }
                    daemonLog.warn(
                      `failed to publish Live Host discovery at ${runtimeBaseDir}: ${
                        err instanceof Error ? err.message : String(err)
                      }`,
                    );
                    return;
                  }
                }
                for (const owner of published) {
                  pendingLiveDiscoveryBaseDirs.delete(owner.runtimeBaseDir);
                  warnedLiveDiscoveryOwners.delete(owner.runtimeBaseDir);
                  rememberLiveDiscoveryOwner(owner);
                }
              };
              await attemptPendingLiveDiscovery();
              scheduleLiveDiscoveryRetry();
            },
          )
          .catch((err) => {
            publicationFailed = true;
            publicationRetryable =
              err instanceof ConversationRuntimeOwnershipError && err.retryable;
            if (!publicationRetryable || !warnedLiveDiscoveryBootFailure) {
              warnedLiveDiscoveryBootFailure = publicationRetryable;
              daemonLog.warn(
                `failed to publish Live Host discovery: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          });
        const trackedPublication = publication.finally(() => {
          if (
            publicationFailed &&
            liveDiscoveryPublish === trackedPublication
          ) {
            liveDiscoveryPublish = undefined;
            if (
              publicationRetryable &&
              !liveDiscoveryShuttingDown &&
              liveDiscoveryEnabled
            ) {
              liveDiscoveryBootRetryApp = candidateApp;
              scheduleLiveDiscoveryRetry();
            }
          }
        });
        liveDiscoveryPublish = trackedPublication;
        return liveDiscoveryPublish;
      };
      const removeLiveDiscoveryOwners = async (): Promise<void> => {
        const owners = [...liveDiscoveryOwners];
        if (owners.length === 0) return;
        let removeLiveDiscoveryFile: LiveDiscoveryRuntime['removeLiveDiscoveryFile'];
        try {
          ({ removeLiveDiscoveryFile } = await loadLiveDiscoveryRuntime());
        } catch (err) {
          throw new Error('Failed to load Live discovery cleanup support.', {
            cause: err,
          });
        }
        const errors: unknown[] = [];
        for (const owner of owners) {
          try {
            await removeLiveDiscoveryFile(owner.runtimeBaseDir, owner);
            const index = liveDiscoveryOwners.indexOf(owner);
            if (index >= 0) liveDiscoveryOwners.splice(index, 1);
          } catch (err) {
            errors.push(err);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(
            errors,
            'Live Host discovery cleanup is incomplete.',
          );
        }
      };
      const unpublishLiveDiscovery = async (): Promise<void> => {
        liveDiscoveryEnabled = false;
        liveDiscoveryBootRetryApp = undefined;
        warnedLiveDiscoveryBootFailure = false;
        cancelLiveDiscoveryRetry();
        pendingLiveDiscoveryBaseDirs.clear();
        attemptPendingLiveDiscovery = undefined;
        await liveDiscoveryPublish;
        await liveDiscoveryRetryTask;
        liveDiscoveryPublish = undefined;
        liveDiscoveryRetryTask = undefined;
        await removeLiveDiscoveryOwners();
      };
      const attachLiveDiscoveryControl = (candidateApp: Application): void => {
        (
          candidateApp.locals as {
            setLiveDiscoveryEnabled?: (enabled: boolean) => Promise<void>;
            onConversationRuntimeReady?: () => void;
          }
        ).setLiveDiscoveryEnabled = (enabled) => {
          const operation = liveDiscoveryToggle.then(() =>
            enabled
              ? publishLiveDiscovery(candidateApp)
              : unpublishLiveDiscovery(),
          );
          liveDiscoveryToggle = operation.catch(() => undefined);
          return operation;
        };
        (
          candidateApp.locals as {
            onConversationRuntimeReady?: () => void;
          }
        ).onConversationRuntimeReady = () => {
          void publishLiveDiscovery(candidateApp);
        };
      };
      const cleanupLiveDiscovery = async (): Promise<void> => {
        liveDiscoveryShuttingDown = true;
        cancelLiveDiscoveryRetry();
        await liveDiscoveryToggle;
        await unpublishLiveDiscovery();
      };
      let shuttingDown = false;
      let closePromise: Promise<void> | undefined;
      let runtimeStartupTimer: NodeJS.Timeout | undefined;
      let runtimeStartAfterHealthTimer: NodeJS.Timeout | undefined;
      let runtimeStartFallbackTimer: NodeJS.Timeout | undefined;
      const runtimeStartupTimeoutMs = resolveRuntimeStartupTimeoutMs(
        deps.runtimeStartupTimeoutMs,
      );
      const clearRuntimeStartupTimer = (): void => {
        if (!runtimeStartupTimer) return;
        clearTimeout(runtimeStartupTimer);
        runtimeStartupTimer = undefined;
      };
      const clearRuntimeStartFallbackTimer = (): void => {
        if (!runtimeStartFallbackTimer) return;
        clearTimeout(runtimeStartFallbackTimer);
        runtimeStartFallbackTimer = undefined;
      };
      const clearRuntimeStartAfterHealthTimer = (): void => {
        if (!runtimeStartAfterHealthTimer) return;
        clearTimeout(runtimeStartAfterHealthTimer);
        runtimeStartAfterHealthTimer = undefined;
      };
      const cancelDeferredRuntimeStartup = (): void => {
        if (
          !deferRuntimeUntilFirstHealth ||
          runtimeStarting ||
          runtimeStartupSettled
        )
          return;
        daemonLog.info(
          'deferred runtime: cancelled, server closed before startup',
        );
        runtimeStartupSettled = true;
        const error = new Error(RUNTIME_STARTUP_CANCELLED_MESSAGE);
        runtimeStartupError = error.message;
        markRuntimeFailed(error);
      };
      const shutdownBridgeAfterFailedStartup = async (
        bridge: AcpSessionBridge | undefined,
      ): Promise<void> => {
        if (!bridge || deps.bridge) return;
        if (shutdownBridges.has(bridge)) return;
        shutdownBridges.add(bridge);
        try {
          await bridge.shutdown();
        } catch (shutdownErr) {
          daemonLog.error(
            'bridge shutdown after runtime startup error failed',
            shutdownErr instanceof Error ? shutdownErr : null,
          );
        } finally {
          if (bridgeRef === bridge) {
            bridgeRef = undefined;
          }
        }
      };
      const stopChannelWorkerAfterFailedStartup =
        async (): Promise<boolean> => {
          if (!channelWorkerManager) return true;
          try {
            await channelWorkerManager.shutdown();
            return true;
          } catch (stopErr) {
            daemonLog.error(
              'channel worker stop after runtime startup error failed',
              stopErr instanceof Error ? stopErr : null,
            );
            return false;
          }
        };
      const failRuntimeStartup = async (
        err: unknown,
        bridgeForCleanup?: AcpSessionBridge,
      ): Promise<void> => {
        const error = err instanceof Error ? err : new Error(String(err));
        markServeAppStartupFailed(error);
        if (runtimeStartupSettled) {
          disposeRuntimeAppResources(runtimeApp ?? runtimeAppForCleanup);
          await shutdownBridgeAfterFailedStartup(bridgeForCleanup);
          return;
        }
        runtimeStartupSettled = true;
        disposeRuntimeAppResources(runtimeApp ?? runtimeAppForCleanup);
        runtimeApp = undefined;
        clearRuntimeStartupTimer();
        const message = error.message;
        runtimeStartupError = message;
        if (
          startup.preheat.status === 'scheduled' ||
          startup.preheat.status === 'running'
        ) {
          startup.preheat.status = 'failed';
          startup.preheat.error = message;
        }
        writeStderrLine(`qwen serve: runtime startup failed: ${message}`);
        daemonLog.error('runtime startup failed', error);
        markRuntimeFailed(error);
        if (closeServerAfterChannelWorkerStartupFailure && server.listening) {
          server.close((closeErr) => {
            if (closeErr) {
              daemonLog.error(
                'server close after runtime startup error failed',
                closeErr,
              );
            }
          });
          server.closeAllConnections();
        }
        const channelWorkerStopped =
          await stopChannelWorkerAfterFailedStartup();
        disposeDaemonEventLoopMonitor();
        if (channelWorkerStopped) removeCurrentServePidfile();
        const bridgesForCleanup = bridgeForCleanup
          ? [bridgeForCleanup, ...getRuntimeBridgesForCleanup()]
          : getRuntimeBridgesForCleanup();
        for (const bridge of [...new Set(bridgesForCleanup)]) {
          await shutdownBridgeAfterFailedStartup(bridge);
        }
      };
      const armRuntimeStartupTimer = (): void => {
        if (runtimeStartupTimeoutMs <= 0 || runtimeStartupTimer) return;
        runtimeStartupTimer = setTimeout(() => {
          void failRuntimeStartup(
            new Error(
              `Daemon runtime startup timed out after ${runtimeStartupTimeoutMs}ms.`,
            ),
          );
        }, runtimeStartupTimeoutMs);
        runtimeStartupTimer.unref();
      };
      const resolveRuntimeChannelGroups = async (
        channelSelection: ServeChannelSelection,
        candidateApp: Application,
        operation: 'initial' | 'set' | 'reload',
      ): Promise<readonly ChannelWorkspaceGroup[]> => {
        const registry = candidateApp.locals?.['workspaceRegistry'] as
          | WorkspaceRegistry
          | undefined;
        if (!registry) {
          throw new Error(
            'Workspace registry is not available for channel workers.',
          );
        }
        const runtimes = registry
          .list()
          .filter((runtime) => runtime.provenance !== 'live-conversation');
        if (runtimes.length <= 1 && operation === 'initial') {
          const primary = registry.primary;
          if (!primary.trusted) {
            throw Object.assign(
              new Error(
                `Primary workspace "${primary.workspaceCwd}" is not trusted; cannot host channels.`,
              ),
              { code: 'untrusted_workspace' },
            );
          }
          return [
            {
              workspaceCwd: primary.workspaceCwd,
              selection: channelSelection,
            },
          ];
        }
        const workerRuntime = await ensureChannelRuntime();
        const settingsRuntime = await loadSettingsRuntimeModules();
        const settingsByWorkspace = new Map<
          string,
          ReturnType<SettingsRuntime['loadSettings']>
        >();
        const grouping = resolveChannelWorkspaceGroups({
          workspaces: runtimes.map((runtime) => {
            const settings = settingsRuntime.settings.loadSettings(
              runtime.workspaceCwd,
              {
                skipLoadEnvironment: true,
                skipWorkspaceSettings: !runtime.trusted,
                workspaceTrusted: runtime.trusted,
              },
            );
            settingsByWorkspace.set(runtime.workspaceCwd, settings);
            return {
              workspaceCwd: runtime.workspaceCwd,
              primary: runtime.primary,
              trusted: runtime.trusted,
              provenance: runtime.provenance,
            };
          }),
          selection: channelSelection,
          loadChannelsConfig: (cwd) => {
            const settings = settingsByWorkspace.get(cwd);
            return settings
              ? workerRuntime.loadChannelsConfig(cwd, settings)
              : {};
          },
        });
        if (!grouping.ok) {
          throw Object.assign(new Error(grouping.error.message), {
            code: grouping.error.code,
            ...(grouping.error.channel
              ? { channel: grouping.error.channel }
              : {}),
          });
        }
        return grouping.groups;
      };

      ensureChannelWorkerManager = (): Promise<ChannelWorkerManager> => {
        if (channelWorkerManager) return Promise.resolve(channelWorkerManager);
        if (channelWorkerManagerStarting) return channelWorkerManagerStarting;
        const starting = (async () => {
          const candidateApp = runtimeApp ?? runtimeAppForCleanup;
          const registry = candidateApp?.locals?.['workspaceRegistry'] as
            | WorkspaceRegistry
            | undefined;
          if (!candidateApp || !registry) {
            throw new Error(
              'Workspace registry is not available for channels.',
            );
          }
          const workerRuntime = await ensureChannelRuntime();
          const workerDaemonUrl = formatChannelWorkerDaemonUrl(
            opts.hostname,
            actualPort,
            tlsOptions !== undefined,
            typeof addr === 'object' &&
              addr &&
              (addr.family === 'IPv4' || addr.family === 'IPv6')
              ? addr.family
              : undefined,
          );

          (
            deps.channelWorkerUrlCertifier ??
            assertChannelWorkerDaemonUrlIsLocal
          )(workerDaemonUrl, opts.hostname);
          if (
            tlsOptions &&
            tlsCertPath &&
            process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0'
          ) {
            // Workers inherit this variable unscrubbed and dial via fetch,
            // which honors it — but the handshake probe hardcodes strict
            // verification, so under ='0' it would fail while every worker
            // connects fine: a certain-outage log for an outage that never
            // happens.
            daemonLog.warn(
              `NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate ` +
                `verification for channel workers; skipping the worker TLS ` +
                `trust check.`,
            );
          } else if (tlsOptions && tlsCertPath) {
            const operatorCaCertPath = process.env['NODE_EXTRA_CA_CERTS'];
            let operatorCaCert: Buffer | undefined;
            let operatorCaCertReadError: string | undefined;
            if (operatorCaCertPath) {
              try {
                operatorCaCert = fs.readFileSync(operatorCaCertPath);
              } catch (error) {
                // Unreadable anchors nothing — but WHY it anchors nothing is
                // not something the contents can say. Swallowing the error
                // sent the operator after a file that already holds exactly
                // the issuing CA and is only unreadable (root-owned, mode
                // 600), with a remedy they had already applied.
                operatorCaCertReadError =
                  (error as NodeJS.ErrnoException)?.code ?? 'read failed';
              }
            }
            let predictedGaps: string[] = [];
            try {
              predictedGaps = describeWorkerTlsTrustGaps({
                cert: tlsOptions.cert,
                certPath: tlsCertPath,
                certSourcePath: tlsCertPath,
                daemonUrl: workerDaemonUrl,
                ...(operatorCaCertPath ? { operatorCaCertPath } : {}),
                ...(operatorCaCert
                  ? {
                      operatorCaCert,
                      operatorCaCertSourcePath: operatorCaCertPath,
                    }
                  : {}),
                ...(operatorCaCertReadError ? { operatorCaCertReadError } : {}),
              });
            } catch (error) {
              if (!(error instanceof ExtraCaInspectionError)) throw error;
              // A verdict the inspection cannot reach must not become a boot
              // failure: the live handshake probe below and the supervisor's
              // warned fallback still run; only the static prediction is lost.
              daemonLog.warn(
                `Channel worker TLS trust-gap inspection could not run: ` +
                  `${error.message} Continuing with the live handshake ` +
                  `probe only.`,
              );
            }
            const workerCaCertPath = workerRuntime.resolveWorkerCaCertPath(
              tlsCertPath,
              operatorCaCertPath,
            );
            const trustFailure = await (
              deps.workerTlsTrustVerifier ?? verifyWorkerTlsTrust
            )({
              daemonUrl: workerDaemonUrl,
              caCertPath: workerCaCertPath,
            });
            if (shuttingDown || runtimeStartupError !== undefined) {
              throw new Error(
                'Daemon stopped while the channel worker TLS trust check was running.',
              );
            }
            if (trustFailure) {
              if (predictedGaps.length > 0) {
                for (const gap of predictedGaps) daemonLog.warn(gap);
              } else {
                daemonLog.warn(
                  `Channel worker TLS verification failed against the exact ` +
                    `CA bundle workers receive (${sanitizeLogText(normalizeWorkerDiagnostic(trustFailure.code), 80)}): ` +
                    `${sanitizeLogText(normalizeWorkerDiagnostic(trustFailure.message), 300)}`,
                );
              }
            }
          }
          const createSupervisor =
            deps.channelWorkerSupervisorFactory ??
            workerRuntime.createChannelWorkerSupervisor;
          const createGroup = (groups: readonly ChannelWorkspaceGroup[]) =>
            workerRuntime.createChannelWorkerGroup({
              groups,
              registry,
              createSupervisor,
              shared: {
                cliEntryPath: workerRuntime.findCliEntryPath(),
                daemonUrl: workerDaemonUrl,
                ...(token ? { daemonToken: token } : {}),
                ...(tlsCertPath ? { workerTlsCaCertPath: tlsCertPath } : {}),
              },
              onReady: (snapshot) => {
                if (runtimeStartupError !== undefined) return;
                if (workspaceInputs.length > 1) {
                  daemonLog.info('channel worker ready', {
                    workspace: snapshot.workspaceCwd,
                    pid: snapshot.pid,
                    channels: snapshot.channels,
                  });
                }
                channelWorkerManager?.workerChanged();
                if (!runtimeStartupSettled) writeChannelWorkerPidfile();
              },
              onExit: (snapshot) => {
                const workspacePrefix =
                  workspaceInputs.length > 1
                    ? `workspace=${snapshot.workspaceCwd}, `
                    : '';
                daemonLog.warn(
                  `channel worker exited (${workspacePrefix}state=${snapshot.state}, pid=${snapshot.pid ?? 'unknown'}, ` +
                    `code=${snapshot.exitCode ?? 'null'}, signal=${snapshot.signal ?? 'null'}, ` +
                    `error=${snapshot.error ?? 'none'}, restartCount=${snapshot.restartCount ?? 0}, ` +
                    `nextRestartAt=${snapshot.nextRestartAt ?? 'none'}, ` +
                    `staleHeartbeatAt=${snapshot.staleHeartbeatAt ?? 'none'})`,
                );
                channelWorkerManager?.workerChanged();
                if (!runtimeStartupSettled) writeChannelWorkerPidfile();
              },
              onStateChange: () => {
                channelWorkerManager?.workerChanged();
                if (!runtimeStartupSettled) writeChannelWorkerPidfile();
              },
              onLog: ({ stream, line, workspaceCwd }) => {
                const message =
                  workspaceInputs.length > 1
                    ? `channel worker [${workspaceCwd}] ${stream}: ${line}`
                    : `channel worker ${stream}: ${line}`;
                if (stream === 'stderr') daemonLog.warn(message);
                else daemonLog.info(message);
              },
            });
          channelWorkerManager = workerRuntime.createChannelWorkerManager({
            resolveGroups: (selection, operation) =>
              resolveRuntimeChannelGroups(selection, candidateApp, operation),
            createGroup,
            reserveLease: reserveChannelServicePidfile,
            releaseLease: () => {
              removeCurrentServePidfile();
              if (channelPidfileReserved) {
                throw new Error('Failed to release the channel service lease.');
              }
            },
            initialLeaseReserved: channelPidfileReserved,
            onCommittedSelection: (_selection, groups) => {
              channelWorkspaceGroups = groups;
              channelWebhookConfigVersion += 1;
              refreshChannelWebhookConfigs?.();
            },
            onStateChange: () => {
              if (runtimeStartupSettled) writeChannelWorkerPidfile();
            },
          });
          return channelWorkerManager;
        })();
        channelWorkerManagerStarting = starting;
        void starting.then(
          () => {
            if (channelWorkerManagerStarting === starting) {
              channelWorkerManagerStarting = undefined;
            }
          },
          () => {
            if (channelWorkerManagerStarting === starting) {
              channelWorkerManagerStarting = undefined;
            }
          },
        );
        return starting;
      };
      const completeRuntimeStartup = async (
        candidateApp: Application,
      ): Promise<void> => {
        if (runtimeStartupSettled) return;
        runtimeApp = candidateApp;
        attachLiveDiscoveryControl(candidateApp);
        const acpHandle = candidateApp.locals?.['acpHandle'] as
          | AcpHttpHandle
          | undefined;
        acpHandle?.attachServer?.(server);
        if (opts.channelSelection) {
          closeServerAfterChannelWorkerStartupFailure = true;
          const manager = await ensureChannelWorkerManager!();
          await manager.startInitial(opts.channelSelection);
          if (runtimeStartupSettled) return;
        }
        if (runtimeStartupSettled) return;
        markServeAppStartupReady();
        await publishLiveDiscovery(candidateApp);
        runtimeStartupSettled = true;
        clearRuntimeStartupTimer();
        markRuntimeReady();
      };
      const startBridgePreheat = (bridge: AcpSessionBridge): void => {
        startup.preheat.status = 'running';
        const preheatStartedAt = performance.now();
        bridge
          .preheat()
          .then(() => {
            startup.preheat.status = 'succeeded';
            startup.preheat.durationMs = Math.round(
              performance.now() - preheatStartedAt,
            );
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            startup.preheat.status = 'failed';
            startup.preheat.durationMs = Math.round(
              performance.now() - preheatStartedAt,
            );
            startup.preheat.error = message;
            writeStderrLine(
              `qwen serve: ACP preheat failed, will retry on first session: ${message}`,
            );
          });
      };
      const startRuntime = (): boolean => {
        if (runtimeStarting) return false;
        armRuntimeStartupTimer();
        clearRuntimeStartAfterHealthTimer();
        clearRuntimeStartFallbackTimer();
        runtimeStarting = buildRuntime()
          .then(async (runtime) => {
            if (runtimeStartupSettled) {
              disposeRuntimeAppResources(runtime.app);
              await shutdownBridgeAfterFailedStartup(runtime.bridge);
              return;
            }
            bridgeRef = runtime.bridge;
            runtimeAppForCleanup = runtime.app;
            if (shuttingDown) {
              await failRuntimeStartup(
                new Error('Daemon runtime stopped before mounting.'),
                runtime.bridge,
              );
              return;
            }
            if (shouldPreheat && runtime.bridge) {
              startBridgePreheat(runtime.bridge);
            }
            await completeRuntimeStartup(runtime.app);
          })
          .catch((err) => failRuntimeStartup(err));
        return true;
      };
      startRuntimeForRequest = startRuntime;
      const scheduleRuntimeStartFallback = (): void => {
        if (shuttingDown || runtimeStarting || runtimeStartFallbackTimer)
          return;
        daemonLog.info(
          `deferred runtime: scheduling fallback start in ${FAST_PATH_RUNTIME_START_FALLBACK_MS}ms`,
        );
        runtimeStartFallbackTimer = setTimeout(() => {
          runtimeStartFallbackTimer = undefined;
          if (shuttingDown) return;
          daemonLog.info('deferred runtime: fallback timer fired, starting');
          startRuntime();
        }, FAST_PATH_RUNTIME_START_FALLBACK_MS);
        runtimeStartFallbackTimer.unref();
      };
      startRuntimeAfterHealth = (): void => {
        if (shuttingDown || runtimeStarting || runtimeStartAfterHealthTimer) {
          return;
        }
        clearRuntimeStartFallbackTimer();
        daemonLog.info(
          `deferred runtime: health served, scheduling start in ${FAST_PATH_RUNTIME_START_AFTER_HEALTH_MS}ms`,
        );
        runtimeStartAfterHealthTimer = setTimeout(() => {
          runtimeStartAfterHealthTimer = undefined;
          if (shuttingDown) return;
          daemonLog.info('deferred runtime: health timer fired, starting');
          startRuntime();
        }, FAST_PATH_RUNTIME_START_AFTER_HEALTH_MS);
        runtimeStartAfterHealthTimer.unref();
      };

      // Forward declaration so handle.close can detach the listener after
      // drain completes. The handler is registered just before `resolve()`.
      const onSignal = async (signal: NodeJS.Signals) => {
        if (shuttingDown) {
          // Second signal forces exit. During drain (up to
          // ~15s for a stuck child + the 5s force-close timer) an
          // operator's reflexive `^C^C` would otherwise be dropped.
          // Match standard daemon behavior (nginx, redis, etc.):
          // first signal = graceful drain; second = hard exit.
          //
          // Synchronously SIGKILL every live `qwen --acp`
          // child BEFORE `process.exit(1)`. Otherwise the daemon
          // vanishes but its child processes keep running with
          // dangling stdin/stdout pipes — visible as orphan
          // `qwen` processes in the operator's `ps` output.
          daemonLog.warn(`received ${signal} during drain — forcing exit`);
          try {
            managedProcessRegistry?.killAllSync();
            channelWorkerManager?.killAllSync();
            for (const runtimeBridge of getRuntimeBridgesForCleanup()) {
              runtimeBridge.killAllSync();
            }
          } catch (err) {
            daemonLog.error(
              'force-kill error',
              err instanceof Error ? err : null,
            );
          }
          await flushDaemonLogBounded(
            daemonLog,
            DAEMON_LOG_FORCED_FLUSH_BUDGET_MS,
          );
          process.exit(1);
          return;
        }
        if (!loggerPublished) {
          loggerSignalOwned = true;
          loggerLifecycle.signalOwned();
        }
        daemonLog.warn(`received ${signal}, draining`);
        try {
          await handle.close();
          process.exit(runtimeStartupError === undefined ? 0 : 1);
        } catch (err) {
          daemonLog.error('shutdown error', err instanceof Error ? err : null);
          if (hasRetryableChannelWorkerShutdownError(err)) {
            daemonLog.error(
              'refusing to exit while a channel worker or service lease remains; signal again to retry after the child exits (another signal during that retry forces exit)',
            );
            return;
          }
          await flushDaemonLogBounded(
            daemonLog,
            DAEMON_LOG_FORCED_FLUSH_BUDGET_MS,
          );
          process.exit(1);
        }
      };
      const onUncaughtExceptionMonitor = () => {
        if (
          process.listenerCount('uncaughtException') === 0 &&
          !channelWorkerManager?.state().enabled
        ) {
          removeCurrentServePidfile();
        }
      };

      const handle: RunHandle = {
        server,
        url,
        bridge: handleBridge,
        webShellMounted,
        resolvedToken: token,
        runtimeReady,
        getLocalControl: () =>
          (runtimeApp ?? runtimeAppForCleanup)?.locals?.[
            'localControlService'
          ] as LocalControlService | undefined,
        close: () => {
          // Idempotent: cache the in-flight (or settled) close promise so
          // overlapping calls (e.g. test harness + signal handler firing
          // simultaneously) all observe the same drain cycle. Without this
          // each caller would arm its own force-close timer + invoke
          // bridge.shutdown / server.close redundantly.
          if (closePromise) return closePromise;
          closePromise = new Promise<void>((res, rej) => {
            shuttingDown = true;
            liveDiscoveryShuttingDown = true;
            cancelLiveDiscoveryRetry();
            channelControlDraining = true;
            const initiallyMountedApp = runtimeApp ?? runtimeAppForCleanup;
            const initiallyMountedManagement = initiallyMountedApp?.locals?.[
              'workspaceManagementHandle'
            ] as { sealAndWait?: () => Promise<void> } | undefined;
            const initiallyMountedSessionMaintenance = initiallyMountedApp
              ?.locals?.['sessionArchiveCoordinator'] as
              | { sealMaintenanceAndWait?: () => Promise<void> }
              | undefined;
            const initiallyMountedConversationActivity = initiallyMountedApp
              ?.locals?.['conversationRuntimeActivity'] as
              | { sealAndWait?: () => Promise<void> }
              | undefined;
            // Calling an async function runs through its first await
            // synchronously. Seal an already-mounted runtime before close()
            // yields so no management request can enter the shutdown window.
            const initialManagementWait =
              initiallyMountedManagement?.sealAndWait?.();
            const initiallyMountedLive = initiallyMountedApp?.locals as
              | { sealAndWaitLiveCoordinator?: () => Promise<void> }
              | undefined;
            const initialLiveWait =
              initiallyMountedLive?.sealAndWaitLiveCoordinator?.();
            const initialSessionMaintenanceWait =
              initiallyMountedSessionMaintenance?.sealMaintenanceAndWait?.();
            const initialConversationActivityWait =
              initiallyMountedConversationActivity?.sealAndWait?.();
            let processRegistryShutdown: Promise<Error | undefined> | undefined;
            const startProcessRegistryShutdown = () => {
              processRegistryShutdown ??= managedProcessRegistry
                ?.shutdown()
                .then(
                  () => undefined,
                  (error: unknown) =>
                    error instanceof Error ? error : new Error(String(error)),
                );
            };
            startProcessRegistryShutdown();
            clearRuntimeStartAfterHealthTimer();
            clearRuntimeStartFallbackTimer();
            cancelDeferredRuntimeStartup();
            // NOTE: the shutdown signal handlers stay attached during the
            // drain so a second signal can take the explicit force-exit path
            // above. Detaching them up front would leave Node's default signal
            // behavior in charge and could orphan agent children. We detach
            // AFTER drain completes (`finish` below).

            // The shared lifecycle closes the listener in parallel with this
            // host drain, then releases Conversations ownership only after both
            // the listener callback and every child/bridge drain are proven.
            let settled = false;
            // Track bridge.shutdown failures so close()
            // doesn't silently report success when the bridge
            // teardown itself failed. The contract says "resolves
            // when the listener has fully closed and the bridge is
            // drained" — propagating the failure lets `onSignal`
            // exit 1 instead of 0, and lets embedders react.
            let bridgeShutdownError: Error | undefined;
            let channelWorkerShutdownError: Error | undefined;
            const finish = (err?: Error | null) => {
              if (settled) return;
              settled = true;
              const accessLogController = (
                (runtimeApp ?? runtimeAppForCleanup)?.locals as
                  | AccessLogAppLocals
                  | undefined
              )?.[ACCESS_LOG_CONTROLLER_LOCAL];
              accessLogController?.sealAndFlushSuppressed();
              const preserveSignalHandlers =
                channelWorkerShutdownError !== undefined &&
                channelWorkerManager?.state().enabled === true;
              if (!preserveSignalHandlers) {
                process.removeListener('SIGINT', onSignal);
                process.removeListener('SIGTERM', onSignal);
                process.removeListener('SIGHUP', onSignal);
              }
              process.removeListener(
                'uncaughtExceptionMonitor',
                onUncaughtExceptionMonitor,
              );
              void (
                coreRuntimePromise
                  ? coreRuntimePromise.then((core) => core.shutdownTelemetry())
                  : Promise.resolve()
              )
                .catch((telemetryErr) => {
                  writeStderrLine(
                    `qwen serve: telemetry shutdown error: ${
                      telemetryErr instanceof Error
                        ? telemetryErr.message
                        : String(telemetryErr)
                    }`,
                  );
                })
                .finally(async () => {
                  // Server.close error takes precedence (operator-visible
                  // listener problem); fall back to the bridge error
                  // captured during shutdown if any.
                  let finalErr =
                    err ?? bridgeShutdownError ?? channelWorkerShutdownError;
                  const retryableChannelClose =
                    channelWorkerShutdownError !== undefined &&
                    channelWorkerManager?.state().enabled === true;
                  if (retryableChannelClose) {
                    const retryableError = channelWorkerShutdownError!;
                    await flushDaemonLogBounded(
                      daemonLog,
                      DAEMON_LOG_FORCED_FLUSH_BUDGET_MS,
                    );
                    closePromise = undefined;
                    shuttingDown = false;
                    channelControlDraining = false;
                    retryableChannelWorkerShutdownErrors.add(retryableError);
                    rej(retryableError);
                    return;
                  }
                  try {
                    await cleanupLiveDiscovery();
                  } catch (cleanupError) {
                    const normalizedCleanupError =
                      cleanupError instanceof Error
                        ? cleanupError
                        : new Error(String(cleanupError));
                    if (finalErr) {
                      writeDaemonLifecycleBestEffort(() => {
                        daemonLog.error(
                          'Live Host discovery cleanup failed during shutdown',
                          normalizedCleanupError,
                        );
                      });
                    }
                    finalErr ??= normalizedCleanupError;
                  }
                  if (loggerPublished || loggerSignalOwned) {
                    writeDaemonLifecycleBestEffort(() => {
                      if (finalErr) {
                        daemonLog.error('daemon shutdown incomplete', finalErr);
                      } else {
                        daemonLog.info('daemon stopped');
                      }
                    });
                    clearLoaderKeyRejectionReporterIfCurrent(
                      loaderRejectionReporter,
                    );
                    await daemonLog.close();
                  }
                  restoreScrubbedLoaderEnv();
                  if (finalErr) rej(finalErr);
                  else res();
                });
            };

            void (
              coreRuntimePromise
                ? coreRuntimePromise.then((core) => core.forceFlushMetrics())
                : Promise.resolve()
            ).catch((flushErr) => {
              daemonLog.warn(
                `pre-shutdown metrics flush failed: ${
                  flushErr instanceof Error
                    ? flushErr.message
                    : String(flushErr)
                }`,
              );
            });

            Promise.resolve()
              .then(async () => {
                await waitForRuntimeStartingForShutdown(
                  runtimeStarting,
                  daemonLog,
                );
                const appForCleanup = runtimeApp ?? runtimeAppForCleanup;
                const workspaceManagementHandle = appForCleanup?.locals?.[
                  'workspaceManagementHandle'
                ] as { sealAndWait?: () => Promise<void> } | undefined;
                const sessionMaintenance = appForCleanup?.locals?.[
                  'sessionArchiveCoordinator'
                ] as
                  | { sealMaintenanceAndWait?: () => Promise<void> }
                  | undefined;
                const conversationActivity = appForCleanup?.locals?.[
                  'conversationRuntimeActivity'
                ] as { sealAndWait?: () => Promise<void> } | undefined;
                await initialManagementWait;
                if (workspaceManagementHandle !== initiallyMountedManagement) {
                  await workspaceManagementHandle?.sealAndWait?.();
                }
                const liveLifecycleHandle = appForCleanup?.locals as
                  | { sealAndWaitLiveCoordinator?: () => Promise<void> }
                  | undefined;
                await initialLiveWait;
                if (liveLifecycleHandle !== initiallyMountedLive) {
                  await liveLifecycleHandle?.sealAndWaitLiveCoordinator?.();
                }
                await initialSessionMaintenanceWait;
                if (sessionMaintenance !== initiallyMountedSessionMaintenance) {
                  await sessionMaintenance?.sealMaintenanceAndWait?.();
                }
                await initialConversationActivityWait;
                if (
                  conversationActivity !== initiallyMountedConversationActivity
                ) {
                  await conversationActivity?.sealAndWait?.();
                }
                stopTrustPolicyMonitor(appForCleanup);
                const waitForTrustPolicyIdle = appForCleanup?.locals?.[
                  'waitForTrustPolicyIdle'
                ] as (() => Promise<void>) | undefined;
                await waitForTrustPolicyIdle?.().catch((err) => {
                  daemonLog.error(
                    'workspace trust reconciliation shutdown wait failed',
                    err instanceof Error ? err : null,
                  );
                });
                startProcessRegistryShutdown();
                disposeRuntimeAppResources(appForCleanup);
                disposeDaemonEventLoopMonitor();
                // Writer terminals are already in flight. Stop the worker
                // before tearing down the bridge state it is attached to.
                if (channelWorkerManager) {
                  await channelWorkerManager.shutdown().catch((err) => {
                    daemonLog.error(
                      'channel worker stop error',
                      err instanceof Error ? err : null,
                    );
                    channelWorkerShutdownError =
                      err instanceof Error ? err : new Error(String(err));
                  });
                } else {
                  removeCurrentServePidfile();
                }
                const runtimeRemoval = appForCleanup?.locals?.[
                  'workspaceRuntimeRemoval'
                ] as WorkspaceRuntimeRemovalController | undefined;
                const workspaceRegistry = appForCleanup?.locals?.[
                  'workspaceRegistry'
                ] as WorkspaceRegistry | undefined;
                const managedRuntimeBridges = new Set<AcpSessionBridge>();
                if (runtimeRemoval && workspaceRegistry) {
                  const managedRuntimes = workspaceRegistry.listManaged();
                  for (const workspaceRuntime of managedRuntimes) {
                    managedRuntimeBridges.add(workspaceRuntime.bridge);
                  }
                  await Promise.all(
                    managedRuntimes.map((workspaceRuntime) =>
                      runtimeRemoval
                        .disposeRuntime(workspaceRuntime, 'daemon_shutdown')
                        .catch((err) => {
                          daemonLog.error(
                            'workspace runtime shutdown error',
                            err instanceof Error ? err : null,
                          );
                          bridgeShutdownError =
                            err instanceof Error ? err : new Error(String(err));
                          try {
                            workspaceRuntime.bridge.killAllSync();
                          } catch {
                            // Continue shutting down the remaining runtimes.
                          }
                        }),
                    ),
                  );
                }
                for (const bridgeForShutdown of getRuntimeBridgesForCleanup()) {
                  if (managedRuntimeBridges.has(bridgeForShutdown)) continue;
                  if (shutdownBridges.has(bridgeForShutdown)) continue;
                  shutdownBridges.add(bridgeForShutdown);
                  await bridgeForShutdown.shutdown().catch((err) => {
                    shutdownBridges.delete(bridgeForShutdown);
                    daemonLog.error(
                      'bridge shutdown error',
                      err instanceof Error ? err : null,
                    );
                    bridgeShutdownError =
                      err instanceof Error ? err : new Error(String(err));
                  });
                }
                const processRegistryError = await processRegistryShutdown;
                if (processRegistryError) {
                  daemonLog.error(
                    'ACP process registry shutdown error',
                    processRegistryError,
                  );
                  bridgeShutdownError ??= processRegistryError;
                }
              })
              .then(
                () => finish(),
                (error: unknown) =>
                  finish(
                    error instanceof Error ? error : new Error(String(error)),
                  ),
              );
          });
          return closePromise;
        },
      };
      closeHost = handle.close;
      handle.close = () => serveAppLifecycle.close();

      try {
        channelWorkspaceGroups = resolveChannelWorkspaceGroupsAtListen();
      } catch (err) {
        removeCurrentServePidfile();
        const error = err instanceof Error ? err : new Error(String(err));
        markServeAppStartupFailed(error);
        void serveAppLifecycle.close().then(
          () => reject(error),
          (closeError: unknown) =>
            reject(
              closeError instanceof Error
                ? new AggregateError([error, closeError], error.message)
                : error,
            ),
        );
        return;
      }
      if (channelWorkspaceGroups) {
        for (const group of channelWorkspaceGroups) {
          daemonLog.info('channel worker group assigned', {
            workspace: group.workspaceCwd,
            channels:
              group.selection.mode === 'all' ? ['all'] : group.selection.names,
          });
        }
        if (opts.channelSelection?.mode === 'all') {
          writeStderrLine(
            'qwen serve: --channel all is primary-workspace only; non-primary workspace channels are not hosted.',
          );
        }
      }
      writeStdoutLine(
        `qwen serve listening on ${url} (mode=${opts.mode}, ` +
          `workspace=${boundWorkspace})`,
      );
      // Operator log on stderr too (systemd/docker/k8s default
      // captures only stderr for service diagnostics, and the
      // workspace= breadcrumb is the single piece of information
      // operators need most when triaging migration issues —
      // "did the daemon bind to the right workspace?"). The stdout
      // line above stays put so integration tests + scripts that
      // parse stdout for the listening URL keep working;
      // `JSON.stringify(boundWorkspace)` quotes the value
      // symmetrically with the workspace_mismatch log (defends
      // against control-char log injection if `boundWorkspace`
      // somehow contained one — operator-controlled today, but
      // cheap defense-in-depth).
      writeStderrLine(
        `qwen serve: bound to workspace ${JSON.stringify(boundWorkspace)}`,
      );
      writeStderrLine(
        `qwen serve: startup timing: processToListenMs=${startup.processToListenMs} ` +
          `runQwenServeToListenMs=${startup.runQwenServeToListenMs}`,
      );
      if (!token) {
        writeStderrLine(
          `qwen serve: bearer auth disabled (loopback default). Set ${QWEN_SERVER_TOKEN_ENV} to enable.`,
        );
        if (opts.clientMcpOverWs === true) {
          writeStderrLine(
            `qwen serve: client-hosted MCP tools are accepted over the WebSocket without auth. ` +
              `Set ${QWEN_SERVE_CLIENT_MCP_OVER_WS_ENV}=0 to disable.`,
          );
        }
      } else if (opts.requireAuth) {
        // The boot check above guarantees `token` is set whenever
        // `--require-auth` is on, so this branch only fires alongside
        // a successfully-authenticated daemon. The log line lets
        // operators confirm the hardening is active without parsing
        // `/capabilities` (and is a useful breadcrumb when triaging
        // "why is loopback returning 401" tickets).
        writeStderrLine(
          'qwen serve: --require-auth enabled (bearer token mandatory ' +
            'on every route, including loopback /health).',
        );
      }

      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      process.on('SIGHUP', onSignal);
      process.on('uncaughtExceptionMonitor', onUncaughtExceptionMonitor);

      // The per-attempt boot-error listener was removed by handleListening.
      // Keep the lifecycle listener and add persistent runtime diagnostics.
      server.on('error', (err) => {
        daemonLog.error('server error', err instanceof Error ? err : null);
      });
      const preparedRuntimeApp = runtimeApp ?? runtimeAppForCleanup;
      if (preparedRuntimeApp && bridgeRef && deps.bridge) {
        attachLiveDiscoveryControl(preparedRuntimeApp);
        if (shouldPreheat) {
          startBridgePreheat(bridgeRef);
        }
        if (opts.channelSelection && !runtimeStartupSettled) {
          armRuntimeStartupTimer();
          runtimeStarting = completeRuntimeStartup(preparedRuntimeApp).catch(
            (err) => failRuntimeStartup(err, bridgeRef),
          );
        } else {
          const acpHandle = preparedRuntimeApp.locals?.['acpHandle'] as
            | AcpHttpHandle
            | undefined;
          acpHandle?.attachServer?.(server);
          markServeAppStartupReady();
          void publishLiveDiscovery(preparedRuntimeApp);
        }
      } else if (deferRuntimeUntilFirstHealth) {
        scheduleRuntimeStartFallback();
      } else {
        startRuntime();
      }

      if (deps.resolveOnListen) {
        loggerPublished = true;
        loggerLifecycle.published();
        void (liveDiscoveryPublish ?? Promise.resolve()).then(() =>
          resolve(handle),
        );
      } else {
        void runtimeReady.then(
          async () => {
            await liveDiscoveryPublish;
            loggerPublished = true;
            loggerLifecycle.published();
            resolve(handle);
          },
          (err) => {
            void handle.close().then(
              () => {
                reject(err instanceof Error ? err : new Error(String(err)));
              },
              (closeErr) => {
                writeDaemonLifecycleBestEffort(() =>
                  daemonLog.error(
                    'shutdown after runtime startup error failed',
                    closeErr instanceof Error ? closeErr : null,
                  ),
                );
                if (hasRetryableChannelWorkerShutdownError(closeErr)) {
                  writeDaemonLifecycleBestEffort(() =>
                    daemonLog.error(
                      'runtime startup failed, but qwen serve remains alive to retain the channel service lease until worker exit is confirmed',
                    ),
                  );
                  return;
                }
                reject(err instanceof Error ? err : new Error(String(err)));
              },
            );
          },
        );
      }
    };
    let server: Server;
    if (tlsOptions) {
      try {
        server = https.createServer(tlsOptions, app);
      } catch (err) {
        // createSecureContext throws a raw OpenSSL string (e.g.
        // "error:0B080074:...key values mismatch") when cert/key don't pair.
        // Wrap it so the operator gets the same actionable framing as the
        // --tls-cert/--tls-key read errors above.
        reject(
          new Error(
            `--tls-cert "${opts.tlsCert}" and --tls-key "${opts.tlsKey}" ` +
              `could not be loaded (do they match?): ` +
              `${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }
    } else {
      server = deps.httpServerFactory?.(app) ?? createServer(app);
    }
    serveAppLifecycle.bindServer(server, {
      startupReady: serveAppStartupReady,
      drainHost: () => {
        if (closeHost) return closeHost();
        if (!server.listening) return Promise.resolve();
        return new Promise<void>((resolve, rejectClose) => {
          server.close((error) => {
            if (error) rejectClose(error);
            else resolve();
          });
        });
      },
    });

    const tryListen = (attemptPort: number, attempt: number): void => {
      const handleListening = (): void => {
        server.removeListener('error', handleError);
        onListening();
      };
      const handleError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', handleListening);
        const nextPort = attemptPort + 1;
        if (
          err.code === 'EADDRINUSE' &&
          opts.port !== 0 &&
          nextPort <= 65535 &&
          attempt < MAX_PORT_ATTEMPTS - 1
        ) {
          writeStderrLine(
            `qwen serve: port ${attemptPort} is in use, trying ${nextPort}...`,
          );
          tryListen(nextPort, attempt + 1);
          return;
        }
        if (err.code === 'EADDRINUSE' && attempt > 0) {
          writeStderrLine(
            `qwen serve: all ports ${opts.port}–${attemptPort} are in use`,
          );
        }
        removeCurrentServePidfile();
        markServeAppStartupFailed(err);
        void serveAppLifecycle.close().then(
          () => reject(err),
          (closeError: unknown) =>
            reject(
              closeError instanceof Error
                ? new AggregateError([err, closeError], err.message)
                : err,
            ),
        );
      };
      try {
        server.once('listening', handleListening);
        server.once('error', handleError);
        server.listen(attemptPort, listenHostname);
      } catch (err) {
        // Synchronous listen failure (e.g. invalid address) — not
        // recoverable via port bump.
        removeCurrentServePidfile();
        server.removeListener('listening', handleListening);
        server.removeListener('error', handleError);
        const error = err instanceof Error ? err : new Error(String(err));
        markServeAppStartupFailed(error);
        void serveAppLifecycle.close().then(
          () => reject(error),
          (closeError: unknown) =>
            reject(
              closeError instanceof Error
                ? new AggregateError([error, closeError], error.message)
                : error,
            ),
        );
        return;
      }
    };

    tryListen(opts.port, 0);
  });
}
