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
  workspaceGitCommit,
  workspaceGitPush,
  workspaceGitBranches,
  workspaceGitHubDefaultBranch,
  workspaceGit,
  workspaceGitHubCreatePullRequest,
  updateSessionMetadata,
  btwSession,
  workspaceClient,
  mockState,
} = vi.hoisted(() => {
  const workspaceGitDiff = vi.fn();
  const workspaceGitLog = vi.fn();
  const workspaceGitHubPullRequests = vi.fn();
  const workspaceGitCommit = vi.fn();
  const workspaceGitPush = vi.fn();
  const workspaceGitBranches = vi.fn();
  const workspaceGitHubDefaultBranch = vi.fn();
  const workspaceGit = vi.fn();
  const workspaceGitHubCreatePullRequest = vi.fn();
  const updateSessionMetadata = vi.fn();
  const btwSession = vi.fn();
  const workspaceClient = {
    btwSession,
    workspaceByCwd: () => ({
      workspaceGitDiff,
      workspaceGitDiffFile: vi.fn(),
      workspaceGitLog,
      workspaceGitCommitDetail: vi.fn(),
      workspaceGitHubPullRequests,
      workspaceGitCommit,
      workspaceGitPush,
      workspaceGitBranches,
      workspaceGitHubDefaultBranch,
      workspaceGit,
      workspaceGitHubCreatePullRequest,
      updateSessionMetadata,
    }),
  };
  const mockState = { capabilities: undefined as unknown };
  return {
    workspaceGitDiff,
    workspaceGitLog,
    workspaceGitHubPullRequests,
    workspaceGitCommit,
    workspaceGitPush,
    workspaceGitBranches,
    workspaceGitHubDefaultBranch,
    workspaceGit,
    workspaceGitHubCreatePullRequest,
    updateSessionMetadata,
    btwSession,
    workspaceClient,
    mockState,
  };
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@qwen-code/web-shell/daemon-react-sdk')
    >();
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

  it('passes gitCwd to commit and push SDK calls in the commit view', async () => {
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
    workspaceGitCommit.mockResolvedValue({
      sha: 'abc1234',
      subject: 'test commit',
    });
    workspaceGitPush.mockResolvedValue({
      success: true,
      output: '',
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <GitDialog
            workspaceCwd="/repo"
            gitCwd="/worktrees/wt"
            initialView="commit"
            onClose={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await flush();

    const textarea = document.body.querySelector(
      '[data-web-shell-dialog] textarea',
    );
    expect(textarea).toBeTruthy();

    // Set the commit message via React's onChange.
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(textarea, 'fix: test commit');
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    // Click "Commit & Push".
    const buttons = document.body.querySelectorAll(
      '[data-web-shell-dialog] button',
    );
    const commitPushBtn = Array.from(buttons).find((b) =>
      b.textContent?.includes('Commit and Push'),
    );
    expect(commitPushBtn).toBeTruthy();

    await act(async () => {
      commitPushBtn!.click();
    });
    await flush();

    expect(workspaceGitCommit).toHaveBeenCalledWith(
      'fix: test commit',
      { all: true },
      '/worktrees/wt',
    );
    expect(workspaceGitPush).toHaveBeenCalledWith(
      { setUpstream: true },
      '/worktrees/wt',
    );
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

  it('lets arrow keys leave the commit tab back to the regular tabs', async () => {
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

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <GitDialog
            workspaceCwd="/repo"
            initialView="commit"
            onClose={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await flush();

    const commitTab = document.getElementById('git-dialog-tab-commit');
    expect(commitTab).toBeTruthy();

    // Commit is the rightmost tab; ArrowLeft moves to the last regular tab
    // (log, since the PR tab is absent without the capability) instead of
    // being swallowed.
    await act(async () => {
      commitTab?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
      );
    });
    await flush();

    expect(
      document
        .getElementById('git-dialog-tab-commit')
        ?.getAttribute('aria-selected'),
    ).toBe('false');
    expect(
      document
        .getElementById('git-dialog-tab-log')
        ?.getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('offers a retry when the PR base-branch list fails to load', async () => {
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
    workspaceGitHubDefaultBranch.mockResolvedValue({ branch: 'origin/main' });
    workspaceGit.mockResolvedValue({ branch: 'feat/x', detached: false });
    workspaceGitBranches.mockRejectedValueOnce(new Error('boom'));
    mockState.capabilities = { features: ['workspace_github_prs'] };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <GitDialog
            workspaceCwd="/repo"
            initialView="commit"
            onClose={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await flush();

    // Open the PR form so the base-branch dropdown fetches (and fails).
    const createPrBtn = Array.from(
      document.body.querySelectorAll('[data-web-shell-dialog] button'),
    ).find((b) => b.textContent?.includes('Create Pull Request'));
    expect(createPrBtn).toBeTruthy();
    await act(async () => {
      createPrBtn!.click();
    });
    await flush();

    // Open the base-branch dropdown: it must show an error + retry, not a
    // permanent "Loading…".
    const branchTrigger = document.body.querySelector(
      'button[aria-label="Base branch"]',
    );
    expect(branchTrigger).toBeTruthy();
    await act(async () => {
      (branchTrigger as HTMLButtonElement).click();
    });
    await flush();

    expect(document.body.textContent).toContain('Failed to load branches');
    const retryBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Retry'),
    );
    expect(retryBtn).toBeTruthy();

    // Retry succeeds and renders the fetched branches.
    workspaceGitBranches.mockResolvedValue({
      local: [{ name: 'main' }],
      remote: [{ name: 'origin/main' }],
    });
    await act(async () => {
      retryBtn!.click();
    });
    await flush();

    expect(document.body.textContent).not.toContain('Failed to load branches');
    expect(workspaceGitBranches).toHaveBeenCalledTimes(2);
  });

  it('commits without pushing when only the Commit button is clicked', async () => {
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
    workspaceGitCommit.mockResolvedValue({
      sha: 'abc1234',
      subject: 'test commit',
    });
    workspaceGitPush.mockResolvedValue({ success: true, output: '' });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <GitDialog
            workspaceCwd="/repo"
            initialView="commit"
            onClose={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await flush();

    const textarea = document.body.querySelector(
      '[data-web-shell-dialog] textarea',
    );
    expect(textarea).toBeTruthy();

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(textarea, 'fix: commit only');
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    const buttons = document.body.querySelectorAll(
      '[data-web-shell-dialog] button',
    );
    const commitBtn = Array.from(buttons).find(
      (b) =>
        b.textContent?.includes('Commit') &&
        !b.textContent?.includes('Push') &&
        b.getAttribute('role') !== 'tab',
    );
    expect(commitBtn).toBeTruthy();
    expect((commitBtn as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      commitBtn!.click();
    });
    await flush();

    expect(workspaceGitCommit).toHaveBeenCalledWith(
      'fix: commit only',
      { all: true },
      undefined,
    );
    expect(workspaceGitPush).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Committed abc1234');
  });

  it('reports commit-success-push-failed when the push rejects', async () => {
    workspaceGitCommit.mockResolvedValue({
      sha: 'def5678',
      subject: 'test commit',
    });
    workspaceGitPush.mockRejectedValue(new Error('network unreachable'));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <GitDialog
            workspaceCwd="/repo"
            initialView="commit"
            onClose={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await flush();

    const textarea = document.body.querySelector(
      '[data-web-shell-dialog] textarea',
    );
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(textarea, 'fix: will fail push');
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    const buttons = document.body.querySelectorAll(
      '[data-web-shell-dialog] button',
    );
    const commitPushBtn = Array.from(buttons).find((b) =>
      b.textContent?.includes('Commit and Push'),
    );
    expect(commitPushBtn).toBeTruthy();

    await act(async () => {
      commitPushBtn!.click();
    });
    await flush();

    expect(workspaceGitCommit).toHaveBeenCalled();
    expect(workspaceGitPush).toHaveBeenCalled();
    expect(document.body.textContent).toContain('def5678');
    expect(document.body.textContent).toContain('network unreachable');
  });

  it('creates a pull request via the SDK', async () => {
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
    workspaceGit.mockResolvedValue({ branch: 'feat/x', detached: false });
    workspaceGitHubDefaultBranch.mockResolvedValue({ branch: 'origin/main' });
    workspaceGitBranches.mockResolvedValue({
      local: [{ name: 'main' }],
      remote: [{ name: 'origin/main' }],
    });
    workspaceGitHubCreatePullRequest.mockResolvedValue({
      number: 99,
      url: 'https://github.com/o/r/pull/99',
    });
    mockState.capabilities = { features: ['workspace_github_prs'] };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <GitDialog
            workspaceCwd="/repo"
            initialView="commit"
            onClose={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await flush();

    // Open the PR form.
    const createPrBtn = Array.from(
      document.body.querySelectorAll('[data-web-shell-dialog] button'),
    ).find((b) => b.textContent?.includes('Create Pull Request'));
    expect(createPrBtn).toBeTruthy();
    await act(async () => {
      createPrBtn!.click();
    });
    await flush();

    // Fill in the PR title.
    const titleInput = document.body.querySelector(
      '[data-web-shell-dialog] input',
    );
    expect(titleInput).toBeTruthy();
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(titleInput, 'feat: add new feature');
      titleInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    // Submit the PR.
    const submitBtn = Array.from(
      document.body.querySelectorAll('[data-web-shell-dialog] button'),
    ).find(
      (b) =>
        b.textContent?.includes('Create') &&
        !b.textContent?.includes('Pull Request'),
    );
    expect(submitBtn).toBeTruthy();
    await act(async () => {
      submitBtn!.click();
    });
    await flush();

    expect(workspaceGitHubCreatePullRequest).toHaveBeenCalledWith(
      {
        title: 'feat: add new feature',
        body: undefined,
        base: 'main',
      },
      undefined,
    );
    expect(document.body.textContent).toContain('#99');
  });

  it('binds the created PR to the current session', async () => {
    workspaceGitDiff.mockResolvedValue({
      files: [],
      linesAdded: 0,
      linesRemoved: 0,
      hiddenCount: 0,
    });
    workspaceGit.mockResolvedValue({ branch: 'feat/x', detached: false });
    workspaceGitHubDefaultBranch.mockResolvedValue({ branch: 'origin/main' });
    workspaceGitBranches.mockResolvedValue({
      local: [{ name: 'main' }],
      remote: [{ name: 'origin/main' }],
    });
    workspaceGitHubCreatePullRequest.mockResolvedValue({
      number: 99,
      url: 'https://github.com/o/r/pull/99',
    });
    updateSessionMetadata.mockResolvedValue({});
    mockState.capabilities = { features: ['workspace_github_prs'] };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <GitDialog
            workspaceCwd="/repo"
            initialView="commit"
            sessionId="sess-1"
            onClose={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await flush();

    const createPrBtn = Array.from(
      document.body.querySelectorAll('[data-web-shell-dialog] button'),
    ).find((b) => b.textContent?.includes('Create Pull Request'));
    expect(createPrBtn).toBeTruthy();
    await act(async () => {
      createPrBtn!.click();
    });
    await flush();

    const titleInput = document.body.querySelector(
      '[data-web-shell-dialog] input',
    );
    expect(titleInput).toBeTruthy();
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(titleInput, 'feat: add new feature');
      titleInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    const submitBtn = Array.from(
      document.body.querySelectorAll('[data-web-shell-dialog] button'),
    ).find(
      (b) =>
        b.textContent?.includes('Create') &&
        !b.textContent?.includes('Pull Request'),
    );
    expect(submitBtn).toBeTruthy();
    await act(async () => {
      submitBtn!.click();
    });
    await flush();

    expect(updateSessionMetadata).toHaveBeenCalledWith('sess-1', {
      pr: {
        number: 99,
        url: 'https://github.com/o/r/pull/99',
        state: 'open',
      },
    });
  });

  it('keeps the PR-creation success when the session binding fails', async () => {
    workspaceGitDiff.mockResolvedValue({
      files: [],
      linesAdded: 0,
      linesRemoved: 0,
      hiddenCount: 0,
    });
    workspaceGit.mockResolvedValue({ branch: 'feat/x', detached: false });
    workspaceGitHubDefaultBranch.mockResolvedValue({ branch: 'origin/main' });
    workspaceGitBranches.mockResolvedValue({
      local: [{ name: 'main' }],
      remote: [{ name: 'origin/main' }],
    });
    workspaceGitHubCreatePullRequest.mockResolvedValue({
      number: 99,
      url: 'https://github.com/o/r/pull/99',
    });
    updateSessionMetadata.mockRejectedValue(new Error('daemon gone'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockState.capabilities = { features: ['workspace_github_prs'] };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <GitDialog
            workspaceCwd="/repo"
            initialView="commit"
            sessionId="sess-1"
            onClose={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await flush();

    const createPrBtn = Array.from(
      document.body.querySelectorAll('[data-web-shell-dialog] button'),
    ).find((b) => b.textContent?.includes('Create Pull Request'));
    await act(async () => {
      createPrBtn!.click();
    });
    await flush();

    const titleInput = document.body.querySelector(
      '[data-web-shell-dialog] input',
    );
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(titleInput, 'feat: add new feature');
      titleInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    const submitBtn = Array.from(
      document.body.querySelectorAll('[data-web-shell-dialog] button'),
    ).find(
      (b) =>
        b.textContent?.includes('Create') &&
        !b.textContent?.includes('Pull Request'),
    );
    await act(async () => {
      submitBtn!.click();
    });
    await flush();
    // Let the rejected binding promise settle.
    await flush();

    expect(updateSessionMetadata).toHaveBeenCalledWith('sess-1', {
      pr: {
        number: 99,
        url: 'https://github.com/o/r/pull/99',
        state: 'open',
      },
    });
    // The binding failure is a warning only — the created PR status stays.
    expect(document.body.textContent).toContain('#99');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('binds the PR to the freshly resolved session after a stale-id retry', async () => {
    workspaceGitDiff.mockResolvedValue({
      files: [{ path: 'a.ts', added: 3, removed: 1, isBinary: false }],
      linesAdded: 3,
      linesRemoved: 1,
      hiddenCount: 0,
    });
    workspaceGit.mockResolvedValue({ branch: 'feat/x', detached: false });
    workspaceGitHubDefaultBranch.mockResolvedValue({ branch: 'origin/main' });
    workspaceGitBranches.mockResolvedValue({
      local: [{ name: 'main' }],
      remote: [{ name: 'origin/main' }],
    });
    workspaceGitHubCreatePullRequest.mockResolvedValue({
      number: 99,
      url: 'https://github.com/o/r/pull/99',
    });
    updateSessionMetadata.mockResolvedValue({});
    // The prop session is dead (daemon restarted); the dialog's side query
    // force-creates a fresh one and the ref must keep it across re-renders
    // until doCreatePr binds the PR.
    btwSession
      .mockRejectedValueOnce(new Error('no session'))
      .mockResolvedValue({ answer: 'feat: change a' });
    // The resolver's list path returns the dead id (generation's first
    // btwSession fails on it); the force-create path returns the fresh id.
    const resolveSessionForWorkspace = vi
      .fn()
      .mockImplementation((_cwd: string, force?: boolean) =>
        Promise.resolve(force ? 'sess-fresh' : 'sess-stale'),
      );
    mockState.capabilities = { features: ['workspace_github_prs'] };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <GitDialog
            workspaceCwd="/repo"
            initialView="commit"
            sessionId="sess-stale"
            resolveSessionForWorkspace={resolveSessionForWorkspace}
            onClose={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await flush();
    await flush();

    // Commit-message generation ran through the retry: first call on the
    // stale id failed, the retry hit the fresh id.
    expect(btwSession).toHaveBeenCalledTimes(2);
    expect(btwSession.mock.calls[0]?.[0]).toBe('sess-stale');
    expect(btwSession.mock.calls[1]?.[0]).toBe('sess-fresh');

    const createPrBtn = Array.from(
      document.body.querySelectorAll('[data-web-shell-dialog] button'),
    ).find((b) => b.textContent?.includes('Create Pull Request'));
    expect(createPrBtn).toBeTruthy();
    await act(async () => {
      createPrBtn!.click();
    });
    await flush();

    const titleInput = document.body.querySelector(
      '[data-web-shell-dialog] input',
    );
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(titleInput, 'feat: change a');
      titleInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    const submitBtn = Array.from(
      document.body.querySelectorAll('[data-web-shell-dialog] button'),
    ).find(
      (b) =>
        b.textContent?.includes('Create') &&
        !b.textContent?.includes('Pull Request'),
    );
    expect(submitBtn).toBeTruthy();
    await act(async () => {
      submitBtn!.click();
    });
    await flush();

    expect(updateSessionMetadata).toHaveBeenCalledWith('sess-fresh', {
      pr: {
        number: 99,
        url: 'https://github.com/o/r/pull/99',
        state: 'open',
      },
    });
  });
});
