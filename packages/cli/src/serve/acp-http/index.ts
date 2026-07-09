/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Application, Request, Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import type { HttpAcpBridge } from '@qwen-code/acp-bridge/bridgeTypes';
import { RUNTIME_MCP_IF_ABSENT_CONFIG_FLAG } from '@qwen-code/qwen-code-core';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type { DaemonWorkspaceService } from '../workspace-service/types.js';
import type { WorkspaceFileSystemFactory } from '../fs/index.js';
import type { DeviceFlowRegistry } from '../auth/device-flow.js';
import type { ParsedAllowOriginPatterns } from '../auth.js';
import { AcpDispatcher } from './dispatch.js';
import { WorkspaceRememberTaskLane } from '../workspace-remember.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  resolveRegisteredWorkspaceRuntimeByPathSelector,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import {
  ConnectionRegistry,
  type AcpConnection,
} from './connection-registry.js';
import { SseStream } from './sse-stream.js';
import { WsStream } from './ws-stream.js';
import type { RateLimitTier } from '../rate-limit.js';
import { SessionArchiveCoordinator } from '../server/session-archive.js';
import {
  RPC,
  error as rpcError,
  isRequest,
  logSafe,
  parseInbound,
} from './json-rpc.js';
import { parseLastEventId } from '../sse-last-event-id.js';
import {
  ClientMcpWsConnection,
  type ClientMcpServerProvider,
} from './client-mcp-ws.js';
import { createClientMcpServerProvider } from './client-mcp-sender-registry.js';
import type {
  CdpTunnelRegistry,
  CdpBridgeEndpoint,
} from '../cdp-tunnel/cdp-tunnel-registry.js';
import {
  isCdpInboundFrameType,
  type CdpOutboundFrame,
} from '../cdp-tunnel/cdp-reverse-link.js';
import { attachCdpClient } from '../cdp-tunnel/cdp-ws.js';
import {
  QWEN_CDP_MCP_COMMAND_ENV,
  resolveCdpMcpCommand,
} from '../cdp-mcp-command.js';
import { safeWsSend } from './safe-ws-send.js';

export const ACP_CONNECTION_HEADER = 'acp-connection-id';
export const ACP_SESSION_HEADER = 'acp-session-id';

/** Pathname of the Plan C CDP-tunnel endpoint (issue #5626). */
const CDP_PATH = '/cdp';

/** Prefix/suffix of the Phase 4 workspace-qualified ACP WS path. */
const PLURAL_ACP_WS_PREFIX = '/workspaces/';
const PLURAL_ACP_WS_SUFFIX = '/acp';

/**
 * `clientInfo.name` an extension must send on `/acp` to claim the CDP bridge.
 * Cross-package protocol constant — kept in sync with `CDP_BRIDGE_CLIENT_NAME`
 * in `packages/chrome-extension/src/background/service-worker.ts` (the two
 * packages can't share a module).
 */
const CDP_BRIDGE_CLIENT_NAME = 'qwen-cdp-bridge';
const CHROME_DEVTOOLS_MCP_SERVER_NAME = 'chrome-devtools';
const RUNTIME_MCP_RETRY_DELAY_MS = 250;
const RUNTIME_MCP_RETRY_ATTEMPTS = 20;

function formatCdpEndpointHost(hostname: string | undefined): string {
  const host = hostname?.trim() || '127.0.0.1';
  if (host === '0.0.0.0' || host === '::' || host === '[::]') {
    return '127.0.0.1';
  }
  const unbracketed =
    host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return unbracketed.includes(':') ? `[${unbracketed}]` : unbracketed;
}

function isAcpChannelUnavailable(err: unknown): boolean {
  return (
    (err as { data?: { errorKind?: unknown } } | undefined)?.data?.errorKind ===
    'acp_channel_unavailable'
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildChromeDevToolsMcpRuntimeConfig(
  localPort: number | undefined,
  hostname: string | undefined,
): Record<string, unknown> | undefined {
  if (
    localPort === undefined ||
    !Number.isInteger(localPort) ||
    localPort <= 0
  ) {
    return undefined;
  }
  const command = resolveCdpMcpCommand(process.env);
  if (!command) {
    writeStderrLine(
      `qwen serve: set ${QWEN_CDP_MCP_COMMAND_ENV} to enable browser automation MCP (no adapter is bundled)`,
    );
    return undefined;
  }
  return {
    command,
    args: [
      '--wsEndpoint',
      `ws://${formatCdpEndpointHost(hostname)}:${localPort}/cdp`,
    ],
    alwaysLoadTools: true,
    [RUNTIME_MCP_IF_ABSENT_CONFIG_FLAG]: true,
  };
}

/**
 * Browsers cannot set an `Authorization` header on a WebSocket, so the Web
 * Shell authenticates the `/voice/stream` (and `/acp`) upgrade by offering the
 * bearer token as a `Sec-WebSocket-Protocol` subprotocol of the form
 * `qwen-bearer.<base64url(token)>`. Kept in sync with the encoder in
 * `packages/web-shell/client/voice/useVoiceCapture.ts`.
 */
export const WS_BEARER_SUBPROTOCOL_PREFIX = 'qwen-bearer.';

/**
 * Pull the bearer credential off a WS upgrade request. Prefer the standard
 * `Authorization: Bearer <token>` header (non-browser clients); fall back to
 * the `qwen-bearer.*` subprotocol (browser clients). Returns `undefined` when
 * neither is present or parseable.
 */
function extractUpgradeBearer(req: IncomingMessage): string | undefined {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.includes(' ')) {
    const scheme = authHeader.slice(0, authHeader.indexOf(' ')).toLowerCase();
    if (scheme === 'bearer') {
      const credentials = authHeader.slice(authHeader.indexOf(' ') + 1).trim();
      if (credentials) return credentials;
    }
  }
  const offered = req.headers['sec-websocket-protocol'];
  if (offered) {
    for (const raw of offered.split(',')) {
      const entry = raw.trim();
      if (!entry.startsWith(WS_BEARER_SUBPROTOCOL_PREFIX)) continue;
      const encoded = entry.slice(WS_BEARER_SUBPROTOCOL_PREFIX.length);
      // `Buffer.from(_, 'base64url')` never throws — malformed input just
      // decodes to garbage bytes, which fail the constant-time hash compare
      // at the call site. An empty decode means "no credential offered".
      const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
      if (decoded) return decoded;
    }
  }
  return undefined;
}

/**
 * Grace window after the connection-scoped SSE stream closes before the
 * connection is reaped (if not reconnected and no session stream is live).
 * Long enough to ride out a transient blip / reconnect, short enough to free
 * `ownedSessions` + a `maxConnections` slot well before the 30-min idle TTL.
 */
const CONN_GRACE_MS = 10_000;

/**
 * Grace window after a SESSION-scoped SSE stream closes at the transport level
 * (proxy idle-close, network blip) without an explicit `session/close`. The
 * binding — ownership, in-flight prompt, bridge-client — is kept alive so a
 * reconnect within the window resumes via ring replay (§1.8) instead of being
 * rejected (403) and re-spawning. Short enough to bound the runaway-prompt
 * cost if the client never returns. Mirrors `CONN_GRACE_MS`.
 */
const SESSION_GRACE_MS = 10_000;

const WS_EXEMPT_METHODS = new Set([
  '_qwen/session/heartbeat',
  '_qwen/session/update_metadata',
]);

const WS_READ_METHODS = new Set([
  'session/list',
  '_qwen/session/context',
  '_qwen/session/supported_commands',
  '_qwen/session/context_usage',
  '_qwen/session/tasks',
  '_qwen/session/lsp',
  '_qwen/session/artifacts',
  '_qwen/workspace/mcp',
  '_qwen/workspace/skills',
  '_qwen/workspace/providers',
  '_qwen/workspace/env',
  '_qwen/workspace/preflight',
  '_qwen/workspace/session_groups/list',
  '_qwen/workspace/trust',
  '_qwen/workspace/permissions',
  '_qwen/workspace/voice',
  '_qwen/workspace/tools',
  '_qwen/workspace/mcp/tools',
  '_qwen/workspace/mcp/resources',
  '_qwen/workspace/agents/list',
  '_qwen/workspace/agents/get',
  '_qwen/workspace/memory',
  '_qwen/workspace/memory/remember/get',
  '_qwen/workspace/memory/forget/get',
  '_qwen/workspace/memory/dream/get',
  '_qwen/workspace/auth/status',
  '_qwen/workspace/auth/device_flow/get',
  '_qwen/file/read',
  '_qwen/file/read_bytes',
  '_qwen/file/stat',
  '_qwen/file/list',
  '_qwen/file/glob',
]);

function isSameLoopbackOrigin(origin: string, localPort?: number): boolean {
  if (!localPort) return false;
  const parsed = new URL(origin);
  // Both schemes: under `--tls-cert/--tls-key` the loopback ACP client
  // speaks https, so its Origin header carries `https://`.
  const allowed = new Set([
    `http://localhost:${localPort}`,
    `http://127.0.0.1:${localPort}`,
    `http://[::1]:${localPort}`,
    `https://localhost:${localPort}`,
    `https://127.0.0.1:${localPort}`,
    `https://[::1]:${localPort}`,
  ]);
  // RFC 7230 §5.4: browsers omit the port in the Origin header when it
  // matches the scheme default (http→80, https→443). Accept the port-less
  // forms so the check doesn't fail on default ports.
  if (localPort === 80 || localPort === 443) {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      allowed.add(`http://${host}`);
      allowed.add(`https://${host}`);
    }
  }
  return allowed.has(parsed.origin.toLowerCase());
}

