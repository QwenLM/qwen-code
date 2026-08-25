/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ResponsesApiInputItem,
  ResponsesApiReasoningItem,
} from './types.js';

/**
 * A 400 in which the endpoint named one replayed `input[N].id` as being over
 * its own maximum id length. `maxLength` is `null` unless the SAME message
 * unambiguously associates a maximum with that parameter.
 */
export interface ReasoningIdRejection {
  readonly namedIndex: number;
  readonly maxLength: number | null;
}

const REJECTION_CODE = 'string_above_max_length';
const PARAM_PATTERN = /^input\[(\d+)\]\.id$/;
const PARAM_REFERENCE_PATTERN = /input\[\d+\]\.id/g;
const MAXIMUM_LENGTH_PATTERN = /maximum length \d+/gi;
const RELEVANT_KEYS = new Set(['code', 'param', 'message']);

// Work bounds. A gateway can echo an entire request back inside its error
// body, so both the text scanned and the number of objects considered are
// capped; exceeding either bound rejects the classification rather than
// truncating it into a guess.
const MAX_BODY_CHARS = 64_000;
const MAX_OBJECT_CANDIDATES = 32;

interface RelevantFields {
  code?: string;
  param?: string;
  message?: string;
}

/**
 * Classify an error body as "the endpoint refused a replayed reasoning item
 * id". Total and fail-closed: every ambiguity returns `undefined`, which
 * leaves the caller with today's behavior (surface the original error).
 *
 * The outer evidence is the HTTP status: only an exact 400 is considered, so
 * a matching body under any other status is never acted on.
 *
 * Two body shapes are supported: the API's own JSON, and ONE level of a
 * gateway that quotes the upstream error JSON inside its own error message.
 * The nested shape cannot be read with `JSON.parse` -- proxies splice raw
 * newlines and tabs into that quoted message, which makes the whole body
 * invalid JSON -- so the body is walked with a quote/escape-aware scanner
 * that ignores braces inside strings and tolerates raw control characters.
 * A loose whole-body regex is deliberately not used: `code` and `param` must
 * come from the same object, or the classification is rejected.
 */
export function parseReasoningIdRejection(
  status: number,
  responseBody: unknown,
): ReasoningIdRejection | undefined {
  if (status !== 400) return undefined;

  const text = toEnvelopeText(responseBody);
  if (text === undefined) return undefined;

  const spans = collectObjectSpans(text, MAX_OBJECT_CANDIDATES);
  if (spans === undefined) return undefined;
  // One nesting level only: rescan quoted strings that could carry an
  // embedded error object, sharing the same candidate budget.
  for (const embedded of collectEmbeddedStrings(text)) {
    const nested = collectObjectSpans(
      embedded,
      MAX_OBJECT_CANDIDATES - spans.length,
    );
    if (nested === undefined) return undefined;
    spans.push(...nested);
  }

  let match: { index: number; param: string; message?: string } | undefined;
  for (const span of spans) {
    const fields = readRelevantFields(span);
    // A duplicated `code`/`param`/`message` (or an unterminated string) means
    // the body cannot be read unambiguously.
    if (fields === undefined) return undefined;
    if (fields.code !== REJECTION_CODE || fields.param === undefined) continue;
    const named = PARAM_PATTERN.exec(fields.param);
    if (!named) continue;
    const index = Number(named[1]);
    if (!Number.isSafeInteger(index) || index < 0) continue;
    // A second matching object means two different rejections; refuse both.
    if (match) return undefined;
    match = { index, param: fields.param, message: fields.message };
  }
  if (!match) return undefined;

  return {
    namedIndex: match.index,
    maxLength: extractMaxLength(match.message, match.param),
  };
}

/**
 * Replace the reasoning items the endpoint will refuse with the ordinary
 * assistant messages their summaries carry, preserving position and leaving
 * every other item byte-exact and identical by reference. Returns `items`
 * itself when nothing is downgraded, so the caller can detect a no-op by
 * identity. Never mutates `items` or anything inside it.
 */
