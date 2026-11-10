/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Renderable } from '@opentui/core';
import { isRenderableWithin } from './renderable-tree.js';

const fake = (parent: Renderable | null = null): Renderable =>
  ({ parent }) as unknown as Renderable;

describe('isRenderableWithin', () => {
  it('accepts the ancestor itself and any descendant', () => {
    const root = fake();
    const middle = fake(root);
    const leaf = fake(middle);
    expect(isRenderableWithin(root, root)).toBe(true);
    expect(isRenderableWithin(leaf, root)).toBe(true);
    expect(isRenderableWithin(leaf, middle)).toBe(true);
  });

  it('rejects unrelated trees and ancestors', () => {
    const root = fake();
    expect(isRenderableWithin(fake(), root)).toBe(false);
    expect(isRenderableWithin(root, fake())).toBe(false);
  });
});
