// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { WaitingMinigame, type WaitingMinigameProps } from './WaitingMinigame';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface Rendered {
  container: HTMLElement;
  rerender: (next: WaitingMinigameProps) => void;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  window.localStorage.clear();
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  });
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function render(props: WaitingMinigameProps): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const rerender = (next: WaitingMinigameProps) => {
    act(() => {
      root.render(
        <I18nProvider language="en">
          <WaitingMinigame {...next} />
        </I18nProvider>,
      );
    });
  };
  rerender(props);
  mounted.push({ root, container });
  return { container, rerender };
}

function key(keyName: string): void {
  act(() => {
    const target =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : document.body;
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: keyName,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

function arm(): void {
  act(() => {
    vi.advanceTimersByTime(700);
  });
}

describe('WaitingMinigame', () => {
  it('stays hidden while no prompt is running', () => {
    const { container } = render({ active: false });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(
      container.querySelector('[data-component="waiting-minigame"]'),
    ).toBeNull();
  });

  it('shows the wait strip after the arm delay and opens the board', () => {
    const { container } = render({ active: true });
    expect(
      container.querySelector('[data-component="waiting-minigame"]'),
    ).toBeNull();
    arm();
    const strip = container.querySelector('button');
    expect(strip?.textContent).toContain('Juust Relax');
    expect(strip?.textContent).toContain(
      'Click or press Enter to start horizontal Tetris',
    );
    expect(strip?.textContent).toContain('Waiting for a reply');

    act(() => strip?.click());
    expect(
      container.querySelector('[data-component="waiting-minigame"]'),
    ).not.toBeNull();
    expect(container.querySelectorAll('[data-state]')).toHaveLength(44 * 7);
    expect(container.textContent).toContain('Score 0');
    expect(container.textContent).toContain('Best 0');
    expect(container.textContent).toContain('clear a column +50');
  });

  it('pauses and resumes with Space, and collapses with Escape', () => {
    const { container } = render({ active: true });
    arm();
    act(() => container.querySelector('button')?.click());
    key(' ');
    expect(container.textContent).toContain('Paused');
    key(' ');
    expect(container.textContent).not.toContain('Paused');
    key('Escape');
    expect(
      container.querySelector('[data-component="waiting-minigame"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Waiting for a reply');
    expect(container.textContent).not.toContain('Score 0');
  });

  it('closes when the prompt stops streaming', () => {
    const { container, rerender } = render({ active: true });
    arm();
    act(() => container.querySelector('button')?.click());
    expect(container.textContent).toContain('Score 0');
    rerender({ active: false });
    expect(
      container.querySelector('[data-component="waiting-minigame"]'),
    ).toBeNull();
  });

  it('resumes gravity after the tab becomes visible again', () => {
    const { container } = render({ active: true });
    arm();
    act(() => container.querySelector('button')?.click());
    expect(activeCellIndexes(container)).toEqual([0, 1, 2, 3]);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(container.textContent).toContain('Paused');

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    key(' ');
    act(() => {
      vi.advanceTimersByTime(140);
    });
    expect(container.textContent).not.toContain('Paused');
    expect(activeCellIndexes(container)).toEqual([1, 2, 3, 4]);
  });

  it('keeps Escape in the game and leaves Space to focused buttons', () => {
    const { container } = render({ active: true });
    arm();
    act(() => container.querySelector('button')?.click());

    const windowKey = vi.fn();
    window.addEventListener('keydown', windowKey);
    try {
      key('Escape');
      expect(container.textContent).toContain('Waiting for a reply');
      expect(windowKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', windowKey);
    }

    act(() => container.querySelector('button')?.click());
    const mute = container.querySelector<HTMLButtonElement>('[aria-pressed]');
    expect(mute).not.toBeNull();
    act(() => mute?.focus());
    key(' ');
    expect(container.textContent).not.toContain('Paused');
  });
});

function activeCellIndexes(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll('[data-state]')).flatMap(
    (element, index) =>
      element.getAttribute('data-state') === '2' ? [index] : [],
  );
}
