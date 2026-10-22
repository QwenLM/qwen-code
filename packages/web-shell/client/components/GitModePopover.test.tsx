// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import {
  GitModePopover,
  type SessionGitIntent,
  validateBranchName,
} from './GitModePopover';

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

  async function render(intent: SessionGitIntent) {
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <GitModePopover
            branch="main"
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
    ).toContain('$ git worktree add .qwen/worktrees/<slug>');
    expect(
      document.querySelector('[data-testid="git-mode-confirm-worktree"]'),
    ).toBeNull();
    expect(onIntentChange).toHaveBeenCalledExactlyOnceWith({
      mode: 'worktree',
    });
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
