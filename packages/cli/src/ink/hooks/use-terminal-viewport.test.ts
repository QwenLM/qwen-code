/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { describe, expect, it } from 'vitest';
import type { DOMElement } from '../dom.js';
import { computeTerminalViewportVisibility } from './use-terminal-viewport.js';

type ElementOptions = {
  top: number;
  height: number;
  parent?: DOMElement;
  scrollTop?: number;
};

function createElement({
  top,
  height,
  parent,
  scrollTop,
}: ElementOptions): DOMElement {
  return {
    yogaNode: {
      getComputedTop: () => top,
      getComputedHeight: () => height,
    },
    parentNode: parent,
    scrollTop,
  } as unknown as DOMElement;
}

describe('computeTerminalViewportVisibility', () => {
  it('returns null until both the element and terminal size are available', () => {
    expect(computeTerminalViewportVisibility(null, { columns: 80, rows: 24 })).toBe(
      null,
    );
    expect(
      computeTerminalViewportVisibility(
        createElement({ top: 0, height: 1 }),
        null,
      ),
    ).toBe(null);
  });

  it('detects an element intersecting a non-overflowing screen', () => {
    const root = createElement({ top: 0, height: 8 });
    const element = createElement({ top: 2, height: 3, parent: root });

    expect(
      computeTerminalViewportVisibility(element, { columns: 80, rows: 10 }),
    ).toBe(true);
  });

  it('includes the cursor-restore row in the overflow boundary', () => {
    const root = createElement({ top: 0, height: 20 });
    const lastScrollbackRow = createElement({
      top: 10,
      height: 1,
      parent: root,
    });
    const firstActiveRow = createElement({ top: 11, height: 1, parent: root });

    expect(
      computeTerminalViewportVisibility(lastScrollbackRow, {
        columns: 80,
        rows: 10,
      }),
    ).toBe(false);
    expect(
      computeTerminalViewportVisibility(firstActiveRow, {
        columns: 80,
        rows: 10,
      }),
    ).toBe(true);
  });

  it('keeps a multi-line element live while any row intersects the viewport', () => {
    const root = createElement({ top: 0, height: 20 });
    const element = createElement({ top: 8, height: 4, parent: root });

    expect(
      computeTerminalViewportVisibility(element, { columns: 80, rows: 10 }),
    ).toBe(true);
  });

  it('subtracts ancestor scroll offsets from the Yoga position', () => {
    const root = createElement({ top: 0, height: 20 });
    const scrollContainer = createElement({
      top: 0,
      height: 20,
      parent: root,
      scrollTop: 5,
    });
    const element = createElement({
      top: 15,
      height: 1,
      parent: scrollContainer,
    });

    expect(
      computeTerminalViewportVisibility(element, { columns: 80, rows: 10 }),
    ).toBe(false);
  });

  it('treats a zero-height node as a point at its top edge', () => {
    const root = createElement({ top: 0, height: 20 });
    const atViewportTop = createElement({ top: 11, height: 0, parent: root });
    const atViewportBottom = createElement({ top: 21, height: 0, parent: root });

    expect(
      computeTerminalViewportVisibility(atViewportTop, {
        columns: 80,
        rows: 10,
      }),
    ).toBe(true);
    expect(
      computeTerminalViewportVisibility(atViewportBottom, {
        columns: 80,
        rows: 10,
      }),
    ).toBe(false);
  });
});