export function downgradeRejectedReasoningItems(
  items: ResponsesApiInputItem[],
  rejection: ReasoningIdRejection,
): ResponsesApiInputItem[] {
  const named = items[rejection.namedIndex];
  // The endpoint named an item that is not a reasoning item in the body we
  // actually sent, so this rejection is about something else.
  if (!isReasoningItem(named)) return items;

  const { maxLength } = rejection;
  // A reported maximum the named id does not exceed contradicts the
  // rejection; do not rewrite history on it.
  if (maxLength !== null && named.id.length <= maxLength) return items;

  const rewritten: ResponsesApiInputItem[] = [];
  let changed = false;
  for (const item of items) {
    if (!isReasoningItem(item) || !exceedsMax(item, maxLength)) {
      rewritten.push(item);
      continue;
    }
    changed = true;
    const summary = readSummaryTexts(item);
    // A signature-only item has nothing human-readable to preserve; keeping
    // it as an empty assistant message would add a blank turn.
    if (summary.length === 0) continue;
    rewritten.push({
      type: 'message',
      role: 'assistant',
      content: summary.join('\n'),
    });
  }
  return changed ? rewritten : items;
}

function exceedsMax(
  item: ResponsesApiReasoningItem,
  maxLength: number | null,
): boolean {
  // No trustworthy maximum: every replayed reasoning item is suspect.
  return maxLength === null || item.id.length > maxLength;
}

function isReasoningItem(
  item: ResponsesApiInputItem | undefined,
): item is ResponsesApiReasoningItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    item.type === 'reasoning' &&
    typeof (item as ResponsesApiReasoningItem).id === 'string'
  );
}

function readSummaryTexts(item: ResponsesApiReasoningItem): string[] {
  if (!Array.isArray(item.summary)) return [];
  const texts: string[] = [];
  for (const entry of item.summary) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      entry.type === 'summary_text' &&
      typeof entry.text === 'string' &&
      entry.text.length > 0
    ) {
      texts.push(entry.text);
    }
  }
  return texts;
}

/**
 * A maximum is trusted only when the matched message names exactly one
 * `input[N].id` -- the matched one -- and exactly one maximum. Anything else
 * (a maximum quoted for a different parameter, or two parameters sharing one
 * sentence) is an association we cannot verify.
 */
function extractMaxLength(
  message: string | undefined,
  param: string,
): number | null {
  if (!message) return null;
  const references = message.match(PARAM_REFERENCE_PATTERN);
  if (!references || references.length !== 1 || references[0] !== param) {
    return null;
  }
  const maxima = message.match(MAXIMUM_LENGTH_PATTERN);
  if (!maxima || maxima.length !== 1) return null;
  const digits = /\d+/.exec(maxima[0]);
  if (!digits) return null;
  const value = Number(digits[0]);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

/**
 * Normalize the body to the text to scan. A primitive or array body is not
 * the structured error envelope this classifier is allowed to act on.
 */
function toEnvelopeText(responseBody: unknown): string | undefined {
  let text: string;
  if (typeof responseBody === 'string') {
    text = responseBody;
  } else if (
    typeof responseBody === 'object' &&
    responseBody !== null &&
    !Array.isArray(responseBody)
  ) {
    try {
      text = JSON.stringify(responseBody);
    } catch {
      return undefined;
    }
    if (typeof text !== 'string') return undefined;
  } else {
    return undefined;
  }
  if (text.length > MAX_BODY_CHARS) return undefined;
  const trimmed = text.trim();
  return trimmed.startsWith('{') ? trimmed : undefined;
}

/**
 * Every balanced `{...}` region, ignoring braces inside strings. Returns
 * `undefined` when the budget is exhausted, so an oversized body fails closed
 * instead of being classified from a truncated view of itself.
 */
function collectObjectSpans(
  text: string,
  budget: number,
): string[] | undefined {
  const spans: string[] = [];
  const starts: number[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const literal = readStringLiteral(text, i);
      if (!literal) break;
      i = literal.next;
      continue;
    }
    if (ch === '{') {
      if (starts.length >= budget) return undefined;
      starts.push(i);
    } else if (ch === '}') {
      const start = starts.pop();
      if (start !== undefined) {
        if (spans.length >= budget) return undefined;
        spans.push(text.slice(start, i + 1));
      }
    }
    i++;
  }
  return spans;
}

