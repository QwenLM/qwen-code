// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  TOUCH_COMPOSER_QUERY,
  isCoarsePointerDevice,
  useIsTouchComposer,
} from './useIsTouchComposer';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const originalMatchMedia = window.matchMedia;
const originalMaxTouchPoints = Object.getOwnPropertyDescriptor(
  Navigator.prototype,
  'maxTouchPoints',
);
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  window.matchMedia = originalMatchMedia;
  if (originalMaxTouchPoints) {
    Object.defineProperty(
      Navigator.prototype,
      'maxTouchPoints',
      originalMaxTouchPoints,
    );
  } else {
    delete (navigator as unknown as Record<string, unknown>)['maxTouchPoints'];
  }
  window.history.replaceState({}, '', '/');
});

function installMatchMedia(matchesByQuery: Record<string, boolean>) {
  const listeners: Array<{
    query: string;
    cb: (event: MediaQueryListEvent) => void;
  }> = [];
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: matchesByQuery[query] ?? false,
    media: query,
    onchange: null,
    addEventListener: (
      _type: string,
      cb: (event: MediaQueryListEvent) => void,
    ) => listeners.push({ query, cb }),
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  })) as unknown as typeof window.matchMedia;
  return {
    fire(query: string, matches: boolean) {
      matchesByQuery[query] = matches;
      act(() => {
        listeners
          .filter((l) => l.query === query)
          .forEach((l) => l.cb({ matches } as MediaQueryListEvent));
      });
    },
    listenerCount: () => listeners.length,
  };
}

function setMaxTouchPoints(value: number) {
  Object.defineProperty(navigator, 'maxTouchPoints', {
    value,
    configurable: true,
  });
}

function renderHook(): { value: () => boolean } {
  let latest = false;
  function Probe() {
    latest = useIsTouchComposer();
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(<Probe />);
  });
  return { value: () => latest };
}

describe('useIsTouchComposer', () => {
  it('returns true when the coarse-pointer query matches and touch points exist', () => {
    installMatchMedia({ [TOUCH_COMPOSER_QUERY]: true });
    setMaxTouchPoints(5);
    expect(renderHook().value()).toBe(true);
  });

  it('returns false when the query matches but no touch points are reported', () => {
    installMatchMedia({ [TOUCH_COMPOSER_QUERY]: true });
    setMaxTouchPoints(0);
    expect(renderHook().value()).toBe(false);
  });

  it('returns false on hover-capable touch devices (touch laptops)', () => {
    // (hover: none) and (pointer: coarse) does not match a laptop with a
    // touchscreen plus trackpad, even though maxTouchPoints > 0.
    installMatchMedia({ [TOUCH_COMPOSER_QUERY]: false });
    setMaxTouchPoints(10);
    expect(renderHook().value()).toBe(false);
  });

  it('returns false when matchMedia is unavailable (SSR / jsdom default)', () => {
    (window as unknown as Record<string, unknown>)['matchMedia'] = undefined;
    setMaxTouchPoints(5);
    expect(renderHook().value()).toBe(false);
  });

  it('honors ?composer=textarea as a force-on override', () => {
    installMatchMedia({ [TOUCH_COMPOSER_QUERY]: false });
    setMaxTouchPoints(0);
    window.history.replaceState({}, '', '/?composer=textarea');
    expect(renderHook().value()).toBe(true);
  });

  it('honors ?composer=codemirror as a force-off escape hatch on touch devices', () => {
    installMatchMedia({ [TOUCH_COMPOSER_QUERY]: true });
    setMaxTouchPoints(5);
    window.history.replaceState({}, '', '/?composer=codemirror');
    expect(renderHook().value()).toBe(false);
  });

  it('freezes the choice at mount and ignores later media changes', () => {
    // Swapping editor backends mid-session would drop composer state, so the
    // hook intentionally does not subscribe to media query changes.
    const media = installMatchMedia({ [TOUCH_COMPOSER_QUERY]: false });
    setMaxTouchPoints(0);
    const probe = renderHook();
    expect(probe.value()).toBe(false);
    media.fire(TOUCH_COMPOSER_QUERY, true);
    expect(probe.value()).toBe(false);
    expect(media.listenerCount()).toBe(0);
  });
});

describe('isCoarsePointerDevice', () => {
  it('detects the device truth regardless of the URL override', () => {
    // Focus gating keys off the physical device: even when the user forces
    // the CodeMirror path via ?composer=codemirror, programmatic focus must
    // stay suppressed on touch devices.
    installMatchMedia({ [TOUCH_COMPOSER_QUERY]: true });
    setMaxTouchPoints(5);
    window.history.replaceState({}, '', '/?composer=codemirror');
    expect(isCoarsePointerDevice()).toBe(true);
  });

  it('returns false on fine-pointer devices', () => {
    installMatchMedia({ [TOUCH_COMPOSER_QUERY]: false });
    setMaxTouchPoints(0);
    expect(isCoarsePointerDevice()).toBe(false);
  });
});
