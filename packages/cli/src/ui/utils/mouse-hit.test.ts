/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { type DOMElement } from 'ink';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findElementAtMouseEvent } from './mouse-hit.js';
import {
  layoutRowForEvent,
  measureElementPosition,
} from './measure-element-position.js';

vi.mock('./measure-element-position.js', () => ({
  layoutRowForEvent: vi.fn(),
  measureElementPosition: vi.fn(),
}));

describe('findElementAtMouseEvent', () => {
  const container = { tag: 'container' } as unknown as DOMElement;
  const first = { tag: 'first' } as unknown as DOMElement;
  const second = { tag: 'second' } as unknown as DOMElement;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(layoutRowForEvent).mockReturnValue(4);
    vi.mocked(measureElementPosition).mockImplementation((node) => {
      if (node === container) return { x: 2, y: 4, width: 16, height: 2 };
      if (node === first) return { x: 2, y: 4, width: 6, height: 1 };
      return { x: 10, y: 4, width: 6, height: 1 };
    });
  });

  it('maps 1-based SGR columns and uses full child rectangles for tabs', () => {
    expect(
      findElementAtMouseEvent(
        container,
        [first, second],
        { col: 10, row: 5 },
        40,
        'rect',
      ),
    ).toBeNull();
    expect(
      findElementAtMouseEvent(
        container,
        [first, second],
        { col: 11, row: 5 },
        40,
        'rect',
      ),
    ).toBe(1);
  });

  it('keeps the right and bottom rectangle edges exclusive', () => {
    expect(
      findElementAtMouseEvent(
        container,
        [first, second],
        { col: 9, row: 5 },
        40,
        'rect',
      ),
    ).toBeNull();

    vi.mocked(layoutRowForEvent).mockReturnValue(5);
    expect(
      findElementAtMouseEvent(
        container,
        [first, second],
        { col: 3, row: 6 },
        40,
        'rect',
      ),
    ).toBeNull();
  });

  it('ignores mouse events before the container ref is attached', () => {
    expect(
      findElementAtMouseEvent(null, [first], { col: 3, row: 5 }, 40, 'row'),
    ).toBeNull();
    expect(layoutRowForEvent).not.toHaveBeenCalled();
  });

  it('passes terminal height into the shared layout mapping', () => {
    findElementAtMouseEvent(container, [first], { col: 3, row: 5 }, 40, 'row');

    expect(layoutRowForEvent).toHaveBeenCalledWith(container, 5, 40);
  });

  it('uses child rows after the container column bound for list rows', () => {
    expect(
      findElementAtMouseEvent(
        container,
        [first, second],
        { col: 9, row: 5 },
        40,
        'row',
      ),
    ).toBe(0);
    expect(
      findElementAtMouseEvent(
        container,
        [first, second],
        { col: 19, row: 5 },
        40,
        'row',
      ),
    ).toBeNull();
  });

  it('returns full-list indices for a visible row slice', () => {
    expect(
      findElementAtMouseEvent(
        container,
        [first, second],
        { col: 3, row: 5 },
        40,
        'row',
        7,
      ),
    ).toBe(7);
  });

  it('keeps zero-width list rows hittable through their container width', () => {
    vi.mocked(measureElementPosition).mockImplementation((node) =>
      node === container
        ? { x: 2, y: 4, width: 16, height: 1 }
        : { x: 2, y: 4, width: 0, height: 1 },
    );

    expect(
      findElementAtMouseEvent(
        container,
        [first],
        { col: 9, row: 5 },
        40,
        'row',
      ),
    ).toBe(0);
  });

  it('ignores missing and degenerate child elements', () => {
    vi.mocked(measureElementPosition).mockImplementation((node) => {
      if (node === null) {
        throw new Error('null children must not be measured');
      }
      return node === container
        ? { x: 0, y: 0, width: 20, height: 2 }
        : { x: 0, y: 4, width: 0, height: 1 };
    });

    expect(
      findElementAtMouseEvent(
        container,
        [null, first],
        { col: 1, row: 5 },
        40,
        'rect',
      ),
    ).toBeNull();
  });
});
