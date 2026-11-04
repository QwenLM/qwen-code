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
    // The terminal width the dialog clips its tab bar and hint to.
    width: 100,
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
        // Carry the paint and frame props the suite asserts on.
        const attrs: Record<string, unknown> = {
          'data-fg': props?.['fg'],
          'data-bg': props?.['bg'],
          'data-wrap-mode': props?.['wrapMode'],
          'data-padding-top': props?.['paddingTop'],
          'data-padding-bottom': props?.['paddingBottom'],
          'data-border':
            props?.['border'] === undefined
              ? undefined
              : JSON.stringify(props['border']),
        };
        if (key !== undefined) attrs['key'] = key;
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          attrs,
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

vi.mock('@opentui/react', async () => {
  const React = await import('react');
  return {
    // Every hook call stays registered for the component's lifetime and
    // delivers to the closure of its latest render, as OpenTUI does, so the
    // Escape hook and the dialog's own key hook are both reachable.
    useKeyboard: (handler: (key: unknown) => void) => {
      const latest = React.useRef(handler);
      latest.current = handler;
      React.useEffect(() => {
        const deliver = (key: unknown) => latest.current(key);
        mocks.state.keyboardHandlers.push(deliver);
        return () => {
          const at = mocks.state.keyboardHandlers.indexOf(deliver);
          if (at >= 0) mocks.state.keyboardHandlers.splice(at, 1);
        };
      }, []);
    },
    useRenderer: () => ({
      addInputHandler: () => {},
      removeInputHandler: () => {},
    }),
    useTerminalDimensions: () => ({ width: mocks.state.width, height: 40 }),
  };
});
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

import { C } from './theme.js';
import {
  computeStatsBodyRows,
  OpenTuiStatsDialog,
  statsTabRuns,
} from './dialogs-stats-skills.js';

const CONFIG = { getSessionId: () => undefined } as unknown as Config;

const send = (name: string, shift = false) => {
  act(() => {
    for (const handler of mocks.state.keyboardHandlers)
      handler({ name, shift });
  });
};

// Keys delivered before React re-renders, as a held Tab does.
const burst = (...names: string[]) => {
  act(() => {
    for (const name of names)
      for (const handler of mocks.state.keyboardHandlers)
        handler({ name, shift: false });
  });
};

// The tab bar's label spans, in order, with the props that paint them.
const tabBar = (container: HTMLElement) =>
  Array.from(
    container.firstElementChild?.children[0]?.querySelectorAll('span') ?? [],
  ).map((label) => ({
    text: label.textContent,
    fg: label.getAttribute('data-fg'),
    bg: label.getAttribute('data-bg'),
  }));
const activeTabs = (container: HTMLElement) =>
  tabBar(container)
    .filter((label) => label.bg === C.accent)
    .map((label) => label.text);
// The footer hint span, the last row of the frame.
const footer = (container: HTMLElement) =>
  container.firstElementChild?.lastElementChild?.querySelector('span');

