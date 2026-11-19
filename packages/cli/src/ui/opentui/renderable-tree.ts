/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Renderable } from '@opentui/core';

/** Whether `node` is `ancestor` or sits below it in the render tree. */
export function isRenderableWithin(
  node: Renderable,
  ancestor: Renderable,
): boolean {
  for (
    let current: Renderable | null = node;
    current;
    current = current.parent as Renderable | null
  ) {
    if (current === ancestor) return true;
  }
  return false;
}
