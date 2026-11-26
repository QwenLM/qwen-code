// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonWorkspaceGitStatus } from '@qwen-code/sdk/daemon';
import postcss from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import chatStyles from './ChatEditor.module.css';
import {
  GitModePopover,
  type SessionGitIntent,
  validateBranchName,
} from './GitModePopover';
import popoverStyles from './GitModePopover.module.css';

function compileComponentStyles(): string {
  const sources: Array<{ file: string; styles: Record<string, string> }> = [
    { file: './ChatEditor.module.css', styles: chatStyles },
    { file: './GitModePopover.module.css', styles: popoverStyles },
  ];
  return sources
    .map(({ file, styles }) => {
      const root = postcss.parse(
        readFileSync(resolve(__dirname, file), 'utf8'),
      );
      root.walkAtRules((atRule) => {
        atRule.remove();
      });
      root.walkRules((rule) => {
        rule.selector = rule.selector.replace(
          /\.([A-Za-z_][A-Za-z0-9_-]*)/g,
          (_, name: string) => `.${styles[name] ?? name}`,
        );
      });
      return root.toString();
    })
    .join('\n');
}

describe('GitModePopover worktree selection', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onIntentChange = vi.fn();

  beforeEach(() => {
    onIntentChange.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(
    intent: SessionGitIntent,
    status?: DaemonWorkspaceGitStatus,
    compact = false,
    showDetails = true,
  ) {
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <GitModePopover
            branch="main"
            status={status}
            compact={compact}
            showDetails={showDetails}
            intent={intent}
            onIntentChange={onIntentChange}
          />
        </I18nProvider>,
      );
    });
  }

  async function openPopover() {
    const chip = container.querySelector<HTMLButtonElement>(
      '[data-testid="git-mode-chip"]',
    );
    expect(chip).not.toBeNull();
    await act(async () => chip!.click());
  }

  function worktreeOption() {
    const option = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ).find((button) => button.textContent?.startsWith('Worktree'));
    expect(option).toBeDefined();
    return option!;
  }

  it('selects worktree with one click and closes the popover', async () => {
    await render({ mode: 'current' });
    await openPopover();
    await act(async () => worktreeOption().click());

    expect(onIntentChange).toHaveBeenCalledExactlyOnceWith({
      mode: 'worktree',
    });
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
  });

  it('restores the checked worktree option and command when reopened', async () => {
    await render({ mode: 'current' });
    await openPopover();
    await act(async () => worktreeOption().click());
    await render({ mode: 'worktree' });
    await openPopover();

    expect(worktreeOption().getAttribute('aria-checked')).toBe('true');
    expect(worktreeOption().textContent).toContain('✓');
    expect(
      document.querySelector('[data-slot="popover-content"]')?.textContent,
    ).toContain('$ git worktree add --detach .qwen/worktrees/<slug>');
    expect(
      document.querySelector('[data-testid="git-mode-confirm-worktree"]'),
    ).toBeNull();
    expect(onIntentChange).toHaveBeenCalledExactlyOnceWith({
      mode: 'worktree',
    });
  });

  it('keeps compact status visible without changing intent actions', async () => {
    await render(
      { mode: 'current' },
      {
        v: 2,
        workspaceCwd: '/tmp/test-project',
        branch: 'main',
        conflicted: 1,
      },
      true,
    );
    const chip = container.querySelector('[data-testid="git-mode-chip"]');
    expect(chip?.getAttribute('aria-label')).toMatch(/^Git mode: main — /);
    expect(container.querySelector('[data-tone="error"]')).not.toBeNull();
    await openPopover();
    await act(async () => worktreeOption().click());
    expect(onIntentChange).toHaveBeenCalledExactlyOnceWith({
      mode: 'worktree',
    });
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();

    await render({ mode: 'current' });
    expect(container.querySelector('[data-tone]')).toBeNull();
  });

  it('computes visible compact severity dots and hides label/chevron across status tones', async () => {
    const style = document.createElement('style');
    style.textContent = compileComponentStyles();
    document.head.appendChild(style);
    try {
      const cases = [
        {
          status: {
            v: 2 as const,
            workspaceCwd: '/tmp/test-project',
            branch: 'main',
            conflicted: 1,
          },
          expectedTone: 'error',
        },
        {
          status: {
            v: 2 as const,
            workspaceCwd: '/tmp/test-project',
            branch: 'main',
            operation: 'rebase' as const,
          },
          expectedTone: 'warning',
        },
        {
          status: {
            v: 2 as const,
            workspaceCwd: '/tmp/test-project',
            branch: null,
            detached: true,
          },
          expectedTone: 'warning',
        },
        {
          status: {
            v: 2 as const,
            workspaceCwd: '/tmp/test-project',
            branch: 'main',
            staged: 1,
          },
          expectedTone: 'accent',
        },
      ];

      for (const { status, expectedTone } of cases) {
        await render({ mode: 'current' }, status, true);
        const dot = container.querySelector('[data-tone]');
        expect(dot?.getAttribute('data-tone')).toBe(expectedTone);
        expect(getComputedStyle(dot!).display).toBe('block');

        const label = container.querySelector(`.${chatStyles.gitBranchText}`);
        const chevron = container.querySelector(`.${popoverStyles.chevron}`);
        expect(label).not.toBeNull();
        expect(chevron).not.toBeNull();
        expect(getComputedStyle(label!).display).toBe('none');
        expect(getComputedStyle(chevron!).display).toBe('none');
      }

      await render({ mode: 'current' }, cases[0].status, false);
      const expandedDot = container.querySelector('[data-tone]');
      expect(expandedDot).not.toBeNull();
      expect(getComputedStyle(expandedDot!).display).toBe('none');

      await render(
        { mode: 'current' },
        {
          v: 2,
          workspaceCwd: '/tmp/test-project',
          branch: 'main',
          computedAt: 1,
        },
        true,
      );
      expect(container.querySelector('[data-tone]')).toBeNull();

      await render(
        { mode: 'current' },
        {
          v: 2,
          workspaceCwd: '/tmp/test-project',
          branch: 'main',
          operation: 'rebase',
          conflicted: 2,
        },
        false,
        false,
      );
      const mediumDot = container.querySelector('[data-tone]');
      const mediumLabel = container.querySelector(
        `.${chatStyles.gitBranchText}`,
      );
      const mediumChevron = container.querySelector(
        `.${popoverStyles.chevron}`,
      );
      const mediumIndicators = container.querySelector(
        `.${chatStyles.gitBranchIndicators}`,
      );
      expect(mediumDot?.getAttribute('data-tone')).toBe('error');
      expect(getComputedStyle(mediumDot!).display).toBe('block');
      expect(getComputedStyle(mediumLabel!).display).not.toBe('none');
      expect(getComputedStyle(mediumChevron!).display).not.toBe('none');
      expect(mediumIndicators).toBeNull();
    } finally {
      style.remove();
    }
  });
});

