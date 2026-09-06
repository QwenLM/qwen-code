/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { resolvePath } from '@qwen-code/channel-base';

function isHomeRelative(value: string): boolean {
  return value === '~' || value.startsWith('~/') || value.startsWith('~\\');
}

export function resolveChannelCwd(
  rawCwd: string | undefined,
  defaultCwd: string,
): string {
  if (!rawCwd) return resolvePath(defaultCwd);
  if (isHomeRelative(rawCwd)) return resolvePath(rawCwd);
  return path.resolve(defaultCwd, rawCwd);
}
