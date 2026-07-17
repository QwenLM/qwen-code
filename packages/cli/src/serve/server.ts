/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import type { Application } from 'express';
import type { DaemonStatusProvider } from '@qwen-code/acp-bridge';
import { hashDaemonWorkspace } from '@qwen-code/qwen-code-core';
import type { DaemonLogger } from './daemon-logger.js';
import type {
  DaemonMetricsBucket,
  DaemonPerfSnapshot,
  DaemonStartupSnapshot,
} from './daemon-status.js';
import type {
  ChannelWorkerSnapshot,
  ChannelWorkerSupervisor,
} from './channel-worker-supervisor.js';
import type { ChannelWorkerGroupSnapshot } from './channel-worker-group.js';
import type {
  ChannelWorkerControlState,
  ChannelWorkerSetResult,
  ChannelWorkerStopResult,
} from './channel-worker-manager.js';
import {
  allowOriginCors,
  bearerAuth,
  createMutationGate,
  denyBrowserOriginCors,
  hostAllowlist,
  parseAllowOriginPatterns,
} from './auth.js';
import type {
  DeviceFlowProvider,
  DeviceFlowRegistry,
} from './auth/device-flow.js';
import { createBridgeFileSystemAdapter } from './bridge-file-system-adapter.js';
import { createDaemonStatusProvider } from './daemon-status-provider.js';
import { createWorkspaceProvidersStatusProvider } from './workspace-providers-status.js';
import { createWorkspaceSkillsStatusProvider } from './workspace-skills-status.js';
import { mountAcpHttp, type AcpHttpHandle } from './acp-http/index.js';
import { createVoiceWsConnectionHandler } from './voice/voice-ws.js';
import {
  ClientMcpSenderRegistry,
  createClientMcpServerProvider,
} from './acp-http/client-mcp-sender-registry.js';
import { CdpTunnelRegistry } from './cdp-tunnel/cdp-tunnel-registry.js';
import {
  canonicalizeWorkspace,
  createAcpSessionBridge,
  type AcpSessionBridge,
} from './acp-session-bridge.js';
import {
  type ServeAuthProviderInstallRequest,
  type ServeAuthProviderInstallResult,
  type ServeChannelSelection,
  type ChannelWebhookConfigSource,
  type ServeOptions,
} from './types.js';
import {
  mountWebShellAssets,
  mountWebShellSpaFallback,
} from './web-shell-static.js';
import {
  mountWorkspaceMemoryRoutes,
  mountWorkspaceQualifiedMemoryRoutes,
} from './workspace-memory.js';
import {
  mountWorkspaceMemoryRememberRoutes,
  WorkspaceRememberTaskLane,
} from './workspace-remember.js';
import {
  mountWorkspaceAgentsRoutes,
  mountWorkspaceQualifiedAgentsRoutes,
} from './workspace-agents.js';
import { registerDaemonStatusRoutes } from './routes/daemon-status.js';
import { createHealthDemoRoutes } from './routes/health-demo.js';
import { registerWorkspaceAuthRoutes } from './routes/workspace-auth.js';
import { registerWorkspaceExtensionRoutes } from './routes/workspace-extensions.js';
import type { WorkspaceFileSystemFactory } from './fs/index.js';
import {
  registerWorkspaceFileReadRoutes,
  registerWorkspaceQualifiedFileReadRoutes,
} from './routes/workspace-file-read.js';
import {
  registerWorkspaceFileWriteRoutes,
  registerWorkspaceQualifiedFileWriteRoutes,
} from './routes/workspace-file-write.js';
import { registerWorkspaceSetupGithubRoutes } from './routes/workspace-setup-github.js';
import {
  registerWorkspaceQualifiedTrustRoutes,
  registerWorkspaceTrustRoutes,
} from './routes/workspace-trust.js';
import { registerPermissionRoutes } from './routes/permission.js';
import { registerSessionRoutes } from './routes/session.js';
import {
  registerScheduledTasksRoutes,
  registerWorkspaceQualifiedScheduledTasksRoutes,
} from './routes/scheduled-tasks.js';
import { registerUsageStatsRoutes } from './routes/usage-stats.js';
import {
  startScheduledTaskKeepalive,
  rehydrateScheduledTaskSessions,
} from './scheduled-task-keepalive.js';
import {
  registerWorkspaceDiagnosticStatusRoutes,
  registerWorkspaceQualifiedDiagnosticStatusRoutes,
  registerWorkspaceQualifiedStatusRoutes,
  registerWorkspaceStatusRoutes,
} from './routes/workspace-status.js';
import {
  createDaemonWorkspaceService,
  type DaemonWorkspaceService,
  type DaemonWorkspaceServiceDeps,
} from './workspace-service/index.js';
import { registerCapabilitiesRoutes } from './routes/capabilities.js';
import {
  registerWorkspacePermissionsRoutes,
  registerWorkspaceQualifiedPermissionsRoutes,
} from './routes/workspace-permissions.js';
import {
  registerWorkspaceQualifiedSettingsRoutes,
  registerWorkspaceSettingsRoutes,
} from './routes/workspace-settings.js';
import {
  getActiveSseCount,
  registerSseEventsRoutes,
} from './routes/sse-events.js';
import {
  registerWorkspaceQualifiedVoiceRoutes,
  registerWorkspaceVoiceRoutes,
  type WorkspaceVoiceRouteDeps,
} from './routes/workspace-voice.js';
import { registerWorkspaceModelsRoutes } from './routes/workspace-models.js';
import { WorkspaceVoiceCoordinator } from './voice/workspace-voice-coordinator.js';
import { registerA2uiActionRoutes } from './routes/a2ui-action.js';
import { setRateLimiter } from './rate-limit.js';
import { resolveAcpHttpEnabled } from './acp-http-enabled.js';
import {
  createTotalSessionAdmissionController,
  type TotalSessionAdmissionSnapshot,
} from './total-session-admission.js';
import {
  sendBridgeError as sendBridgeErrorResponse,
  sendPermissionVoteError as sendPermissionVoteErrorResponse,
  type SendBridgeError,
} from './server/error-response.js';
import { resolveBridgeFsFactory } from './server/fs-factory.js';
import {
  createBuildWorkspaceCtx,
  parseAndValidateWorkspaceClientId,
  parseClientIdHeader,
  safeBody,
} from './server/request-helpers.js';
import { daemonTelemetryMiddleware } from './server/telemetry.js';
import { installAccessLogMiddleware } from './server/access-log.js';
import { setupDeviceFlowRegistry } from './server/device-flow-registry.js';
import {
  installFinalErrorHandler,
  installJsonBodyParser,
} from './server/error-handlers.js';
import { installRateLimiter } from './server/rate-limiter-setup.js';
import { createServeFeatures } from './server/serve-features.js';
import { SessionArchiveCoordinator } from './server/session-archive.js';
import { installSelfOriginStripMiddleware } from './server/self-origin.js';
import {
  createSingleWorkspaceRegistry,
  createWorkspaceSessionOwnerIndex,
  type WorkspaceRegistry,
  type WorkspaceRuntime,
  type WorkspaceRuntimeEnvMetadata,
} from './workspace-registry.js';
import {
  isPortableAbsolutePath,
  resolveRegisteredWorkspaceRuntimeByPathSelector,
} from './workspace-route-runtime.js';
import {
  registerWorkspaceLifecycleRoutes,
  registerWorkspaceQualifiedLifecycleRoutes,
} from './routes/workspace-lifecycle.js';
import {
  registerWorkspaceManagementRoutes,
  type WorkspaceManagementHandle,
  type WorkspaceRuntimeRemovalController,
} from './routes/workspace-management.js';
import type { WorkspaceRegistrationStore } from './workspace-registration-store.js';
import {
  registerWorkspaceGitRoutes,
  registerWorkspaceQualifiedGitRoutes,
} from './routes/workspace-git.js';
import { WorkspaceGitState } from './workspace-git-state.js';
import {
  registerWorkspaceMcpControlRoutes,
  registerWorkspaceQualifiedMcpControlRoutes,
} from './routes/workspace-mcp-control.js';
import { registerWorkspaceChannelControlRoutes } from './routes/workspace-channel-control.js';
import {
  registerWorkspaceQualifiedToolsRoutes,
  registerWorkspaceToolsRoutes,
} from './routes/workspace-tools.js';
import {
  registerWorkspaceQualifiedSkillsRoutes,
  registerWorkspaceSkillsRoutes,
} from './routes/workspace-skills.js';
import { registerChannelWebhookRoutes } from './routes/channel-webhooks.js';
import {
  parseChannelWebhookConfigLenient,
  type parseChannelWebhookConfig,
} from '../commands/channel/config-utils.js';
import { loadChannelsConfig } from '../commands/channel/runtime.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';

