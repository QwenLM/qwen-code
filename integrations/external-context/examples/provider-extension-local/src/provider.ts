/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContextItem } from './profile.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;

export class ProviderConfigurationError extends Error {}

export function validateProviderConfiguration(): void {
  readProviderConfiguration();
}

export async function searchProvider(input: {
  query: string;
  signal: AbortSignal;
}): Promise<readonly ContextItem[]> {
  const { baseUrl, token } = readProviderConfiguration();
  const response = await fetch(new URL('/v1/context/search', baseUrl), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query: input.query, limit: 5 }),
    redirect: 'manual',
    signal: input.signal,
  });

  if (!response.ok || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Provider request failed.');
  }

  const parsed = JSON.parse(await readBoundedBody(response)) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed['items'])) {
    throw new Error('Provider response is invalid.');
  }
  return parsed['items']
    .map(parseItem)
    .filter((item): item is ContextItem => item !== undefined)
    .slice(0, 5);
}

function readProviderConfiguration(): { baseUrl: URL; token: string } {
  return {
    baseUrl: readBaseUrl(),
    token: readRequiredEnvironment('PROVIDER_CONTEXT_TOKEN'),
  };
}

function readBaseUrl(): URL {
  const value = readRequiredEnvironment('PROVIDER_CONTEXT_BASE_URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderConfigurationError('Provider configuration is invalid.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderConfigurationError('Provider configuration is invalid.');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new ProviderConfigurationError('Provider configuration is invalid.');
  }
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && loopback.has(url.hostname))
  ) {
    throw new ProviderConfigurationError('Provider configuration is invalid.');
  }
  return url;
}

function readRequiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value || value === '${' + name + '}') {
    throw new ProviderConfigurationError(
      'Provider configuration is unavailable.',
    );
  }
  return value;
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    Number.parseInt(declaredLength, 10) > MAX_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Provider response is invalid.');
  }
  if (!response.body) throw new Error('Provider response is invalid.');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Provider response is invalid.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}

function parseItem(value: unknown): ContextItem | undefined {
  if (!isRecord(value)) return undefined;
  const id = value['id'];
  const content = value['content'];
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof content !== 'string' ||
    content.length === 0
  ) {
    return undefined;
  }

  const item: ContextItem = { id, content };
  if (typeof value['title'] === 'string') item.title = value['title'];
  if (typeof value['uri'] === 'string') item.uri = value['uri'];
  if (typeof value['score'] === 'number' && Number.isFinite(value['score'])) {
    item.score = value['score'];
  }
  const updatedAt = value['updated_at'] ?? value['updatedAt'];
  if (typeof updatedAt === 'string') item.updatedAt = updatedAt;
  return item;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
