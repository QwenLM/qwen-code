/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * YAML repair utilities for frontmatter parsing.
 *
 * LLMs frequently generate malformed YAML in frontmatter blocks:
 * - Multiline strings (`|` or `>`) containing colons that get mis-parsed
 * - Values with special characters (`:`, `#`, `{`, `}`, etc.) not quoted
 * - Mixed tab/space indentation
 * - Trailing whitespace
 *
 * This module performs best-effort repair so frontmatter can be parsed.
 */

const MULTILINE_INDICATORS = new Set([
  '|',
  '>',
  '|+',
  '>+',
  '|-',
  '>-',
  '|2',
  '>2',
]);

/** Characters that require quoting when they appear at the start of a value. */
const SPECIAL_STARTERS = new Set([
  '&',
  '*',
  '!',
  '?',
  '[',
  '{',
  '|',
  '>',
  '%',
  '@',
  '`',
  "'",
  '"',
]);

/**
 * Repair a YAML string, fixing common LLM-generated formatting issues.
 * Also usable as `repairYamlFrontmatter` — the two names are aliases.
 */
export function yamlRepair(text: string): string {
  const lines = text.split('\n');
  const repairedLines: string[] = [];

  let inMultilineBlock = false;
  let multilineIndent = 0;
  let multilineKey = '';
  let multilineKeyIndent = '';
  let multilineContent = '';

  const flushMultiline = (): void => {
    if (multilineKey) {
      const content = multilineContent.trim();
      if (content) {
        repairedLines.push(
          `${multilineKeyIndent}${multilineKey}: ${escapeYamlString(content)}`,
        );
      } else {
        repairedLines.push(`${multilineKeyIndent}${multilineKey}: ""`);
      }
      multilineContent = '';
      multilineKey = '';
      inMultilineBlock = false;
    }
  };

  for (const line of lines) {
    const normalizedLine = line.replace(/\t/g, '  ').trimEnd();

    if (normalizedLine.trim() === '') {
      if (inMultilineBlock) {
        multilineContent += ' ';
      } else {
        repairedLines.push(normalizedLine);
      }
      continue;
    }

    const trimmed = normalizedLine.trimStart();
    if (trimmed.startsWith('#')) {
      if (inMultilineBlock) flushMultiline();
      repairedLines.push(normalizedLine);
      continue;
    }

    const currentIndent = getIndentLevel(normalizedLine);

    if (inMultilineBlock) {
      if (currentIndent > multilineIndent) {
        if (multilineContent.length > 0) multilineContent += ' ';
        multilineContent += normalizedLine.trim();
        continue;
      } else {
        flushMultiline();
      }
    }

    const kv = splitKeyValue(normalizedLine);
    if (!kv) {
      repairedLines.push(normalizedLine);
      continue;
    }

    const { keyWithIndent, key, value } = kv;

    if (isMultilineIndicator(value)) {
      multilineKey = key.trim();
      multilineKeyIndent = getIndent(normalizedLine);
      multilineIndent = currentIndent;
      inMultilineBlock = true;
      continue;
    }

    if (needsQuoting(value)) {
      repairedLines.push(`${keyWithIndent}: ${escapeYamlString(value)}`);
    } else {
      repairedLines.push(normalizedLine);
    }
  }

  flushMultiline();

  return repairedLines.join('\n');
}

/** Alias for `yamlRepair` — used by callers working with frontmatter specifically. */
export const repairYamlFrontmatter = yamlRepair;

function getIndent(line: string): string {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    i++;
  }
  return line.slice(0, i);
}

function getIndentLevel(line: string): number {
  let count = 0;
  for (const char of line) {
    if (char === ' ') count++;
    else if (char === '\t') count += 2;
    else break;
  }
  return count;
}

function isMultilineIndicator(value: string): boolean {
  return MULTILINE_INDICATORS.has(value.trim());
}

function needsQuoting(value: string): boolean {
  if (!value) return false;

  // Already quoted
  if (value.length >= 2) {
    if (
      (value[0] === '"' && value[value.length - 1] === '"') ||
      (value[0] === "'" && value[value.length - 1] === "'")
    ) {
      return false;
    }
  }

  if (MULTILINE_INDICATORS.has(value.trim())) return false;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === ':' && i + 1 < value.length && value[i + 1] === ' ')
      return true;
    if (char === ':' && i === value.length - 1) return true;
    if (char === '#') return true;
  }

  // Starts with special character (multiline indicators already returned false above)
  const firstChar = value[0];
  if (firstChar && SPECIAL_STARTERS.has(firstChar)) return true;

  return false;
}

function escapeYamlString(s: string): string {
  let result = '"';
  for (const char of s) {
    switch (char) {
      case '"':
        result += '\\"';
        break;
      case '\\':
        result += '\\\\';
        break;
      case '\n':
        result += '\\n';
        break;
      case '\r':
        result += '\\r';
        break;
      case '\t':
        result += '\\t';
        break;
      default:
        result += char;
    }
  }
  return result + '"';
}

/**
 * Split a YAML line into key and value parts.
 * Returns null if not a valid `key: value` line.
 */
function splitKeyValue(
  line: string,
): { keyWithIndent: string; key: string; value: string } | null {
  const trimmed = line.trimStart();
  if (!trimmed || trimmed.startsWith('#')) return null;

  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (char === ':' && !inSingleQuote && !inDoubleQuote) {
      if (
        i + 1 >= trimmed.length ||
        trimmed[i + 1] === ' ' ||
        trimmed[i + 1] === '\t'
      ) {
        const indent = getIndent(line);
        const key = trimmed.slice(0, i);
        const value = i + 1 < trimmed.length ? trimmed.slice(i + 1).trim() : '';
        return { keyWithIndent: indent + key, key, value };
      }
    }
  }

  return null;
}
