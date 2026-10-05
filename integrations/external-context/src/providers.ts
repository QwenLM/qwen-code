/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ConfigurationError } from './config.js';
import {
  postJson,
  ProviderHttpStatusError,
  validateProviderBaseUrl,
} from './http-client.js';
import type {
  ExternalContextItem,
  ExternalContextProvider,
  ExternalMemoryWriter,
  DataworksBffMemoryConfig,
  GenericHttpProviderConfig,
  Mem0ProviderConfig,
  ProviderConfig,
  RememberResult,
} from './types.js';

const MEM0_BASE_URL = new URL('https://api.mem0.ai/');
const MAX_PROVIDER_ITEMS = 5;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFINITIVE_WRITE_REJECTION_STATUSES = new Set([400, 401, 403, 404]);

export function createProvider(
  config: ProviderConfig,
): ExternalContextProvider {
  switch (config.type) {
    case 'mem0-platform-v3':
      return new Mem0PlatformV3Adapter(config);
    case 'generic-http-search-v1':
      return new GenericHttpSearchV1Adapter(config);
    case 'dataworks-bff-memory-v1':
      return new DataworksBffMemoryAdapter(config);
    // no default
  }
}

export function createMemoryWriter(
  config: ProviderConfig,
): ExternalMemoryWriter | undefined {
  switch (config.type) {
    case 'mem0-platform-v3':
      return new Mem0PlatformV3Adapter(config);
    case 'generic-http-search-v1':
      return undefined;
    case 'dataworks-bff-memory-v1':
      return new DataworksBffMemoryAdapter(config);
    // no default
  }
}

export class GenericHttpSearchV1Adapter implements ExternalContextProvider {
  private readonly searchUrl: URL;

  constructor(private readonly config: GenericHttpProviderConfig) {
    const baseUrl = validateConfiguredBaseUrl(config.baseUrl);
    this.searchUrl = new URL('/v1/context/search', baseUrl);
  }

  async search(input: {
    query: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<readonly ExternalContextItem[]> {
    const response = await postJson({
      url: this.searchUrl,
      authorization: `Bearer ${this.config.token}`,
      body: { query: input.query, limit: input.limit },
      signal: input.signal,
    });
    return parseGenericItems(response);
  }
}

export class Mem0PlatformV3Adapter
  implements ExternalContextProvider, ExternalMemoryWriter
{
  private readonly baseUrl: URL;

  constructor(
    private readonly config: Mem0ProviderConfig,
    baseUrl: URL = MEM0_BASE_URL,
  ) {
    this.baseUrl = validateConfiguredBaseUrl(baseUrl.toString());
  }

  async search(input: {
    query: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<readonly ExternalContextItem[]> {
    const response = await postJson({
      url: new URL('/v3/memories/search/', this.baseUrl),
      authorization: `Token ${this.config.apiKey}`,
      body: {
        query: input.query,
        filters: { app_id: this.config.appId },
        top_k: Math.min(input.limit, MAX_PROVIDER_ITEMS),
        threshold: 0.1,
        rerank: false,
      },
      signal: input.signal,
    });
    return parseMem0Items(response);
  }

  async remember(input: {
    content: string;
    signal: AbortSignal;
  }): Promise<RememberResult> {
    let response: unknown;
    try {
      response = await postJson({
        url: new URL('/v3/memories/add/', this.baseUrl),
        authorization: `Token ${this.config.apiKey}`,
        body: {
          messages: [{ role: 'user', content: input.content }],
          app_id: this.config.appId,
          infer: false,
        },
        signal: input.signal,
      });
    } catch (error) {
      if (
        error instanceof ProviderHttpStatusError &&
        DEFINITIVE_WRITE_REJECTION_STATUSES.has(error.status)
      ) {
        return { status: 'failed' };
      }
      return { status: 'unknown' };
    }
    return parseMem0RememberResult(response);
  }
}

export class DataworksBffMemoryAdapter
  implements ExternalContextProvider, ExternalMemoryWriter
{
  private readonly baseUrl: URL;

  constructor(private readonly config: DataworksBffMemoryConfig) {
    this.baseUrl = validateBffBaseUrl(config.baseUrl);
  }

  async search(input: {
    query: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<readonly ExternalContextItem[]> {
    const data = unwrapBffEnvelope(
      await postJson({
        url: new URL('/dmai/mem0MemoriesSearch', this.baseUrl),
        authorization: `Bearer ${this.config.token}`,
        body: {
          query: input.query,
          filters: {},
          top_k: Math.min(input.limit, 5),
          threshold: 0.35,
        },
        signal: input.signal,
      }),
    );
    const memories = isRecord(data) ? data['results'] : undefined;
    if (!Array.isArray(memories)) {
      throw new Error(
        'External context provider returned an invalid response.',
      );
    }
    return memories
      .map(parseBffMemoryItem)
      .filter((value): value is ExternalContextItem => value !== undefined)
      .slice(0, MAX_PROVIDER_ITEMS);
  }

  async remember(input: {
    content: string;
    signal: AbortSignal;
  }): Promise<RememberResult> {
    try {
      const data = unwrapBffEnvelope(
        await postJson({
          url: new URL('/dmai/mem0MemoriesAdd', this.baseUrl),
          authorization: `Bearer ${this.config.token}`,
          body: {
            messages: [{ role: 'user', content: input.content }],
            source: 'qwen-code',
            infer: false,
          },
          signal: input.signal,
        }),
      );
      const memories = Array.isArray(data)
        ? data
        : isRecord(data) && Array.isArray(data['results'])
          ? data['results']
          : undefined;
      return memories && memories.length > 0
        ? { status: 'stored' }
        : { status: 'failed' };
    } catch (error) {
      if (
        error instanceof BffEnvelopeRejectionError ||
        (error instanceof ProviderHttpStatusError &&
          DEFINITIVE_WRITE_REJECTION_STATUSES.has(error.status))
      ) {
        return { status: 'failed' };
      }
      return { status: 'unknown' };
    }
  }
}

class BffEnvelopeRejectionError extends Error {}

function validateBffBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.endsWith('/') ? value : `${value}/`);
  } catch {
    throw new ConfigurationError('Provider URL is invalid.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigurationError(
      'Provider URL must not contain credentials, query, or fragment.',
    );
  }
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]')
    )
  ) {
    throw new ConfigurationError(
      'Provider URL must use HTTPS or loopback HTTP.',
    );
  }
  return new URL(`${url.origin}/`);
}

