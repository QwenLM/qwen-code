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

// A STABLE client object: the dialog's fetch effect depends on `client`, so a
// fresh object per render would re-fire it in a loop.
const { workspaceGitLog, workspaceGitCommitDetail, workspaceClient } =
  vi.hoisted(() => {
    const workspaceGitLog = vi.fn();
    const workspaceGitCommitDetail = vi.fn();
    const workspaceClient = {
      workspaceByCwd: () => ({ workspaceGitLog, workspaceGitCommitDetail }),
    };
    return { workspaceGitLog, workspaceGitCommitDetail, workspaceClient };
  });

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useWorkspace: () => ({ client: workspaceClient }),
}));

const { GitLogDialog } = await import('./GitLogDialog');

let container: HTMLDivElement;
let root: Root;

function mount(workspaceCwd = '/repo', language: 'en' | 'zh-CN' = 'en') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language={language}>
        <GitLogDialog workspaceCwd={workspaceCwd} onClose={vi.fn()} />
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
});

let shaSeq = 0;
function entry(overrides: Record<string, unknown> = {}) {
  shaSeq += 1;
  const sha = String(shaSeq).padStart(40, '0');
  return {
    sha,
    shortSha: sha.slice(0, 7),
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authorDate: Math.floor(Date.now() / 1000) - 120, // ~2 minutes ago
    subject: `commit ${shaSeq}`,
    refs: '',
    parents: ['0000000000000000000000000000000000000000'],
    ...overrides,
  };
}

function logPayload(entries: unknown[], hasMore = false, available = true) {
  return { v: 1 as const, workspaceCwd: '/repo', available, entries, hasMore };
}

