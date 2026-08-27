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
import {
  findInvalidMem0Scope,
  getMem0Preset,
  mem0ScopeViolationMessage,
  type Mem0Preset,
  type Mem0ScopePlacement,
} from './mem0-presets.js';
import type {
  ExternalContextItem,
  ExternalContextProvider,
  ExternalMemoryWriter,
  GenericHttpProviderConfig,
  Mem0CompatibleProviderConfig,
  Mem0ProviderConfig,
  ProviderConfig,
  RememberResult,
} from './types.js';

const MEM0_BASE_URL = new URL('https://api.mem0.ai/');
const MAX_PROVIDER_ITEMS = 5;
const DEFINITIVE_WRITE_REJECTION_STATUSES = new Set([400, 401, 403, 404]);

export function createProvider(
  config: ProviderConfig,
): ExternalContextProvider {
  switch (config.type) {
    case 'mem0-platform-v3':
      return new Mem0PlatformV3Adapter(config);
    case 'mem0':
      return new Mem0CompatibleAdapter(config);
    case 'generic-http-search-v1':
      return new GenericHttpSearchV1Adapter(config);
    // no default
  }
}

export function createMemoryWriter(
  config: ProviderConfig,
): ExternalMemoryWriter | undefined {
  switch (config.type) {
    case 'mem0-platform-v3':
      return new Mem0PlatformV3Adapter(config);
    case 'mem0':
      return getMem0Preset(config.preset).write === undefined
        ? undefined
        : new Mem0CompatibleAdapter(config);
    case 'generic-http-search-v1':
      return undefined;
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
      credentialHeader: {
        name: 'authorization',
        value: `Bearer ${this.config.token}`,
      },
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
      credentialHeader: {
        name: 'authorization',
        value: `Token ${this.config.apiKey}`,
      },
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
        credentialHeader: {
          name: 'authorization',
          value: `Token ${this.config.apiKey}`,
        },
        body: {
          messages: [{ role: 'user', content: input.content }],
          app_id: this.config.appId,
          infer: false,
        },
        signal: input.signal,
      });
    } catch (error) {
      return classifyWriteRejection(error);
    }
    return parseMem0RememberResult(response);
  }
}

function classifyWriteRejection(error: unknown): RememberResult {
  if (
    error instanceof ProviderHttpStatusError &&
    DEFINITIVE_WRITE_REJECTION_STATUSES.has(error.status)
  ) {
    return { status: 'failed' };
  }
  return { status: 'unknown' };
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
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    Array.from(value).length > 256 ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return undefined;
  }
  return value;
}

export class Mem0CompatibleAdapter
  implements ExternalContextProvider, ExternalMemoryWriter
{
  private readonly origin: URL;
  private readonly preset: Mem0Preset;

  constructor(private readonly config: Mem0CompatibleProviderConfig) {
    const violation = findInvalidMem0Scope(config);
    if (violation !== undefined) {
      throw new ConfigurationError(
        mem0ScopeViolationMessage(config.preset, violation),
      );
    }
    this.preset = getMem0Preset(config.preset);
    this.origin = validateConfiguredBaseUrl(config.endpoint.origin, {
      allowInsecureHttp: config.endpoint.allowInsecureHttp,
      allowInsecureHttpHint: true,
    });
    validateMem0BasePath(config.endpoint.basePath);
  }

  async search(input: {
    query: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<readonly ExternalContextItem[]> {
    const body: Record<string, unknown> = {
      query: input.query,
      [this.preset.search.limitField]: Math.min(
        input.limit,
        MAX_PROVIDER_ITEMS,
      ),
      ...this.preset.search.fixedBody,
    };
    applyMem0Scope(body, this.config, this.preset, 'search');
    const response = await postJson({
      url: this.buildUrl(this.preset.search.path),
      credentialHeader: mem0CredentialHeader(
        this.preset,
        this.config.credential,
      ),
      body,
      signal: input.signal,
    });
    return parseMem0Items(
      response,
      this.preset.search.idField,
      this.preset.search.contentFields,
    );
  }

  async remember(input: {
    content: string;
    signal: AbortSignal;
  }): Promise<RememberResult> {
    const write = this.preset.write;
    if (write === undefined) {
      return { status: 'unknown' };
    }
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: input.content }],
      infer: false,
    };
    applyMem0Scope(body, this.config, this.preset, 'write');
    let response: unknown;
    try {
      response = await postJson({
        url: this.buildUrl(write.path),
        credentialHeader: mem0CredentialHeader(
          this.preset,
          this.config.credential,
        ),
        body,
        signal: input.signal,
      });
    } catch (error) {
      return classifyWriteRejection(error);
    }
    return write.response === 'async-status'
      ? parseMem0RememberResult(response)
      : parseDirectWriteResult(response, write.idField, input.content);
  }

  private buildUrl(path: string): URL {
    const url = new URL(this.origin);
    const basePath = this.config.endpoint.basePath.replace(/\/$/u, '');
    url.pathname = `${basePath}${path}`;
    return url;
  }
}

function parseDirectWriteResult(
  response: unknown,
  idField: 'id',
  content: string,
): RememberResult {
  if (!isRecord(response) || !Array.isArray(response['results'])) {
    return { status: 'unknown' };
  }
  for (const item of response['results']) {
    if (!isRecord(item)) {
      continue;
    }
    if (!isExactDirectImport(item, content)) {
      return { status: 'unknown' };
    }
    const id = parseOperationId(item[idField]);
    if (id !== undefined) {
      return { status: 'stored', providerOperationId: id };
    }
  }
  return { status: 'unknown' };
}

