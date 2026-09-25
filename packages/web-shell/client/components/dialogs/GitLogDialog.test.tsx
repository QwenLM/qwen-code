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

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: () => ({ client: workspaceClient }),
}));

const { GitLogDialog, GitLogContent } = await import('./GitLogDialog');

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

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
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

    expect(workspaceGitLog).toHaveBeenCalledWith(50, 0, undefined, undefined, {
      all: false,
      search: undefined,
    });
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
    expect(workspaceGitLog).toHaveBeenNthCalledWith(
      2,
      50,
      1,
      undefined,
      undefined,
      { all: false, search: undefined },
    );
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

    expect(workspaceGitLog).toHaveBeenNthCalledWith(
      2,
      50,
      1,
      undefined,
      undefined,
      { all: false, search: undefined },
    );
    expect(workspaceGitLog).toHaveBeenNthCalledWith(
      3,
      50,
      3,
      undefined,
      undefined,
      { all: false, search: undefined },
    );
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

    expect(workspaceGitCommitDetail).toHaveBeenCalledWith(e.sha, undefined);
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

  it('forwards gitCwd to the log list, pagination, and commit-detail SDK calls', async () => {
    const e = entry();
    workspaceGitLog
      .mockResolvedValueOnce(logPayload([e], true))
      .mockResolvedValueOnce(logPayload([entry({ subject: 'older' })], false));
    workspaceGitCommitDetail.mockResolvedValue({
      ...e,
      body: 'body',
      files: [],
      filesCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
      hiddenCount: 0,
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <GitLogContent workspaceCwd="/repo" gitCwd="/worktrees/wt" />
        </I18nProvider>,
      );
    });
    await flush();

    expect(workspaceGitLog).toHaveBeenCalledWith(
      50,
      0,
      '/worktrees/wt',
      undefined,
      { all: false, search: undefined },
    );

    const loadMore = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent === 'Load more',
    ) as HTMLButtonElement;
    expect(loadMore).toBeTruthy();
    await act(async () => {
      loadMore.click();
    });
    await flush();

    expect(workspaceGitLog).toHaveBeenNthCalledWith(
      2,
      50,
      1,
      '/worktrees/wt',
      undefined,
      { all: false, search: undefined },
    );

    const row = document.body.querySelector(
      'button[aria-expanded="false"]',
    ) as HTMLButtonElement;
    expect(row).not.toBeNull();
    await act(async () => {
      row.click();
    });
    await flush();

    expect(workspaceGitCommitDetail).toHaveBeenCalledWith(
      e.sha,
      '/worktrees/wt',
    );
  });

  it('refetches every branch when the All branches toggle is pressed', async () => {
    workspaceGitLog
      .mockResolvedValueOnce(logPayload([entry({ subject: 'head only' })]))
      .mockResolvedValueOnce(logPayload([entry({ subject: 'other branch' })]));
    mount();
    await flush();

    const toggle = document.body.querySelector(
      '[data-testid="git-log-all-branches"]',
    ) as HTMLButtonElement;
    expect(toggle.textContent).toBe('All branches');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await act(async () => {
      toggle.click();
    });
    await flush();

    expect(workspaceGitLog).toHaveBeenNthCalledWith(
      2,
      50,
      0,
      undefined,
      undefined,
      { all: true, search: undefined },
    );
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(document.body.textContent).toContain('other branch');
    expect(document.body.textContent).not.toContain('head only');
  });

  it('searches after the query settles and hides the lane graph for matches', async () => {
    workspaceGitLog
      .mockResolvedValueOnce(logPayload([entry({ subject: 'unrelated' })]))
      .mockResolvedValueOnce(logPayload([entry({ subject: 'fix: typo' })]));
    mount();
    await flush();
    expect(
      document.body.querySelector('[data-testid="commit-graph"]'),
    ).not.toBeNull();

    const input = document.body.querySelector(
      'input[type="search"]',
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(input, ' typo ');
    });
    // Still debouncing: no second fetch yet.
    expect(workspaceGitLog).toHaveBeenCalledTimes(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await flush();

    expect(workspaceGitLog).toHaveBeenNthCalledWith(
      2,
      50,
      0,
      undefined,
      undefined,
      { all: false, search: 'typo' },
    );
    expect(document.body.textContent).toContain('fix: typo');
    expect(
      document.body.querySelector('[data-testid="commit-graph"]'),
    ).toBeNull();
  });

  it('shows the no-match placeholder for an empty search result', async () => {
    workspaceGitLog
      .mockResolvedValueOnce(logPayload([entry()]))
      .mockResolvedValueOnce(logPayload([]));
    mount();
    await flush();
    const input = document.body.querySelector(
      'input[type="search"]',
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(input, 'nothing');
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await flush();
    expect(document.body.textContent).toContain('No commits match');
  });

  it('lays merge history out in lanes: the side branch takes a second column', async () => {
    const base = entry({ subject: 'base', parents: [] });
    const side = entry({ subject: 'side', parents: [base.sha] });
    const mainline = entry({ subject: 'mainline', parents: [base.sha] });
    const merge = entry({
      subject: 'merge',
      parents: [mainline.sha, side.sha],
    });
    workspaceGitLog.mockResolvedValue(
      logPayload([merge, side, mainline, base]),
    );
    mount();
    await flush();

    const columns = Array.from(
      document.body.querySelectorAll('[data-testid="commit-graph"]'),
    ).map((el) => el.getAttribute('data-column'));
    expect(columns).toEqual(['0', '1', '0', '0']);

    // Lanes continue straight through an expanded row's detail block.
    workspaceGitCommitDetail.mockResolvedValue({
      ...side,
      available: true,
      body: '',
      files: [],
      filesCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
      hiddenCount: 0,
    });
    const rows = document.body.querySelectorAll('button[aria-expanded]');
    await act(async () => {
      (rows[1] as HTMLButtonElement).click();
    });
    await flush();
    // The side row keeps both lanes (its own and the mainline) open below it.
    expect(
      document.body.querySelectorAll('[data-testid="commit-graph-tail"] path'),
    ).toHaveLength(2);
  });
});
