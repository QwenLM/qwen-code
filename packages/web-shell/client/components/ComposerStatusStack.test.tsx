// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalSnapshotV2 } from '@qwen-code/sdk/daemon';
import { WebShellCustomizationProvider } from '../customization';
import { I18nProvider, getTranslator } from '../i18n';
import { ComposerStatusStack } from './ComposerStatusStack';
import type { QueuedPrompt } from './QueuedPromptDisplay';
import styles from './ComposerStatusStack.module.css';

// Stub the goal strip with an unconditional element so the no-goal cases
// observe this component's own gate, not GoalStatusStrip's internal `!goal`
// guard (which would otherwise mask a widened gate). The strip's own rendering
// and complete-goal guard stay pinned by GoalStatusStrip.test.tsx.
vi.mock('./GoalStatusStrip', () => ({
  GoalStatusStrip: () => <div data-web-shell-goal-status="" />,
}));

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

  function stack(): HTMLElement {
    const node = container.querySelector<HTMLElement>(
      '[data-testid="composer-status-stack"]',
    );
    if (!node) throw new Error('composer status stack was not rendered');
    return node;
  }

  it('wraps the queue and the goal strip in the shared status root', () => {
    render({ queued: queuedProps, goal: goalProps });
    const node = stack();
    // The component must apply the module's root class (the only source of the
    // border/width/radius). This pins the component's usage of it; that the
    // stylesheet actually defines `.root` is pinned by reading the file below,
    // because this package's vitest config emulates CSS modules (no test.css).
    expect(node.className).toContain(styles.root);
    expect(container.textContent).toContain('排队消息一');
    // Both children stay direct and in this order: the stylesheet selects
    // `.root > [queued] + [goal]`, so a wrapper or a swap must fail here.
    expect(node.children).toHaveLength(2);
    expect(node.children[0].hasAttribute('data-web-shell-queued-prompts')).toBe(
      true,
    );
    expect(node.children[1].hasAttribute('data-web-shell-goal-status')).toBe(
      true,
    );
  });

  it('omits the goal strip when no goal controller is supplied', () => {
    render({ queued: queuedProps });
    const node = stack();
    expect(node.children).toHaveLength(1);
    expect(node.children[0].hasAttribute('data-web-shell-queued-prompts')).toBe(
      true,
    );
    expect(node.querySelector('[data-web-shell-goal-status]')).toBeNull();
  });

  it('omits the goal strip when the snapshot carries no goal', () => {
    render({
      queued: queuedProps,
      goal: { ...goalProps, snapshot: { v: 2, activity: 'idle', goal: null } },
    });
    const node = stack();
    expect(node.querySelector('[data-web-shell-goal-status]')).toBeNull();
    expect(
      node.querySelector('[data-web-shell-queued-prompts]'),
    ).not.toBeNull();
  });

  it('still renders the root for a goal-only stack with an empty queue', () => {
    render({ queued: { ...queuedProps, prompts: [] }, goal: goalProps });
    const node = stack();
    expect(node.className).toContain(styles.root);
    expect(node.children).toHaveLength(1);
    expect(node.children[0].hasAttribute('data-web-shell-goal-status')).toBe(
      true,
    );
    expect(node.querySelector('[data-web-shell-queued-prompts]')).toBeNull();
  });

  it('defines the root class in the stylesheet the component imports', () => {
    // Without test.css, vitest resolves `styles.<key>` from an emulated map
    // regardless of the file's contents, so the className assertion above
    // cannot see a stylesheet-only rename. Read the file to pin that `.root`
    // is actually defined — a production build needs it for the root styles.
    const css = readFileSync(
      resolve(__dirname, 'ComposerStatusStack.module.css'),
      'utf8',
    );
    expect(css).toMatch(/^\.root\s*\{/m);
  });
});
