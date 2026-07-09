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
  running: boolean;
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

async function mount(
  goals: MockGoal[],
  opts: {
    onCreateGoal?: (condition: string) => void | Promise<void>;
    onOpenSession?: (sessionId: string) => void;
    onError?: (error: unknown, message: string) => void;
  } = {},
) {
  actions.listGoals.mockResolvedValue(goals);
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
  running: false,
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
    await mount([baseGoal({ running: true })]);
    expect(document.body.textContent).toContain('Working');

    act(() => root?.unmount());
    container?.remove();
    await mount([baseGoal({ running: false })]);
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
    actions.listGoals.mockResolvedValue([]);

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

  it('submits a trimmed condition and closes the form', async () => {
    const onCreateGoal = vi.fn();
    await mount([], { onCreateGoal });

    click(findButton('New goal'));
    const textarea = document.querySelector('textarea');
    if (!textarea) throw new Error('textarea not found');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setter.call(textarea, '  ship it  ');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click(findButton('Set goal'));
    await flush();

    expect(onCreateGoal).toHaveBeenCalledWith('ship it');
    expect(document.querySelector('textarea')).toBeNull();
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
});
