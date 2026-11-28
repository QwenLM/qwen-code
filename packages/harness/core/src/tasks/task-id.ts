/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';

/** Create the public identifier used by local Bash and Monitor tasks. */
export function createLocalBashTaskId(): string {
  const value = randomBytes(5).readUIntBE(0, 5);
  return `b${value.toString(36).padStart(8, '0').slice(-8)}`;
}
