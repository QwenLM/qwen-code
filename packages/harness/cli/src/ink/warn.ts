/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { logForDebugging } from './stubs/debug.js';

export function ifNotInteger(value: number | undefined, name: string): void {
  if (value === undefined) return;
  if (Number.isInteger(value)) return;
  logForDebugging(`${name} should be an integer, got ${value}`, {
    level: 'warn',
  });
}
