/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function toUnicodeEscapedString(input: string): string {
  let output = '';

  for (const char of input) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }

    if (codePoint >= 0x20 && codePoint <= 0x7e) {
      output += char;
      continue;
    }

    if (codePoint <= 0xffff) {
      output += `\\u${codePoint.toString(16).padStart(4, '0')}`;
      continue;
    }

    const value = codePoint - 0x10000;
    const high = 0xd800 + (value >> 10);
    const low = 0xdc00 + (value & 0x3ff);
    output += `\\u${high.toString(16).padStart(4, '0')}\\u${low
      .toString(16)
      .padStart(4, '0')}`;
  }

  return output;
}

export function shouldUseUnicodeEscapedPaths(model?: string): boolean {
  if (!model) {
    return false;
  }

  const normalized = model.trim().toLowerCase();
  return (
    normalized.includes('qwen3.5-plus') ||
    normalized.includes('qwen3.5-397b-a17b')
  );
}

export function decodeUnicodeEscapedString(input: string): string {
  if (!input.includes('\\u')) {
    return input;
  }

  const collapsed = input.replace(/\\\\u([0-9a-fA-F]{4})/g, '\\u$1');

  return collapsed.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

export function buildUnicodeMappingSection(
  values: string[],
  title: string,
): string {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);

    const escaped = toUnicodeEscapedString(value);
    if (escaped !== value) {
      lines.push(`${value} => ${escaped}`);
    }
  }

  if (lines.length === 0) {
    return '';
  }

  return `\n---\n${title}:\n${lines.join('\n')}`;
}