describe('OpenTuiStatsDialog scrolling', () => {
  beforeEach(() => {
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.contentRows = 100;
    mocks.state.width = 100;
    mocks.state.scroller.scrollBy.mockClear();
    mocks.state.scroller.scrollTo.mockClear();
  });

  it('budgets the body from the popup region minus the dialog chrome', () => {
    // An 80x24 terminal leaves a 19-row region; a 40-row one leaves 35.
    expect(computeStatsBodyRows(35)).toBe(27);
    expect(computeStatsBodyRows(19)).toBe(11);
    // Region 9 is the shortest that pays the normal chrome and a body row.
    expect(computeStatsBodyRows(9)).toBe(1);
    // Below it the unshrinkable frame sheds padding, tab bar and hint and
    // keeps only its border (from three rows), so the body keeps content
    // rows instead of the frame pushing its border past the region's clip.
    expect(computeStatsBodyRows(8)).toBe(6);
    expect(computeStatsBodyRows(5)).toBe(3);
    expect(computeStatsBodyRows(2)).toBe(2);
  });

  it('clips the tab labels to one row, from the right, at a narrow width', () => {
    // The unclipped bar is 33 columns: three labels and two one-column gaps.
    expect(statsTabRuns(33)).toEqual([
      ' Session ',
      ' Activity ',
      ' Efficiency ',
    ]);
    expect(statsTabRuns(30)).toEqual([' Session ', ' Activity ', ' Efficie…']);
    // A label with no column left is dropped with its gap, not wrapped.
    expect(statsTabRuns(20)).toEqual([' Session ', ' Activity ', '']);
    expect(statsTabRuns(10)).toEqual([' Session ', '', '']);
    expect(statsTabRuns(5)).toEqual([' Ses…', '', '']);
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

  it('sheds the tab bar and the hint when the region cannot pay the chrome', () => {
    mocks.state.contentRows = 30;
    const { getByTestId, queryByText } = render(
      <OpenTuiStatsDialog
        config={CONFIG}
        onClose={() => {}}
        availableTerminalHeight={6}
      />,
    );
    // Border only: six rows leave the body four.
    expect(getByTestId('scrollbox').getAttribute('data-height')).toBe('4');
    expect(queryByText('Session')).toBeNull();
    expect(queryByText('tab · esc')).toBeNull();
    expect(queryByText('tab · ↑↓ scroll · esc')).toBeNull();
    // The keys still move the body and Tab still cycles the tabs.
    send('pagedown');
    expect(mocks.state.scroller.scrollBy).toHaveBeenCalledWith(3);
    send('tab');
    expect(getByTestId('scrollbox').textContent).toContain(
      'Activity (this session)',
    );
  });

  it('keeps esc in the hint when the long hint cannot fit the row', () => {
    // Twenty columns leave a content width of 10: the 21-column scroll hint
    // would clip to 'tab · ↑↓ …' and lose the key that matters.
    mocks.state.width = 20;
    mocks.state.contentRows = 30;
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

  it('budgets the embedded tab bar four columns narrower than the popup', () => {
    // Inside Settings the frame sits within that dialog's border and
    // padding: at 43 columns the popup's content width is 33, the embed's 29.
    mocks.state.width = 43;
    const labels = (container: HTMLElement) =>
      Array.from(
        container.firstElementChild?.children[0]?.querySelectorAll('span') ??
          [],
      ).map((label) => label.textContent);
    const popup = render(
      <OpenTuiStatsDialog
        config={CONFIG}
        onClose={() => {}}
        availableTerminalHeight={15}
      />,
    );
    expect(labels(popup.container)).toEqual([
      ' Session ',
      ' Activity ',
      ' Efficiency ',
    ]);
    popup.unmount();
    const embed = render(
      <OpenTuiStatsDialog config={CONFIG} onClose={() => {}} />,
    );
    expect(labels(embed.container)).toEqual([
      ' Session ',
      ' Activity ',
      ' Effici…',
    ]);
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

  it('remounts the frame when the region crosses the compact boundary', () => {
    // A removed layout property can persist on a reused native node, so the
    // frame is keyed by its style: without the key the compact frame would
    // keep the padding rows the normal one had.
    const dialog = (height: number) => (
      <OpenTuiStatsDialog
        config={CONFIG}
        onClose={() => {}}
        availableTerminalHeight={height}
      />
    );
    const { container, rerender } = render(dialog(10));
    const normal = container.firstElementChild;
    expect(normal?.getAttribute('data-padding-top')).toBe('1');
    expect(normal?.getAttribute('data-padding-bottom')).toBe('1');

    rerender(dialog(6));
    const compact = container.firstElementChild;
    expect(compact).not.toBe(normal);
    expect(compact?.getAttribute('data-border')).toBe('true');
    expect(compact?.getAttribute('data-padding-top')).toBe('0');
    expect(compact?.getAttribute('data-padding-bottom')).toBe('0');

    // And back: the property being removed on the way down returns.
    rerender(dialog(10));
    expect(container.firstElementChild).not.toBe(compact);
    expect(container.firstElementChild?.getAttribute('data-padding-top')).toBe(
      '1',
    );
  });

  it('clips the footer hint to the content width on one row', () => {
    const renderAt = (width: number) => {
      mocks.state.width = width;
      return render(
        <OpenTuiStatsDialog
          config={CONFIG}
          onClose={() => {}}
          availableTerminalHeight={15}
        />,
      );
    };
    // Eighteen columns leave a content width of 8, one short of the hint.
    const narrow = renderAt(18);
    expect(footer(narrow.container)?.textContent).toBe('tab · e…');
    expect(footer(narrow.container)?.getAttribute('data-wrap-mode')).toBe(
      'none',
    );
    narrow.unmount();
    // Eleven leave one column: the hint is the ellipsis, and the tab bar
    // holds only that column for the first label; the rest are dropped.
    const tiny = renderAt(11);
    expect(footer(tiny.container)?.textContent).toBe('…');
    expect(tabBar(tiny.container).map((label) => label.text)).toEqual(['…']);
  });

  it('highlights the tab whose body is shown', () => {
    mocks.state.contentRows = 30;
    const { container, getByTestId } = render(
      <OpenTuiStatsDialog
        config={CONFIG}
        onClose={() => {}}
        availableTerminalHeight={15}
      />,
    );
    expect(activeTabs(container)).toEqual([' Session ']);
    const [session, activity] = tabBar(container);
    expect(session?.fg).toBe('#1e1e2e');
    expect(activity?.fg).toBe(C.text);
    expect(activity?.bg).toBeNull();
    expect(getByTestId('scrollbox').textContent).toContain('Session ID');

    send('tab');
    expect(activeTabs(container)).toEqual([' Activity ']);
    expect(getByTestId('scrollbox').textContent).toContain(
      'Activity (this session)',
    );
  });

  it('cycles the tabs forward and back, wrapping at both ends', () => {
    const { container } = render(
      <OpenTuiStatsDialog
        config={CONFIG}
        onClose={() => {}}
        availableTerminalHeight={15}
      />,
    );
    // Shift+Tab from the first tab wraps to the last.
    send('tab', true);
    expect(activeTabs(container)).toEqual([' Efficiency ']);
    send('tab');
    expect(activeTabs(container)).toEqual([' Session ']);
    send('tab');
    send('tab');
    send('tab');
    expect(activeTabs(container)).toEqual([' Session ']);
  });

  it('advances once per Tab when several arrive before a re-render', () => {
    const { container } = render(
      <OpenTuiStatsDialog
        config={CONFIG}
        onClose={() => {}}
        availableTerminalHeight={15}
      />,
    );
    burst('tab', 'tab');
    expect(activeTabs(container)).toEqual([' Efficiency ']);
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <OpenTuiStatsDialog
        config={CONFIG}
        onClose={onClose}
        availableTerminalHeight={6}
      />,
    );
    // Compact chrome shows no hint, but the key still closes.
    send('escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores every key while an embedding host owns the focus', () => {
    const onClose = vi.fn();
    mocks.state.contentRows = 30;
    const { container, getByTestId } = render(
      <OpenTuiStatsDialog
        config={CONFIG}
        onClose={onClose}
        isFocused={false}
        availableTerminalHeight={15}
      />,
    );
    send('tab');
    send('down');
    send('pagedown');
    send('escape');
    expect(activeTabs(container)).toEqual([' Session ']);
    expect(getByTestId('scrollbox').textContent).toContain('Session ID');
    expect(mocks.state.scroller.scrollBy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
