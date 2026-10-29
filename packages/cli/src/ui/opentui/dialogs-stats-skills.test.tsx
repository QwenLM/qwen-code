/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The standalone /stats dialog scrolls its tab body inside a row budget so
 * the Tokens and Models sections stay reachable on short terminals (#13074),
 * while the Settings embed keeps the unscrolled body and its own up key.
 */

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import type { Config } from '@qwen-code/qwen-code-core';

const mocks = vi.hoisted(() => {
  const state = {
    keyboardHandlers: [] as Array<(key: unknown) => void>,
    // Rows the body reports through onSizeChange, as OpenTUI layout would.
    contentRows: 100,
    scroller: {
      scrollBy: vi.fn(),
      scrollTo: vi.fn(),
    },
  };
  async function buildJsxRuntime() {
    const React = await import('react');
    // Stands in for the native scrollbox: records its budget and hands the
    // dialog a fake renderable through the ref, as OpenTUI would.
    const ScrollBox = (props: {
      height?: number;
      focusable?: boolean;
      children?: React.ReactNode;
      ref?: React.Ref<unknown>;
    }) => {
      React.useImperativeHandle(props.ref, () => state.scroller);
      return React.createElement(
        'div',
        {
          'data-testid': 'scrollbox',
          'data-height': props.height,
          'data-focusable': String(props.focusable),
        },
        props.children,
      );
    };
    // Stands in for the measured body box: reports its layout height after
    // every render, as OpenTUI layout re-fires onSizeChange when the height
    // changes (tab switch, telemetry update).
    const Measured = (props: {
      onSizeChange?: (this: { height: number }) => void;
      children?: React.ReactNode;
    }) => {
      React.useEffect(() => {
        props.onSizeChange?.call({ height: state.contentRows });
      });
      return React.createElement('div', null, props.children);
    };
    const jsx = (
      type: unknown,
      props: Record<string, unknown> | null,
      key?: React.Key,
    ) => {
      const children = (props?.['children'] ?? null) as React.ReactNode;
      if (type === 'box' && props?.['onSizeChange']) {
        return React.createElement(Measured, { ...props, key }, children);
      }
      if (type === 'box' || type === 'text') {
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          key === undefined ? null : { key },
          children,
        );
      }
      if (type === 'scrollbox') {
        return React.createElement(ScrollBox, { ...props, key }, children);
      }
      return React.createElement(
        type as React.ElementType,
        key === undefined ? props : { ...props, key },
        children,
      );
    };
    return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
  }
  return { state, buildJsxRuntime };
});

vi.mock('@opentui/react', () => ({
  useKeyboard: (handler: (key: unknown) => void) => {
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.keyboardHandlers.push(handler);
  },
  useRenderer: () => ({
    addInputHandler: () => {},
    removeInputHandler: () => {},
  }),
}));
vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
// theme.ts builds a SyntaxStyle at module scope, which needs the OpenTUI
// native FFI; stub the surface it touches.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));
vi.mock('./key-map.js', () => ({
  toOriginalKey: (key: { name?: string; shift?: boolean }) => ({
    name: key?.name ?? '',
    shift: !!key?.shift,
  }),
}));

import {
  computeStatsBodyRows,
  OpenTuiStatsDialog,
} from './dialogs-stats-skills.js';

const CONFIG = { getSessionId: () => undefined } as unknown as Config;

const send = (name: string, shift = false) => {
  act(() => {
    for (const handler of mocks.state.keyboardHandlers)
      handler({ name, shift });
  });
};

