// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface MockGoal {
  sessionId: string;
  displayName: string | null;
  condition: string;
  iterations: number;
  setAt: number;
  lastReason?: string;
  hasActivePrompt: boolean;
}

const { actions } = vi.hoisted(() => ({
  actions: {
    listGoals: vi.fn(),
    clearGoal: vi.fn(),
  },
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useWorkspaceActions: () => actions,
}));

const { GoalsDialog } = await import('./GoalsDialog');
const { I18nProvider } = await import('../../i18n');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(el: Element | null | undefined) {
  if (!el) throw new Error('click target not found');
  act(() => {
    el.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  });
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
}

/** Set the condition textarea the way React's onChange expects. */
function setTextarea(value: string) {
  const textarea = document.querySelector('textarea');
  if (!textarea) throw new Error('textarea not found');
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function mount(
  goals: MockGoal[],
  opts: {
    onCreateGoal?: (
      condition: string,
    ) => boolean | void | Promise<boolean | void>;
    onOpenSession?: (sessionId: string) => void;
    onError?: (error: unknown, message: string) => void;
    droppedCount?: number;
  } = {},
) {
  actions.listGoals.mockResolvedValue({
    goals,
    droppedCount: opts.droppedCount ?? 0,
  });
  actions.clearGoal.mockResolvedValue({ cleared: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <GoalsDialog
          onCreateGoal={opts.onCreateGoal ?? vi.fn()}
          onOpenSession={opts.onOpenSession ?? vi.fn()}
          onError={opts.onError ?? vi.fn()}
        />
      </I18nProvider>,
    );
  });
  await flush();
}

