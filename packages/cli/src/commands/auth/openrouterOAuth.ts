/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import open from 'open';

import type { ModelConfig } from '@qwen-code/qwen-code-core';

export const OPENROUTER_ENV_KEY = 'OPENROUTER_API_KEY';
export const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-4o-mini';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_OAUTH_AUTHORIZE_URL = 'https://openrouter.ai/auth';
export const OPENROUTER_OAUTH_EXCHANGE_URL =
  'https://openrouter.ai/api/v1/auth/keys';
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_OAUTH_CALLBACK_URL =
  'http://localhost:3000/openrouter/callback';
const OPENROUTER_CODE_CHALLENGE_METHOD = 'S256';
const OPENROUTER_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const OPENROUTER_MINIMUM_TEXT_MODELS = 1;

export const OPENROUTER_DEFAULT_MODELS: ModelConfig[] = [
  {
    id: 'openai/gpt-4o-mini',
    name: 'OpenRouter · GPT-4o mini',
    baseUrl: OPENROUTER_BASE_URL,
    envKey: OPENROUTER_ENV_KEY,
  },
  {
    id: 'anthropic/claude-3.7-sonnet',
    name: 'OpenRouter · Claude 3.7 Sonnet',
    baseUrl: OPENROUTER_BASE_URL,
    envKey: OPENROUTER_ENV_KEY,
  },
  {
    id: 'google/gemini-2.5-flash',
    name: 'OpenRouter · Gemini 2.5 Flash',
    baseUrl: OPENROUTER_BASE_URL,
    envKey: OPENROUTER_ENV_KEY,
  },
];

export interface OpenRouterOAuthResult {
  apiKey: string;
  userId?: string;
  authorizationCodeWaitMs?: number;
  apiKeyExchangeMs?: number;
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

export interface OAuthCallbackListener {
  ready: Promise<void>;
  waitForCode: Promise<string>;
  close: () => Promise<void>;
}

interface OpenRouterModelApiRecord {
  id?: string;
  name?: string;
  description?: string;
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

function toBase64Url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function createPkcePair(): PkcePair {
  const codeVerifier = toBase64Url(randomBytes(32));
  const codeChallenge = toBase64Url(
    createHash('sha256').update(codeVerifier).digest(),
  );
  return { codeVerifier, codeChallenge };
}

export function buildOpenRouterAuthorizationUrl(params: {
  callbackUrl: string;
  codeChallenge: string;
  codeChallengeMethod?: 'S256';
  limit?: number;
}): string {
  const url = new URL(OPENROUTER_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('callback_url', params.callbackUrl);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set(
    'code_challenge_method',
    params.codeChallengeMethod || OPENROUTER_CODE_CHALLENGE_METHOD,
  );
  if (typeof params.limit === 'number') {
    url.searchParams.set('limit', String(params.limit));
  }
  return url.toString();
}

export function startOAuthCallbackListener(
  callbackUrl = OPENROUTER_OAUTH_CALLBACK_URL,
  timeoutMs = OPENROUTER_OAUTH_TIMEOUT_MS,
): OAuthCallbackListener {
  const parsedUrl = new URL(callbackUrl);
  if (parsedUrl.protocol !== 'http:') {
    throw new Error(
      'Only http localhost callback URLs are currently supported.',
    );
  }

  let server: Server | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let settled = false;

  const close = async () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    server = undefined;
  };

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const finish = (action: 'resolve' | 'reject', payload: string | Error) => {
    if (settled) {
      return;
    }
    settled = true;

    if (action === 'resolve') {
      resolveCode(payload as string);
    } else {
      rejectCode(payload as Error);
    }

    void close().catch(() => undefined);
  };

  server = createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', parsedUrl.origin);
    if (requestUrl.pathname !== parsedUrl.pathname) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    const error = requestUrl.searchParams.get('error');
    if (error) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(`OpenRouter authorization failed: ${error}`);
      void finish(
        'reject',
        new Error(`OpenRouter authorization failed: ${error}`),
      );
      return;
    }

    const code = requestUrl.searchParams.get('code');
    if (!code) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Missing authorization code.');
      void finish(
        'reject',
        new Error('Missing authorization code from OpenRouter callback.'),
      );
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      '<html><body><h1>OpenRouter authentication complete.</h1><p>You can return to Qwen Code.</p></body></html>',
    );
    void finish('resolve', code);
  });

  server.once('error', (error) => {
    rejectReady(error instanceof Error ? error : new Error(String(error)));
    void finish(
      'reject',
      error instanceof Error ? error : new Error(String(error)),
    );
  });

  const port = parsedUrl.port ? Number(parsedUrl.port) : 80;
  server.listen(port, parsedUrl.hostname, () => {
    resolveReady();
  });

  timeout = setTimeout(() => {
    void finish(
      'reject',
      new Error('Timed out waiting for OpenRouter OAuth callback.'),
    );
  }, timeoutMs);

  return {
    ready,
    waitForCode,
    close,
  };
}

