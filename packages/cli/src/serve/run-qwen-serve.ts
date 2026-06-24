/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import type { Server } from 'node:http';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import express, {
  type Application,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { writeStderrLine, writeStdoutLine } from '../utils/stdioHelpers.js';
import type { BridgeEvent } from './event-bus.js';
import { getDeviceFlowRegistry } from './auth/device-flow.js';
import {
  loadServeFastPathSettings,
  preResolveServeFastPathHomeEnvOverrides,
  type ServeFastPathSettings,
} from './fast-path-settings.js';
import type { AcpSessionBridge } from '@qwen-code/acp-bridge/bridgeTypes';
import { canonicalizeWorkspace } from '@qwen-code/acp-bridge/workspacePaths';
import type {
  AuthType,
  ProviderSetupInputs,
  TelemetryRuntimeConfig,
  TelemetrySettings,
} from '@qwen-code/qwen-code-core';
import { createBridgeFileSystemAdapter } from './bridge-file-system-adapter.js';
import { isLoopbackBind } from './loopback-binds.js';
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
  type DaemonStartupSnapshot,
  type DaemonStatusResponse,
} from './daemon-status.js';
import {
  finalizeStartupProfile,
  profileCheckpoint,
} from '../utils/startupProfiler.js';

const QWEN_SERVER_TOKEN_ENV = 'QWEN_SERVER_TOKEN';
const QWEN_SERVE_PROMPT_DEADLINE_MS_ENV = 'QWEN_SERVE_PROMPT_DEADLINE_MS';
const QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS_ENV =
  'QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS';
const SHUTDOWN_FORCE_CLOSE_MS = 5_000;
const DEFAULT_RUNTIME_STARTUP_TIMEOUT_MS = 120_000;
const RUNTIME_STARTUP_TIMEOUT_ENV = 'QWEN_SERVE_RUNTIME_STARTUP_TIMEOUT_MS';
const MAX_EVENT_RING_SIZE = 1_000_000;
const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION = 5;
const DEFAULT_EVENT_RING_SIZE = 8000;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
const WORKSPACE_SETTING_SCOPE =
  'Workspace' as import('../config/settings.js').SettingScope;

function isPositiveIntegerMs(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function isNonNegativeIntegerOrInfinity(value: number): boolean {
  return (
    value === Number.POSITIVE_INFINITY ||
    (Number.isFinite(value) && Number.isInteger(value) && value >= 0)
  );
}

function isNonNegativeIntegerMs(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

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
type LoadedSettingsAdapterRuntime =
  typeof import('../config/loadedSettingsAdapter.js');

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
   * Bounds background runtime mounting after the listener is ready. Defaults to
   * QWEN_SERVE_RUNTIME_STARTUP_TIMEOUT_MS, then 120s. Use 0 to disable.
   */
  runtimeStartupTimeoutMs?: number;
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
      loadedSettingsAdapter: LoadedSettingsAdapterRuntime;
    }>
  | undefined;
function loadSettingsRuntimeModules(): Promise<{
  settings: SettingsRuntime;
  loadedSettingsAdapter: LoadedSettingsAdapterRuntime;
}> {
  settingsRuntimePromise ??= Promise.all([
    import('../config/settings.js'),
    import('../config/loadedSettingsAdapter.js'),
  ]).then(([settings, loadedSettingsAdapter]) => ({
    settings,
    loadedSettingsAdapter,
  }));
  return settingsRuntimePromise;
}

async function loadServeRuntimeModules() {
  const [
    serverModule,
    bridgeModule,
    spawnChannelModule,
    workspaceModule,
    daemonStatusProviderModule,
    workspaceProvidersStatusModule,
  ] = await Promise.all([
    import('./server.js'),
    import('@qwen-code/acp-bridge/bridge'),
    import('@qwen-code/acp-bridge/spawnChannel'),
    import('./workspace-service/index.js'),
    import('./daemon-status-provider.js'),
    import('./workspace-providers-status.js'),
  ]);
  return {
    createServeApp: serverModule.createServeApp,
    getActiveSseCount: serverModule.getActiveSseCount,
    resolveBridgeFsFactory: serverModule.resolveBridgeFsFactory,
    createAcpSessionBridge: bridgeModule.createAcpSessionBridge,
    createSpawnChannelFactory: spawnChannelModule.createSpawnChannelFactory,
    createDaemonWorkspaceService: workspaceModule.createDaemonWorkspaceService,
    createDaemonStatusProvider:
      daemonStatusProviderModule.createDaemonStatusProvider,
    createWorkspaceProvidersStatusProvider:
      workspaceProvidersStatusModule.createWorkspaceProvidersStatusProvider,
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
    rateLimit: opts.rateLimit === true,
    reloadAvailable: true,
  });
}

