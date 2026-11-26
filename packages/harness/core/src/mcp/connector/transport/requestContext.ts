/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import {
  mcpModelContext,
  type McpModelInfo,
} from '../../tools/mcp-model-context.js';

/** Request-group context carried on stdio `tools/call` requests. */
export const MCP_REQUEST_CONTEXT_META_KEY = 'com.qoder/request-context-v1';

/**
 * Mirrors the HTTP `X-RequestSet-ID` header for headerless transports: every
 * stdio `tools/call` in a Qoder model context carries the parent request-group
 * id under `params._meta["com.qoder/request-context-v1"].requestSetId`.
 * Omitted when the active context has no request-set id. Existing `_meta` and
 * other fields in the context object are preserved.
 */
export function withRequestContextMeta(
  message: JSONRPCMessage,
  info: McpModelInfo | undefined,
): JSONRPCMessage {
  const requestSetId = info?.requestSetId;
  if (!requestSetId) return message;
  if (!('method' in message) || message.method !== 'tools/call') return message;
  if (!('id' in message)) return message;
  const params =
    'params' in message && message.params !== undefined
      ? message.params
      : ({} as Record<string, unknown>);
  const existingMeta = (params as { _meta?: unknown })._meta;
  const meta = isRecord(existingMeta) ? { ...existingMeta } : {};
  const existingContext = meta[MCP_REQUEST_CONTEXT_META_KEY];
  meta[MCP_REQUEST_CONTEXT_META_KEY] = {
    ...(isRecord(existingContext) ? existingContext : {}),
    requestSetId,
  };
  return {
    ...message,
    params: { ...params, _meta: meta },
  } as JSONRPCMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface RequestContextTransport {
  send(message: JSONRPCMessage, options?: unknown): Promise<void>;
}

/** Wraps a headerless transport so its tool calls carry the request context. */
export function withRequestContextMetaTransport<
  T extends RequestContextTransport,
>(transport: T): T {
  const send = transport.send.bind(transport);
  transport.send = (message, options) =>
    send(withRequestContextMeta(message, mcpModelContext.getStore()), options);
  return transport;
}