const baseGoal = (over: Partial<MockGoal> = {}): MockGoal => ({
  sessionId: 'sess-1',
  displayName: 'fix-ci',
  condition: 'all tests pass',
  iterations: 0,
  setAt: Date.now() - 5000,
  hasActivePrompt: false,
  ...over,
});

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('GoalsDialog', () => {
  it('shows the empty state when no goal is active', async () => {
    await mount([]);
    expect(document.body.textContent).toContain('No active goals');
  });

  it('warns that the list is incomplete when sessions could not be probed', async () => {
    // Otherwise a brownout is indistinguishable from an empty workspace, and
    // the user re-creates goals that are already running.
    await mount([], { droppedCount: 2 });

    expect(
      document.querySelector('[data-testid="goals-dropped"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      '2 sessions could not be reached',
    );
  });

  it('shows no degradation notice when every session was probed', async () => {
    await mount([baseGoal()]);
    expect(document.querySelector('[data-testid="goals-dropped"]')).toBeNull();
  });

  it('renders a goal with its condition, turn count and judge verdict', async () => {
    await mount([
      baseGoal({ iterations: 3, lastReason: 'two tests still fail' }),
    ]);

    const text = document.body.textContent ?? '';
    expect(text).toContain('all tests pass');
    expect(text).toContain('3 turns');
    expect(text).toContain('two tests still fail');
    expect(text).toContain('fix-ci');
  });

  it('says "not yet evaluated" before the first judge turn', async () => {
    await mount([baseGoal({ iterations: 0 })]);
    expect(document.body.textContent).toContain('not yet evaluated');
  });

  it('distinguishes a working goal from a waiting one', async () => {
    await mount([baseGoal({ hasActivePrompt: true })]);
    expect(document.body.textContent).toContain('Working');

    act(() => root?.unmount());
    container?.remove();
    await mount([baseGoal({ hasActivePrompt: false })]);
    expect(document.body.textContent).toContain('Waiting');
  });

  it('falls back to the session id when the session has no name', async () => {
    await mount([baseGoal({ displayName: null, sessionId: 'abc-123' })]);
    expect(findButton('abc-123')).toBeDefined();
  });

  it('opens the goal session when its label is clicked', async () => {
    const onOpenSession = vi.fn();
    await mount([baseGoal()], { onOpenSession });

    click(findButton('fix-ci'));

    expect(onOpenSession).toHaveBeenCalledWith('sess-1');
  });

  it('clears a goal after confirmation and reloads the list', async () => {
    await mount([baseGoal()]);
    actions.listGoals.mockResolvedValue({ goals: [], droppedCount: 0 });

    click(document.querySelector('button[aria-label="Clear goal"]'));
    await flush();

    expect(window.confirm).toHaveBeenCalled();
    expect(actions.clearGoal).toHaveBeenCalledWith('sess-1');
    expect(document.body.textContent).toContain('No active goals');
  });

  it('does not clear when the confirmation is declined', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    await mount([baseGoal()]);

    click(document.querySelector('button[aria-label="Clear goal"]'));
    await flush();

    expect(actions.clearGoal).not.toHaveBeenCalled();
  });

  it('surfaces a clear failure through onError', async () => {
    const onError = vi.fn();
    await mount([baseGoal()], { onError });
    actions.clearGoal.mockRejectedValue(new Error('session is gone'));

    click(document.querySelector('button[aria-label="Clear goal"]'));
    await flush();

    expect(onError).toHaveBeenCalled();
  });

  it('rejects an empty condition instead of submitting it', async () => {
    const onCreateGoal = vi.fn();
    await mount([], { onCreateGoal });

    click(findButton('New goal'));
    click(findButton('Set goal'));
    await flush();

    expect(onCreateGoal).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Enter a condition');
  });

  it('rejects a condition longer than MAX_GOAL_LENGTH', async () => {
    const onCreateGoal = vi.fn();
    await mount([], { onCreateGoal });

    click(findButton('New goal'));
    setTextarea('x'.repeat(4001));
    click(findButton('Set goal'));
    await flush();

    expect(onCreateGoal).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('limited to 4000 characters');
  });

  it('rejects a clear keyword, which would drop the goal instead of setting it', async () => {
    const onCreateGoal = vi.fn();
    await mount([], { onCreateGoal });

    click(findButton('New goal'));
    // `/goal clear` clears; a form that accepted it would spawn a session that
    // immediately drops its own goal.
    setTextarea('  Clear  ');
    click(findButton('Set goal'));
    await flush();

    expect(onCreateGoal).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('clears a goal rather than');
  });

  it('submits a trimmed condition and closes the form', async () => {
    const onCreateGoal = vi.fn();
    await mount([], { onCreateGoal });

    click(findButton('New goal'));
    setTextarea('  ship it  ');
    click(findButton('Set goal'));
    await flush();

    expect(onCreateGoal).toHaveBeenCalledWith('ship it');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('never lets a slow /goals poll overlap itself', async () => {
    // `GET /goals` fans out one probe per live session and a wedged child can
    // hold it for the bridge's ext-method timeout, which is the same order as
    // the poll interval. A fixed setInterval would stack fan-outs, and the
    // action timeout rejects the wait without aborting the request.
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    actions.listGoals.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ goals: [], droppedCount: 0 });
        }),
    );

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <I18nProvider language="en">
          <GoalsDialog
            onCreateGoal={vi.fn()}
            onOpenSession={vi.fn()}
            onError={vi.fn()}
          />
        </I18nProvider>,
      );
    });

    // The mount load is in flight and never settles.
    expect(actions.listGoals).toHaveBeenCalledTimes(1);

    // Well past several intervals: still exactly one request.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(actions.listGoals).toHaveBeenCalledTimes(1);

    // Once it settles, the next poll is scheduled one interval later.
    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(actions.listGoals).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(actions.listGoals).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('stops polling once unmounted', async () => {
    vi.useFakeTimers();
    actions.listGoals.mockResolvedValue({ goals: [], droppedCount: 0 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <I18nProvider language="en">
          <GoalsDialog
            onCreateGoal={vi.fn()}
            onOpenSession={vi.fn()}
            onError={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const afterMount = actions.listGoals.mock.calls.length;

    act(() => root?.unmount());
    root = null;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(actions.listGoals).toHaveBeenCalledTimes(afterMount);

    vi.useRealTimers();
  });

  it('routes a creation failure to a toast when the page closed mid-flight', async () => {
    const onError = vi.fn();
    let reject: ((e: Error) => void) | undefined;
    const onCreateGoal = vi.fn(
      () =>
        new Promise<void>((_resolve, rj) => {
          reject = rj;
        }),
    );
    await mount([], { onCreateGoal, onError });

    click(findButton('New goal'));
    setTextarea('ship it');
    click(findButton('Set goal'));
    await flush();

    // Navigating away unmounts the page while the prompt is still in flight;
    // an inline form error would never be seen.
    act(() => root?.unmount());
    root = null;

    await act(async () => {
      reject?.(new Error('daemon says no'));
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalled();
  });

  it('renders the load error and keeps the list usable', async () => {
    actions.listGoals.mockRejectedValue(new Error('daemon unreachable'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <I18nProvider language="en">
          <GoalsDialog
            onCreateGoal={vi.fn()}
            onOpenSession={vi.fn()}
            onError={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await flush();

    expect(document.body.textContent).toContain('daemon unreachable');
  });

  it('drops a stale dropped-session count when the next load fails outright', async () => {
    // The banner describes a partial probe. A hard `GET /goals` failure is a
    // different state, and pinning the old count reports a partial probe that
    // did not happen on this load.
    vi.useFakeTimers();
    actions.listGoals.mockResolvedValue({ goals: [], droppedCount: 2 });
    actions.clearGoal.mockResolvedValue({ cleared: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <I18nProvider language="en">
          <GoalsDialog
            onCreateGoal={vi.fn()}
            onOpenSession={vi.fn()}
            onError={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      document.querySelector('[data-testid="goals-dropped"]'),
    ).not.toBeNull();

    // The next poll reaches nothing at all.
    actions.listGoals.mockRejectedValue(new Error('daemon unreachable'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(document.querySelector('[data-testid="goals-dropped"]')).toBeNull();
    expect(document.body.textContent).toContain('daemon unreachable');
    vi.useRealTimers();
  });

  it('keeps the form open with the condition when creation reports failure', async () => {
    // `onCreateGoal` returning false means no goal was started and the caller
    // already surfaced why. Resetting would close the form and silently throw
    // away what the user typed.
    const onCreateGoal = vi.fn().mockResolvedValue(false);
    await mount([], { onCreateGoal });

    click(findButton('New goal'));
    setTextarea('ship it');
    click(findButton('Set goal'));
    await flush();

    expect(onCreateGoal).toHaveBeenCalledWith('ship it');
    const textarea = document.querySelector('textarea');
    expect(textarea).not.toBeNull();
    expect(textarea!.value).toBe('ship it');
  });

  it('closes the form when creation resolves with no explicit result', async () => {
    // The common case: a void-returning callback still means success.
    const onCreateGoal = vi.fn().mockResolvedValue(undefined);
    await mount([], { onCreateGoal });

    click(findButton('New goal'));
    setTextarea('ship it');
    click(findButton('Set goal'));
    await flush();

    expect(document.querySelector('textarea')).toBeNull();
  });
});
