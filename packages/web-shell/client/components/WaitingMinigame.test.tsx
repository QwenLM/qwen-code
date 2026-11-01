// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import {
  WaitingMinigame,
  WaitingMinigameButton,
  type WaitingMinigameProps,
} from './WaitingMinigame';

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
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: keyName,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

describe('WaitingMinigame', () => {
  it('renders nothing while the board is closed', () => {
    const { container } = render({ open: false, onClose: vi.fn() });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(
      container.querySelector('[data-component="waiting-minigame"]'),
    ).toBeNull();
  });

  it('renders the board and its score when open', () => {
    const { container } = render({ open: true, onClose: vi.fn() });
    expect(
      container.querySelector('[data-component="waiting-minigame"]'),
    ).not.toBeNull();
    expect(container.querySelectorAll('[data-state]')).toHaveLength(44 * 7);
    expect(container.textContent).toContain('Juust Relax');
    expect(container.textContent).toContain('Score 0');
    expect(container.textContent).toContain('Best 0');
    expect(container.textContent).toContain('clear a column +50');
  });

  it('pauses and resumes with Space, and collapses with Escape', () => {
    const onClose = vi.fn();
    const { container, rerender } = render({ open: true, onClose });
    key(' ');
    expect(container.textContent).toContain('Paused');
    key(' ');
    expect(container.textContent).not.toContain('Paused');
    key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender({ open: false, onClose });
    expect(
      container.querySelector('[data-component="waiting-minigame"]'),
    ).toBeNull();
  });

  it('resumes a paused board when it reopens', () => {
    const { container, rerender } = render({ open: true, onClose: vi.fn() });
    key(' ');
    expect(container.textContent).toContain('Paused');
    rerender({ open: false, onClose: vi.fn() });
    rerender({ open: true, onClose: vi.fn() });
    expect(container.textContent).not.toContain('Paused');
  });
});

describe('WaitingMinigameButton', () => {
  function renderButton(open: boolean): {
    container: HTMLElement;
    onToggle: ReturnType<typeof vi.fn>;
  } {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onToggle = vi.fn();
    act(() => {
      root.render(
        <I18nProvider language="en">
          <WaitingMinigameButton open={open} onToggle={onToggle} />
        </I18nProvider>,
      );
    });
    mounted.push({ root, container });
    return { container, onToggle };
  }

  it('renders an expanded state and toggles the board on click', () => {
    const { container, onToggle } = renderButton(false);
    const button = container.querySelector<HTMLButtonElement>(
      '[data-component="waiting-minigame-trigger"]',
    );
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(button?.getAttribute('aria-label')).toBe(
      'Start the waiting minigame',
    );
    act(() => button?.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('reports the open state on the trigger', () => {
    const { container } = renderButton(true);
    expect(
      container
        .querySelector('[data-component="waiting-minigame-trigger"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
  });
});