function buildOpenRouterHeaders() {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://github.com/QwenLM/qwen-code.git',
    'X-OpenRouter-Title': 'Qwen Code',
  };
}

const OPENROUTER_MODEL_PRIORITY_PREFIXES = ['qwen/', 'glm/', 'minimax/'];
const OPENROUTER_RECOMMENDED_MODEL_LIMIT = 16;
const OPENROUTER_FREE_MODEL_ID_HINT = ':free';

function isOpenRouterFreeModelId(modelId: string): boolean {
  const normalizedId = modelId.toLowerCase();
  return (
    normalizedId.includes(OPENROUTER_FREE_MODEL_ID_HINT) ||
    normalizedId === 'openrouter/free'
  );
}

function getOpenRouterModelPriority(modelId: string): number {
  const normalizedId = modelId.toLowerCase();
  const matchedIndex = OPENROUTER_MODEL_PRIORITY_PREFIXES.findIndex((prefix) =>
    normalizedId.startsWith(prefix),
  );
  return matchedIndex === -1
    ? OPENROUTER_MODEL_PRIORITY_PREFIXES.length
    : matchedIndex;
}

function isOpenRouterFreeConfig(model: ModelConfig): boolean {
  return isOpenRouterFreeModelId(model.id);
}

function compareOpenRouterModels(a: ModelConfig, b: ModelConfig): number {
  const freeDiff =
    Number(isOpenRouterFreeConfig(b)) - Number(isOpenRouterFreeConfig(a));
  if (freeDiff !== 0) {
    return freeDiff;
  }

  const priorityDiff =
    getOpenRouterModelPriority(a.id) - getOpenRouterModelPriority(b.id);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  return a.id.localeCompare(b.id);
}

function toOpenRouterModelConfig(
  model: OpenRouterModelApiRecord,
): ModelConfig | null {
  if (!model.id) {
    return null;
  }

  const outputModalities = model.architecture?.output_modalities || [];
  const supportsTextOutput = outputModalities.length
    ? outputModalities.includes('text')
    : true;

  if (!supportsTextOutput) {
    return null;
  }

  const inputModalities = model.architecture?.input_modalities || [];
  const supportsVision = inputModalities.includes('image');

  return {
    id: model.id,
    name: model.name
      ? `OpenRouter · ${model.name}`
      : `OpenRouter · ${model.id}`,
    baseUrl: OPENROUTER_BASE_URL,
    envKey: OPENROUTER_ENV_KEY,
    capabilities: supportsVision ? { vision: true } : undefined,
    generationConfig:
      typeof model.context_length === 'number'
        ? { contextWindowSize: model.context_length }
        : undefined,
  };
}

function chooseRepresentativeModel(
  models: ModelConfig[],
  predicate: (model: ModelConfig) => boolean,
  selectedIds: Set<string>,
): ModelConfig | undefined {
  return models.find((model) => predicate(model) && !selectedIds.has(model.id));
}

function addRecommendedModel(
  target: ModelConfig[],
  model: ModelConfig | undefined,
  selectedIds: Set<string>,
  limit: number,
): void {
  if (!model || selectedIds.has(model.id) || target.length >= limit) {
    return;
  }
  target.push(model);
  selectedIds.add(model.id);
}

export function selectRecommendedOpenRouterModels(
  models: ModelConfig[],
  limit = OPENROUTER_RECOMMENDED_MODEL_LIMIT,
): ModelConfig[] {
  if (models.length <= limit) {
    return models;
  }

  const sorted = [...models].sort(compareOpenRouterModels);
  const recommended: ModelConfig[] = [];
  const selectedIds = new Set<string>();

  const freeModels = sorted.filter((model) => isOpenRouterFreeConfig(model));
  for (const model of freeModels.slice(0, Math.min(limit, 6))) {
    addRecommendedModel(recommended, model, selectedIds, limit);
  }

  for (const prefix of OPENROUTER_MODEL_PRIORITY_PREFIXES) {
    addRecommendedModel(
      recommended,
      chooseRepresentativeModel(
        sorted,
        (model) => model.id.toLowerCase().startsWith(prefix),
        selectedIds,
      ),
      selectedIds,
      limit,
    );
  }

  for (const family of ['anthropic/', 'google/', 'openai/']) {
    addRecommendedModel(
      recommended,
      chooseRepresentativeModel(
        sorted,
        (model) => model.id.toLowerCase().startsWith(family),
        selectedIds,
      ),
      selectedIds,
      limit,
    );
  }

  addRecommendedModel(
    recommended,
    chooseRepresentativeModel(
      sorted,
      (model) => model.capabilities?.vision === true,
      selectedIds,
    ),
    selectedIds,
    limit,
  );

  addRecommendedModel(
    recommended,
    chooseRepresentativeModel(
      sorted,
      (model) => (model.generationConfig?.contextWindowSize || 0) >= 1000000,
      selectedIds,
    ),
    selectedIds,
    limit,
  );

  for (const model of sorted) {
    if (recommended.length >= limit) {
      break;
    }
    addRecommendedModel(recommended, model, selectedIds, limit);
  }

  return recommended;
}

