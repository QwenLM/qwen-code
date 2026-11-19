/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { isAtScrollTail, JumpToBottomHint } from './jump-to-bottom-hint.js';

const buildJsxRuntime = vi.hoisted(() => async () => {
  const React = await import('react');
  const jsx = (
    type: unknown,
    props: Record<string, unknown> | null,
    key?: React.Key,
  ) => {
    const config = key === undefined ? props : { ...props, key };
    const children = config?.['children'] as React.ReactNode;
    const { children: _children, ...rest } = config ?? {};
    if (type === 'box' || type === 'text') {
      return React.createElement(
        type === 'box' ? 'div' : 'span',
        rest,
        children,
      );
    }
    return React.createElement(
      type as React.ElementType,
      { ...rest, ...(key === undefined ? {} : { key }) },
      children,
    );
  };
  return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
});

vi.mock('@opentui/react/jsx-runtime', () => buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => buildJsxRuntime());
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

function fakeScrollBox() {
  let onChange: (() => void) | null = null;
  const box = {
    scrollTop: 0,
    scrollHeight: 100,
    viewport: { height: 20 },
    verticalScrollBar: {
      on: (_event: string, handler: () => void) => {
        onChange = handler;
      },
      off: vi.fn(),
    },
    scrollTo: vi.fn((position: number) => {
      box.scrollTop = position;
    }),
  };
  return {
    box: box as unknown as ScrollBoxRenderable,
    fireChange: () => onChange?.(),
    raw: box,
  };
}

describe('isAtScrollTail', () => {
  it('is true when content fits and at the maximum offset', () => {
    expect(isAtScrollTail(0, 10, 20)).toBe(true);
    expect(isAtScrollTail(80, 100, 20)).toBe(true);
  });

  it('is false one row above the tail', () => {
    expect(isAtScrollTail(79, 100, 20)).toBe(false);
  });
});

describe('JumpToBottomHint', () => {
  it('appears away from the tail and hides back at it', () => {
    const { box, fireChange, raw } = fakeScrollBox();
    render(<JumpToBottomHint scrollRef={{ current: box }} bottom={3} />);

    expect(screen.getByText(/Jump to bottom/)).toBeTruthy();

    act(() => {
      raw.scrollTop = 80;
      fireChange();
    });
    expect(screen.queryByText(/Jump to bottom/)).toBeNull();
  });

  it('clicking the hint jumps to the bottom', () => {
    const { box, fireChange, raw } = fakeScrollBox();
    render(<JumpToBottomHint scrollRef={{ current: box }} bottom={3} />);

    fireEvent.mouseUp(screen.getByText(/Jump to bottom/).parentElement!);
    expect(raw.scrollTo).toHaveBeenCalledWith(100);
    act(() => {
      fireChange();
    });
    expect(screen.queryByText(/Jump to bottom/)).toBeNull();
  });

  it('reports visibility so other bottom-right chrome can stack above it', () => {
    const onVisibilityChange = vi.fn();
    const { box, fireChange, raw } = fakeScrollBox();
    render(
      <JumpToBottomHint
        scrollRef={{ current: box }}
        bottom={3}
        onVisibilityChange={onVisibilityChange}
      />,
    );

    expect(onVisibilityChange).toHaveBeenLastCalledWith(true);

    act(() => {
      raw.scrollTop = 80;
      fireChange();
    });
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
  });
});
