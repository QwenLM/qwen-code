/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { runLogger } from '../../utils/runLogger.js';
import { getConfigValue, subscribeConfigValue } from '../index.js';
import { clamp, parseBoolean, parseFiniteInteger } from './gateParseUtils.js';

export const MODEL_STREAM_DIAGNOSTICS_GATE = 'model_stream_diagnostics';

export interface ModelStreamDiagnosticsConfig {
  enabled: boolean;
  progressIntervalMs: number;
  progressChunkEvery: number;
  includeResourceSnapshotOnError: boolean;
}

export const DEFAULT_MODEL_STREAM_DIAGNOSTICS_CONFIG: ModelStreamDiagnosticsConfig =
  {
    enabled: false,
    progressIntervalMs: 15_000,
    progressChunkEvery: 128,
    includeResourceSnapshotOnError: true,
  };

const MIN_PROGRESS_INTERVAL_MS = 1_000;
const MAX_PROGRESS_INTERVAL_MS = 300_000;
const MIN_PROGRESS_CHUNK_EVERY = 1;
const MAX_PROGRESS_CHUNK_EVERY = 10_000;

let currentGateValue: ModelStreamDiagnosticsConfig =
  DEFAULT_MODEL_STREAM_DIAGNOSTICS_CONFIG;
let lastResolvedRawValue: unknown;

function parseGateValue(
  value: unknown,
): ModelStreamDiagnosticsConfig | undefined {
  if (value == null) {
    return DEFAULT_MODEL_STREAM_DIAGNOSTICS_CONFIG;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return DEFAULT_MODEL_STREAM_DIAGNOSTICS_CONFIG;
    const enabled = parseBoolean(trimmed);
    if (enabled !== undefined) {
      return { ...DEFAULT_MODEL_STREAM_DIAGNOSTICS_CONFIG, enabled };
    }
    try {
      value = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }

  const enabled = parseBoolean(value);
  if (enabled !== undefined) {
    return { ...DEFAULT_MODEL_STREAM_DIAGNOSTICS_CONFIG, enabled };
  }

  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const parsedEnabled =
    parseBoolean(record['enabled']) ??
    DEFAULT_MODEL_STREAM_DIAGNOSTICS_CONFIG.enabled;
  const parsedIncludeResourceSnapshotOnError =
    parseBoolean(record['include_resource_snapshot_on_error']) ??
    parseBoolean(record['includeResourceSnapshotOnError']) ??
    parseBoolean(record['resourceSnapshotOnError']) ??
    DEFAULT_MODEL_STREAM_DIAGNOSTICS_CONFIG.includeResourceSnapshotOnError;
  const progressIntervalMs =
    parseFiniteInteger(record['progress_interval_ms']) ??
    parseFiniteInteger(record['progressIntervalMs']) ??
    DEFAULT_MODEL_STREAM_DIAGNOSTICS_CONFIG.progressIntervalMs;
  const progressChunkEvery =
    parseFiniteInteger(record['progress_chunk_every']) ??
    parseFiniteInteger(record['progressChunkEvery']) ??
    DEFAULT_MODEL_STREAM_DIAGNOSTICS_CONFIG.progressChunkEvery;

  return {
    enabled: parsedEnabled,
    progressIntervalMs: clamp(
      progressIntervalMs,
      MIN_PROGRESS_INTERVAL_MS,
      MAX_PROGRESS_INTERVAL_MS,
    ),
    progressChunkEvery: clamp(
      progressChunkEvery,
      MIN_PROGRESS_CHUNK_EVERY,
      MAX_PROGRESS_CHUNK_EVERY,
    ),
    includeResourceSnapshotOnError: parsedIncludeResourceSnapshotOnError,
  };
}

/**
 * Resolve the effective gate config, tolerating reads that happen before a
 * config source exists. getConfigValue() returns undefined on those early
 * startup paths; the guard below then short-circuits and leaves currentGateValue
 * untouched, so callers keep getting the safe default (enabled: false) instead of
 * a throw. Once the source is installed the subscription in
 * registerModelStreamDiagnosticsFeature() — or the next resolve call — picks up
 * the real value, making this default-safe and eventually-correct.
 */
function resolveCurrentGateValue(): ModelStreamDiagnosticsConfig {
  const freshValue = getConfigValue(MODEL_STREAM_DIAGNOSTICS_GATE);
  if (freshValue !== undefined && freshValue !== lastResolvedRawValue) {
    lastResolvedRawValue = freshValue;
    const parsed = parseGateValue(freshValue);
    if (parsed !== undefined) {
      currentGateValue = parsed;
    }
  }
  return currentGateValue;
}

export function getModelStreamDiagnosticsConfig(): ModelStreamDiagnosticsConfig {
  return resolveCurrentGateValue();
}

export function registerModelStreamDiagnosticsFeature(): void {
  subscribeConfigValue(MODEL_STREAM_DIAGNOSTICS_GATE, (value) => {
    if (value === undefined) {
      return;
    }

    const parsed = parseGateValue(value);
    if (parsed === undefined) {
      runLogger.warn(
        '[config-service] Ignoring invalid model_stream_diagnostics feature gate value',
        { value },
      );
      return;
    }

    currentGateValue = parsed;
    runLogger.log(
      '[config-service] model_stream_diagnostics feature gate value received',
      {
        enabled: parsed.enabled,
        progressIntervalMs: parsed.progressIntervalMs,
        progressChunkEvery: parsed.progressChunkEvery,
        includeResourceSnapshotOnError:
          parsed.includeResourceSnapshotOnError,
      },
    );
  });
}

/** @internal test-only */
export function _resetModelStreamDiagnosticsFeatureForTesting(): void {
  currentGateValue = DEFAULT_MODEL_STREAM_DIAGNOSTICS_CONFIG;
  lastResolvedRawValue = undefined;
}
