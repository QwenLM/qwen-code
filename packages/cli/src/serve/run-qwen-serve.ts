/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { X509Certificate, createHash, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import type { Server } from 'node:http';
import * as https from 'node:https';
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
import {
  DEFAULT_COMPACTED_REPLAY_MAX_BYTES,
  normalizeCompactedReplayMaxBytes,
} from '@qwen-code/acp-bridge/replayWindowLimits';
import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import type { NdJsonMessageObservation } from '@qwen-code/acp-bridge/ndJsonStream';
import { getDeviceFlowRegistry } from './auth/device-flow.js';
import {
  loadServeFastPathSettings,
  preResolveServeFastPathHomeEnvOverrides,
  type ServeFastPathSettings,
} from './fast-path-settings.js';
import { resolveWorkspaceInputs } from './workspace-inputs.js';
import type { AcpSessionBridge } from '@qwen-code/acp-bridge/bridgeTypes';
import { canonicalizeWorkspace } from '@qwen-code/acp-bridge/workspacePaths';
import type {
  AuthType,
  ProviderSetupInputs,
  TelemetryRuntimeConfig,
  TelemetrySettings,
} from '@qwen-code/qwen-code-core';
import { createBridgeFileSystemAdapter } from './bridge-file-system-adapter.js';
// Dynamic-imported below (not at module scope) so the serve fast-path bundle
// closure check doesn't trace create-sub-session's transitive deps through
// the run-qwen-serve chunk. The launcher is only needed after listen().
import { PathMutexRegistry } from './fs/path-mutex-registry.js';
import { isLoopbackBind } from './loopback-binds.js';
import { RUNTIME_STARTUP_CANCELLED_MESSAGE } from './runtime-startup-errors.js';
import { resolveWebShellDir } from './web-shell-resolver.js';
import {
  allowOriginCors,
  bearerAuth,
  denyBrowserOriginCors,
  hostAllowlist,
  parseAllowOriginPatterns,
} from './auth.js';
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
  CAPABILITIES_SCHEMA_VERSION,
  type CapabilitiesEnvelope,
  type ServeAuthProviderInstallRequest,
  type ServeAuthProviderInstallResult,
  type ServeOptions,
} from './types.js';
import type { WorkspaceFileSystemFactory } from './fs/index.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from './workspace-registry.js';
import type { PermissionPolicy } from '@qwen-code/acp-bridge';
import { getCliVersion } from '../utils/version.js';
import { getRateLimiter } from './rate-limit.js';
import type { AcpHttpHandle } from './acp-http/index.js';
import {
  allowOriginMode,
  listenerMaxConnections,
  parseDaemonStatusDetail,
  positiveFiniteOrNull,
  type DaemonStatusIssue,
  type DaemonPerfSnapshot,
  type DaemonStartupSnapshot,
  type DaemonStatusResponse,
} from './daemon-status.js';
import { DaemonMetricsRing, computeCpuPercent } from './daemon-metrics-ring.js';
import { createLargePipeFrameObserver } from './large-pipe-frame-observer.js';
import type {
  ChannelWorkerSupervisor,
  CreateChannelWorkerSupervisorOptions,
} from './channel-worker-supervisor.js';
import { QWEN_SERVER_TOKEN_ENV } from './channel-worker-env.js';
import { ChannelWebhookEnqueueError } from './channel-webhook-ipc.js';
import { channelSelectionNames } from './channel-selection.js';
import {
  finalizeStartupProfile,
  profileCheckpoint,
} from '../utils/startupProfiler.js';
import type { ServiceInfo } from '../commands/channel/pidfile.js';
import { sanitizeLogText } from '@qwen-code/channel-base';
import { isBrowserAutomationMcpAvailable } from './cdp-mcp-command.js';

// Reverse MCP channel; enabled only by explicit option or env opt-in.
const QWEN_SERVE_CLIENT_MCP_OVER_WS_ENV = 'QWEN_SERVE_CLIENT_MCP_OVER_WS';
// CDP tunnel; default-on for Chrome-extension origins or explicit env opt-in.
const QWEN_SERVE_CDP_TUNNEL_OVER_WS_ENV = 'QWEN_SERVE_CDP_TUNNEL_OVER_WS';
const QWEN_SERVE_PROMPT_DEADLINE_MS_ENV = 'QWEN_SERVE_PROMPT_DEADLINE_MS';
const QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS_ENV =
  'QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS';
const SHUTDOWN_FORCE_CLOSE_MS = 5_000;

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
const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION = 5;
const DEFAULT_EVENT_RING_SIZE = 8000;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
const WORKSPACE_SETTING_SCOPE =
  'Workspace' as import('../config/settings.js').SettingScope;

type RunQwenServeOptions = Omit<ServeOptions, 'token' | 'workspace'> & {
  token?: string;
  workspace?: string | string[];
};
type WorkspaceSettingsWrite =
  import('./workspace-service/types.js').WorkspaceSettingsWrite;
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

export function formatChannelWorkerDaemonUrl(
  host: string,
  port: number,
): string {
  const normalized = host.trim().toLowerCase();
  if (
    normalized === '' ||
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    normalized === '[::]'
  ) {
    return `http://127.0.0.1:${port}`;
  }
  return `http://${formatHostForUrl(host)}:${port}`;
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
 * Returning `undefined` is the bridge's signal to use its own
 * `getCurrentGeminiMdFilename()` default — so a malformed value
 * keeps the daemon alive rather than producing a garbage filename.
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
  /** Resolves when the listener has fully closed and the bridge is drained. */
  close(): Promise<void>;
}

type CoreRuntime = typeof import('@qwen-code/qwen-code-core');
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
  findCliEntryPath(): string;
};

