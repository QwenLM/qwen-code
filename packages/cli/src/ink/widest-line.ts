/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { lineWidth } from './line-width-cache.js';

export function widestLine(string: string): number {
  let maxWidth = 0;
  let start = 0;

  while (start <= string.length) {
    const end = string.indexOf('\n', start);
    const line =
      end === -1 ? string.substring(start) : string.substring(start, end);

    maxWidth = Math.max(maxWidth, lineWidth(line));

    if (end === -1) break;
    start = end + 1;
  }

  return maxWidth;
}
