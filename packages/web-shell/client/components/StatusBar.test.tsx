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
  mockConnection.contextWindow = 0;
  mockConnection.tokenCount = 0;
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

const contextButton = () =>
  document.querySelector<HTMLButtonElement>('button[title="Context Usage"]');

describe('StatusBar context pill', () => {
  it('renders a mini bar with the percentage and keeps the full text accessible', () => {
    mockConnection.contextWindow = 1_000_000;
    mockConnection.tokenCount = 338_108;
    mount();

    const button = contextButton();
    expect(button?.textContent).toBe('33.8%');
    // The visible label is only the bare percentage; the meaning lives in the
    // accessible name so screen readers still hear "context used".
    expect(button?.getAttribute('aria-label')).toBe('33.8% context used');
    const fill = button?.querySelector<HTMLSpanElement>('span > span');
    expect(fill?.style.width).toBe('33.8108%');
  });

  it('escalates the fill color at the /context panel thresholds', () => {
    mockConnection.contextWindow = 100;

    mockConnection.tokenCount = 61;
    mount();
    let fill = contextButton()!.querySelector<HTMLSpanElement>('span > span')!;
    expect(fill.className).toContain('contextFillWarning');
    act(() => root!.unmount());
    container!.remove();

    mockConnection.tokenCount = 81;
    mount();
    fill = contextButton()!.querySelector<HTMLSpanElement>('span > span')!;
    expect(fill.className).toContain('contextFillError');
  });

  it('caps the fill width at 100% when usage exceeds the window', () => {
    mockConnection.contextWindow = 100;
    mockConnection.tokenCount = 150;
    mount();

    const fill =
      contextButton()!.querySelector<HTMLSpanElement>('span > span')!;
    expect(fill.style.width).toBe('100%');
    expect(contextButton()?.textContent).toBe('150.0%');
  });

  it('opens the context breakdown when clicked', () => {
    mockConnection.contextWindow = 1000;
    mockConnection.tokenCount = 100;
    const onShowContext = vi.fn();
    mount({ onShowContext });

    act(() => {
      contextButton()?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    expect(onShowContext).toHaveBeenCalledTimes(1);
  });

  it('stays hidden until a token count arrives', () => {
    mockConnection.contextWindow = 1000;
    mockConnection.tokenCount = 0;
    mount();
    expect(contextButton()).toBeNull();
  });

  it('renders in compact mode', () => {
    // The default chat layout mounts the StatusBar with compact={true}; the
    // pill must survive it or it would never be visible in the product.
    mockConnection.contextWindow = 1000;
    mockConnection.tokenCount = 338;
    mount({ compact: true });
    expect(contextButton()?.textContent).toBe('33.8%');
  });
});

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
