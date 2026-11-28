// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOUCH_SIDEBAR_MEDIA_QUERY,
  useTouchSidebarActions,
} from './use-touch-sidebar-actions';

let container: HTMLDivElement;
let root: Root;
let originalMatchMedia: typeof window.matchMedia;

function Probe({ mobileOpen = false }: { mobileOpen?: boolean }) {
  const { isTouchActions, useActionSheet } = useTouchSidebarActions(mobileOpen);
  return (
    <div
      data-touch={String(isTouchActions)}
      data-sheet={String(useActionSheet)}
    />
  );
}

beforeEach(() => {
  originalMatchMedia = window.matchMedia;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

describe('useTouchSidebarActions', () => {
  it('defaults to false on desktop when mobileOpen is false', () => {
    const matchMedia = vi.fn().mockReturnValue({
      matches: false,
      media: TOUCH_SIDEBAR_MEDIA_QUERY,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: matchMedia,
    });

    act(() => {
      root.render(<Probe />);
    });

    const el = container.firstElementChild as HTMLElement;
    expect(matchMedia).toHaveBeenCalledWith(TOUCH_SIDEBAR_MEDIA_QUERY);
    expect(el.dataset.touch).toBe('false');
    expect(el.dataset.sheet).toBe('false');
  });

  it('enables touch actions when mobileOpen is true even if matchMedia is false', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        media: TOUCH_SIDEBAR_MEDIA_QUERY,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });

    act(() => {
      root.render(<Probe mobileOpen />);
    });

    const el = container.firstElementChild as HTMLElement;
    expect(el.dataset.touch).toBe('true');
    expect(el.dataset.sheet).toBe('true');
  });

  it('reacts to MediaQueryList change events (e.g. iPad keyboard attach/detach)', () => {
    let listener: ((event: MediaQueryListEvent) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        matches: query === TOUCH_SIDEBAR_MEDIA_QUERY,
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: MediaQueryListEvent) => void,
        ) => {
          if (query === TOUCH_SIDEBAR_MEDIA_QUERY) listener = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });

    act(() => {
      root.render(<Probe />);
    });
    const el = container.firstElementChild as HTMLElement;
    expect(el.dataset.touch).toBe('true');

    act(() => {
      listener?.({ matches: false } as MediaQueryListEvent);
    });
    expect(el.dataset.touch).toBe('false');
    expect(el.dataset.sheet).toBe('false');

    act(() => {
      listener?.({ matches: true } as MediaQueryListEvent);
    });
    expect(el.dataset.touch).toBe('true');
    expect(el.dataset.sheet).toBe('true');
  });
});
