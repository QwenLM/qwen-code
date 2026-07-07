// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useIsLargeScreen } from './useIsLargeScreen';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const originalMatchMedia = window.matchMedia;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  window.matchMedia = originalMatchMedia;
});

function installMatchMedia(initial: boolean) {
  let matches = initial;
  let listeners: Array<(event: MediaQueryListEvent) => void> = [];
  const mql = {
    get matches() {
      return matches;
    },
    media: '',
    onchange: null,
    addEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) =>
      listeners.push(cb),
    removeEventListener: (
      _type: string,
      cb: (event: MediaQueryListEvent) => void,
    ) => {
      listeners = listeners.filter((l) => l !== cb);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
  window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      matches = next;
      act(() => {
        listeners.forEach((l) => l({ matches } as MediaQueryListEvent));
      });
    },
  };
}

function Probe() {
  const isLarge = useIsLargeScreen();
  return <span data-testid="value">{String(isLarge)}</span>;
}

function render(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Probe />));
}

function value(): string | undefined {
  return container?.querySelector('[data-testid="value"]')?.textContent ?? undefined;
}

describe('useIsLargeScreen', () => {
  it('seeds synchronously from the initial media match', () => {
    installMatchMedia(true);
    render();
    expect(value()).toBe('true');
  });

  it('starts false on small screens', () => {
    installMatchMedia(false);
    render();
    expect(value()).toBe('false');
  });

  it('reacts to viewport crossing the breakpoint', () => {
    const media = installMatchMedia(true);
    render();
    expect(value()).toBe('true');
    media.set(false);
    expect(value()).toBe('false');
    media.set(true);
    expect(value()).toBe('true');
  });

  it('degrades to false when matchMedia is unavailable', () => {
    // Some locked-down/embedded browsers omit matchMedia entirely.
    (window as unknown as { matchMedia?: unknown }).matchMedia =
      undefined as unknown as typeof window.matchMedia;
    render();
    expect(value()).toBe('false');
  });
});
