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

// The escapes the JSON grammar defines, mapped to what they denote. Anything
// else after a backslash makes the body invalid JSON, and a body we cannot
// read exactly is a body we refuse to act on.
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

// The only raw control characters a proxy is known to splice into the message
// it quotes. Every other character below U+0020 makes the body invalid JSON
// for a reason we have no account of, so it fails closed.
const REPAIRABLE_CONTROLS: ReadonlySet<string> = new Set(['\n', '\t', '\r']);

// Work bounds. A gateway can echo an entire request back inside its error
// body, so both the text scanned and the number of objects considered are
// capped; exceeding either bound rejects the classification rather than
// truncating it into a guess.
const MAX_BODY_CHARS = 64_000;
const MAX_OBJECT_CANDIDATES = 32;

interface Envelope {
  readonly value: unknown;
  readonly objects: number;
}

/**
 * Classify an error body as "the endpoint refused a replayed reasoning item
 * id". Total and fail-closed: every ambiguity returns `undefined`, which
 * leaves the caller with today's behavior (surface the original error).
 *
 * The outer evidence is the HTTP status: only an exact 400 is considered, so
 * a matching body under any other status is never acted on.
 *
 * The body must be ONE well-formed top-level object -- balanced, with only
 * JSON's own escapes, and nothing but whitespace after it -- and the verdict
 * is read from that object's own `error` member alone. Text the endpoint
 * merely quoted somewhere else (a `debug` field, an example, a request it
 * echoed back) is never evidence about the request we sent.
 *
 * `JSON.parse` cannot be used directly: proxies splice raw newlines, tabs and
 * carriage returns into the message they quote, which makes the whole body
 * invalid JSON. So the body is walked once to validate it, and exactly those
 * three characters -- and only inside the one `error.message` the repair is
 * about -- are re-escaped before the result is parsed strictly. A raw control
 * character anywhere else, or any other control character even there, is
 * damage we have no account of and fails closed.
 *
 * ONE level of nesting is supported, for the gateway that quotes the upstream
 * error JSON inside its own `error.message`, and only out of that recognized
 * member.
 */
export function parseReasoningIdRejection(
  status: number,
  responseBody: unknown,
): ReasoningIdRejection | undefined {
  if (status !== 400) return undefined;
  // `responseBody` is whatever the transport handed back. Exotic values --
  // a revoked proxy, an object whose getters throw -- can make even a type
  // check or a stringification throw, and a classifier that throws would turn
  // an ordinary 400 into a crash. Every such failure is just "not a body we
  // can read".
  try {
    return classify(responseBody);
  } catch {
    return undefined;
  }
}

function classify(responseBody: unknown): ReasoningIdRejection | undefined {
  const text = toEnvelopeText(responseBody);
  if (text === undefined) return undefined;

  const envelope = readEnvelope(text, MAX_OBJECT_CANDIDATES, true);
  if (!envelope) return undefined;

  const error = readErrorMember(envelope.value);
  if (!error) return undefined;

  return (
    matchRejection(error) ??
    matchQuotedRejection(error, MAX_OBJECT_CANDIDATES - envelope.objects)
  );
}

/** The rejection declared directly by one coherent structured error object. */
function matchRejection(
  error: Record<string, unknown>,
): ReasoningIdRejection | undefined {
  if (error['code'] !== REJECTION_CODE) return undefined;
  const param = error['param'];
  if (typeof param !== 'string') return undefined;
  const named = PARAM_PATTERN.exec(param);
  if (!named) return undefined;
  const index = Number(named[1]);
  if (!Number.isSafeInteger(index) || index < 0) return undefined;
  const message = error['message'];
  return {
    namedIndex: index,
    maxLength: extractMaxLength(
      typeof message === 'string' ? message : undefined,
      param,
    ),
  };
}

/**
 * The rejection a gateway quoted inside its own `error.message`. Only that
 * one member is reopened, and only for a single object that runs to the end
 * of the message -- not for every brace the message happens to contain. The
 * quoted text is read strictly: the repair was already spent unwrapping the
 * outer message, and a second one would be a guess about a guess.
 */
function matchQuotedRejection(
  error: Record<string, unknown>,
  budget: number,
): ReasoningIdRejection | undefined {
  const message = error['message'];
  if (typeof message !== 'string') return undefined;
  const start = message.indexOf('{');
  if (start < 0) return undefined;
  const quoted = readEnvelope(message.slice(start), budget, false);
  if (!quoted) return undefined;
  const inner = readErrorMember(quoted.value);
  return inner ? matchRejection(inner) : undefined;
}

function readErrorMember(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const error = value['error'];
  return isPlainObject(error) ? error : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  // JSON's grammar admits exactly four whitespace characters around a value.
  // `String.prototype.trim` admits many more -- vertical tab, form feed,
  // no-break space -- so trimming here would quietly accept, and then act on,
  // bodies that are not JSON at all. (The trailing side is enforced by the
  // scanner, which requires JSON whitespace past the top-level object.)
  let start = 0;
  while (start < text.length && isJsonWhitespace(text[start]!)) start++;
  return text[start] === '{' ? text.slice(start) : undefined;
}

