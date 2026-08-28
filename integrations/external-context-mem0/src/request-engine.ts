/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildSearchUrl } from './config.js';
import type {
  DialectV1,
  ExternalContextItem,
  RuntimeConfiguration,
  ScopeLocation,
  SearchProvider,
} from './types.js';

const MAX_RESULTS = 5;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function createRequestEngine(
  runtime: RuntimeConfiguration,
  fetcher: FetchLike = fetch,
): SearchProvider {
  return async ({ query, signal }) => {
    const url = buildSearchUrl(runtime.instance, runtime.dialect);
    const headers = new Headers({ accept: 'application/json' });
    applyAuthentication(headers, runtime);
    const body = buildRequest(url, runtime, query);
    if (body !== undefined) headers.set('content-type', 'application/json');

    const response = await fetcher(url, {
      method: runtime.dialect.search.method,
      headers,
      body,
      redirect: 'manual',
      signal,
    });
    if (!response.ok || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Provider request failed.');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await readBoundedBody(response)) as unknown;
    } catch {
      throw new Error('Provider response is invalid.');
    }
    return normalizeResponse(payload, runtime.dialect);
  };
}

function applyAuthentication(
  headers: Headers,
  runtime: RuntimeConfiguration,
): void {
  switch (runtime.dialect.auth) {
    case 'authorization-token':
      headers.set('authorization', `Token ${runtime.credential}`);
      break;
    case 'authorization-bearer':
      headers.set('authorization', `Bearer ${runtime.credential}`);
      break;
    case 'x-api-key':
      headers.set('x-api-key', runtime.credential);
      break;
    default:
      throw new Error('Provider authentication is invalid.');
  }
}

function buildRequest(
  url: URL,
  runtime: RuntimeConfiguration,
  query: string,
): string | undefined {
  const body: Record<string, unknown> = {};
  placeValue(url, body, runtime.dialect.search.queryLocation, 'query', query);
  placeValue(
    url,
    body,
    runtime.dialect.search.userIdLocation,
    'user_id',
    runtime.instance.scope.userId,
  );
  placeValue(
    url,
    body,
    runtime.dialect.search.agentIdLocation,
    'agent_id',
    runtime.instance.scope.agentId,
  );
  placeValue(
    url,
    body,
    runtime.dialect.search.appIdLocation,
    'app_id',
    runtime.instance.scope.appId,
  );
  if (runtime.dialect.search.limitField !== 'omit') {
    placeMethodValue(
      url,
      body,
      runtime.dialect,
      runtime.dialect.search.limitField,
      MAX_RESULTS,
    );
  }
  if (runtime.dialect.search.threshold !== undefined) {
    placeMethodValue(
      url,
      body,
      runtime.dialect,
      'threshold',
      runtime.dialect.search.threshold,
    );
  }
  if (runtime.dialect.search.rerank !== undefined) {
    placeMethodValue(
      url,
      body,
      runtime.dialect,
      'rerank',
      runtime.dialect.search.rerank,
    );
  }
  return runtime.dialect.search.method === 'POST'
    ? JSON.stringify(body)
    : undefined;
}

function placeMethodValue(
  url: URL,
  body: Record<string, unknown>,
  dialect: DialectV1,
  name: string,
  value: string | number | boolean,
): void {
  if (dialect.search.method === 'GET') {
    url.searchParams.set(name, String(value));
  } else {
    body[name] = value;
  }
}

function placeValue(
  url: URL,
  body: Record<string, unknown>,
  location: ScopeLocation | 'json' | 'query',
  name: string,
  value: string | undefined,
): void {
  if (location === 'omit') return;
  if (value === undefined) throw new Error('Provider request is invalid.');
  if (location === 'query') {
    url.searchParams.set(name, value);
    return;
  }
  if (location === 'json') {
    body[name] = value;
    return;
  }
  const filters = (body['filters'] ??= {}) as Record<string, unknown>;
  filters[name] = value;
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (Number.isFinite(bytes) && bytes > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Provider response is invalid.');
    }
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

function normalizeResponse(
  value: unknown,
  dialect: DialectV1,
): readonly ExternalContextItem[] {
  const collection = readCollection(value, dialect);
  return collection
    .map((item) => parseItem(item, dialect))
    .filter((item): item is ExternalContextItem => item !== undefined)
    .slice(0, MAX_RESULTS);
}

function readCollection(value: unknown, dialect: DialectV1): unknown[] {
  if (dialect.response.collection === 'root-array') {
    if (!Array.isArray(value)) throw new Error('Provider response is invalid.');
    return value;
  }
  if (!isRecord(value) || !Array.isArray(value['results'])) {
    throw new Error('Provider response is invalid.');
  }
  return value['results'];
}

function parseItem(
  value: unknown,
  dialect: DialectV1,
): ExternalContextItem | undefined {
  if (!isRecord(value)) return undefined;
  const id = value[dialect.response.idField];
  const content = value[dialect.response.contentField];
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof content !== 'string' ||
    content.length === 0
  ) {
    return undefined;
  }

  const item: ExternalContextItem = { id, content };
  copyStringField(value, item, dialect.response.titleField, 'title');
  copyStringField(value, item, dialect.response.uriField, 'uri');
  copyStringField(value, item, dialect.response.updatedAtField, 'updatedAt');
  if (dialect.response.scoreField !== 'omit') {
    const score = value[dialect.response.scoreField];
    if (typeof score === 'number' && Number.isFinite(score)) item.score = score;
  }
  return item;
}

function copyStringField(
  source: Record<string, unknown>,
  target: ExternalContextItem,
  sourceField: 'title' | 'uri' | 'updated_at' | 'updatedAt' | 'omit',
  targetField: 'title' | 'uri' | 'updatedAt',
): void {
  if (sourceField === 'omit') return;
  const value = source[sourceField];
  if (typeof value === 'string' && value.length > 0) {
    target[targetField] = value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
