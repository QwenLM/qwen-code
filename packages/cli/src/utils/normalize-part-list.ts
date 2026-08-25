/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part, PartListUnion } from '@google/genai';

/**
 * Normalizes various part list formats into a consistent Part[] array.
 *
 * @param parts - Input parts in various formats (string, Part, Part[], or null)
 * @returns Normalized array of Part objects
 */
export function normalizePartList(parts: PartListUnion | null): Part[] {
  if (!parts) {
    return [];
  }

  if (typeof parts === 'string') {
    return [{ text: parts }];
  }

  if (Array.isArray(parts)) {
    return parts.map((part) =>
      typeof part === 'string' ? { text: part } : (part as Part),
    );
  }

  return [parts as Part];
}
