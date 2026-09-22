// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { popoverTopEdge, readPopoverSafeTop } from './popoverRoom';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function mockTops(tops: Map<Element, number>) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return { top: tops.get(this) ?? -1000 } as DOMRect;
    },
  );
}

describe('readPopoverSafeTop', () => {
  it('tells an undeclared safe top from a declared zero', () => {
    const element = document.createElement('div');
    document.body.append(element);
    expect(readPopoverSafeTop(element)).toBeUndefined();
    element.style.setProperty('--web-shell-popover-safe-top', '0px');
    expect(readPopoverSafeTop(element)).toBe(0);
    element.style.setProperty('--web-shell-popover-safe-top', '64px');
    expect(readPopoverSafeTop(element)).toBe(64);
  });
});

describe('popoverTopEdge', () => {
  it('stays below the lowest clipping edge and the declared safe top', () => {
    const shell = document.createElement('div');
    const body = document.createElement('div');
    const pane = document.createElement('div');
    const wrapper = document.createElement('div');
    const anchor = document.createElement('div');
    shell.style.overflowY = 'hidden';
    body.style.overflowY = 'hidden';
    pane.style.overflowY = 'auto';
    shell.append(body);
    body.append(pane);
    pane.append(wrapper);
    wrapper.append(anchor);
    document.body.append(shell);
    // The scrolled pane's box starts above the body that clips it, so the
    // edge is the lowest clipping top, not the nearest or the outermost one.
    mockTops(
      new Map<Element, number>([
        [shell, 0],
        [body, 53],
        [pane, 30],
        [wrapper, 90],
        [anchor, 200],
      ]),
    );

    // The unclipped wrapper and the anchor itself do not bound the popover.
    expect(popoverTopEdge(anchor)).toBe(53);
    anchor.style.setProperty('--web-shell-popover-safe-top', '64px');
    expect(popoverTopEdge(anchor)).toBe(64);
  });

  it('falls back to the viewport top without clipping ancestors', () => {
    const anchor = document.createElement('div');
    document.body.append(anchor);
    mockTops(new Map<Element, number>([[anchor, 200]]));

    expect(popoverTopEdge(anchor)).toBe(0);
  });
});
