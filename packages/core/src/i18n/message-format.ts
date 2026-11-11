/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageParams } from './i18n-service.js';

const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

export type MessageToken =
  | { kind: 'text'; value: string }
  | { kind: 'placeholder'; name: string };

export function tokenizeMessage(template: string): readonly MessageToken[] {
  const tokens: MessageToken[] = [];
  let cursor = 0;

  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const index = match.index;
    if (index > cursor) {
      tokens.push({ kind: 'text', value: template.slice(cursor, index) });
    }
    tokens.push({ kind: 'placeholder', name: match[1] });
    cursor = index + match[0].length;
  }

  if (cursor < template.length) {
    tokens.push({ kind: 'text', value: template.slice(cursor) });
  }

  return tokens;
}

export function formatMessage(
  template: string,
  params: MessageParams = {},
): string {
  return tokenizeMessage(template)
    .map((token) => {
      if (token.kind === 'text') return token.value;
      const value = params[token.name];
      return value === undefined ? `{${token.name}}` : String(value);
    })
    .join('');
}

export function getPlaceholderNames(template: string): readonly string[] {
  return tokenizeMessage(template)
    .filter((token) => token.kind === 'placeholder')
    .map((token) => token.name);
}
