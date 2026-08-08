/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { dispatchRowMouseEvent } from './mouse-rows.js';
import type { ListHitGeometry } from './mouse-hit.js';

const geometry: ListHitGeometry = {
  container: { x: 0, y: 0, width: 30, height: 4 },
  items: [
    { index: 0, top: 0, height: 1 },
    { index: 1, top: 1, height: 2 }, // multi-line
    { index: 2, top: 3, height: 1 },
  ],
};

function makeProps(isDisabled?: (index: number) => boolean) {
  return {
    geometry,
    isDisabled,
    onHoverIndex: vi.fn(),
    onSelectIndex: vi.fn(),
  };
}

describe('mouse-rows: menu/dialog/completion hover + click (RowMouseController parity)', () => {
  it('move dispatches hover for the row under the pointer', () => {
    const props = makeProps();
    expect(
      dispatchRowMouseEvent({ name: 'move', point: { x: 5, y: 0 } }, props),
    ).toBe(0);
    expect(props.onHoverIndex).toHaveBeenCalledWith(0);
    expect(props.onSelectIndex).not.toHaveBeenCalled();
  });

  it('left-press dispatches select for the row under the pointer', () => {
    const props = makeProps();
    expect(
      dispatchRowMouseEvent(
        { name: 'left-press', point: { x: 5, y: 2 } },
        props,
      ),
    ).toBe(1);
    expect(props.onSelectIndex).toHaveBeenCalledWith(1);
    expect(props.onHoverIndex).not.toHaveBeenCalled();
  });

  it('multi-line items resolve across their whole span', () => {
    const props = makeProps();
    expect(
      dispatchRowMouseEvent({ name: 'move', point: { x: 5, y: 1 } }, props),
    ).toBe(1);
    expect(
      dispatchRowMouseEvent({ name: 'move', point: { x: 5, y: 2 } }, props),
    ).toBe(1);
  });

  it('ignores interactions outside the container columns', () => {
    const props = makeProps();
    expect(
      dispatchRowMouseEvent({ name: 'move', point: { x: 40, y: 0 } }, props),
    ).toBeNull();
    expect(props.onHoverIndex).not.toHaveBeenCalled();
    expect(props.onSelectIndex).not.toHaveBeenCalled();
  });

  it('skips disabled rows', () => {
    const props = makeProps((index) => index === 1);
    expect(
      dispatchRowMouseEvent({ name: 'move', point: { x: 5, y: 2 } }, props),
    ).toBeNull();
    expect(props.onHoverIndex).not.toHaveBeenCalled();
  });

  it('returns null on a gap row (nothing dispatched)', () => {
    const gapped: ListHitGeometry = {
      container: geometry.container,
      items: [
        { index: 0, top: 0, height: 1 },
        { index: 1, top: 3, height: 1 },
      ],
    };
    const props = { ...makeProps(), geometry: gapped };
    expect(
      dispatchRowMouseEvent({ name: 'move', point: { x: 5, y: 2 } }, props),
    ).toBeNull();
  });
});
