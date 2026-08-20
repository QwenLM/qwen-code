/**
 * Standalone loopback WebSocket server for voice dictation.
 *
 * Runs separately from the main RPC `WsRpcServer` so raw PCM streaming never
 * touches the RPC envelope/handshake protocol. Binds to 127.0.0.1 on a random
 * port and authenticates with a voice-scoped token (passed in the `?token=`
 * query, since a browser/renderer WebSocket cannot set an Authorization header).
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import type { Logger } from '../runtime/platform';
import {
  createVoiceConnectionHandler,
  type VoiceHandlerDeps,
} from './voice-ws-handler';

const VOICE_MAX_PAYLOAD_BYTES = 20 * 1024 * 1024;
const CLOSE_TIMEOUT_MS = 3000;
const DISABLED_CLOSE_GRACE_MS = 500;
// On shutdown, give clients this long to honor the graceful WS close (flushing
// any buffered `final` transcript) before force-terminating stragglers.
const SHUTDOWN_GRACE_MS = 500;

export interface VoiceServerOptions extends VoiceHandlerDeps {
  /** Voice-scoped token validated per upgrade. */
  token: string;
  host?: string;
  allowedOrigins?: readonly string[];
  isEnabled?: () => boolean;
}

export interface VoiceServer {
  port: number;
  /** ws://<host>:<port>/voice/stream (token is appended by the caller). */
  url: string;
  close(): Promise<void>;
}

/** Constant-time token comparison (loopback, but cheap to do right). */
export function tokenMatches(
  provided: string | null,
  expected: string,
): boolean {
  if (provided == null) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface ClosableClient {
  close?(code?: number, reason?: string): void;
  terminate(): void;
}

interface ClosableWebSocketServer {
  clients: Iterable<ClosableClient>;
  close(): void;
}

interface ClosableHttpServer {
  close(callback?: () => void): void;
  closeAllConnections?: () => void;
}

/** Why an upgrade was rejected; drives both the HTTP status and the warn log. */
export type VoiceUpgradeRejectionReason =
  | 'bad-path'
  | 'disabled'
  | 'bad-origin'
  | 'bad-token';

export interface VoiceUpgradeRejection {
  status: number;
  statusText: string;
  reason: VoiceUpgradeRejectionReason;
}

/**
 * Decide whether a voice upgrade request must be rejected, in guard order
 * (path → token → disabled → origin). Returns `null` to allow the upgrade.
 * Pure so the guards are testable without going over the wire.
 *
 * The token check runs before `isEnabled` because `isEnabled` reads config from
 * disk (uncached); gating it behind auth stops an unauthenticated client from
 * triggering a disk read on every upgrade attempt.
 */
export function classifyVoiceUpgrade(args: {
  pathname: string;
  token: string | null;
  origin: string | undefined;
  expectedToken: string;
  isEnabled?: () => boolean;
  allowedOrigins?: readonly string[];
}): VoiceUpgradeRejection | null {
  if (args.pathname !== '/voice/stream') {
    return { status: 404, statusText: 'Not Found', reason: 'bad-path' };
  }
  if (!tokenMatches(args.token, args.expectedToken)) {
    return { status: 401, statusText: 'Unauthorized', reason: 'bad-token' };
  }
  if (args.isEnabled && !args.isEnabled()) {
    return { status: 403, statusText: 'Forbidden', reason: 'disabled' };
  }
  if (!isAllowedVoiceOrigin(args.origin, args.allowedOrigins)) {
    return { status: 403, statusText: 'Forbidden', reason: 'bad-origin' };
  }
  return null;
}

export function isAllowedVoiceOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[] = [],
): boolean {
  // `file://` is the packaged Electron renderer's origin. No custom app scheme
  // (e.g. `qwen://`) is registered anywhere, so accepting one would only let an
  // unregistered same-machine scheme pass origin validation — keep it out as
  // defense-in-depth alongside the loopback bind + voice token.
  return (
    !origin ||
    origin.startsWith('file://') ||
    allowedOrigins.includes(origin)
  );
}

export function terminateVoiceClients(
  wss: Pick<ClosableWebSocketServer, 'clients'>,
): number {
  let terminated = 0;
  for (const client of wss.clients) {
    try {
      client.terminate();
      terminated++;
    } catch {
      // ignore
    }
  }
  return terminated;
}

/**
 * Force-terminate clients that ignored the disabled-grace close, logging how
 * many stragglers were dropped — observability parity with the shutdown path.
 */
export function terminateDisabledVoiceClients(
  wss: Pick<ClosableWebSocketServer, 'clients'>,
  log?: Logger,
): number {
  const terminated = terminateVoiceClients(wss);
  if (terminated > 0) {
    log?.warn(
      `voice: force-terminated ${terminated} straggling client(s) after disable-grace period`,
    );
  }
  return terminated;
}

export function closeVoiceClients(
  wss: Pick<ClosableWebSocketServer, 'clients'>,
  code = 1000,
  reason = 'voice disabled',
): number {
  let closed = 0;
  for (const client of wss.clients) {
    try {
      client.close?.(code, reason);
      closed++;
    } catch {
      // ignore
    }
  }
  return closed;
}

