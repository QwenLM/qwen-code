/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const entry = value[key];
  return typeof entry === 'string' ? entry : undefined;
}

export function getFirstString(
  value: unknown,
  keys: readonly string[],
): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === 'string' && entry.trim().length > 0) {
      return entry;
    }
  }
  return undefined;
}

export function stringifyJson(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function getTextContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return '';
  const text = value['text'];
  return typeof text === 'string' ? text : '';
}

const MAX_OUTPUT_TEXT_DEPTH = 64;

export function getOutputText(value: unknown, depth = 0): string {
  if (depth > MAX_OUTPUT_TEXT_DEPTH) return '[output truncated]';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => getOutputText(entry, depth + 1))
      .filter(Boolean)
      .join('\n');
  }
  if (!isRecord(value)) return value === undefined ? '' : stringifyJson(value);

  for (const key of ['text', 'output', 'stdout', 'stderr', 'rawOutput']) {
    const entry = value[key];
    if (typeof entry === 'string') return entry;
  }

  const content = value['content'];
  if (content !== undefined) {
    const nested = getOutputText(content, depth + 1);
    if (nested) return nested;
  }

  return stringifyJson(value);
}

export function sanitizeTerminalText(text: string): string {
  return text
    .replace(bidiControlPattern, '')
    .replace(oscSequencePattern, '')
    .replace(dcsSequencePattern, '')
    .replace(csiSequencePattern, '')
    .replace(controlCharactersPattern, '');
}

export function stripOscSequences(text: string): string {
  return text.replace(oscSequencePattern, '');
}

const nul = String.fromCharCode(0x00);
const backspace = String.fromCharCode(0x08);
const verticalTab = String.fromCharCode(0x0b);
const formFeed = String.fromCharCode(0x0c);
const shiftOut = String.fromCharCode(0x0e);
const unitSeparator = String.fromCharCode(0x1f);
const deleteChar = String.fromCharCode(0x7f);
const c1End = String.fromCharCode(0x9f);
const escapeChar = String.fromCharCode(0x1b);
const bell = String.fromCharCode(0x07);

const controlCharactersPattern = new RegExp(
  `[${nul}-${backspace}${verticalTab}${formFeed}${shiftOut}-${unitSeparator}${deleteChar}-${c1End}]`,
  'g',
);

const oscSequencePattern = new RegExp(
  `${escapeChar}\\][\\s\\S]*?(?:${bell}|${escapeChar}\\\\)`,
  'g',
);
const dcsSequencePattern = new RegExp(
  `${escapeChar}P[\\s\\S]*?${escapeChar}\\\\`,
  'g',
);
const csiSequencePattern = new RegExp(`${escapeChar}\\[[0-?]*[ -/]*[@-~]`, 'g');
const bidiControlPattern = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
