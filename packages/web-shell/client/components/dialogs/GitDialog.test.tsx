// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const {
  workspaceGitDiff,
  workspaceGitLog,
  workspaceGitHubPullRequests,
  workspaceClient,
  mockState,
} = vi.hoisted(() => {
  const workspaceGitDiff = vi.fn();
  const workspaceGitLog = vi.fn();
  const workspaceGitHubPullRequests = vi.fn();
  const workspaceClient = {
    workspaceByCwd: () => ({
      workspaceGitDiff,
      workspaceGitDiffFile: vi.fn(),
      workspaceGitLog,
      workspaceGitCommitDetail: vi.fn(),
      workspaceGitHubPullRequests,
    }),
  };
  const mockState = { capabilities: undefined as unknown };
  return {
    workspaceGitDiff,
    workspaceGitLog,
    workspaceGitHubPullRequests,
    workspaceClient,
    mockState,
  };
});

vi.mock('@qwen-code/webui/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/webui/daemon-react-sdk')>();
  return {
    ...actual,
    useWorkspace: () => ({
      client: workspaceClient,
      capabilities: mockState.capabilities,
    }),
  };
});

const { GitDialog } = await import('./GitDialog');

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mount(initialView: 'diff' | 'log' | 'prs' = 'diff', gitCwd?: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <GitDialog
          workspaceCwd="/repo"
          gitCwd={gitCwd}
          initialView={initialView}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );
  });
}

function rerender(initialView: 'diff' | 'log' | 'prs' = 'diff') {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <GitDialog
          workspaceCwd="/repo"
          initialView={initialView}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  mockState.capabilities = undefined;
});

