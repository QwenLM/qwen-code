/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { type MutableRefObject } from 'react';
import { type DOMElement } from 'ink';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionCategoryMouseController } from './CompletionCategoryMouseController.js';
import { useMouseEvents } from '../hooks/useMouseEvents.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import {
  layoutRowForEvent,
  measureElementPosition,
} from '../utils/measure-element-position.js';
import { type MouseEvent } from '../utils/mouse.js';

vi.mock('../hooks/useMouseEvents.js', () => ({ useMouseEvents: vi.fn() }));
vi.mock('../hooks/useTerminalSize.js', () => ({ useTerminalSize: vi.fn() }));
vi.mock('../utils/measure-element-position.js', () => ({
  layoutRowForEvent: vi.fn(),
  measureElementPosition: vi.fn(),
}));

const ref = <T,>(current: T): MutableRefObject<T> => ({ current });

function makeEvent(
  partial: Partial<MouseEvent> & Pick<MouseEvent, 'name'>,
): MouseEvent {
  return {
    col: 1,
    row: 1,
    shift: false,
    meta: false,
    ctrl: false,
    button: 'left',
    ...partial,
  } as MouseEvent;
}

describe('CompletionCategoryMouseController', () => {
  const containerNode = { tag: 'container' } as unknown as DOMElement;
  const categoryNodes = [
    { tag: 'all' },
    { tag: 'file' },
    { tag: 'session' },
  ] as unknown as DOMElement[];
  const categories = ['all', 'file', 'session'] as const;
  let onSelectCategory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onSelectCategory = vi.fn();
    vi.mocked(useTerminalSize).mockReturnValue({ rows: 40, columns: 80 });
    vi.mocked(layoutRowForEvent).mockImplementation(
      (_node, terminalRow) => terminalRow - 1,
    );
    vi.mocked(measureElementPosition).mockImplementation((node) => {
      const index = categoryNodes.indexOf(node);
      return { x: 2 + index * 8, y: 4, width: 6, height: 1 };
    });
  });

  function mountAndGetHandler(): (event: MouseEvent) => void {
    render(
      <CompletionCategoryMouseController
        containerRef={ref(containerNode)}
        categoryRefs={ref(categoryNodes)}
        categories={categories}
        onSelectCategory={onSelectCategory}
      />,
    );
    const call = vi.mocked(useMouseEvents).mock.calls.at(-1)!;
    expect(call[1]).toMatchObject({ isActive: true, tracking: 'button' });
    return call[0];
  }

  it('selects the exact category under a left click', () => {
    const handler = mountAndGetHandler();

    handler(makeEvent({ name: 'left-press', col: 19, row: 5 }));

    expect(onSelectCategory).toHaveBeenCalledWith('session');
  });

  it('ignores clicks outside category bounds', () => {
    const handler = mountAndGetHandler();

    handler(makeEvent({ name: 'left-press', col: 9, row: 5 }));
    handler(makeEvent({ name: 'left-press', col: 19, row: 6 }));

    expect(onSelectCategory).not.toHaveBeenCalled();
  });

  it('ignores non-press mouse events', () => {
    const handler = mountAndGetHandler();

    handler(makeEvent({ name: 'move', col: 19, row: 5 }));
    handler(makeEvent({ name: 'left-release', col: 19, row: 5 }));

    expect(onSelectCategory).not.toHaveBeenCalled();
  });
});
