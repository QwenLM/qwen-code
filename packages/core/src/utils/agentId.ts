/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';

/**
 * Generate a unique agent instance ID.
 *
 * Format: `a{label-}{16 hex chars}`
 * - Prefix is always `a`
 * - Optional label (e.g. agent definition name) separated by `-`
 * - Suffix is 16 hex characters from `crypto.randomBytes(8)`
 *
 * @param label Optional human-readable label (e.g. agent definition name)
 */
export function createAgentId(label?: string): string {
  const hex = crypto.randomBytes(8).toString('hex');
  return label ? `a${label}-${hex}` : `a${hex}`;
}
