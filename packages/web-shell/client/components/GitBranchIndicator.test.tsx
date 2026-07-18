// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonWorkspaceGitStatus } from '@qwen-code/sdk/daemon';
import { getTranslator, I18nProvider } from '../i18n';
import { GitBranchIndicator } from './GitBranchIndicator';

let container: HTMLDivElement;
let root: Root | undefined;

function render(
  props: {
    branch: string;
    status?: DaemonWorkspaceGitStatus;
    compact?: boolean;
    onOpenDiff?: () => void;
  },
  language: 'en' | 'zh-CN' = 'en',
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language={language}>
        <GitBranchIndicator {...props} />
      </I18nProvider>,
    );
  });
}

afterEach(() => {
  // The localization tests below assert on getTranslator() without render(),
  // so `root` may already be unmounted by a preceding test's afterEach — guard
  // instead of unconditionally double-unmounting (a TypeError under React 19).
  if (root) {
    act(() => root.unmount());
    root = undefined;
  }
  container.remove();
});

function chip(): HTMLElement {
  const el = container.querySelector('[data-web-shell-git-branch]');
  if (!el) throw new Error('branch indicator was not rendered');
  return el as HTMLElement;
}

describe('GitBranchIndicator', () => {
  it('renders a read-only branch indicator with the complete name', () => {
    const branch = 'feature/a-very-long-web-shell-branch-name';
    render({ branch });

    const el = chip();
    expect(el.tagName).toBe('OUTPUT');
    expect(el.textContent).toContain(branch);
    // No interactive control — it is a status chip, not a button.
    expect(container.querySelector('button')).toBeNull();
    // A clean repo carries no dirty / operation markers.
    expect(el.getAttribute('data-dirty')).toBeNull();
    expect(el.getAttribute('data-operation')).toBeNull();
  });

  it('renders a clickable button that fires onOpenDiff when provided', () => {
    let opened = 0;
    render({ branch: 'main', onOpenDiff: () => (opened += 1) });

    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('data-clickable')).toBe('true');
    expect(button?.tagName).toBe('BUTTON');
    act(() => button?.click());
    expect(opened).toBe(1);
  });

  it('marks a dirty working tree and shows ahead/behind + stash', () => {
    render({
      branch: 'main',
      status: {
        v: 2,
        workspaceCwd: '/repo',
        branch: 'main',
        hasUpstream: true,
        ahead: 2,
        behind: 1,
        staged: 3,
        unstaged: 0,
        untracked: 0,
        stashCount: 4,
      },
    });

    const el = chip();
    expect(el.getAttribute('data-dirty')).toBe('true');
    expect(el.textContent).toContain('↑2');
    expect(el.textContent).toContain('↓1');
    expect(el.textContent).toContain('4');
    // Accessible label summarizes the enriched state.
    const label = el.getAttribute('aria-label') ?? '';
    expect(label).toContain('Current Git branch: main');
    expect(label).toContain('3 staged');
    expect(label).toContain('2 ahead');
    expect(label).toContain('1 behind');
    expect(label).toContain('4 stashed');
  });

  it('surfaces an in-progress operation and conflict count', () => {
    render({
      branch: 'main',
      status: {
        v: 2,
        workspaceCwd: '/repo',
        branch: 'main',
        conflicted: 7,
        operation: 'rebase',
      },
    });

    const el = chip();
    expect(el.getAttribute('data-operation')).toBe('rebase');
    expect(el.textContent).toContain('Rebasing');
    expect(el.textContent).toContain('7');
    expect(el.getAttribute('aria-label')).toContain('7 conflicted');
  });

  it('treats a conflicted-only working tree as dirty', () => {
    // A merge where every changed file is conflicted has staged=unstaged=
    // untracked=0 but conflicted>0 — still uncommitted changes, so still dirty.
    render({
      branch: 'main',
      status: {
        v: 2,
        workspaceCwd: '/repo',
        branch: 'main',
        conflicted: 3,
      },
    });

    expect(chip().getAttribute('data-dirty')).toBe('true');
  });

  it('flags a detached HEAD', () => {
    render({
      branch: 'a1b2c3d',
      status: { v: 2, workspaceCwd: '/repo', branch: null, detached: true },
    });

    const el = chip();
    expect(el.getAttribute('data-detached')).toBe('true');
    expect(el.getAttribute('aria-label')).toContain('Detached HEAD');
  });

  it('collapses to a single severity dot in compact mode', () => {
    render({
      branch: 'main',
      compact: true,
      status: {
        v: 2,
        workspaceCwd: '/repo',
        branch: 'main',
        conflicted: 2,
        staged: 1,
      },
    });

    const el = chip();
    // Conflict outranks dirty, so the badge takes the error tone.
    const dot = el.querySelector('[data-tone]');
    expect(dot?.getAttribute('data-tone')).toBe('error');
    // Inline indicators are suppressed in the icon-only chip.
    expect(el.textContent).not.toContain('↑');
  });

  it('omits the badge dot for a clean compact chip', () => {
    render({ branch: 'main', compact: true, status: undefined });
    expect(chip().querySelector('[data-tone]')).toBeNull();
  });

  it('localizes the accessible branch label', () => {
    expect(getTranslator('en')('git.currentBranch', { branch: 'main' })).toBe(
      'Current Git branch: main',
    );
    expect(
      getTranslator('zh-CN')('git.currentBranch', { branch: 'main' }),
    ).toBe('当前 Git 分支：main');
  });

  it('localizes the enriched state phrases', () => {
    expect(getTranslator('en')('git.operation.rebase')).toBe('Rebasing');
    expect(getTranslator('zh-CN')('git.operation.rebase')).toBe('变基中');
    expect(getTranslator('zh-CN')('git.staged', { count: 3 })).toBe('3 已暂存');
    expect(getTranslator('zh-CN')('git.ahead', { count: 2 })).toBe('领先 2');
  });
});
