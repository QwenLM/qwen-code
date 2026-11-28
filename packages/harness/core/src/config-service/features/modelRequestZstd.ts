/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_FIXED_ENV_PREFIX } from '../../config/brand.js';

import { runLogger } from '../../utils/runLogger.js';
import { getConfigValue, subscribeConfigValue } from '../index.js';
import { parseBoolean, parseObjectGateValue } from './gateParseUtils.js';

/**
 * QCS: { enabled: false, transports: ['legacy'], min_body_chars: 4096, level: 1 }.
 * The retired 'http' entry is still accepted from QCS and ignored.
 * QWEN_ZSTD_REQUEST_BODIES=1/0 overrides rollout targeting; LEVEL and MIN_CHARS
 * use QWEN_ZSTD_REQUEST_BODY_* variables and otherwise inherit the QCS values.
 * Thresholds count UTF-16 code units in the final body (String.length).
 * Compression levels 1–22 are supported; level 1 favors request latency.
 */
export const MODEL_REQUEST_ZSTD_GATE = 'model_request_zstd';
export type ZstdModelTransport = 'legacy';

export interface ModelRequestZstdConfig {
  readonly enabled: boolean;
  readonly transports: readonly ZstdModelTransport[];
  /** Final request body String.length, measured in UTF-16 code units. */
  readonly minBodyChars: number;
  readonly level: number;
  readonly source: 'default' | 'qcs' | 'env';
}

const DEFAULT_CONFIG: ModelRequestZstdConfig = {
  enabled: false,
  transports: ['legacy'],
  minBodyChars: 4096,
  level: 1,
  source: 'default',
};
let currentConfig = DEFAULT_CONFIG;
const invalidEnvironmentValues = new Map<string, string>();

function integer(
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : undefined;
}

function parseConfig(value: unknown): ModelRequestZstdConfig | undefined {
  if (value == null || value === '') return DEFAULT_CONFIG;
  const record = parseObjectGateValue(value);
  if (!record) return undefined;
  const enabled =
    record['enabled'] === undefined ? false : parseBoolean(record['enabled']);
  const minBodyChars =
    record['min_body_chars'] === undefined
      ? DEFAULT_CONFIG.minBodyChars
      : integer(record['min_body_chars'], 1);
  const level =
    record['level'] === undefined
      ? DEFAULT_CONFIG.level
      : integer(record['level'], 1, 22);
  const transports = record['transports'] ?? DEFAULT_CONFIG.transports;
  if (
    enabled === undefined ||
    minBodyChars === undefined ||
    level === undefined ||
    !Array.isArray(transports) ||
    !transports.every(
      (transport: unknown) => transport === 'legacy' || transport === 'http',
    )
  )
    return undefined;
  return {
    enabled,
    minBodyChars,
    level,
    transports: transports.filter(
      (transport): transport is ZstdModelTransport => transport === 'legacy',
    ),
    source: 'qcs',
  };
}

function environmentOverride<T>(
  name: string,
  parse: (value: string) => T | undefined,
): T | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const parsed = parse(raw);
  if (parsed === undefined) {
    if (invalidEnvironmentValues.get(name) !== raw) {
      invalidEnvironmentValues.set(name, raw);
      runLogger.warn(`[config-service] Ignoring invalid ${name} value`);
    }
  } else {
    invalidEnvironmentValues.delete(name);
  }
  return parsed;
}

/** Snapshot once per logical request; retries must use the same policy. */
export function getModelRequestZstdConfig(): ModelRequestZstdConfig {
  const fresh = getConfigValue(MODEL_REQUEST_ZSTD_GATE);
  const parsed = parseConfig(fresh);
  if (parsed) currentConfig = parsed;
  const enabled = environmentOverride(
    `${BRAND_FIXED_ENV_PREFIX}ZSTD_REQUEST_BODIES`,
    parseBoolean,
  );
  const minBodyChars = environmentOverride(
    `${BRAND_FIXED_ENV_PREFIX}ZSTD_REQUEST_BODY_MIN_CHARS`,
    (value) => integer(value, 1),
  );
  const level = environmentOverride(
    `${BRAND_FIXED_ENV_PREFIX}ZSTD_REQUEST_BODY_LEVEL`,
    (value) => integer(value, 1, 22),
  );
  return {
    ...currentConfig,
    enabled: enabled ?? currentConfig.enabled,
    // An explicit enable covers every supported adapter, independently of rollout targeting.
    transports:
      enabled === true
        ? [...DEFAULT_CONFIG.transports]
        : [...currentConfig.transports],
    minBodyChars: minBodyChars ?? currentConfig.minBodyChars,
    level: level ?? currentConfig.level,
    source:
      enabled !== undefined || minBodyChars !== undefined || level !== undefined
        ? 'env'
        : currentConfig.source,
  };
}

export function registerModelRequestZstdFeature(): void {
  subscribeConfigValue(MODEL_REQUEST_ZSTD_GATE, (value) => {
    const parsed = parseConfig(value);
    if (!parsed) {
      runLogger.warn(
        '[config-service] Ignoring invalid model_request_zstd feature gate value',
      );
      return;
    }
    currentConfig = parsed;
    runLogger.log(
      '[config-service] model_request_zstd feature gate value received',
      parsed,
    );
  });
}
