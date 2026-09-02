/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ConfigurationError } from './config.js';
import { postJson, validateProviderBaseUrl } from './http-client.js';
import type {
  ExternalContextItem,
  ExternalContextProvider,
  GenericHttpProviderConfig,
  Mem0ProviderConfig,
  ProviderConfig,
} from './types.js';

const MEM0_BASE_URL = new URL('https://api.mem0.ai/');
const MAX_PROVIDER_ITEMS = 5;

export function createProvider(
  config: ProviderConfig,
): ExternalContextProvider {
  switch (config.type) {
    case 'mem0-platform-v3':
      return new Mem0PlatformV3Adapter(config);
    case 'generic-http-search-v1':
      return new GenericHttpSearchV1Adapter(config);
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

export class Mem0PlatformV3Adapter implements ExternalContextProvider {
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