function unwrapBffEnvelope(value: unknown): unknown {
  if (!isRecord(value)) {
    throw new Error('External context provider returned an invalid response.');
  }
  const code = value['code'];
  if (
    code !== undefined &&
    code !== null &&
    code !== 0 &&
    code !== 200 &&
    code !== '0' &&
    code !== '200'
  ) {
    throw new BffEnvelopeRejectionError(
      'External context provider rejected the request.',
    );
  }
  return Object.hasOwn(value, 'data') ? value['data'] : value;
}

function parseBffMemoryItem(value: unknown): ExternalContextItem | undefined {
  if (!isRecord(value)) return undefined;
  const id = value['id'] ?? value['memory_id'];
  const content = value['memory'] ?? value['text'] ?? value['content'];
  if (typeof id !== 'string' || typeof content !== 'string' || !content) {
    return undefined;
  }
  return {
    id,
    content,
    ...(typeof value['score'] === 'number' ? { score: value['score'] } : {}),
    ...(typeof value['updated_at'] === 'string' &&
    Number.isFinite(Date.parse(value['updated_at']))
      ? {
          updatedAt: new Date(value['updated_at']).toISOString(),
        }
      : {}),
  };
}

function parseMem0RememberResult(response: unknown): RememberResult {
  if (!isRecord(response)) {
    return { status: 'unknown' };
  }

  const status = response['status'];
  const operationId = parseOperationId(response['event_id']);
  if (status === 'FAILED') {
    return { status: 'failed' };
  }
  if (status === 'PENDING') {
    return operationId === undefined
      ? { status: 'unknown' }
      : { status: 'accepted', providerOperationId: operationId };
  }
  if (status === 'SUCCEEDED') {
    if (response['event_id'] !== undefined && operationId === undefined) {
      return { status: 'unknown' };
    }
    return operationId === undefined
      ? { status: 'stored' }
      : { status: 'stored', providerOperationId: operationId };
  }
  return { status: 'unknown' };
}

function parseOperationId(value: unknown): string | undefined {
  return typeof value === 'string' && UUID_PATTERN.test(value)
    ? value
    : undefined;
}

function parseGenericItems(response: unknown): readonly ExternalContextItem[] {
  if (!isRecord(response) || !Array.isArray(response['items'])) {
    throw new Error('External context provider returned an invalid response.');
  }
  return response['items']
    .map(parseGenericItem)
    .filter((item): item is ExternalContextItem => item !== undefined)
    .slice(0, MAX_PROVIDER_ITEMS);
}

function parseGenericItem(value: unknown): ExternalContextItem | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return parseItemFields(value, 'content');
}

function parseMem0Items(response: unknown): readonly ExternalContextItem[] {
  const values =
    isRecord(response) && Array.isArray(response['results'])
      ? response['results']
      : undefined;
  if (!values) {
    throw new Error('External context provider returned an invalid response.');
  }
  return values
    .map((value) =>
      isRecord(value) ? parseItemFields(value, 'memory') : undefined,
    )
    .filter((item): item is ExternalContextItem => item !== undefined)
    .slice(0, MAX_PROVIDER_ITEMS);
}

function parseItemFields(
  value: Record<string, unknown>,
  contentKey: 'content' | 'memory',
): ExternalContextItem | undefined {
  const id = value['id'];
  const content = value[contentKey];
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof content !== 'string' ||
    content.length === 0
  ) {
    return undefined;
  }

  const optional = {
    title: parseOptionalString(value['title']),
    uri: parseOptionalString(value['uri']),
    updatedAt: parseOptionalString(value['updated_at'] ?? value['updatedAt']),
    score:
      typeof value['score'] === 'number' && Number.isFinite(value['score'])
        ? value['score']
        : undefined,
  };

  const item: ExternalContextItem = { id, content };
  if (optional.title !== undefined) {
    item.title = optional.title;
  }
  if (optional.uri !== undefined) {
    item.uri = optional.uri;
  }
  if (optional.updatedAt !== undefined) {
    item.updatedAt = optional.updatedAt;
  }
  if (optional.score !== undefined) {
    item.score = optional.score;
  }
  return item;
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateConfiguredBaseUrl(value: string): URL {
  try {
    return validateProviderBaseUrl(value);
  } catch (error) {
    throw new ConfigurationError(
      error instanceof Error
        ? error.message
        : 'External context provider URL is invalid.',
    );
  }
}
