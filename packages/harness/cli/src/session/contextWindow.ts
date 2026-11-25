/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type ParsedContextWindowControlValue =
  | { kind: 'missing' }
  | { kind: 'clear' }
  | { kind: 'set'; value: number }
  | { kind: 'invalid'; raw: unknown };

export function parseContextWindow(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

export function parseContextWindowControlValue(
  request: Record<string, unknown>,
): ParsedContextWindowControlValue {
  const hasCamel = Object.prototype.hasOwnProperty.call(
    request,
    'contextWindow',
  );
  const hasSnake = Object.prototype.hasOwnProperty.call(
    request,
    'context_window',
  );
  if (!hasCamel && !hasSnake) {
    return { kind: 'missing' };
  }

  const raw = hasCamel ? request['contextWindow'] : request['context_window'];
  if (raw === null) {
    return { kind: 'clear' };
  }

  const parsed = parseContextWindow(raw);
  return parsed === undefined
    ? { kind: 'invalid', raw }
    : { kind: 'set', value: parsed };
}
