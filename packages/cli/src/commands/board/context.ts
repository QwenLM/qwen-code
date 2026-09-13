/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { assertSafeName } from '@qwen-code/qwen-code-core/board';

export function requireBoardName(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new Error('Pass --board <name>.');
  }
  assertSafeName('board name', value);
  return value;
}

export function requireActorName(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new Error('Pass --as <name>.');
  }
  assertSafeName('actor name', value);
  return value;
}