export {
  createDefaultFsAuditEmit,
  resolveBoundWorkspacesFromIdeEnv,
  resolveBridgeFsFactory,
} from './server/fs-factory.js';
export {
  PromptDeadlineExceededError,
  resolvePromptDeadlineMs,
} from './server/prompt-deadline.js';
export { detectFromLoopback } from './server/request-helpers.js';
export {
  InvalidCursorError,
  getWorkspaceSessionInfoForResponse,
  listWorkspaceSessionsForResponse,
} from './server/session-list.js';
export type {
  ListWorkspaceSessionsOptions,
  ListWorkspaceSessionsReadOptions,
  ListWorkspaceSessionsResult,
  WorkspaceSessionInfoResult,
} from './server/session-list.js';
export { getActiveSseCount } from './routes/sse-events.js';

/**
 * Module-scoped once-per-process guard for the `createServeApp`
 * default-trust stderr warning. Without this, tests calling
 * `createServeApp` repeatedly would flood stderr with identical lines.
 */
let warnedDefaultTrust = false;

function loadServeChannelWebhookConfigs(
  sources: readonly ChannelWebhookConfigSource[],
): Record<string, { webhooks?: ReturnType<typeof parseChannelWebhookConfig> }> {
  const parsed: Record<
    string,
    { webhooks?: ReturnType<typeof parseChannelWebhookConfig> }
  > = {};

  for (const source of sources) {
    let channelsConfig: ReturnType<typeof loadChannelsConfig>;
    try {
      channelsConfig = loadChannelsConfig(source.workspaceCwd);
    } catch (error) {
      writeStderrLine(
        `[daemon] Skipping webhook config source ${JSON.stringify(source.workspaceCwd)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    const selectedChannels = source.channelNames
      ? new Set(source.channelNames)
      : undefined;
    for (const [channelName, rawConfig] of Object.entries(channelsConfig)) {
      if (
        (selectedChannels && !selectedChannels.has(channelName)) ||
        typeof rawConfig !== 'object' ||
        rawConfig === null
      ) {
        continue;
      }
      let webhooks: ReturnType<typeof parseChannelWebhookConfig>;
      try {
        webhooks = parseChannelWebhookConfigLenient(
          channelName,
          rawConfig as Record<string, unknown>,
          (webhookSource, sourceError) => {
            const sourceMessage =
              sourceError instanceof Error
                ? sourceError.message
                : String(sourceError);
            writeStderrLine(
              `[daemon] Skipping malformed webhook source "${webhookSource}" for channel "${channelName}": ${sourceMessage}`,
            );
          },
          source.env,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeStderrLine(
          `[daemon] Skipping malformed webhook config for channel "${channelName}": ${message}`,
        );
        continue;
      }
      if (webhooks) {
        parsed[channelName] = { webhooks };
      }
    }
  }

  return parsed;
}

function describeRegistryPrimaryForConflict(
  registry: WorkspaceRegistry,
): string {
  return (
    `registry primary cwd=${JSON.stringify(registry.primary.workspaceCwd)}, ` +
    `workspaceId=${JSON.stringify(registry.primary.workspaceId)}`
  );
}

function getRuntimeEffectiveEnv(
  metadata: WorkspaceRuntimeEnvMetadata | undefined,
): Readonly<Record<string, string | undefined>> | undefined {
  if (!metadata || metadata.mode === 'parent-process') {
    return metadata?.effectiveEnv;
  }
  return metadata.effectiveEnv ?? {};
}

export interface ServeAppDeps {
  /** Bridge instance; tests inject a fake. Defaults to a fresh real one. */
  bridge?: AcpSessionBridge;
  /**
   * Enables resident management of scheduled-task-owned sessions: a periodic
   * keepalive (so their schedulers aren't idle-reaped) and a boot-time
   * rehydration (so they re-arm after a restart). Opt-in — only the real
   * long-running daemon (`runQwenServe`) sets it. Tests and direct embeds
   * leave it off so `createServeApp` neither spawns sessions on boot nor holds
   * a heartbeat timer.
   */
  manageScheduledTaskSessions?: boolean;
  /**
   * Directory of the built Web Shell SPA (`index.html` + `assets/`). When
   * set (and `opts.serveWebShell !== false`), `createServeApp` mounts the
   * UI at the daemon root before `bearerAuth`. Production `runQwenServe`
   * resolves this via `resolveWebShellDir()` and injects it here; direct
   * embeds / tests opt in by passing a fixture dir, so the default
   * `createServeApp` (no injection) stays API-only and existing route tests
   * are unaffected.
   */
  webShellDir?: string;
  /**
   * Qwen Code version advertised to web/SDK clients. Production passes the
   * resolved CLI package version; tests/direct embeds may omit it.
   */
  qwenCodeVersion?: string;
  /**
   * Pre-canonicalized workspace path. When supplied, `createServeApp`
   * skips its own `canonicalizeWorkspace` call (which would issue a
   * redundant `realpathSync.native` syscall — idempotent, but a hot
   * boot-time stat we can avoid). `runQwenServe` passes this after
   * its own boot-time canonicalize so the value used by
   * `/capabilities`, the `POST /session` cwd fallback, and the
   * bridge are all the SAME canonical form. Callers that haven't
   * canonicalized yet (tests, direct embeds) omit this and
   * `createServeApp` falls back to canonicalizing `opts.workspace ??
   * process.cwd()` itself.
   */
  boundWorkspace?: string;
  /**
   * Workspace filesystem boundary factory. When supplied, file routes
   * pull a per-request `WorkspaceFileSystem` off it; when omitted,
   * `createServeApp` builds a strict default (`trusted: false`,
   * warn-once no-op `emit`) so an upstream refactor that forgets to
   * inject `fsFactory` never silently allows writes against an
   * untrusted workspace.
   */
  fsFactory?: WorkspaceFileSystemFactory;
  /**
   * Device-flow auth registry. Tests inject a fake; production callers
   * omit this and `createServeApp` constructs a default wired to the
   * shipped Qwen provider, the bridge's `publishWorkspaceEvent`,
   * and a stderr audit sink.
   */
  deviceFlowRegistry?: DeviceFlowRegistry;
  maxExtensionOperationHistory?: number;
  /**
   * Extra device-flow providers for tests / future extensions.
   * Production builds register only `QwenOAuthDeviceFlowProvider`;
   * passing extra entries here registers them in addition.
   */
  deviceFlowProviders?: DeviceFlowProvider[];
  /**
   * Installs an LLM auth provider by applying the same provider install plan
   * used by interactive `/auth`. Production `runQwenServe` injects a
   * settings-backed implementation; tests/direct embeds may omit it, in which
   * case the route reports `not_implemented`.
   */
  installAuthProvider?: (
    req: ServeAuthProviderInstallRequest,
  ) => Promise<ServeAuthProviderInstallResult>;
  /**
   * Optional daemon logger. When provided, `sendBridgeError` routes
   * each 5xx error through `daemonLog.error(...)` (which tees to stderr +
   * the daemon log file). When omitted, falls back to existing
   * stderr-only behavior.
   */
  daemonLog?: DaemonLogger;
  startup?: DaemonStartupSnapshot;
  getChannelWorkerSnapshot?: () => ChannelWorkerSnapshot;
  getChannelWorkerSnapshots?: () => ChannelWorkerGroupSnapshot[];
  getChannelWorkerControl?: () => ChannelWorkerControlState;
  isChannelControlDraining?: () => boolean;
  isChannelControlInitializing?: () => boolean;
  setChannelWorkerSelection?: (
    selection: ServeChannelSelection,
  ) => Promise<ChannelWorkerSetResult>;
  stopChannelWorker?: () => Promise<ChannelWorkerStopResult>;
  enqueueChannelWebhookTask?: ChannelWorkerSupervisor['enqueueWebhookTask'];
  channelWebhookConfigSources?: readonly ChannelWebhookConfigSource[];
  getChannelWebhookConfigSources?: () => readonly ChannelWebhookConfigSource[];
  getChannelWebhookConfigVersion?: () => number;
  registerChannelWebhookConfigRefresh?: (refresh: () => void) => void;
  /**
   * Stop and relaunch the daemon-managed channel worker so it re-reads
   * settings.json. Its presence mounts the compatibility reload route;
   * `channel_reload` is advertised only while the control state is enabled.
   */
  reloadChannelWorker?: () => Promise<ChannelWorkerSnapshot>;
  getPerfSnapshot?: () => DaemonPerfSnapshot;
  /** Rolling metrics series for the Daemon Status charts (oldest→newest). */
  getMetricsSeries?: () => DaemonMetricsBucket[];
  getTotalSessionAdmissionSnapshot?: () => TotalSessionAdmissionSnapshot;
  /**
   * Sink fed one (durationMs, statusCode) per matched daemon HTTP request, so
   * the metrics ring can bucket request rate and latency for the charts.
   */
  recordDaemonRequest?: (durationMs: number, statusCode: number) => void;
  workspace?: DaemonWorkspaceService;
  statusProvider?: DaemonStatusProvider;
  persistDisabledTools?: (
    workspace: string,
    toolName: string,
    enabled: boolean,
  ) => Promise<void>;
  persistDisabledSkills?: DaemonWorkspaceServiceDeps['persistDisabledSkills'];
  contextFilename?: string;
  persistSetting?: (
    workspace: string,
    scope: import('../config/settings.js').SettingScope,
    key: string,
    value: unknown,
  ) => Promise<void | import('../config/settings.js').LoadedSettings>;
  persistSettings?: (
    workspace: string,
    writes: Array<{
      scope: import('../config/settings.js').SettingScope;
      key: string;
      value: unknown;
    }>,
  ) => Promise<void>;
  sessionArtifactsPersistenceAvailable?: boolean;
  /**
   * Reverse tool channel (issue #5626, Phase 2). Shared sender registry that
   * bridges the daemon WS (per-connection `ClientMcpRegistrar`) and the ACP
   * child's `client_mcp/message` ext-method. `runQwenServe` constructs ONE and
   * passes the SAME instance here AND to its `createAcpSessionBridge` call (as
   * `clientMcpSender: registry.lookup`) so the bridge that answers the child
   * and the WS provider that registers senders agree. When omitted (the
   * standalone `createServeApp` path with no injected bridge), `createServeApp`
   * builds its own registry and wires it into the bridge it creates.
   */
  clientMcpSenderRegistry?: ClientMcpSenderRegistry;
  workspaceRegistry?: WorkspaceRegistry;
  createWorkspaceRuntime?: (cwd: string) => Promise<WorkspaceRuntime>;
  workspaceRegistrationStore?: WorkspaceRegistrationStore;
  workspaceRuntimeRemoval?: WorkspaceRuntimeRemovalController;
  primaryWorkspaceTrusted?: boolean;
  primaryRuntimeEnv?: WorkspaceRuntimeEnvMetadata;
  daemonEnv?: Readonly<NodeJS.ProcessEnv>;
  voiceTranscriber?: WorkspaceVoiceRouteDeps['transcribe'];
  voiceCoordinator?: WorkspaceVoiceCoordinator;
}

/**
 * Build the Express app for `qwen serve`. Pure function — no side effects on
 * the network or process; `runQwenServe` does the listen/signal handling.
 *
 * `getPort` is invoked lazily by the host-allowlist middleware so callers
 * binding to port 0 (ephemeral) can supply the actual port after `listen()`
 * resolves. Defaults to `opts.port` for callers (e.g. tests) that pin a port
 * up front.
 *
 * Route modules are registered below in middleware order. Keep this file as
 * the assembly point so auth/rate-limit/body-parser/REST/ACP/Web Shell order
 * stays reviewable in one place.
 *
 * **Workspace validation contract.** `createServeApp` itself does NOT
 * verify that `opts.workspace` exists or is a directory — it
 * canonicalizes via `canonicalizeWorkspace`, which falls back to
 * `path.resolve` on ENOENT so the app boots even against a missing
 * path. `runQwenServe` is the production entry point and DOES
 * perform the `fs.statSync` + `isDirectory()` boot-loud check before
 * calling this function. Tests inject synthetic paths (`/work/bound`
 * etc.) on purpose: they want to exercise the route layer's
 * canonicalization and `workspace_mismatch` translation without
 * needing a real directory on disk. If a future entry point binds
 * `createServeApp` directly to user input, it MUST replicate the
 * `runQwenServe` validation (or call into a shared helper if one is
 * extracted) — otherwise a non-existent `--workspace` would boot
 * a "healthy"-looking daemon whose every spawn fails with cryptic
 * child-process ENOENT.
 */
// Mirrors the bridge's session-idle reaper default (30 min). Used only to
// size the scheduled-task keepalive interval when no explicit timeout is set.
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
// Bounds for the keepalive interval: ≥30s (avoid busy-looping on a tiny custom
// timeout) and ≤10min (stay well inside the 30-min default reaper window).
const KEEPALIVE_MIN_INTERVAL_MS = 30_000;
const KEEPALIVE_MAX_INTERVAL_MS = 10 * 60_000;

/**
 * Sizes the keepalive heartbeat interval so a resident task session is beaten
 * BEFORE the idle reaper closes it. Targets a third of the reaper window, but
 * never exceeds HALF of it — so at least one heartbeat lands in time even for a
 * small custom timeout, where the 30s floor would otherwise overshoot the whole
 * window and let the session be reaped before the first beat. When the reaper is
 * disabled (idle timeout ≤ 0) sessions are never reaped, so heartbeats aren't
 * needed — the loop still runs (to revive re-enabled bound sessions) but at the
 * relaxed max cadence.
 */
export function computeKeepaliveIntervalMs(idleTimeoutMs: number): number {
  if (idleTimeoutMs <= 0) return KEEPALIVE_MAX_INTERVAL_MS;
  const target = Math.min(
    Math.max(KEEPALIVE_MIN_INTERVAL_MS, Math.floor(idleTimeoutMs / 3)),
    KEEPALIVE_MAX_INTERVAL_MS,
  );
  return Math.max(1, Math.min(target, Math.floor(idleTimeoutMs / 2)));
}

export function createServeApp(
  opts: ServeOptions,
  getPort: () => number = () => opts.port,
  deps: ServeAppDeps = {},
): Application {
  if (deps.workspaceRuntimeRemoval && !deps.voiceCoordinator) {
    throw new Error(
      'createServeApp: deps.workspaceRuntimeRemoval requires the matching deps.voiceCoordinator.',
    );
  }
  const app = express();
  // Forward `maxSessions` into the default-constructed bridge so
  // direct callers of `createServeApp` (tests, embeds) get the same
  // cap they configured via `ServeOptions`. Previously the default
  // bridge silently fell back to `DEFAULT_MAX_SESSIONS` (20) and
  // only the `runQwenServe` path piped the option through.
  //
  // The primary workspace value advertised on `/capabilities`, used for the
  // `POST /session` cwd fallback, AND passed into the primary bridge must be
  // the SAME canonical form.
  // `deps.boundWorkspace` is the pre-canonicalized fast-path from
  // `runQwenServe`; when omitted we canonicalize ourselves.
  const injectedWorkspaceRegistry = deps.workspaceRegistry;
  const boundWorkspace =
    injectedWorkspaceRegistry?.primary.workspaceCwd ??
    deps.boundWorkspace ??
    canonicalizeWorkspace(opts.workspace ?? process.cwd());
  if (injectedWorkspaceRegistry) {
    const primary = injectedWorkspaceRegistry.primary;
    const registryConflictCandidates = [
      {
        depName: 'deps.boundWorkspace',
        depValue: deps.boundWorkspace,
        registryValue: primary.workspaceCwd,
        detail: `deps.boundWorkspace=${JSON.stringify(deps.boundWorkspace)}`,
      },
      {
        depName: 'deps.bridge',
        depValue: deps.bridge,
        registryValue: primary.bridge,
        detail: 'deps.bridge is a different object',
      },
      {
        depName: 'deps.workspace',
        depValue: deps.workspace,
        registryValue: primary.workspaceService,
        detail: 'deps.workspace is a different object',
      },
      {
        depName: 'deps.fsFactory',
        depValue: deps.fsFactory,
        registryValue: primary.routeFileSystemFactory,
        detail: 'deps.fsFactory is a different object',
      },
      {
        depName: 'deps.clientMcpSenderRegistry',
        depValue: deps.clientMcpSenderRegistry,
        registryValue: primary.clientMcpSenderRegistry,
        detail: 'deps.clientMcpSenderRegistry is a different object',
      },
    ];
    for (const candidate of registryConflictCandidates) {
      if (
        candidate.depValue === undefined ||
        candidate.depValue === candidate.registryValue
      ) {
        continue;
      }
      throw new Error(
        'createServeApp: workspaceRegistry conflicts with ' +
          `${candidate.depName}: ${describeRegistryPrimaryForConflict(
            injectedWorkspaceRegistry,
          )}; ${candidate.detail}.`,
      );
    }
  }
  // Construct `fsFactory` BEFORE the bridge so the bridge can wire it
  // through `BridgeFileSystem` for ACP-side writeTextFile/readTextFile.
  // Default trust is `false` (test-safe). Embeds without `deps.fsFactory`
  // or `deps.bridge` will see agent writes rejected with
  // `untrusted_workspace` — warn once so the asymmetry is visible.
  if (
    !injectedWorkspaceRegistry &&
    !deps.fsFactory &&
    !deps.bridge &&
    !warnedDefaultTrust
  ) {
    warnedDefaultTrust = true;
    process.stderr.write(
      'qwen serve: createServeApp default fsFactory uses trusted=false ' +
        '— agent ACP writeTextFile calls will reject with untrusted_workspace. ' +
        'Inject deps.fsFactory (with explicit trust) or deps.bridge to override.\n',
    );
  }
  const fsFactory =
    injectedWorkspaceRegistry?.primary.routeFileSystemFactory ??
    resolveBridgeFsFactory({
      boundWorkspaces: [boundWorkspace],
      injected: deps.fsFactory,
      trusted: false,
    });
  const tokenConfigured =
    typeof opts.token === 'string' && opts.token.length > 0;
  const sessionShellCommandEnabled =
    opts.enableSessionShell === true && tokenConfigured;
  // Reverse tool channel (issue #5626, Phase 2). Process-scoped registry that
  // bridges the daemon WS (per-connection `ClientMcpRegistrar`) and the ACP
  // child's `client_mcp/message` ext-method. Prefer the registry `runQwenServe`
  // already wired into its injected bridge (`deps.clientMcpSenderRegistry`) so
  // the bridge that answers the child and the WS provider share ONE map.
  // Standalone `createServeApp` (no injected bridge) builds its own and wires
  // it into the bridge it creates below. Inert until a WS client sends
  // `mcp_register` (gated by `clientMcpOverWs`).
  // Guard the split-brain case: an injected `deps.bridge` was already wired to
  // its own sender, so building a fresh registry here would leave the bridge
  // and this registry pointing at different maps. A caller injecting the bridge
  // must inject the matching registry too. Only enforced when `clientMcpOverWs`
  // is active — that's the only path that processes `mcp_*` frames, so without
  // it the registry is inert and a mismatch can't manifest (and the vast
  // majority of tests inject a fake bridge without ever touching client-MCP).
  if (
    opts.clientMcpOverWs === true &&
    deps.bridge &&
    !injectedWorkspaceRegistry &&
    !deps.clientMcpSenderRegistry
  ) {
    throw new Error(
      'createServeApp: deps.bridge requires deps.clientMcpSenderRegistry ' +
        'when clientMcpOverWs is enabled (the bridge is already wired to its ' +
        'own sender; a fresh registry here would be an orphan).',
    );
  }
  const clientMcpSenderRegistry =
    injectedWorkspaceRegistry?.primary.clientMcpSenderRegistry ??
    deps.clientMcpSenderRegistry ??
    new ClientMcpSenderRegistry();
  const primaryRuntimeEnvMetadata =
    injectedWorkspaceRegistry?.primary.env ?? deps.primaryRuntimeEnv;
  const primaryEffectiveEnv = getRuntimeEffectiveEnv(primaryRuntimeEnvMetadata);
  const { languageCodes, currentServeFeatures, invalidateServeFeaturesCache } =
    createServeFeatures({
      opts,
      boundWorkspace,
      persistSettingAvailable: deps.persistSetting !== undefined,
      sessionArtifactsPersistenceAvailable:
        deps.sessionArtifactsPersistenceAvailable !== false,
      sessionGenerationAvailable: () => {
        const runtimes = workspaceRegistry.list();
        return (
          runtimes.length > 0 &&
          runtimes.every(
            (runtime) => runtime.bridge.generateSessionContent !== undefined,
          )
        );
      },
      // Registry injection supplies the primary workspace service through the
      // runtime, so it has the same reload surface as legacy deps.workspace.
      reloadAvailable:
        deps.workspace !== undefined || injectedWorkspaceRegistry !== undefined,
      channelControlAvailable:
        deps.getChannelWorkerControl !== undefined &&
        deps.setChannelWorkerSelection !== undefined &&
        deps.stopChannelWorker !== undefined,
      channelReloadAvailable: () => {
        if (deps.reloadChannelWorker === undefined) return false;
        const control = deps.getChannelWorkerControl?.();
        if (control) {
          return (
            control.enabled &&
            control.selection !== null &&
            control.workers.length > 0
          );
        }
        return (
          deps.getChannelWorkerSnapshots?.().some((worker) => worker.enabled) ||
          deps.getChannelWorkerSnapshot?.().enabled ||
          false
        );
      },
      sessionShellCommandEnabled,
      multiWorkspaceSessionsEnabled: () => workspaceRegistry.list().length > 1,
      persistentWorkspaceRegistrationAvailable:
        deps.workspaceRegistrationStore !== undefined,
      workspaceRuntimeRemovalAvailable:
        deps.workspaceRuntimeRemoval !== undefined,
      ...(primaryEffectiveEnv ? { env: primaryEffectiveEnv } : {}),
    });
  (
    app.locals as {
      invalidateServeFeaturesCache?: () => void;
    }
  ).invalidateServeFeaturesCache = invalidateServeFeaturesCache;
  const statusProvider =
    deps.statusProvider ??
    createDaemonStatusProvider(
      primaryEffectiveEnv ? { env: primaryEffectiveEnv } : {},
    );
  let defaultBridgeForAdmission: AcpSessionBridge | undefined;
  const totalSessionAdmission =
    !deps.bridge && !injectedWorkspaceRegistry
      ? createTotalSessionAdmissionController({
          maxTotalSessions: opts.maxTotalSessions,
          getBridges: () =>
            defaultBridgeForAdmission ? [defaultBridgeForAdmission] : [],
        })
      : undefined;
  const defaultSessionOwnerIndex = !injectedWorkspaceRegistry
    ? createWorkspaceSessionOwnerIndex()
    : undefined;
  const bridge =
    injectedWorkspaceRegistry?.primary.bridge ??
    deps.bridge ??
    createAcpSessionBridge({
      maxSessions: opts.maxSessions,
      ...(totalSessionAdmission
        ? { freshSessionAdmission: totalSessionAdmission.admit }
        : {}),
      ...(defaultSessionOwnerIndex
        ? {
            sessionLifecycle:
              defaultSessionOwnerIndex.handleBridgeSessionLifecycle,
          }
        : {}),
      maxPendingPromptsPerSession: opts.maxPendingPromptsPerSession,
      eventRingSize: opts.eventRingSize,
      compactedReplayMaxBytes: opts.compactedReplayMaxBytes,
      permissionResponseTimeoutMs: opts.permissionResponseTimeoutMs,
      boundWorkspace,
      sessionShellCommandEnabled,
      // Wire the production status provider so direct embeds / tests
      // that don't inject `deps.bridge` get daemon env + preflight cells.
      statusProvider,
      // Wire the WorkspaceFileSystem adapter so ACP writeTextFile /
      // readTextFile pick up trust / TOCTOU / audit.
      fileSystem: createBridgeFileSystemAdapter(fsFactory),
      // Reverse tool channel: answer the child's `client_mcp/message`
      // ext-method by reaching the WS connection that hosts the named server.
      clientMcpSender: clientMcpSenderRegistry.lookup,
    });
  if (!injectedWorkspaceRegistry && !deps.bridge) {
    defaultBridgeForAdmission = bridge;
  }
  const archiveCoordinator = new SessionArchiveCoordinator();

  installSelfOriginStripMiddleware(app, getPort);

  // Park the factory on `app.locals` so route handlers can pick it up
  // via `req.app.locals.fsFactory` without re-threading the value
  // through every handler signature.
  (app.locals as { fsFactory?: WorkspaceFileSystemFactory }).fsFactory =
    fsFactory;
  // Surface the bound workspace on `app.locals` so file routes can
  // compute workspace-relative response paths without re-resolving.
  (app.locals as { boundWorkspace?: string }).boundWorkspace = boundWorkspace;

  const { deviceFlowRegistry, getSupportedDeviceFlowProviders } =
    setupDeviceFlowRegistry({
      app,
      bridge,
      registry: deps.deviceFlowRegistry,
      providers: deps.deviceFlowProviders,
      // Phase 4: fan device-flow events out to the primary and every trusted
      // secondary runtime bridge, so workspace-qualified ACP clients receive
      // their own flow's events. Resolved lazily: the registry is created
      // before the workspace registry exists, but by the time a flow emits,
      // `app.locals` holds the populated registry.
      resolveEventBridges: () => {
        const reg = (app.locals as { workspaceRegistry?: WorkspaceRegistry })
          .workspaceRegistry;
        if (!reg) return [bridge];
        return reg
          .list()
          .filter((rt) => rt.primary || rt.trusted)
          .map((rt) => rt.bridge);
      },
    });

  const { daemonLog } = deps;

  const sendBridgeError: SendBridgeError = (res, err, ctx) =>
    sendBridgeErrorResponse(res, err, ctx, daemonLog);
  const sendPermissionVoteError = (
    res: import('express').Response,
    err: unknown,
    ctx: { route: string; sessionId?: string },
  ) => sendPermissionVoteErrorResponse(res, err, ctx, daemonLog);

  const workspace: DaemonWorkspaceService =
    injectedWorkspaceRegistry?.primary.workspaceService ??
    deps.workspace ??
    createDaemonWorkspaceService({
      boundWorkspace,
      contextFilename: deps.contextFilename ?? 'QWEN.md',
      statusProvider,
      workspaceProvidersStatusProvider: createWorkspaceProvidersStatusProvider(
        primaryEffectiveEnv ? { env: primaryEffectiveEnv } : {},
      ),
      workspaceSkillsStatusProvider: createWorkspaceSkillsStatusProvider(),
      ...(primaryEffectiveEnv ? { voiceEnv: primaryEffectiveEnv } : {}),
      isChannelLive: () => bridge.isChannelLive(),
      persistDisabledTools:
        deps.persistDisabledTools ??
        (async () => {
          throw new Error(
            'setWorkspaceToolEnabled requires persistDisabledTools in ServeAppDeps',
          );
        }),
      persistDisabledSkills:
        deps.persistDisabledSkills ??
        (async () => {
          throw new Error(
            'setWorkspaceSkillEnabled requires persistDisabledSkills in ServeAppDeps',
          );
        }),
      queryWorkspaceStatus: (method, idle) =>
        bridge.queryWorkspaceStatus(method, idle),
      invokeWorkspaceCommand: (method, params, invokeOpts) =>
        bridge.invokeWorkspaceCommand(method, params, invokeOpts),
      preheatAcpChild: () => bridge.preheat(),
      refreshExtensionsForAllSessions: () =>
        bridge.refreshExtensionsForAllSessions(),
      ...(deps.persistSetting ? { persistSetting: deps.persistSetting } : {}),
      ...(deps.persistSettings
        ? { persistSettings: deps.persistSettings }
        : {}),
      publishWorkspaceEvent: (event) => {
        if (
          event.type === 'settings_changed' ||
          event.type === 'settings_reloaded'
        ) {
          invalidateServeFeaturesCache();
        }
        bridge.publishWorkspaceEvent(event);
      },
    });
  const workspaceRegistry =
    injectedWorkspaceRegistry ??
    createSingleWorkspaceRegistry(
      {
        workspaceId: hashDaemonWorkspace(boundWorkspace),
        workspaceCwd: boundWorkspace,
        primary: true,
        trusted: deps.primaryWorkspaceTrusted ?? false,
        env: primaryRuntimeEnvMetadata ?? {
          mode: 'parent-process',
          overlayKeys: [],
        },
        bridge,
        workspaceService: workspace,
        routeFileSystemFactory: fsFactory,
        clientMcpSenderRegistry,
      },
      defaultSessionOwnerIndex
        ? { sessionOwnerIndex: defaultSessionOwnerIndex }
        : {},
    );
  (app.locals as { workspaceRegistry?: WorkspaceRegistry }).workspaceRegistry =
    workspaceRegistry;
  const primaryRuntime = workspaceRegistry.primary;
  const daemonEnv = deps.daemonEnv ?? process.env;
  const primaryRuntimeEffectiveEnv =
    getRuntimeEffectiveEnv(primaryRuntime.env) ?? daemonEnv;
  const voiceCoordinator =
    deps.voiceCoordinator ?? new WorkspaceVoiceCoordinator();
  const primaryBoundWorkspace = primaryRuntime.workspaceCwd;
  const primaryBridge = primaryRuntime.bridge;
  const primaryWorkspace = primaryRuntime.workspaceService;
  const primaryRouteFileSystemFactory = primaryRuntime.routeFileSystemFactory;
  const workspaceGitState = new WorkspaceGitState();
  (app.locals as { stopWorkspaceGitState?: () => void }).stopWorkspaceGitState =
    () => workspaceGitState.dispose();
  (
    app.locals as {
      stopWorkspaceGitStateForWorkspace?: (workspaceCwd: string) => void;
    }
  ).stopWorkspaceGitStateForWorkspace = (workspaceCwd) =>
    workspaceGitState.disposeWorkspace(workspaceCwd);
  const workspaceQualifiedAcpEnabled = resolveAcpHttpEnabled();

  // Order matters: rejection guards (CORS / Host allowlist / bearer auth)
  // run BEFORE the JSON body parser. Otherwise an unauthenticated POST
  // gets a full 10MB `JSON.parse` before the 401 fires — a trivially
  // amplified CPU/memory cost from any wrong-token client.
  //
  // When `--allow-origin` is configured, install the
  // allowlist middleware instead of the deny-wall. The allowlist owns
  // both halves of the policy (matched → CORS headers + pass-through or
  // 204 preflight; unmatched → 403 with the same error envelope as the
  // wall). When `--allow-origin` is empty/undefined, the deny-wall stays
  // installed. Pattern parsing happens in `run-qwen-serve.ts` for validation;
  // here we still keep the wildcard/no-token invariant for embedded
  // callers that construct the app directly.
  if (opts.allowOrigins && opts.allowOrigins.length > 0) {
    const parsedAllowOrigins = parseAllowOriginPatterns(opts.allowOrigins);
    if (parsedAllowOrigins.allowAny && !opts.token) {
      throw new Error(
        `Refusing to start with --allow-origin '*' but no bearer token ` +
          `configured. '*' admits any cross-origin browser to the API; ` +
          `without a token, any local page can drive the daemon. Set a ` +
          `token or list specific origins instead of '*'.`,
      );
    }
    app.use(allowOriginCors(parsedAllowOrigins));
  } else {
    app.use(denyBrowserOriginCors);
  }
  app.use(hostAllowlist(opts.hostname, getPort));
  const rateLimiter = installRateLimiter(app, opts, daemonLog, {
    mount: false,
    workspaceQualifiedAcpEnabled,
  });

  const healthDemoRoutes = createHealthDemoRoutes({
    opts,
    getPort,
    workspaceRegistry,
    getActiveSseCount,
    getRateLimiter: () => rateLimiter,
  });
  if (healthDemoRoutes.exposeHealthPreAuth) {
    healthDemoRoutes.register(app);
  }

  installAccessLogMiddleware(app, daemonLog);

  // Serve the Web Shell static assets (/ and /assets) BEFORE bearerAuth. The
  // static shell carries no secrets and a browser cannot attach an
  // Authorization header to a `<script src>` subresource or an address-bar
  // navigation, so gating it would just break the UI — the front-end's own
  // API calls still carry the bearer (getDaemonAuthHeaders) and every API
  // route below stays token-gated. The SPA deep-link fallback is registered
  // LATER (after all API routes, see mountWebShellSpaFallback) so authed
  // routes win over the shell. The assets dir is resolved by the caller
  // (runQwenServe) and injected via deps.webShellDir; `--no-web` sets
  // opts.serveWebShell=false to opt out.
  const webShellDir =
    opts.serveWebShell !== false ? deps.webShellDir : undefined;
  // Extension origins (chrome-extension://…) explicitly allowed via
  // --allow-origin may frame the Web Shell so the extension can host the UI in
  // a Chrome side panel (issue #5626). All other origins still get
  // frame-ancestors 'none' + X-Frame-Options: DENY.
  const webShellFrameAncestors =
    opts.allowOrigins && opts.allowOrigins.length > 0
      ? [...parseAllowOriginPatterns(opts.allowOrigins).origins].filter(
          (o) =>
            o.startsWith('chrome-extension://') ||
            o.startsWith('moz-extension://'),
        )
      : [];
  if (webShellDir) {
    mountWebShellAssets(app, webShellDir, webShellFrameAncestors);
  }

  if (deps.enqueueChannelWebhookTask) {
    let channelWebhookConfigVersion = -1;
    let channelWebhookConfigs: Record<
      string,
      { webhooks?: ReturnType<typeof parseChannelWebhookConfig> }
    > = {};
    const refreshChannelWebhookConfigs = () => {
      const version = deps.getChannelWebhookConfigVersion?.() ?? 0;
      try {
        // A mutable manager must provide committed routing explicitly;
        // falling back to every primary-workspace webhook would keep old
        // secrets active after DELETE or a failed replacement.
        const sources =
          deps.getChannelWebhookConfigSources?.() ??
          (deps.getChannelWorkerControl
            ? []
            : (deps.channelWebhookConfigSources ?? [
                { workspaceCwd: primaryBoundWorkspace },
              ]));
        channelWebhookConfigs = loadServeChannelWebhookConfigs(sources);
        channelWebhookConfigVersion = version;
      } catch (error) {
        channelWebhookConfigs = {};
        daemonLog?.warn(
          `failed to refresh channel webhook configuration: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    };
    deps.registerChannelWebhookConfigRefresh?.(refreshChannelWebhookConfigs);
    registerChannelWebhookRoutes(app, {
      getChannelsConfig: () => {
        const version = deps.getChannelWebhookConfigVersion?.() ?? 0;
        if (channelWebhookConfigVersion !== version) {
          refreshChannelWebhookConfigs();
        }
        return channelWebhookConfigs;
      },
      safeBody,
      enqueueWebhookTask: deps.enqueueChannelWebhookTask,
      rateLimiter,
      daemonLog,
    });
  }

  app.use(bearerAuth(opts.token));

  // Rate limiter: after auth (only count authenticated requests), except
  // webhook routes which use their own shared-secret auth before bearerAuth.
  if (rateLimiter) {
    app.use(rateLimiter.middleware);
  }

  if (!healthDemoRoutes.exposeHealthPreAuth) {
    // Non-loopback OR loopback with `--require-auth`: register
    // `/health` and `/demo` AFTER `bearerAuth` so probes must carry
    // the token. Otherwise unauthenticated callers can ping any
    // reachable address:port to confirm a daemon exists (and `/demo`
    // leaks the full API surface).
    healthDemoRoutes.register(app);
  }

  installJsonBodyParser(app);

  // Mutation-route gate factory. Non-strict mode is passthrough;
  // `{ strict: true }` requires a token even on loopback defaults.
  const mutate = createMutationGate({
    tokenConfigured,
    requireAuth: opts.requireAuth === true,
  });

  app.use(
    daemonTelemetryMiddleware(
      (req) => {
        const match = req.path.match(/^\/workspaces\/([^/]+)/);
        const rawSelector = match?.[1];
        if (rawSelector) {
          try {
            const selector = decodeURIComponent(rawSelector);
            const byId = workspaceRegistry.getByWorkspaceId(selector);
            if (byId) return byId.workspaceCwd;
            if (isPortableAbsolutePath(selector)) {
              const runtime = resolveRegisteredWorkspaceRuntimeByPathSelector(
                workspaceRegistry,
                selector,
              );
              if (runtime) return runtime.workspaceCwd;
            }
          } catch {
            return primaryBoundWorkspace;
          }
        }
        return primaryBoundWorkspace;
      },
      deps.recordDaemonRequest,
      (sessionId) => {
        try {
          const owner = workspaceRegistry.resolveLiveSessionOwner(sessionId);
          return owner.kind === 'found'
            ? owner.runtime.workspaceCwd
            : undefined;
        } catch {
          return undefined;
        }
      },
    ),
  );

  const buildWorkspaceCtx = createBuildWorkspaceCtx(primaryBoundWorkspace);

  const acpHandleRef: { current?: AcpHttpHandle } = {};
  const workspaceRememberLane = new WorkspaceRememberTaskLane(
    primaryBridge,
    primaryBoundWorkspace,
  );

  // Plan C CDP tunnel (issue #5626): process-scoped registry pairing the
  // extension `/acp` connection with the `/cdp` puppeteer endpoint. Inert until
  // both ends connect (gated by `cdpTunnelOverWs`).
  const cdpTunnelRegistry =
    opts.cdpTunnelOverWs === true ? new CdpTunnelRegistry() : undefined;

  registerDaemonStatusRoutes(app, {
    opts,
    boundWorkspace: primaryBoundWorkspace,
    bridge: primaryBridge,
    workspaceRegistry,
    workspace: primaryWorkspace,
    daemonLog,
    startup: deps.startup,
    qwenCodeVersion: deps.qwenCodeVersion,
    getAcpHandle: () => acpHandleRef.current,
    getRateLimiter: () => rateLimiter,
    getRestSseActive: getActiveSseCount,
    currentServeFeatures,
    getSupportedDeviceFlowProviders,
    deviceFlowRegistry,
    sessionShellCommandEnabled,
    getChannelWorkerSnapshot: deps.getChannelWorkerSnapshot,
    getChannelWorkerSnapshots: deps.getChannelWorkerSnapshots,
    getPerfSnapshot: deps.getPerfSnapshot,
    getMetricsSeries: deps.getMetricsSeries,
    getTotalSessionAdmissionSnapshot:
      deps.getTotalSessionAdmissionSnapshot ?? totalSessionAdmission?.snapshot,
  });

  registerCapabilitiesRoutes(app, {
    qwenCodeVersion: deps.qwenCodeVersion,
    mode: opts.mode,
    currentServeFeatures,
    boundWorkspace: primaryBoundWorkspace,
    workspaceRegistry,
    permissionPolicy: primaryBridge.permissionPolicy,
    maxSessionsPerWorkspace: opts.maxSessions,
    maxTotalSessions: opts.maxTotalSessions,
    maxPendingPromptsPerSession: opts.maxPendingPromptsPerSession,
    languageCodes,
  });

  registerWorkspaceStatusRoutes(app, {
    boundWorkspace: primaryBoundWorkspace,
    bridge: primaryBridge,
    workspace: primaryWorkspace,
    mutate,
    sendBridgeError,
  });
  registerWorkspaceQualifiedStatusRoutes(app, {
    workspaceRegistry,
    sendBridgeError,
  });
  registerWorkspaceGitRoutes(app, {
    boundWorkspace: primaryBoundWorkspace,
    bridge: primaryBridge,
    gitState: workspaceGitState,
    sendBridgeError,
  });
  registerWorkspaceQualifiedGitRoutes(app, {
    workspaceRegistry,
    gitState: workspaceGitState,
    sendBridgeError,
  });

  // Workspace memory + agents CRUD routes.
  mountWorkspaceMemoryRoutes(app, {
    bridge: primaryBridge,
    boundWorkspace: primaryBoundWorkspace,
    mutate,
    parseClientId: parseClientIdHeader,
    safeBody,
  });
  mountWorkspaceQualifiedMemoryRoutes(app, {
    workspaceRegistry,
    mutate,
    parseClientId: parseClientIdHeader,
    safeBody,
  });
  mountWorkspaceMemoryRememberRoutes(app, {
    bridge: primaryBridge,
    lane: workspaceRememberLane,
    mutate,
    parseClientId: parseClientIdHeader,
    safeBody,
  });
  mountWorkspaceAgentsRoutes(app, {
    bridge: primaryBridge,
    boundWorkspace: primaryBoundWorkspace,
    mutate,
    parseClientId: parseClientIdHeader,
    safeBody,
  });
  mountWorkspaceQualifiedAgentsRoutes(app, {
    workspaceRegistry,
    mutate,
    parseClientId: parseClientIdHeader,
    safeBody,
  });

  registerWorkspaceDiagnosticStatusRoutes(app, {
    boundWorkspace: primaryBoundWorkspace,
    bridge: primaryBridge,
    workspace: primaryWorkspace,
    mutate,
    sendBridgeError,
  });
  registerWorkspaceQualifiedDiagnosticStatusRoutes(app, {
    workspaceRegistry,
    sendBridgeError,
  });

  registerWorkspaceExtensionRoutes(app, {
    boundWorkspace: primaryBoundWorkspace,
    bridge: primaryBridge,
    workspace: primaryWorkspace,
    mutate,
    safeBody,
    sendBridgeError,
    workspaceRegistry,
    ...(deps.maxExtensionOperationHistory === undefined
      ? {}
      : { maxExtensionOperationHistory: deps.maxExtensionOperationHistory }),
  });

  // Workspace file routes (read-only + mutation).
  registerWorkspaceFileReadRoutes(app, {
    parseClientId: parseClientIdHeader,
  });
  registerWorkspaceQualifiedFileReadRoutes(app, {
    parseClientId: parseClientIdHeader,
    workspaceRegistry,
  });
  registerWorkspaceFileWriteRoutes(app, {
    bridge: primaryBridge,
    mutate,
    parseClientId: parseClientIdHeader,
    safeBody,
  });
  registerWorkspaceQualifiedFileWriteRoutes(app, {
    bridge: primaryBridge,
    mutate,
    parseClientId: parseClientIdHeader,
    safeBody,
    workspaceRegistry,
  });
  registerWorkspaceSetupGithubRoutes(app, {
    boundWorkspace: primaryBoundWorkspace,
    bridge: primaryBridge,
    env: primaryRuntimeEffectiveEnv,
    mutate,
    parseClientId: parseClientIdHeader,
    safeBody,
  });
  registerWorkspaceTrustRoutes(app, {
    boundWorkspace: primaryBoundWorkspace,
    workspace: primaryWorkspace,
    mutate,
    safeBody,
    parseAndValidateClientId: (req, res) =>
      parseAndValidateWorkspaceClientId(req, res, primaryBridge),
  });
  registerWorkspaceQualifiedTrustRoutes(app, {
    workspaceRegistry,
    mutate,
    safeBody,
  });

  // Dynamic workspace registration.
  const workspaceManagementHandle = registerWorkspaceManagementRoutes(app, {
    workspaceRegistry,
    mutate,
    safeBody,
    createWorkspaceRuntime: deps.createWorkspaceRuntime,
    workspaceRegistrationStore: deps.workspaceRegistrationStore,
    getAcpHandle: () => acpHandleRef.current,
    runtimeRemoval: deps.workspaceRuntimeRemoval,
  });
  (
    app.locals as { workspaceManagementHandle?: WorkspaceManagementHandle }
  ).workspaceManagementHandle = workspaceManagementHandle;
  (
    app.locals as {
      workspaceRuntimeRemoval?: WorkspaceRuntimeRemovalController;
    }
  ).workspaceRuntimeRemoval = deps.workspaceRuntimeRemoval;

  const broadcastSettingsChanged = (
    key: string,
    value: unknown,
    scope: string,
    clientId: string | undefined,
  ) => {
    invalidateServeFeaturesCache();
    primaryBridge.publishWorkspaceEvent({
      type: 'settings_changed',
      data: { key, value, scope },
      ...(clientId ? { originatorClientId: clientId } : {}),
    });
  };

  if (deps.persistSetting) {
    const persistSetting = deps.persistSetting;
    registerWorkspaceSettingsRoutes(app, {
      boundWorkspace: primaryBoundWorkspace,
      mutate,
      safeBody,
      persistSetting: async (...args) => {
        await persistSetting(...args);
      },
      broadcastSettingsChanged,
      parseAndValidateClientId: (req, res) =>
        parseAndValidateWorkspaceClientId(req, res, primaryBridge),
    });
    registerWorkspaceQualifiedSettingsRoutes(app, {
      workspaceRegistry,
      mutate,
      safeBody,
      persistSetting: async (...args) => {
        await persistSetting(...args);
      },
      invalidateServeFeaturesCache,
    });
  }
  registerWorkspacePermissionsRoutes(app, {
    boundWorkspace: primaryBoundWorkspace,
    mutate,
    safeBody,
    workspace: primaryWorkspace,
    parseAndValidateClientId: (req, res) =>
      parseAndValidateWorkspaceClientId(req, res, primaryBridge),
  });
  registerWorkspaceQualifiedPermissionsRoutes(app, {
    workspaceRegistry,
    mutate,
    safeBody,
  });
  registerWorkspaceVoiceRoutes(app, {
    boundWorkspace: primaryBoundWorkspace,
    mutate,
    safeBody,
    persistSetting: deps.persistSetting,
    persistSettings: deps.persistSettings,
    transcribe: deps.voiceTranscriber,
    env: getRuntimeEffectiveEnv(primaryRuntime.env),
    acquireVoiceLease: () => voiceCoordinator.acquire(primaryRuntime),
    broadcastSettingsChanged,
    parseAndValidateClientId: (req, res) =>
      parseAndValidateWorkspaceClientId(req, res, primaryBridge),
  });
  registerWorkspaceQualifiedVoiceRoutes(app, {
    workspaceRegistry,
    mutate,
    safeBody,
    persistSetting: deps.persistSetting,
    persistSettings: deps.persistSettings,
    transcribe: deps.voiceTranscriber,
    acquireVoiceLease: (runtime) => voiceCoordinator.acquire(runtime),
    parseAndValidateClientId: (req, res, runtime) =>
      parseAndValidateWorkspaceClientId(req, res, runtime.bridge),
    invalidateServeFeaturesCache,
  });
  if (deps.persistSettings) {
    registerWorkspaceModelsRoutes(app, {
      boundWorkspace: primaryBoundWorkspace,
      mutate,
      safeBody,
      persistSettings: deps.persistSettings,
      broadcastSettingsChanged,
      parseAndValidateClientId: (req, res) =>
        parseAndValidateWorkspaceClientId(req, res, primaryBridge),
    });
  }

  // A2UI action inbound (the upstream half of A2UI-over-MCP): user
  // interactions from web clients are proxied to the UI MCP server's
  // standard `action` tool.
  registerA2uiActionRoutes(app, {
    boundWorkspace: primaryBoundWorkspace,
    mutate,
    safeBody,
    env: getRuntimeEffectiveEnv(primaryRuntime.env),
    // UI-server discovery uses the daemon's workspace MCP status, which
    // includes servers registered at runtime.
    getMcpServers: async () => {
      const ctx = buildWorkspaceCtx('POST /session/:id/a2ui-action');
      const status = await primaryWorkspace.getWorkspaceMcpStatus(ctx);
      return (status.servers ?? []) as Array<{
        name: string;
        mcpStatus?: string;
        config?: Record<string, unknown>;
      }>;
    },
  });

  registerWorkspaceAuthRoutes(app, {
    mutate,
    deviceFlowRegistry,
    getSupportedDeviceFlowProviders,
    sendBridgeError,
    boundWorkspace: primaryBoundWorkspace,
    allowPrivateAuthBaseUrl: opts.allowPrivateAuthBaseUrl === true,
    installAuthProvider: deps.installAuthProvider,
  });

  registerSessionRoutes(app, {
    boundWorkspace: primaryBoundWorkspace,
    bridge: primaryBridge,
    workspaceRegistry,
    archiveCoordinator,
    mutate,
    sendBridgeError,
    daemonLog,
    promptDeadlineMs: opts.promptDeadlineMs,
    sessionShellCommandEnabled,
    languageCodes,
  });

  registerWorkspaceMcpControlRoutes(app, {
    boundWorkspace: primaryBoundWorkspace,
    bridge: primaryBridge,
    workspace: primaryWorkspace,
    mutate,
    safeBody,
    sendBridgeError,
    parseAndValidateClientId: (req, res) =>
      parseAndValidateWorkspaceClientId(req, res, primaryBridge),
  });
  registerWorkspaceQualifiedMcpControlRoutes(app, {
    workspaceRegistry,
    mutate,
    safeBody,
    sendBridgeError,
  });
  const channelWorkerControl =
    deps.getChannelWorkerControl ??
    (deps.getChannelWorkerSnapshot
      ? () => {
          const workers = deps.getChannelWorkerSnapshots?.() ?? [];
          const primary = deps.getChannelWorkerSnapshot!();
          return {
            enabled:
              workers.length > 0
                ? workers.some((worker) => worker.enabled)
                : primary.enabled,
            selection: null,
            transition: 'idle' as const,
            workers,
          };
        }
      : undefined);
  if (
    channelWorkerControl &&
    (deps.reloadChannelWorker ||
      (deps.setChannelWorkerSelection && deps.stopChannelWorker))
  ) {
    registerWorkspaceChannelControlRoutes(app, {
      getChannelWorkerControl: channelWorkerControl,
      ...(deps.isChannelControlDraining
        ? { isDaemonDraining: deps.isChannelControlDraining }
        : {}),
      ...(deps.isChannelControlInitializing
        ? { isManagerInitializing: deps.isChannelControlInitializing }
        : {}),
      ...(deps.setChannelWorkerSelection
        ? { setChannelWorkerSelection: deps.setChannelWorkerSelection }
        : {}),
      ...(deps.stopChannelWorker
        ? { stopChannelWorker: deps.stopChannelWorker }
        : {}),
      ...(deps.reloadChannelWorker
        ? { reloadChannelWorker: deps.reloadChannelWorker }
        : {}),
      mutate,
      safeBody,
      sendBridgeError,
      parseAndValidateClientId: (req, res) =>
        parseAndValidateWorkspaceClientId(req, res, primaryBridge),
    });
  }
  registerWorkspaceLifecycleRoutes(app, {
    boundWorkspace: primaryBoundWorkspace,
    workspace: primaryWorkspace,
    mutate,
    safeBody,
    sendBridgeError,
    invalidateServeFeaturesCache,
    parseAndValidateClientId: (req, res) =>
      parseAndValidateWorkspaceClientId(req, res, primaryBridge),
  });
  registerWorkspaceQualifiedLifecycleRoutes(app, {
    workspaceRegistry,
    mutate,
    safeBody,
    sendBridgeError,
    invalidateServeFeaturesCache,
  });
  registerWorkspaceToolsRoutes(app, {
    boundWorkspace: primaryBoundWorkspace,
    workspace: primaryWorkspace,
    mutate,
    safeBody,
    sendBridgeError,
    parseAndValidateClientId: (req, res) =>
      parseAndValidateWorkspaceClientId(req, res, primaryBridge),
  });
  registerWorkspaceQualifiedToolsRoutes(app, {
    workspaceRegistry,
    mutate,
    safeBody,
    sendBridgeError,
  });
  registerWorkspaceSkillsRoutes(app, {
    workspaceRuntime: primaryRuntime,
    mutate,
    safeBody,
    sendBridgeError,
    parseAndValidateClientId: (req, res) =>
      parseAndValidateWorkspaceClientId(req, res, primaryBridge),
  });
  registerWorkspaceQualifiedSkillsRoutes(app, {
    workspaceRegistry,
    mutate,
    safeBody,
    sendBridgeError,
  });

  // Durable scheduled-tasks CRUD (the Web Shell "Scheduled tasks" page).
  // Reads/writes the per-project cron file only; firing stays with the
  // session-side scheduler. Non-strict mutate: creating a scheduled prompt
  // is the same capability class as POST /session/:id/prompt.
  //
  // The bridge is passed ONLY when resident task-session management is enabled.
  // Binding a task to a dedicated session is only safe when something keeps that
  // session resident and reloads it after a restart (the keepalive + rehydration
  // below); without it, a bound task would fire only inside a session nothing
  // revives and silently go dormant. So embedders that leave the manager off
  // get UNBOUND tasks (shared-owner firing) instead.
  registerScheduledTasksRoutes(app, {
    boundWorkspace: primaryBoundWorkspace,
    mutate,
    safeBody,
    bridge: deps.manageScheduledTaskSessions ? bridge : undefined,
  });

  // The same CRUD surface, workspace-qualified, so a multi-workspace Web Shell
  // manages every registered project's schedule against that project's own cron
  // file (and its own session bridge) rather than always the primary's. Each
  // request resolves + trust-checks `:workspace` before any read/write.
  registerWorkspaceQualifiedScheduledTasksRoutes(app, {
    workspaceRegistry,
    mutate,
    safeBody,
    manageScheduledTaskSessions: deps.manageScheduledTaskSessions === true,
  });

  // Read-only token-usage dashboard (Daemon Status "统计" tab). Aggregate local
  // usage only; open GET like /daemon/status, with its own short TTL cache.
  registerUsageStatsRoutes(app);

  // Resident management of scheduled-task-owned sessions — opt-in, so tests and
  // embeds that call createServeApp neither spawn sessions on boot nor hold a
  // heartbeat timer (both would read the bound workspace's real tasks file).
  if (deps.manageScheduledTaskSessions) {
    // Keepalive: keep task sessions resident so their in-child schedulers keep
    // ticking rather than being idle-reaped, AND revive a re-enabled bound
    // session the reaper already let go. The revive loop is needed even when the
    // reaper is disabled (idle timeout ≤ 0), because archiving a task closes its
    // session — so this always runs when task sessions are managed, not only
    // when a reaper is active.
    const idleTimeoutMs =
      opts.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
    const keepaliveIntervalMs = computeKeepaliveIntervalMs(idleTimeoutMs);

    // Rehydrate task-owned sessions on boot so their schedulers re-arm after a
    // restart (a bound task fires only in its own session, which nothing else
    // reloads). Fire-and-forget so it never delays the server coming up; a
    // no-op when there are no bound tasks. Deliberately not awaited.
    const rehydrateWorkspace = (
      taskBridge: AcpSessionBridge,
      workspaceCwd: string,
    ) => {
      void rehydrateScheduledTaskSessions({
        bridge: taskBridge,
        boundWorkspace: workspaceCwd,
        onError: (sessionId, err) => {
          process.stderr.write(
            `qwen serve: failed to rehydrate scheduled-task session ${sessionId}: ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
        },
        // Outer catch is defense-in-depth: rehydrateScheduledTaskSessions already
        // catches readCronTasks failures and per-session load errors internally
        // (returning { loaded, failed }), so this only guards an unexpected throw
        // from the function entry itself. Log rather than swallow it — a silent
        // failure here leaves every bound task dormant with no diagnostic.
      }).catch((err) => {
        process.stderr.write(
          `qwen serve: unexpected scheduled-task rehydration failure: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      });
    };

    // Every registered workspace gets its own keepalive + rehydration against
    // its own cron file + bridge, so a bound task created through the
    // workspace-qualified route fires (and survives a restart) exactly like a
    // primary-workspace one — otherwise a secondary workspace's tasks would be
    // written to disk but silently never revived.
    const keepaliveStops = new Map<string, () => void>();
    const startKeepaliveForWorkspace = (runtime: WorkspaceRuntime) => {
      if (keepaliveStops.has(runtime.workspaceCwd)) return;
      const keepalive = startScheduledTaskKeepalive({
        bridge: runtime.bridge,
        boundWorkspace: runtime.workspaceCwd,
        intervalMs: keepaliveIntervalMs,
      });
      rehydrateWorkspace(runtime.bridge, runtime.workspaceCwd);
      keepaliveStops.set(runtime.workspaceCwd, keepalive.stop);
    };
    for (const runtime of workspaceRegistry.list()) {
      startKeepaliveForWorkspace(runtime);
    }

    // Park a combined stop fn on `app.locals` (same pattern as `fsFactory` /
    // `boundWorkspace` / `acpHandle` above) so the shutdown sequence in
    // run-qwen-serve.ts can invoke it without threading it back through the
    // createServeApp return type. Stopping all is idempotent per keepalive.
    (
      app.locals as { stopScheduledTaskKeepalive?: () => void }
    ).stopScheduledTaskKeepalive = () => {
      for (const stop of keepaliveStops.values()) stop();
      keepaliveStops.clear();
    };
    (
      app.locals as {
        stopScheduledTaskKeepaliveForWorkspace?: (workspaceCwd: string) => void;
      }
    ).stopScheduledTaskKeepaliveForWorkspace = (workspaceCwd) => {
      keepaliveStops.get(workspaceCwd)?.();
      keepaliveStops.delete(workspaceCwd);
    };
    (
      app.locals as {
        startScheduledTaskKeepaliveForWorkspace?: (
          runtime: WorkspaceRuntime,
        ) => void;
      }
    ).startScheduledTaskKeepaliveForWorkspace = startKeepaliveForWorkspace;
  }

  registerPermissionRoutes(app, {
    bridge: primaryBridge,
    workspaceRegistry,
    daemonLog,
    mutate,
    sendPermissionVoteError,
  });

  registerSseEventsRoutes(app, {
    bridge: primaryBridge,
    workspaceRegistry,
    daemonLog,
    writerIdleTimeoutMs: opts.writerIdleTimeoutMs,
    sendBridgeError,
  });

  // Official ACP Streamable HTTP transport (RFD #721) mounted at `/acp`
  // alongside the REST surface, sharing this same `bridge` instance.
  // Additive + toggleable (`QWEN_SERVE_ACP_HTTP=0` opts out).
  // See `docs/design/daemon-acp-http/README.md` for the dual-transport
  // decision. Mounted AFTER the REST routes (distinct path, no overlap)
  // and BEFORE the final error handler so malformed `/acp` bodies still
  // route through the JSON error contract below.
  acpHandleRef.current = mountAcpHttp(app, primaryBridge, {
    boundWorkspace: primaryBoundWorkspace,
    daemonEnv,
    // Phase 4 (issue #6378): pass the registry so `/workspaces/:workspace/acp`
    // mounts a per-runtime ACP dispatcher for each registered workspace.
    workspaceRegistry,
    archiveCoordinator,
    workspace: primaryWorkspace,
    fsFactory: primaryRouteFileSystemFactory,
    deviceFlowRegistry,
    token: opts.token,
    // Mirror the REST CORS allowlist onto the WS CSRF wall so an
    // explicitly permitted origin (e.g. the extension's
    // `chrome-extension://<id>`) can open the reverse tool channel.
    allowedOrigins:
      opts.allowOrigins && opts.allowOrigins.length > 0
        ? parseAllowOriginPatterns(opts.allowOrigins)
        : undefined,
    hostname: opts.hostname,
    sessionShellCommandEnabled,
    workspaceRememberLane,
    checkRate: rateLimiter?.checkRate,
    clientMcpOverWs: opts.clientMcpOverWs === true,
    // Reverse tool channel (issue #5626, Phase 2). Per-connection provider:
    // on `mcp_register` it records the WS registrar's sender in the shared
    // registry and adds an SDK-type runtime MCP server in the ACP child
    // (originator = the connection id). Only meaningful when
    // `clientMcpOverWs` is on; the WS layer never builds a provider otherwise.
    ...(opts.clientMcpOverWs === true
      ? {
          clientMcpProviderFactory: (connectionId: string) =>
            createClientMcpServerProvider(
              primaryRuntime.clientMcpSenderRegistry,
              primaryBridge,
              connectionId,
            ),
        }
      : {}),
    // Plan C CDP tunnel (issue #5626): the `/cdp` branch + `cdp_*` routing
    // activate only when the flag is on and a registry is supplied.
    cdpTunnelOverWs: opts.cdpTunnelOverWs === true,
    ...(cdpTunnelRegistry ? { cdpTunnelRegistry } : {}),
    // Browser captures audio and streams raw PCM here; the daemon transcribes
    // server-side via the reused CLI voice pipeline. Shares the ACP upgrade
    // listener's loopback/CSRF/bearer checks.
    extraWsRoutes: [
      {
        path: '/voice/stream',
        onConnection: createVoiceWsConnectionHandler(primaryBoundWorkspace, {
          env: getRuntimeEffectiveEnv(primaryRuntime.env),
          acquireVoiceLease: () => voiceCoordinator.acquire(primaryRuntime),
        }),
      },
    ],
    workspaceVoiceConnection: (runtime, ws, req) =>
      createVoiceWsConnectionHandler(runtime.workspaceCwd, {
        env: getRuntimeEffectiveEnv(runtime.env),
        acquireVoiceLease: () => voiceCoordinator.acquire(runtime),
      })(ws, req),
  });
  if (acpHandleRef.current) {
    app.locals['acpHandle'] = acpHandleRef.current;
  }

  // Web Shell SPA deep-link fallback — registered AFTER every API route (and
  // just before the error handler) so real routes, including their bearerAuth
  // 401s, always win; only genuine 404 misses fall through to the shell. This
  // is what keeps an attacker-controlled `Accept: text/html` from coaxing the
  // 200 shell out of an authed route.
  if (webShellDir) {
    mountWebShellSpaFallback(app, webShellDir, webShellFrameAncestors);
  }

  installFinalErrorHandler(app);

  if (rateLimiter) {
    setRateLimiter(app, rateLimiter);
  }

  return app;
}
