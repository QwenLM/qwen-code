// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { buildWaitingActivity } from '../utils/waitingActivity';
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

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 10, 4, 12, 0, 0).getTime();
const activity = buildWaitingActivity(
  [
    { id: 'user-old', role: 'user', timestamp: NOW - 3 * DAY_MS },
    {
      id: 'assistant-old',
      role: 'assistant',
      timestamp: NOW - 3 * DAY_MS + 60_000,
    },
    { id: 'user-today', role: 'user', timestamp: NOW - 1_000 },
    { id: 'assistant-today', role: 'assistant', timestamp: NOW - 500 },
  ],
  { now: NOW },
);
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
            onSelectActivity={next.onSelectActivity}
            gamesEnabled={next.gamesEnabled ?? true}
            entryDelayMs={next.entryDelayMs ?? 0}
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

function clickQwenStart(container: HTMLElement): void {
  act(() =>
    container
      .querySelector<HTMLButtonElement>(
        '[data-component="waiting-minigame-start"]',
      )
      ?.click(),
  );
}

function finishIntro(): void {
  act(() => {
    vi.advanceTimersByTime(1_800);
  });
}

function startRandomGame(container: HTMLElement): void {
  clickQwenStart(container);
  finishIntro();
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
    expect(container.textContent).toContain('Q&A activity');
    expect(container.textContent).toContain('Activity');
    expect(container.textContent).toContain('Usage');
    expect(container.querySelectorAll('[data-level]')).toHaveLength(44 * 7);
    expect(
      container.querySelector('[aria-label="Start a random game"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain('Score 0');
  });

  it('keeps the game entry hidden when games are disabled', () => {
    const { container } = render({ gamesEnabled: false });
    expect(container.textContent).toContain('Q&A activity');
    expect(container.textContent).toContain('Activity');
    expect(container.textContent).toContain('Usage');
    expect(
      container.querySelector('[data-component="waiting-minigame-start"]'),
    ).toBeNull();
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(
      container.querySelector('[data-component="waiting-minigame-start"]'),
    ).toBeNull();
    clickButton(container, 'Usage');
    expect(container.textContent).toContain('Total tokens');
  });

  it('reveals the Qwen entry after the five second delay', () => {
    const { container } = render({ entryDelayMs: 5_000 });
    expect(
      container.querySelector('[data-component="waiting-minigame-start"]'),
    ).toBeNull();
    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(
      container.querySelector('[data-component="waiting-minigame-start"]'),
    ).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(
      container.querySelector('[data-component="waiting-minigame-start"]'),
    ).not.toBeNull();
  });

  it('keeps the Qwen entry cell stable while activity updates', () => {
    const { container, rerender } = render();
    const position = () => {
      const start = container.querySelector<HTMLElement>(
        '[data-component="waiting-minigame-start"]',
      );
      return `${start?.style.gridColumn}:${start?.style.gridRow}`;
    };
    expect(position()).toBe('1:1');
    rerender({
      activity: activity.map((day, index) => ({
        ...day,
        count: day.future || index === 100 ? 0 : 1,
      })),
    });
    expect(position()).toBe('1:1');
  });

  it('flies the Qwen Code blocks into the Tetris start cluster', () => {
    const { container } = render();
    clickQwenStart(container);
    const intro = container.querySelector('[data-intro="true"]');
    expect(intro).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(750);
    });
    expect(intro?.getAttribute('data-settling')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(520);
    });
    expect(intro?.getAttribute('data-landed')).toBe('true');
    expect(intro?.querySelectorAll('[data-state="1"]')).toHaveLength(12);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(container.querySelector('[data-intro="true"]')).toBeNull();
    expect(container.textContent).toContain('Score 0');
    expect(container.textContent).toContain('Best 0');
  });

  it('keeps the Qwen Code blocks still before a Snake game', () => {
    vi.mocked(Math.random).mockReturnValue(0.9);
    const { container } = render();
    clickQwenStart(container);
    const intro = container.querySelector('[data-intro="true"]');
    expect(intro).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(750);
    });
    expect(intro?.getAttribute('data-settling')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(container.querySelector('[data-intro="true"]')).toBeNull();
    expect(container.textContent).toContain('Arrows / WASD turn');
  });

  it('shows day details on hover and locates the clicked day', () => {
    const onSelectActivity = vi.fn();
    const days = buildWaitingActivity(
      [
        {
          id: 'assistant-hover',
          role: 'assistant',
          timestamp: NOW - 1_000,
        },
        { id: 'user-hover', role: 'user', timestamp: NOW - 500 },
      ],
      { now: NOW },
    );
    const { container } = render({
      activity: days,
      onSelectActivity,
    });
    const active = container.querySelector<HTMLElement>(
      '[data-level]:not([data-empty="true"])',
    )!;
    act(() => {
      active.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }),
      );
    });
    expect(container.textContent).toContain('2 Q&A');
    expect(container.textContent).toContain('Click to locate');
    act(() => active.click());
    expect(onSelectActivity).toHaveBeenCalledWith('user-hover');

    const empty = container.querySelector<HTMLElement>(
      'button[data-level][data-empty="true"]',
    )!;
    act(() => empty.click());
    expect(onSelectActivity).toHaveBeenCalledTimes(1);
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

  it('starts Tetris, pauses, resumes and closes with Escape', () => {
    const onClose = vi.fn();
    const { container } = render({ onClose });
    startRandomGame(container);
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

  it('starts Snake randomly and supports pause, resume and turning', () => {
    vi.mocked(Math.random).mockReturnValue(0.9);
    const { container } = render();
    startRandomGame(container);
    expect(container.querySelectorAll('[data-state]')).toHaveLength(44 * 7);
    expect(container.textContent).toContain('Arrows / WASD turn');
    expect(container.textContent).toContain('🍎');
    key(' ');
    expect(container.textContent).toContain('Paused');
    key(' ');
    expect(container.textContent).not.toContain('Paused');
    const headBefore = activeCellIndexes(container);
    key('ArrowUp');
    act(() => {
      vi.advanceTimersByTime(240);
    });
    expect(activeCellIndexes(container)).not.toEqual(headBefore);
  });

  it('returns to the activity view on reopen', () => {
    const { container, rerender } = render();
    startRandomGame(container);
    expect(container.textContent).toContain('Score 0');
    rerender({ open: false });
    rerender({ open: true });
    expect(container.textContent).toContain('Q&A activity');
    expect(container.textContent).not.toContain('Score 0');
  });

  it('pauses gravity when the tab is hidden and resumes after Space', () => {
    const { container } = render();
    startRandomGame(container);
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
    startRandomGame(container);
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
    startRandomGame(container);
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

  it('renders an expanded state and toggles the card on click', () => {
    const { container, onToggle } = renderButton(false);
    const button = container.querySelector<HTMLButtonElement>(
      '[data-component="waiting-minigame-trigger"]',
    );
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(button?.getAttribute('aria-label')).toBe('Open task activity');
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
