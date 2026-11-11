/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

/// <reference path="../types.d.ts" />
import { c as _c } from 'react/compiler-runtime';

/**
 * Adds one or more newline (\n) characters. Must be used within <Text> components.
 */
export default function Newline(t0: any) {
  const $ = _c(4);
  const { count: t1 } = t0;
  const count = t1 === undefined ? 1 : t1;
  let t2;
  if ($[0] !== count) {
    t2 = '\n'.repeat(count);
    $[0] = count;
    $[1] = t2;
  } else {
    t2 = $[1];
  }
  let t3;
  if ($[2] !== t2) {
    t3 = <ink-text>{t2}</ink-text>;
    $[2] = t2;
    $[3] = t3;
  } else {
    t3 = $[3];
  }
  return t3;
}