function createBootstrapCapabilities(input: {
  opts: ServeOptions;
  boundWorkspace: string;
  qwenCodeVersion?: string;
  sessionShellCommandEnabled: boolean;
  permissionPolicy: PermissionPolicy | undefined;
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
        cachedSelfOrigins = new Set([
          `http://127.0.0.1:${port}`,
          `http://localhost:${port}`,
          `http://[::1]:${port}`,
          `http://host.docker.internal:${port}`,
        ]);
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

function createBootstrapServeApp(input: {
  opts: ServeOptions;
  getPort: () => number;
  boundWorkspace: string;
  startup: DaemonStartupSnapshot;
  daemonLog: DaemonLogger;
  qwenCodeVersion?: string;
  sessionShellCommandEnabled: boolean;
  permissionPolicy: PermissionPolicy | undefined;
  getRuntimeError: () => string | undefined;
}): Application {
  const {
    opts,
    getPort,
    boundWorkspace,
    startup,
    daemonLog,
    qwenCodeVersion,
    sessionShellCommandEnabled,
    permissionPolicy,
    getRuntimeError,
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

    res.status(200).json({ status: 'ok' });
  };
  const loopback = isLoopbackBind(opts.hostname);
  const exposeHealthPreAuth = loopback && !opts.requireAuth;
  if (exposeHealthPreAuth) {
    app.get('/health', healthHandler);
  }

  app.use(bearerAuth(opts.token));

  if (!exposeHealthPreAuth) {
    app.get('/health', healthHandler);
  }

  app.get('/capabilities', (_req: Request, res: Response): void => {
    res.status(200).json(
      createBootstrapCapabilities({
        opts,
        boundWorkspace,
        qwenCodeVersion,
        sessionShellCommandEnabled,
        permissionPolicy,
      }),
    );
  });

  app.get('/daemon/status', (req: Request, res: Response): void => {
    const detail = parseDaemonStatusDetail(req.query['detail']);
    if (!detail.ok || !detail.detail) {
      res.status(400).json({
        error: 'detail must be one of: summary, full',
        code: 'invalid_detail',
      });
      return;
    }
    const runtimeError = getRuntimeError();
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
        maxPendingPromptsPerSession: advertisedMaxPendingPromptsPerSession(
          opts.maxPendingPromptsPerSession,
        ),
        listenerMaxConnections: listenerMaxConnections(opts.maxConnections),
        eventRingSize: opts.eventRingSize ?? DEFAULT_EVENT_RING_SIZE,
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
): Application {
  const app = express();
  app.use((req: Request, res: Response, next: NextFunction) => {
    const target = getRuntimeApp() ?? bootstrapApp;
    const handler = target as unknown as (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => void;
    handler(req, res, next);
  });
  return app;
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
  optsIn: Omit<ServeOptions, 'token'> & { token?: string },
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
  const opts: ServeOptions = {
    ...optsIn,
    token,
    promptDeadlineMs,
    writerIdleTimeoutMs,
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

  // Resolve the bound workspace (1 daemon = 1 workspace).
  // Explicit `--workspace` wins; otherwise default to process.cwd().
  // `POST /session` with a mismatched `cwd` is rejected by the bridge
  // with `WorkspaceMismatchError`. Multi-workspace deployments use
  // multiple daemon processes, not intra-daemon routing.
  //
  // Boot-loud validation: absolute path, exists, is a directory.
  const rawWorkspace = opts.workspace ?? process.cwd();
  if (!path.isAbsolute(rawWorkspace)) {
    throw new Error(
      `Invalid --workspace "${rawWorkspace}": must be an absolute path.`,
    );
  }
  try {
    const stats = fs.statSync(rawWorkspace);
    if (!stats.isDirectory()) {
      throw new Error(
        `Invalid --workspace "${rawWorkspace}": exists but is not a directory.`,
      );
    }
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err) {
      const code = (err as { code?: unknown }).code;
      if (code === 'ENOENT') {
        throw new Error(
          `Invalid --workspace "${rawWorkspace}": directory does not exist.`,
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
          `Invalid --workspace "${rawWorkspace}": permission denied ` +
            `(${String(code)}). The path exists but cannot be stat'd ` +
            `by the current user.`,
        );
      }
    }
    throw err;
  }
  // Canonicalize ONCE here so `/capabilities` and the POST /session
  // fallback (both via server.ts) AND the bridge agree on the same
  // path. Without this, server.ts and the bridge each compute
  // `boundWorkspace` independently; on symlinks or case-insensitive
  // filesystems the bridge's `realpathSync.native` form diverges from
  // server.ts's raw `opts.workspace` and clients see one path on
  // `/capabilities` but another on `POST /session` responses.
  const boundWorkspace = canonicalizeWorkspace(rawWorkspace);

  // Read a lightweight settings summary once at boot for startup-time fields
  // used before the full runtime settings loader is allowed onto the hot path.
  let contextFilenameForInit: string | undefined;
  let permissionPolicy: PermissionPolicy | undefined;
  let permissionConsensusQuorum: number | undefined;
  let bootSettings: ServeFastPathSettings | undefined;
  try {
    bootSettings =
      deps.bootSettings ?? loadServeFastPathSettings(boundWorkspace);
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
  };

  const cliVersion = await getCliVersion();

  const trustedWorkspace = deps.trustedWorkspace ?? true;
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
  let runtimeStartupError: string | undefined;
  let runtimeStarting: Promise<void> | undefined;
  let markRuntimeReady!: () => void;
  let markRuntimeFailed!: (err: Error) => void;
  let runtimeStartupSettled = false;
  const runtimeReady = new Promise<void>((resolve, reject) => {
    markRuntimeReady = resolve;
    markRuntimeFailed = reject;
  });
  void runtimeReady.catch(() => {});

  const handleBridge =
    deps.bridge ??
    createLazyBridgeProxy(
      () => bridgeRef,
      () => runtimeStartupError,
    );

  const buildRuntime = async (): Promise<{
    app: Application;
    bridge: AcpSessionBridge;
  }> => {
    const [runtime, core, settingsRuntime] = await Promise.all([
      loadServeRuntimeModules(),
      loadCoreRuntime(),
      loadSettingsRuntimeModules(),
    ]);
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
    const daemonWorkspaceHash = core.hashDaemonWorkspace(boundWorkspace);
    const daemonTelemetrySettings = await core.resolveTelemetrySettings({
      env: process.env,
      settings: runtimeBootSettings?.merged.telemetry,
    });
    core.initializeTelemetry(
      createDaemonTelemetryRuntimeConfig(
        daemonTelemetrySettings,
        cliVersion,
        `daemon:${daemonWorkspaceHash}:${process.pid}`,
        {
          otlpEndpoint: core.DEFAULT_OTLP_ENDPOINT,
          telemetryTarget: core.DEFAULT_TELEMETRY_TARGET,
        },
      ),
    );
    core.initializeDaemonMetrics();
    const daemonTelemetry = core.createDaemonBridgeTelemetry();
    daemonTelemetry.metrics = {
      sessionLifecycle(action) {
        core.recordDaemonSessionLifecycle(action);
        core.emitDaemonLog(
          `Session ${action}.`,
          {
            'qwen-code.workspace.hash': daemonWorkspaceHash,
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
      promptQueueWait: core.recordDaemonPromptQueueWait,
      promptDuration: core.recordDaemonPromptDuration,
      cancelled: core.recordDaemonCancel,
    };
    // Allocate the audit ring + publisher in the daemon host (here)
    // rather than inside the bridge factory, because the ring is the
    // seam for exposing `GET /workspace/permission/audit` in the future.
    const permissionAuditRing = new PermissionAuditRing();
    const permissionAuditPublisher = createPermissionAuditPublisher({
      ring: permissionAuditRing,
    });
    const customIgnoreFiles =
      runtimeBootSettings?.merged.context?.fileFiltering?.customIgnoreFiles;
    const fsFactory = runtime.resolveBridgeFsFactory({
      boundWorkspace,
      injected: deps.fsFactory,
      trusted: trustedWorkspace,
      emit: deps.fsAuditEmit,
      ...(customIgnoreFiles !== undefined ? { customIgnoreFiles } : {}),
    });
    const channelFactory = runtime.createSpawnChannelFactory({
      onDiagnosticLine: diagnosticSink,
      ...(opts.experimentalLsp === true
        ? { extraArgs: ['--experimental-lsp'] }
        : {}),
    });
    const statusProvider = runtime.createDaemonStatusProvider();
    const workspaceProvidersStatusProvider =
      runtime.createWorkspaceProvidersStatusProvider();
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
    const bridge =
      deps.bridge ??
      runtime.createAcpSessionBridge({
        maxSessions: opts.maxSessions,
        ...(opts.maxPendingPromptsPerSession !== undefined
          ? { maxPendingPromptsPerSession: opts.maxPendingPromptsPerSession }
          : {}),
        ...(opts.eventRingSize !== undefined
          ? { eventRingSize: opts.eventRingSize }
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
    }
    const workspaceService = runtime.createDaemonWorkspaceService({
      boundWorkspace,
      contextFilename: contextFilenameForInit ?? 'QWEN.md',
      statusProvider,
      workspaceProvidersStatusProvider,
      isChannelLive: () => bridge.isChannelLive(),
      persistDisabledTools: persistDisabledToolsFn,
      reloadDaemonEnv: (workspace) =>
        withSettingsLock(workspace, async () => {
          const fresh = settingsRuntime.settings.loadSettings(workspace, {
            skipLoadEnvironment: true,
          });
          return settingsRuntime.settings.reloadEnvironment(
            fresh.merged,
            workspace,
          );
        }),
      queryWorkspaceStatus: (method, idle) =>
        bridge.queryWorkspaceStatus(method, idle),
      invokeWorkspaceCommand: (method, params, invokeOpts) =>
        bridge.invokeWorkspaceCommand(method, params, invokeOpts),
      refreshExtensionsForAllSessions: () =>
        bridge.refreshExtensionsForAllSessions(),
      publishWorkspaceEvent: (event) => bridge.publishWorkspaceEvent(event),
    });

    core.registerDaemonGaugeCallbacks({
      sessionCount: () => bridge.sessionCount,
      sseCount: () => runtime.getActiveSseCount(),
      heapUsed: () => process.memoryUsage().heapUsed,
    });

    const app = runtime.createServeApp(opts, () => actualPort, {
      bridge,
      webShellDir,
      boundWorkspace,
      qwenCodeVersion: cliVersion,
      startup,
      fsFactory,
      daemonLog,
      workspace: workspaceService,
      persistDisabledTools: persistDisabledToolsFn,
      persistSetting: (workspace, scope, key, value) =>
        withSettingsLock(workspace, async () => {
          const fresh = settingsRuntime.settings.loadSettings(workspace);
          fresh.setValue(scope, key, value);
        }),
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
            await core.applyProviderInstallPlan(plan, {
              settings:
                settingsRuntime.loadedSettingsAdapter.createLoadedSettingsAdapter(
                  fresh,
                ),
              doRefreshAuth: false,
            });
            core.emitDaemonLog('Auth provider installed.', {
              'qwen-code.daemon.auth.provider_id': provider.id,
              'qwen-code.daemon.auth.auth_type': plan.authType,
            });
            return {
              v: 1,
              providerId: provider.id,
              providerLabel: provider.label,
              authType: plan.authType,
              ...(plan.modelSelection?.modelId
                ? { modelId: plan.modelSelection.modelId }
                : {}),
              ...(inputs.baseUrl ? { baseUrl: inputs.baseUrl } : {}),
              message: `Successfully configured ${provider.label}. Use /model to switch models.`,
            };
          },
        ),
    });
    return { app, bridge };
  };

  if (deps.bridge) {
    const runtime = await buildRuntime();
    runtimeAppForCleanup = runtime.app;
    runtimeApp = runtime.app;
    bridgeRef = runtime.bridge;
    runtimeStartupSettled = true;
    markRuntimeReady();
  }

  const bootstrapApp = createBootstrapServeApp({
    opts,
    getPort: () => actualPort,
    boundWorkspace,
    startup,
    daemonLog,
    qwenCodeVersion: cliVersion,
    sessionShellCommandEnabled,
    permissionPolicy,
    getRuntimeError: () => runtimeStartupError,
  });
  const app =
    runtimeApp ?? createDelegatingServeApp(bootstrapApp, () => runtimeApp);

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

  return await new Promise<RunHandle>((resolve, reject) => {
    const server = app.listen(opts.port, listenHostname, () => {
      startup.listenerReadyAt = new Date().toISOString();
      startup.processToListenMs = Math.round(process.uptime() * 1000);
      startup.runQwenServeToListenMs = Math.round(
        performance.now() - runStartedAt,
      );
      profileCheckpoint('serve_listener_ready');
      finalizeStartupProfile(daemonLog.getDaemonId() || 'serve');

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
      const url = `http://${formatHostForUrl(opts.hostname)}:${actualPort}`;
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
      const runtimeStartupTimeoutMs = resolveRuntimeStartupTimeoutMs(
        deps.runtimeStartupTimeoutMs,
      );
      const clearRuntimeStartupTimer = (): void => {
        if (!runtimeStartupTimer) return;
        clearTimeout(runtimeStartupTimer);
        runtimeStartupTimer = undefined;
      };
      const shutdownBridgeAfterFailedStartup = async (
        bridge: AcpSessionBridge | undefined,
      ): Promise<void> => {
        if (!bridge || deps.bridge) return;
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
        markRuntimeFailed(error);
        await shutdownBridgeAfterFailedStartup(bridgeForCleanup ?? bridgeRef);
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
            runtimeStartupSettled = true;
            clearRuntimeStartupTimer();
            markRuntimeReady();
          })
          .catch((err) => failRuntimeStartup(err));
        if (runtimeStartupTimeoutMs > 0) {
          runtimeStartupTimer = setTimeout(() => {
            void failRuntimeStartup(
              new Error(
                `Daemon runtime startup timed out after ${runtimeStartupTimeoutMs}ms.`,
              ),
            );
          }, runtimeStartupTimeoutMs);
          runtimeStartupTimer.unref();
        }
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
            bridgeRef?.killAllSync();
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
            // NOTE: the SIGINT/SIGTERM handlers stay attached during the
            // drain. Their `if (shuttingDown) return` guard makes a second
            // signal a no-op. Detaching them up front would leave Node's
            // default signal behavior in charge — a second SIGTERM mid-drain
            // would terminate the process and orphan agent children. We
            // detach AFTER drain completes (`finish` below).

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

            void (coreRuntimePromise
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
                const bridgeForShutdown = bridgeRef;
                if (bridgeForShutdown) {
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

      // Swap the boot-error listener for a runtime-error one
      // before resolving. `server.once('error', reject)` at the
      // bottom only catches errors BEFORE listening; post-listen
      // errors (EMFILE after FD exhaustion, runtime errors on the
      // listener) would be unhandled and crash the daemon. Use a
      // persistent listener that logs to stderr instead.
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
    });
    server.once('error', reject);
  });
}
