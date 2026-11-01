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

const activity = Array.from({ length: 44 }, (_, index) => ({
  count: index % 4,
  startAt: 1_000 + index * 60_000,
  endAt: 61_000 + index * 60_000,
}));
const tokens = {
  input: 5_000,
  output: 3_000,
  cached: 1_000,
  context: 900,
  contextLimit: 1_000,
};

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

function render(props: Partial<WaitingMinigameProps> = {}): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const rerender = (next: Partial<WaitingMinigameProps>) => {
    act(() => {
      root.render(
        <I18nProvider language="en">
          <WaitingMinigame
            open={next.open ?? true}
            onClose={next.onClose ?? vi.fn()}
            activity={next.activity ?? activity}
            tokenUsage={next.tokenUsage ?? tokens}
          />
        </I18nProvider>,
      );
    });
  };
  rerender(props);
  mounted.push({ root, container });
  return { container, rerender };
}

function keyOn(target: EventTarget, keyName: string): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: keyName,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

function key(keyName: string): void {
  keyOn(window, keyName);
}

function clickButton(container: HTMLElement, label: string): void {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.includes(label),
  );
  act(() => button?.click());
}

function startGame(container: HTMLElement, label: 'Tetris' | 'Snake'): void {
  act(() =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Start a game"]')
      ?.click(),
  );
  clickButton(container, label);
}

function activeCellIndexes(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll('[data-state]')).flatMap(
    (element, index) =>
      element.getAttribute('data-state') === '2' ? [index] : [],
  );
}

describe('WaitingMinigame', () => {
  it('renders nothing while closed', () => {
    const { container } = render({ open: false });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(
      container.querySelector('[data-component="waiting-minigame"]'),
    ).toBeNull();
  });

  it('opens on the activity heatmap with the Qwen entry', () => {
    const { container } = render();
    expect(
      container.querySelector('[data-component="waiting-minigame"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Activity');
    expect(container.textContent).toContain('Usage');
    expect(container.textContent).toContain('Click the Qwen mark to play');
    expect(container.querySelectorAll('[data-level]')).toHaveLength(44);
    expect(
      container.querySelector('[aria-label="Start a game"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain('Score 0');
  });

  it('shows token totals, input, output and context in the usage tab', () => {
    const { container } = render();
    clickButton(container, 'Usage');
    expect(container.textContent).toContain('Total tokens');
    expect(container.textContent).toContain('8.0k');
    expect(container.textContent).toContain('5.0k');
    expect(container.textContent).toContain('3.0k');
    expect(container.textContent).toContain('1.0k');
    expect(container.textContent).toContain('900 / 1.0k');
    expect(container.textContent).not.toContain('No token data yet');
  });

  it('shows an empty token state when usage is unavailable', () => {
    const { container } = render({
      tokenUsage: { input: 0, output: 0, cached: 0 },
    });
    clickButton(container, 'Usage');
    expect(container.textContent).toContain('No token data yet');
  });

  it('picks Tetris and supports pause, resume and Escape', () => {
    const onClose = vi.fn();
    const { container } = render({ onClose });
    startGame(container, 'Tetris');
    expect(container.querySelectorAll('[data-state]')).toHaveLength(44 * 7);
    expect(container.textContent).toContain('Score 0');
    expect(container.textContent).toContain('Best 0');
    expect(container.textContent).toContain('clear a column +50');

    key(' ');
    expect(container.textContent).toContain('Paused');
    key(' ');
    expect(container.textContent).not.toContain('Paused');
    key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('picks Snake and supports pause, resume and turning', () => {
    const { container } = render();
    startGame(container, 'Snake');
    expect(container.querySelectorAll('[data-state]')).toHaveLength(44 * 7);
    expect(container.textContent).toContain('Arrows / WASD turn');
    key(' ');
    expect(container.textContent).toContain('Paused');
    key(' ');
    expect(container.textContent).not.toContain('Paused');
    const headBefore = activeCellIndexes(container);
    key('ArrowUp');
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(activeCellIndexes(container)).not.toEqual(headBefore);
  });

  it('returns to the activity view on reopen', () => {
    const { container, rerender } = render();
    startGame(container, 'Tetris');
    expect(container.textContent).toContain('Score 0');
    rerender({ open: false });
    rerender({ open: true });
    expect(container.textContent).toContain('Click the Qwen mark to play');
    expect(container.textContent).not.toContain('Score 0');
  });

  it('pauses gravity when the tab is hidden and resumes after Space', () => {
    const { container } = render();
    startGame(container, 'Tetris');
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

  it('leaves Space and Escape to focused controls and open dialogs', () => {
    const onClose = vi.fn();
    const { container } = render({ onClose });
    startGame(container, 'Tetris');
    const mute = container.querySelector<HTMLButtonElement>('[aria-pressed]');
    expect(mute).not.toBeNull();
    act(() => mute?.focus());
    keyOn(mute!, ' ');
    expect(container.textContent).not.toContain('Paused');

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const dialogButton = document.createElement('button');
    dialog.appendChild(dialogButton);
    container.appendChild(dialog);
    keyOn(dialogButton, 'Escape');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps game controls out of the aria-hidden board', () => {
    const { container } = render();
    startGame(container, 'Tetris');
    expect(container.querySelector('[aria-hidden="true"] button')).toBeNull();
    expect(
      container.querySelectorAll('[aria-hidden="true"] [data-state]'),
    ).toHaveLength(44 * 7);
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
