/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function parseFiniteInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return undefined;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return undefined;
}

/**
 * Parse a feature-gate "enabled" value that may arrive as a boolean, a
 * string ('', 'true'/'false', '0'/'1', or a JSON payload), or an object with
 * an `enabled` field. Returns undefined when the value is unparseable so
 * callers can preserve their last known-good state.
 */
export function parseEnabledGateValue(value: unknown): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '' || normalized === 'false' || normalized === '0') {
      return false;
    }
    if (normalized === 'true' || normalized === '1') return true;
    try {
      return parseEnabledGateValue(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (typeof value !== 'object') return undefined;
  return parseEnabledGateValue((value as Record<string, unknown>)['enabled']);
}

/**
 * Parse a feature-gate value that carries a JSON object payload: either an
 * already-decoded object, or a JSON string to decode. Arrays, null, and
 * anything unparseable return undefined so callers can keep their last
 * known-good state.
 */
export function parseObjectGateValue(
  value: unknown,
): Record<string, unknown> | undefined {
  let decoded = value;
  if (typeof decoded === 'string') {
    const trimmed = decoded.trim();
    if (!trimmed) return undefined;
    try {
      decoded = JSON.parse(trimmed) as unknown;
    } catch {
      return undefined;
    }
  }
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    return undefined;
  }
  return decoded as Record<string, unknown>;
}