export function isOpenRouterConfig(config: ModelConfig): boolean {
  return (config.baseUrl || '').includes('openrouter.ai');
}

export function mergeOpenRouterConfigs(
  existingConfigs: ModelConfig[],
  openRouterModels = OPENROUTER_DEFAULT_MODELS,
): ModelConfig[] {
  const nonOpenRouterConfigs = existingConfigs.filter(
    (existing) => !isOpenRouterConfig(existing),
  );
  return [...openRouterModels, ...nonOpenRouterConfigs];
}

export async function fetchOpenRouterModels(): Promise<ModelConfig[]> {
  const response = await fetch(OPENROUTER_MODELS_URL, {
    method: 'GET',
    headers: buildOpenRouterHeaders(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OpenRouter models request failed (${response.status}): ${errorText}`,
    );
  }

  const data = (await response.json()) as {
    data?: OpenRouterModelApiRecord[];
  };
  const records = Array.isArray(data.data) ? data.data : [];
  const models = records
    .map((record) => toOpenRouterModelConfig(record))
    .filter((model): model is ModelConfig => model !== null)
    .sort(compareOpenRouterModels);

  if (models.length < OPENROUTER_MINIMUM_TEXT_MODELS) {
    throw new Error(
      'OpenRouter models request returned no usable text models.',
    );
  }

  return models;
}

export async function getOpenRouterModelsWithFallback(): Promise<
  ModelConfig[]
> {
  try {
    return await fetchOpenRouterModels();
  } catch {
    return OPENROUTER_DEFAULT_MODELS;
  }
}

export async function exchangeAuthCodeForApiKey(params: {
  code: string;
  codeVerifier: string;
}): Promise<OpenRouterOAuthResult> {
  const response = await fetch(OPENROUTER_OAUTH_EXCHANGE_URL, {
    method: 'POST',
    headers: buildOpenRouterHeaders(),
    body: JSON.stringify({
      code: params.code,
      code_verifier: params.codeVerifier,
      code_challenge_method: OPENROUTER_CODE_CHALLENGE_METHOD,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OpenRouter API key exchange failed (${response.status}): ${errorText}`,
    );
  }

  const data = (await response.json()) as {
    key?: string;
    user_id?: string;
  };

  if (!data.key) {
    throw new Error(
      'OpenRouter API key exchange succeeded but no key was returned.',
    );
  }

  return {
    apiKey: data.key,
    userId: data.user_id,
  };
}

interface OpenRouterOAuthLoginDeps {
  openBrowser?: typeof open;
  startListener?: typeof startOAuthCallbackListener;
  exchangeApiKey?: typeof exchangeAuthCodeForApiKey;
  now?: () => number;
}

export async function runOpenRouterOAuthLogin(
  callbackUrl = OPENROUTER_OAUTH_CALLBACK_URL,
  deps: OpenRouterOAuthLoginDeps = {},
): Promise<OpenRouterOAuthResult> {
  const { codeVerifier, codeChallenge } = createPkcePair();
  const authUrl = buildOpenRouterAuthorizationUrl({
    callbackUrl,
    codeChallenge,
    codeChallengeMethod: OPENROUTER_CODE_CHALLENGE_METHOD,
  });

  const openBrowser = deps.openBrowser || open;
  const startListener = deps.startListener || startOAuthCallbackListener;
  const exchangeApiKey = deps.exchangeApiKey || exchangeAuthCodeForApiKey;
  const now = deps.now || Date.now;

  const listener = startListener(callbackUrl);
  try {
    await listener.ready;
    await openBrowser(authUrl);

    const waitStartMs = now();
    const code = await listener.waitForCode;
    const authorizationCodeWaitMs = now() - waitStartMs;

    const exchangeStartMs = now();
    const exchangeResult = await exchangeApiKey({ code, codeVerifier });
    const apiKeyExchangeMs = now() - exchangeStartMs;

    return {
      ...exchangeResult,
      authorizationCodeWaitMs,
      apiKeyExchangeMs,
    };
  } finally {
    void listener.close().catch(() => undefined);
  }
}
