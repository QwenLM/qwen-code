/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal JSON-RPC 2.0 helpers for the ACP-over-HTTP transport
 * (`packages/cli/src/serve/acp-http/`). The official ACP Streamable HTTP
 * transport (RFD #721) frames every message as a JSON-RPC 2.0 object;
 * this module owns the wire types + parse/validate/serialize so the
 * dispatcher stays focused on bridge routing.
 *
 * We hand-roll framing (rather than reuse `@agentclientprotocol/sdk`'s
 * `ndJsonStream`) because the RFD splits a single logical connection
 * across multiple long-lived SSE streams (connection-scoped + one per
 * session), so outbound frames must be demultiplexed to the right
 * stream — something a single duplex `Connection` can't express.
 */

/**
 * Vendor extension namespace. ACP reserves any `_`-prefixed method for
 * extensions (the ONLY hard rule); the spec's `_zed.dev/…` example shows a
 * domain-style segment by convention, but `qwen` is distinctive enough that
 * we use the shorter bare form `_qwen/…`. Vendor data on standard messages
 * goes under `_meta` keyed by the same name (`_meta: { "qwen": … }`).
 */
export const QWEN_METHOD_NS = '_qwen/';
/** Key for vendor `_meta` blocks (capabilities + per-message data). */
export const QWEN_META_KEY = 'qwen';

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcOutbound = JsonRpcRequest | JsonRpcNotification;
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;
export type JsonRpcInbound =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

/** Standard JSON-RPC 2.0 error codes. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isRequest(m: unknown): m is JsonRpcRequest {
  return (
    isObject(m) &&
    m['jsonrpc'] === '2.0' &&
    typeof m['method'] === 'string' &&
    'id' in m &&
    m['id'] !== null &&
    (typeof m['id'] === 'number' || typeof m['id'] === 'string')
  );
}

export function isNotification(m: unknown): m is JsonRpcNotification {
  return (
    isObject(m) &&
    m['jsonrpc'] === '2.0' &&
    typeof m['method'] === 'string' &&
    !('id' in m)
  );
}

export function isResponse(m: unknown): m is JsonRpcResponse {
  return (
    isObject(m) &&
    m['jsonrpc'] === '2.0' &&
    !('method' in m) &&
    'id' in m &&
    // JSON-RPC 2.0 §5: EXACTLY one of result/error (XOR). Accepting both
    // would let a buggy client's approval (result + error) be misread as a
    // cancellation by the `'error' in msg` check downstream. A dual-field
    // message therefore fails isRequest/isNotification/isResponse →
    // `parseInbound` rejects it → the POST handler returns 400 (logged by the
    // malformed-request path in index.ts), so the client is told its vote was
    // not accepted (not a silent drop); it can retry with a valid response,
    // and teardown still releases the pending entry if it doesn't.
    'result' in m !== 'error' in m
  );
}

const LOG_SAFE_RE = new RegExp(
  String.raw`[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]`,
  'g',
);

/**
 * Strip terminal control chars from values interpolated into operator-facing
 * stderr logs, so a client-controlled `sessionId`/`method`/error string can't
 * forge or split log lines (log injection). Shared by the transport modules.
 */
export function logSafe(s: string): string {
  return s.replace(LOG_SAFE_RE, ' ');
}

export function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

export function error(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

export function notification(
  method: string,
  params: unknown,
): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params };
}

export function request(
  id: JsonRpcId,
  method: string,
  params: unknown,
): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params };
}

/**
 * Parse a request body into a JSON-RPC message. Returns `{ ok: false }`
 * with a ready-to-send error on malformed JSON or a non-conforming
 * envelope (batch arrays are rejected per RFD §"batch → 501", surfaced
 * here as INVALID_REQUEST since we never reach the 501 path).
 */
export function parseInbound(
  raw: unknown,
): { ok: true; message: JsonRpcInbound } | { ok: false; error: JsonRpcError } {
  if (Array.isArray(raw)) {
    return {
      ok: false,
      error: error(null, RPC.INVALID_REQUEST, 'JSON-RPC batch not supported'),
    };
  }
  if (isRequest(raw) || isNotification(raw) || isResponse(raw)) {
    return { ok: true, message: raw };
  }
  return {
    ok: false,
    error: error(null, RPC.INVALID_REQUEST, 'Malformed JSON-RPC message'),
  };
}
