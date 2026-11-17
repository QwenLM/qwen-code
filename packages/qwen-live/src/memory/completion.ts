/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MemoryConnection } from './config.js';

export function resolveCompletionConnection(
  shared: MemoryConnection,
  settings: { baseUrl: string; apiKeyEnv: string },
): MemoryConnection {
  if (!settings.baseUrl) return shared;
  const apiKey = settings.apiKeyEnv
    ? process.env[settings.apiKeyEnv]
    : shared.apiKey;
  return { baseUrl: settings.baseUrl, ...(apiKey ? { apiKey } : {}) };
}

export class MemoryCompletionError extends Error {
  constructor(readonly status?: number) {
    super(
      status
        ? `Memory completion HTTP ${status}`
        : 'Invalid memory completion response',
    );
    this.name = 'MemoryCompletionError';
  }
}

export function completionFailureDetails(
  error: unknown,
): Record<string, unknown> {
  return {
    kind: error instanceof Error ? error.name : 'unknown',
    ...(error instanceof MemoryCompletionError && error.status !== undefined
      ? { status: error.status }
      : {}),
  };
}

export async function complete(
  connection: MemoryConnection,
  body: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetcher(
        `${connection.baseUrl.replace(/\/$/u, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(connection.apiKey
              ? { Authorization: `Bearer ${connection.apiKey}` }
              : {}),
          },
          body: JSON.stringify(body),
          signal: combined,
        },
      );
    } catch (error) {
      if (attempt === 0 && !combined.aborted) continue;
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (
        attempt === 0 &&
        (response.status === 429 || response.status >= 500) &&
        !combined.aborted
      )
        continue;
      throw new MemoryCompletionError(response.status);
    }
    break;
  }
  if (!response?.body) throw new MemoryCompletionError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > 1_048_576) {
      await reader.cancel();
      throw new MemoryCompletionError();
    }
    chunks.push(item.value);
  }
  const decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!isRecord(decoded) || !Array.isArray(decoded['choices']))
    throw new MemoryCompletionError();
  const first: unknown = decoded['choices'][0];
  const message = isRecord(first) ? first['message'] : undefined;
  return isRecord(message) && typeof message['content'] === 'string'
    ? message['content']
    : '';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
