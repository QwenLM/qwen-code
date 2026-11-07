/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface MemoryConnection {
  baseUrl: string;
  apiKey?: string;
}

export type MemoryLogger = (
  event: string,
  details?: Record<string, unknown>,
) => void;

export interface MemoryConfig {
  enabled: boolean;
  dir: string;
  defaultId: string;
  retrieve: {
    topK: number;
    maxChars: number;
    retrievedMaxChars: number;
    useVector: boolean;
    model: string;
    timeoutMs: number;
    backfillTimeoutMs: number;
    cacheSize: number;
    minSim: number;
    vecLimit: number;
    ftsLimit: number;
    ftsAndTryThreshold: number;
    andBoost: number;
    timeRangeBoost: number;
    timeEdgeDays: number;
    rrfK: number;
    envMinGapSec: number;
  };
  preload: {
    ltmMaxPerField: number;
    ltmMaxChars: number;
    stmUpcomingGraceDays: number;
    stmMaxAgeDays: number;
    recencyLambda: number;
    upcomingWeight: number;
    ongoingWeight: number;
    urgentBoost: number;
    urgentDays: number;
    stmMaxItems: number;
    stmMaxChars: number;
  };
  updater: {
    enabled: boolean;
    model: string;
    baseUrl: string;
    apiKeyEnv: string;
    timeoutMs: number;
    temperature: number;
    maxTokens: number;
    maxWmEntries: number;
    shutdownWaitSec: number;
  };
  observer: {
    enabled: boolean;
    model: string;
    baseUrl: string;
    apiKeyEnv: string;
    intervalSec: number;
    timeoutMs: number;
    temperature: number;
    maxTokens: number;
    maxContentChars: number;
    maxFrameAgeSec: number;
  };
  wm: { maxEntries: number; maxEntryChars: number };
  segment: {
    maxTurns: number;
    minTurnsBeforeGapCut: number;
    maxChars: number;
    silenceGapSec: number;
  };
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  dir: '',
  defaultId: 'default',
  retrieve: {
    topK: 3,
    maxChars: 5000,
    retrievedMaxChars: 6000,
    useVector: true,
    model: 'text-embedding-v4',
    timeoutMs: 400,
    backfillTimeoutMs: 10000,
    cacheSize: 1000,
    minSim: 0.4,
    vecLimit: 50,
    ftsLimit: 50,
    ftsAndTryThreshold: 20,
    andBoost: 1.2,
    timeRangeBoost: 2,
    timeEdgeDays: 2,
    rrfK: 60,
    envMinGapSec: 600,
  },
  preload: {
    ltmMaxPerField: 6,
    ltmMaxChars: 800,
    stmUpcomingGraceDays: 2,
    stmMaxAgeDays: 90,
    recencyLambda: 0.05,
    upcomingWeight: 1.5,
    ongoingWeight: 1,
    urgentBoost: 1.5,
    urgentDays: 3,
    stmMaxItems: 20,
    stmMaxChars: 1200,
  },
  updater: {
    enabled: true,
    model: 'qwen3.7-plus',
    baseUrl: '',
    apiKeyEnv: '',
    timeoutMs: 120000,
    temperature: 0,
    maxTokens: 2048,
    maxWmEntries: 64,
    shutdownWaitSec: 2,
  },
  observer: {
    enabled: false,
    model: 'qwen3.7-plus',
    baseUrl: '',
    apiKeyEnv: '',
    intervalSec: 60,
    timeoutMs: 60000,
    temperature: 0,
    maxTokens: 400,
    maxContentChars: 400,
    maxFrameAgeSec: 15,
  },
  wm: { maxEntries: 128, maxEntryChars: 200 },
  segment: {
    maxTurns: 4,
    minTurnsBeforeGapCut: 2,
    maxChars: 1000,
    silenceGapSec: 60,
  },
};

export function initialMemoryConfig(enabled: boolean, model = 'qwen3.7-plus') {
  const defaults = structuredClone(DEFAULT_MEMORY_CONFIG);
  const { model: _model, ...observer } = defaults.observer;
  return {
    ...defaults,
    enabled,
    updater: { ...defaults.updater, model },
    observer,
  };
}

