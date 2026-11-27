/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { truncateString } from '../utils/textUtils.js';
import { SCRIPT_LIMITS, type JsonObject, type JsonValue } from './types.js';

const MAX_STRING_LENGTH = 512;
const MAX_ITEMS = 20;
const MAX_DEPTH = 4;

/** A detached, bounded input preview for transcripts, never for execution. */
export function snapshotCallArgs(input: Record<string, unknown>): {
  args: JsonObject;
  argsTruncated?: boolean;
} {
  let remaining = SCRIPT_LIMITS.summaryArgumentBytes;
  let truncated = false;

  const copy = (value: unknown, depth: number): JsonValue | undefined => {
    if (typeof value === 'string') {
      let preview = truncateString(value, MAX_STRING_LENGTH, '…');
      let bytes = Buffer.byteLength(JSON.stringify(preview));
      if (bytes > remaining) {
        // A UTF-16 code unit takes at most six bytes after JSON escaping.
        preview = truncateString(
          value,
          Math.max(0, Math.floor((remaining - 5) / 6)),
          '…',
        );
        bytes = Buffer.byteLength(JSON.stringify(preview));
      }
      if (bytes > remaining) {
        truncated = true;
        return undefined;
      }
      truncated ||= preview !== value;
      remaining -= bytes;
      return preview;
    }
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (bytes <= remaining) {
        remaining -= bytes;
        return value;
      }
    } else if (typeof value === 'object' && remaining >= 2) {
      remaining -= 2;
      const array = Array.isArray(value);
      const keys = Object.keys(value);
      const entries: Array<[string, JsonValue]> = [];
      const limit = depth < MAX_DEPTH ? MAX_ITEMS : 0;
      truncated ||= keys.length > limit;
      for (const key of keys.slice(0, limit)) {
        const overhead =
          (entries.length ? 1 : 0) +
          (array ? 0 : Buffer.byteLength(JSON.stringify(key)) + 1);
        if (overhead >= remaining) {
          truncated = true;
          continue;
        }
        remaining -= overhead;
        const child = copy((value as Record<string, unknown>)[key], depth + 1);
        if (child === undefined) {
          remaining += overhead;
          // An array preview is a prefix; do not shift later elements forward.
          if (array) break;
        } else {
          entries.push([key, child]);
        }
      }
      return array
        ? entries.map(([, child]) => child)
        : Object.fromEntries(entries);
    }
    truncated = true;
    return undefined;
  };

  const args = copy(input, 0) as JsonObject;
  return { args, ...(truncated ? { argsTruncated: true } : {}) };
}
