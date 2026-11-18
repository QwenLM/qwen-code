// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalSnapshotV2 } from '@qwen-code/sdk/daemon';
import { WebShellCustomizationProvider } from '../customization';
import { I18nProvider, getTranslator } from '../i18n';
import { ComposerStatusStack } from './ComposerStatusStack';
import type { QueuedPrompt } from './QueuedPromptDisplay';

const t = getTranslator('zh-CN');

function activeGoal(): GoalSnapshotV2 {
  return {
    v: 2,
    activity: 'running',
    goal: {
      goalId: 'goal-1',
      revision: 2,
      objective: 'ship every surface',
      status: 'active',
      evidenceCursor: { recordId: null },
      turnCount: 3,
      activeTimeMs: 4000,
      createdAt: 1000,
      updatedAt: 5000,
    },
  };
}

const queuedProps = {
  prompts: [{ id: 1, text: '排队消息一' }] as QueuedPrompt[],
  t,
  onDelete: vi.fn(),
  onInsert: vi.fn(),
  onEdit: vi.fn(),
};

const goalProps = {
  snapshot: activeGoal(),
  onEdit: vi.fn(),
  onPause: vi.fn(),
  onResume: vi.fn(),
  onClear: vi.fn(),
};

describe('ComposerStatusStack', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(
    props: React.ComponentProps<typeof ComposerStatusStack>,
  ): void {
    act(() => {
      root.render(
        <I18nProvider language="en">
          <WebShellCustomizationProvider value={{}}>
            <ComposerStatusStack {...props} />
          </WebShellCustomizationProvider>
        </I18nProvider>,
      );
    });
  }

  it('wraps the queue and the goal strip in the shared status root', () => {
    render({ queued: queuedProps, goal: goalProps });
    const stack = container.querySelector(
      '[data-testid="composer-status-stack"]',
    );
    expect(stack).not.toBeNull();
    expect(
      stack?.querySelector('[data-web-shell-queued-prompts]'),
    ).not.toBeNull();
    expect(stack?.querySelector('[data-web-shell-goal-status]')).not.toBeNull();
    expect(container.textContent).toContain('排队消息一');
    expect(container.textContent).toContain('ship every surface');
  });

  it('omits the goal strip when no goal controller is supplied', () => {
    render({ queued: queuedProps });
    expect(
      container.querySelector('[data-testid="composer-status-stack"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-web-shell-queued-prompts]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-web-shell-goal-status]')).toBeNull();
  });

  it('omits the goal strip when the snapshot carries no goal', () => {
    render({
      queued: queuedProps,
      goal: { ...goalProps, snapshot: { v: 2, activity: 'idle', goal: null } },
    });
    expect(container.querySelector('[data-web-shell-goal-status]')).toBeNull();
    expect(
      container.querySelector('[data-web-shell-queued-prompts]'),
    ).not.toBeNull();
  });

  it('still renders the root for a goal-only stack with an empty queue', () => {
    render({ queued: { ...queuedProps, prompts: [] }, goal: goalProps });
    const stack = container.querySelector(
      '[data-testid="composer-status-stack"]',
    );
    expect(stack).not.toBeNull();
    expect(stack?.querySelector('[data-web-shell-queued-prompts]')).toBeNull();
    expect(stack?.querySelector('[data-web-shell-goal-status]')).not.toBeNull();
  });
});