let channelWorkerRuntimePromise: Promise<ChannelWorkerRuntime> | undefined;
async function loadChannelWorkerRuntime(): Promise<ChannelWorkerRuntime> {
  channelWorkerRuntimePromise ??= Promise.all([
    import('./channel-worker-supervisor.js'),
    import('../commands/channel/pidfile.js'),
    import('../commands/channel/cli-entry-path.js'),
  ])
    .then(([supervisor, pidfile, cliEntryPath]) => ({
      createChannelWorkerSupervisor: supervisor.createChannelWorkerSupervisor,
      channelServicePidfile: pidfile,
      findCliEntryPath: cliEntryPath.findCliEntryPath,
    }))
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
  return new Error(
    `Channel service is already running under ${owner} (PID ${info.pid}). Stop it before starting qwen serve --channel.`,
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
   * permissions in the interactive CLI is not yet replicated for
   * the daemon. Tests pin this to false to assert the gate is
   * actually wired through `runQwenServe → createServeApp →
   * fsFactory`.
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
  channelServicePidfile?: ChannelServicePidfile;
}

function shouldPreheatBridge(deps: RunQwenServeDeps): boolean {
  if (deps.preheatBridge !== undefined) return deps.preheatBridge;
  return process.env['VITEST_WORKER_ID'] === undefined;
}

let coreRuntimePromise: Promise<CoreRuntime> | undefined;
function loadCoreRuntime(): Promise<CoreRuntime> {
  coreRuntimePromise ??= import('@qwen-code/qwen-code-core');
  return coreRuntimePromise;
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
    workspaceModule,
    workspaceTypesModule,
    daemonStatusProviderModule,
    workspaceProvidersStatusModule,
    workspaceSkillsStatusModule,
    totalSessionAdmissionModule,
    workspaceRegistryModule,
  ] = await Promise.all([
    import('./server.js'),
    import('@qwen-code/acp-bridge/bridge'),
    import('@qwen-code/acp-bridge/spawnChannel'),
    import('./workspace-service/index.js'),
    import('./workspace-service/types.js'),
    import('./daemon-status-provider.js'),
    import('./workspace-providers-status.js'),
    import('./workspace-skills-status.js'),
    import('./total-session-admission.js'),
    import('./workspace-registry.js'),
  ]);
  return {
    createServeApp: serverModule.createServeApp,
    getActiveSseCount: serverModule.getActiveSseCount,
    resolveBoundWorkspacesFromIdeEnv:
      serverModule.resolveBoundWorkspacesFromIdeEnv,
    resolveBridgeFsFactory: serverModule.resolveBridgeFsFactory,
    createAcpSessionBridge: bridgeModule.createAcpSessionBridge,
    createSpawnChannelFactory: spawnChannelModule.createSpawnChannelFactory,
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
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return getAdvertisedServeFeatures(undefined, {
    requireAuth: opts.requireAuth === true,
    mcpPoolActive: opts.mcpPoolActive !== false,
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
    rateLimit: opts.rateLimit === true,
    reloadAvailable: true,
    channelReloadAvailable: opts.channelSelection !== undefined,
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

function createBootstrapServeApp(input: {
  opts: ServeOptions;
  getPort: () => number;
  boundWorkspace: string;
  startup: DaemonStartupSnapshot;
  daemonLog: DaemonLogger;
  qwenCodeVersion?: string;
  sessionShellCommandEnabled: boolean;
  sessionArtifactsPersistenceAvailable: boolean;
  permissionPolicy: PermissionPolicy | undefined;
  multiWorkspaceCapabilitiesRequireRuntime: boolean;
  getRuntimeError: () => string | undefined;
  getChannelWorkerSnapshot: () => ReturnType<
    ChannelWorkerSupervisor['snapshot']
  >;
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
    permissionPolicy,
    multiWorkspaceCapabilitiesRequireRuntime,
    getRuntimeError,
    getChannelWorkerSnapshot,
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

  const healthHandler = (_req: Request, res: Response): void => {
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
      res.status(503).json({
        error: runtimeError
          ? 'Daemon runtime failed to start'
          : 'Daemon runtime is still starting',
        code: runtimeError
          ? 'daemon_runtime_failed'
          : 'daemon_runtime_starting',
      });
      return;
    }
    res.status(200).json(
      createBootstrapCapabilities({
        opts,
        boundWorkspace,
        qwenCodeVersion,
        sessionShellCommandEnabled,
        sessionArtifactsPersistenceAvailable,
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
    const channelWorker = getChannelWorkerSnapshot();
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
    const response: DaemonStatusResponse = {
      v: 1,
      detail: detail.detail,
      generatedAt: new Date().toISOString(),
      status: runtimeFailed ? 'error' : 'warning',
      issues: [issue],
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
        ...(detail.detail === 'full' && daemonLog.getLogPath()
          ? { logPath: daemonLog.getLogPath() }
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
        promptDeadlineMs: positiveFiniteOrNull(opts.promptDeadlineMs),
        writerIdleTimeoutMs: positiveFiniteOrNull(opts.writerIdleTimeoutMs),
        channelIdleTimeoutMs: channelIdleTimeoutMs(opts.channelIdleTimeoutMs),
        sessionIdleTimeoutMs: sessionIdleTimeoutMs(opts.sessionIdleTimeoutMs),
        acpConnectionCap: null,
      },
      capabilities: {
        protocolVersions: getServeProtocolVersions(),
        features: currentServeFeaturesForRunQwenServe(
          opts,
          sessionShellCommandEnabled,
          sessionArtifactsPersistenceAvailable,
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
    const runtimeError = getRuntimeError();
    res.status(503).json({
      error: runtimeError
        ? 'Daemon runtime failed to start'
        : 'Daemon runtime is still starting',
      code: runtimeError ? 'daemon_runtime_failed' : 'daemon_runtime_starting',
    });
  });

  return app;
}

function createDelegatingServeApp(
  bootstrapApp: Application,
  getRuntimeApp: () => Application | undefined,
  options: {
    waitForDeferredRuntimeRoutes?: boolean;
    startRuntime?: () => void;
    runtimeReady?: Promise<void>;
    authenticateDeferredRuntimeRequest?: RequestHandler;
    authenticateDeferredChannelWebhookRequest?: RequestHandler;
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
        const webhookRequest = isChannelWebhookRequest(req);
        const authGate = webhookRequest
          ? (options.authenticateDeferredChannelWebhookRequest ??
            options.authenticateDeferredRuntimeRequest)
          : options.authenticateDeferredRuntimeRequest;
        if (authGate) {
          if (!runSynchronousRequestGate(authGate, req, res, next)) {
            return;
          }
        }
        options.startRuntime();
        try {
          await options.runtimeReady;
        } catch {
          // Fall through to the bootstrap app so it can report the startup error.
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
  workspace: string,
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

    const secret = readDeferredWebhookSecret(
      runtime,
      workspace,
      channelName,
      source,
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
): string | undefined {
  try {
    const rawConfig = runtime.loadChannelsConfig(workspace)[channelName];
    if (typeof rawConfig !== 'object' || rawConfig === null) {
      return undefined;
    }
    return runtime.parseChannelWebhookConfig(
      channelName,
      rawConfig as Record<string, unknown>,
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
export async function runQwenServe(
  optsIn: RunQwenServeOptions,
  deps: RunQwenServeDeps = {},
): Promise<RunHandle> {
  const runStartedAt = performance.now();
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
  preResolveServeFastPathHomeEnvOverrides();
  const daemonRuntimeBaseEnv: Readonly<NodeJS.ProcessEnv> = Object.freeze({
    ...process.env,
  });

  // Trim both sources. Common gotcha: `export QWEN_SERVER_TOKEN=$(cat
  // token.txt)` keeps the file's trailing `\n` in the env value, so the
  // hashed-then-compared token never matches what well-behaved clients
  // send. Every request returns the generic 401 with no breadcrumb
  // pointing at the whitespace, and operators chase ghosts. Trim once
  // at boot so the comparison is over what humans intended to set.
  const rawToken = optsIn.token ?? process.env[QWEN_SERVER_TOKEN_ENV];
  const token =
    typeof rawToken === 'string' && rawToken.trim().length > 0
      ? rawToken.trim()
      : undefined;
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
  const channelRuntime = opts.channelSelection
    ? await loadChannelWorkerRuntime()
    : undefined;
  const channelServicePidfile =
    deps.channelServicePidfile ?? channelRuntime?.channelServicePidfile;
  let channelPidfileReserved = false;
  const removeCurrentServePidfile = (): void => {
    if (!opts.channelSelection || !channelServicePidfile) return;
    if (!channelPidfileReserved) return;
    if (channelServicePidfile.removeServeServiceInfo) {
      if (channelServicePidfile.removeServeServiceInfo(process.pid)) {
        channelPidfileReserved = false;
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
      channelPidfileReserved = false;
    }
  };
  const reserveChannelServicePidfile = (): void => {
    if (!opts.channelSelection) return;
    if (!channelServicePidfile) {
      throw new Error('Channel service pidfile runtime is not available.');
    }
    const channelPidfileNames = channelSelectionNames(opts.channelSelection);
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
              throw new Error(
                'Channel service is already starting. Retry after the current startup finishes.',
              );
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
            'token gates API routes; /health and /demo remain pre-auth ' +
            'on loopback unless --require-auth is set)'
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

  const validateAndCanonicalizeWorkspace = (workspace: string): string => {
    if (!path.isAbsolute(workspace)) {
      throw new Error(
        `Invalid --workspace "${workspace}": must be an absolute path.`,
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
  };

  // Resolve the bound workspace list. The first explicit workspace remains the
  // primary workspace for legacy APIs; later workspaces are sessions-only
  // runtimes.
  const workspaceInputs = rawWorkspaces.map((workspace) => ({
    raw: workspace,
    cwd: validateAndCanonicalizeWorkspace(workspace),
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
  const daemonLog: DaemonLogger = initDaemonLogger({
    boundWorkspace,
    baseDir: daemonLogBaseDir,
  });
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
  const childEnvOverrides: Record<string, string | undefined> = {
    QWEN_SERVE_MCP_CLIENT_BUDGET:
      opts.mcpClientBudget !== undefined
        ? String(opts.mcpClientBudget)
        : undefined,
    QWEN_SERVE_MCP_BUDGET_MODE: opts.mcpBudgetMode,
    QWEN_SERVE_CDP_TUNNEL_OVER_WS: opts.cdpTunnelOverWs ? '1' : undefined,
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
  let runtimeApp: Application | undefined;
  let runtimeAppForCleanup: Application | undefined;
  let bridgeRef: AcpSessionBridge | undefined = deps.bridge;
  const internalRuntimeBridgesForCleanup: AcpSessionBridge[] = [];
  let daemonEventLoopMonitor:
    | ReturnType<CoreRuntime['startEventLoopLagMonitor']>
    | undefined;
  // Daemon Status metrics-ring sampler: a fixed-cadence timer that seals a
  // bucket plus the window-scoped event-loop histogram it resets each seal.
  // Torn down together with the event-loop monitor on runtime restart/stop.
  let daemonMetricsSampler: { dispose(): void } | undefined;
  let runtimeStartupError: string | undefined;
  let runtimeStarting: Promise<void> | undefined;
  let markRuntimeReady!: () => void;
  let markRuntimeFailed!: (err: Error) => void;
  let runtimeStartupSettled = false;
  let startRuntimeAfterHealth: (() => void) | undefined;
  let startRuntimeForRequest: (() => void) | undefined;
  const deferRuntimeUntilFirstHealth =
    deps.resolveOnListen === true && deps.deferRuntimeUntilFirstHealth === true;
  const runtimeReady = new Promise<void>((resolve, reject) => {
    markRuntimeReady = resolve;
    markRuntimeFailed = reject;
  });
  void runtimeReady.catch(() => {});
  const disposeDaemonEventLoopMonitor = (): void => {
    daemonEventLoopMonitor?.dispose();
    daemonEventLoopMonitor = undefined;
    daemonMetricsSampler?.dispose();
    daemonMetricsSampler = undefined;
  };
  let channelWorker: ChannelWorkerSupervisor =
    createDisabledChannelWorkerSupervisor();
  const getChannelWorkerSnapshot = () => channelWorker.snapshot();
  const reloadChannelWorker = () => channelWorker.restart();
  const writeChannelWorkerPidfile = (
    snapshot = channelWorker.snapshot(),
    options: { clearWorkerPid?: boolean } = {},
  ): void => {
    if (!opts.channelSelection || !channelServicePidfile) return;
    try {
      channelServicePidfile.writeServeServiceInfo({
        channels: snapshot.channels,
        servePid: process.pid,
        ...(!options.clearWorkerPid && snapshot.pid !== undefined
          ? { workerPid: snapshot.pid }
          : {}),
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
  const getRuntimeBridgesForCleanup = (): AcpSessionBridge[] => {
    const appForCleanup = runtimeApp ?? runtimeAppForCleanup;
    const registry = appForCleanup?.locals?.['workspaceRegistry'] as
      | WorkspaceRegistry
      | undefined;
    const bridges = [
      ...(registry ? registry.list().map((runtime) => runtime.bridge) : []),
      ...(bridgeRef ? [bridgeRef] : []),
      ...internalRuntimeBridgesForCleanup,
    ];
    return [...new Set(bridges)];
  };

  const buildRuntime = async (): Promise<{
    app: Application;
    bridge: AcpSessionBridge;
  }> => {
    const [runtime, core, settingsRuntime, resolvedCliVersion] =
      await Promise.all([
        loadServeRuntimeModules(),
        loadCoreRuntime(),
        loadSettingsRuntimeModules(),
        cliVersionPromise,
      ]);
    cliVersion = resolvedCliVersion;
    let runtimeBootSettings:
      | ReturnType<SettingsRuntime['loadSettings']>
      | undefined;
    try {
      runtimeBootSettings =
        settingsRuntime.settings.loadSettings(boundWorkspace);
    } catch (err) {
      writeStderrLine(
        `qwen serve: could not read full settings for runtime startup ` +
          `(${err instanceof Error ? err.message : String(err)}); falling back to defaults.`,
      );
    }
    const trustedWorkspace =
      deps.trustedWorkspace ??
      (runtimeBootSettings
        ? settingsRuntime.trustedFolders.getWorkspaceTrustStatus(
            runtimeBootSettings.merged,
            boundWorkspace,
          ).effective.state === 'trusted'
        : true);
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
        )
      : {
          effectiveEnv: { ...daemonRuntimeBaseEnv },
          overlayKeys: Object.freeze([] as string[]),
          envFilePaths: Object.freeze([] as string[]),
          envFileReadFailed: false,
          envFileReadFailures: Object.freeze([]),
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
    const runtimeEffectiveEnv: NodeJS.ProcessEnv = {
      ...runtimeEnvSnapshot.effectiveEnv,
    };
    const replaceRuntimeEffectiveEnv = (
      nextEnv: Readonly<NodeJS.ProcessEnv>,
    ): void => {
      for (const key of Object.keys(runtimeEffectiveEnv)) {
        delete runtimeEffectiveEnv[key];
      }
      Object.assign(runtimeEffectiveEnv, nextEnv);
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
    core.initializeTelemetry(
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
        // for the LLM-latency percentiles.
        tokenUsage(inputTokens, outputTokens, durationMs) {
          metricsRing.recordTokens(inputTokens, outputTokens);
          if (typeof durationMs === 'number') {
            metricsRing.recordLlmDuration(durationMs);
          }
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
        if (!runtimeBootSettings) {
          daemonLog.warn(
            'excluding secondary workspace root because trust settings are unavailable',
            { workspace },
          );
          return false;
        }
        const trustedSecondary =
          settingsRuntime.trustedFolders.getWorkspaceTrustStatus(
            runtimeBootSettings.merged,
            workspace,
          ).effective.state === 'trusted';
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
    const sharedPathLocks = new PathMutexRegistry();
    const fsFactory = runtime.resolveBridgeFsFactory({
      // Secondary roots share a write-capable factory only after their own
      // folder trust check passes; untrusted secondary roots stay outside.
      boundWorkspaces,
      injected: deps.fsFactory,
      trusted: trustedWorkspace,
      emit: deps.fsAuditEmit,
      pathLocks: sharedPathLocks,
      ...(customIgnoreFiles !== undefined ? { customIgnoreFiles } : {}),
    });
    const routeFsFactory = runtime.resolveBridgeFsFactory({
      // REST routes still return primary-relative paths, so keep their
      // filesystem boundary primary-only until responses carry root IDs.
      boundWorkspaces: [boundWorkspace],
      trusted: trustedWorkspace,
      emit: deps.fsAuditEmit,
      pathLocks: sharedPathLocks,
      ...(customIgnoreFiles !== undefined ? { customIgnoreFiles } : {}),
    });
    const channelFactory = runtime.createSpawnChannelFactory({
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
      ...(opts.experimentalLsp === true
        ? { extraArgs: ['--experimental-lsp'] }
        : {}),
    });
    const statusProvider = runtime.createDaemonStatusProvider({
      env: runtimeEffectiveEnv,
    });
    const workspaceProvidersStatusProvider =
      runtime.createWorkspaceProvidersStatusProvider({
        env: runtimeEffectiveEnv,
      });
    const workspaceSkillsStatusProvider =
      runtime.createWorkspaceSkillsStatusProvider();
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
    const persistDisabledToolsFn = (
      workspace: string,
      toolName: string,
      enabled: boolean,
    ): Promise<void> =>
      withSettingsLock(workspace, async () => {
        const fresh = settingsRuntime.settings.loadSettings(workspace);
        const wsScope = fresh.forScope(WORKSPACE_SETTING_SCOPE).settings;
        const wsDisabled = wsScope.tools?.disabled;
        const current = Array.isArray(wsDisabled)
          ? wsDisabled.filter((v): v is string => typeof v === 'string')
          : [];
        const next = new Set(current);
        if (enabled) next.delete(toolName);
        else next.add(toolName);
        fresh.setValue(
          WORKSPACE_SETTING_SCOPE,
          'tools.disabled',
          [...next].sort(),
        );
      });
    const persistSettingFn = (
      workspace: string,
      scope: import('../config/settings.js').SettingScope,
      key: string,
      value: unknown,
    ) =>
      withSettingsLock(workspace, async () => {
        const fresh = settingsRuntime.settings.loadSettings(workspace);
        fresh.setValue(scope, key, value);
        return fresh;
      });
    const persistSettingsFn = (
      workspace: string,
      writes: WorkspaceSettingsWrite[],
    ): Promise<void> =>
      withSettingsLock(workspace, async () => {
        const fresh = settingsRuntime.settings.loadSettings(workspace);
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
          fresh.setValues(writes, (scope) => {
            committedScopes.add(scope);
            committed += writesByScope.get(scope) ?? 0;
          });
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
    const { createSubSessionLauncher } = await import(
      './create-sub-session.js'
    );
    // Late-binds the bridge (constructed just below) via `() => bridgeRef`. Only
    // wired on the daemon-created bridge — an injected `deps.bridge` (embed/test)
    // brings its own options.
    const subSessionLauncher = createSubSessionLauncher({
      getBridge: () => bridgeRef,
      boundWorkspace,
    });
    const bridge =
      deps.bridge ??
      runtime.createAcpSessionBridge({
        // Reverse tool channel: let `BridgeClient.extMethod` reach the WS
        // connection that hosts a named client MCP server (#5626).
        clientMcpSender: clientMcpSenderRegistry.lookup,
        onCreateSubSession: subSessionLauncher.launch,
        maxSessions: opts.maxSessions,
        freshSessionAdmission: totalSessionAdmission.admit,
        sessionLifecycle: sessionOwnerIndex.handleBridgeSessionLifecycle,
        ...(opts.maxPendingPromptsPerSession !== undefined
          ? { maxPendingPromptsPerSession: opts.maxPendingPromptsPerSession }
          : {}),
        ...(opts.eventRingSize !== undefined
          ? { eventRingSize: opts.eventRingSize }
          : {}),
        ...(opts.compactedReplayMaxBytes !== undefined
          ? { compactedReplayMaxBytes: opts.compactedReplayMaxBytes }
          : {}),
        ...(opts.channelIdleTimeoutMs !== undefined
          ? { channelIdleTimeoutMs: opts.channelIdleTimeoutMs }
          : {}),
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
        sessionShellCommandEnabled,
        childEnvOverrides,
        channelFactory,
        onDiagnosticLine: diagnosticSink,
        telemetry: daemonTelemetry,
        ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
        ...(permissionConsensusQuorum !== undefined
          ? { permissionConsensusQuorum }
          : {}),
        permissionAudit: permissionAuditPublisher,
        statusProvider,
        fileSystem: createBridgeFileSystemAdapter(fsFactory),
        persistApprovalMode: (workspace, mode) =>
          withSettingsLock(workspace, async () => {
            const fresh = settingsRuntime.settings.loadSettings(workspace);
            fresh.setValue(WORKSPACE_SETTING_SCOPE, 'tools.approvalMode', mode);
          }),
      });
    if (!deps.bridge) {
      bridgeRef = bridge;
      internalRuntimeBridgesForCleanup.push(bridge);
    }
    runtimeBridges.push(bridge);
    const workspaceService = runtime.createDaemonWorkspaceService({
      boundWorkspace,
      contextFilename: contextFilenameForInit ?? 'QWEN.md',
      statusProvider,
      workspaceProvidersStatusProvider,
      workspaceSkillsStatusProvider,
      isChannelLive: () => bridge.isChannelLive(),
      persistDisabledTools: persistDisabledToolsFn,
      persistSetting: persistSettingFn,
      persistSettings: persistSettingsFn,
      preheatAcpChild: () => bridge.preheat(),
      reloadDaemonEnv: (workspace) =>
        withSettingsLock(workspace, async () => {
          const fresh = settingsRuntime.settings.loadSettings(workspace, {
            skipLoadEnvironment: true,
          });
          const result = settingsRuntime.settings.reloadEnvironment(
            fresh.merged,
            workspace,
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
      publishWorkspaceEvent: (event) => bridge.publishWorkspaceEvent(event),
    });

    const workspaceRuntimes: WorkspaceRuntime[] = [
      {
        workspaceId: daemonWorkspaceHash,
        workspaceCwd: boundWorkspace,
        primary: true,
        trusted: trustedWorkspace,
        env: primaryRuntimeEnv,
        bridge,
        workspaceService,
        routeFileSystemFactory: routeFsFactory,
        clientMcpSenderRegistry,
      },
    ];

    const createRuntimeEnvMetadata = (
      workspace: string,
      settings: ReturnType<SettingsRuntime['loadSettings']> | undefined,
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
      replace: (nextEnv: Readonly<NodeJS.ProcessEnv>) => void;
    } => {
      const snapshot = settings
        ? settingsRuntime.environment.buildRuntimeEnvironment(
            settings.merged,
            workspace,
            daemonRuntimeBaseEnv,
          )
        : {
            effectiveEnv: { ...daemonRuntimeBaseEnv },
            overlayKeys: Object.freeze([] as string[]),
            envFilePaths: Object.freeze([] as string[]),
            envFileReadFailed: false,
            envFileReadFailures: Object.freeze([]),
          };
      logRuntimeEnvFileReadFailures(workspace, snapshot);
      const effectiveEnv: NodeJS.ProcessEnv = { ...snapshot.effectiveEnv };
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
        replace(nextEnv) {
          for (const key of Object.keys(effectiveEnv)) {
            delete effectiveEnv[key];
          }
          Object.assign(effectiveEnv, nextEnv);
        },
      };
    };

    // Collects stop() callbacks from every per-workspace sub-session launcher
    // (primary + secondaries). Called during shutdown so no new sub-sessions
    // are admitted while bridges are being torn down.
    const subSessionStoppers: Array<() => void> = [];

    for (const workspaceInput of workspaceInputs.slice(1)) {
      let secondarySettings:
        | ReturnType<SettingsRuntime['loadSettings']>
        | undefined;
      try {
        secondarySettings = settingsRuntime.settings.loadSettings(
          workspaceInput.cwd,
        );
      } catch (err) {
        writeStderrLine(
          `qwen serve: could not read full settings for secondary workspace ` +
            `${workspaceInput.cwd} (${err instanceof Error ? err.message : String(err)}); ` +
            `falling back to defaults.`,
        );
      }
      const secondaryTrusted = secondarySettings
        ? settingsRuntime.trustedFolders.getWorkspaceTrustStatus(
            secondarySettings.merged,
            workspaceInput.cwd,
          ).effective.state === 'trusted'
        : false;
      if (!secondaryTrusted) {
        daemonLog.warn('secondary workspace is not trusted', {
          workspace: workspaceInput.cwd,
          trustSettingsAvailable: secondarySettings !== undefined,
        });
      }
      const secondaryEnv = createRuntimeEnvMetadata(
        workspaceInput.cwd,
        secondarySettings,
      );
      const secondaryWorkspaceHash = core.hashDaemonWorkspace(
        workspaceInput.cwd,
      );
      const secondaryStatusProvider = runtime.createDaemonStatusProvider({
        env: secondaryEnv.effectiveEnv,
      });
      const secondaryBridgeFsFactory = runtime.resolveBridgeFsFactory({
        boundWorkspaces: [workspaceInput.cwd],
        trusted: secondaryTrusted,
        emit: deps.fsAuditEmit,
        pathLocks: sharedPathLocks,
        ...(customIgnoreFiles !== undefined ? { customIgnoreFiles } : {}),
      });
      const secondaryChannelFactory = runtime.createSpawnChannelFactory({
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
        ...(opts.experimentalLsp === true
          ? { extraArgs: ['--experimental-lsp'] }
          : {}),
      });
      const secondaryClientMcpSenderRegistry = new ClientMcpSenderRegistry();
      // Wire sub-session support for the secondary workspace too — without
      // this, isolated scheduled tasks and create_sub_session calls from
      // sessions bound to a secondary workspace hit methodNotFound.
      // eslint-disable-next-line prefer-const -- assigned once after bridge creation; `let` required because the launcher closure captures it before the assignment.
      let secondaryBridgeRef:
        | ReturnType<typeof runtime.createAcpSessionBridge>
        | undefined;
      const secondarySubSessionLauncher = createSubSessionLauncher({
        getBridge: () => secondaryBridgeRef,
        boundWorkspace: workspaceInput.cwd,
      });
      const secondaryBridge = runtime.createAcpSessionBridge({
        clientMcpSender: secondaryClientMcpSenderRegistry.lookup,
        onCreateSubSession: secondarySubSessionLauncher.launch,
        maxSessions: opts.maxSessions,
        freshSessionAdmission: totalSessionAdmission.admit,
        sessionLifecycle: sessionOwnerIndex.handleBridgeSessionLifecycle,
        ...(opts.maxPendingPromptsPerSession !== undefined
          ? { maxPendingPromptsPerSession: opts.maxPendingPromptsPerSession }
          : {}),
        ...(opts.eventRingSize !== undefined
          ? { eventRingSize: opts.eventRingSize }
          : {}),
        ...(opts.compactedReplayMaxBytes !== undefined
          ? { compactedReplayMaxBytes: opts.compactedReplayMaxBytes }
          : {}),
        ...(opts.channelIdleTimeoutMs !== undefined
          ? { channelIdleTimeoutMs: opts.channelIdleTimeoutMs }
          : {}),
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
        sessionShellCommandEnabled,
        childEnvOverrides,
        channelFactory: secondaryChannelFactory,
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
        fileSystem: createBridgeFileSystemAdapter(secondaryBridgeFsFactory),
        persistApprovalMode: (workspace, mode) =>
          withSettingsLock(workspace, async () => {
            const fresh = settingsRuntime.settings.loadSettings(workspace);
            fresh.setValue(WORKSPACE_SETTING_SCOPE, 'tools.approvalMode', mode);
          }),
      });
      secondaryBridgeRef = secondaryBridge;
      runtimeBridges.push(secondaryBridge);
      internalRuntimeBridgesForCleanup.push(secondaryBridge);
      subSessionStoppers.push(secondarySubSessionLauncher.stop);
      const secondaryWorkspaceService = runtime.createDaemonWorkspaceService({
        boundWorkspace: workspaceInput.cwd,
        contextFilename: contextFilenameForInit ?? 'QWEN.md',
        statusProvider: secondaryStatusProvider,
        workspaceProvidersStatusProvider:
          runtime.createWorkspaceProvidersStatusProvider({
            env: secondaryEnv.effectiveEnv,
          }),
        workspaceSkillsStatusProvider:
          runtime.createWorkspaceSkillsStatusProvider(),
        isChannelLive: () => secondaryBridge.isChannelLive(),
        preheatAcpChild: () => secondaryBridge.preheat(),
        persistDisabledTools: persistDisabledToolsFn,
        persistSetting: persistSettingFn,
        persistSettings: persistSettingsFn,
        reloadDaemonEnv: (workspace) =>
          withSettingsLock(workspace, async () => {
            const fresh = settingsRuntime.settings.loadSettings(workspace, {
              skipLoadEnvironment: true,
            });
            const result = settingsRuntime.settings.reloadEnvironment(
              fresh.merged,
              workspace,
            );
            try {
              const refreshedRuntimeEnv =
                settingsRuntime.environment.buildRuntimeEnvironment(
                  fresh.merged,
                  workspace,
                  daemonRuntimeBaseEnv,
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
      workspaceRuntimes.push({
        workspaceId: secondaryWorkspaceHash,
        workspaceCwd: workspaceInput.cwd,
        primary: false,
        trusted: secondaryTrusted,
        env: secondaryEnv.metadata,
        bridge: secondaryBridge,
        workspaceService: secondaryWorkspaceService,
        routeFileSystemFactory: secondaryBridgeFsFactory,
        clientMcpSenderRegistry: secondaryClientMcpSenderRegistry,
      });
    }

    const workspaceRegistry: WorkspaceRegistry =
      runtime.createWorkspaceRegistry(workspaceRuntimes, {
        sessionOwnerIndex,
      });

    core.registerDaemonGaugeCallbacks({
      sessionCount: () =>
        workspaceRegistry
          .list()
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
        const child = bridge.getChildResourceSnapshot?.();
        // Only poll the child's resources when someone is watching: the
        // staleness guard already drops the reading to 0 when idle, so gating
        // avoids a 5s RPC round-trip (pipe + child CPU) for a chart nobody has
        // open.
        if (runtime.getActiveSseCount() > 0 || (acp?.wsStreams ?? 0) > 0) {
          void bridge.refreshChildResource?.();
        }
        metricsRing.sample(nowMs, {
          cpuPercent,
          rssBytes: mem.rss,
          heapUsedBytes: mem.heapUsed,
          activeSessions: workspaceRegistry
            .list()
            .reduce((sum, item) => sum + item.bridge.sessionCount, 0),
          activePrompts: workspaceRegistry
            .list()
            .reduce(
              (sum, item) => sum + (item.bridge.activePromptCount ?? 0),
              0,
            ),
          queuedPrompts: workspaceRegistry
            .list()
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

    const app = runtime.createServeApp(opts, () => actualPort, {
      workspaceRegistry,
      bridge,
      webShellDir,
      boundWorkspace,
      qwenCodeVersion: resolvedCliVersion,
      startup,
      // The real long-running daemon keeps scheduled-task sessions resident
      // (keepalive) and reloads them on boot (rehydration). Off by default so
      // direct createServeApp embeds/tests don't spawn sessions.
      manageScheduledTaskSessions: true,
      fsFactory: routeFsFactory,
      primaryWorkspaceTrusted: trustedWorkspace,
      primaryRuntimeEnv,
      daemonLog,
      getChannelWorkerSnapshot,
      enqueueChannelWebhookTask: (task) =>
        channelWorker.enqueueWebhookTask(task),
      // Gate both the `channel_reload` capability and the reload route on the
      // presence of this dep, so it is advertised only when a channel worker
      // exists to reload.
      ...(opts.channelSelection ? { reloadChannelWorker } : {}),
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
      recordDaemonRequest: (durationMs, statusCode) =>
        metricsRing.recordRequest(durationMs, statusCode),
      workspace: workspaceService,
      // Reverse tool channel (#5626): the SAME registry wired into `bridge` above,
      // so the WS provider and the child-answering bridge share one sender map.
      clientMcpSenderRegistry,
      persistDisabledTools: persistDisabledToolsFn,
      persistSetting: persistSettingFn,
      persistSettings: persistSettingsFn,
      sessionArtifactsPersistenceAvailable:
        sessionArtifactsPersistenceAvailableFromSettings(
          runtimeBootSettings?.merged,
        ),
      installAuthProvider: (req) =>
        withSettingsLock(
          boundWorkspace,
          async (): Promise<ServeAuthProviderInstallResult> => {
            const provider = core.findProviderById(req.providerId);
            if (!provider) {
              throw new Error(`Unsupported auth provider: ${req.providerId}`);
            }
            const inputs = buildProviderSetupInputs(req, provider, {
              getDefaultModelIds: core.getDefaultModelIds,
              resolveBaseUrl: core.resolveBaseUrl,
            });
            const plan = core.buildInstallPlan(provider, inputs);
            const fresh = settingsRuntime.settings.loadSettings(boundWorkspace);
            const adapter =
              settingsRuntime.loadedSettingsAdapter.createLoadedSettingsAdapter(
                fresh,
              );
            await core.applyProviderInstallPlan(plan, {
              settings: adapter,
              doRefreshAuth: false,
            });
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
    // Park the sub-session launcher's stop on app.locals so the close handler
    // can flip it off before tearing down the bridge it spawns into (symmetric
    // with stopScheduledTaskKeepalive). Defensive: a launch during drain would
    // otherwise just fail its spawnOrAttach against the shutting-down bridge.
    (
      app.locals as { subSessionStoppers?: Array<() => void> }
    ).subSessionStoppers = subSessionStoppers;
    subSessionStoppers.push(subSessionLauncher.stop);
    return { app, bridge };
  };

  if (deps.bridge) {
    const runtime = await buildRuntime();
    runtimeAppForCleanup = runtime.app;
    runtimeApp = runtime.app;
    bridgeRef = runtime.bridge;
    if (!opts.channelSelection) {
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
    permissionPolicy,
    multiWorkspaceCapabilitiesRequireRuntime: workspaceInputs.length > 1,
    getRuntimeError: () => runtimeStartupError,
    getChannelWorkerSnapshot,
    onHealthServed: deferRuntimeUntilFirstHealth
      ? () => startRuntimeAfterHealth?.()
      : undefined,
  });
  const deferredChannelWebhookAuth = deferRuntimeUntilFirstHealth
    ? createDeferredChannelWebhookAuth(
        boundWorkspace,
        await loadChannelWebhookConfigRuntime(),
        daemonLog,
      )
    : undefined;
  const app =
    runtimeApp ??
    createDelegatingServeApp(bootstrapApp, () => runtimeApp, {
      waitForDeferredRuntimeRoutes: deferRuntimeUntilFirstHealth,
      startRuntime: () => startRuntimeForRequest?.(),
      runtimeReady,
      authenticateDeferredRuntimeRequest: bearerAuth(opts.token),
      authenticateDeferredChannelWebhookRequest: deferredChannelWebhookAuth,
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

  reserveChannelServicePidfile();

  return await new Promise<RunHandle>((resolve, reject) => {
    // When TLS is configured, wrap the Express app in an HTTPS listener
    // (`https.Server extends http.Server`, so everything downstream —
    // `server.maxConnections`, `server.address()`, `attachServer(server)`,
    // graceful close — is unchanged). Otherwise `app.listen()` keeps the
    // existing plain-HTTP path bit-for-bit.
    const onListening = () => {
      startup.listenerReadyAt = new Date().toISOString();
      startup.processToListenMs = Math.round(process.uptime() * 1000);
      startup.runQwenServeToListenMs = Math.round(
        performance.now() - runStartedAt,
      );
      profileCheckpoint('serve_listener_ready');
      finalizeStartupProfile(`serve-${process.pid}`);

      // Listener-level connection cap, set inside the listen callback
      // because Node only exposes the underlying `Server` after
      // `app.listen()` returns. Each session's `EventBus` already
      // refuses to admit more than `DEFAULT_MAX_SUBSCRIBERS` (64), but
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
      try {
        if (opts.channelSelection) {
          const createSupervisor =
            deps.channelWorkerSupervisorFactory ??
            channelRuntime?.createChannelWorkerSupervisor;
          const findCliEntryPath = channelRuntime?.findCliEntryPath;
          if (!createSupervisor || !findCliEntryPath) {
            throw new Error(
              'Channel worker supervisor runtime is not available.',
            );
          }
          channelWorker = createSupervisor({
            cliEntryPath: findCliEntryPath(),
            daemonUrl: formatChannelWorkerDaemonUrl(opts.hostname, actualPort),
            ...(token ? { daemonToken: token } : {}),
            workspace: boundWorkspace,
            selection: opts.channelSelection,
            onReady: (snapshot) => {
              writeChannelWorkerPidfile(snapshot);
            },
            onLog: ({ stream, line }) => {
              const message = `channel worker ${stream}: ${line}`;
              if (stream === 'stderr') {
                daemonLog.warn(message);
              } else {
                daemonLog.info(message);
              }
            },
            onExit: (snapshot) => {
              daemonLog.warn(
                `channel worker exited (state=${snapshot.state}, pid=${snapshot.pid ?? 'unknown'}, ` +
                  `code=${snapshot.exitCode ?? 'null'}, signal=${snapshot.signal ?? 'null'}, ` +
                  `error=${snapshot.error ?? 'none'}, restartCount=${snapshot.restartCount ?? 0}, ` +
                  `nextRestartAt=${snapshot.nextRestartAt ?? 'none'}, ` +
                  `staleHeartbeatAt=${snapshot.staleHeartbeatAt ?? 'none'})`,
              );
              writeChannelWorkerPidfile(snapshot, { clearWorkerPid: true });
            },
          });
        }
      } catch (err) {
        removeCurrentServePidfile();
        const error = err instanceof Error ? err : new Error(String(err));
        server.close((closeErr) => {
          if (closeErr) {
            daemonLog.error(
              'server close after channel worker setup error failed',
              closeErr,
            );
          }
          reject(error);
        });
        return;
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
      const stopChannelWorkerAfterFailedStartup = async (): Promise<void> => {
        await channelWorker.stop().catch((stopErr) => {
          daemonLog.error(
            'channel worker stop after runtime startup error failed',
            stopErr instanceof Error ? stopErr : null,
          );
        });
      };
      const failRuntimeStartup = async (
        err: unknown,
        bridgeForCleanup?: AcpSessionBridge,
      ): Promise<void> => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (runtimeStartupSettled) {
          await shutdownBridgeAfterFailedStartup(bridgeForCleanup);
          return;
        }
        runtimeStartupSettled = true;
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
        await stopChannelWorkerAfterFailedStartup();
        disposeDaemonEventLoopMonitor();
        removeCurrentServePidfile();
        const bridgesForCleanup = bridgeForCleanup
          ? [bridgeForCleanup, ...getRuntimeBridgesForCleanup()]
          : getRuntimeBridgesForCleanup();
        for (const bridge of [...new Set(bridgesForCleanup)]) {
          await shutdownBridgeAfterFailedStartup(bridge);
        }
        markRuntimeFailed(error);
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
      const completeRuntimeStartup = async (): Promise<void> => {
        if (runtimeStartupSettled) return;
        if (opts.channelSelection) {
          await channelWorker.start();
          if (runtimeStartupSettled) return;
        }
        if (runtimeStartupSettled) return;
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
      const startRuntime = (): void => {
        if (runtimeStarting) return;
        armRuntimeStartupTimer();
        clearRuntimeStartAfterHealthTimer();
        clearRuntimeStartFallbackTimer();
        runtimeStarting = buildRuntime()
          .then(async (runtime) => {
            if (runtimeStartupSettled) {
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
            runtimeApp = runtime.app;
            const acpHandle = runtime.app.locals?.['acpHandle'] as
              | AcpHttpHandle
              | undefined;
            acpHandle?.attachServer?.(server);
            if (shouldPreheat) {
              startBridgePreheat(runtime.bridge);
            }
            await completeRuntimeStartup();
          })
          .catch((err) => failRuntimeStartup(err));
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
            channelWorker.killAllSync();
            for (const runtimeBridge of getRuntimeBridgesForCleanup()) {
              runtimeBridge.killAllSync();
            }
            removeCurrentServePidfile();
          } catch (err) {
            daemonLog.error(
              'force-kill error',
              err instanceof Error ? err : null,
            );
          }
          await daemonLog.flush().catch(() => {});
          process.exit(1);
          return;
        }
        daemonLog.warn(`received ${signal}, draining`);
        try {
          await handle.close();
          await daemonLog.flush();
          process.exit(0);
        } catch (err) {
          daemonLog.error('shutdown error', err instanceof Error ? err : null);
          await daemonLog.flush().catch(() => {});
          process.exit(1);
        }
      };
      const onUncaughtExceptionMonitor = () => {
        if (process.listenerCount('uncaughtException') === 0) {
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
        close: () => {
          // Idempotent: cache the in-flight (or settled) close promise so
          // overlapping calls (e.g. test harness + signal handler firing
          // simultaneously) all observe the same drain cycle. Without this
          // each caller would arm its own force-close timer + invoke
          // bridge.shutdown / server.close redundantly.
          if (closePromise) return closePromise;
          closePromise = new Promise<void>((res, rej) => {
            shuttingDown = true;
            // Stop the scheduled-task keepalive timer before tearing down the
            // bridge it heartbeats. It's already unref()'d so it can't hold the
            // process open, but stopping it here keeps it from firing against a
            // disposed bridge (matters for embedders that don't process.exit).
            (
              app.locals as { stopScheduledTaskKeepalive?: () => void }
            ).stopScheduledTaskKeepalive?.();
            // Same rationale for the create_sub_session launchers: stop accepting
            // new sub-session spawns before the bridges are torn down. Calls
            // every workspace's launcher stop (primary + secondaries).
            const stoppers = (
              app.locals as { subSessionStoppers?: Array<() => void> }
            ).subSessionStoppers;
            if (stoppers) {
              for (const stop of stoppers) stop();
            }
            clearRuntimeStartAfterHealthTimer();
            clearRuntimeStartFallbackTimer();
            cancelDeferredRuntimeStartup();
            // NOTE: the SIGINT/SIGTERM handlers stay attached during the
            // drain so a second signal can take the explicit force-exit path
            // above. Detaching them up front would leave Node's default signal
            // behavior in charge and could orphan agent children. We detach
            // AFTER drain completes (`finish` below).

            // Two-phase shutdown:
            //   1. `bridge.shutdown()` — tears down agent children with
            //      its own internal `KILL_HARD_DEADLINE_MS` (10s) so
            //      a wedged child can't block forever. We wait
            //      unconditionally; the bridge bounds itself.
            //   2. `server.close()` — drains in-flight HTTP connections
            //      (long-lived SSE subscribers especially). This is
            //      what `SHUTDOWN_FORCE_CLOSE_MS` actually protects:
            //      a single hung SSE consumer would otherwise pin
            //      the listener open forever.
            //
            // Crucially, the force timer is armed AFTER bridge.shutdown
            // resolves, not at the start of the whole sequence. An
            // earlier version raced both phases against the same 5s
            // timer; if the bridge took 5–10s to kill its children
            // (e.g. SIGTERM grace period), the timer fired first,
            // resolved this promise, and `process.exit(0)` ran while
            // the bridge was still tearing children down — orphaning
            // any that hadn't yet hit `KILL_HARD_DEADLINE_MS`.
            let settled = false;
            // Track bridge.shutdown failures so close()
            // doesn't silently report success when the bridge
            // teardown itself failed. The contract says "resolves
            // when the listener has fully closed and the bridge is
            // drained" — propagating the failure lets `onSignal`
            // exit 1 instead of 0, and lets embedders react.
            let bridgeShutdownError: Error | undefined;
            const finish = (err?: Error | null) => {
              if (settled) return;
              settled = true;
              process.removeListener('SIGINT', onSignal);
              process.removeListener('SIGTERM', onSignal);
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
                .finally(() => daemonLog.flush().catch(() => {}))
                .finally(() => {
                  // Server.close error takes precedence (operator-visible
                  // listener problem); fall back to the bridge error
                  // captured during shutdown if any.
                  const finalErr = err ?? bridgeShutdownError;
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
                // Dispose the device-flow registry FIRST so any
                // in-flight IdP poll is cancelled and timers are cleared
                // before the bridge tear-down (which would otherwise race
                // with the still-polling registry on shared HTTP agents).
                const deviceFlowRegistry = appForCleanup
                  ? getDeviceFlowRegistry(appForCleanup)
                  : undefined;
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
                // Dispose ACP handle (close WebSocketServer + send close frames).
                const acpHandle = appForCleanup?.locals?.['acpHandle'] as
                  | AcpHttpHandle
                  | undefined;
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
                // Dispose rate limiter (clear GC timer + buckets).
                const rl = appForCleanup
                  ? getRateLimiter(appForCleanup)
                  : undefined;
                if (rl) {
                  rl.setDraining(true);
                  rl.dispose();
                }
                disposeDaemonEventLoopMonitor();
                // The worker owns daemon-backed sessions; disconnect it before
                // tearing down the ACP bridge it is attached to.
                await channelWorker.stop().catch((err) => {
                  daemonLog.error(
                    'channel worker stop error',
                    err instanceof Error ? err : null,
                  );
                });
                removeCurrentServePidfile();
                for (const bridgeForShutdown of getRuntimeBridgesForCleanup()) {
                  if (shutdownBridges.has(bridgeForShutdown)) continue;
                  shutdownBridges.add(bridgeForShutdown);
                  await bridgeForShutdown.shutdown().catch((err) => {
                    daemonLog.error(
                      'bridge shutdown error',
                      err instanceof Error ? err : null,
                    );
                    bridgeShutdownError =
                      err instanceof Error ? err : new Error(String(err));
                  });
                }
              })
              .finally(() => {
                // Phase 2: arm the force timer NOW so it only races
                // server.close, not the bridge tear-down above.
                // `RunHandle.close()` contract says "fully
                // closed and bridge drained" — the previous code
                // resolved on a 100ms shortcut AFTER
                // `closeAllConnections()` without waiting for
                // `server.close`'s callback, so embedders/tests
                // could observe a "closed" handle while the server
                // was still finalizing. Now: force-close just
                // accelerates `server.close` by killing the
                // sockets, but we still wait for `server.close`'s
                // callback to fire. A secondary deadline catches
                // the pathological case where `server.close` never
                // resolves at all (kernel-stuck socket etc.) so
                // shutdown is still bounded.
                const SECONDARY_DEADLINE_MS = 2_000;
                let secondaryTimer: NodeJS.Timeout | undefined;
                const forceTimer = setTimeout(() => {
                  daemonLog.warn(
                    `${SHUTDOWN_FORCE_CLOSE_MS}ms listener-drain timeout reached; force-closing remaining connections`,
                  );
                  server.closeAllConnections();
                  // After force-close, server.close's callback
                  // SHOULD fire promptly. Give it `SECONDARY_DEADLINE_MS`
                  // before we resolve anyway with a warning — much
                  // longer than the previous 100ms shortcut, and
                  // logged so the operator knows the contract was
                  // bent.
                  secondaryTimer = setTimeout(() => {
                    daemonLog.warn(
                      `server.close did not fire ${SECONDARY_DEADLINE_MS}ms after force-close; resolving anyway`,
                    );
                    finish();
                  }, SECONDARY_DEADLINE_MS);
                  secondaryTimer.unref();
                }, SHUTDOWN_FORCE_CLOSE_MS);
                forceTimer.unref();
                server.close((err) => {
                  clearTimeout(forceTimer);
                  if (secondaryTimer) clearTimeout(secondaryTimer);
                  finish(err);
                });
              });
          });
          return closePromise;
        },
      };

      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      process.on('uncaughtExceptionMonitor', onUncaughtExceptionMonitor);

      // Swap the boot-error listener for a runtime-error one
      // before resolving. `tryListen`'s `server.once('error', ...)`
      // only catches errors BEFORE listening; post-listen errors
      // (EMFILE after FD exhaustion, runtime errors on the listener)
      // would be unhandled and crash the daemon. Use a persistent
      // listener that logs to stderr instead.
      server.removeAllListeners('error');
      server.on('error', (err) => {
        daemonLog.error('server error', err instanceof Error ? err : null);
      });
      if (runtimeApp && bridgeRef) {
        const acpHandle = runtimeApp.locals?.['acpHandle'] as
          | AcpHttpHandle
          | undefined;
        acpHandle?.attachServer?.(server);
        if (shouldPreheat) {
          startBridgePreheat(bridgeRef);
        }
        if (opts.channelSelection && !runtimeStartupSettled) {
          armRuntimeStartupTimer();
          runtimeStarting = completeRuntimeStartup().catch((err) =>
            failRuntimeStartup(err, bridgeRef),
          );
        }
      } else if (deferRuntimeUntilFirstHealth) {
        scheduleRuntimeStartFallback();
      } else {
        startRuntime();
      }

      if (deps.resolveOnListen) {
        resolve(handle);
      } else {
        void runtimeReady.then(
          () => resolve(handle),
          (err) => {
            void handle
              .close()
              .catch((closeErr) => {
                daemonLog.error(
                  'shutdown after runtime startup error failed',
                  closeErr instanceof Error ? closeErr : null,
                );
              })
              .finally(() => {
                reject(err instanceof Error ? err : new Error(String(err)));
              });
          },
        );
      }
    };
    let server: Server;
    let httpsServer: https.Server | undefined;
    if (tlsOptions) {
      try {
        httpsServer = https.createServer(tlsOptions, app);
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
    }

    const tryListen = (attemptPort: number, attempt: number): void => {
      try {
        if (httpsServer) {
          // server.listen(port, host, cb) registers `cb` as a one-time
          // `listening` listener. On failed attempts (EADDRINUSE),
          // `listening` never fires so the listener accumulates. Clear
          // stale listeners before each retry.
          httpsServer.removeAllListeners('listening');
          server = httpsServer.listen(attemptPort, listenHostname, onListening);
        } else {
          server = app.listen(attemptPort, listenHostname, onListening);
        }
      } catch (err) {
        // Synchronous listen failure (e.g. invalid address) — not
        // recoverable via port bump.
        removeCurrentServePidfile();
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      server.once('error', (err: NodeJS.ErrnoException) => {
        server.close();
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
        } else {
          if (err.code === 'EADDRINUSE' && attempt > 0) {
            writeStderrLine(
              `qwen serve: all ports ${opts.port}–${attemptPort} are in use`,
            );
          }
          removeCurrentServePidfile();
          reject(err);
        }
      });
    };

    tryListen(opts.port, 0);
  });
}
