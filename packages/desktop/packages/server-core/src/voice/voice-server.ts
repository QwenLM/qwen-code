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
): void {
  for (const client of wss.clients) {
    try {
      client.terminate();
    } catch {
      // ignore
    }
  }
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
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();

    terminateVoiceClients(wss);
    httpServer.closeAllConnections?.();
    wss.close();
    httpServer.close(finish);
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
              terminateVoiceClients(wss);
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
    if (url.pathname !== '/voice/stream') {
      log?.warn('voice: rejected upgrade for path:', url.pathname);
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (options.isEnabled && !options.isEnabled()) {
      log?.warn('voice: rejected upgrade while disabled');
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!isAllowedVoiceOrigin(req.headers.origin, options.allowedOrigins)) {
      log?.warn('voice: rejected upgrade with origin:', req.headers.origin);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!tokenMatches(url.searchParams.get('token'), options.token)) {
      log?.warn('voice: rejected upgrade with invalid token');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
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
        closePromise = closeVoiceServerResources(httpServer, wss);
      }
      return closePromise;
    },
  };
}