export function closeVoiceServerResources(
  httpServer: ClosableHttpServer,
  wss: ClosableWebSocketServer,
  timeoutMs = CLOSE_TIMEOUT_MS,
  graceMs = SHUTDOWN_GRACE_MS,
  log?: Logger,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      clearTimeout(deadline);
      log?.info('voice: stream server shutdown complete');
      resolve();
    };

    let tornDown = false;
    const teardown = () => {
      if (tornDown) return;
      tornDown = true;
      // RST any client that ignored the graceful close, then drop the servers.
      // closeAllConnections lets httpServer.close actually complete.
      const terminated = terminateVoiceClients(wss);
      if (terminated > 0) {
        log?.warn(
          `voice: force-terminated ${terminated} straggling client(s) after grace period`,
        );
      }
      httpServer.closeAllConnections?.();
      wss.close();
      httpServer.close(finish);
    };

    // Graceful first: a WS close frame flushes any buffered `final` transcript
    // and lets the renderer observe a clean close instead of a TCP reset (a bare
    // terminate would drop an in-flight transcript on quit).
    const closed = closeVoiceClients(wss, 1001, 'server shutting down');
    log?.info(`voice: shutting down stream server (${closed} active client(s))`);
    // After a short grace period, force-terminate stragglers and tear down.
    const graceTimer = setTimeout(teardown, Math.min(graceMs, timeoutMs));
    graceTimer.unref?.();
    // Absolute ceiling so app quit can never hang on a wedged close.
    const deadline = setTimeout(() => {
      teardown();
      finish();
    }, timeoutMs);
    deadline.unref?.();
  });
}

export async function startVoiceServer(
  options: VoiceServerOptions,
): Promise<VoiceServer> {
  const host = options.host ?? '127.0.0.1';
  const log: Logger | undefined = options.logger;

  const httpServer: HttpServer = createServer((_req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('Upgrade Required');
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: VOICE_MAX_PAYLOAD_BYTES,
  });
  const handle = createVoiceConnectionHandler(options);
  let disabledCloseTimer: ReturnType<typeof setTimeout> | undefined;
  const enabledTimer = options.isEnabled
    ? setInterval(() => {
        if (options.isEnabled?.()) {
          if (disabledCloseTimer) {
            clearTimeout(disabledCloseTimer);
            disabledCloseTimer = undefined;
          }
          return;
        }
        // Reached only when disabled (the guard above returns when enabled).
        if (disabledCloseTimer) return;
        const closed = closeVoiceClients(wss);
        if (closed > 0) {
          log?.info('voice: closing active clients because voice is disabled');
          disabledCloseTimer = setTimeout(() => {
            disabledCloseTimer = undefined;
            if (!options.isEnabled?.()) {
              terminateDisabledVoiceClients(wss, log);
            }
          }, DISABLED_CLOSE_GRACE_MS);
          disabledCloseTimer.unref?.();
        }
      }, 1000)
    : undefined;
  enabledTimer?.unref?.();

  httpServer.on('upgrade', (req, socket, head) => {
    // A raw socket error during the upgrade window would otherwise crash the
    // process with an unhandled 'error' event.
    socket.on('error', (err) => {
      log?.debug('voice: upgrade socket error:', err.message);
    });
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    const rejection = classifyVoiceUpgrade({
      pathname: url.pathname,
      token: url.searchParams.get('token'),
      origin: req.headers.origin,
      expectedToken: options.token,
      isEnabled: options.isEnabled,
      allowedOrigins: options.allowedOrigins,
    });
    if (rejection) {
      switch (rejection.reason) {
        case 'bad-path':
          log?.warn('voice: rejected upgrade for path:', url.pathname);
          break;
        case 'disabled':
          log?.warn('voice: rejected upgrade while disabled');
          break;
        case 'bad-origin':
          log?.warn('voice: rejected upgrade with origin:', req.headers.origin);
          break;
        case 'bad-token':
          log?.warn('voice: rejected upgrade with invalid token');
          break;
      }
      socket.write(
        `HTTP/1.1 ${rejection.status} ${rejection.statusText}\r\n\r\n`,
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handle(ws));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      httpServer.once('error', onError);
      httpServer.listen(0, host, () => {
        httpServer.removeListener('error', onError);
        httpServer.on('error', (err) => {
          log?.warn('voice: server error after listen:', err);
        });
        resolve();
      });
    });
  } catch (error) {
    if (enabledTimer) clearInterval(enabledTimer);
    clearTimeout(disabledCloseTimer);
    wss.close();
    throw error;
  }

  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  log?.info(`voice: stream server listening on ws://${host}:${port}/voice/stream`);

  // Idempotent close: terminate any open client so the http server can actually
  // finish closing, and reuse the same promise for repeated calls.
  let closePromise: Promise<void> | undefined;
  return {
    port,
    url: `ws://${host}:${port}/voice/stream`,
    close: () => {
      if (!closePromise) {
        if (enabledTimer) clearInterval(enabledTimer);
        clearTimeout(disabledCloseTimer);
        // Omit timeout/grace so the function's own defaults apply; only `log`
        // needs forwarding (passing the constants would silently drift if the
        // defaults ever changed).
        closePromise = closeVoiceServerResources(
          httpServer,
          wss,
          undefined,
          undefined,
          log,
        );
      }
      return closePromise;
    },
  };
}
