/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import type { DOMElement } from './dom.js';

type Output = {
  /**
   * Element width.
   */
  width: number;

  /**
   * Element height.
   */
  height: number;
};

/**
 * Walk to the Ink root and compute layout if a commit has dirtied it.
 *
 * Layout runs once per frame rather than once per commit, so a caller reading
 * geometry between the two (e.g. from a layout effect when a dialog mounts)
 * would otherwise see the previous frame's numbers.
 */
function ensureLayoutFor(node: DOMElement): void {
  let current: DOMElement = node;
  while (current.parentNode) current = current.parentNode;
  current.ensureLayout?.();
}

/**
 * Measure the dimensions of a particular `<Box>` element.
 */
const measureElement = (node: DOMElement): Output => {
  ensureLayoutFor(node);
  return {
    width: node.yogaNode?.getComputedWidth() ?? 0,
    height: node.yogaNode?.getComputedHeight() ?? 0,
  };
};

export default measureElement;