/**
 * Cap on concurrent fire-and-forget client-MCP register/unregister dispatches
 * per WS connection. `mcp_register`/`mcp_unregister` are dispatched off the
 * serialized message queue (not awaited), so without a guard a burst of frames
 * would each independently trigger a provider round-trip — DoS amplification.
 */
const MAX_INFLIGHT_MCP_DISPATCH = 8;

export interface MountAcpHttpOptions {
  boundWorkspace: string;
  workspace: DaemonWorkspaceService;
  fsFactory?: WorkspaceFileSystemFactory;
  deviceFlowRegistry?: DeviceFlowRegistry;
  enabled?: boolean;
  path?: string;
  maxConnections?: number;
  /** Bearer token for WS auth (WS bypasses Express middleware). */
  token?: string;
  /**
   * Parsed `--allow-origin` allowlist. The WS CSRF check (CSWSH defence)
   * rejects non-loopback origins; origins in this allowlist are also accepted,
   * so a browser extension (`chrome-extension://<id>`) can open the reverse
   * tool channel. Mirrors the REST CORS allowlist (`allowOriginCors`).
   */
  allowedOrigins?: ParsedAllowOriginPatterns;
  /** Hostname the daemon is listening on; used by local MCP child processes. */
  hostname?: string;
  /** Effective direct session shell policy for ACP initialize/dispatch. */
  sessionShellCommandEnabled?: boolean;
  archiveCoordinator?: SessionArchiveCoordinator;
  /** Shared lane for sessionless workspace remember tasks. */
  workspaceRememberLane: WorkspaceRememberTaskLane;
  /** Rate limit checker for WS messages (WS bypasses Express middleware). */
  checkRate?: (key: string, tier: RateLimitTier) => boolean;
  /**
   * Opt-in: accept client-hosted MCP servers over the WS (issue #5626,
   * Phase 2 "reverse tool channel"). When true, inbound `mcp_register` /
   * `mcp_message` / `mcp_unregister` frames are handled per-connection. Off by
   * default — the public contract is still settling.
   */
  clientMcpOverWs?: boolean;
  /**
   * Injection point for the deep wiring into the agent's live MCP stack. When
   * supplied, an `mcp_register` frame registers a real SDK-type runtime MCP
   * server whose discovery + tool calls round-trip over the WS. When omitted,
   * `mcp_register` is rejected with a structured `not_wired` error (the WS
   * framing + correlation still work, but no agent-visible server is created).
   *
   * Single shared instance — used by the round-trip test, which injects one
   * provider for the whole server. Production wires the per-connection
   * {@link clientMcpProviderFactory} instead (so each WS connection gets its
   * own runtime-MCP originator id). When both are set the factory wins.
   */
  clientMcpProvider?: ClientMcpServerProvider;
  /**
   * Per-WS-connection provider factory (issue #5626, production wiring). Called
   * once per connection (lazily, on the first client-MCP frame) with the
   * connection's stable id, so runtime-MCP mutations the provider performs are
   * attributed to that connection. Takes precedence over
   * {@link clientMcpProvider}.
   */
  clientMcpProviderFactory?: (connectionId: string) => ClientMcpServerProvider;
  /**
   * Opt-in: tunnel raw CDP to a real browser tab over the reverse `/acp` WS
   * (Plan C, issue #5626). When true, a `/cdp` upgrade branch accepts a loopback
   * puppeteer client and inbound `cdp_*` frames are routed to the bound reverse
   * link. Off by default.
   */
  cdpTunnelOverWs?: boolean;
  /**
   * Process-scoped registry that pairs the extension `/acp` reverse connection
   * with the `/cdp` endpoint. Required when {@link cdpTunnelOverWs} is on;
   * ignored otherwise.
   */
  cdpTunnelRegistry?: CdpTunnelRegistry;
  /**
   * Additional non-ACP WebSocket routes (e.g. `/voice/stream`) that reuse this
   * upgrade listener's security checks. Matched paths skip the ACP init flow.
   */
  /**
   * Phase 4 (issue #6378): the daemon's workspace registry. When present and it
   * has non-primary runtimes, `/workspaces/:workspace/acp` mounts a per-runtime
   * ACP dispatcher for each registered workspace. Legacy `/acp` stays bound to
   * the primary runtime.
   */
  workspaceRegistry?: WorkspaceRegistry;
  extraWsRoutes?: readonly ExtraWsRoute[];
}

/**
 * A non-ACP WebSocket route that shares the daemon's single upgrade listener
 * (and therefore its loopback / host-allowlist / CSRF / bearer-token checks)
 * instead of attaching a second `'upgrade'` listener — the ACP listener
 * `socket.destroy()`s unknown paths, so a competing listener can't coexist.
 */
export interface ExtraWsRoute {
  path: string;
  onConnection: (ws: WebSocket, req: IncomingMessage) => void;
}

/**
 * Per-workspace ACP mount. Phase 4 (issue #6378) turns the single-runtime
 * `/acp` into one mount per workspace runtime: each owns its own
 * `ConnectionRegistry` + `AcpDispatcher` (built from that runtime's bridge /
 * workspace / fsFactory / device-flow / remember-lane), while the HTTP handlers
 * and the single WS upgrade listener select the mount by URL path. CDP-bridge
 * runtime-MCP wiring stays primary-only, so non-primary mounts get no-op CDP
 * hooks.
 */
interface RuntimeAcpMount {
  readonly registry: ConnectionRegistry;
  readonly dispatcher: AcpDispatcher;
  readonly ensureChromeDevToolsMcpRegistered: (
    localPort: number | undefined,
    originatorClientId: string,
  ) => void;
  readonly removeChromeDevToolsMcpIfUnused: (
    originatorClientId: string,
  ) => void;
  readonly clientMcpProviderFactory?: (
    connectionId: string,
  ) => ClientMcpServerProvider;
}

export interface AcpHttpHandle {
  dispose(): void;
  registry: ConnectionRegistry;
  /** Attach HTTP server post-listen to enable WebSocket upgrade. */
  attachServer(server: import('node:http').Server): void;
}

/**
 * Mount the official ACP Streamable HTTP transport (RFD #721) on an
 * existing Express app, backed by the shared `HttpAcpBridge`. Additive:
 * the REST surface (`/session/*`) is untouched (design doc §6).
 *
 * Wire shape (single `/acp` endpoint):
 *   - POST   {initialize}  → 200 + capabilities JSON + `Acp-Connection-Id`
 *   - POST   {other}       → 202; reply delivered on a long-lived SSE stream
 *   - GET    (conn header) → connection-scoped SSE stream
 *   - GET    (conn+session)→ session-scoped SSE stream
 *   - DELETE               → 202; tears the connection down
 */