// Shared test vectors — the same inputs are asserted on the server side
// in packages/cli/src/serve/server.test.ts (POST /session branch validation).
// If either predicate drifts, these tests catch it.
describe('validateBranchName', () => {
  it.each([
    'feat/../x',
    'feat//x',
    'feat@{1}',
    'feat.lock',
    '.hidden',
    '-feat',
    'HEAD',
    'feature.git',
    '',
  ])('rejects %s', (name) => {
    expect(validateBranchName(name)).toBe(false);
  });

  it.each(['feat/x', 'fix/bug-123', 'my-branch', 'release/v1.0.0', 'a'])(
    'accepts %s',
    (name) => {
      expect(validateBranchName(name)).toBe(true);
    },
  );

  it('rejects names exceeding the byte-length caps', () => {
    // Mirrors the server-side caps (200 bytes per `/`-separated component,
    // 1000 bytes total). Counted in UTF-8 bytes, so CJK chars (3 bytes each)
    // trip the component cap at ~86 chars.
    expect(validateBranchName('a'.repeat(201))).toBe(false);
    expect(validateBranchName(`feat/${'a'.repeat(201)}`)).toBe(false);
    expect(validateBranchName('a'.repeat(1001))).toBe(false);
    expect(validateBranchName('功'.repeat(86))).toBe(false);
  });

  it('accepts a name at the byte-length boundary', () => {
    expect(validateBranchName('a'.repeat(200))).toBe(true);
  });
});
