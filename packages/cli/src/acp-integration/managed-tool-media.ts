/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { hasBoundedJsonStructure } from '@qwen-code/acp-bridge/ndJsonStream';
import { DAEMON_ACP_NDJSON_LIMITS } from '@qwen-code/acp-bridge/spawnChannel';

// Leave room for the JSON-RPC/HTTP envelopes without changing ACP capacity.
export const MAX_MANAGED_MEDIA_RESPONSE_BYTES =
  DAEMON_ACP_NDJSON_LIMITS.maxFrameBytes - 64 * 1024;

export function isManagedMediaOperation(
  operation: string,
): operation is 'execute' | 'status' | 'cancel' {
  return (
    operation === 'execute' || operation === 'status' || operation === 'cancel'
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isBase64(data: string): boolean {
  if (data.length % 4 !== 0) return false;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const body = data.slice(0, data.length - padding);
  if (/[^A-Za-z0-9+/]/.test(body)) return false;
  if (padding === 0) return true;
  const last =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(
      body.at(-1)!,
    );
  return padding === 2 ? (last & 15) === 0 : (last & 3) === 0;
}

/** Validate the actual wire projection before sending it to the bounded ACP pipe. */
export function managedToolResponseMediaBytes(
  result: unknown,
  operation: 'execute' | 'status' | 'cancel',
): number {
  const json = JSON.stringify(result);
  if (
    json === undefined ||
    Buffer.byteLength(json) > MAX_MANAGED_MEDIA_RESPONSE_BYTES
  ) {
    throw new Error('Managed Runtime media response exceeded its size limit.');
  }
  // Native results may contain undefined optional fields; JSON omits them.
  const wire: unknown = JSON.parse(json);
  if (!hasBoundedJsonStructure({ jsonrpc: '2.0', id: '0', result: wire })) {
    throw new Error(
      'Managed Runtime media response exceeded ACP structure limits.',
    );
  }
  const status = record(wire);
  if (operation !== 'execute' && status?.['state'] !== 'settled') return 0;
  const execution =
    operation === 'execute' ? status : record(status?.['result']);
  if (
    !['not_started', 'success', 'error', 'cancelled'].includes(
      String(execution?.['executionStatus']),
    )
  )
    return 0;
  const content = record(execution?.['result'])?.['llmContent'];
  const parts = Array.isArray(content) ? content : [content];
  let mediaBytes = 0;
  for (const part of parts) {
    const object = record(part);
    if (!object || !Object.hasOwn(object, 'inlineData')) continue;
    const inline = record(object['inlineData']);
    if (
      !inline ||
      typeof inline['data'] !== 'string' ||
      typeof inline['mimeType'] !== 'string' ||
      !/^(?:(?:image|audio|video)\/[a-z0-9.+-]+|application\/pdf)$/i.test(
        inline['mimeType'],
      ) ||
      !isBase64(inline['data'])
    ) {
      throw new Error('Managed Runtime returned invalid inline media.');
    }
    mediaBytes += inline['data'].length;
  }
  return mediaBytes;
}