/**
 * Decides whether one returned result is evidence that the confirmed text was
 * stored verbatim.
 *
 * `infer: false` is what makes `context_remember` store the exact text the
 * user approved in the confirmation Hook, but it is an ordinary request field:
 * a deployment whose request model predates it drops it silently and runs LLM
 * fact extraction instead, then returns a rewritten memory plus a perfectly
 * valid identifier. Reporting `stored` there would tell the user that the text
 * they read is what landed, when it is not. The echoed `memory` is the only
 * client-side evidence available, and it does not depend on knowing which
 * build is deployed - which matters because the endpoint is operator-supplied
 * and its version is not guaranteed.
 *
 * Inference can also retire a contradicting memory, so a `DELETE` event is
 * never storage of this content.
 *
 * A result that echoes no `memory` at all is left to the identifier, so a
 * preset whose upstream simply does not return the field keeps its existing
 * behaviour rather than degrading to `unknown`.
 */
function isExactDirectImport(
  item: Record<string, unknown>,
  content: string,
): boolean {
  const memory = item['memory'];
  if (typeof memory === 'string' && memory !== content) {
    return false;
  }
  return item['event'] !== 'DELETE';
}

function mem0CredentialHeader(
  preset: Mem0Preset,
  credential: string,
): { name: 'authorization' | 'x-api-key'; value: string } {
  switch (preset.authentication) {
    case 'authorization-token':
      return { name: 'authorization', value: `Token ${credential}` };
    case 'x-api-key':
      return { name: 'x-api-key', value: credential };
    // no default
  }
}

function applyMem0Scope(
  body: Record<string, unknown>,
  config: Mem0CompatibleProviderConfig,
  preset: Mem0Preset,
  operation: 'search' | 'write',
): void {
  const fields = [
    ['userId', 'user_id'],
    ['agentId', 'agent_id'],
    ['appId', 'app_id'],
  ] as const;
  for (const [configField, requestField] of fields) {
    const value = config.scope[configField];
    const placement = preset.scope[configField][operation];
    placeMem0Scope(body, placement, requestField, value);
  }
}

function placeMem0Scope(
  body: Record<string, unknown>,
  placement: Mem0ScopePlacement,
  field: 'user_id' | 'agent_id' | 'app_id',
  value: string | undefined,
): void {
  if (placement === 'omit' || value === undefined) {
    return;
  }
  if (placement === 'body' || placement === 'body-and-filters') {
    body[field] = value;
  }
  if (placement === 'filters' || placement === 'body-and-filters') {
    const filters = (body['filters'] ??= {}) as Record<string, unknown>;
    filters[field] = value;
  }
}

// Each rule names the shape it rejects so an administrator editing a local
// file is told which character to remove, instead of retrying a single opaque
// message against nine independent conditions.
const MEM0_BASE_PATH_RULES: ReadonlyArray<{
  reason: string;
  rejects: (value: string) => boolean;
}> = [
  {
    reason: 'it must start with "/"',
    rejects: (value) => !value.startsWith('/'),
  },
  {
    reason: 'it must not contain an empty segment ("//")',
    rejects: (value) => value.includes('//'),
  },
  {
    reason: 'it must not contain a query ("?")',
    rejects: (value) => value.includes('?'),
  },
  {
    reason: 'it must not contain a fragment ("#")',
    rejects: (value) => value.includes('#'),
  },
  {
    reason: 'it must not contain a backslash',
    rejects: (value) => value.includes('\\'),
  },
  {
    reason: 'it must not contain percent-encoded material ("%")',
    rejects: (value) => value.includes('%'),
  },
  {
    reason: 'it must not contain whitespace',
    rejects: (value) => /\s/u.test(value),
  },
  {
    reason: 'it must not contain control characters',
    rejects: (value) =>
      Array.from(value).some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 0x1f || code === 0x7f;
      }),
  },
  {
    reason: 'it must not contain a "." or ".." segment',
    rejects: (value) =>
      value.split('/').some((segment) => segment === '.' || segment === '..'),
  },
];

function validateMem0BasePath(value: string): void {
  if (value === '') {
    return;
  }
  for (const rule of MEM0_BASE_PATH_RULES) {
    if (rule.rejects(value)) {
      throw new ConfigurationError(
        `External context Mem0 endpoint basePath is invalid: ${rule.reason}.`,
      );
    }
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
  return parseItemFields(value, 'id', ['content']);
}

function parseMem0Items(
  response: unknown,
  idField: 'id' | 'memory_id' = 'id',
  contentFields: ReadonlyArray<'memory' | 'content' | 'text'> = ['memory'],
): readonly ExternalContextItem[] {
  const values =
    isRecord(response) && Array.isArray(response['results'])
      ? response['results']
      : undefined;
  if (!values) {
    throw new Error('External context provider returned an invalid response.');
  }
  return values
    .map((value) =>
      isRecord(value)
        ? parseItemFields(value, idField, contentFields)
        : undefined,
    )
    .filter((item): item is ExternalContextItem => item !== undefined)
    .slice(0, MAX_PROVIDER_ITEMS);
}

function parseItemFields(
  value: Record<string, unknown>,
  idKey: 'id' | 'memory_id',
  contentKeys: ReadonlyArray<'content' | 'memory' | 'text'>,
): ExternalContextItem | undefined {
  const id = value[idKey];
  const content = contentKeys
    .map((key) => value[key])
    .find(
      (candidate): candidate is string =>
        typeof candidate === 'string' && candidate.length > 0,
    );
  if (typeof id !== 'string' || id.length === 0 || content === undefined) {
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

function validateConfiguredBaseUrl(
  value: string,
  options?: { allowInsecureHttp?: boolean; allowInsecureHttpHint?: boolean },
): URL {
  try {
    return validateProviderBaseUrl(value, options);
  } catch (error) {
    throw new ConfigurationError(
      error instanceof Error
        ? error.message
        : 'External context provider URL is invalid.',
    );
  }
}
