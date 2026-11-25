/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

export function managedCommandId(value: string): string {
  return value.length <= 128
    ? value
    : `${value.slice(0, 56)}:sha256:${createHash('sha256').update(value).digest('hex')}`;
}