describe('GitLogDialog', () => {
  it('renders the commit list with author and relative time', async () => {
    workspaceGitLog.mockResolvedValue(
      logPayload([entry({ subject: 'first change', authorName: 'Ada' })]),
    );
    mount();
    await flush();

    expect(workspaceGitLog).toHaveBeenCalledWith(50, 0);
    expect(document.body.textContent).toContain('first change');
    expect(document.body.textContent).toContain('Ada');
    expect(document.body.textContent).toContain('2 minutes ago');
  });

  it('localizes relative time and the copy action', async () => {
    workspaceGitLog.mockResolvedValue(logPayload([entry()]));
    mount('/repo', 'zh-CN');
    await flush();

    expect(document.body.textContent).toContain('2分钟前');
    expect(
      document.body.querySelector('button[aria-label^="复制提交"]'),
    ).toBeTruthy();
  });

  it('shows the loading placeholder before the first page resolves', async () => {
    workspaceGitLog.mockReturnValue(new Promise(() => {})); // never resolves
    mount();
    // No flush — still pending.
    expect(document.body.textContent).toContain('Loading history');
  });

  it('shows the error placeholder when the list fails to load', async () => {
    workspaceGitLog.mockRejectedValue(new Error('boom'));
    mount();
    await flush();
    expect(document.body.textContent).toContain('Failed to load history');
  });

  it('shows the unavailable placeholder when git is unavailable', async () => {
    workspaceGitLog.mockResolvedValue(logPayload([], false, false));
    mount();
    await flush();
    expect(document.body.textContent).toContain('Git is not available');
  });

  it('shows the empty placeholder for a repo with no commits', async () => {
    workspaceGitLog.mockResolvedValue(logPayload([], false, true));
    mount();
    await flush();
    expect(document.body.textContent).toContain('No commits yet');
  });

  it('paginates: Load more fetches the next page at the current offset and appends', async () => {
    workspaceGitLog
      .mockResolvedValueOnce(logPayload([entry({ subject: 'newest' })], true))
      .mockResolvedValueOnce(logPayload([entry({ subject: 'older' })], false));
    mount();
    await flush();

    const loadMore = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent === 'Load more',
    ) as HTMLButtonElement;
    expect(loadMore).toBeTruthy();
    await act(async () => {
      loadMore.click();
    });
    await flush();

    // Second call uses the accumulated offset (1 entry already loaded).
    expect(workspaceGitLog).toHaveBeenNthCalledWith(2, 50, 1);
    expect(document.body.textContent).toContain('newest');
    expect(document.body.textContent).toContain('older');
  });

  it('deduplicates overlapping pages while advancing the server offset', async () => {
    const duplicate = entry({ subject: 'duplicate' });
    workspaceGitLog
      .mockResolvedValueOnce(logPayload([duplicate], true))
      .mockResolvedValueOnce(
        logPayload([duplicate, entry({ subject: 'older' })], true),
      )
      .mockResolvedValueOnce(logPayload([], false));
    mount();
    await flush();

    const loadMore = () =>
      Array.from(document.body.querySelectorAll('button')).find(
        (button) => button.textContent === 'Load more',
      ) as HTMLButtonElement;
    await act(async () => {
      loadMore().click();
    });
    await flush();
    await act(async () => {
      loadMore().click();
    });
    await flush();

    expect(workspaceGitLog).toHaveBeenNthCalledWith(2, 50, 1);
    expect(workspaceGitLog).toHaveBeenNthCalledWith(3, 50, 3);
    expect(document.body.textContent?.match(/duplicate/g)).toHaveLength(1);
    expect(document.body.textContent).toContain('older');
  });

  it('surfaces a load-more failure instead of failing silently', async () => {
    workspaceGitLog
      .mockResolvedValueOnce(logPayload([entry()], true))
      .mockRejectedValueOnce(new Error('page 2 down'));
    mount();
    await flush();

    const loadMore = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent === 'Load more',
    ) as HTMLButtonElement;
    await act(async () => {
      loadMore.click();
    });
    await flush();

    expect(document.body.textContent).toContain('Failed to load history');
  });

  it('expands a commit and loads its detail (body + file stats)', async () => {
    const e = entry({ subject: 'expandable' });
    workspaceGitLog.mockResolvedValue(logPayload([e]));
    workspaceGitCommitDetail.mockResolvedValue({
      ...e,
      available: true,
      body: 'the full body',
      files: [{ path: 'src/x.ts', added: 4, removed: 2, isBinary: false }],
      filesCount: 1,
      linesAdded: 4,
      linesRemoved: 2,
      hiddenCount: 0,
    });
    mount();
    await flush();

    const row = document.body.querySelector(
      'button[aria-expanded="false"]',
    ) as HTMLButtonElement;
    await act(async () => {
      row.click();
    });
    await flush();

    expect(workspaceGitCommitDetail).toHaveBeenCalledWith(e.sha);
    expect(document.body.textContent).toContain('the full body');
    expect(document.body.textContent).toContain('src/x.ts');
  });

  it('shows zero-file stats when an empty commit expands', async () => {
    const e = entry({ subject: 'empty commit' });
    workspaceGitLog.mockResolvedValue(logPayload([e]));
    workspaceGitCommitDetail.mockResolvedValue({
      ...e,
      available: true,
      body: '',
      files: [],
      filesCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
      hiddenCount: 0,
    });
    mount();
    await flush();

    const row = document.body.querySelector(
      'button[aria-expanded="false"]',
    ) as HTMLButtonElement;
    await act(async () => {
      row.click();
    });
    await flush();

    expect(document.body.textContent).toContain('0 files · +0 −0');
  });

  it('shows an error when an expanded commit reports available:false', async () => {
    const e = entry();
    workspaceGitLog.mockResolvedValue(logPayload([e]));
    // Commit force-pushed away between listing and expanding.
    workspaceGitCommitDetail.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: false,
    });
    mount();
    await flush();

    const row = document.body.querySelector(
      'button[aria-expanded="false"]',
    ) as HTMLButtonElement;
    await act(async () => {
      row.click();
    });
    await flush();

    // Without the !available branch this row would be empty; it must show the
    // error instead.
    expect(document.body.textContent).toContain(
      'Failed to load commit details',
    );
  });

  it('shows an error when the commit-detail fetch rejects', async () => {
    const e = entry();
    workspaceGitLog.mockResolvedValue(logPayload([e]));
    workspaceGitCommitDetail.mockRejectedValue(new Error('detail down'));
    mount();
    await flush();

    const row = document.body.querySelector(
      'button[aria-expanded="false"]',
    ) as HTMLButtonElement;
    await act(async () => {
      row.click();
    });
    await flush();

    expect(document.body.textContent).toContain(
      'Failed to load commit details',
    );
  });
});
