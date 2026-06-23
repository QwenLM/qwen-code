/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { type Server } from 'node:http';
import * as path from 'node:path';
import { writeStderrLine, writeStdoutLine } from '../utils/stdioHelpers.js';
import type { BridgeEvent } from './event-bus.js';
import { getDeviceFlowRegistry } from './auth/device-flow.js';
import {
  loadSettings,
  reloadEnvironment,
  SettingScope,
} from '../config/settings.js';
import { createLoadedSettingsAdapter } from '../config/loadedSettingsAdapter.js';
import {
  canonicalizeWorkspace,
  createAcpSessionBridge,
  type AcpSessionBridge,
} from './acp-session-bridge.js';
import {
  DEFAULT_OTLP_ENDPOINT,
  DEFAULT_TELEMETRY_TARGET,
  createDaemonBridgeTelemetry,
  emitDaemonLog,
  forceFlushMetrics,
  hashDaemonWorkspace,
  initializeDaemonMetrics,
  initializeTelemetry,
  recordDaemonCancel,
  recordDaemonChannelLifecycle,
  recordDaemonPromptDuration,
  recordDaemonPromptQueueWait,
  recordDaemonSessionLifecycle,
  registerDaemonGaugeCallbacks,
  findProviderById,
  buildInstallPlan,
  applyProviderInstallPlan,
  resolveBaseUrl,
  getDefaultModelIds,
  resolveTelemetrySettings,
  shutdownTelemetry,
} from '@qwen-code/qwen-code-core';
import type {
  Protocol,
  ProviderSetupInputs,
  TelemetryRuntimeConfig,
  TelemetrySettings,
} from '@qwen-code/qwen-code-core';
import { createBridgeFileSystemAdapter } from './bridge-file-system-adapter.js';
import { createDaemonStatusProvider } from './daemon-status-provider.js';
import { isLoopbackBind } from './loopback-binds.js';
import { resolveWebShellDir } from './web-shell-static.js';
import { parseAllowOriginPatterns } from './auth.js';
import {
  createPermissionAuditPublisher,
  PermissionAuditRing,
} from './permission-audit.js';
import {
  createServeApp,
  getActiveSseCount,
  resolveBridgeFsFactory,
} from './server.js';
import { initDaemonLogger, type DaemonLogger } from './daemon-logger.js';
import { createSpawnChannelFactory } from '@qwen-code/acp-bridge/spawnChannel';
import { createDaemonWorkspaceService } from './workspace-service/index.js';
import { SERVE_CAPABILITY_REGISTRY } from './capabilities.js';
import type {
  ServeOptions,
  ServeAuthProviderInstallRequest,
  ServeAuthProviderInstallResult,
} from './types.js';
import type { WorkspaceFileSystemFactory } from './fs/index.js';
import type { PermissionPolicy } from '@qwen-code/acp-bridge';
import { getCliVersion } from '../utils/version.js';
import { getRateLimiter } from './rate-limit.js';
import type { AcpHttpHandle } from './acp-http/index.js';

const QWEN_SERVER_TOKEN_ENV = 'QWEN_SERVER_TOKEN';
const QWEN_SERVE_PROMPT_DEADLINE_MS_ENV = 'QWEN_SERVE_PROMPT_DEADLINE_MS';
const QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS_ENV =
  'QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS';
