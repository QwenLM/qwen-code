/**
 * @license
 * Copyright 2026 Alibaba Group Holding Limited
 * SPDX-License-Identifier: Apache-2.0
 */

import { Jieba } from '@node-rs/jieba';
// eslint-disable-next-line import/no-internal-modules -- Documented dictionary entry point shipped by the package.
import { dict } from '@node-rs/jieba/dict.js';

let tokenizer: Jieba | undefined;

export function initializeTokenizer(): void {
  tokenizer ??= Jieba.withDict(dict);
}

export function stripNoise(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/giu, ' ')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/giu, ' ')
    .replace(/<think>\s*<\/think>/giu, ' ')
    .replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/giu, ' ')
    .replace(/\b(?:oss|https?|s3|file):\/\/\S+/giu, ' ')
    .replace(/<\/?[A-Za-z][A-Za-z0-9_.:-]*[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function segment(text: unknown): string[] {
  const cleaned = stripNoise(text);
  if (!cleaned) return [];
  initializeTokenizer();
  return tokenizer!
    .cutForSearch(cleaned, true)
    .map((token) => token.trim())
    .filter((token) => /[\p{L}\p{N}]/u.test(token));
}

export function indexText(text: unknown): string {
  return segment(text).join(' ');
}

export function queryTerms(query: unknown): string[] {
  return [...new Set(segment(query))];
}
