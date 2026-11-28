// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonGitHubPullRequest } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import { indexAutofixPrWatches } from '../../utils/autofixPrWatches';
import {
  AutofixPrContext,
  type AutofixPrContextValue,
} from '../autofixPr/AutofixPrContext';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type TauriWindow = { __TAURI__?: { core?: { invoke?: unknown } } };

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// A STABLE client object: the dialog's fetch effect depends on `client`, so a
// fresh object per render would re-fire it in a loop.
const { workspaceGitHubPullRequests, workspaceClient } = vi.hoisted(() => {
  const workspaceGitHubPullRequests = vi.fn();
  const workspaceClient = {
    workspaceByCwd: () => ({ workspaceGitHubPullRequests }),
  };
  return { workspaceGitHubPullRequests, workspaceClient };
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: () => ({ client: workspaceClient }),
}));

const { GitHubPrsContent } = await import('./GitHubPrsDialog');

let container: HTMLDivElement;
let root: Root;

function mount(
  language: 'en' | 'zh-CN' = 'en',
  onSubtitleChange?: (subtitle: string | undefined) => void,
  options?: {
    autofixCtx?: AutofixPrContextValue;
    onActionTriggered?: () => void;
  },
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const content = (
    <GitHubPrsContent
      workspaceCwd="/repo"
      onSubtitleChange={onSubtitleChange}
      onActionTriggered={options?.onActionTriggered}
    />
  );
  act(() => {
    root.render(
      <I18nProvider language={language}>
        {options?.autofixCtx ? (
          <AutofixPrContext.Provider value={options.autofixCtx}>
            {content}
          </AutofixPrContext.Provider>
        ) : (
          content
        )}
      </I18nProvider>,
    );
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as TauriWindow).__TAURI__;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function pr(overrides: Partial<DaemonGitHubPullRequest> = {}) {
  return {
    number: 42,
    title: 'Fix the flaky test',
    url: 'https://github.com/o/r/pull/42',
    author: 'octocat',
    headRefName: 'fix/flaky-test',
    state: 'open' as const,
    reviewDecision: 'approved' as const,
    checks: 'passing' as const,
    updatedAt: Math.floor(Date.now() / 1000) - 120,
    ...overrides,
  };
}

function listPayload(
  pullRequests: DaemonGitHubPullRequest[],
  available = true,
) {
  return { v: 1 as const, workspaceCwd: '/repo', available, pullRequests };
}

describe('GitHubPrsContent', () => {
  it('renders pull requests with review badge, checks icon, and relative time', async () => {
    workspaceGitHubPullRequests.mockResolvedValue(listPayload([pr()]));
    mount();
    await flush();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Fix the flaky test');
    expect(text).toContain('#42');
    expect(text).toContain('fix/flaky-test');
    expect(text).toContain('octocat');
    expect(text).toContain('2 minutes ago');
    expect(text).toContain('Approved');
  });

  it('opens the pull request through the desktop opener when a row is clicked', async () => {
    workspaceGitHubPullRequests.mockResolvedValue(listPayload([pr()]));
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as TauriWindow).__TAURI__ = { core: { invoke } };
    mount();
    await flush();

    const row = document.body.querySelector(
      'a[aria-label*="pull request #42"]',
    );
    expect(row).toBeTruthy();
    let event: MouseEvent | undefined;
    await act(async () => {
      event = new MouseEvent('click', { bubbles: true, cancelable: true });
      row?.dispatchEvent(event);
    });

    expect(event?.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
      url: 'https://github.com/o/r/pull/42',
    });
  });

  it('keeps pull request rows as native links in plain browsers', async () => {
    workspaceGitHubPullRequests.mockResolvedValue(listPayload([pr()]));
    mount();
    await flush();

    const row = document.body.querySelector<HTMLAnchorElement>(
      'a[aria-label*="pull request #42"]',
    );
    expect(row?.href).toBe('https://github.com/o/r/pull/42');
    expect(row?.target).toBe('_blank');
    let event: MouseEvent | undefined;
    await act(async () => {
      event = new MouseEvent('click', { bubbles: true, cancelable: true });
      row?.dispatchEvent(event);
    });

    expect(event?.defaultPrevented).toBe(false);
  });

  it('renders draft and changes-requested pull requests', async () => {
    workspaceGitHubPullRequests.mockResolvedValue(
      listPayload([
        pr({
          number: 7,
          title: 'WIP: rewrite the parser',
          state: 'draft',
          reviewDecision: 'changes_requested',
          checks: 'failing',
        }),
      ]),
    );
    mount();
    await flush();

    const text = document.body.textContent ?? '';
    expect(text).toContain('WIP: rewrite the parser');
    expect(text).toContain('Changes requested');
  });

  it('renders the review-required badge', async () => {
    workspaceGitHubPullRequests.mockResolvedValue(
      listPayload([pr({ number: 9, reviewDecision: 'review_required' })]),
    );
    mount();
    await flush();

    const badge = document.body.querySelector('[class*="badgeReviewRequired"]');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('Review required');
  });

  it('renders the pending checks indicator', async () => {
    workspaceGitHubPullRequests.mockResolvedValue(
      listPayload([pr({ checks: 'pending' })]),
    );
    mount();
    await flush();

    const pending = document.body.querySelector('[class*="checksPending"]');
    expect(pending).toBeTruthy();
  });

  it('reports the open count through onSubtitleChange', async () => {
    workspaceGitHubPullRequests.mockResolvedValue(
      listPayload([pr(), pr({ number: 43 })]),
    );
    const onSubtitleChange = vi.fn();
    mount('en', onSubtitleChange);
    await flush();

    expect(onSubtitleChange).toHaveBeenCalledWith('2 open');
  });

  it('shows the empty state', async () => {
    workspaceGitHubPullRequests.mockResolvedValue(listPayload([]));
    mount();
    await flush();

    expect(document.body.textContent).toContain('No open pull requests');
  });

  it('shows the not-a-repository state', async () => {
    workspaceGitHubPullRequests.mockResolvedValue(listPayload([], false));
    mount();
    await flush();

    expect(document.body.textContent).toContain(
      'This workspace is not a git repository',
    );
  });

  it('shows gh install guidance when the daemon reports github_cli_unavailable', async () => {
    workspaceGitHubPullRequests.mockRejectedValue({
      body: { code: 'github_cli_unavailable' },
    });
    mount();
    await flush();

    const text = document.body.textContent ?? '';
    expect(text).toContain('GitHub CLI (gh) is not installed');
    expect(text).toContain('gh auth login');
  });

  it('shows the generic error state for other failures', async () => {
    workspaceGitHubPullRequests.mockRejectedValue(new Error('network down'));
    mount();
    await flush();

    expect(document.body.textContent).toContain('Failed to load pull requests');
  });

  it('localizes the interface', async () => {
    workspaceGitHubPullRequests.mockResolvedValue(listPayload([pr()]));
    mount('zh-CN');
    await flush();

    const text = document.body.textContent ?? '';
    expect(text).toContain('已批准');
    expect(text).toContain('2分钟前');
  });

  it('shows autofix action buttons, highlights failing PRs, and launches or opens watches', async () => {
    const startInNewSession = vi.fn().mockResolvedValue(undefined);
    const openWatch = vi.fn().mockResolvedValue(undefined);
    const onActionTriggered = vi.fn();
    const lists = new Map([
      [
        '',
        {
          available: true,
          watches: [
            {
              pr: 42,
              repo: 'o/r',
              host: 'github.com',
              url: 'https://github.com/o/r/pull/42',
              headRefName: 'fix/flaky-test',
              headSha: 'a'.repeat(40),
              pushes: 1,
              maxPushes: 10,
              session: 'watch-session',
              preparedAt: null,
              lastCheck: null,
              checkedRecently: true,
              lastRound: null,
              stopped: null,
              watch: {
                every: 2,
                reply: true,
                instructions: '',
                task: 'feedc0ffee12',
              },
              ended: null,
              needsHuman: [],
              worktreeExists: true,
              fix: null,
            },
          ],
        },
      ],
    ]);
    const autofixCtx: AutofixPrContextValue = {
      watchIndex: indexAutofixPrWatches(lists, new Map([['', '/repo']])),
      lists,
      error: null,
      loaded: true,
      reload: vi.fn().mockResolvedValue(undefined),
      canStartInWorkspace: () => true,
      startInNewSession,
      openWatch,
    };

    workspaceGitHubPullRequests.mockResolvedValue(
      listPayload([
        pr({ number: 42, checks: 'passing', reviewDecision: 'approved' }),
        pr({
          number: 43,
          url: 'https://github.com/o/r/pull/43',
          checks: 'failing',
          reviewDecision: 'changes_requested',
        }),
      ]),
    );
    mount('en', undefined, { autofixCtx, onActionTriggered });
    await flush();

    const buttons = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(
        '[data-testid="autofix-pr-action"]',
      ),
    );
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent).toBe('Watching');
    expect(buttons[1]?.textContent).toBe('Autofix');
    expect(buttons[1]?.className).toContain('prominent');

    await act(async () => {
      buttons[1]!.click();
      await Promise.resolve();
    });
    expect(onActionTriggered).toHaveBeenCalledTimes(1);
    expect(startInNewSession).toHaveBeenCalledWith({
      prompt: '/autofix-pr https://github.com/o/r/pull/43',
      workspaceCwd: '/repo',
      sessionTitle: 'Autofix PR #43',
    });

    await act(async () => {
      buttons[0]!.click();
      await Promise.resolve();
    });
    expect(onActionTriggered).toHaveBeenCalledTimes(2);
    expect(openWatch).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'watching' }),
    );
  });
});