export function mountAcpHttp(
  app: Application,
  bridge: HttpAcpBridge,
  opts: MountAcpHttpOptions,
): AcpHttpHandle | undefined {
  const enabled = opts.enabled ?? process.env['QWEN_SERVE_ACP_HTTP'] !== '0';
  if (!enabled) return undefined;

  const path = opts.path ?? '/acp';
  const dispatcherRef: { current?: AcpDispatcher } = {};
  // When a session/connection tears down with a permission still pending,
  // cancel it on the bridge so the agent's prompt isn't left blocked.
  const registry = new ConnectionRegistry(
    (req, clientId) => {
      // Defensive, matching the `detachClient` callback below: if a future
      // refactor introduces async work between registry and dispatcher
      // creation, a teardown racing in here must not crash
      // `abandonPendingForSession`. Log and report "not cancelled" instead of
      // throwing through the teardown path.
      if (!dispatcherRef.current) {
        writeStderrLine(
          'qwen serve: /acp abandonPending called before dispatcher initialized (skipped)',
        );
        return false;
      }
      return dispatcherRef.current.cancelAbandonedPermission(req, clientId);
    },
    // Best-effort bridge detach so a torn-down connection's bridge-stamped
    // client ids don't linger in the bridge's voter/known-client sets.
    (sessionId, clientId) => {
      void bridge.detachClient(sessionId, clientId).catch((err: unknown) => {
        writeStderrLine(
          `qwen serve: /acp detachClient(${sessionId}) failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    },
    opts.maxConnections,
  );
  let cdpMcpRegistered = false;
  let cdpMcpRegistering: Promise<void> | undefined;
  let cdpMcpTerminalSkipLogged = false;

  async function removeChromeDevToolsMcp(
    originatorClientId: string,
  ): Promise<void> {
    if (!cdpMcpRegistered) return;
    cdpMcpRegistered = false;
    try {
      await bridge.removeRuntimeMcpServer(
        CHROME_DEVTOOLS_MCP_SERVER_NAME,
        originatorClientId,
      );
    } catch (err) {
      writeStderrLine(
        `qwen serve: failed to remove ${CHROME_DEVTOOLS_MCP_SERVER_NAME} runtime MCP: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  function removeChromeDevToolsMcpIfUnused(originatorClientId: string): void {
    void (async () => {
      if (opts.cdpTunnelRegistry?.hasActive()) return;
      if (cdpMcpRegistering) await cdpMcpRegistering;
      if (opts.cdpTunnelRegistry?.hasActive()) return;
      await removeChromeDevToolsMcp(originatorClientId);
    })().catch((err) => {
      writeStderrLine(
        `qwen serve: failed to clean up ${CHROME_DEVTOOLS_MCP_SERVER_NAME} runtime MCP: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  function ensureChromeDevToolsMcpRegistered(
    localPort: number | undefined,
    originatorClientId: string,
  ): void {
    if (opts.token) {
      if (!cdpMcpTerminalSkipLogged) {
        writeStderrLine(
          `qwen serve: ${CHROME_DEVTOOLS_MCP_SERVER_NAME} runtime MCP skipped because /cdp requires bearer auth`,
        );
        cdpMcpTerminalSkipLogged = true;
      }
      return;
    }
    if (cdpMcpRegistered || cdpMcpRegistering || cdpMcpTerminalSkipLogged) {
      return;
    }
    const runtimeConfig = buildChromeDevToolsMcpRuntimeConfig(
      localPort,
      opts.hostname,
    );
    if (!runtimeConfig) {
      cdpMcpTerminalSkipLogged = true;
      return;
    }
    cdpMcpRegistering = (async () => {
      try {
        let result: Awaited<ReturnType<typeof bridge.addRuntimeMcpServer>>;
        for (let attempt = 0; ; attempt++) {
          try {
            result = await bridge.addRuntimeMcpServer(
              CHROME_DEVTOOLS_MCP_SERVER_NAME,
              runtimeConfig,
              originatorClientId,
            );
            break;
          } catch (err) {
            if (
              !isAcpChannelUnavailable(err) ||
              attempt >= RUNTIME_MCP_RETRY_ATTEMPTS ||
              !opts.cdpTunnelRegistry?.hasActive()
            ) {
              throw err;
            }
            await delay(RUNTIME_MCP_RETRY_DELAY_MS);
          }
        }
        if ((result as { skipped?: boolean }).skipped) {
          writeStderrLine(
            `qwen serve: ${CHROME_DEVTOOLS_MCP_SERVER_NAME} runtime MCP skipped: ${
              (result as { reason?: string }).reason ?? 'unknown'
            }`,
          );
          return;
        }
        if ((result as { shadowedSettings?: boolean }).shadowedSettings) {
          await bridge
            .removeRuntimeMcpServer(
              CHROME_DEVTOOLS_MCP_SERVER_NAME,
              originatorClientId,
            )
            .catch(() => {});
          cdpMcpTerminalSkipLogged = true;
          writeStderrLine(
            `qwen serve: ${CHROME_DEVTOOLS_MCP_SERVER_NAME} runtime MCP skipped because settings already define it`,
          );
          return;
        }
        cdpMcpRegistered = true;
        if (!opts.cdpTunnelRegistry?.hasActive()) {
          await removeChromeDevToolsMcp(originatorClientId);
        }
      } catch (err) {
        writeStderrLine(
          `qwen serve: failed to add ${CHROME_DEVTOOLS_MCP_SERVER_NAME} runtime MCP: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } finally {
        cdpMcpRegistering = undefined;
      }
    })();
  }

  const dispatcher = new AcpDispatcher(
    bridge,
    opts.boundWorkspace,
    opts.workspace,
    opts.workspaceRememberLane,
    opts.fsFactory,
    opts.deviceFlowRegistry,
    opts.sessionShellCommandEnabled === true,
    registry,
    opts.archiveCoordinator ?? new SessionArchiveCoordinator(),
  );
  dispatcherRef.current = dispatcher;

  // Phase 4: the primary runtime's mount. Non-primary mounts are added later in
  // this milestone; the HTTP handlers and WS upgrade listener resolve the mount
  // by URL path and delegate to these same helpers.
  const primaryMount: RuntimeAcpMount = {
    registry,
    dispatcher,
    ensureChromeDevToolsMcpRegistered,
    removeChromeDevToolsMcpIfUnused,
    clientMcpProviderFactory: opts.clientMcpProviderFactory,
  };

  // DELETE /acp handler, parameterized by the resolved mount so the legacy
  // `/acp` and the Phase 4 `/workspaces/:workspace/acp` share one implementation.
  const handleAcpDelete = (
    mount: RuntimeAcpMount,
    req: Request,
    res: Response,
  ): void => {
    const connectionId = headerOf(req, ACP_CONNECTION_HEADER);
    if (!connectionId) {
      res.status(400).json({ error: 'Missing Acp-Connection-Id' });
      return;
    }
    // NOTE: like every other route, DELETE is gated only by the bearer
    // token — the daemon's trust boundary is "holds the token for this
    // daemon", so any token-holder may tear down any connection (same posture
    // as the REST `DELETE /session/:id`). A per-connection secret would add
    // intra-token isolation; deferred with the rest of the multi-tenant
    // hardening (design §7).
    const existed = mount.registry.delete(connectionId);
    if (existed) {
      writeStderrLine(
        `qwen serve: /acp connection deleted ${connectionId.slice(0, 8)} (remaining=${mount.registry.size})`,
      );
    }
    res.status(202).end();
  };

  // ── POST /acp ──────────────────────────────────────────────────────
  const handleAcpPost = async (
    mount: RuntimeAcpMount,
    req: Request,
    res: Response,
  ): Promise<void> => {
    // RFD: Content-Type MUST be application/json; otherwise 415.
    const ct = req.headers['content-type'];
    if (!ct || !ct.startsWith('application/json')) {
      res.status(415).json({ error: 'Content-Type must be application/json' });
      return;
    }
    // RFD: batch JSON-RPC arrays → 501 Not Implemented.
    if (Array.isArray(req.body)) {
      res
        .status(501)
        .json({ error: 'Batch JSON-RPC requests are not supported' });
      return;
    }
    const parsed = parseInbound(req.body);
    if (!parsed.ok) {
      writeStderrLine(
        `qwen serve: /acp malformed request from ${req.socket?.remoteAddress}: ${parsed.error.error.message}`,
      );
      res.status(400).json(parsed.error);
      return;
    }
    const message = parsed.message;

    // `initialize` mints a connection and replies inline (200 + JSON).
    if (isRequest(message) && message.method === 'initialize') {
      const conn = mount.registry.create(isLoopbackReq(req));
      if (!conn) {
        // Connection cap reached — shed load rather than grow unbounded.
        writeStderrLine(
          `qwen serve: /acp connection cap reached (max=${mount.registry.connectionCap}), rejecting initialize`,
        );
        res.setHeader('Retry-After', '5');
        res
          .status(503)
          .json(
            rpcError(
              message.id,
              RPC.INTERNAL_ERROR,
              'Too many ACP connections; retry later',
            ),
          );
        return;
      }
      const requestedVersion =
        message.params &&
        typeof message.params === 'object' &&
        !Array.isArray(message.params)
          ? (message.params as Record<string, unknown>)['protocolVersion']
          : undefined;
      res.setHeader('Acp-Connection-Id', conn.connectionId);
      res.status(200).json({
        // success envelope: clients correlate by the request id.
        jsonrpc: '2.0',
        id: message.id,
        result: mount.dispatcher.buildInitializeResult(
          conn.connectionId,
          requestedVersion,
        ),
      });
      writeStderrLine(
        `qwen serve: /acp connection established ${conn.connectionId.slice(0, 8)} ` +
          `(loopback=${conn.fromLoopback}, active=${mount.registry.size})`,
      );
      return;
    }

    const connHeader = headerOf(req, ACP_CONNECTION_HEADER);
    if (!connHeader) {
      res
        .status(400)
        .json(
          rpcError(
            isRequest(message) ? message.id : null,
            RPC.INVALID_REQUEST,
            'Missing Acp-Connection-Id',
          ),
        );
      return;
    }
    const conn = mount.registry.get(connHeader);
    if (!conn) {
      res
        .status(404)
        .json(
          rpcError(
            isRequest(message) ? message.id : null,
            RPC.INVALID_REQUEST,
            'Unknown Acp-Connection-Id',
          ),
        );
      return;
    }

    // Rate limit ACP HTTP POST (mirrors the WS checkRate path).
    if (opts.checkRate && isRequest(message)) {
      const m = message.method;
      if (!WS_EXEMPT_METHODS.has(m)) {
        const tier: RateLimitTier =
          m === 'session/prompt' || m === '_qwen/session/prompt'
            ? 'prompt'
            : WS_READ_METHODS.has(m)
              ? 'read'
              : 'mutation';
        const httpKey = (req.socket?.remoteAddress ?? 'http-unknown').replace(
          /^::ffff:/,
          '',
        );
        if (!opts.checkRate(httpKey, tier)) {
          res.setHeader('Retry-After', '5');
          res.status(429).json({
            error: 'Rate limit exceeded',
            code: 'rate_limit_exceeded',
            tier,
          });
          return;
        }
      }
    }

    // Per RFD: non-initialize POST acks 202; the reply rides an SSE stream.
    res.status(202).end();
    // Response already sent — `handle` delivers everything else over SSE, so
    // swallow+log any late rejection rather than let it escape as an
    // unhandled rejection (which could take the daemon down).
    await mount.dispatcher
      .handle(
        conn,
        message,
        headerOf(req, ACP_SESSION_HEADER),
        isLoopbackReq(req),
      )
      .catch((err: unknown) => {
        writeStderrLine(
          `qwen serve: /acp handle error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  };

  app.post(path, (req: Request, res: Response) => {
    void handleAcpPost(primaryMount, req, res);
  });

  // ── GET /acp (SSE) ─────────────────────────────────────────────────
  const handleAcpGet = (
    mount: RuntimeAcpMount,
    req: Request,
    res: Response,
  ): void => {
    // RFD: Accept MUST include text/event-stream; otherwise 406.
    const accept = req.headers['accept'] ?? '';
    if (!accept.includes('text/event-stream')) {
      res
        .status(406)
        .json({ error: 'Accept header must include text/event-stream' });
      return;
    }
    const connHeader = headerOf(req, ACP_CONNECTION_HEADER);
    if (!connHeader) {
      res.status(400).json({ error: 'Missing Acp-Connection-Id' });
      return;
    }
    const conn = mount.registry.get(connHeader);
    if (!conn) {
      res.status(404).json({ error: 'Unknown Acp-Connection-Id' });
      return;
    }
    const sessionId = headerOf(req, ACP_SESSION_HEADER);

    if (!sessionId) {
      // Connection-scoped stream. onClose logs the disconnect so a
      // half-dead connection (conn stream gone, replies silently buffering)
      // leaves an operator breadcrumb.
      const connId = conn.connectionId;
      const stream = new SseStream(
        res,
        () => {
          writeStderrLine(
            `qwen serve: /acp connection stream closed (${connId.slice(0, 8)})`,
          );
          // Grace-period reap: a dead connection otherwise locks its
          // ownedSessions + counts against maxConnections for the full 30-min
          // idle TTL. After the grace window, reap UNLESS a reconnect
          // re-attached the conn stream (clears the timer) OR a session
          // stream is still live (client is active — only the conn stream
          // blipped, don't kill its sessions/prompts) OR a session is itself
          // mid-reconnect within its OWN grace window (`hasRecoverableSession`)
          // — reaping then would 404 the imminent session resume and abort the
          // in-flight prompt before SESSION_GRACE_MS promised.
          conn.clearGraceTimer();
          // Reap iff the grace has elapsed and this dead conn stream is still
          // current with nothing live or mid-reconnect. Shared by the grace
          // timer and the post-session-grace re-check (below) so a connection
          // blocked from reaping by a then-recoverable session doesn't linger
          // until the 30-min idle sweep after that session finally tears down.
          const reapConnIfDead = () => {
            if (
              mount.registry.get(connId) === conn &&
              conn.connStream === stream &&
              conn.connGraceExpired &&
              !conn.hasLiveSessionStream() &&
              !conn.hasRecoverableSession()
            ) {
              writeStderrLine(
                `qwen serve: /acp reaping connection ${connId.slice(0, 8)} (conn stream gone, no live session stream)`,
              );
              mount.registry.delete(connId);
            }
          };
          conn.connGraceTimer = setTimeout(() => {
            conn.connGraceExpired = true;
            reapConnIfDead();
          }, CONN_GRACE_MS);
          conn.connGraceTimer.unref?.();
          // When a session's reclaim grace expires it may have been the last
          // thing blocking this reap; re-evaluate then too.
          conn.onSessionGraceExpired = reapConnIfDead;
        },
        () => conn.touch(),
      );
      stream.open();
      conn.attachConnStream(stream);
      return;
    }

    // Session-scoped stream — only for a session THIS connection owns
    // (created via session/new or attached via session/load|resume). Stops
    // one connection eavesdropping on another's session event stream.
    if (!conn.ownsSession(sessionId)) {
      res.status(403).json({ error: 'Session not owned by this connection' });
      return;
    }

    // Fresh controller per stream so a reconnect gets a live (non-aborted)
    // signal; `attachSessionStream` installs it and tears down any prior
    // stream/subscription. onClose aborts THIS stream's controller — a
    // stale stream closing can't cancel a newer subscription.
    const ac = new AbortController();
    const stream = new SseStream(
      res,
      () => {
        // Transport-level close (tab close / network drop / proxy idle-close):
        // stop THIS stream's event pump only. The prompt + ownership are NOT
        // torn down here — `detachSessionStream` (below) keeps them across a
        // grace window so a reconnect can resume (§1.8). Only an expired grace,
        // an explicit `session/close`, or connection teardown aborts the prompt.
        ac.abort();
      },
      () => conn.touch(),
    );
    // Open (write SSE headers + `retry:`) BEFORE attaching, so the protocol
    // handshake precedes any buffered frames the attach flushes.
    stream.open();
    // Resume cursor: an EventSource/SSE client auto-resends the last `id:` it
    // saw as `Last-Event-ID` on reconnect. Drives the EventBus ring replay so
    // content frames produced during a mid-turn proxy gap are recovered (§1.8).
    const lastEventId = parseLastEventId(
      headerOf(req, 'last-event-id'),
      '/acp ',
    );
    // Pass the resume cursor INTO attach: when resuming, attach skips flushing
    // id-bearing buffered frames because the ring replay below redelivers every
    // bus event after `lastEventId` exactly once — including any frame lost
    // in-flight to the dead socket (whose id sits below the buffer's ids but
    // above the client's cursor). Advancing the cursor past the buffer instead
    // would silently drop that frame; flushing AND replaying would double-send.
    // Id-less JSON-RPC replies are still flushed (they aren't ring events).
    conn.attachSessionStream(sessionId, stream, ac, lastEventId);
    // When the pump settles, branch on WHY:
    //  • the transport closed the stream (proxy idle-close / tab close) →
    //    DETACH with a grace window: keep ownership + the in-flight prompt so a
    //    reconnect resumes (§1.8); full teardown only if no reconnect arrives.
    //  • the pump ended while the stream is still open (subprocess done /
    //    iterator error) → the stream is a zombie; full close now.
    // Both are identity-guarded so a stale stream can't act on a newer one.
    // INVARIANT (cross-file, mirrors the CONTRACT comment in
    // `connection-registry.ts` `attachSessionStream`): the identity checks below
    // (`conn.sessions.get(sessionId)?.stream === stream`) are load-bearing and
    // depend on `attachSessionStream` installing the NEW stream BEFORE the old
    // one's pump settles here. If a refactor closed the old stream first, this
    // settling pump would see `stream !== current` and fall into the "superseded"
    // no-op while the reclaim is mid-flight — skipping detach-with-grace and
    // aborting the prompt instead of keeping it alive for reconnect. The
    // identity guard, not a flag, is what keeps a stale close from tearing down a
    // fresh reclaim. Covered by connection-registry.test.ts "detachSessionStream
    // is a no-op for a stale stream after reclaim (identity guard)".
    const onPumpSettled = () => {
      if (stream.isClosed) {
        // Transport-closed → detach-with-grace. detachSessionStream logs the
        // detach breadcrumb itself (with the grace window).
        conn.detachSessionStream(sessionId, stream, SESSION_GRACE_MS);
      } else if (conn.sessions.get(sessionId)?.stream === stream) {
        // Pump ended while the stream is still open (subprocess done / iterator
        // error) → the stream is a zombie; full close now. Logged so the
        // operator trail can tell this apart from a transport-close detach.
        writeStderrLine(
          `qwen serve: /acp session stream pump ended while open ` +
            `(${logSafe(sessionId)}) — closing`,
        );
        conn.closeSessionStream(sessionId);
      } else {
        // Guard mismatch: a stale stream's pump settled after a newer reclaim
        // already took over. No-op, but log it so the trail isn't silent.
        writeStderrLine(
          `qwen serve: /acp session stream pump settled for a superseded ` +
            `stream (${logSafe(sessionId)}) — no-op`,
        );
      }
    };
    void mount.dispatcher
      .pumpSessionEvents(conn, sessionId, ac.signal, lastEventId)
      .then(onPumpSettled, (err: unknown) => {
        writeStderrLine(
          `qwen serve: /acp event pump error (${logSafe(sessionId)}, lastEventId=${
            lastEventId ?? 'none'
          }): ${logSafe(err instanceof Error ? err.message : String(err))}`,
        );
        onPumpSettled();
      });
  };

  app.get(path, (req: Request, res: Response) => {
    handleAcpGet(primaryMount, req, res);
  });

  // ── DELETE /acp ────────────────────────────────────────────────────
  app.delete(path, (req: Request, res: Response) => {
    handleAcpDelete(primaryMount, req, res);
  });

  // ── Phase 4: workspace-qualified ACP (/workspaces/:workspace/acp) ────
  // One dispatcher + connection registry per non-primary runtime, bound to that
  // runtime's bridge / workspace / fsFactory / remember-lane. CDP-bridge
  // runtime-MCP and reverse client-MCP stay primary-only in this milestone;
  // per-runtime device-flow lands in a later milestone.
  const createSecondaryAcpMount = (rt: WorkspaceRuntime): RuntimeAcpMount => {
    const secondaryDispatcherRef: { current?: AcpDispatcher } = {};
    const secondaryRegistry = new ConnectionRegistry(
      (req, clientId) => {
        if (!secondaryDispatcherRef.current) return false;
        return secondaryDispatcherRef.current.cancelAbandonedPermission(
          req,
          clientId,
        );
      },
      (sessionId, clientId) => {
        void rt.bridge
          .detachClient(sessionId, clientId)
          .catch((err: unknown) => {
            writeStderrLine(
              `qwen serve: /workspaces/${rt.workspaceId}/acp detachClient(${sessionId}) failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
      },
      opts.maxConnections,
    );
    const secondaryDispatcher = new AcpDispatcher(
      rt.bridge,
      rt.workspaceCwd,
      rt.workspaceService,
      new WorkspaceRememberTaskLane(rt.bridge),
      rt.routeFileSystemFactory,
      rt.deviceFlowRegistry,
      opts.sessionShellCommandEnabled === true,
      secondaryRegistry,
      opts.archiveCoordinator ?? new SessionArchiveCoordinator(),
    );
    secondaryDispatcherRef.current = secondaryDispatcher;
    return {
      registry: secondaryRegistry,
      dispatcher: secondaryDispatcher,
      ensureChromeDevToolsMcpRegistered: () => {},
      removeChromeDevToolsMcpIfUnused: () => {},
      // Reverse client-MCP over WS is per-runtime: a connection on this
      // workspace's ACP registers client-hosted MCP servers in this runtime's
      // sender registry + bridge only. Only wired when the reverse channel is
      // enabled (mirrors the primary mount).
      clientMcpProviderFactory:
        opts.clientMcpOverWs === true
          ? (connectionId: string) =>
              createClientMcpServerProvider(
                rt.clientMcpSenderRegistry,
                rt.bridge,
                connectionId,
              )
          : undefined,
    };
  };

  const secondaryMounts = new Map<string, RuntimeAcpMount>();
  for (const rt of opts.workspaceRegistry?.list() ?? []) {
    if (!rt.primary) {
      secondaryMounts.set(rt.workspaceId, createSecondaryAcpMount(rt));
    }
  }

  // Resolve the mount for a `/workspaces/:workspace/acp` request. Unknown
  // selectors 400 via the shared resolver; untrusted non-primary workspaces are
  // rejected here (no ACP child is spawned). Read/teardown refinement for
  // untrusted workspaces is deferred to a later milestone.
  const resolvePluralMount = (
    req: Request,
    res: Response,
  ): RuntimeAcpMount | null => {
    const workspaceRegistry = opts.workspaceRegistry;
    if (!workspaceRegistry) {
      res.status(400).json({
        error: 'Workspace-qualified ACP is not enabled on this daemon',
        code: 'workspace_mismatch',
      });
      return null;
    }
    const rt = resolveWorkspaceRuntimeFromParam(workspaceRegistry, req, res);
    if (!rt) return null;
    if (!rt.primary && !rt.trusted) {
      res.status(403).json({
        error: `Workspace "${rt.workspaceCwd}" is not trusted.`,
        code: 'untrusted_workspace',
        workspaceCwd: rt.workspaceCwd,
        workspaceId: rt.workspaceId,
      });
      return null;
    }
    if (rt.primary) return primaryMount;
    const mount = secondaryMounts.get(rt.workspaceId);
    if (!mount) {
      res.status(400).json({
        error: `Workspace "${rt.workspaceCwd}" has no registered ACP mount`,
        code: 'workspace_mismatch',
        workspaceCwd: rt.workspaceCwd,
        workspaceId: rt.workspaceId,
      });
      return null;
    }
    return mount;
  };

  const pluralAcpPath = '/workspaces/:workspace/acp';
  app.post(pluralAcpPath, (req: Request, res: Response) => {
    const mount = resolvePluralMount(req, res);
    if (!mount) return;
    void handleAcpPost(mount, req, res);
  });
  app.get(pluralAcpPath, (req: Request, res: Response) => {
    const mount = resolvePluralMount(req, res);
    if (!mount) return;
    handleAcpGet(mount, req, res);
  });
  app.delete(pluralAcpPath, (req: Request, res: Response) => {
    const mount = resolvePluralMount(req, res);
    if (!mount) return;
    handleAcpDelete(mount, req, res);
  });

  // ── WebSocket upgrade (ACP RFD) ────────────────────────────────────
  let wss: WebSocketServer | undefined;
  let upgradeListener:
    | ((req: IncomingMessage, socket: Duplex, head: Buffer) => void)
    | undefined;
  let upgradeServer: import('node:http').Server | undefined;

  function setupWebSocket(httpServer: import('node:http').Server): void {
    if (wss) return;
    wss = new WebSocketServer({
      noServer: true,
      maxPayload: 10 * 1024 * 1024,
      // Browsers authenticate the upgrade by offering the bearer token as a
      // `qwen-bearer.*` subprotocol (see extractUpgradeBearer). Never echo that
      // secret-bearing value back in the handshake response — select the first
      // non-secret subprotocol instead. The web-shell offers a non-secret
      // marker (`qwen-ws`) alongside the bearer one precisely so there is always
      // a safe value to select: selecting none would make strict WS clients
      // (e.g. the `ws` library) reject the handshake with "Server sent no
      // subprotocol". ACP clients offer no subprotocol, so this is a no-op for
      // them.
      handleProtocols: (protocols) => {
        for (const proto of protocols) {
          if (!proto.startsWith(WS_BEARER_SUBPROTOCOL_PREFIX)) return proto;
        }
        return false;
      },
    });
    upgradeServer = httpServer;
    const expectedTokenHash = opts.token
      ? createHash('sha256').update(opts.token).digest()
      : undefined;

    upgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const rawAddr =
        (socket as unknown as { remoteAddress?: string }).remoteAddress ??
        'ws-unknown';
      const localPort = (socket as { localPort?: number }).localPort;
      const logReject = (reason: string) => {
        writeStderrLine(
          `qwen serve: WebSocket upgrade rejected (${reason}) from ${rawAddr}`,
        );
      };
      let url: URL;
      try {
        url = new URL(
          req.url ?? '/',
          `http://${req.headers.host ?? 'localhost'}`,
        );
      } catch {
        logReject('invalid-url');
        socket.destroy();
        return;
      }
      // `/cdp` is the Plan C CDP-tunnel endpoint (issue #5626): a loopback
      // puppeteer client connects to drive a real tab. It reuses the SAME
      // loopback / host-allowlist / auth / CSRF checks below, then upgrades into
      // the CDP glue instead of the ACP handshake. Off unless opted in.
      const isCdpPath =
        opts.cdpTunnelOverWs === true &&
        opts.cdpTunnelRegistry !== undefined &&
        url.pathname === CDP_PATH;
      const extraRoute = opts.extraWsRoutes?.find(
        (route) => route.path === url.pathname,
      );
      // Phase 4: `/workspaces/<selector>/acp` is a valid upgrade path shape when
      // the daemon has a workspace registry. Actual workspace resolution/trust
      // runs after the shared security checks below.
      const isPluralAcpShape =
        opts.workspaceRegistry !== undefined &&
        url.pathname.startsWith(PLURAL_ACP_WS_PREFIX) &&
        url.pathname.endsWith(PLURAL_ACP_WS_SUFFIX) &&
        url.pathname.length >
          PLURAL_ACP_WS_PREFIX.length + PLURAL_ACP_WS_SUFFIX.length &&
        !url.pathname
          .slice(
            PLURAL_ACP_WS_PREFIX.length,
            url.pathname.length - PLURAL_ACP_WS_SUFFIX.length,
          )
          .includes('/');
      if (
        url.pathname !== path &&
        !isCdpPath &&
        !extraRoute &&
        !isPluralAcpShape
      ) {
        logReject(`unknown-path ${url.pathname}`);
        socket.destroy();
        return;
      }

      const fromLoopback = isLoopbackSocket(socket);

      // Host allowlist: mirror REST surface's hostAllowlist middleware
      // (auth.ts:196). Prevents DNS-rebinding attacks where a malicious
      // domain resolves to 127.0.0.1 and the browser sends the
      // attacker's Host header. Match the full host:port string like
      // the REST middleware does; extract port from the socket.
      if (fromLoopback) {
        const host = (req.headers['host'] ?? '').toLowerCase();
        const allowed = new Set([
          `localhost:${localPort}`,
          `127.0.0.1:${localPort}`,
          `[::1]:${localPort}`,
          `host.docker.internal:${localPort}`,
        ]);
        // RFC 7230 §5.4: browsers omit the port suffix when it matches the
        // scheme default (http→80, https→443). On TLS/port 443 the browser
        // sends `Host: localhost`, which won't match `localhost:443` and
        // every WS upgrade is rejected. Mirror the REST host allowlist
        // (auth.ts) and accept the port-less forms on default ports.
        if (localPort === 80 || localPort === 443) {
          allowed.add('localhost');
          allowed.add('127.0.0.1');
          allowed.add('[::1]');
          allowed.add('host.docker.internal');
        }
        if (!allowed.has(host)) {
          logReject(`host-not-allowed ${host || '(missing)'}`);
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      // CSRF: reject cross-origin WS upgrades. Browser-initiated requests
      // to 127.0.0.1 carry the external origin, so this check must apply
      // to loopback too (CSWSH defence).
      const origin = req.headers['origin'];
      if (origin) {
        try {
          const isLoopbackOrigin = isSameLoopbackOrigin(origin, localPort);
          // `--allow-origin` allowlist (same match semantics as the REST
          // `allowOriginCors`): lets an explicitly permitted non-loopback
          // origin — e.g. a browser extension's `chrome-extension://<id>`
          // opening the reverse tool channel — past the CSWSH wall.
          const isAllowlistedOrigin =
            opts.allowedOrigins !== undefined &&
            opts.allowedOrigins.origins.has(origin.toLowerCase());
          if (!isLoopbackOrigin && !isAllowlistedOrigin) {
            logReject(`origin-not-allowed ${origin}`);
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }
        } catch {
          logReject('invalid-origin');
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      // Auth: WS bypasses Express middleware. Same posture as REST:
      // loopback without token = allow; non-loopback/token-mismatch = reject.
      if (opts.token) {
        // Accept the token from `Authorization` (non-browser clients) or the
        // `qwen-bearer.*` subprotocol (browsers, which can't set Authorization
        // on a WebSocket). Hash-compare in constant time, same posture as REST.
        const credentials = extractUpgradeBearer(req);
        const actual = credentials
          ? createHash('sha256').update(credentials).digest()
          : undefined;
        if (
          !actual ||
          !expectedTokenHash ||
          actual.length !== expectedTokenHash.length ||
          !timingSafeEqual(expectedTokenHash, actual)
        ) {
          logReject('auth-mismatch');
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      } else if (!fromLoopback) {
        logReject('non-loopback-without-token');
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      // ── /cdp branch: hand the upgraded socket to the CDP-tunnel glue ──
      if (isCdpPath) {
        wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          attachCdpClient(ws, opts.cdpTunnelRegistry!, writeStderrLine);
        });
        return;
      }

      // ── Phase 4: resolve the target ACP mount for this upgrade ──
      // Legacy `/acp` binds to the primary mount; `/workspaces/:workspace/acp`
      // resolves the registered runtime's mount. The shared security checks
      // above already ran uniformly; workspace resolution/trust happens only
      // after them, and the raw URL is decoded here (WS bypasses Express).
      let activeMount = primaryMount;
      if (isPluralAcpShape) {
        const selector = decodeURIComponent(
          url.pathname.slice(
            PLURAL_ACP_WS_PREFIX.length,
            url.pathname.length - PLURAL_ACP_WS_SUFFIX.length,
          ),
        );
        const wsRegistry = opts.workspaceRegistry;
        const rt = wsRegistry
          ? (wsRegistry.getByWorkspaceId(selector) ??
            resolveRegisteredWorkspaceRuntimeByPathSelector(
              wsRegistry,
              selector,
            ))
          : undefined;
        if (!rt) {
          logReject(`workspace-mismatch ${selector}`);
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
          socket.destroy();
          return;
        }
        if (!rt.primary && !rt.trusted) {
          logReject(`untrusted-workspace ${rt.workspaceId}`);
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
        const resolvedMount = rt.primary
          ? primaryMount
          : secondaryMounts.get(rt.workspaceId);
        if (!resolvedMount) {
          logReject(`workspace-acp-no-mount ${rt.workspaceId}`);
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
          socket.destroy();
          return;
        }
        activeMount = resolvedMount;
      }

      wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        // Non-ACP routes (e.g. voice) own their own protocol — hand the
        // upgraded socket off and skip the ACP initialize handshake.
        if (extraRoute) {
          extraRoute.onConnection(ws, req);
          return;
        }
        let initialized = false;
        const initTimer = setTimeout(() => {
          if (!initialized) {
            writeStderrLine(
              `qwen serve: /acp WS initialize timeout (30s) from ${rawAddr}`,
            );
            ws.close(1002, 'Initialize timeout');
          }
        }, 30_000);
        initTimer.unref?.();
        let connRef: AcpConnection | undefined;
        let messageQueue = Promise.resolve();
        // Per-connection client-hosted MCP holder (issue #5626). Created
        // lazily on the first client-MCP frame; disposed on WS close.
        let clientMcp: ClientMcpWsConnection | undefined;
        // In-flight fire-and-forget client-MCP register/unregister dispatches.
        // `mcp_register`/`mcp_unregister` are dispatched off the message queue
        // (not awaited), so a burst would otherwise spawn unbounded concurrent
        // provider round-trips. Capped by MAX_INFLIGHT_MCP_DISPATCH below.
        let clientMcpInflightDispatch = 0;
        // Per-connection CDP-tunnel bridge unregister (Plan C, issue #5626),
        // called on WS close.
        let cdpBridgeUnregister: (() => void) | undefined;
        // The registered CDP bridge endpoint. Its `routeInbound` starts as a
        // no-op and is reassigned by the `/cdp` glue when a puppeteer client binds.
        let cdpEndpoint: CdpBridgeEndpoint | undefined;
        const wsKey = rawAddr.startsWith('::ffff:')
          ? rawAddr.slice(7)
          : rawAddr;

        ws.on('error', (err) => {
          writeStderrLine(
            `qwen serve: /acp WS error: ${err instanceof Error ? err.message : String(err)}`,
          );
        });

        // Tear down client-hosted MCP servers when the socket goes away so a
        // disconnected extension doesn't leave runtime servers + pending
        // requests dangling. WsStream's onClose handles ACP teardown; this is
        // the orthogonal client-MCP teardown.
        ws.on('close', () => {
          if (clientMcp) {
            void clientMcp.dispose('WS closed').catch(() => {});
            clientMcp = undefined;
          }
          if (cdpBridgeUnregister) {
            cdpBridgeUnregister();
            cdpBridgeUnregister = undefined;
            removeChromeDevToolsMcpIfUnused(
              connRef?.connectionId ?? 'cdp-bridge',
            );
          }
        });

        ws.on('message', (rawData: Buffer | string) => {
          messageQueue = messageQueue
            .then(() => handleWsMessage(rawData))
            .catch((err) => {
              writeStderrLine(
                `qwen serve: /acp WS message handler error: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        });

        async function handleWsMessage(
          rawData: Buffer | string,
        ): Promise<void> {
          let text: string;
          try {
            text =
              typeof rawData === 'string' ? rawData : rawData.toString('utf8');
          } catch {
            ws.close(1003, 'Only text frames supported');
            return;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            ws.send(
              JSON.stringify(rpcError(null, RPC.PARSE_ERROR, 'Parse error')),
            );
            return;
          }

          if (Array.isArray(parsed)) {
            ws.send(
              JSON.stringify({
                error: 'Batch JSON-RPC not supported',
              }),
            );
            return;
          }

          // ── Client-hosted MCP frames (issue #5626) ───────────────────
          // These are NOT JSON-RPC envelopes — they carry a `type`
          // discriminator (`mcp_register` / `mcp_message` / `mcp_unregister`)
          // and ride the same WS as the ACP stream. Intercept before
          // `parseInbound` (which would reject them as malformed JSON-RPC).
          if (
            opts.clientMcpOverWs === true &&
            parsed !== null &&
            typeof parsed === 'object' &&
            ClientMcpWsConnection.isClientMcpFrameType(
              (parsed as { type?: unknown }).type,
            )
          ) {
            // Client-MCP requires an initialized connection (the ACP handshake
            // establishes the connection identity + stream first).
            if (!initialized) {
              ws.send(
                JSON.stringify({
                  type: 'mcp_error',
                  code: 'not_initialized',
                  message: 'initialize the ACP connection before mcp_register',
                }),
              );
              return;
            }

            const frameType = (parsed as { type?: unknown }).type;

            // Rate-limit the reverse client-MCP channel: an initialized client
            // can otherwise spam mcp_register/mcp_unregister (each drives runtime
            // MCP add/remove/discovery) without consuming the daemon's configured
            // mutation budget. mcp_message is a correlation reply on the hot path,
            // so it rides the lighter 'read' tier. Only enforced when a limiter
            // is configured (mirrors the JSON-RPC checkRate block below).
            if (opts.checkRate) {
              const tier: RateLimitTier =
                frameType === 'mcp_message' ? 'read' : 'mutation';
              if (!opts.checkRate(wsKey, tier)) {
                safeWsSend(
                  ws,
                  JSON.stringify({
                    type: 'mcp_error',
                    code: 'rate_limited',
                    message: 'Rate limit exceeded',
                  }),
                  'client-MCP',
                );
                return;
              }
            }

            if (!clientMcp) {
              // Prefer the per-connection factory (production) so the
              // provider's runtime-MCP mutations are attributed to THIS
              // connection; fall back to the single shared provider (tests).
              // `connRef` is set above once `initialized` is true.
              const provider = activeMount.clientMcpProviderFactory
                ? activeMount.clientMcpProviderFactory(
                    connRef?.connectionId ?? 'ws-unknown',
                  )
                : opts.clientMcpProvider;
              clientMcp = new ClientMcpWsConnection(
                (frame) => safeWsSend(ws, JSON.stringify(frame), 'client-MCP'),
                provider,
              );
            }

            const sendClientMcpAck = (
              result: Awaited<ReturnType<ClientMcpWsConnection['handleFrame']>>,
            ): void => {
              // `message_resolved` correlates a client→daemon response — no
              // ack frame (the awaiting agent request resolves directly).
              // `ignored` is silent. Everything else gets a structured ack.
              if (result.kind === 'registered') {
                safeWsSend(
                  ws,
                  JSON.stringify({
                    type: 'mcp_registered',
                    server: result.server,
                    toolCount: result.toolCount,
                  }),
                  'client-MCP',
                );
              } else if (result.kind === 'unregistered') {
                safeWsSend(
                  ws,
                  JSON.stringify({
                    type: 'mcp_unregistered',
                    server: result.server,
                  }),
                  'client-MCP',
                );
              } else if (result.kind === 'error') {
                safeWsSend(
                  ws,
                  JSON.stringify({
                    type: 'mcp_error',
                    code: result.code,
                    message: result.message,
                  }),
                  'client-MCP',
                );
              }
            };

            // `mcp_register` / `mcp_unregister` await a provider round-trip
            // that ITSELF needs `mcp_message` response frames delivered on
            // THIS same serialized queue — awaiting it inline would deadlock
            // (responses queued behind the still-in-flight register). Mirror
            // the `session/prompt` pattern: dispatch off the queue and ack when
            // it resolves. NOTE the naming: register/unregister still EXPECT a
            // response frame (`mcp_registered`/`mcp_error`) — they're just
            // dispatched off-queue, not awaited inline. `mcp_message` is itself a
            // synchronous correlation response, so it stays inline (keeps
            // ordering) and needs no ack.
            const dispatchOffQueue = frameType !== 'mcp_message';
            if (dispatchOffQueue) {
              // DoS guard: the dispatch below is NOT awaited, so a burst of
              // register/unregister frames would otherwise spawn unbounded
              // concurrent provider round-trips. Reject once at the cap.
              if (clientMcpInflightDispatch >= MAX_INFLIGHT_MCP_DISPATCH) {
                writeStderrLine(
                  `qwen serve: /acp client-MCP inflight cap hit (${MAX_INFLIGHT_MCP_DISPATCH}); rejecting ${String(frameType)} frame`,
                );
                safeWsSend(
                  ws,
                  JSON.stringify({
                    type: 'mcp_error',
                    code: 'too_many_inflight',
                    message: `too many concurrent client-MCP registrations (max ${MAX_INFLIGHT_MCP_DISPATCH})`,
                  }),
                  'client-MCP',
                );
                return;
              }

              clientMcpInflightDispatch++;
            }
            const handleP = clientMcp
              .handleFrame(parsed as Record<string, unknown>)
              .then(sendClientMcpAck, (err: unknown) => {
                const message =
                  err instanceof Error ? err.message : String(err);
                writeStderrLine(
                  `qwen serve: /acp client-mcp frame error: ${message}`,
                );
                // handleFrame normally returns a structured {kind:'error'};
                // this branch is an UNEXPECTED rejection. mcp_register /
                // mcp_unregister callers block on a response frame, so without
                // an mcp_error here they hang. mcp_message is a reply (not a
                // request), so it needs no ack.
                if (dispatchOffQueue) {
                  safeWsSend(
                    ws,
                    JSON.stringify({
                      type: 'mcp_error',
                      code: 'internal_error',
                      message,
                    }),
                    'client-MCP',
                  );
                }
              })
              .finally(() => {
                if (dispatchOffQueue) clientMcpInflightDispatch--;
              });
            if (frameType === 'mcp_message') {
              await handleP;
            }
            return;
          }

          // ── CDP-tunnel frames (Plan C, issue #5626) ──────────────────
          // The extension's `cdp_*` frames on this `/acp` socket are NOT
          // JSON-RPC, so intercept before `parseInbound` and route to the bound
          // `/cdp` reverse link. `routeInbound` is a no-op until a puppeteer
          // client binds.
          if (
            opts.cdpTunnelOverWs === true &&
            cdpEndpoint !== undefined &&
            parsed !== null &&
            typeof parsed === 'object' &&
            isCdpInboundFrameType((parsed as { type?: unknown }).type)
          ) {
            cdpEndpoint.routeInbound(parsed as Record<string, unknown>);
            return;
          }

          const inbound = parseInbound(parsed);
          if (!inbound.ok) {
            ws.send(JSON.stringify(inbound.error));
            return;
          }
          const message = inbound.message;

          if (!initialized) {
            if (!isRequest(message) || message.method !== 'initialize') {
              ws.send(
                JSON.stringify(
                  rpcError(
                    isRequest(message) ? message.id : null,
                    RPC.INVALID_REQUEST,
                    'First message must be initialize',
                  ),
                ),
              );
              ws.close(1002, 'Protocol error');
              return;
            }

            const conn = activeMount.registry.create(fromLoopback);
            if (!conn) {
              ws.send(
                JSON.stringify(
                  rpcError(
                    message.id,
                    RPC.INTERNAL_ERROR,
                    'Too many connections',
                  ),
                ),
              );
              ws.close(1013, 'Connection cap');
              return;
            }

            const requestedVersion =
              message.params &&
              typeof message.params === 'object' &&
              !Array.isArray(message.params)
                ? (message.params as Record<string, unknown>)['protocolVersion']
                : undefined;

            // WS: single socket serves as conn stream + all session streams.
            const stream = new WsStream(
              ws,
              () => {
                writeStderrLine(
                  `qwen serve: /acp WS closed (${conn.connectionId.slice(0, 8)})`,
                );
                activeMount.registry.delete(conn.connectionId);
              },
              () => conn.touch(),
            );
            conn.attachConnStream(stream);

            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result: activeMount.dispatcher.buildInitializeResult(
                  conn.connectionId,
                  requestedVersion,
                ),
              }),
            );

            initialized = true;
            clearTimeout(initTimer);
            connRef = conn;
            writeStderrLine(
              `qwen serve: /acp WS established ${conn.connectionId.slice(0, 8)} (loopback=${fromLoopback}, active=${activeMount.registry.size})`,
            );
            // Plan C (issue #5626): register this connection as the active CDP
            // bridge eagerly so a `/cdp` puppeteer client can bind immediately
            // (otherwise the extension never surfaces as the bridge until it
            // sends a `cdp_*` frame, which it won't until attached — a deadlock).
            // Gate on `clientInfo.name`: web UI / Zed agents share this `/acp`
            // endpoint, and an un-gated last-writer-wins would let an agent steal
            // the bridge with `cdp_*` frames it can't answer.
            const clientName =
              message.params &&
              typeof message.params === 'object' &&
              !Array.isArray(message.params)
                ? (
                    (message.params as Record<string, unknown>)[
                      'clientInfo'
                    ] as { name?: string } | undefined
                  )?.name
                : undefined;
            if (
              opts.cdpTunnelOverWs === true &&
              opts.cdpTunnelRegistry !== undefined &&
              clientName === CDP_BRIDGE_CLIENT_NAME
            ) {
              cdpEndpoint = {
                connectionId: conn.connectionId,
                send: (frame: CdpOutboundFrame) =>
                  safeWsSend(ws, JSON.stringify(frame), 'CDP'),
                routeInbound: () => false,
              };
              cdpBridgeUnregister =
                opts.cdpTunnelRegistry.register(cdpEndpoint);
              activeMount.ensureChromeDevToolsMcpRegistered(
                localPort,
                conn.connectionId,
              );
              writeStderrLine(
                `qwen serve: /acp connection ${conn.connectionId.slice(0, 8)} registered as CDP bridge`,
              );
            }
            return;
          }

          // Subsequent messages
          const conn = connRef;
          if (!conn || conn.destroyed) {
            ws.send(
              JSON.stringify(
                rpcError(null, RPC.INTERNAL_ERROR, 'Connection lost'),
              ),
            );
            ws.close(1011, 'Connection lost');
            return;
          }

          // Lazy session stream attachment for WS
          if (
            isRequest(message) &&
            message.params &&
            typeof message.params === 'object'
          ) {
            const sid = (message.params as Record<string, unknown>)[
              'sessionId'
            ];
            if (typeof sid === 'string' && conn.ownsSession(sid)) {
              const binding = conn.sessions.get(sid);
              if (
                binding &&
                !binding.stream &&
                conn.connStream &&
                !conn.connStream.isClosed
              ) {
                const ac = new AbortController();
                conn.attachSessionStream(sid, conn.connStream, ac);
                const myAbort = ac;
                const cleanupSession = () => {
                  const b = conn.sessions.get(sid);
                  if (b?.stream === conn.connStream && b?.abort === myAbort) {
                    conn.closeSessionStream(sid);
                  }
                };
                void activeMount.dispatcher
                  .pumpSessionEvents(conn, sid, ac.signal)
                  .then(cleanupSession, (err: unknown) => {
                    writeStderrLine(
                      `qwen serve: /acp WS pump error (${sid}): ${err instanceof Error ? err.message : String(err)}`,
                    );
                    cleanupSession();
                  });
              }
            }
          }

          if (opts.checkRate && isRequest(message)) {
            const m = message.method;
            if (WS_EXEMPT_METHODS.has(m)) {
              // Heartbeat + metadata update: exempt from rate limiting
              // (mirrors REST resolveTier returning null for heartbeat)
            } else {
              const tier: RateLimitTier =
                m === 'session/prompt' || m === '_qwen/session/prompt'
                  ? 'prompt'
                  : WS_READ_METHODS.has(m)
                    ? 'read'
                    : 'mutation';
              if (!opts.checkRate(wsKey, tier)) {
                ws.send(
                  JSON.stringify(
                    rpcError(
                      message.id,
                      RPC.INTERNAL_ERROR,
                      'Rate limit exceeded',
                    ),
                  ),
                );
                return;
              }
            }
          }

          // Prompt is long-running (minutes); awaiting it would block
          // permission votes and cancel requests queued behind it → deadlock.
          // Fire-and-forget so the message queue stays unblocked.
          const isPrompt =
            isRequest(message) &&
            (message.method === 'session/prompt' ||
              message.method === '_qwen/session/prompt');
          const dispatchP = activeMount.dispatcher
            .handle(conn, message, undefined, fromLoopback)
            .catch((err: unknown) => {
              writeStderrLine(
                `qwen serve: /acp WS handle error: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          if (!isPrompt) await dispatchP;
        }
      });
    };
    httpServer.on('upgrade', upgradeListener!);

    writeStderrLine(`qwen serve: /acp WebSocket transport enabled on ${path}`);
  }

  return {
    dispose: () => {
      if (upgradeServer && upgradeListener) {
        upgradeServer.removeListener('upgrade', upgradeListener);
        upgradeListener = undefined;
        upgradeServer = undefined;
      }
      registry.dispose();
      // Phase 4: dispose every non-primary runtime's ACP connection registry too,
      // so their sweep timers + live connections are torn down on shutdown.
      for (const mount of secondaryMounts.values()) {
        mount.registry.dispose();
      }
      if (wss) {
        wss.close();
        wss = undefined;
      }
    },
    registry,
    attachServer(server: import('node:http').Server) {
      setupWebSocket(server);
    },
  };
}

function headerOf(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * True when the request's KERNEL-stamped peer address is loopback. Mirrors
 * the REST surface's `detectFromLoopback` (NOT derived from forgeable
 * headers like `X-Forwarded-For`). Replicated here rather than imported
 * from `server.ts` to avoid a server↔acp-http import cycle.
 */
function isLoopbackSocket(socket: Duplex): boolean {
  const addr = (socket as unknown as { remoteAddress?: string }).remoteAddress;
  if (typeof addr !== 'string') return false;
  return (
    addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.')
  );
}

function isLoopbackReq(req: Request): boolean {
  const addr = req.socket?.remoteAddress;
  if (typeof addr !== 'string') return false;
  // Match the REST surface's `detectFromLoopback`: the full 127.0.0.0/8
  // range + the IPv4-mapped block, not just three exact literals (a
  // container peer on 127.0.0.2 is legal loopback).
  return (
    addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.')
  );
}
