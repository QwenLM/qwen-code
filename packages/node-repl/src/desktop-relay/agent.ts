/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What one accepted connection on the relay's loopback port gets.
 *
 * Two kinds of client arrive on the same port, told apart by their first
 * bytes:
 *  - a browser (the Web Shell on this computer) speaking HTTP: `GET /status`,
 *    `POST /connect` (approved in a native dialog, then relayed over the
 *    daemon's reverse tool channel) and `POST /disconnect`;
 *  - an MCP client speaking newline-delimited JSON-RPC, which is what an SSH
 *    `RemoteForward` from a terminal session delivers. Its first `tools/call`
 *    is what asks for approval, so starting a remote session alone never pops
 *    a dialog.
 */

import type { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { WorkspaceSelector } from './acp-relay.js';
import {
  formatHttpResponse,
  looksLikeHttp,
  parseHttpRequest,
  type HttpRequest,
  type ParseResult,
} from './http.js';
import {
  errorReply,
  McpChildRelay,
  type ChildChannel,
  type JsonRpcId,
  type JsonRpcMessage,
} from './mcp-child-relay.js';

export type RelayRecordPhase =
  | 'connecting'
  | 'registering'
  | 'connected'
  | 'stopped'
  | 'failed';

/** What is kept on disk about the one relay that may be running. Never the token. */
export interface RelayRecord {
  pid: number | null;
  origin: string;
  daemonUrl: string;
  sessionId: string;
  phase: RelayRecordPhase;
  message?: string;
  updatedAt: string;
}

export interface ConnectRequest {
  daemonUrl: string;
  sessionId: string;
  token?: string;
  workspace?: WorkspaceSelector;
}

export interface AgentContext {
  port: number;
  version: string;
  /** This process; a record carrying it belongs to the relay about to start here. */
  pid: number;
  askConsent(message: string): Promise<boolean>;
  readRecord(): RelayRecord | undefined;
  writeRecord(record: RelayRecord): void;
  isAlive(pid: number): boolean;
  terminate(pid: number): void;
  /** Runs an approved relay until it ends. */
  startRelay(request: ConnectRequest, origin: string): Promise<void>;
  now?: () => Date;
}

export interface HttpOutcome {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Work that must start only after the response has been sent. */
  after?: () => Promise<void>;
}

const LIVE_PHASES: ReadonlySet<RelayRecordPhase> = new Set([
  'connecting',
  'registering',
  'connected',
]);
const KNOWN_PATHS = new Set(['/status', '/connect', '/disconnect']);

export function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    // Chrome asks a loopback server to opt in before a public page may call it.
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

function json(
  status: number,
  headers: Record<string, string>,
  body: unknown,
): HttpOutcome {
  return {
    status,
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function webOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.origin === value
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function boundedString(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** Returns the request, or the reason it cannot be one. */
export function parseConnectBody(body: string): ConnectRequest | string {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return 'body is not JSON';
  }
  if (value === null || typeof value !== 'object')
    return 'body is not an object';
  const input = value as Record<string, unknown>;
  if (!boundedString(input['daemonUrl'], 2048)) return 'daemonUrl is required';
  let daemon: URL;
  try {
    daemon = new URL(input['daemonUrl']);
  } catch {
    return 'daemonUrl is not a URL';
  }
  if (daemon.protocol !== 'http:' && daemon.protocol !== 'https:') {
    return 'daemonUrl must be http or https';
  }
  if (daemon.username || daemon.password) {
    return 'daemonUrl must not carry credentials';
  }
  if (!boundedString(input['sessionId'], 256)) return 'sessionId is required';
  const request: ConnectRequest = {
    daemonUrl: daemon.toString(),
    sessionId: input['sessionId'],
  };
  const token = input['token'];
  if (token !== undefined) {
    if (!boundedString(token, 4096)) return 'token must be a string';
    request.token = token;
  }
  const workspace = input['workspace'];
  if (workspace !== undefined) {
    const selector = workspace as { kind?: unknown; value?: unknown } | null;
    if (
      selector === null ||
      typeof selector !== 'object' ||
      (selector.kind !== 'id' && selector.kind !== 'cwd') ||
      !boundedString(selector.value, 4096)
    ) {
      return 'workspace must be { kind: "id" | "cwd", value }';
    }
    request.workspace = { kind: selector.kind, value: selector.value };
  }
  return request;
}

export function consentMessage(
  origin: string,
  request: ConnectRequest,
): string {
  const daemon = new URL(request.daemonUrl);
  const lines = [
    `${origin} asks to let a Qwen Code session on ${daemon.host} use this computer.`,
    '',
    'If you allow it, that session can run code on this computer with your permissions and see and control its screen, until you disconnect it or the session ends.',
  ];
  if (daemon.origin !== origin) {
    lines.push(
      '',
      `The page (${origin}) and the session (${daemon.origin}) are on different sites.`,
    );
  }
  lines.push('', `Session: ${request.sessionId}`);
  return lines.join('\n');
}

function currentRecord(ctx: AgentContext): RelayRecord | undefined {
  const record = ctx.readRecord();
  if (record === undefined) return undefined;
  // A relay that died without writing its end still reads as live on disk.
  if (
    LIVE_PHASES.has(record.phase) &&
    (record.pid === null || !ctx.isAlive(record.pid))
  ) {
    return { ...record, pid: null, phase: 'stopped' };
  }
  return record;
}

export async function handleHttpRequest(
  request: HttpRequest,
  ctx: AgentContext,
): Promise<HttpOutcome> {
  // A rebound DNS name reaches this port with a foreign Host header; only the
  // loopback names are accepted, so a page cannot pose as same-origin.
  const host = request.headers['host'];
  if (host !== `127.0.0.1:${ctx.port}` && host !== `localhost:${ctx.port}`) {
    return json(421, {}, { ok: false, code: 'bad_host' });
  }
  const origin = webOrigin(request.headers['origin']);
  const cors = origin === undefined ? {} : corsHeaders(origin);
  const path = request.path.split('?')[0] ?? request.path;

  if (request.method === 'OPTIONS' && KNOWN_PATHS.has(path)) {
    return { status: 204, headers: cors, body: '' };
  }
  const now = (ctx.now?.() ?? new Date()).toISOString();

  if (request.method === 'GET' && path === '/status') {
    const record = currentRecord(ctx);
    // Only the page that started a relay learns what it is connected to.
    const visible =
      record !== undefined && origin !== undefined && record.origin === origin;
    return json(200, cors, {
      ok: true,
      version: ctx.version,
      ...(visible
        ? {
            active: {
              sessionId: record.sessionId,
              daemonUrl: record.daemonUrl,
              phase: record.phase,
              ...(record.message === undefined
                ? {}
                : { message: record.message }),
            },
          }
        : {}),
    });
  }

  if (request.method === 'POST' && path === '/connect') {
    if (origin === undefined) {
      return json(403, cors, {
        ok: false,
        code: 'origin_required',
        message: 'Only a web page can ask for this computer.',
      });
    }
    const parsed = parseConnectBody(request.body);
    if (typeof parsed === 'string') {
      return json(400, cors, {
        ok: false,
        code: 'bad_request',
        message: parsed,
      });
    }
    if (!(await ctx.askConsent(consentMessage(origin, parsed)))) {
      return json(403, cors, { ok: false, code: 'denied' });
    }
    // One relay per computer: an approved connection replaces the previous one.
    const previous = ctx.readRecord();
    if (
      typeof previous?.pid === 'number' &&
      previous.pid !== ctx.pid &&
      ctx.isAlive(previous.pid)
    ) {
      ctx.terminate(previous.pid);
    }
    ctx.writeRecord({
      pid: ctx.pid,
      origin,
      daemonUrl: parsed.daemonUrl,
      sessionId: parsed.sessionId,
      phase: 'connecting',
      updatedAt: now,
    });
    return {
      ...json(202, cors, { ok: true }),
      after: () => ctx.startRelay(parsed, origin),
    };
  }

  if (request.method === 'POST' && path === '/disconnect') {
    const record = ctx.readRecord();
    if (
      origin === undefined ||
      record === undefined ||
      record.origin !== origin
    ) {
      return json(409, cors, { ok: false, code: 'not_connected' });
    }
    if (
      typeof record.pid === 'number' &&
      record.pid !== ctx.pid &&
      ctx.isAlive(record.pid)
    ) {
      ctx.terminate(record.pid);
    }
    ctx.writeRecord({
      pid: null,
      origin: record.origin,
      daemonUrl: record.daemonUrl,
      sessionId: record.sessionId,
      phase: 'stopped',
      updatedAt: now,
    });
    return json(200, cors, { ok: true });
  }

  return json(404, cors, { ok: false, code: 'not_found' });
}

export interface RawMcpDeps {
  spawnChild(): ChildChannel;
  askConsent(message: string): Promise<boolean>;
  notify(message: string): Promise<void>;
}

export const RAW_CONSENT_MESSAGE = [
  'A Qwen Code session connected to this computer through an SSH tunnel or another local connection wants to use it.',
  '',
  'If you allow it, that session can run code on this computer with your permissions and see and control its screen, until the connection closes.',
].join('\n');

function isToolsCall(
  message: unknown,
): message is JsonRpcMessage & { id: JsonRpcId } {
  if (message === null || typeof message !== 'object') return false;
  const { method, id } = message as JsonRpcMessage;
  return (
    method === 'tools/call' &&
    (typeof id === 'string' || typeof id === 'number')
  );
}

/** Serves node_repl over a raw JSON-RPC stream until either side closes. */
export function serveRawMcp(
  socket: Duplex,
  initial: Buffer,
  deps: RawMcpDeps,
): Promise<void> {
  return new Promise((resolve) => {
    const child = deps.spawnChild();
    const relay = new McpChildRelay(child);
    const decoder = new StringDecoder('utf8');
    let consent: Promise<boolean> | undefined;
    let pendingText = '';
    let closed = false;

    const write = (reply: JsonRpcMessage) => {
      if (!closed) socket.write(`${JSON.stringify(reply)}\n`);
    };
    const finish = () => {
      if (closed) return;
      closed = true;
      relay.close();
      socket.destroy();
      resolve();
    };
    const handleLine = async (line: string) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      // Only tools/call runs code; the handshake and discovery need no approval.
      if (isToolsCall(message)) {
        consent ??= deps.askConsent(RAW_CONSENT_MESSAGE).then((allowed) => {
          if (allowed) {
            void deps.notify('A Qwen Code session is now using this computer.');
          }
          return allowed;
        });
        if (!(await consent)) {
          write(
            errorReply(
              message.id,
              -32001,
              'The person at this computer declined remote use of it.',
            ),
          );
          return;
        }
      }
      const reply = await relay.handle(message);
      if (reply !== undefined) write(reply);
    };
    const onText = (text: string) => {
      pendingText += text;
      let newline = pendingText.indexOf('\n');
      while (newline >= 0) {
        const line = pendingText.slice(0, newline).trim();
        pendingText = pendingText.slice(newline + 1);
        if (line) void handleLine(line);
        newline = pendingText.indexOf('\n');
      }
    };

    child.onExit(() => finish());
    socket.on('error', () => undefined);
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('data', (chunk: Buffer) => onText(decoder.write(chunk)));
    onText(decoder.write(initial));
  });
}

export interface ConnectionDeps {
  http: AgentContext;
  raw: RawMcpDeps;
  readTimeoutMs?: number;
}

/** Serves one accepted connection: sniffs the protocol, then dispatches. */
export function serveConnection(
  socket: Duplex,
  deps: ConnectionDeps,
): Promise<void> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let mode: 'sniffing' | 'http' | 'dispatched' = 'sniffing';
    const timer = setTimeout(() => {
      if (mode === 'dispatched') return;
      mode = 'dispatched';
      socket.destroy();
      resolve();
    }, deps.readTimeoutMs ?? 10_000);

    const dispatchHttp = async (parsed: ParseResult) => {
      if (parsed.kind === 'invalid') {
        socket.end(
          formatHttpResponse(
            400,
            { 'content-type': 'application/json' },
            JSON.stringify({
              ok: false,
              code: 'bad_request',
              message: parsed.reason,
            }),
          ),
        );
        return;
      }
      if (parsed.kind !== 'complete') return;
      let outcome: HttpOutcome;
      try {
        outcome = await handleHttpRequest(parsed.request, deps.http);
      } catch (error) {
        outcome = json(
          500,
          {},
          {
            ok: false,
            code: 'internal',
            message: error instanceof Error ? error.message : String(error),
          },
        );
      }
      socket.end(
        formatHttpResponse(outcome.status, outcome.headers, outcome.body),
      );
      await outcome.after?.();
    };

    const onData = (chunk: Buffer) => {
      if (mode === 'dispatched') return;
      buffer = Buffer.concat([buffer, chunk]);
      if (mode === 'sniffing') {
        const start = buffer.toString('latin1').trimStart();
        if (start.startsWith('{')) {
          mode = 'dispatched';
          clearTimeout(timer);
          socket.off('data', onData);
          void serveRawMcp(socket, buffer, deps.raw).then(resolve);
          return;
        }
        if (buffer.length < 8 && !buffer.includes(0x0a)) return;
        if (!looksLikeHttp(buffer)) {
          mode = 'dispatched';
          clearTimeout(timer);
          socket.destroy();
          resolve();
          return;
        }
        mode = 'http';
      }
      const parsed = parseHttpRequest(buffer);
      if (parsed.kind === 'incomplete') return;
      mode = 'dispatched';
      clearTimeout(timer);
      socket.off('data', onData);
      void dispatchHttp(parsed).then(resolve);
    };

    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (mode === 'dispatched') return;
      mode = 'dispatched';
      clearTimeout(timer);
      resolve();
    });
    socket.on('data', onData);
  });
}
