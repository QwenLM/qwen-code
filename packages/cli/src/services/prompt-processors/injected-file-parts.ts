/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part, PartUnion } from '@google/genai';

// File data must remain opaque to later template interpolation.
const injectedFileParts = new WeakSet<object>();

export function markInjectedFilePart(part: PartUnion): Part {
  const content = typeof part === 'string' ? { text: part } : part;
  injectedFileParts.add(content);
  return content;
}

export function isInjectedFilePart(part: PartUnion): boolean {
  return typeof part !== 'string' && injectedFileParts.has(part);
}
