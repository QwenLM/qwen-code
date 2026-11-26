/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

/**
 * Builds a stable, RFC 4122 v5-shaped UUID from structured identity parts.
 * NUL framing prevents boundaries between adjacent parts from being ambiguous.
 */
export function deterministicUUID(parts: readonly string[]): string {
  const bytes = Buffer.from(
    createHash('sha256')
      .update(parts.join('\0'))
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