type NumericRule = readonly [
  minimum: number,
  maximum: number,
  integer?: boolean,
];
const NUMBER_RULES: Record<string, NumericRule> = {
  'retrieve.topK': [1, 20, true],
  'retrieve.maxChars': [100, 100000, true],
  'retrieve.retrievedMaxChars': [100, 100000, true],
  'retrieve.timeoutMs': [50, 60000, true],
  'retrieve.backfillTimeoutMs': [50, 120000, true],
  'retrieve.cacheSize': [1, 1000000, true],
  'retrieve.minSim': [0, 1],
  'retrieve.vecLimit': [1, 1000, true],
  'retrieve.ftsLimit': [1, 1000, true],
  'retrieve.ftsAndTryThreshold': [1, 1000, true],
  'retrieve.andBoost': [1, 10],
  'retrieve.timeRangeBoost': [1, 100],
  'retrieve.timeEdgeDays': [0, 365, true],
  'retrieve.rrfK': [1, 10000, true],
  'retrieve.envMinGapSec': [0, 86400],
  'preload.ltmMaxPerField': [1, 64, true],
  'preload.ltmMaxChars': [1, 100000, true],
  'preload.stmUpcomingGraceDays': [0, 365, true],
  'preload.stmMaxAgeDays': [1, 3650, true],
  'preload.recencyLambda': [0, 100000],
  'preload.upcomingWeight': [0, 100000],
  'preload.ongoingWeight': [0, 100000],
  'preload.urgentBoost': [0, 100000],
  'preload.urgentDays': [0, 365, true],
  'preload.stmMaxItems': [1, 1000, true],
  'preload.stmMaxChars': [1, 100000, true],
  'updater.timeoutMs': [1000, 600000, true],
  'updater.temperature': [0, 2],
  'updater.maxTokens': [256, 32768, true],
  'updater.maxWmEntries': [1, 4096, true],
  'updater.shutdownWaitSec': [0, 60],
  'observer.intervalSec': [0, 3600],
  'observer.timeoutMs': [1000, 600000, true],
  'observer.temperature': [0, 2],
  'observer.maxTokens': [64, 32768, true],
  'observer.maxContentChars': [20, 4096, true],
  'observer.maxFrameAgeSec': [0, 3600],
  'wm.maxEntries': [1, 4096, true],
  'wm.maxEntryChars': [1, 4000, true],
  'segment.maxTurns': [1, 64, true],
  'segment.minTurnsBeforeGapCut': [1, 64, true],
  'segment.maxChars': [50, 100000, true],
  'segment.silenceGapSec': [0, 86400, true],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeMemoryConfig(
  defaults: Record<string, unknown>,
  raw: unknown,
  path: string,
  configPath: string,
): Record<string, unknown> {
  if (raw === undefined) return structuredClone(defaults);
  const invalid = (key: string, detail: string): never => {
    throw new Error(
      `Invalid "memory${key ? '.' + key : ''}" in ${configPath}: ${detail}`,
    );
  };
  if (!isRecord(raw)) return invalid(path, 'expected an object');
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(defaults, key))
      invalid(path, `unknown key ${JSON.stringify(key)}`);
  }
  for (const [key, fallback] of Object.entries(defaults)) {
    const keyPath = path ? `${path}.${key}` : key;
    const value = raw[key] ?? fallback;
    if (raw[key] === null) invalid(keyPath, 'null is not supported');
    if (isRecord(fallback)) {
      result[key] = mergeMemoryConfig(fallback, raw[key], keyPath, configPath);
    } else if (typeof fallback === 'boolean') {
      if (typeof value !== 'boolean') invalid(keyPath, 'expected a boolean');
      result[key] = value;
    } else if (typeof fallback === 'number') {
      const rule = NUMBER_RULES[keyPath];
      if (!rule) throw new Error(`Missing memory validation rule: ${keyPath}`);
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < rule[0] ||
        value > rule[1] ||
        (rule[2] && !Number.isInteger(value))
      ) {
        invalid(
          keyPath,
          `expected ${rule[2] ? 'an integer' : 'a number'} from ${rule[0]} to ${rule[1]}`,
        );
      }
      result[key] = value;
    } else {
      if (typeof value !== 'string' || /\p{C}/u.test(value))
        return invalid(keyPath, 'expected text without control characters');
      const text = value.trim();
      if (!text && key !== 'dir' && key !== 'baseUrl' && key !== 'apiKeyEnv')
        invalid(keyPath, 'must not be empty');
      if ((key === 'model' || key === 'apiKeyEnv') && text.length > 256)
        invalid(keyPath, 'text is too long');
      result[key] = text;
    }
  }
  return result;
}

export function resolveMemoryConfig(
  raw: unknown,
  dataDir: string,
  configPath: string,
): MemoryConfig {
  const config = mergeMemoryConfig(
    DEFAULT_MEMORY_CONFIG as unknown as Record<string, unknown>,
    raw,
    '',
    configPath,
  ) as unknown as MemoryConfig;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(config.defaultId))
    throw new Error('memory.defaultId must be a safe library id');
  const rawObserver =
    isRecord(raw) && isRecord(raw['observer']) ? raw['observer'] : {};
  if (rawObserver['model'] === undefined)
    config.observer.model = config.updater.model;
  for (const settings of [config.updater, config.observer]) {
    if (settings.baseUrl) validateMemoryBaseUrl(settings.baseUrl);
    if (
      settings.apiKeyEnv &&
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(settings.apiKeyEnv)
    )
      throw new Error('memory apiKeyEnv must name an environment variable');
    if (settings.apiKeyEnv && !settings.baseUrl)
      throw new Error('memory apiKeyEnv requires baseUrl');
  }
  if (config.retrieve.maxChars > config.retrieve.retrievedMaxChars)
    throw new Error(
      'memory.retrieve.maxChars must not exceed retrievedMaxChars',
    );
  if (config.retrieve.backfillTimeoutMs < config.retrieve.timeoutMs)
    throw new Error(
      'memory.retrieve.backfillTimeoutMs must not be below timeoutMs',
    );
  if (config.segment.minTurnsBeforeGapCut > config.segment.maxTurns)
    throw new Error(
      'memory.segment.minTurnsBeforeGapCut must not exceed maxTurns',
    );
  const directory = config.dir.startsWith('~/')
    ? join(homedir(), config.dir.slice(2))
    : config.dir;
  config.dir = directory
    ? isAbsolute(directory)
      ? directory
      : resolve(dataDir, directory)
    : join(dataDir, 'memories');
  return config;
}

export function validateMemoryBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Memory endpoint must be an HTTP(S) URL without embedded credentials, query or fragment',
    );
  }
  return url.toString().replace(/\/$/u, '');
}

export function deriveMemoryBaseUrl(realtimeEndpoint: string): string {
  const url = new URL(realtimeEndpoint);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.username || url.password)
    throw new Error('Memory endpoint cannot contain credentials');
  url.search = '';
  url.hash = '';
  const compatible = url.pathname.indexOf('/compatible-mode/v1');
  url.pathname =
    compatible >= 0
      ? url.pathname.slice(0, compatible) + '/compatible-mode/v1'
      : '/compatible-mode/v1';
  return validateMemoryBaseUrl(url.toString());
}
