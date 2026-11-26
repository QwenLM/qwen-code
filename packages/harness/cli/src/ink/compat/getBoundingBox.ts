/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import type { DOMElement } from '../dom.js';

/**
 * Get the bounding box of a DOMElement relative to the viewport.
 *
 * The ink engine doesn't have a dedicated `getBoundingBox` — this utility
 * walks up the yoga layout tree to compute the element's absolute position
 * (left, top) and reads its computed width/height.
 */
export function getBoundingBox(node: DOMElement): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const yogaNode = node.yogaNode;
  if (!yogaNode) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  // Called from mouse handlers, which fire between frames. Layout is only
  // recomputed per frame now, so hit-testing has to ask for it explicitly or
  // a click during a fast stream would resolve against stale rectangles.
  let root: DOMElement = node;
  while (root.parentNode) root = root.parentNode;
  root.ensureLayout?.();

  const width = yogaNode.getComputedWidth();
  const height = yogaNode.getComputedHeight();

  // Walk up the layout tree to compute absolute position
  let x = yogaNode.getComputedLeft();
  let y = yogaNode.getComputedTop();

  let parent = node.parentNode;
  while (parent) {
    if (parent.yogaNode) {
      x += parent.yogaNode.getComputedLeft();
      y += parent.yogaNode.getComputedTop();
    }
    parent = parent.parentNode;
  }

  return { x, y, width, height };
}
