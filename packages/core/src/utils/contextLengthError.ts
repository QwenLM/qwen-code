/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ContextLengthExceededInfo {
  isExceeded: boolean;
  message: string;
  actualTokens?: number;
  limitTokens?: number;
}

const MAX_COLLECT_DEPTH = 4;

const TIMEOUT_PATTERNS = [
  /\bcontext deadline exceeded\b/i,
  /\bdeadline exceeded\b/i,
  /\b(?:request|connection|read|context)\s+timed out\b/i,
  /\b(?:request|connection|read|context)\s+timeout\b/i,
  /\b(?:timeout|timed out)\s+(?:after|while|during)\b/i,
];

const CONTEXT_LENGTH_PATTERNS = [
  /\bcontext[_\s-]?length[_\s-]?exceeded\b/i,
  /\bmaximum context length\b/i,
  /\bprompt\s+(?:is\s+)?too long\b/i,
  /\binput\s+(?:token\s+)?(?:count\s+|length\s+)?(?:is\s+)?too long\b/i,
  /\brange of input length should be\b/i,
  /\btoo many tokens\b/i,
  /\btokens?\s*>\s*[\d,]+\s*(?:maximum|max|limit)\b/i,
  /\b(?:input|prompt|messages?|context)\b[^\n]{0,120}\btokens?\b[^\n]{0,120}\bexceed(?:s|ed|ing)?\b/i,
];

function parseInteger(value: string): number {
  return Number.parseInt(value.replace(/,/g, ''), 10);
}

function parseTokenCounts(text: string): {
  actualTokens?: number;
  limitTokens?: number;
} {
  const greaterThanMatch = text.match(/(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)/i);
  if (greaterThanMatch) {
    return {
      actualTokens: parseInteger(greaterThanMatch[1]!),
      limitTokens: parseInteger(greaterThanMatch[2]!),
    };
  }

  const openAiMatch = text.match(
    /maximum context length is\s*(\d[\d,]*)\s*tokens?[\s\S]*?(?:resulted in|requested|used)\s*(\d[\d,]*)\s*tokens?/i,
  );
  if (openAiMatch) {
    return {
      actualTokens: parseInteger(openAiMatch[2]!),
      limitTokens: parseInteger(openAiMatch[1]!),
    };
  }

  const maxContextLimitMatch = text.match(
    /maximum context length is\s*(\d[\d,]*)\s*tokens?/i,
  );
  if (maxContextLimitMatch) {
    return {
      limitTokens: parseInteger(maxContextLimitMatch[1]!),
    };
  }

  const inputExceedsMatch = text.match(
    /input\s+token\s+(?:count|length)[^\d]*(\d[\d,]*)[\s\S]*?exceed(?:s|ed)?[\s\S]*?(?:maximum|limit)[^\d]*(\d[\d,]*)/i,
  );
  if (inputExceedsMatch) {
    return {
      actualTokens: parseInteger(inputExceedsMatch[1]!),
      limitTokens: parseInteger(inputExceedsMatch[2]!),
    };
  }

  return {};
}

function tryParseEmbeddedJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      // Fall through to embedded-object parsing.
    }
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return undefined;
  }

  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

function collectStrings(
  value: unknown,
  seen: Set<object>,
  depth = 0,
): string[] {
  if (depth > MAX_COLLECT_DEPTH || value === null || value === undefined) {
    return [];
  }

  if (typeof value === 'string') {
    const parsed = tryParseEmbeddedJson(value);
    if (parsed === undefined) {
      return [value];
    }
    return [value, ...collectStrings(parsed, seen, depth + 1)];
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }

  if (typeof value !== 'object') {
    return [];
  }

  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  const strings: string[] = [];
  if (value instanceof Error) {
    strings.push(value.name, value.message);
    strings.push(...collectStrings(value.cause, seen, depth + 1));
  }

  for (const [, nested] of Object.entries(value)) {
    strings.push(...collectStrings(nested, seen, depth + 1));
  }

  return strings;
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export function getContextLengthExceededInfo(
  error: unknown,
): ContextLengthExceededInfo {
  const fragments = uniqueNonEmpty(collectStrings(error, new Set<object>()));
  const message = fragments.join('\n');
  const isTimeout = TIMEOUT_PATTERNS.some((pattern) => pattern.test(message));
  const isExceeded =
    !isTimeout &&
    fragments.some((fragment) =>
      CONTEXT_LENGTH_PATTERNS.some((pattern) => pattern.test(fragment)),
    );
  const counts = isExceeded ? parseTokenCounts(message) : {};

  return {
    isExceeded,
    message,
    ...counts,
  };
}

export function isContextLengthExceededError(error: unknown): boolean {
  return getContextLengthExceededInfo(error).isExceeded;
}