/** Unescaped string literals that could themselves contain an error object. */
function collectEmbeddedStrings(text: string): string[] {
  const embedded: string[] = [];
  let i = 0;
  while (i < text.length && embedded.length < MAX_OBJECT_CANDIDATES) {
    if (text[i] !== '"') {
      i++;
      continue;
    }
    const literal = readStringLiteral(text, i);
    if (!literal) break;
    if (literal.value.includes('{')) embedded.push(literal.value);
    i = literal.next;
  }
  return embedded;
}

/**
 * The `code`/`param`/`message` string values declared directly on one object
 * (nested objects are skipped whole, so an outer envelope never inherits its
 * child's fields). `undefined` means the object is unreadable or declares a
 * relevant key twice.
 */
function readRelevantFields(span: string): RelevantFields | undefined {
  const fields: RelevantFields = {};
  const seen = new Set<string>();
  let i = 1;
  while (i < span.length) {
    const ch = span[i];
    if (ch === '}') break;
    if (ch !== '"') {
      i++;
      continue;
    }
    const key = readStringLiteral(span, i);
    if (!key) return undefined;
    i = skipWhitespace(span, key.next);
    if (span[i] !== ':') continue;
    i = skipWhitespace(span, i + 1);

    let value: string | undefined;
    if (span[i] === '"') {
      const literal = readStringLiteral(span, i);
      if (!literal) return undefined;
      value = literal.value;
      i = literal.next;
    } else {
      i = skipValue(span, i);
    }

    if (!RELEVANT_KEYS.has(key.value)) continue;
    if (seen.has(key.value)) return undefined;
    seen.add(key.value);
    if (value !== undefined) {
      fields[key.value as keyof RelevantFields] = value;
    }
  }
  return fields;
}

/**
 * Read one JSON string literal starting at the opening quote and return its
 * unescaped value. A raw newline or tab inside the literal is kept as-is
 * rather than rejected -- that is exactly the shape proxies emit.
 */
function readStringLiteral(
  text: string,
  start: number,
): { value: string; next: number } | undefined {
  let value = '';
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') return { value, next: i + 1 };
    if (ch !== '\\') {
      value += ch;
      i++;
      continue;
    }
    const escape = text[i + 1];
    if (escape === undefined) return undefined;
    switch (escape) {
      case 'n':
        value += '\n';
        break;
      case 't':
        value += '\t';
        break;
      case 'r':
        value += '\r';
        break;
      case 'b':
        value += '\b';
        break;
      case 'f':
        value += '\f';
        break;
      case 'u': {
        const hex = text.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          value += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        value += escape;
        break;
      }
      default:
        // Covers \" \\ \/ and any unknown escape.
        value += escape;
        break;
    }
    i += 2;
  }
  return undefined;
}

/** Skip a non-string value, including a nested object or array. */
function skipValue(text: string, start: number): number {
  let i = start;
  let depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const literal = readStringLiteral(text, i);
      if (!literal) return text.length;
      i = literal.next;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      if (depth === 0) return i;
      depth--;
      if (depth === 0) return i + 1;
    } else if (ch === ',' && depth === 0) {
      return i + 1;
    }
    i++;
  }
  return i;
}

function skipWhitespace(text: string, start: number): number {
  let i = start;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}

/** Metadata-only counter for the retry diagnostic. */
export function countReasoningItems(items: ResponsesApiInputItem[]): number {
  return items.filter(isReasoningItem).length;
}
