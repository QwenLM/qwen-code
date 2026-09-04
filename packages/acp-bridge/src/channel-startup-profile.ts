/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CHANNEL_STARTUP_PROFILE_META_KEY,
  CHANNEL_STARTUP_PROFILE_VERSION,
  type ChannelStartupProfileV1,
} from './bridgeTypes.js';
import type { BridgeTelemetryAttributes } from './bridgeOptions.js';

const MAX_PROFILE_DURATION_MS = 600_000;
const ATTRIBUTE_PREFIX = 'qwen-code.daemon.acp_startup';

type ProfileDurations = Record<string, number>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readDuration(
  source: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = source[key];
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_PROFILE_DURATION_MS
    ? value
    : undefined;
}

function readDurations(
  source: unknown,
  keys: readonly string[],
): { values: ProfileDurations; complete: boolean } {
  if (!isRecord(source)) {
    return { values: {}, complete: false };
  }
  const values: ProfileDurations = {};
  let complete = true;
  for (const key of keys) {
    const value = readDuration(source, key);
    if (value === undefined) {
      complete = false;
    } else {
      values[key] = value;
    }
  }
  return { values, complete };
}

function addDurationAttributes(
  attributes: BridgeTelemetryAttributes,
  group: 'phase' | 'config',
  values: ProfileDurations,
): void {
  for (const [key, value] of Object.entries(values)) {
    if (group === 'phase' && key === 'unattributedMs') continue;
    const attributeKey = key.replace(
      /[A-Z]/g,
      (letter) => `_${letter.toLowerCase()}`,
    );
    attributes[`${ATTRIBUTE_PREFIX}.${group}.${attributeKey}`] = value;
  }
}

const PHASE_KEYS = [
  'processToProfilerReadyMs',
  'geminiImportMs',
  'argsParseMs',
  'settingsLoadMs',
  'configConstructionMs',
  'appInitializationMs',
  'acpImportMs',
  'bootstrapConfigInitializationMs',
  'transportSetupMs',
  'initializeHandlerMs',
  'unattributedMs',
] as const satisfies ReadonlyArray<keyof ChannelStartupProfileV1['phases']>;

const CONFIG_KEYS = [
  'extensionsInitialMs',
  'hooksMs',
  'skillsMs',
  'extensionsFinalMs',
  'hierarchicalMemoryMs',
  'toolRegistryMs',
  'ripgrepProbeMs',
  'toolWarmupMs',
  'otherMs',
] as const satisfies ReadonlyArray<keyof ChannelStartupProfileV1['config']>;

export function getChannelStartupProfileAttributes(
  response: unknown,
  receivedAtEpochMs: number,
  initializeTimeoutMs: number,
): BridgeTelemetryAttributes | undefined {
  if (!isRecord(response) || !isRecord(response['_meta'])) {
    return undefined;
  }
  const profile = response['_meta'][CHANNEL_STARTUP_PROFILE_META_KEY];
  if (!isRecord(profile) || profile['v'] !== CHANNEL_STARTUP_PROFILE_VERSION) {
    return undefined;
  }

  const phases = readDurations(profile['phases'], PHASE_KEYS);
  const config = readDurations(profile['config'], CONFIG_KEYS);
  const processToResponseMs = readDuration(profile, 'processToResponseMs');
  const responseBuiltAtEpochMs = profile['responseBuiltAtEpochMs'];
  const childComplete = profile['complete'] === true;
  const validResponseEpoch =
    typeof responseBuiltAtEpochMs === 'number' &&
    Number.isFinite(responseBuiltAtEpochMs) &&
    responseBuiltAtEpochMs >= 0;
  const effectiveComplete =
    childComplete &&
    phases.complete &&
    config.complete &&
    processToResponseMs !== undefined &&
    validResponseEpoch;

  const attributes: BridgeTelemetryAttributes = {
    [`${ATTRIBUTE_PREFIX}.profile.version`]: CHANNEL_STARTUP_PROFILE_VERSION,
    [`${ATTRIBUTE_PREFIX}.profile.complete`]: effectiveComplete,
  };
  if (processToResponseMs !== undefined) {
    attributes[`${ATTRIBUTE_PREFIX}.child.process_to_response_ms`] =
      processToResponseMs;
  }
  if (phases.values['unattributedMs'] !== undefined) {
    attributes[`${ATTRIBUTE_PREFIX}.child.unattributed_ms`] =
      phases.values['unattributedMs'];
  }
  addDurationAttributes(attributes, 'phase', phases.values);
  addDurationAttributes(attributes, 'config', config.values);

  if (validResponseEpoch) {
    const transportMs = receivedAtEpochMs - responseBuiltAtEpochMs;
    if (
      Number.isFinite(transportMs) &&
      transportMs >= 0 &&
      transportMs <= initializeTimeoutMs
    ) {
      attributes[`${ATTRIBUTE_PREFIX}.response_transport_ms`] = transportMs;
    }
  }

  return attributes;
}