describe('OpenTuiStatsDialog scrolling', () => {
  beforeEach(() => {
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.contentRows = 100;
    mocks.state.scroller.scrollBy.mockClear();
    mocks.state.scroller.scrollTo.mockClear();
  });

  it('budgets the body from the popup region minus the dialog chrome', () => {
    // An 80x24 terminal leaves a 19-row region; a 40-row one leaves 35.
    expect(computeStatsBodyRows(35)).toBe(27);
    expect(computeStatsBodyRows(19)).toBe(11);
    // The frame is unshrinkable, so a tiny region leaves the body nothing
    // rather than pushing the border past the region's clip.
    expect(computeStatsBodyRows(5)).toBe(0);
  });

  it('wraps the body in a scrollbox sized from the region budget', () => {
    const { getByTestId, getByText } = render(
      <OpenTuiStatsDialog
        config={CONFIG}
        onClose={() => {}}
        availableTerminalHeight={15}
      />,
    );
    const box = getByTestId('scrollbox');
    expect(box.getAttribute('data-height')).toBe('7');
    // A focusable scrollbox would also handle arrows after a click, doubling them.
    expect(box.getAttribute('data-focusable')).toBe('false');
    // The last Session sections, the ones a short terminal used to clip,
    // live inside the scrolled region.
    expect(box.textContent).toContain('Tokens');
    expect(getByText('tab · ↑↓ scroll · esc')).toBeTruthy();
  });

  it('is content-sized and hides the scroll hint when the body fits', () => {
    mocks.state.contentRows = 20;
    const { getByTestId, getByText, queryByText } = render(
      <OpenTuiStatsDialog
        config={CONFIG}
        onClose={() => {}}
        availableTerminalHeight={48}
      />,
    );
    // Not padded out to the 40-row budget.
    expect(getByTestId('scrollbox').getAttribute('data-height')).toBe('20');
    expect(getByText('tab · esc')).toBeTruthy();
    expect(queryByText('tab · ↑↓ scroll · esc')).toBeNull();
  });

  it('caps at the budget and shows the hint when the body overflows', () => {
    mocks.state.contentRows = 30;
    const { getByTestId, getByText } = render(
      <OpenTuiStatsDialog
        config={CONFIG}
        onClose={() => {}}
        availableTerminalHeight={15}
      />,
    );
    expect(getByTestId('scrollbox').getAttribute('data-height')).toBe('7');
    expect(getByText('tab · ↑↓ scroll · esc')).toBeTruthy();
  });

  it('does not advertise scrolling when the region leaves the body no rows', () => {
    mocks.state.contentRows = 30;
    const { getByText, queryByText } = render(
      <OpenTuiStatsDialog
        config={CONFIG}
        onClose={() => {}}
        availableTerminalHeight={6}
      />,
    );
    expect(getByText('tab · esc')).toBeTruthy();
    expect(queryByText('tab · ↑↓ scroll · esc')).toBeNull();
  });

  it('scrolls the body with up/down/pageup/pagedown', () => {
    render(
      <OpenTuiStatsDialog
        config={CONFIG}
        onClose={() => {}}
        availableTerminalHeight={15}
      />,
    );
    send('down');
    send('up');
    send('pagedown');
    send('pageup');
    expect(mocks.state.scroller.scrollBy.mock.calls).toEqual([
      [1],
      [-1],
      [6],
      [-6],
    ]);
  });

  it('steps a page by one row when the region leaves a single body row', () => {
    // Region 9 is the smallest with a non-zero budget (one body row); the
    // page step must not floor to 0 or PageUp/PageDown go dead there.
    render(
      <OpenTuiStatsDialog
        config={CONFIG}
        onClose={() => {}}
        availableTerminalHeight={9}
      />,
    );
    send('pagedown');
    send('pageup');
    expect(mocks.state.scroller.scrollBy.mock.calls).toEqual([[1], [-1]]);
  });

  it('does not advertise scrolling when the body exactly fits the budget', () => {
    // contentRows === bodyRows: the scrollbox cannot move, so the hint must
    // not promise a scroll.
    mocks.state.contentRows = 7;
    const { getByText, queryByText } = render(
      <OpenTuiStatsDialog
        config={CONFIG}
        onClose={() => {}}
        availableTerminalHeight={15}
      />,
    );
    expect(getByText('tab · esc')).toBeTruthy();
    expect(queryByText('tab · ↑↓ scroll · esc')).toBeNull();
  });

  it('re-measures the body when the tab changes', () => {
    const { getByTestId, getByText, queryByText } = render(
      <OpenTuiStatsDialog
        config={CONFIG}
        onClose={() => {}}
        availableTerminalHeight={15}
      />,
    );
    expect(getByTestId('scrollbox').getAttribute('data-height')).toBe('7');
    expect(getByText('tab · ↑↓ scroll · esc')).toBeTruthy();
    // The Activity body is shorter and fits the budget: the scrollbox
    // follows its new height and the hint stops promising a scroll.
    mocks.state.contentRows = 5;
    send('tab');
    expect(getByTestId('scrollbox').getAttribute('data-height')).toBe('5');
    expect(getByText('tab · esc')).toBeTruthy();
    expect(queryByText('tab · ↑↓ scroll · esc')).toBeNull();
  });

  it('returns to the top when the tab changes', () => {
    const { getByTestId } = render(
      <OpenTuiStatsDialog
        config={CONFIG}
        onClose={() => {}}
        availableTerminalHeight={15}
      />,
    );
    send('pagedown');
    send('tab');
    expect(mocks.state.scroller.scrollTo).toHaveBeenCalledWith(0);
    // The Activity tab body renders inside the scroll container too.
    expect(getByTestId('scrollbox').textContent).toContain(
      'Activity (this session)',
    );
    expect(getByTestId('scrollbox').textContent).toContain('Requests:');
  });

  it('keeps the embedded body unscrolled and ignores the arrow keys', () => {
    const { queryByTestId, getByText } = render(
      <OpenTuiStatsDialog config={CONFIG} onClose={() => {}} />,
    );
    expect(queryByTestId('scrollbox')).toBeNull();
    expect(getByText('tab · esc')).toBeTruthy();
    send('down');
    expect(mocks.state.scroller.scrollBy).not.toHaveBeenCalled();
  });
});
