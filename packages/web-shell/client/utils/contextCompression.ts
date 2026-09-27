/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Structured companion to the English sentence `/compress` streams over ACP.
 *
 * The daemon ships on its own release cadence, so this is parsed defensively:
 * an unreadable payload falls back to rendering the sentence as before rather
 * than dropping the message.
 */
export interface ContextCompressionResult {
  originalTokenCount: number;
  newTokenCount: number;
  originalTokenCountIsEstimated: boolean;
  newTokenCountIsEstimated: boolean;
  /** Server-authored advisory. Free-form text, not a translation key. */
  warning?: string;
}

export type ContextCompressionMeta =
  | { phase: 'notice'; instructionsLimit: number }
  | { phase: 'progress' }
  | { phase: 'noop' }
  | { phase: 'done'; result: ContextCompressionResult };

export function parseContextCompressionMeta(
  value: unknown,
): ContextCompressionMeta | undefined {
  if (!isRecord(value)) return undefined;
  if (value['phase'] === 'notice') {
    const instructionsLimit = toCount(value['instructionsLimit']);
    return instructionsLimit === undefined
      ? undefined
      : { phase: 'notice', instructionsLimit };
  }
  if (value['phase'] === 'progress') return { phase: 'progress' };
  if (value['phase'] === 'noop') return { phase: 'noop' };
  if (value['phase'] !== 'done') return undefined;
  const result = parseContextCompressionResult(value);
  return result ? { phase: 'done', result } : undefined;
}

function parseContextCompressionResult(
  value: unknown,
): ContextCompressionResult | undefined {
  if (!isRecord(value)) return undefined;
  const originalTokenCount = toCount(value['originalTokenCount']);
  const newTokenCount = toCount(value['newTokenCount']);
  if (originalTokenCount === undefined || newTokenCount === undefined) {
    return undefined;
  }
  const warning = value['warning'];
  return {
    originalTokenCount,
    newTokenCount,
    originalTokenCountIsEstimated:
      value['originalTokenCountIsEstimated'] === true,
    newTokenCountIsEstimated: value['newTokenCountIsEstimated'] === true,
    ...(typeof warning === 'string' && warning.length > 0 ? { warning } : {}),
  };
}

/**
 * Token count for a compression line, grouped for the UI language rather than
 * the browser's locale. `~` marks a locally estimated count, the same
 * convention the TUI banner uses (#9309).
 */
export function formatCompressionTokens(
  count: number,
  isEstimated: boolean,
  language: string,
): string {
  return `${isEstimated ? '~' : ''}${count.toLocaleString(language)}`;
}

/** A finite, non-negative integer count — token totals and character limits. */
function toCount(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
