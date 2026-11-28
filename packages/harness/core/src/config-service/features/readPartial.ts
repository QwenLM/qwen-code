/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { getConfigValue } from '../index.js';
import { parseObjectGateValue } from './gateParseUtils.js';

export const READ_PARTIAL_FEATURE_GATE = 'read_partial';
export interface ReadPartialDecision {
  enabled: boolean;
  source: 'env' | 'invalid_env' | 'qcs' | 'missing' | 'invalid' | 'unavailable' | 'ineligible';
}

/** Synchronous cache lookup on each Read; never retains a previous enablement. */
export function resolveReadPartialGate(eligible: boolean): ReadPartialDecision {
  const env = process.env['OPEN_READ_PARTIAL'];
  if (env !== undefined) {
    return { enabled: env === '1', source: env === '0' || env === '1' ? 'env' : 'invalid_env' };
  }
  const off = (source: ReadPartialDecision['source']): ReadPartialDecision =>
    ({ enabled: false, source });
  if (!eligible) return off('ineligible');
  let raw: unknown;
  try { raw = getConfigValue(READ_PARTIAL_FEATURE_GATE); }
  catch { return off('unavailable'); }
  if (raw === undefined || raw === null) return off('missing');
  const value = parseObjectGateValue(raw);
  if (!value || typeof value['enabled'] !== 'boolean') return off('invalid');
  return { enabled: value['enabled'], source: 'qcs' };
}
