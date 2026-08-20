// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { mockConnection } = vi.hoisted(() => ({
  mockConnection: {
    sessionId: 'session-1' as string | undefined,
    currentModel: undefined as string | undefined,
    contextWindow: 0,
    tokenCount: 0,
  },
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => mockConnection,
}));

const { StatusBar } = await import('./StatusBar');
const { I18nProvider } = await import('../i18n');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

function mount(
  props: Partial<Parameters<typeof StatusBar>[0]> = {},
): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <StatusBar
          onSelectMode={vi.fn()}
          onSelectModel={vi.fn()}
          onShowContext={vi.fn()}
          onOpenSettings={vi.fn()}
          tasks={[]}
          {...props}
        />
      </I18nProvider>,
    );
  });
  return container;
}

const goalButton = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label^="Goals"]');

describe('StatusBar goal pill', () => {
  it('names the active goal in its accessible label', () => {
    // The visible pill is only "◎ Goal (2m)" — the condition never appears in
    // it, and `title` is a hover tooltip screen readers do not reliably
    // announce. Without the condition here, a screen-reader user cannot tell
    // which goal is running without opening the Goals page.
    mount({
      activeGoal: { condition: 'all tests pass', setAt: Date.now() - 5000 },
      onOpenGoals: vi.fn(),
    });

    expect(goalButton()?.getAttribute('aria-label')).toBe(
      'Goals: all tests pass',
    );
    // The purpose stays in front of the condition: a bare condition string
    // gives no hint that activating this opens anything.
    expect(goalButton()?.getAttribute('aria-label')).toMatch(/^Goals: /);
  });

  it('falls back to the plain label when no goal is active', () => {
    mount({ onOpenGoals: vi.fn() });
    expect(goalButton()).toBeNull();
  });

  it('opens the Goals page when activated', () => {
    const onOpenGoals = vi.fn();
    mount({
      activeGoal: { condition: 'ship it', setAt: Date.now() },
      onOpenGoals,
    });

    act(() => {
      goalButton()?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    expect(onOpenGoals).toHaveBeenCalledTimes(1);
  });

  it('renders the goal as static text when there is nowhere to open', () => {
    // No `onOpenGoals` (e.g. embedded without the Goals page): the pill must
    // not pretend to be interactive.
    mount({ activeGoal: { condition: 'ship it', setAt: Date.now() } });

    expect(goalButton()).toBeNull();
    expect(document.body.textContent).toContain('/goal active');
  });
});
