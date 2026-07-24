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

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useWorkspace: () => ({ client: workspaceClient }),
}));

const { GitHubPrsContent } = await import('./GitHubPrsDialog');

let container: HTMLDivElement;
let root: Root;

function mount(
  language: 'en' | 'zh-CN' = 'en',
  onSubtitleChange?: (subtitle: string | undefined) => void,
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language={language}>
        <GitHubPrsContent
          workspaceCwd="/repo"
          onSubtitleChange={onSubtitleChange}
        />
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

  it('opens the pull request on GitHub when a row is clicked', async () => {
    workspaceGitHubPullRequests.mockResolvedValue(listPayload([pr()]));
    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    mount();
    await flush();

    const row = document.body.querySelector(
      'button[aria-label*="pull request #42"]',
    );
    expect(row).toBeTruthy();
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(openSpy).toHaveBeenCalledWith(
      'https://github.com/o/r/pull/42',
      '_blank',
      'noopener,noreferrer',
    );
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
});
