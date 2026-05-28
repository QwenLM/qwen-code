/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  APPROVAL_MODE_INFO,
  APPROVAL_MODES,
  AuthType,
  clearCachedCredentialFile,
  createDebugLogger,
  generateSessionRecap,
  QwenOAuth2Event,
  qwenOAuth2Events,
  MCP_BUDGET_WARN_FRACTION,
  MCPServerConfig,
  SessionService,
  SESSION_TITLE_MAX_LENGTH,
  tokenLimit,
  getMCPDiscoveryState,
  getMCPServerStatus,
  MCPDiscoveryState,
  MCPServerStatus,
  McpTransportPool,
  POOLED_TRANSPORTS_DEFAULT,
  SessionEndReason,
  WorkspaceMcpBudget,
  DiscoveredMCPTool,
  restoreWorktreeContext,
} from '@qwen-code/qwen-code-core';
import type {
  ApprovalMode,
  Config,
  ConversationRecord,
  DeviceAuthorizationData,
  McpBudgetEvent,
  McpBudgetMode,
  McpTransportKind,
} from '@qwen-code/qwen-code-core';
import {
  AgentSideConnection,
  RequestError,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import type { Content } from '@google/genai';
import type {
  Agent,
  AuthenticateRequest,
  AuthMethod,
  CancelNotification,
  ClientCapabilities,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  McpServer,
  McpServerHttp,
  McpServerSse,
  McpServerStdio,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionInfo,
  SessionModeState,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
} from '@agentclientprotocol/sdk';
import { buildAuthMethods } from './authMethods.js';
import { AcpFileSystemService } from './service/filesystem.js';
import { Readable, Writable } from 'node:stream';
import { normalizeDisabledToolList } from '../config/normalizeDisabledTools.js';
import type { LoadedSettings } from '../config/settings.js';
import { loadSettings, SettingScope } from '../config/settings.js';
import type { ApprovalModeValue } from './session/types.js';
import { z } from 'zod';
import type { CliArgs } from '../config/config.js';
import { loadCliConfig } from '../config/config.js';
import { Session, buildAvailableCommandsSnapshot } from './session/Session.js';
import { buildSessionTasksStatus } from './session/tasksSnapshot.js';
import {
  formatAcpModelId,
  parseAcpBaseModelId,
} from '../utils/acpModelUtils.js';
import { runWithAcpRuntimeOutputDir } from './runtimeOutputDirContext.js';
import { runExitCleanup } from '../utils/cleanup.js';
import {
  ACP_PREFLIGHT_KINDS,
  STATUS_SCHEMA_VERSION,
  SERVE_CONTROL_EXT_METHODS,
  SERVE_STATUS_EXT_METHODS,
  mapDomainErrorToErrorKind,
  type AcpPreflightKind,
  type ServeErrorKind,
  type ServeMcpBudgetMode,
  type ServeMcpBudgetStatusCell,
  type ServeMcpDiscoveryState,
  type ServeMcpServerRuntimeStatus,
  type ServeMcpTransport,
  type ServeWorkspaceMcpToolStatus,
  type ServeWorkspaceMcpToolsStatus,
  type ServePreflightCell,
  type ServePreflightKind,
  type ServeSessionContextStatus,
  type ServeSessionSupportedCommandsStatus,
  type ServeSessionTasksStatus,
  type ServeStatus,
  type ServeStatusCell,
  type ServeWorkspaceMcpServerStatus,
  type ServeWorkspaceMcpStatus,
  type ServeWorkspaceProviderModel,
  type ServeWorkspaceProviderStatus,
  type ServeWorkspaceProvidersStatus,
  type ServeWorkspaceSkillStatus,
  type ServeWorkspaceSkillsStatus,
  type ServeWorkspaceToolStatus,
  type ServeWorkspaceToolsStatus,
  type ServeSessionContextUsageStatus,
} from '../serve/status.js';
import {
  collectContextData,
  formatContextUsageText,
} from '../ui/commands/contextCommand.js';

const debugLogger = createDebugLogger('ACP_AGENT');

/**
 * Env-var candidates per auth method, used by `buildAuthPreflightCell` for
 * a side-effect-free presence check. Mirrors `AUTH_ENV_MAPPINGS` from
 * `core/src/models/constants.ts` (which isn't on the public package
 * surface). Keep in sync if a new provider is added there. Any auth method
 * not listed here surfaces as `status: 'unknown'` on the cell rather than
 * a false `auth_env_error` — full validation happens at session start.
 *
 * Drift detection: `AUTH_PREFLIGHT_AUDITED_AUTH_TYPES` below lists every
 * `AuthType` enum value that has been triaged for this map (either keyed
 * here, or explicitly waived for non-env-based auth like qwen-oauth). The
 * paired test `AUTH_PREFLIGHT_AUDITED_AUTH_TYPES covers every AuthType`
 * walks the public enum and fails CI when core adds a new auth method
 * without a deliberate decision here.
 */
export const AUTH_PREFLIGHT_ENV_KEYS: Readonly<
  Record<string, readonly string[]>
> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY'],
  'vertex-ai': ['GOOGLE_API_KEY'],
};

/**
 * Auth methods deliberately not env-keyed (e.g. OAuth-based, credential
 * file). Listed here so the drift test recognizes them as triaged-but-
 * waived rather than a missing entry.
 */
export const AUTH_PREFLIGHT_WAIVED_AUTH_TYPES: ReadonlySet<string> = new Set([
  'qwen-oauth',
]);