describe('GitDialog', () => {
  it('switches views inside one dialog with complete tab semantics', async () => {
    workspaceGitDiff.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      filesCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
      files: [],
      hiddenCount: 0,
    });
    workspaceGitLog.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      entries: [],
      hasMore: false,
    });
    mount();
    await flush();

    const dialog = document.body.querySelector('[data-web-shell-dialog]');
    const historyTab = document.getElementById('git-dialog-tab-log');
    const panel = document.getElementById('git-dialog-panel');
    expect(dialog).toBeTruthy();
    expect(historyTab?.getAttribute('aria-selected')).toBe('false');
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(panel?.getAttribute('aria-labelledby')).toBe('git-dialog-tab-diff');

    await act(async () => {
      historyTab?.click();
    });
    await flush();

    expect(
      document.body.querySelectorAll('[data-web-shell-dialog]'),
    ).toHaveLength(1);
    expect(historyTab?.getAttribute('aria-selected')).toBe('true');
    expect(panel?.getAttribute('aria-labelledby')).toBe('git-dialog-tab-log');
    expect(workspaceGitLog).toHaveBeenCalledWith(50, 0, undefined);
  });

  it('supports arrow-key tab navigation', async () => {
    workspaceGitDiff.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      filesCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
      files: [],
      hiddenCount: 0,
    });
    workspaceGitLog.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      entries: [],
      hasMore: false,
    });
    mount();
    await flush();

    const diffTab = document.getElementById('git-dialog-tab-diff');
    await act(async () => {
      diffTab?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    await flush();

    expect(
      document
        .getElementById('git-dialog-tab-log')
        ?.getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('forwards gitCwd to both diff and log SDK calls', async () => {
    workspaceGitDiff.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      filesCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
      files: [],
      hiddenCount: 0,
    });
    workspaceGitLog.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      entries: [],
      hasMore: false,
    });
    mount('diff', '/worktrees/feature-x');
    await flush();

    expect(workspaceGitDiff).toHaveBeenCalledWith('/worktrees/feature-x');

    const historyTab = document.getElementById('git-dialog-tab-log');
    await act(async () => {
      historyTab?.click();
    });
    await flush();

    expect(workspaceGitLog).toHaveBeenCalledWith(50, 0, '/worktrees/feature-x');
  });

  it('shows the pull requests tab only when the daemon advertises the capability', async () => {
    workspaceGitDiff.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      filesCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
      files: [],
      hiddenCount: 0,
    });

    // Without the capability: two tabs, no PR fetch.
    mount();
    await flush();
    expect(document.getElementById('git-dialog-tab-prs')).toBeNull();
    expect(workspaceGitHubPullRequests).not.toHaveBeenCalled();

    act(() => root.unmount());
    container.remove();

    // With the capability: third tab fetches and renders PRs.
    mockState.capabilities = { features: ['workspace_github_prs'] };
    workspaceGitHubPullRequests.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      pullRequests: [
        {
          number: 42,
          title: 'Fix the flaky test',
          url: 'https://github.com/o/r/pull/42',
          author: 'octocat',
          headRefName: 'fix/flaky-test',
          state: 'open',
          reviewDecision: 'approved',
          checks: 'passing',
          updatedAt: Math.floor(Date.now() / 1000) - 120,
        },
      ],
    });
    mount('prs');
    await flush();

    const prsTab = document.getElementById('git-dialog-tab-prs');
    expect(prsTab?.getAttribute('aria-selected')).toBe('true');
    expect(workspaceGitHubPullRequests).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Fix the flaky test');
  });

  it('falls back to the diff view when PRs are requested without the capability', async () => {
    workspaceGitDiff.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      filesCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
      files: [],
      hiddenCount: 0,
    });
    mount('prs');
    await flush();

    expect(document.getElementById('git-dialog-tab-prs')).toBeNull();
    expect(
      document
        .getElementById('git-dialog-tab-diff')
        ?.getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('wraps arrow-key navigation across all three tabs', async () => {
    workspaceGitDiff.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      filesCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
      files: [],
      hiddenCount: 0,
    });
    workspaceGitHubPullRequests.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      pullRequests: [],
    });
    mockState.capabilities = { features: ['workspace_github_prs'] };
    mount('prs');
    await flush();

    const press = (id: string, key: string) =>
      act(async () => {
        document
          .getElementById(id)
          ?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });

    // ArrowRight on the last tab wraps to the first.
    await press('git-dialog-tab-prs', 'ArrowRight');
    await flush();
    expect(
      document
        .getElementById('git-dialog-tab-diff')
        ?.getAttribute('aria-selected'),
    ).toBe('true');

    // ArrowLeft on the first tab wraps to the last.
    await press('git-dialog-tab-diff', 'ArrowLeft');
    await flush();
    expect(
      document
        .getElementById('git-dialog-tab-prs')
        ?.getAttribute('aria-selected'),
    ).toBe('true');

    // Home/End jump to the ends of the three-tab list.
    await press('git-dialog-tab-prs', 'Home');
    await flush();
    expect(
      document
        .getElementById('git-dialog-tab-diff')
        ?.getAttribute('aria-selected'),
    ).toBe('true');
    await press('git-dialog-tab-diff', 'End');
    await flush();
    expect(
      document
        .getElementById('git-dialog-tab-prs')
        ?.getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('clamps to the diff view when the capability is withdrawn mid-session', async () => {
    workspaceGitDiff.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      filesCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
      files: [],
      hiddenCount: 0,
    });
    workspaceGitHubPullRequests.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      pullRequests: [],
    });
    mockState.capabilities = { features: ['workspace_github_prs'] };
    mount('prs');
    await flush();
    expect(
      document
        .getElementById('git-dialog-tab-prs')
        ?.getAttribute('aria-selected'),
    ).toBe('true');

    // A daemon reconnect resets capabilities to undefined; the PR tab must
    // disappear and the dialog must fall back to a rendered, selected tab
    // with intact ARIA wiring.
    mockState.capabilities = undefined;
    rerender('prs');
    await flush();

    expect(document.getElementById('git-dialog-tab-prs')).toBeNull();
    expect(
      document
        .getElementById('git-dialog-tab-diff')
        ?.getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      document
        .getElementById('git-dialog-panel')
        ?.getAttribute('aria-labelledby'),
    ).toBe('git-dialog-tab-diff');
  });
});
