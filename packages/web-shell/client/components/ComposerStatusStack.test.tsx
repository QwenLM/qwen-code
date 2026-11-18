// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss, { type Rule } from 'postcss';
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

  it('defines a live root rule and the child-coupling selectors in the stylesheet', () => {
    // Without test.css, vitest resolves `styles.<key>` from an emulated map
    // regardless of the file's contents, so the className assertion above
    // cannot see the stylesheet. Parse it (as ChatEditor.css.test.ts does) to
    // pin a live `.root` rule and both child-coupling rules with their full
    // selector chains and declarations: emptying or commenting out a rule,
    // renaming either coupling attribute, or re-pointing the divider's parent
    // or preceding sibling must fail here.
    const css = readFileSync(
      resolve(__dirname, 'ComposerStatusStack.module.css'),
      'utf8',
    );
    const sheet = postcss.parse(css);
    const root = sheet.nodes?.find(
      (node): node is Rule =>
        node.type === 'rule' && node.selector.trim() === '.root',
    );
    expect(root).toBeDefined();
    expect(
      (root?.nodes ?? []).filter((node) => node.type === 'decl').length,
    ).toBeGreaterThan(0);
    const selectors: string[] = [];
    const coupling: Rule[] = [];
    sheet.walkRules((rule) => {
      const tidy = rule.selectors.map((selector) =>
        selector.replace(/\s+/g, ' ').trim(),
      );
      selectors.push(...tidy);
      if (
        tidy.some(
          (selector) =>
            selector.includes('[data-web-shell-queued-prompts]') ||
            selector.includes('[data-web-shell-goal-status]'),
        )
      ) {
        coupling.push(rule);
      }
    });
    // Both halves of the child reset, and the full divider chain (parent and
    // preceding sibling included), must survive verbatim.
    expect(selectors).toContain(
      '.root > :global([data-web-shell-queued-prompts])',
    );
    expect(selectors).toContain('.root > [data-web-shell-goal-status]');
    expect(selectors).toContain(
      '.root > :global([data-web-shell-queued-prompts]) + [data-web-shell-goal-status]',
    );
    // The reset and divider rules must still carry their declarations.
    expect(coupling.length).toBeGreaterThan(0);
    for (const rule of coupling) {
      expect(
        (rule.nodes ?? []).filter((node) => node.type === 'decl').length,
      ).toBeGreaterThan(0);
    }
  });
});