export async function runAcpAgent(
  config: Config,
  settings: LoadedSettings,
  argv: CliArgs,
) {
  // F2 (#4175 commit 6 review fix — claude-opus-4-7 W119): skip MCP
  // discovery in the BOOTSTRAP config. Pre-fix every stdio MCP server
  // was spawned twice — once by the bootstrap (legacy per-server path,
  // pool=undefined, invisible to budget / drainAll / pid-sweep) and
  // once via each session's pool-routed discovery. With N servers and
  // M sessions, the headline `4 sessions × budget=2 caps at 2`
  // contract was silently violated by the bootstrap copies. Bootstrap
  // MCP clients are never used to serve a session (each session
  // builds its own per-session Config and runs discovery there), so
  // skipping at the bootstrap layer is safe AND closes the 2N
  // subprocess leak.
  const bootstrapSkipsMcpDiscovery = true;
  await config.initialize({
    skipGeminiInitialization: true,
    skipMcpDiscovery: bootstrapSkipsMcpDiscovery,
  });
  // F2 (#4175 commit 6 review fix — claude-opus-4-7 W132): the
  // `failedMcpServers` warning was unconditional, but
  // `getMCPServerStatus` defaults to DISCONNECTED for absent entries
  // (`mcp-client.ts:407-409`). Under `skipMcpDiscovery: true` the
  // global `serverStatuses` map has no entries for any of this
  // workspace's MCP servers, so every configured non-disabled server
  // was reported as failed — false-positive "Warning: MCP server(s)
  // failed to start" on every `qwen serve` startup, even when the
  // per-session pool-routed discovery would spin them up successfully
  // a moment later. Skip the warning when we know discovery was
  // intentionally bypassed; per-session paths surface real failures
  // through their own status routes / events.
  if (!bootstrapSkipsMcpDiscovery) {
    await config.waitForMcpReady();
    const failedMcpServers =
      typeof config.getFailedMcpServerNames === 'function'
        ? config.getFailedMcpServerNames()
        : [];
    if (failedMcpServers.length > 0) {
      process.stderr.write(
        `Warning: MCP server(s) failed to start: ${failedMcpServers.join(', ')}. ` +
          `Continuing with built-in tools and any servers that did connect.\n`,
      );
    }
  }

  const stdout = Writable.toWeb(process.stdout) as WritableStream;
  const stdin = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

  // Stdout is used to send messages to the client, so console.log/console.info
  // messages to stderr so that they don't interfere with ACP.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;

  const stream = ndJsonStream(stdout, stdin);
  let agentInstance: QwenAgent | undefined;
  const connection = new AgentSideConnection((conn) => {
    agentInstance = new QwenAgent(config, settings, argv, conn);
    return agentInstance;
  }, stream);

  // F2 (#4175 commit 5 review fix — wenshao R8): both the SIGTERM
  // handler and the IDE-initiated close path need to drain the MCP
  // pool before runExitCleanup. Pre-fix the same try/catch with the
  // same 8s timeout was duplicated verbatim — easy drift target.
  // Single helper closure keeps the timeout + log labels consistent
  // and means future changes to the drain semantics happen in one
  // place. 8s budget is `MAX_DRAIN_MS - 2s` (per design §17 wall-
  // clock budget) so descendant pid sweeps still complete before
  // runExitCleanup's own kill loop kicks in.
  const drainPoolBeforeExit = async (label: string): Promise<void> => {
    if (!agentInstance) return;
    try {
      await agentInstance.shutdownMcpPool(8_000);
    } catch (err) {
      debugLogger.error(`[ACP] MCP pool drain (${label}) error:`, err);
    }
  };

  // Handle SIGTERM/SIGINT for graceful shutdown.
  // Without this, signal handlers registered elsewhere in the CLI
  // (e.g., stdin raw mode restoration) override the default exit behavior,
  // causing the ACP process to ignore termination signals.
  let shuttingDown = false;
  let sessionEndFired = false;

  // Helper to fire SessionEnd hook once, preventing double-fire from both
  // shutdown handler path and connection.closed path.
  const fireSessionEndOnce = async (reason: SessionEndReason) => {
    if (sessionEndFired) return;
    sessionEndFired = true;

    const configs = new Set<Config>([config]);
    const sessions = agentInstance?.getActiveSessions();
    if (sessions) {
      for (const session of sessions) {
        const sessionConfig = session.getConfig?.();
        if (sessionConfig) {
          configs.add(sessionConfig);
        }
      }
    }

    for (const cfg of configs) {
      const hookSystem = cfg.getHookSystem?.();
      const hooksEnabled = !cfg.getDisableAllHooks?.();
      if (
        !hooksEnabled ||
        !hookSystem ||
        !cfg.hasHooksForEvent?.('SessionEnd')
      ) {
        continue;
      }
      try {
        await hookSystem.fireSessionEndEvent(reason);
      } catch (err) {
        debugLogger.warn(
          `SessionEnd hook failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  const shutdownHandler = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    debugLogger.debug('[ACP] Shutdown signal received, closing streams');

    // Fire SessionEnd hook for all active sessions (aligned with core path)
    await fireSessionEndOnce(SessionEndReason.Other);

    try {
      process.stdin.destroy();
    } catch {
      // stdin may already be closed
    }
    try {
      process.stdout.destroy();
    } catch {
      // stdout may already be closed
    }
    // F2 (#4175 commit 4): drain the workspace MCP pool BEFORE
    // runExitCleanup so the descendant pid sweep (commit 3) can
    // SIGTERM npx/uvx wrapper grandchildren. runExitCleanup's own
    // child kill is a fallback for processes the pool didn't track.
    await drainPoolBeforeExit('signal');
    // Clean up child processes (MCP servers, etc.) and force exit.
    // Without this, orphan subprocesses keep the Node.js event loop alive
    // and the CLI process never terminates after the IDE disconnects.
    runExitCleanup()
      .catch((err) => {
        debugLogger.error('[ACP] Cleanup error:', err);
      })
      .finally(() => {
        process.exit(0);
      });
  };
  process.on('SIGTERM', shutdownHandler);
  process.on('SIGINT', shutdownHandler);

  await connection.closed;
  // Connection closed by IDE - fire SessionEnd hook (aligned with core path)
  await fireSessionEndOnce(SessionEndReason.PromptInputExit);
  // F2 (#4175 commit 4 review fix — wenshao C1): the SIGTERM/SIGINT
  // shutdownHandler drains the pool, but the IDE-initiated normal
  // close path (this branch) returned without draining, leaking
  // shared MCP entries (subprocess + descendants) until the OS
  // eventually reaped them — a real regression vs pre-F2 daemon
  // mode where each session's manager torn down its own clients
  // on disconnect. Mirror the SIGTERM handler's pool drain here via
  // the shared helper (R8 fold-in).
  await drainPoolBeforeExit('ide_close');

  process.off('SIGTERM', shutdownHandler);
  process.off('SIGINT', shutdownHandler);
}

export function toStdioServer(server: McpServer): McpServerStdio | undefined {
  if ('command' in server && 'args' in server && 'env' in server) {
    return server as McpServerStdio;
  }
  return undefined;
}

export function toSseServer(
  server: McpServer,
): (McpServerSse & { type: 'sse' }) | undefined {
  if ('type' in server && server.type === 'sse') {
    return server as McpServerSse & { type: 'sse' };
  }
  return undefined;
}

export function toHttpServer(
  server: McpServer,
): (McpServerHttp & { type: 'http' }) | undefined {
  if ('type' in server && server.type === 'http') {
    return server as McpServerHttp & { type: 'http' };
  }
  return undefined;
}

/**
 * F2 (#4175 commit 4): parse `QWEN_SERVE_MCP_POOL_TRANSPORTS` env var
 * (set by `runQwenServe.ts` from the `--mcp-pool-transports` CLI flag).
 * Comma-separated list e.g. "stdio,websocket,http". Falls back to
 * `POOLED_TRANSPORTS_DEFAULT` ({stdio, websocket}) on missing /
 * malformed input. Unknown transport names are silently dropped — the
 * resulting set is still a valid `ReadonlySet<McpTransportKind>`.
 */
function parsePooledTransports(
  envValue: string | undefined,
): ReadonlySet<McpTransportKind> {
  if (!envValue || !envValue.trim()) return POOLED_TRANSPORTS_DEFAULT;
  const KNOWN: ReadonlySet<McpTransportKind> = new Set([
    'stdio',
    'websocket',
    'http',
    'sse',
  ]);
  const out = new Set<McpTransportKind>();
  for (const raw of envValue.split(',')) {
    const trimmed = raw.trim().toLowerCase();
    if (KNOWN.has(trimmed as McpTransportKind)) {
      out.add(trimmed as McpTransportKind);
    }
  }
  // Empty after parsing (all unknown) → fall back to defaults so an
  // operator typo doesn't silently disable the pool entirely.
  return out.size > 0 ? out : POOLED_TRANSPORTS_DEFAULT;
}

/**
 * Parse `QWEN_SERVE_MCP_POOL_DRAIN_MS` env var. Default 30000ms per
 * design §6.3. Bounded to [1000, 600000] (1s–10min) so a typo
 * can't permanently strand pool entries (lower bound) or starve the
 * MAX_IDLE hard cap (upper bound).
 */
function parsePoolDrainMs(envValue: string | undefined): number {
  if (!envValue) return 30_000;
  // F2 (#4175 commit 6 review fix — wenshao W9): reject input that
  // contains anything other than digits. Pre-fix `Number.parseInt`
  // accepted `'30000ms'`, `'30000abc'`, etc. (silently truncating to
  // 30000), so an operator hand-editing env vars with a unit
  // suffix or typo would get a value that "looks parsed" but
  // actually represents a misconfiguration. Strict regex prevents
  // both classes; on rejection we log a stderr warning AND fall
  // back to the default rather than raising at boot (boot-fatal
  // would be more aggressive than the rest of `qwen serve`'s
  // env-validation surface, which uniformly degrades-with-warning).
  const trimmed = envValue.trim();
  if (!/^\d+$/.test(trimmed)) {
    process.stderr.write(
      `qwen serve: QWEN_SERVE_MCP_POOL_DRAIN_MS=${JSON.stringify(envValue)} ` +
        `is not a valid integer; using default 30000ms.\n`,
    );
    return 30_000;
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return 30_000;
  return Math.min(600_000, Math.max(1_000, n));
}

/**
 * F2 (#4175 commit 6): construct the workspace-scoped MCP budget
 * controller from the daemon's env vars (`QWEN_SERVE_MCP_CLIENT_BUDGET`,
 * `QWEN_SERVE_MCP_BUDGET_MODE`). Returns `undefined` when budget is
 * unset OR resolves to `off` mode — both signal "no enforcement", and
 * the pool's snapshot path should treat the controller as absent so
 * the legacy per-session cell shape remains. Mirrors
 * `McpClientManager`'s constructor-time budget resolution to keep
 * env-var behavior identical between pool and non-pool modes.
 *
 * The pool is responsible for invoking `tryReserve`/`release`; this
 * helper just produces the controller and wires the event callback.
 * `onEvent` is invoked with the workspace-scoped budget event; the
 * callback (typically `QwenAgent.broadcastBudgetEvent`) fans it out
 * to every attached session.
 */
function createWorkspaceMcpBudget(
  onEvent: (event: McpBudgetEvent) => void,
): WorkspaceMcpBudget | undefined {
  const rawBudget = process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'];
  const rawMode = process.env['QWEN_SERVE_MCP_BUDGET_MODE'];
  // F2 (#4175 commit 6 review fix — wenshao W24): match
  // `McpClientManager.readBudgetFromEnv`'s parsing exactly. Pre-fix
  // we used `Number.parseInt(rawBudget, 10)` which silently accepted
  // `"2.5"` as `2`, `"1e2"` as `1` (manager reads it as `100` — 100×
  // enforcement divergence on the same env var), and rejected
  // `"0x10"` (manager accepts as `16`). Switch to `Number(...)` +
  // explicit `Number.isInteger` guard so the pool and the manager
  // honor the same env values.
  const budget =
    rawBudget !== undefined && rawBudget !== '' ? Number(rawBudget) : undefined;
  const mode: McpBudgetMode = (() => {
    if (rawMode === 'enforce' || rawMode === 'warn' || rawMode === 'off') {
      return rawMode;
    }
    return budget !== undefined &&
      Number.isFinite(budget) &&
      Number.isInteger(budget) &&
      budget > 0
      ? 'warn'
      : 'off';
  })();
  if (
    mode === 'off' ||
    budget === undefined ||
    !Number.isFinite(budget) ||
    !Number.isInteger(budget) ||
    budget <= 0
  ) {
    return undefined;
  }
  return new WorkspaceMcpBudget({
    clientBudget: budget,
    mode,
    onEvent,
  });
}

class QwenAgent implements Agent {
  private sessions: Map<string, Session> = new Map();
  private clientCapabilities: ClientCapabilities | undefined;

  /**
   * F2 (#4175 commit 4): workspace-shared MCP transport pool. Eagerly
   * constructed in the ctor (per V21-13 Q6 resolved); lazy w.r.t.
   * actual MCP work — spawns nothing until the first session's
   * `discoverAllMcpToolsViaPool` calls `pool.acquire`.
   *
   * Set to `undefined` when `QWEN_SERVE_NO_MCP_POOL=1` env var is
   * present (kill switch for rollback / A-B comparison). When
   * undefined, sessions fall back to per-session McpClient spawn
   * (pre-F2 behavior, identical to standalone `qwen` runtime).
   *
   * Single instance per QwenAgent → single instance per ACP child
   * process → single instance per workspace (post-#4113 invariant).
   * Pool is workspace-bound via `this.config.getWorkspaceContext()`.
   */
  private readonly mcpPool?: McpTransportPool;

  /**
   * F2 (#4175 commit 6): workspace-scoped MCP budget controller.
   * Constructed alongside `mcpPool` when `--mcp-client-budget=N` is
   * configured. Pool delegates `tryReserve` / `release` to this
   * controller so the cap caps the workspace, not each session.
   * `undefined` when no budget is configured OR when the pool kill
   * switch is on.
   */
  private readonly workspaceMcpBudget?: WorkspaceMcpBudget;

  getActiveSessions(): Session[] {
    return [...this.sessions.values()];
  }

  /**
   * F2 (#4175 commit 4): drain the workspace MCP transport pool.
   * Called by the runAcpAgent SIGTERM/SIGINT shutdownHandler so all
   * pool entries (subprocess + wrappers) get a coordinated SIGTERM
   * with descendant pid sweep before process.exit. No-op when pool
   * is undefined (kill-switch mode).
   *
   * Bounded by `timeoutMs` (default 10s); entries that don't close
   * cleanly are reported in `DrainResult.errors` but the pool clears
   * its maps regardless because the process is exiting.
   */
  async shutdownMcpPool(timeoutMs = 10_000): Promise<void> {
    if (!this.mcpPool) return;
    try {
      const result = await this.mcpPool.drainAll({ force: true, timeoutMs });
      if (result.forced > 0 || result.errors.length > 0) {
        debugLogger.warn(
          `MCP pool drain: ${result.drained} clean, ${result.forced} timed out, ` +
            `${result.errors.length} errors`,
        );
      }
    } catch (err) {
      debugLogger.error(
        `MCP pool drainAll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async closeStoredSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.mcpPool?.releaseSession(sessionId);
      return;
    }

    try {
      await session.cancelPendingPrompt();
    } catch (err) {
      debugLogger.debug(
        `Session ${sessionId} cancel during close failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    try {
      await session.getConfig().getToolRegistry()?.stop();
    } catch (err) {
      debugLogger.debug(
        `Session ${sessionId} tool registry stop during close failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    this.mcpPool?.releaseSession(sessionId);
    this.sessions.delete(sessionId);
  }

  constructor(
    private config: Config,
    private settings: LoadedSettings,
    private argv: CliArgs,
    private connection: AgentSideConnection,
  ) {
    // Pool kill switch via env var so operators can A/B compare or
    // roll back without rebuilding. `runQwenServe.ts` sets this when
    // `--no-mcp-pool` is passed at daemon startup.
    if (process.env['QWEN_SERVE_NO_MCP_POOL'] === '1') {
      this.mcpPool = undefined;
      this.workspaceMcpBudget = undefined;
    } else {
      // F2 (#4175 commit 6): construct the workspace-scoped budget
      // controller when `--mcp-client-budget=N` was set at boot. The
      // ACP child receives the value via env var (set by the daemon
      // parent in `runQwenServe.ts`), the same path the pre-F2
      // per-session McpClientManager reads from. With the pool
      // active, this controller's accounting REPLACES per-session
      // copies — 4 sessions × budget=2 caps the workspace at 2,
      // not 8 (per design §11). Budget event delivery uses
      // `broadcastBudgetEvent` to fan out to every attached session
      // via SSE notifications; if no sessions are attached at fire
      // time, the event is dropped (snapshot still carries the
      // hysteresis state for clients that reconnect).
      this.workspaceMcpBudget = createWorkspaceMcpBudget((event) => {
        this.broadcastBudgetEvent(event);
      });
      this.mcpPool = new McpTransportPool(this.config, {
        workspaceContext: this.config.getWorkspaceContext(),
        debugMode: this.config.getDebugMode(),
        // sendSdkMcpMessage left undefined: SDK MCP servers always
        // bypass the pool via createUnpooledConnection (per-session
        // routing through ACP control plane). The legacy
        // McpClientManager path retains its own per-session SDK
        // wiring; pool-mode discoverAllMcpToolsViaPool delegates SDK
        // MCP to that bypass.
        pooledTransports: parsePooledTransports(
          process.env['QWEN_SERVE_MCP_POOL_TRANSPORTS'],
        ),
        drainDelayMs: parsePoolDrainMs(
          process.env['QWEN_SERVE_MCP_POOL_DRAIN_MS'],
        ),
        budget: this.workspaceMcpBudget,
      });
    }
  }

  /**
   * F2 (#4175 commit 6): expose pool's workspace-scoped budget
   * controller for snapshot builders. Returns `undefined` when the
   * pool is disabled (`QWEN_SERVE_NO_MCP_POOL=1`) OR no
   * `--mcp-client-budget` was configured (controller not constructed).
   */
  getWorkspaceMcpBudget(): WorkspaceMcpBudget | undefined {
    return this.workspaceMcpBudget;
  }

  /**
   * F2 (#4175 commit 6): fan-out a workspace-scoped MCP budget event
   * to every active session's SSE bus. Replaces the per-session
   * `setMcpBudgetEventCallback` wiring in `newSessionConfig` for
   * pool-mode daemons — the pool's `WorkspaceMcpBudget` fires once,
   * this method sends one `extNotification` per attached session.
   * Each notification is independently fire-and-forget (a mid-flight
   * ACP disconnect on one session must not sink delivery to siblings).
   */
  private broadcastBudgetEvent(event: McpBudgetEvent): void {
    // The QwenAgent's `this.connection` is the single ACP channel to
    // the daemon. The daemon's bridge `bridgeClient.extNotification`
    // resolves the per-session SSE bus from the `sessionId` field of
    // each notification — so we send N notifications (one per active
    // session id) over the same connection. Each notification is
    // independently fire-and-forget; a mid-flight ACP disconnect
    // shouldn't sink delivery to siblings.
    //
    // R3 (commit 6 self-review fold-in): snapshot the session id
    // list before the async fan-out so a concurrent `killSession`
    // (which mutates `this.sessions` synchronously) can't corrupt
    // the iterator. `Array.from` produces a stable snapshot; per-id
    // notifications then run on the snapshot regardless of live-map
    // mutations.
    const sessionIds = Array.from(this.sessions.keys());
    for (const sid of sessionIds) {
      void this.connection
        .extNotification('qwen/notify/session/mcp-budget-event', {
          v: 1,
          sessionId: sid,
          // F2 (#4175 commit 6): tag every workspace-scoped event so
          // SDK reducers can branch via `isWorkspaceScopedBudgetEvent`.
          // Per-session legacy events keep `scope` absent (means
          // 'session'), preserving the additive-protocol contract.
          scope: 'workspace' as const,
          ...event,
        })
        .catch((err: unknown) => {
          debugLogger.debug(
            `MCP workspace budget event delivery to session ${sid} failed ` +
              `(kind=${event.kind}): ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
  }

  async initialize(args: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = args.clientCapabilities;
    const authMethods = buildAuthMethods();
    const version = process.env['CLI_VERSION'] || process.version;

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: 'qwen-code',
        title: 'Qwen Code',
        version,
      },
      authMethods,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: true,
          embeddedContext: true,
        },
        sessionCapabilities: {
          list: {},
          resume: {},
        },
        mcpCapabilities: {
          sse: true,
          http: true,
        },
      },
    };
  }

  async authenticate({ methodId }: AuthenticateRequest): Promise<void> {
    const method = z.nativeEnum(AuthType).parse(methodId);

    let authUri: string | undefined;
    const authUriHandler = (deviceAuth: DeviceAuthorizationData) => {
      authUri = deviceAuth.verification_uri_complete;
      void this.connection.extNotification('authenticate/update', {
        _meta: { authUri },
      });
    };

    if (method === AuthType.QWEN_OAUTH) {
      qwenOAuth2Events.once(QwenOAuth2Event.AuthUri, authUriHandler);
    }

    await clearCachedCredentialFile();
    try {
      await this.config.refreshAuth(method);
      this.settings.setValue(
        SettingScope.User,
        'security.auth.selectedType',
        method,
      );
    } finally {
      if (method === AuthType.QWEN_OAUTH) {
        qwenOAuth2Events.off(QwenOAuth2Event.AuthUri, authUriHandler);
      }
    }
  }

  async newSession({
    cwd,
    mcpServers,
  }: NewSessionRequest): Promise<NewSessionResponse> {
    const config = await this.newSessionConfig(cwd, mcpServers);
    await this.ensureAuthenticated(config);
    this.setupFileSystem(config);

    const session = await this.createAndStoreSession(config);
    const availableModels = this.buildAvailableModels(config);
    const modesData = this.buildModesData(config);
    const configOptions = this.buildConfigOptions(config);

    return {
      sessionId: session.getId(),
      models: availableModels,
      modes: modesData,
      configOptions,
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const exists = await runWithAcpRuntimeOutputDir(
      this.settings,
      params.cwd,
      async () => {
        const sessionService = new SessionService(params.cwd);
        return sessionService.sessionExists(params.sessionId);
      },
    );
    if (!exists) {
      throw RequestError.resourceNotFound(`session:${params.sessionId}`);
    }

    const config = await this.newSessionConfig(
      params.cwd,
      // `LoadSessionRequest.mcpServers` is required in today's ACP
      // schema, but mirror `unstable_resumeSession` and tolerate a
      // future loosening — `newSessionConfig` iterates the list, so
      // a `null`/`undefined` would otherwise throw `TypeError`.
      params.mcpServers ?? [],
      params.sessionId,
      true,
    );
    await this.ensureAuthenticated(config);
    this.setupFileSystem(config);

    const sessionData = config.getResumedSessionData();
    const session = await this.createAndStoreSession(
      config,
      sessionData?.conversation,
    );

    await this.#restoreWorktreeOnResume(config, session);

    const modesData = this.buildModesData(config);
    const availableModels = this.buildAvailableModels(config);
    const configOptions = this.buildConfigOptions(config);

    return {
      modes: modesData,
      models: availableModels,
      configOptions,
    };
  }

  async unstable_resumeSession(
    params: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    const exists = await runWithAcpRuntimeOutputDir(
      this.settings,
      params.cwd,
      async () => {
        const sessionService = new SessionService(params.cwd);
        return sessionService.sessionExists(params.sessionId);
      },
    );
    if (!exists) {
      throw RequestError.resourceNotFound(`session:${params.sessionId}`);
    }

    const config = await this.newSessionConfig(
      params.cwd,
      params.mcpServers ?? [],
      params.sessionId,
      true,
    );
    await this.ensureAuthenticated(config);
    this.setupFileSystem(config);

    const session = await this.createAndStoreSession(config);

    await this.#restoreWorktreeOnResume(config, session);

    const modesData = this.buildModesData(config);
    const availableModels = this.buildAvailableModels(config);
    const configOptions = this.buildConfigOptions(config);

    return {
      modes: modesData,
      models: availableModels,
      configOptions,
    };
  }

  /**
   * Shared worktree restore for both ACP entry points (`loadSession` and
   * `unstable_resumeSession`). Reads the WorktreeSession sidecar, cleans
   * up stale ones, and queues the context reminder on the Session so the
   * next `#executePrompt` prepends it to the user's first prompt.
   *
   * Best-effort: failures don't block session load — worktree context
   * is a hint to the model, not a load-time correctness requirement.
   * (PR #4174 review #3259975... — parity between the two ACP entry
   * points.)
   */
  async #restoreWorktreeOnResume(
    config: Config,
    session: Session,
  ): Promise<void> {
    try {
      const sessionPath = config
        .getSessionService()
        .getWorktreeSessionPath(config.getSessionId());
      const restored = await restoreWorktreeContext(sessionPath);
      if (restored.contextMessage) {
        session.pendingWorktreeNotice = restored.contextMessage;
      }
    } catch (error) {
      debugLogger.warn(`ACP worktree restore failed: ${error}`);
    }
  }

  async unstable_listSessions(
    params: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const cwd = params.cwd || process.cwd();
    const numericCursor = params.cursor ? Number(params.cursor) : undefined;

    // The ACP spec's ListSessionsRequest doesn't include a page-size field,
    // so the SDK's zod validator strips any top-level `size` the client sends
    // before it reaches this handler. Carry page size through `_meta.size`
    // (same pattern filesystem.ts uses for `_meta.bom` / `_meta.encoding`).
    const metaSize = params._meta?.['size'];
    const size =
      typeof metaSize === 'number' && metaSize > 0
        ? Math.floor(metaSize)
        : undefined;

    const result = await runWithAcpRuntimeOutputDir(this.settings, cwd, () => {
      const sessionService = new SessionService(cwd);
      return sessionService.listSessions({
        cursor: Number.isNaN(numericCursor) ? undefined : numericCursor,
        size,
      });
    });

    const sessions: SessionInfo[] = result.items.map((item) => ({
      cwd: item.cwd,
      sessionId: item.sessionId,
      title: item.customTitle || item.prompt || '(session)',
      updatedAt: new Date(item.mtime).toISOString(),
    }));

    return {
      sessions,
      nextCursor:
        result.nextCursor != null ? String(result.nextCursor) : undefined,
    };
  }

  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse | void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${params.sessionId}`,
      );
    }
    return session.setMode(params);
  }

  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${params.sessionId}`,
      );
    }
    return await session.setModel(params);
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const { sessionId, configId, value } = params;

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${sessionId}`,
      );
    }

    switch (configId) {
      case 'mode': {
        await this.setSessionMode({
          sessionId,
          modeId: value as string,
        });
        break;
      }
      case 'model': {
        await session.setModel(
          {
            sessionId,
            modelId: value as string,
          },
          { persistDefault: false },
        );
        break;
      }
      default:
        throw RequestError.invalidParams(
          undefined,
          `Unsupported configId: ${configId}`,
        );
    }

    return {
      configOptions: this.buildConfigOptions(session.getConfig()),
    };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    return session.prompt(params);
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    await session.cancelPendingPrompt();
  }

  private workspaceCwd(config: Config): string {
    return config.getTargetDir();
  }

  private safeWorkspaceCwd(config: Config): string {
    try {
      return this.workspaceCwd(config);
    } catch {
      return '';
    }
  }

  private mcpTransport(server: unknown): ServeMcpTransport {
    if (
      server &&
      typeof server === 'object' &&
      'type' in server &&
      (server as { type?: unknown }).type === 'sdk'
    ) {
      return 'sdk';
    }
    if (
      server &&
      typeof server === 'object' &&
      typeof (server as { httpUrl?: unknown }).httpUrl === 'string'
    ) {
      return 'http';
    }
    if (
      server &&
      typeof server === 'object' &&
      typeof (server as { url?: unknown }).url === 'string'
    ) {
      return 'sse';
    }
    if (
      server &&
      typeof server === 'object' &&
      typeof (server as { tcp?: unknown }).tcp === 'string'
    ) {
      return 'websocket';
    }
    if (
      server &&
      typeof server === 'object' &&
      typeof (server as { command?: unknown }).command === 'string'
    ) {
      return 'stdio';
    }
    return 'unknown';
  }

  private mcpStatus(status: MCPServerStatus): ServeMcpServerRuntimeStatus {
    switch (status) {
      case MCPServerStatus.CONNECTED:
        return 'connected';
      case MCPServerStatus.CONNECTING:
        return 'connecting';
      case MCPServerStatus.DISCONNECTED:
      default:
        return 'disconnected';
    }
  }

  private mcpCellStatus(
    status: MCPServerStatus,
    disabled: boolean,
  ): ServeStatus {
    if (disabled) return 'disabled';
    switch (status) {
      case MCPServerStatus.CONNECTED:
        return 'ok';
      case MCPServerStatus.CONNECTING:
        return 'warning';
      case MCPServerStatus.DISCONNECTED:
      default:
        return 'error';
    }
  }

  private discoveryState(): ServeMcpDiscoveryState {
    const state = getMCPDiscoveryState();
    switch (state) {
      case MCPDiscoveryState.IN_PROGRESS:
        return 'in_progress';
      case MCPDiscoveryState.COMPLETED:
        return 'completed';
      case MCPDiscoveryState.NOT_STARTED:
      default:
        return 'not_started';
    }
  }

  private buildWorkspaceMcpStatus(config: Config): ServeWorkspaceMcpStatus {
    try {
      const workspaceCwd = this.workspaceCwd(config);
      const servers = config.getMcpServers() ?? {};

      // F2 (#4175 commit 5): pool snapshot powers `entryCount` +
      // `entrySummary` per-server fields. Captured once outside the
      // per-server loop because `pool.getSnapshot()` walks every entry
      // and we don't want N walks for N servers. Absent when the pool
      // is disabled (`QWEN_SERVE_NO_MCP_POOL=1`); per-server
      // enrichment then no-ops and the snapshot reverts to the legacy
      // (pre-F2) shape — that's the contract for daemons that
      // advertise `mcp_workspace_pool: false`.
      let poolByName: Record<
        string,
        {
          entryCount: number;
          entrySummary: ReadonlyArray<{
            entryIndex: number;
            refs: number;
            status: MCPServerStatus;
          }>;
        }
      > = {};
      try {
        const snap = this.mcpPool?.getSnapshot();
        if (snap) poolByName = snap.byName;
      } catch (err) {
        // Pool snapshot failures must not crash the wider status —
        // surface to stderr so silent regressions are visible without
        // depending on `debugLogger.debug` operator opt-in (matches
        // the budget-accounting fail-loud pattern below).
        process.stderr.write(
          `qwen serve: pool snapshot for workspace MCP status failed: ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
      }

      // PR 14: pull live accounting + budget config from the child's
      // McpClientManager so the daemon's read-only route reflects the
      // single source of truth (not a daemon-side polled cache).
      // `getToolRegistry()` and `getMcpClientManager()` are best-effort
      // — older test stubs or partially-initialized configs may not
      // expose them; in that case we fall back to "no budget surface".
      //
      // F2 (#4175 commit 6): when the workspace-scoped budget
      // controller is active, prefer its accounting — clientCount /
      // clientBudget / budgetMode come from the workspace budget
      // (one cap across all sessions) and the snapshot cell carries
      // `scope: 'workspace'`. Manager fall-back keeps the legacy
      // per-session cell shape for daemons without a configured
      // budget OR with the kill switch on.
      let clientCount: number | undefined;
      let clientBudget: number | undefined;
      let budgetMode: ServeMcpBudgetMode | undefined;
      let refusedSet: ReadonlySet<string> = new Set<string>();
      let budgetCellScope: 'workspace' | 'session' = 'session';
      const wsBudget = this.workspaceMcpBudget;
      if (wsBudget !== undefined) {
        budgetCellScope = 'workspace';
        clientCount = wsBudget.getReservedCount();
        clientBudget = wsBudget.getBudget();
        budgetMode = this.coerceBudgetMode(wsBudget.getMode());
        refusedSet = new Set(wsBudget.getRefusedServerNames());
      } else {
        try {
          const manager = config.getToolRegistry()?.getMcpClientManager();
          if (manager) {
            const accounting = manager.getMcpClientAccounting();
            clientCount = accounting.total;
            clientBudget = manager.getMcpClientBudget();
            budgetMode = manager.getMcpBudgetMode();
            refusedSet = new Set(accounting.refusedServerNames);
          }
        } catch (err) {
          // Accounting failure must not crash the snapshot — the per-
          // server data is still useful even without budget overlay.
          // PR 14 fix (review #4247 wenshao S7a): bumped from
          // `debugLogger.debug` to stderr `process.stderr.write` so a
          // production daemon emits a visible warning when accounting
          // breaks. `debugLogger.debug` is gated on the operator
          // having set debug=true, which makes silent slot-leak / type-
          // mismatch failures invisible in real deployments.
          process.stderr.write(
            `qwen serve: getMcpClientAccounting failed: ` +
              `${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }

      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: true,
        discoveryState: this.discoveryState(),
        servers: Object.entries(servers).map(([name, server]) => {
          const disabled = config.isMcpServerDisabled(name);
          const rawStatus = getMCPServerStatus(name);
          const refusedByBudget = refusedSet.has(name);
          // PR 14 fix (review #4247): config-disable takes precedence
          // over budget-refusal. `lastRefusedServerNames` is a
          // per-discovery-pass snapshot; if an operator runs
          // `/mcp disable <name>` against a server that was refused
          // last pass, the entry stays in the refused list until the
          // next discovery pass clears it (`McpClientManager.removeServer`
          // now drops the entry too — see sibling fix). Either way,
          // a `disabled` cell should NEVER show `budget_exhausted` —
          // the operator's deliberate disable wins.
          const effectivelyRefused = refusedByBudget && !disabled;
          const out: ServeWorkspaceMcpServerStatus = {
            kind: 'mcp_server',
            // Refused-by-budget shadows the raw status: the rawStatus
            // is `DISCONNECTED` (we never tried to connect), but the
            // operator-facing severity is `error` with an explanatory
            // errorKind rather than the generic disconnected `error`.
            status: effectivelyRefused
              ? 'error'
              : this.mcpCellStatus(rawStatus, disabled),
            name,
            mcpStatus: this.mcpStatus(rawStatus),
            transport: this.mcpTransport(server),
            disabled,
          };
          if (effectivelyRefused) {
            out.errorKind = 'budget_exhausted';
            out.disabledReason = 'budget';
            out.hint =
              'Raise --mcp-client-budget or remove servers from mcpServers config.';
          } else if (disabled) {
            out.disabledReason = 'config';
          }
          const description =
            server && typeof server === 'object'
              ? (server as { description?: unknown }).description
              : undefined;
          const extensionName =
            server && typeof server === 'object'
              ? (server as { extensionName?: unknown }).extensionName
              : undefined;
          if (typeof description === 'string') {
            out.description = description;
          }
          if (typeof extensionName === 'string') {
            out.extensionName = extensionName;
          }
          // F2 (#4175 commit 5): pool entries enrichment. `entryCount`
          // and `entrySummary` are present together (or both absent)
          // — guards on `mcp_workspace_pool` capability advertise the
          // pair atomically. The runtime status is mapped through the
          // existing `this.mcpStatus(...)` so downstream string-typed
          // consumers see the same `'connected' | 'connecting' |
          // 'disconnected'` enum the top-level `mcpStatus` field uses.
          const poolRow = poolByName[name];
          if (poolRow) {
            out.entryCount = poolRow.entryCount;
            out.entrySummary = poolRow.entrySummary.map((e) => ({
              entryIndex: e.entryIndex,
              refs: e.refs,
              status: this.mcpStatus(e.status),
            }));
          }
          return out;
        }),
        ...(clientCount !== undefined ? { clientCount } : {}),
        ...(clientBudget !== undefined ? { clientBudget } : {}),
        ...(budgetMode !== undefined ? { budgetMode } : {}),
        ...(budgetMode !== undefined
          ? {
              // PR 14 fix (review #4247 wenshao R2-#6): filter out
              // servers that are now config-disabled so the
              // workspace cell matches the per-server cell
              // precedence (`effectivelyRefused = refusedByBudget
              // && !disabled` above). Pre-fix a server disabled
              // after being refused would render `disabled` on its
              // per-server row but `error: budget_exhausted` on the
              // workspace row — confusing for dashboards. Use
              // `Array.from(refusedSet).filter(...)` to apply the
              // same disabled gate the per-server loop applies.
              budgets: this.buildBudgetCells(
                clientCount ?? 0,
                clientBudget,
                budgetMode,
                Array.from(refusedSet).filter(
                  (n) => !config.isMcpServerDisabled(n),
                ).length,
                budgetCellScope,
              ),
            }
          : {}),
      };
    } catch (error) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.safeWorkspaceCwd(config),
        initialized: true,
        servers: [],
        errors: [this.errorCell('mcp', error)],
      };
    }
  }

  private buildWorkspaceMcpToolsStatus(
    config: Config,
    serverName: string,
  ): ServeWorkspaceMcpToolsStatus {
    const workspaceCwd = this.safeWorkspaceCwd(config);
    try {
      const servers = config.getMcpServers() ?? {};
      if (!Object.prototype.hasOwnProperty.call(servers, serverName)) {
        return {
          v: STATUS_SCHEMA_VERSION,
          workspaceCwd,
          serverName,
          initialized: true,
          acpChannelLive: true,
          tools: [],
          errors: [
            {
              kind: 'mcp_tools',
              status: 'error',
              error: `MCP server not configured: ${serverName}`,
            },
          ],
        };
      }

      const registry = config.getToolRegistry();
      const allTools = registry?.getAllTools() ?? [];
      const tools: ServeWorkspaceMcpToolStatus[] = allTools
        .filter(
          (tool): tool is DiscoveredMCPTool =>
            tool instanceof DiscoveredMCPTool && tool.serverName === serverName,
        )
        .map((tool) => {
          const invalidReasons: string[] = [];
          if (!tool.name) invalidReasons.push('missing name');
          if (!tool.description) invalidReasons.push('missing description');
          const schema =
            tool.parameterSchema &&
            typeof tool.parameterSchema === 'object' &&
            !Array.isArray(tool.parameterSchema)
              ? (tool.parameterSchema as Record<string, unknown>)
              : undefined;
          const annotations =
            tool.annotations &&
            typeof tool.annotations === 'object' &&
            !Array.isArray(tool.annotations)
              ? (tool.annotations as Record<string, unknown>)
              : undefined;
          return {
            name: tool.name || '(unnamed)',
            serverToolName: tool.serverToolName,
            description: tool.description,
            ...(schema ? { schema } : {}),
            ...(annotations ? { annotations } : {}),
            isValid: invalidReasons.length === 0,
            ...(invalidReasons.length > 0
              ? { invalidReason: invalidReasons.join(', ') }
              : {}),
          };
        });

      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        serverName,
        initialized: true,
        acpChannelLive: true,
        tools,
      };
    } catch (error) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        serverName,
        initialized: true,
        acpChannelLive: true,
        tools: [],
        errors: [this.errorCell('mcp_tools', error)],
      };
    }
  }

  /**
   * Build the MCP budget status cells exposed on `GET /workspace/mcp`
   * (PR 14). v1 emits one cell with `scope: 'session'` — each ACP
   * session has its own `McpClientManager`, so the budget enforces
   * per-session (snapshot reflects the bootstrap session's view).
   * Wave 5 PR 23 (shared MCP pool) will add `scope: 'workspace'`
   * for true per-workspace aggregation. Consumers MUST tolerate
   * additional entries with unrecognized scope values (drop, don't
   * fail).
   *
   * Cell `status` semantics:
   *   - `error`   — refusals happened this pass (only possible in enforce mode)
   *   - `warning` — live count crossed 75% of budget (warn or enforce mode)
   *   - `ok`      — under threshold (or `off` mode)
   *
   * **`liveCount` vs `reservedSlots.size` (PR 14 review #4247 R9 #5)**:
   * `liveCount` here is `accounting.total` — only `MCPServerStatus.CONNECTED`
   * clients. Enforcement (`tryReserveSlot`) on the other hand uses
   * `reservedSlots.size` — all reserved names, including in-flight
   * connects and never-connected stale entries. The two diverge when
   * servers hold a slot during the connect handshake or after a
   * connect failure that didn't release (e.g. `'already_held'`
   * reconnect timeouts). The snapshot intentionally uses the live
   * count for **operator observability** — "how many MCP clients
   * are actually serving requests right now" — while enforcement
   * uses the reservation count to prevent capacity races across
   * `Promise.all` microtask boundaries. PR 14b's typed events
   * should consider exposing both for real-time pressure signals.
   */
  private buildBudgetCells(
    liveCount: number,
    budget: number | undefined,
    mode: ServeMcpBudgetMode,
    refusedCount: number,
    scope: 'workspace' | 'session' = 'session',
  ): ServeMcpBudgetStatusCell[] {
    // PR 14 fix (review #4247): when no `--mcp-client-budget` is
    // configured the manager resolves to `mode: 'off'`. The protocol
    // docs and SDK type comments promise `budgets: []` for that case;
    // a synthetic `mcp_budget` cell carrying nothing actionable was
    // (a) protocol-noncompliant, (b) clutter — clients iterating
    // `budgets[]` to render rows would draw an "ok" budget row for
    // uncapped workspaces. Always return empty so the top-level
    // `budgetMode: 'off'` field is the sole signal that guardrails
    // are inactive.
    if (mode === 'off') return [];
    let status: ServeStatus = 'ok';
    let errorKind: ServeErrorKind | undefined;
    let hint: string | undefined;
    if (refusedCount > 0) {
      status = 'error';
      errorKind = 'budget_exhausted';
      hint =
        'Raise --mcp-client-budget or remove servers from mcpServers config.';
    } else if (
      budget !== undefined &&
      budget > 0 &&
      liveCount >= MCP_BUDGET_WARN_FRACTION * budget
    ) {
      status = 'warning';
      hint = `Live MCP clients are above ${Math.round(
        MCP_BUDGET_WARN_FRACTION * 100,
      )}% of the configured budget.`;
    }
    const cell: ServeMcpBudgetStatusCell = {
      kind: 'mcp_budget',
      // F2 (#4175 commit 6): `scope` graduates from 'session' to
      // 'workspace' when `QwenAgent.workspaceMcpBudget` is active —
      // the cap covers the whole workspace, not each ACP session
      // independently. Daemons running with `--no-mcp-pool` or with
      // budget unset keep the legacy `'session'` scope. SDK consumers
      // narrow via `isWorkspaceScopedBudgetEvent` for events; the
      // snapshot route surfaces the same `scope` value here.
      scope,
      status,
      liveCount,
      mode,
      refusedCount,
    };
    if (budget !== undefined) cell.budget = budget;
    if (errorKind) cell.errorKind = errorKind;
    if (hint) cell.hint = hint;
    return [cell];
  }

  /**
   * F2 (#4175 commit 6): map the core `McpBudgetMode` enum to the
   * status protocol's `ServeMcpBudgetMode`. The two are wire-compat
   * 1:1 today (`'enforce' | 'warn' | 'off'`); this helper exists so
   * a future divergence (e.g. an `'audit'` mode added on the core
   * side before the protocol catches up) doesn't break the snapshot
   * builder via a TS structural-narrowing surprise.
   */
  private coerceBudgetMode(mode: McpBudgetMode): ServeMcpBudgetMode {
    return mode;
  }

  private errorCell(
    kind: string,
    error: unknown,
    errorKind?: ServeErrorKind,
  ): ServeStatusCell {
    const inferred = errorKind ?? mapDomainErrorToErrorKind(error);
    return {
      kind,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      ...(inferred ? { errorKind: inferred } : {}),
    };
  }

  private async buildWorkspaceSkillsStatus(
    config: Config,
  ): Promise<ServeWorkspaceSkillsStatus> {
    const skillManager = config.getSkillManager();
    if (!skillManager) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.workspaceCwd(config),
        initialized: true,
        skills: [],
      };
    }

    try {
      const skills = await skillManager.listSkills();
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.workspaceCwd(config),
        initialized: true,
        skills: skills.map((skill): ServeWorkspaceSkillStatus => {
          const modelInvocable = skill.disableModelInvocation !== true;
          return {
            kind: 'skill',
            status: modelInvocable ? 'ok' : 'disabled',
            name: skill.name,
            description: skill.description,
            level: skill.level,
            modelInvocable,
            ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
            ...(skill.model ? { model: skill.model } : {}),
            ...(skill.extensionName
              ? { extensionName: skill.extensionName }
              : {}),
          };
        }),
      };
    } catch (error) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.workspaceCwd(config),
        initialized: true,
        skills: [],
        errors: [this.errorCell('skills', error)],
      };
    }
  }

  private buildWorkspaceProvidersStatus(
    config: Config,
  ): ServeWorkspaceProvidersStatus {
    try {
      const workspaceCwd = this.workspaceCwd(config);
      const currentAuthType = config.getAuthType?.();
      const activeRuntimeSnapshot = config.getActiveRuntimeModelSnapshot?.();
      const currentModelId = activeRuntimeSnapshot
        ? activeRuntimeSnapshot.id
        : (config.getModel() || '').trim();
      const hasCurrentModel = currentModelId.length > 0;
      const currentAuth = activeRuntimeSnapshot?.authType ?? currentAuthType;
      const currentAcpModelId =
        hasCurrentModel && currentAuth
          ? formatAcpModelId(currentModelId, currentAuth)
          : currentModelId || undefined;
      const providers = new Map<string, ServeWorkspaceProviderStatus>();

      for (const model of config.getAllConfiguredModels()) {
        const authType = String(model.authType);
        let provider = providers.get(authType);
        if (!provider) {
          provider = {
            kind: 'model_provider',
            status: 'ok',
            authType,
            current: false,
            models: [],
          };
          providers.set(authType, provider);
        }

        const effectiveModelId =
          model.isRuntimeModel && model.runtimeSnapshotId
            ? model.runtimeSnapshotId
            : model.id;
        const modelId = formatAcpModelId(effectiveModelId, model.authType);
        const isCurrent =
          currentAuth === model.authType &&
          hasCurrentModel &&
          (currentModelId === effectiveModelId ||
            currentModelId === model.id ||
            currentAcpModelId === modelId);
        const providerModel: ServeWorkspaceProviderModel = {
          modelId,
          baseModelId: parseAcpBaseModelId(effectiveModelId),
          name: model.label,
          ...(model.description !== undefined
            ? { description: model.description }
            : {}),
          contextLimit: model.contextWindowSize ?? tokenLimit(effectiveModelId),
          isCurrent,
          isRuntime: model.isRuntimeModel === true,
        };
        provider.models.push(providerModel);
        if (isCurrent) provider.current = true;
      }

      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: true,
        ...(currentAuth || currentAcpModelId
          ? {
              current: {
                ...(currentAuth ? { authType: String(currentAuth) } : {}),
                ...(currentAcpModelId ? { modelId: currentAcpModelId } : {}),
              },
            }
          : {}),
        providers: [...providers.values()],
      };
    } catch (error) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.safeWorkspaceCwd(config),
        initialized: true,
        providers: [],
        errors: [this.errorCell('providers', error)],
      };
    }
  }

  private async buildAcpPreflightCells(
    config: Config,
  ): Promise<{ cells: ServePreflightCell[]; errors?: ServeStatusCell[] }> {
    // Drive emission order from the shared `ACP_PREFLIGHT_KINDS` constant
    // (also consumed by `createIdleAcpPreflightCells` in `serve/status.ts`)
    // so the idle-placeholder list and the live builder cannot drift —
    // adding a new ACP kind in the constant flags any builder dispatch
    // gap as a TS exhaustiveness error in the switch below, instead of
    // silently dropping the cell from one path or the other.
    const builders: Record<
      AcpPreflightKind,
      () => ServePreflightCell | Promise<ServePreflightCell>
    > = {
      auth: () => this.buildAuthPreflightCell(config),
      mcp_discovery: () => this.buildMcpDiscoveryPreflightCell(config),
      skills: () => this.buildSkillsPreflightCell(config),
      providers: () => this.buildProvidersPreflightCell(config),
      tool_registry: () => this.buildToolRegistryPreflightCell(config),
      egress: () => ({
        kind: 'egress',
        status: 'not_started',
        locality: 'acp',
        hint: 'egress probing lands in PR 14 (#4175)',
      }),
    };
    const cells: ServePreflightCell[] = [];
    for (const kind of ACP_PREFLIGHT_KINDS) {
      cells.push(await builders[kind]());
    }
    return { cells };
  }

  private acpCell(
    kind: ServePreflightKind,
    spec: Omit<ServePreflightCell, 'kind' | 'locality'>,
  ): ServePreflightCell {
    return { kind, locality: 'acp', ...spec };
  }

  /**
   * Pure auth preflight check. Looks up the well-known env var keys for the
   * configured auth method (via `AUTH_ENV_MAPPINGS`) and reports whether at
   * least one is present.
   *
   * Deliberately does NOT call `validateAuthMethod` from `cli/config/auth.ts`:
   * that helper has side effects (reloads `.env` from disk via
   * `loadEnvironment`, writes `process.env['GOOGLE_GENAI_USE_VERTEXAI']` for
   * Vertex auth) which would let a read-only `GET /workspace/preflight`
   * mutate daemon state and produce torn snapshots when racing
   * `GET /workspace/env`. Full validation still happens at session start.
   */
  private buildAuthPreflightCell(config: Config): ServePreflightCell {
    try {
      const authType = config.getAuthType?.();
      if (!authType) {
        return this.acpCell('auth', {
          status: 'warning',
          errorKind: 'auth_env_error',
          error: 'No auth method configured.',
          hint: 'Run `qwen` and complete the auth flow, or set a provider env var.',
          detail: { source: 'none', hasToken: false },
        });
      }
      const apiKeyVars = AUTH_PREFLIGHT_ENV_KEYS[String(authType)] ?? [];
      const presentVar = apiKeyVars.find((name: string) =>
        Boolean(process.env[name]),
      );
      const hasToken = Boolean(presentVar);
      // No env-var registration → either OAuth-style auth (qwen-oauth) or
      // a custom provider whose key is sourced from settings rather than
      // env. Surface as `unknown` (the SDK consumer can defer to the
      // `/session` boot for definitive validation) rather than a false
      // negative.
      if (apiKeyVars.length === 0) {
        return this.acpCell('auth', {
          status: 'unknown',
          hint: 'Auth credentials for this provider are not env-keyed; full validation runs at session start.',
          detail: {
            source: String(authType),
            hasToken: 'unknown',
            envVarCandidates: [],
          },
        });
      }
      return this.acpCell('auth', {
        status: hasToken ? 'ok' : 'warning',
        ...(hasToken
          ? {}
          : {
              errorKind: 'auth_env_error' as const,
              error: `None of the env vars [${apiKeyVars.join(', ')}] is set for authType '${String(authType)}'.`,
              hint: `Set one of: ${apiKeyVars.join(' / ')}.`,
            }),
        detail: {
          source: String(authType),
          hasToken,
          envVarCandidates: apiKeyVars,
          ...(presentVar ? { presentVar } : {}),
        },
      });
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err) ?? 'auth_env_error';
      return this.acpCell('auth', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        errorKind,
      });
    }
  }

  private buildMcpDiscoveryPreflightCell(config: Config): ServePreflightCell {
    try {
      const discovery = this.discoveryState();
      const servers = config.getMcpServers() ?? {};
      const total = Object.keys(servers).length;
      // Today `MCPServerStatus` is `{CONNECTED, CONNECTING, DISCONNECTED}`,
      // but a future state (e.g. `ERROR`, `NEEDS_AUTH`) could be added.
      // Bucketing it as `disconnected` would silently lose the distinction
      // between "credential failed" and "idle, will spawn on demand".
      // Track an explicit `unknown` count so unrecognized states surface in
      // the cell `detail` rather than disappearing.
      const counts = {
        connected: 0,
        connecting: 0,
        disconnected: 0,
        unknown: 0,
      };
      for (const name of Object.keys(servers)) {
        const raw = getMCPServerStatus(name);
        switch (raw) {
          case MCPServerStatus.CONNECTED:
            counts.connected += 1;
            break;
          case MCPServerStatus.CONNECTING:
            counts.connecting += 1;
            break;
          case MCPServerStatus.DISCONNECTED:
            counts.disconnected += 1;
            break;
          default:
            counts.unknown += 1;
            break;
        }
      }
      const detail = { discoveryState: discovery, total, ...counts };

      if (total === 0) {
        return this.acpCell('mcp_discovery', {
          status: 'ok',
          detail,
          hint: 'No MCP servers configured.',
        });
      }
      if (counts.unknown > 0) {
        return this.acpCell('mcp_discovery', {
          status: 'warning',
          errorKind: 'protocol_error',
          error: `${counts.unknown}/${total} MCP server(s) in an unrecognized state.`,
          detail,
        });
      }
      if (counts.disconnected > 0 && discovery === 'completed') {
        return this.acpCell('mcp_discovery', {
          status: 'error',
          errorKind: 'protocol_error',
          error: `${counts.disconnected}/${total} MCP server(s) disconnected after discovery.`,
          detail,
        });
      }
      if (counts.connecting > 0 || discovery === 'in_progress') {
        // No `errorKind`: this is a normal transitional state (just-spawned
        // MCP servers haven't completed their handshake yet), not an
        // `init_timeout`. The latter would push SDK consumers to render
        // timeout-specific remediation ("increase init timeout") when the
        // correct user action is simply "wait or retry shortly". A real
        // timeout surfaces via `BridgeTimeoutError` from the bridge's
        // `withTimeout`, mapped through `mapDomainErrorToErrorKind`.
        return this.acpCell('mcp_discovery', {
          status: 'warning',
          error: `${counts.connecting}/${total} MCP server(s) still connecting.`,
          detail,
        });
      }
      return this.acpCell('mcp_discovery', { status: 'ok', detail });
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err);
      return this.acpCell('mcp_discovery', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        ...(errorKind ? { errorKind } : {}),
      });
    }
  }

  private async buildSkillsPreflightCell(
    config: Config,
  ): Promise<ServePreflightCell> {
    // Whole body wrapped in try so a Config getter that throws
    // synchronously (mock-style or future Config refactor) doesn't escape
    // out of `buildAcpPreflightCells` and 500 the whole envelope.
    try {
      const skillManager = config.getSkillManager();
      if (!skillManager) {
        return this.acpCell('skills', {
          status: 'disabled',
          // `disabled` here is the structural state — Config has no
          // SkillManager attached. That can mean the user opted out OR a
          // mis-config silently dropped the manager; preflight cannot
          // distinguish the two without settings introspection. Hint
          // surfaces the ambiguity so operators investigate when
          // unexpected.
          hint: 'No SkillManager attached to Config; verify settings if you expected skills to load.',
          detail: { configured: false },
        });
      }
      const skills = await skillManager.listSkills();
      return this.acpCell('skills', {
        status: 'ok',
        detail: { count: skills.length },
      });
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err);
      return this.acpCell('skills', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        ...(errorKind ? { errorKind } : {}),
      });
    }
  }

  private buildProvidersPreflightCell(config: Config): ServePreflightCell {
    try {
      const models = config.getAllConfiguredModels();
      const authType = config.getAuthType?.();
      if (models.length === 0) {
        // `authType` set but zero models = the next `POST /session` will
        // fail. Report `error`, not `warning`: the daemon literally cannot
        // serve a prompt in this state.
        return this.acpCell('providers', {
          status: authType ? 'error' : 'disabled',
          ...(authType ? { errorKind: 'auth_env_error' } : {}),
          ...(authType
            ? {
                error: `No model configured for authType ${String(authType)}.`,
              }
            : {}),
          detail: { count: 0, authType: authType ? String(authType) : null },
        });
      }
      const authTypes = new Set(models.map((m) => String(m.authType)));
      return this.acpCell('providers', {
        status: 'ok',
        detail: {
          count: models.length,
          providers: [...authTypes],
        },
      });
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err) ?? 'auth_env_error';
      return this.acpCell('providers', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        errorKind,
      });
    }
  }

  private buildToolRegistryPreflightCell(config: Config): ServePreflightCell {
    try {
      const registry = config.getToolRegistry();
      if (!registry) {
        return this.acpCell('tool_registry', {
          status: 'error',
          errorKind: 'protocol_error',
          error: 'Tool registry is not initialized.',
        });
      }
      const tools = registry.getAllTools();
      return this.acpCell('tool_registry', {
        status: 'ok',
        detail: { count: tools.length },
      });
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err) ?? 'protocol_error';
      return this.acpCell('tool_registry', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        errorKind,
      });
    }
  }

  private buildWorkspaceToolsStatus(config: Config): ServeWorkspaceToolsStatus {
    const workspaceCwd = this.safeWorkspaceCwd(config);
    try {
      const registry = config.getToolRegistry();
      if (!registry) {
        return {
          v: STATUS_SCHEMA_VERSION,
          workspaceCwd,
          initialized: true,
          acpChannelLive: true,
          tools: [],
          errors: [
            {
              kind: 'tools',
              status: 'error',
              errorKind: 'protocol_error',
              error: 'Tool registry is not initialized.',
            },
          ],
        };
      }

      const disabled = config.getDisabledTools();
      const tools: ServeWorkspaceToolStatus[] = registry
        .getAllTools()
        .filter((tool) => !('serverName' in tool))
        .map((tool) => ({
          name: tool.name,
          displayName: tool.displayName,
          description: tool.description,
          enabled: !disabled.has(tool.name),
        }));

      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: true,
        acpChannelLive: true,
        tools,
      };
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err) ?? 'protocol_error';
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: true,
        acpChannelLive: true,
        tools: [],
        errors: [
          {
            kind: 'tools',
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
            errorKind,
          },
        ],
      };
    }
  }

  private sessionOrThrow(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${sessionId}`,
      );
    }
    return session;
  }

  private buildSessionContextStatus(
    sessionId: string,
  ): ServeSessionContextStatus {
    const session = this.sessionOrThrow(sessionId);
    const config = session.getConfig();
    return {
      v: STATUS_SCHEMA_VERSION,
      sessionId,
      workspaceCwd: this.workspaceCwd(config),
      state: {
        models: this.buildAvailableModels(config),
        modes: this.buildModesData(config),
        configOptions: this.buildConfigOptions(config),
      },
    };
  }

  private async buildSessionContextUsageStatus(
    sessionId: string,
    showDetails: boolean,
  ): Promise<ServeSessionContextUsageStatus> {
    const session = this.sessionOrThrow(sessionId);
    const config = session.getConfig();
    let usage;
    try {
      usage = await collectContextData(config, showDetails);
    } catch (err) {
      console.warn('[context-usage] collectContextData failed:', err);
      usage = {
        type: 'context_usage' as const,
        modelName: config.getModel() || 'unknown',
        totalTokens: 0,
        contextWindowSize: 0,
        breakdown: {
          systemPrompt: 0,
          builtinTools: 0,
          mcpTools: 0,
          memoryFiles: 0,
          skills: 0,
          messages: 0,
          freeSpace: 0,
          autocompactBuffer: 0,
        },
        builtinTools: [] as Array<{ name: string; tokens: number }>,
        mcpTools: [] as Array<{ name: string; tokens: number }>,
        memoryFiles: [] as Array<{ path: string; tokens: number }>,
        skills: [] as Array<{
          name: string;
          tokens: number;
          loaded?: boolean;
          bodyTokens?: number;
        }>,
        isEstimated: true,
        showDetails,
      };
    }
    return {
      v: STATUS_SCHEMA_VERSION,
      sessionId,
      workspaceCwd: this.workspaceCwd(config),
      usage: {
        modelName: usage.modelName,
        totalTokens: usage.totalTokens,
        contextWindowSize: usage.contextWindowSize,
        breakdown: usage.breakdown,
        builtinTools: usage.builtinTools,
        mcpTools: usage.mcpTools,
        memoryFiles: usage.memoryFiles,
        skills: usage.skills,
        isEstimated: usage.isEstimated,
        showDetails: usage.showDetails,
      },
      formattedText: formatContextUsageText(usage),
    };
  }

  private async buildSessionSupportedCommandsStatus(
    sessionId: string,
  ): Promise<ServeSessionSupportedCommandsStatus> {
    const session = this.sessionOrThrow(sessionId);
    const { availableCommands, availableSkills } =
      await buildAvailableCommandsSnapshot(session.getConfig());
    return {
      v: STATUS_SCHEMA_VERSION,
      sessionId,
      availableCommands,
      availableSkills: availableSkills ?? [],
    };
  }

  private buildSessionTasksStatus(sessionId: string): ServeSessionTasksStatus {
    const session = this.sessionOrThrow(sessionId);
    return buildSessionTasksStatus(sessionId, session.getConfig());
  }

  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const cwd = (params['cwd'] as string) || process.cwd();
    const SESSION_ID_RE = /^[0-9a-fA-F-]{32,36}$/;

    switch (method) {
      case SERVE_STATUS_EXT_METHODS.workspaceMcp:
        return this.buildWorkspaceMcpStatus(this.config) as unknown as Record<
          string,
          unknown
        >;
      case SERVE_STATUS_EXT_METHODS.workspaceMcpTools: {
        const serverName = params['serverName'];
        if (typeof serverName !== 'string' || serverName.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing serverName',
          );
        }
        return this.buildWorkspaceMcpToolsStatus(
          this.config,
          serverName,
        ) as unknown as Record<string, unknown>;
      }
      case SERVE_STATUS_EXT_METHODS.workspaceSkills:
        return (await this.buildWorkspaceSkillsStatus(
          this.config,
        )) as unknown as Record<string, unknown>;
      case SERVE_STATUS_EXT_METHODS.workspaceTools:
        return this.buildWorkspaceToolsStatus(this.config) as unknown as Record<
          string,
          unknown
        >;
      case SERVE_STATUS_EXT_METHODS.workspaceProviders:
        return this.buildWorkspaceProvidersStatus(
          this.config,
        ) as unknown as Record<string, unknown>;
      case SERVE_STATUS_EXT_METHODS.workspacePreflight:
        return (await this.buildAcpPreflightCells(
          this.config,
        )) as unknown as Record<string, unknown>;
      case SERVE_STATUS_EXT_METHODS.sessionContext: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        return this.buildSessionContextStatus(sessionId) as unknown as Record<
          string,
          unknown
        >;
      }
      case SERVE_STATUS_EXT_METHODS.sessionContextUsage: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        return (await this.buildSessionContextUsageStatus(
          sessionId,
          params['detail'] === true,
        )) as unknown as Record<string, unknown>;
      }
      case SERVE_STATUS_EXT_METHODS.sessionSupportedCommands: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        return (await this.buildSessionSupportedCommandsStatus(
          sessionId,
        )) as unknown as Record<string, unknown>;
      }
      case SERVE_STATUS_EXT_METHODS.sessionTasks: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        return this.buildSessionTasksStatus(sessionId) as unknown as Record<
          string,
          unknown
        >;
      }
      case SERVE_CONTROL_EXT_METHODS.workspaceMcpRestart: {
        // #4175 Wave 4 PR 17. Single-server MCP restart with budget
        // pre-check from PR 14 v1's accounting snapshot. Soft skips
        // (in_flight, disabled, budget_would_exceed) come back as
        // structured 200 responses; hard errors (server not in
        // config, manager unavailable, post-discover not connected)
        // propagate as JSON-RPC errors with structured `data` that
        // the bridge translates to typed HTTP responses.
        //
        // F2 (#4175 commit 5): when `this.mcpPool` is present AND the
        // pool currently holds at least one entry for this server
        // name, restart routes through `pool.restartByName(name, opts)`
        // instead of the legacy per-session `discoverToolsForServer`.
        // The pool may hold multiple entries for the same name (e.g.
        // sessions injected divergent OAuth headers); `entryIndex`
        // narrows to one entry, omitted = restart all entries in
        // parallel via `Promise.allSettled`. Soft-skip pre-flight
        // checks (disabled / in_flight / budget) still run BEFORE the
        // pool branch so the existing legacy event shape covers the
        // skip cases without inventing per-entry skip semantics.
        const serverName = params['serverName'];
        if (typeof serverName !== 'string' || serverName.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing serverName',
          );
        }
        // F2 (#4175 commit 5): optional `entryIndex` selector. The
        // server.ts route validates the wire format (integer >= 0 or
        // `'*'`); here we just accept a finite non-negative integer.
        // `'*'` flattens to undefined (semantically "all").
        let entryIndex: number | undefined;
        const rawEntryIndex = params['entryIndex'];
        if (rawEntryIndex !== undefined && rawEntryIndex !== '*') {
          if (
            typeof rawEntryIndex !== 'number' ||
            !Number.isInteger(rawEntryIndex) ||
            rawEntryIndex < 0
          ) {
            throw RequestError.invalidParams(
              undefined,
              'entryIndex must be a non-negative integer or "*"',
            );
          }
          entryIndex = rawEntryIndex;
        }
        const servers = this.config.getMcpServers() ?? {};
        if (!Object.prototype.hasOwnProperty.call(servers, serverName)) {
          // #4282 gpt-5.5 C5 fold-in: the bridge looks for
          // `data.errorKind: 'mcp_server_not_found'` to map this back
          // to a typed `McpServerNotFoundError` and a stable HTTP 404
          // — without the structured payload the bridge can't
          // distinguish this from a generic JSON-RPC error and the
          // route falls through to 500.
          throw new RequestError(
            -32004,
            `MCP server not configured: ${JSON.stringify(serverName)}`,
            { errorKind: 'mcp_server_not_found', serverName },
          );
        }
        if (this.config.isMcpServerDisabled(serverName)) {
          return {
            serverName,
            restarted: false,
            skipped: true,
            reason: 'disabled' as const,
          };
        }
        const manager = this.config.getToolRegistry()?.getMcpClientManager();
        if (!manager) {
          throw RequestError.internalError(
            undefined,
            'McpClientManager unavailable on this Config',
          );
        }
        if (manager.isServerDiscovering(serverName)) {
          return {
            serverName,
            restarted: false,
            skipped: true,
            reason: 'in_flight' as const,
          };
        }
        const accounting = manager.getMcpClientAccounting();
        const budget = manager.getMcpClientBudget();
        const mode = manager.getMcpBudgetMode();
        // #4282 gpt-5.5 C3 fold-in: enforce-mode capacity is reserved
        // by `tryReserveSlot` via `reservedSlots` (which counts
        // configured + in-flight + disconnected slot holders), not by
        // `total` (which only counts CONNECTED clients). Comparing
        // `total` to budget under-counted reservations and let a
        // restart proceed past capacity; the manager would then
        // refuse internally and return void, while this handler
        // reported `restarted: true`. Mirror the manager's policy
        // by checking `reservedSlots.length` for servers that don't
        // already hold a reservation.
        if (
          mode === 'enforce' &&
          budget !== undefined &&
          !accounting.reservedSlots.includes(serverName) &&
          accounting.reservedSlots.length >= budget
        ) {
          return {
            serverName,
            restarted: false,
            skipped: true,
            reason: 'budget_would_exceed' as const,
          };
        }
        // #4282 fold-in 5 (Codex P2-2). Re-read settings to pick up
        // any `tools.disabled` toggles applied since this ACP child
        // booted. The original snapshot was frozen by Config's
        // constructor; without this refresh, a `setWorkspaceToolEnabled`
        // call followed by the documented `mcp restart` would
        // re-register a just-disabled MCP tool because
        // `discoverMcpToolsForServer` walks `ToolRegistry.registerTool`,
        // which consults `Config.getDisabledTools()`.
        //
        // #4297 fold-in 3 (wenshao critical, addresses #3260725526):
        // read the MERGED settings (User + System + Workspace union)
        // rather than the workspace scope alone. The bootstrap Config
        // received `merged.tools?.disabled`, so user/system policy is
        // already enforced by `ToolRegistry.registerTool`. Replacing
        // the in-memory set with the workspace scope alone would
        // silently drop higher-scope entries — a user-level disable
        // would survive boot but vanish after the first MCP restart,
        // letting `discoverMcpToolsForServer` re-register the
        // user-disabled tool.
        //
        // The asymmetry vs. the persist-write path is deliberate:
        // `runQwenServe.persistDisabledTools` writes to
        // `SettingScope.Workspace` only so the workspace file doesn't
        // bake in user/system entries (the fold-in 1 H2 fix). Reads
        // need the union; writes need the scope. The two paths look
        // alike but answer different questions.
        try {
          const fresh = loadSettings(this.config.getTargetDir());
          const mergedDisabled = fresh.merged.tools?.disabled;
          // #4297 fold-in 7 (qwen-latest critical, addresses
          // #3262625101): a malformed `tools.disabled` (boolean,
          // string, object — hand-edited settings.json) DOESN'T
          // throw, so the catch block below would never fire. The
          // ternary used to silently substitute `[]`, clearing the
          // entire disabled set with zero operator signal. Detect
          // and stderr-log the malformed shape before clearing so a
          // misconfigured settings file is loud rather than silent.
          if (mergedDisabled !== undefined && !Array.isArray(mergedDisabled)) {
            process.stderr.write(
              `qwen serve: MCP restart for ${JSON.stringify(serverName)}: ` +
                `tools.disabled has unexpected type ${typeof mergedDisabled}; ` +
                `clearing disabled set — check settings.json. ` +
                `Expected an array of strings.\n`,
            );
          }
          // #4329 F1 fold-in (#4319): use the shared
          // `normalizeDisabledToolList` helper so the boot path
          // (`cli/src/config/config.ts`) and this MCP restart refresh
          // path agree byte-for-byte on what counts as "disabled".
          // Without the shared helper a `tools.disabled: ['  Foo  ',
          // '', 'Foo']` settings entry would produce different sets
          // at boot vs after restart — `ToolRegistry.has(tool.name)`
          // exact-match check would then silently re-register the
          // trimmed tool. Helper is in `cli/src/config/normalizeDisabledTools.ts`
          // with its own unit tests covering the trim / empty-skip /
          // dedupe contract.
          const disabledList = normalizeDisabledToolList(mergedDisabled);
          this.config.setDisabledTools(new Set(disabledList));
        } catch (err) {
          // #4297 fold-in 2 (wenshao S3): settings load failures are
          // non-fatal — fall through with the existing in-memory
          // snapshot. The MCP restart still runs; only the
          // disabledTools sync is skipped. Surface a stderr line so a
          // persistent failure (corrupted settings.json, permission
          // denied) is visible to operators rather than silently
          // breaking the documented "toggle + restart" workflow with
          // zero diagnostic.
          process.stderr.write(
            `qwen serve: MCP restart for ${JSON.stringify(serverName)} ` +
              `could not refresh disabledTools from merged settings ` +
              `(${err instanceof Error ? err.message : String(err)}); ` +
              `proceeding with the bootstrap snapshot — recently toggled ` +
              `tools may not take effect until daemon restart.\n`,
          );
        }
        // F2 (#4175 commit 5): pool-mode routing. When the pool holds
        // entries for this name, route restart through the pool so all
        // matching entries restart with proper per-entry generation
        // tracking + snapshot replay (see mcp-pool-entry.ts). The
        // legacy per-session path stays as fallback when the pool is
        // disabled (`QWEN_SERVE_NO_MCP_POOL=1`), absent, or empty for
        // this name (e.g. unpooled HTTP/SSE/SDK transports).
        const poolSnapshot = this.mcpPool?.getSnapshot();
        const poolHasEntries =
          poolSnapshot !== undefined &&
          (poolSnapshot.byName[serverName]?.entryCount ?? 0) > 0;
        if (this.mcpPool && poolHasEntries) {
          const restartResults = await this.mcpPool.restartByName(serverName, {
            ...(entryIndex !== undefined ? { entryIndex } : {}),
          });
          // V21-7: when the caller asked for a specific `entryIndex`
          // that doesn't match any current pool entry, return an
          // empty `entries` array rather than throwing — matches the
          // design's documented "404-like soft signal" for narrowed
          // restarts where the underlying entry drained between the
          // status snapshot and the restart call.
          return {
            serverName,
            entries: restartResults,
          };
        }
        // #4297 fold-in 9 (gpt-5.5 critical, addresses #3263088414):
        // route through `ToolRegistry.discoverToolsForServer` instead
        // of calling `manager.discoverMcpToolsForServer` directly.
        // The registry wrapper PURGES this server's existing
        // `DiscoveredMCPTool` entries (and its `revealedDeferred`
        // markers) plus its prompts before rediscovery, so a
        // toggle-disable-then-restart workflow actually removes the
        // newly-disabled tool from the live registry. Without the
        // wrapper, `registerTool` would only consult the refreshed
        // `disabledTools` set for newly-discovered tools — entries
        // that were already in the registry from the prior boot
        // would keep serving requests, silently breaking the
        // documented "toggle + restart" promise.
        //
        // F2 (#4175 commit 5): an explicit `entryIndex` query against
        // the legacy (no-pool) path is invalid — the legacy path has
        // exactly one entry per server name, so `entryIndex !== 0` can
        // never match. Reject with invalidParams to surface the
        // operator's mistake (likely calling pool semantics against a
        // `--no-mcp-pool` daemon) rather than silently restarting the
        // single legacy entry.
        if (entryIndex !== undefined && entryIndex !== 0) {
          throw RequestError.invalidParams(
            undefined,
            `entryIndex=${entryIndex} requested but pool not active for ` +
              `${JSON.stringify(serverName)} — legacy single-entry path ` +
              `only supports entryIndex=0 or undefined`,
          );
        }
        const start = Date.now();
        const toolRegistry = this.config.getToolRegistry();
        if (!toolRegistry) {
          throw RequestError.internalError(
            undefined,
            'ToolRegistry unavailable on this Config',
          );
        }
        await toolRegistry.discoverToolsForServer(serverName);
        // #4282 gpt-5.5 C4 fold-in: `discoverMcpToolsForServer`
        // catches reconnect/discovery errors internally (logs and
        // resolves void) so a broken MCP server would otherwise
        // surface as `restarted: true`. Verify the live status from
        // the per-server status map; anything other than CONNECTED
        // means the restart didn't take effect.
        const postStatus = getMCPServerStatus(serverName);
        if (postStatus !== MCPServerStatus.CONNECTED) {
          throw new RequestError(
            -32099,
            `MCP server ${JSON.stringify(serverName)} did not reach a ` +
              `connected state after restart (status: ${postStatus}).`,
            {
              errorKind: 'mcp_restart_failed',
              serverName,
              mcpStatus: postStatus,
            },
          );
        }
        return {
          serverName,
          restarted: true,
          durationMs: Date.now() - start,
        };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionClose: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        await this.closeStoredSession(sessionId);
        return { sessionId, closed: true };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionApprovalMode: {
        // #4175 Wave 4 PR 17: remote callers change a live session's
        // approval mode via this ACP extMethod. `Config.setApprovalMode`
        // throws `TrustGateError` for privileged modes in an untrusted
        // folder; we let it propagate — the bridge's mapping helper
        // converts the name to `errorKind: 'auth_env_error'` on the
        // wire so the SDK consumer gets a structured failure.
        const sessionId = params['sessionId'];
        const mode = params['mode'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (
          typeof mode !== 'string' ||
          !APPROVAL_MODES.includes(mode as ApprovalMode)
        ) {
          throw RequestError.invalidParams(
            undefined,
            `Invalid approval mode; allowed: ${APPROVAL_MODES.join(', ')}`,
          );
        }
        const session = this.sessionOrThrow(sessionId);
        const config = session.getConfig();
        const previous = config.getApprovalMode();
        try {
          config.setApprovalMode(mode as ApprovalMode);
        } catch (err) {
          // `TrustGateError` is the core's structured rejection for
          // untrusted-folder + privileged-mode. We re-raise it as a
          // JSON-RPC error whose `data.errorKind` is the literal the
          // bridge looks for to reconstruct a typed `TrustGateError` on
          // the daemon side (JSON-RPC strips the class name across the
          // wire). Other errors propagate unchanged.
          if (err instanceof Error && err.name === 'TrustGateError') {
            throw new RequestError(-32003, err.message, {
              errorKind: 'trust_gate',
            });
          }
          throw err;
        }
        const current = config.getApprovalMode();
        return { previous, current };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionRecap: {
        // #4175 follow-up. Generate a one-sentence "where did I leave
        // off" summary by running `generateSessionRecap` against the
        // session's GeminiClient history. Best-effort: the core helper
        // is documented to return `null` on any failure (short history,
        // transient model error, etc.) and never throws — we surface
        // that null verbatim so the daemon route returns a 200 with
        // `recap: null` rather than a 5xx.
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const session = this.sessionOrThrow(sessionId);
        const config = session.getConfig();
        // v1: no cross-process abort plumbing. The bridge does not listen
        // for HTTP client disconnect and no AbortSignal is threaded through
        // the ext-method, so the LLM call in this child always runs to
        // completion. The only ceilings are the bridge's 60s
        // `SESSION_RECAP_TIMEOUT_MS` backstop and the transport-closed race
        // against ACP channel death. Acceptable because recap is short
        // (single-attempt side-query, `maxOutputTokens: 300`). A future
        // request-id-based cancel ext-method can plumb a real signal
        // end-to-end if the bandwidth cost ever becomes an issue.
        const recap = await generateSessionRecap(
          config,
          new AbortController().signal,
        );
        return { sessionId, recap };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionShellHistory: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const command = params['command'];
        if (typeof command !== 'string') {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing command',
          );
        }
        const session = this.sessionOrThrow(sessionId);
        const config = session.getConfig();
        const geminiClient = config.getGeminiClient()!;
        const outputText =
          typeof params['output'] === 'string' ? params['output'] : '';
        geminiClient.addHistory({
          role: 'user',
          parts: [
            {
              text: `I ran the following shell command:\n\`\`\`sh\n${command}\n\`\`\`\n\nThis produced the following result:\n\`\`\`\n${outputText}\n\`\`\``,
            },
          ],
        });
        return { sessionId, injected: true };
      }
      case 'deleteSession': {
        const sessionId = params['sessionId'] as string;
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const success = await runWithAcpRuntimeOutputDir(
          this.settings,
          cwd,
          async () => {
            const sessionService = new SessionService(cwd);
            return sessionService.removeSession(sessionId);
          },
        );
        return { success };
      }
      case 'renameSession': {
        const sessionId = params['sessionId'] as string;
        const title = params['title'] as string;
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (!title || typeof title !== 'string') {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing title',
          );
        }
        if (title.length > SESSION_TITLE_MAX_LENGTH) {
          throw RequestError.invalidParams(
            undefined,
            `Title too long (max ${SESSION_TITLE_MAX_LENGTH} chars)`,
          );
        }
        // When the target session is currently live in this process, route
        // through its ChatRecordingService so the in-memory `currentCustomTitle`
        // stays in sync. Writing directly to disk via SessionService here
        // would leave the live recording's cache stale; the next title
        // re-anchor (every 32KB of writes) or finalize() would re-emit the
        // old title and silently revert the rename. The disk-only path
        // remains for the dead-session case (e.g., another client renaming
        // a session that isn't active in this process).
        const liveRecording = this.sessions
          .get(sessionId)
          ?.getConfig()
          .getChatRecordingService();
        if (liveRecording) {
          const ok = liveRecording.recordCustomTitle(title, 'manual');
          await liveRecording.flush();
          return { success: ok };
        }
        const success = await runWithAcpRuntimeOutputDir(
          this.settings,
          cwd,
          async () => {
            const sessionService = new SessionService(cwd);
            return sessionService.renameSession(sessionId, title);
          },
        );
        return { success };
      }
      case 'rewindSession': {
        const sessionId = params['sessionId'] as string;
        const targetTurnIndex = params['targetTurnIndex'];
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (
          !Number.isInteger(targetTurnIndex) ||
          (targetTurnIndex as number) < 0
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing targetTurnIndex',
          );
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
          throw RequestError.invalidParams(
            undefined,
            `Session not found for id: ${sessionId}`,
          );
        }

        const historyBeforeRewind = session.captureHistorySnapshot();
        return {
          success: true,
          historyBeforeRewind,
          ...session.rewindToTurn(targetTurnIndex as number),
        };
      }
      case 'restoreSessionHistory': {
        const sessionId = params['sessionId'] as string;
        const history = params['history'];
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (!Array.isArray(history)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing history',
          );
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
          throw RequestError.invalidParams(
            undefined,
            `Session not found for id: ${sessionId}`,
          );
        }

        session.restoreHistory(history as Content[]);
        return { success: true };
      }
      case 'getAccountInfo': {
        const sessionId = params['sessionId'] as string | undefined;
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        const config = session ? session.getConfig() : this.config;
        const cfg = config.getContentGeneratorConfig();
        return {
          authType: cfg?.authType ?? config.getAuthType() ?? null,
          model: cfg?.model ?? config.getModel() ?? null,
          baseUrl: cfg?.baseUrl ?? null,
          apiKeyEnvKey: cfg?.apiKeyEnvKey ?? null,
        };
      }
      default:
        throw RequestError.methodNotFound(method);
    }
  }

  // --- private helpers ---

  private async newSessionConfig(
    cwd: string,
    mcpServers: McpServer[],
    sessionId?: string,
    resume?: boolean,
  ): Promise<Config> {
    this.settings = loadSettings(cwd);
    const mergedMcpServers = { ...this.settings.merged.mcpServers };

    for (const server of mcpServers) {
      const stdioServer = toStdioServer(server);
      if (stdioServer) {
        const env: Record<string, string> = {};
        for (const { name: envName, value } of stdioServer.env) {
          env[envName] = value;
        }
        mergedMcpServers[stdioServer.name] = new MCPServerConfig(
          stdioServer.command,
          stdioServer.args,
          env,
          cwd,
        );
        continue;
      }

      const sseServer = toSseServer(server);
      if (sseServer) {
        const headers: Record<string, string> = {};
        for (const { name: headerName, value } of sseServer.headers) {
          headers[headerName] = value;
        }
        mergedMcpServers[sseServer.name] = new MCPServerConfig(
          undefined,
          undefined,
          undefined,
          undefined,
          sseServer.url,
          undefined,
          Object.keys(headers).length > 0 ? headers : undefined,
        );
        continue;
      }

      const httpServer = toHttpServer(server);
      if (httpServer) {
        const headers: Record<string, string> = {};
        for (const { name: headerName, value } of httpServer.headers) {
          headers[headerName] = value;
        }
        mergedMcpServers[httpServer.name] = new MCPServerConfig(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          httpServer.url,
          Object.keys(headers).length > 0 ? headers : undefined,
        );
        continue;
      }
    }

    const settings = { ...this.settings.merged, mcpServers: mergedMcpServers };
    const argvForSession = {
      ...this.argv,
      ...(resume ? { resume: sessionId } : { sessionId }),
      continue: false,
    };

    const config = await loadCliConfig(
      settings,
      argvForSession,
      cwd,
      [],
      // Pass separated hooks for proper source attribution
      {
        userHooks: this.settings.getUserHooks(),
        projectHooks: this.settings.getProjectHooks(),
      },
    );
    // F2 (#4175 commit 4): inject the workspace-shared MCP transport
    // pool BEFORE `config.initialize()` so the ToolRegistry that
    // initialize() constructs picks up the pool reference and the
    // session's McpClientManager routes non-SDK MCP discovery
    // through it. Calling after initialize would leave the manager
    // with a stale `pool=undefined` and the pool would never be
    // exercised. The pool is workspace-scoped (`QwenAgent.mcpPool`)
    // and lives for the daemon's lifetime — see ctor.
    if (
      this.mcpPool !== undefined &&
      typeof config.setMcpTransportPool === 'function'
    ) {
      config.setMcpTransportPool(this.mcpPool);
    }
    // PR 14b fix #2 (codex review round 1): register the MCP guardrail
    // budget-event callback BEFORE `config.initialize()`. Pre-fix the
    // registration ran AFTER initialize, which (a) missed end-of-pass
    // events under `QWEN_CODE_LEGACY_MCP_BLOCKING=1` (synchronous
    // discovery completes inside initialize, before our setter runs)
    // and (b) raced against background-discovery completion under the
    // default progressive mode. `Config.setMcpBudgetEventCallback`
    // stashes the callback and `createToolRegistry` applies it to the
    // manager BEFORE `discoverAllTools` / `startMcpDiscoveryInBackground`
    // fires, closing both windows.
    //
    // sessionId source: `config.getSessionId()` reads the Config's own
    // session id (auto-assigned via `randomUUID()` in the Config
    // constructor when no override is passed — see `config.ts:849`),
    // so the value is available immediately after `loadCliConfig`
    // returns. The closure pins it for the manager's whole lifetime.
    //
    // Defensive `typeof` checks tolerate stub Configs / ToolRegistries
    // in older tests (older fixtures may omit `setMcpBudgetEventCallback`
    // or `getSessionId`).
    const wiredSessionId =
      typeof config.getSessionId === 'function'
        ? config.getSessionId()
        : undefined;
    // F2 (#4175 commit 6): when the workspace-scoped budget controller
    // is active, the pool's `WorkspaceMcpBudget` fires events at
    // workspace level and `broadcastBudgetEvent` fans them to every
    // attached session. Skipping the per-session manager callback
    // here prevents double-firing (manager's inline state machine is
    // dormant in pool mode anyway, but defensively skipping the
    // callback also avoids any future wiring that might re-activate
    // it). Daemons without a configured budget — or running with the
    // pool kill switch — keep the per-session callback so legacy
    // `scope: 'session'` events still fan out via the ACP child path.
    const skipPerSessionBudgetCallback = this.workspaceMcpBudget !== undefined;
    if (
      !skipPerSessionBudgetCallback &&
      typeof config.setMcpBudgetEventCallback === 'function' &&
      wiredSessionId !== undefined
    ) {
      const sid = wiredSessionId;
      config.setMcpBudgetEventCallback((event) => {
        // Fire-and-forget: `extNotification` returns Promise<void> but
        // the manager's call site doesn't await. `.catch` suppresses
        // unhandled rejections — a mid-flight ACP disconnect would
        // otherwise crash the child. Snapshot still carries the state
        // for clients that reconnect.
        //
        // PR 14b fix (codex round 3 — DeepSeek): pre-fix the catch
        // handler was `() => {}`, silently dropping every error
        // including "real" ones (serialization bugs, protocol
        // violations) — operators had no debug trail. Now logs at
        // `debug` level: ACP channel closure during shutdown is the
        // expected case and would spam at higher levels, but `debug`
        // is opt-in so when an oncall engineer DOES turn it on for
        // an MCP guardrail incident, they see exactly which event
        // dropped and why.
        void this.connection
          .extNotification('qwen/notify/session/mcp-budget-event', {
            v: 1,
            sessionId: sid,
            ...event,
          })
          .catch((err: unknown) => {
            debugLogger.debug(
              `MCP budget extNotification dropped ` +
                `(session=${sid}, kind=${event.kind}): ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
          });
      });
    }
    await config.initialize();
    // Same reasoning as the top-level runAcpAgent path: ACP feeds session
    // messages to the model immediately, so we cannot return a Config whose
    // MCP discovery is still in flight.
    await config.waitForMcpReady();
    // Surface MCP failures to stderr — mirrors `runAcpAgent` (lines 95-107)
    // and the other non-interactive entry points (`gemini.tsx`,
    // `session.ts`). Without this, per-session ACP configs that lose MCP
    // servers fall back to built-in-tools-only with no user-visible
    // indication. Defensive against tests that pass a stubbed Config
    // without `getFailedMcpServerNames`.
    const failedMcpServers =
      typeof config.getFailedMcpServerNames === 'function'
        ? config.getFailedMcpServerNames()
        : [];
    if (failedMcpServers.length > 0) {
      process.stderr.write(
        `Warning: MCP server(s) failed to start: ${failedMcpServers.join(', ')}. ` +
          `Continuing with built-in tools and any servers that did connect.\n`,
      );
    }
    return config;
  }

  private async ensureAuthenticated(config: Config): Promise<void> {
    const selectedType = config.getModelsConfig().getCurrentAuthType();
    if (!selectedType) {
      throw RequestError.authRequired(
        { authMethods: this.pickAuthMethodsForAuthRequired() },
        'Use Qwen Code CLI to authenticate first.',
      );
    }

    try {
      await config.refreshAuth(selectedType, true);
    } catch (e) {
      debugLogger.error(`Authentication failed: ${e}`);
      throw RequestError.authRequired(
        {
          authMethods: this.pickAuthMethodsForAuthRequired(selectedType, e),
        },
        'Authentication failed: ' + (e as Error).message,
      );
    }
  }

  private pickAuthMethodsForAuthRequired(
    selectedType?: AuthType | string,
    error?: unknown,
  ): AuthMethod[] {
    const authMethods = buildAuthMethods();
    const errorMessage = this.extractErrorMessage(error);
    if (
      errorMessage?.includes('qwen-oauth') ||
      errorMessage?.includes('Qwen OAuth')
    ) {
      const qwenOAuthMethods = authMethods.filter(
        (m) => m.id === AuthType.QWEN_OAUTH,
      );
      return qwenOAuthMethods.length ? qwenOAuthMethods : authMethods;
    }

    if (selectedType) {
      const matched = authMethods.filter((m) => m.id === selectedType);
      return matched.length ? matched : authMethods;
    }

    return authMethods;
  }

  private extractErrorMessage(error?: unknown): string | undefined {
    if (error instanceof Error) return error.message;
    if (
      typeof error === 'object' &&
      error != null &&
      'message' in error &&
      typeof error.message === 'string'
    ) {
      return error.message;
    }
    if (typeof error === 'string') return error;
    return undefined;
  }

  private setupFileSystem(config: Config): void {
    if (!this.clientCapabilities?.fs) return;

    const acpFileSystemService = new AcpFileSystemService(
      this.connection,
      config.getSessionId(),
      this.clientCapabilities.fs,
      config.getFileSystemService(),
    );
    config.setFileSystemService(acpFileSystemService);
  }

  private async createAndStoreSession(
    config: Config,
    conversation?: ConversationRecord,
  ): Promise<Session> {
    const sessionId = config.getSessionId();
    const geminiClient = config.getGeminiClient();
    const needsInitialize = !geminiClient.isInitialized();

    if (needsInitialize) {
      await geminiClient.initialize();
    }

    const session = new Session(
      sessionId,
      config,
      this.connection,
      this.settings,
    );
    this.sessions.set(sessionId, session);

    setTimeout(async () => {
      await session.sendAvailableCommandsUpdate();
    }, 0);

    if (conversation && conversation.messages) {
      await session.replayHistory(conversation.messages);
    }

    // Install rewriter AFTER history replay to avoid rewriting historical messages
    session.installRewriter();

    return session;
  }

  private buildAvailableModels(config: Config): NewSessionResponse['models'] {
    const rawCurrentModelId = (
      config.getModel() ||
      this.config.getModel() ||
      ''
    ).trim();
    const currentAuthType = config.getAuthType();
    const allConfiguredModels = config.getAllConfiguredModels();

    const activeRuntimeSnapshot = config.getActiveRuntimeModelSnapshot?.();
    const currentModelId = activeRuntimeSnapshot
      ? formatAcpModelId(
          activeRuntimeSnapshot.id,
          activeRuntimeSnapshot.authType,
        )
      : this.formatCurrentModelId(rawCurrentModelId, currentAuthType);

    const mappedAvailableModels = allConfiguredModels.map((model) => {
      const effectiveModelId =
        model.isRuntimeModel && model.runtimeSnapshotId
          ? model.runtimeSnapshotId
          : model.id;

      return {
        modelId: formatAcpModelId(effectiveModelId, model.authType),
        name: model.label,
        description: model.description ?? null,
        _meta: {
          contextLimit: model.contextWindowSize ?? tokenLimit(model.id),
        },
      };
    });

    return {
      currentModelId,
      availableModels: mappedAvailableModels,
    };
  }

  private buildModesData(config: Config): SessionModeState {
    const currentApprovalMode = config.getApprovalMode();

    const availableModes = APPROVAL_MODES.map((mode) => ({
      id: mode as ApprovalModeValue,
      name: APPROVAL_MODE_INFO[mode].name,
      description: APPROVAL_MODE_INFO[mode].description,
    }));

    return {
      currentModeId: currentApprovalMode as ApprovalModeValue,
      availableModes,
    };
  }

  private buildConfigOptions(config: Config): SessionConfigOption[] {
    const currentApprovalMode = config.getApprovalMode();
    const allConfiguredModels = config.getAllConfiguredModels();
    const rawCurrentModelId = (config.getModel() || '').trim();
    const currentAuthType = config.getAuthType?.();

    const activeRuntimeSnapshot = config.getActiveRuntimeModelSnapshot?.();
    const currentModelId = activeRuntimeSnapshot
      ? formatAcpModelId(
          activeRuntimeSnapshot.id,
          activeRuntimeSnapshot.authType,
        )
      : this.formatCurrentModelId(rawCurrentModelId, currentAuthType);

    const modeOptions = APPROVAL_MODES.map((mode) => ({
      value: mode,
      name: APPROVAL_MODE_INFO[mode].name,
      description: APPROVAL_MODE_INFO[mode].description,
    }));

    const modeConfigOption: SessionConfigOption = {
      id: 'mode',
      name: 'Mode',
      description: 'Session permission mode',
      category: 'mode',
      type: 'select' as const,
      currentValue: currentApprovalMode,
      options: modeOptions,
    };

    const modelOptions = allConfiguredModels.map((model) => {
      const effectiveModelId =
        model.isRuntimeModel && model.runtimeSnapshotId
          ? model.runtimeSnapshotId
          : model.id;
      return {
        value: formatAcpModelId(effectiveModelId, model.authType),
        name: model.label,
        description: model.description ?? '',
      };
    });

    const modelConfigOption: SessionConfigOption = {
      id: 'model',
      name: 'Model',
      description: 'AI model to use',
      category: 'model',
      type: 'select' as const,
      currentValue: currentModelId,
      options: modelOptions,
    };

    return [modeConfigOption, modelConfigOption];
  }

  private formatCurrentModelId(
    baseModelId: string,
    authType?: AuthType,
  ): string {
    if (!baseModelId) return baseModelId;
    return authType ? formatAcpModelId(baseModelId, authType) : baseModelId;
  }
}
