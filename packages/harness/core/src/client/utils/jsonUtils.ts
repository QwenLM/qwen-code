/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ClientError, MALFORMED_RESPONSE_CODE } from '../clientError.js';

/** 通用 JSON 字段读取与响应解码。 */
export function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return recordOrNull(value) ?? {};
}

export function hasOwn(source: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

export function readJsonString(
  source: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readBoolean(
  source: Record<string, unknown> | null,
  key: string,
): boolean | undefined {
  const value = source?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function readNumber(
  source: Record<string, unknown> | null,
  key: string,
): number | undefined {
  const value = source?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function pickString(
  source: Record<string, unknown> | null,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = readJsonString(source, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function pickBoolean(
  source: Record<string, unknown> | null,
  keys: string[],
): boolean | undefined {
  for (const key of keys) {
    const value = readBoolean(source, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function pickNumber(
  source: Record<string, unknown> | null,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = readNumber(source, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function normalizePercentage(value: number | undefined): number {
  if (value === undefined) return 0;
  const percentage = value >= 0 && value <= 1 ? value * 100 : value;
  return Number(percentage.toFixed(2));
}

export function decodeResponseBody(text: string, operation: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ClientError(`${operation} returned an invalid response`, {
      code: MALFORMED_RESPONSE_CODE,
      operation,
      cause: error,
    });
  }
}
