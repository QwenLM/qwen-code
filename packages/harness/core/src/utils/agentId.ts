/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';

/** Generate an opaque instance ID for agent transcripts and runtime events. */
export function createAgentId(): string {
  return `a${randomBytes(8).toString('hex')}`;
}