const SHUTDOWN_FORCE_CLOSE_MS = 5_000;

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
): TelemetryRuntimeConfig {
  return {
    getTelemetryEnabled: () => telemetry.enabled ?? false,
    getTelemetryOtlpEndpoint: () =>
      telemetry.otlpEndpoint ?? DEFAULT_OTLP_ENDPOINT,
    getTelemetryOtlpProtocol: () => telemetry.otlpProtocol ?? 'grpc',
    getTelemetryOtlpTracesEndpoint: () => telemetry.otlpTracesEndpoint,
    getTelemetryOtlpLogsEndpoint: () => telemetry.otlpLogsEndpoint,
    getTelemetryOtlpMetricsEndpoint: () => telemetry.otlpMetricsEndpoint,
    getTelemetryTarget: () => telemetry.target ?? DEFAULT_TELEMETRY_TARGET,
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
  policyConfig: { permissionStrategy?: string; consensusQuorum?: number } = {},
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
  if (
    policyConfig.permissionStrategy !== undefined &&
    !validSet.has(policyConfig.permissionStrategy)
  ) {
    throw new InvalidPolicyConfigError(
      `qwen serve: invalid policy.permissionStrategy ` +
        `"${String(policyConfig.permissionStrategy)}"; must be one of ` +
        `${Array.from(validSet).join(', ')}`,
    );
  }
  if (
    policyConfig.consensusQuorum !== undefined &&
    (!Number.isInteger(policyConfig.consensusQuorum) ||
      policyConfig.consensusQuorum < 1)
  ) {
    throw new InvalidPolicyConfigError(
      `qwen serve: invalid policy.consensusQuorum ` +
        `${String(policyConfig.consensusQuorum)}; must be a positive integer`,
    );
  }
  // When consensusQuorum is set but the active strategy doesn't
  // use it, drop the value so the public contract matches the
  // warning. Operators reading the warning at boot now see
  // consistent behavior all the way down.
  const consensusQuorumActive =
    policyConfig.consensusQuorum !== undefined &&
    policyConfig.permissionStrategy === 'consensus';
  if (
    policyConfig.consensusQuorum !== undefined &&
    policyConfig.permissionStrategy !== 'consensus'
  ) {
    onWarning(
      'qwen serve: policy.consensusQuorum is set but ' +
        'policy.permissionStrategy is not "consensus"; the override will ' +
        'be ignored.',
    );
  }
  return {
    permissionPolicy: policyConfig.permissionStrategy as
      | PermissionPolicy
      | undefined,
    permissionConsensusQuorum: consensusQuorumActive
      ? policyConfig.consensusQuorum
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
  /** Resolves when the listener has fully closed and the bridge is drained. */
  close(): Promise<void>;
}

function normalizeInstallModelIds(
  req: ServeAuthProviderInstallRequest,
  provider: NonNullable<ReturnType<typeof findProviderById>>,
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
  provider: NonNullable<ReturnType<typeof findProviderById>>,
): ProviderSetupInputs {
  const protocol = (req.protocol ?? provider.protocol) as Protocol;
  const baseUrl = resolveBaseUrl(provider, req.baseUrl);
  return {
    ...(provider.protocolOptions ? { protocol } : {}),
    baseUrl,
    apiKey: req.apiKey.trim(),
    modelIds: normalizeInstallModelIds(req, provider),
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
}

function shouldPreheatBridge(deps: RunQwenServeDeps): boolean {
  if (deps.preheatBridge !== undefined) return deps.preheatBridge;
  return process.env['VITEST_WORKER_ID'] === undefined;
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

  // Init daemon logger early so all subsequent lifecycle events
  // (bridge spawn diagnostics, shutdown errors) are captured to file.
  const daemonLog: DaemonLogger = initDaemonLogger({ boundWorkspace });
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
  if (opts.maxPendingPromptsPerSession !== undefined) {
    if (!isNonNegativeIntegerOrInfinity(opts.maxPendingPromptsPerSession)) {
      throw new TypeError(
        `Invalid maxPendingPromptsPerSession: ${opts.maxPendingPromptsPerSession}. Must be a non-negative integer (0 / Infinity = unlimited).`,
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

  // Read settings once at boot for the workspace context filename and
  // policy fields (permissionStrategy / consensusQuorum). Wrap in
  // try/catch so a corrupted settings.json doesn't block daemon boot
  // — context filename falls back to the bridge's default; policy
  // validation rethrows because invalid policy is an explicit operator
  // misconfiguration.
  let contextFilenameForInit: string | undefined;
  let permissionPolicy: PermissionPolicy | undefined;
  let permissionConsensusQuorum: number | undefined;
  let bootSettings: ReturnType<typeof loadSettings> | undefined;
  try {
    bootSettings = loadSettings(boundWorkspace);
    contextFilenameForInit = extractContextFilename(
      bootSettings.merged.context?.fileName,
    );
    const policyConfig =
      (
        bootSettings.merged as {
          policy?: {
            permissionStrategy?: string;
            consensusQuorum?: number;
          };
        }
      ).policy ?? {};
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

  const daemonWorkspaceHash = hashDaemonWorkspace(boundWorkspace);
  const daemonTelemetrySettings = await resolveTelemetrySettings({
    env: process.env,
    settings: bootSettings?.merged.telemetry,
  });
  const cliVersion = await getCliVersion();
  initializeTelemetry(
    createDaemonTelemetryRuntimeConfig(
      daemonTelemetrySettings,
      cliVersion,
      `daemon:${daemonWorkspaceHash}:${process.pid}`,
    ),
  );
  initializeDaemonMetrics();
  const daemonTelemetry = createDaemonBridgeTelemetry();
  daemonTelemetry.metrics = {
    sessionLifecycle(action) {
      recordDaemonSessionLifecycle(action);
      emitDaemonLog(
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
      recordDaemonChannelLifecycle(action, expected);
      emitDaemonLog(
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
    promptQueueWait: recordDaemonPromptQueueWait,
    promptDuration: recordDaemonPromptDuration,
    cancelled: recordDaemonCancel,
  };

  // Allocate the audit ring + publisher in the daemon host (here)
  // rather than inside the bridge factory, because the ring is the
  // seam for exposing `GET /workspace/permission/audit` in the
  // future.
  const permissionAuditRing = new PermissionAuditRing();
  const permissionAuditPublisher = createPermissionAuditPublisher({
    ring: permissionAuditRing,
  });

  // Construct `fsFactory` BEFORE the bridge so the bridge can wire it
  // through `BridgeFileSystem` for ACP-side writeTextFile / readTextFile
  // calls. See `bridge-file-system-adapter.ts` for the translation layer.
  const trustedWorkspace = deps.trustedWorkspace ?? true;
  const fsFactory = resolveBridgeFsFactory({
    boundWorkspace,
    injected: deps.fsFactory,
    trusted: trustedWorkspace,
    emit: deps.fsAuditEmit,
  });

  // Create a spawn channel factory that tees child-stderr diagnostics
  // into the daemon log file (file-only, no duplicate stderr write).
  const diagnosticSink = (line: string, level?: 'info' | 'warn' | 'error') =>
    daemonLog.raw(line, level);
  const channelFactory = createSpawnChannelFactory({
    onDiagnosticLine: diagnosticSink,
  });

  const persistDisabledToolsFn = (
    workspace: string,
    toolName: string,
    enabled: boolean,
  ): Promise<void> =>
    withSettingsLock(workspace, async () => {
      const fresh = loadSettings(workspace);
      const wsScope = fresh.forScope(SettingScope.Workspace).settings;
      const wsDisabled = wsScope.tools?.disabled;
      const current = Array.isArray(wsDisabled)
        ? wsDisabled.filter((v): v is string => typeof v === 'string')
        : [];
      const next = new Set(current);
      if (enabled) next.delete(toolName);
      else next.add(toolName);
      fresh.setValue(
        SettingScope.Workspace,
        'tools.disabled',
        [...next].sort(),
      );
    });

  // Create the status provider once — shared between bridge and workspace
  // service so both answer env/preflight cells from the same daemon-local
  // implementation.
  const statusProvider = createDaemonStatusProvider();

  const bridge =
    deps.bridge ??
    createAcpSessionBridge({
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
      // Wire the validated policy/quorum from settings into the
      // bridge.
      ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
      ...(permissionConsensusQuorum !== undefined
        ? { permissionConsensusQuorum }
        : {}),
      permissionAudit: permissionAuditPublisher,
      // #4175 PR 22b/2: inject the daemon-host status provider so the
      // bridge can pull env / preflight cells through a typed seam
      // instead of importing daemon-host helpers directly. Production
      // implementation wraps `buildEnvStatusFromProcess` and the
      // (lifted) `buildDaemonPreflightCells` body.
      statusProvider,
      // F1 follow-up (#4319): inject the WorkspaceFileSystem adapter so
      // agent ACP `writeTextFile` / `readTextFile` calls go through
      // PR 18's defensive fs layer (trust gate + atomic write + symlink
      // resolution + audit emit) instead of `BridgeClient`'s inline
      // raw-fs proxy. Closes the `ws.ts:613` follow-up thread.
      fileSystem: createBridgeFileSystemAdapter(fsFactory),
      // #4175 Wave 4 PR 17: `POST /session/:id/approval-mode` accepts
      // an opt-in `persist: true` flag. We re-load settings on each
      // persist call rather than caching a `LoadedSettings` handle —
      // another writer (CLI, another daemon, an editor) could have
      // touched the file between calls, so the freshest state wins
      // over a stale in-memory cache.
      //
      // #4282 fold-in 4 (qwen-latest C2): both persist callbacks run
      // through `withSettingsLock` — a per-workspace promise chain that
      // serializes the read-modify-write cycle. Without the lock, two
      // concurrent `POST /workspace/tools/:name/enable` requests could
      // both read the same pre-modification state and the second write
      // would silently overwrite the first toggle, leaving the disk
      // copy out of sync with the SDK reducer's view. The lock costs
      // one tick of latency per call but eliminates the lost-update
      // window for the entire process; cross-daemon races against the
      // same workspace file remain (rare; documented).
      persistApprovalMode: (workspace, mode) =>
        withSettingsLock(workspace, async () => {
          const fresh = loadSettings(workspace);
          fresh.setValue(SettingScope.Workspace, 'tools.approvalMode', mode);
        }),
    });

  // Construct the DaemonWorkspaceService AFTER the bridge so it can
  // close over the bridge's generic delegation methods. This service
  // owns workspace-scoped status queries, tool toggle, init, and MCP
  // restart — routes in server.ts delegate here instead of reaching
  // into the bridge for workspace concerns.
  const workspaceService = createDaemonWorkspaceService({
    boundWorkspace,
    contextFilename: contextFilenameForInit ?? 'QWEN.md',
    // Daemon-host status provider for env + preflight cells.
    statusProvider,
    // Channel liveness check — proxied through the bridge's live-channel
    // probe (not session count: a channel can be live with zero attached
    // sessions during the cold-spawn window).
    isChannelLive: () => bridge.isChannelLive(),
    persistDisabledTools: persistDisabledToolsFn,
    reloadDaemonEnv: (workspace) =>
      withSettingsLock(workspace, async () => {
        const fresh = loadSettings(workspace, { skipLoadEnvironment: true });
        return reloadEnvironment(fresh.merged, workspace);
      }),
    queryWorkspaceStatus: (method, idle) =>
      bridge.queryWorkspaceStatus(method, idle),
    invokeWorkspaceCommand: (method, params, invokeOpts) =>
      bridge.invokeWorkspaceCommand(method, params, invokeOpts),
    refreshExtensionsForAllSessions: () =>
      bridge.refreshExtensionsForAllSessions(),
    publishWorkspaceEvent: (event) => bridge.publishWorkspaceEvent(event),
  });

  registerDaemonGaugeCallbacks({
    sessionCount: () => bridge.sessionCount,
    sseCount: () => getActiveSseCount(),
    heapUsed: () => process.memoryUsage().heapUsed,
  });

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

  // Pass the already-canonical `boundWorkspace` into `createServeApp`
  // via `deps.boundWorkspace`. That field is the pre-canonicalized
  // fast-path: createServeApp skips its own `canonicalizeWorkspace`
  // call (which would issue a redundant `realpathSync.native`
  // syscall — idempotent but unnecessary I/O at boot). Direct
  // callers of createServeApp (tests / embeds) omit it and the
  // server canonicalizes itself.
  //
  // `fsFactory` is constructed above (before the bridge) so the
  // bridge can wire it through `BridgeFileSystem`. The HTTP read
  // routes and ACP fs calls share the same factory instance.
  const app = createServeApp(opts, () => actualPort, {
    bridge,
    webShellDir,
    boundWorkspace,
    qwenCodeVersion: cliVersion,
    fsFactory,
    daemonLog,
    workspace: workspaceService,
    persistDisabledTools: persistDisabledToolsFn,
    persistSetting: (workspace, scope, key, value) =>
      withSettingsLock(workspace, async () => {
        const fresh = loadSettings(workspace);
        fresh.setValue(scope, key, value);
      }),
    installAuthProvider: (req) =>
      withSettingsLock(
        boundWorkspace,
        async (): Promise<ServeAuthProviderInstallResult> => {
          const provider = findProviderById(req.providerId);
          if (!provider) {
            throw new Error(`Unsupported auth provider: ${req.providerId}`);
          }
          const inputs = buildProviderSetupInputs(req, provider);
          const plan = buildInstallPlan(provider, inputs);
          const fresh = loadSettings(boundWorkspace);
          await applyProviderInstallPlan(plan, {
            settings: createLoadedSettingsAdapter(fresh),
            doRefreshAuth: false,
          });
          emitDaemonLog('Auth provider installed.', {
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
  // Pull the device-flow registry back out so the close hook can
  // dispose it before `bridge.shutdown()`, ensuring polling timers +
  // cancel controllers are torn down BEFORE we tell agent children
  // to exit.
  const deviceFlowRegistry = getDeviceFlowRegistry(app);

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
            bridge.killAllSync();
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
        bridge,
        webShellMounted,
        resolvedToken: token,
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
              void shutdownTelemetry()
                .catch((telemetryErr) => {
                  writeStderrLine(
                    `qwen serve: telemetry shutdown error: ${
                      telemetryErr instanceof Error
                        ? telemetryErr.message
                        : String(telemetryErr)
                    }`,
                  );
                })
                .finally(() => {
                  // Server.close error takes precedence (operator-visible
                  // listener problem); fall back to the bridge error
                  // captured during shutdown if any.
                  const finalErr = err ?? bridgeShutdownError;
                  if (finalErr) rej(finalErr);
                  else res();
                });
            };

            // Dispose the device-flow registry FIRST so any
            // in-flight IdP poll is cancelled and timers are cleared
            // before the bridge tear-down (which would otherwise race
            // with the still-polling registry on shared HTTP agents).
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
            const acpHandle = app.locals?.['acpHandle'] as
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
            const rl = getRateLimiter(app);
            if (rl) {
              rl.setDraining(true);
              rl.dispose();
            }
            forceFlushMetrics()
              .catch((flushErr) => {
                daemonLog.warn(
                  `pre-shutdown metrics flush failed: ${
                    flushErr instanceof Error
                      ? flushErr.message
                      : String(flushErr)
                  }`,
                );
              })
              .then(() => {
                bridge
                  .shutdown()
                  .catch((err) => {
                    daemonLog.error(
                      'bridge shutdown error',
                      err instanceof Error ? err : null,
                    );
                    bridgeShutdownError =
                      err instanceof Error ? err : new Error(String(err));
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
      if (!deps.bridge && shouldPreheatBridge(deps)) {
        bridge.preheat().catch((err) => {
          writeStderrLine(
            `qwen serve: ACP preheat failed, will retry on first session: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }

      // Enable WebSocket transport now that http.Server is available.
      const acpHandle = app.locals?.['acpHandle'] as AcpHttpHandle | undefined;
      acpHandle?.attachServer?.(server);

      resolve(handle);
    });
    server.once('error', reject);
  });
}