/**
 * Read `text` as exactly one top-level JSON object. Returns `undefined` for
 * anything else: an unbalanced object or string, a duplicated key,
 * non-whitespace past the top-level object, an escape JSON does not define,
 * or more than `budget` objects.
 *
 * With `repairErrorMessage`, and only then, a raw newline, tab or carriage
 * return inside the top-level `error.message` string is re-escaped instead of
 * rejected -- the one damage pattern proxies are known to produce.
 */
function readEnvelope(
  text: string,
  budget: number,
  repairErrorMessage: boolean,
): Envelope | undefined {
  const normalized = normalizeEnvelope(text, budget, repairErrorMessage);
  if (!normalized) return undefined;
  try {
    return { value: JSON.parse(normalized.json), objects: normalized.objects };
  } catch {
    return undefined;
  }
}

interface NormalizedEnvelope {
  readonly json: string;
  readonly objects: number;
}

interface Container {
  readonly object: boolean;
  readonly keys: Set<string>;
  /** True only for the object that is the top-level `error` member. */
  readonly recognizedError: boolean;
  atKey: boolean;
  /** The key whose value is being read, so a value knows its own path. */
  key: string | undefined;
}

function normalizeEnvelope(
  text: string,
  budget: number,
  repairErrorMessage: boolean,
): NormalizedEnvelope | undefined {
  const out: string[] = [];
  const stack: Container[] = [];
  let objects = 0;
  let closed = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;
    // Past the single top-level object nothing but whitespace may follow;
    // trailing garbage means we are not reading the body we think we are.
    if (closed) {
      if (!isJsonWhitespace(ch)) return undefined;
      i++;
      continue;
    }
    if (ch === '"') {
      const top = stack[stack.length - 1];
      const atKey = top?.object === true && top.atKey;
      // The repair is for one string only: the message of the top-level
      // `error` member, which is where a proxy quotes the upstream body.
      const repairable =
        repairErrorMessage &&
        top?.object === true &&
        !atKey &&
        top.recognizedError &&
        top.key === 'message';
      const literal = readStringLiteral(text, i, repairable);
      if (!literal) return undefined;
      if (top?.object && top.atKey) {
        // A key declared twice makes the object's meaning reader-dependent.
        if (top.keys.has(literal.value)) return undefined;
        top.keys.add(literal.value);
        top.atKey = false;
        top.key = literal.value;
      }
      out.push(literal.json);
      i = literal.next;
      continue;
    }
    if (ch === '{' || ch === '[') {
      const object = ch === '{';
      if (object && ++objects > budget) return undefined;
      const parent = stack[stack.length - 1];
      stack.push({
        object,
        keys: new Set(),
        recognizedError:
          object &&
          stack.length === 1 &&
          parent?.object === true &&
          parent.key === 'error',
        atKey: object,
        key: undefined,
      });
    } else if (ch === '}' || ch === ']') {
      const top = stack.pop();
      if (!top || top.object !== (ch === '}')) return undefined;
      if (stack.length === 0) closed = true;
    } else if (ch === ',') {
      const top = stack[stack.length - 1];
      if (top?.object) {
        top.atKey = true;
        top.key = undefined;
      }
    }
    out.push(ch);
    i++;
  }

  if (!closed || stack.length > 0) return undefined;
  return { json: out.join(''), objects };
}

function isJsonWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/**
 * Read one JSON string literal starting at the opening quote, returning both
 * its unescaped value and a strictly valid JSON re-encoding of it. Only the
 * escapes JSON defines are accepted. A raw control character is rejected
 * unless `repairable` says this is the proxied message and the character is
 * one of the three proxies actually splice, in which case it is kept and
 * re-escaped.
 */
function readStringLiteral(
  text: string,
  start: number,
  repairable: boolean,
): { value: string; json: string; next: number } | undefined {
  let value = '';
  let json = '"';
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') return { value, json: `${json}"`, next: i + 1 };
    if (ch === '\\') {
      const escape = text[i + 1];
      if (escape === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
        value += String.fromCharCode(parseInt(hex, 16));
        json += text.slice(i, i + 6);
        i += 6;
        continue;
      }
      const simple = escape === undefined ? undefined : SIMPLE_ESCAPES[escape];
      if (simple === undefined) return undefined;
      value += simple;
      json += `\\${escape}`;
      i += 2;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      if (!repairable || !REPAIRABLE_CONTROLS.has(ch)) return undefined;
      value += ch;
      json += `\\u${code.toString(16).padStart(4, '0')}`;
      i++;
      continue;
    }
    value += ch;
    json += ch;
    i++;
  }
  return undefined;
}

/** Metadata-only counter for the retry diagnostic. */
export function countReasoningItems(items: ResponsesApiInputItem[]): number {
  return items.filter(isReasoningItem).length;
}
