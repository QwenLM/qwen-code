/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

export function managedCommandId(value: string): string {
  if (value.length <= 128) return value;
  const split = value.codePointAt(55)! > 0xffff ? 55 : 56;
  let prefix = value.slice(0, split);
  while (Buffer.from(prefix, 'utf8').toString('utf8') !== prefix) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}:sha256:${createHash('sha256').update(value).digest('hex')}`;
}
