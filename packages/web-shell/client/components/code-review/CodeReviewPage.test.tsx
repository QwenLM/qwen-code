// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonClient,
  DaemonGitHubAccountPullRequest,
  DaemonGitHubPullRequestDetailResponse,
  DaemonGitHubPullRequestInbox,
} from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import { CodeReviewPage, type CodeReviewPageProps } from './CodeReviewPage';

vi.mock('../messages/Markdown', () => ({
  Markdown: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('../messages/tools/DiffView', () => ({
  DiffView: ({ diff }: { diff: string }) => <pre>{diff}</pre>,
}));

const account = { host: 'github.com', login: 'octocat' };
function pr(
  number: number,
  repo = 'owner/repository',
  title = `Pull request ${number}`,
): DaemonGitHubAccountPullRequest {
  const url = `https://github.com/${repo}`;
  return {
    repository: { host: 'github.com', nameWithOwner: repo, url },
    number,
    title,
    url: `${url}/pull/${number}`,
    author: 'octocat',
    state: 'open',
    updatedAt: 1_790_000_000 + number,
  };
}
function inbox(): DaemonGitHubPullRequestInbox {
  const info = {
    totalCount: 1,
    incompleteResults: false,
    searchLimitReached: false,
  };
  return {
    v: 1,
    scope: 'account',
    account,
    authored: [pr(1, 'owner/repository', 'Improve navigation')],
    needsMyReview: [pr(1, 'another/project', 'Fix window restore')],
    page: 1,
    limit: 50,
    hasMore: { authored: false, needsMyReview: false },
    search: {
      authored: { ...info },
      reviewRequested: { ...info },
      assigned: { ...info, totalCount: 0 },
    },
  };
}
function detail(row = pr(1)): DaemonGitHubPullRequestDetailResponse {
  return {
    v: 1,
    scope: 'account',
    account,
    repository: row.repository,
    pullRequest: {
      ...row,
      headRefName: `feature-${row.number}`,
      checks: 'passing',
      reviewDecision: 'review_required',
      body: `Description for ${row.repository.nameWithOwner}#${row.number}`,
      baseRefName: 'main',
      baseRefOid: 'a'.repeat(40),
      headRefOid: 'b'.repeat(40),
      createdAt: 1_790_000_000,
      additions: 5,
      deletions: 2,
      changedFiles: 1,
      mergeable: 'MERGEABLE',
      files: [
        {
          path: 'src/main.ts',
          status: 'modified',
          additions: 5,
          deletions: 2,
          patch: '@@ -1 +1 @@\n-old\n+new',
          patchTruncated: false,
        },
      ],
      checksDetails: [
        {
          name: 'Unit tests',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          url: `${row.repository.url}/actions/runs/1`,
        },
      ],
      reviews: [],
      comments: [
        {
          id: 'c1',
          author: 'reviewer',
          body: 'Please cover account switching.',
          createdAt: 1_790_000_100,
          url: `${row.url}#issuecomment-1`,
          path: null,
          line: null,
        },
      ],
      requestedReviewers: [
        { kind: 'user', login: 'reviewer', url: 'https://github.com/reviewer' },
      ],
      truncated: {
        files: false,
        checks: false,
        comments: false,
        reviews: false,
        requestedReviewers: false,
      },
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let root: Root;
let container: HTMLDivElement;
const loadInbox = vi.fn();
const loadDetail = vi.fn();
const client = {
  githubPullRequestInbox: loadInbox,
  githubPullRequestDetail: loadDetail,
} as unknown as DaemonClient;
function render(props: Partial<CodeReviewPageProps> = {}) {
  act(() =>
    root.render(
      <I18nProvider language="en">
        <CodeReviewPage client={client} {...props} />
      </I18nProvider>,
    ),
  );
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
function input(value: string) {
  const element = container.querySelector<HTMLInputElement>(
    '[data-testid="code-review-search"]',
  )!;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function click(testId: string) {
  act(() =>
    container
      .querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!
      .click(),
  );
}
function selectRow(url: string) {
  act(() =>
    container
      .querySelector<HTMLButtonElement>(`[data-pr-url="${url}"]`)!
      .click(),
  );
}
function submit() {
  act(() =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}
function selectTab(label: string) {
  const tab = [
    ...container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ].find((element) => element.textContent?.startsWith(label))!;
  act(() => {
    tab.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0 }),
    );
    tab.click();
  });
}
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  loadInbox.mockResolvedValue(inbox());
  loadDetail.mockImplementation((ref: string) => {
    const url = new URL(ref);
    const [, owner, repo, , number] = url.pathname.split('/');
    return Promise.resolve(detail(pr(Number(number), `${owner}/${repo}`)));
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

describe('CodeReviewPage', () => {
  it('loads account groups and distinguishes same-number PRs across repositories', async () => {
    const onSelectPullRequest = vi.fn();
    render({ onSelectPullRequest });
    await flush();
    expect(loadInbox).toHaveBeenCalledExactlyOnceWith({ page: 1 });
    expect(loadDetail).toHaveBeenCalledWith(pr(1).url);
    expect(container.textContent).toContain('Authored by you');
    expect(container.textContent).toContain('Needs my review');
    expect(container.textContent).toContain(
      'Description for owner/repository#1',
    );
    expect(container.textContent).toContain('Unit tests');
    expect(onSelectPullRequest).not.toHaveBeenCalled();
    selectRow(pr(1, 'another/project').url);
    await flush();
    expect(container.textContent).toContain(
      'Description for another/project#1',
    );
    expect(container.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    expect(onSelectPullRequest).toHaveBeenCalledExactlyOnceWith(
      pr(1, 'another/project').url,
    );
  });

  it('filters loaded PRs by repository without requesting or opening a bare number', async () => {
    render();
    await flush();
    input('another/project');
    expect(
      container.querySelectorAll('[data-testid="code-review-pr-row"]'),
    ).toHaveLength(1);
    expect(container.textContent).toContain('Filtering loaded pull requests');
    input('77');
    submit();
    await flush();
    expect(loadInbox).toHaveBeenCalledTimes(1);
    expect(loadDetail).toHaveBeenCalledTimes(1);
  });

  it('submits complete URLs and clears stale details on failure', async () => {
    const onSelectPullRequest = vi.fn();
    render({ onSelectPullRequest });
    await flush();
    const ref = 'https://github.com/other/repo/pull/31';
    loadDetail.mockRejectedValueOnce({ body: { code: 'github_pr_not_found' } });
    input(ref);
    submit();
    await flush();
    expect(loadDetail).toHaveBeenLastCalledWith(ref);
    expect(onSelectPullRequest).toHaveBeenCalledExactlyOnceWith(ref);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'could not be found',
    );
    expect(container.textContent).not.toContain(
      'Description for owner/repository#1',
    );
  });

  it('normalizes PR subpage URLs and explains a host mismatch', async () => {
    const onSelectPullRequest = vi.fn();
    render({ onSelectPullRequest });
    await flush();
    loadDetail.mockRejectedValueOnce({
      body: { code: 'github_host_mismatch' },
    });
    const url = 'https://enterprise.example/owner/repo/pull/77';
    input(`${url}/files#diff-123`);
    submit();
    await flush();
    expect(loadDetail).toHaveBeenLastCalledWith(url);
    expect(onSelectPullRequest).toHaveBeenCalledExactlyOnceWith(url);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'different GitHub host',
    );
  });

  it('clears a user selection when browser Back restores the empty PR route', async () => {
    const onSelectPullRequest = vi.fn();
    render({ onSelectPullRequest });
    await flush();
    const selected = pr(1, 'another/project').url;
    selectRow(selected);
    await flush();
    render({ initialPrRef: selected, onSelectPullRequest });
    await flush();
    render({ initialPrRef: undefined, onSelectPullRequest });
    await flush();
    expect(
      container
        .querySelector('[data-testid="code-review-page"]')
        ?.getAttribute('data-show-detail'),
    ).toBe('false');
    expect(container.textContent).toContain(
      'Description for owner/repository#1',
    );
    expect(onSelectPullRequest).toHaveBeenCalledExactlyOnceWith(selected);
  });

  it('follows deep-link changes and browser-back clearing without callbacks', async () => {
    const onSelectPullRequest = vi.fn();
    render({ onSelectPullRequest });
    await flush();
    render({ initialPrRef: pr(77, 'other/project').url, onSelectPullRequest });
    await flush();
    expect(container.textContent).toContain('Description for other/project#77');
    render({ initialPrRef: undefined, onSelectPullRequest });
    await flush();
    expect(container.textContent).toContain(
      'Description for owner/repository#1',
    );
    expect(onSelectPullRequest).not.toHaveBeenCalled();
  });

  it('does not let a slower response overwrite a newer selection', async () => {
    const first = deferred<DaemonGitHubPullRequestDetailResponse>();
    loadDetail.mockImplementation((ref: string) =>
      ref === pr(1).url
        ? first.promise
        : Promise.resolve(detail(pr(1, 'another/project'))),
    );
    render();
    await flush();
    selectRow(pr(1, 'another/project').url);
    await flush();
    first.resolve(detail());
    await flush();
    expect(container.textContent).not.toContain(
      'Description for owner/repository#1',
    );
    expect(container.textContent).toContain(
      'Description for another/project#1',
    );
  });

  it('resets query and selection on client change and drops old responses', async () => {
    const oldInbox = deferred<DaemonGitHubPullRequestInbox>();
    const oldDetail = deferred<DaemonGitHubPullRequestDetailResponse>();
    loadInbox.mockReturnValue(oldInbox.promise);
    loadDetail.mockReturnValue(oldDetail.promise);
    render({ initialPrRef: pr(1).url });
    input('old search');
    const next = {
      githubPullRequestInbox: vi.fn().mockResolvedValue({
        ...inbox(),
        authored: [pr(8)],
        needsMyReview: [],
      }),
      githubPullRequestDetail: vi.fn().mockResolvedValue(detail(pr(8))),
    } as unknown as DaemonClient;
    render({ client: next });
    await flush();
    oldInbox.resolve(inbox());
    oldDetail.resolve(detail());
    await flush();
    expect(container.textContent).toContain(
      'Description for owner/repository#8',
    );
    expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('');
    expect(container.querySelector('[data-pr-number="1"]')).toBeNull();
    expect(container.textContent).not.toContain(
      'Description for owner/repository#1',
    );
  });

  it('appends pages by URL, sorts updates, and preserves selection', async () => {
    loadInbox.mockResolvedValueOnce({
      ...inbox(),
      hasMore: { authored: true, needsMyReview: true },
    });
    render();
    await flush();
    loadInbox.mockResolvedValueOnce({
      ...inbox(),
      page: 2,
      authored: [pr(1, 'owner/repository', 'Updated title'), pr(9)],
      needsMyReview: [pr(1, 'another/project'), pr(1, 'third/project')],
    });
    click('code-review-load-more');
    await flush();
    expect(loadInbox).toHaveBeenLastCalledWith({ page: 2 });
    expect(
      container.querySelectorAll('[data-testid="code-review-pr-row"]'),
    ).toHaveLength(4);
    expect(
      container
        .querySelector('[data-testid="code-review-pr-row"]')
        ?.getAttribute('data-pr-url'),
    ).toBe(pr(9).url);
    expect(container.textContent).toContain('Updated title');
    expect(container.textContent).toContain(
      'Description for owner/repository#1',
    );
    expect(loadDetail).toHaveBeenCalledTimes(1);
  });

  it('refreshes during pagination and ignores a late page from the prior revision', async () => {
    loadInbox.mockResolvedValueOnce({
      ...inbox(),
      hasMore: { authored: true, needsMyReview: false },
    });
    render();
    await flush();
    const second = deferred<DaemonGitHubPullRequestInbox>();
    loadInbox.mockReturnValueOnce(second.promise);
    click('code-review-load-more');
    await flush();
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="code-review-refresh"]',
      )?.disabled,
    ).toBe(false);
    loadInbox.mockResolvedValueOnce({
      ...inbox(),
      authored: [pr(5)],
      needsMyReview: [],
    });
    click('code-review-refresh');
    await flush();
    second.resolve({ ...inbox(), page: 2, authored: [pr(99)] });
    await flush();
    expect(container.querySelector('[data-pr-number="5"]')).not.toBeNull();
    expect(container.querySelector('[data-pr-number="99"]')).toBeNull();
    expect(loadInbox).toHaveBeenLastCalledWith({ page: 1 });
  });

  it('keeps loaded rows after a failed next page and retries that page', async () => {
    loadInbox.mockResolvedValueOnce({
      ...inbox(),
      hasMore: { authored: true, needsMyReview: false },
    });
    render();
    await flush();
    loadInbox.mockRejectedValueOnce({
      body: { code: 'github_pr_read_failed' },
    });
    click('code-review-load-more');
    await flush();
    expect(
      container.querySelectorAll('[data-testid="code-review-pr-row"]'),
    ).toHaveLength(2);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    loadInbox.mockResolvedValueOnce({ ...inbox(), page: 2, authored: [pr(9)] });
    click('code-review-load-more');
    await flush();
    expect(loadInbox).toHaveBeenLastCalledWith({ page: 2 });
    expect(container.querySelector('[data-pr-number="9"]')).not.toBeNull();
  });

  it('clears old rows when the GitHub account changes between pages', async () => {
    loadInbox.mockResolvedValueOnce({
      ...inbox(),
      hasMore: { authored: true, needsMyReview: false },
    });
    render();
    await flush();
    loadInbox.mockResolvedValueOnce({
      ...inbox(),
      page: 2,
      account: { ...account, login: 'new-user' },
      authored: [pr(9)],
    });
    click('code-review-load-more');
    await flush();
    expect(container.textContent).toContain('The GitHub account changed');
    expect(
      container.querySelectorAll('[data-testid="code-review-pr-row"]'),
    ).toHaveLength(0);
    expect(
      container.querySelector('[data-testid="code-review-detail"]'),
    ).toBeNull();
  });

  it.each(['inbox-first', 'detail-first'])(
    'rejects mixed account responses regardless of arrival order (%s)',
    async (order) => {
      const inboxRead = deferred<DaemonGitHubPullRequestInbox>();
      const detailRead = deferred<DaemonGitHubPullRequestDetailResponse>();
      loadInbox.mockReturnValueOnce(inboxRead.promise);
      loadDetail.mockReturnValueOnce(detailRead.promise);
      render({ initialPrRef: pr(1).url });
      const otherDetail = {
        ...detail(),
        account: { ...account, login: 'new-user' },
      };
      if (order === 'inbox-first') {
        inboxRead.resolve(inbox());
        await flush();
        detailRead.resolve(otherDetail);
      } else {
        detailRead.resolve(otherDetail);
        await flush();
        inboxRead.resolve(inbox());
      }
      await flush();
      expect(container.textContent).toContain('The GitHub account changed');
      expect(
        container.querySelectorAll('[data-testid="code-review-pr-row"]'),
      ).toHaveLength(0);
      expect(
        container.querySelector('[data-testid="code-review-detail"]'),
      ).toBeNull();
    },
  );

  it('shows setup guidance and retries a failed inbox read', async () => {
    loadInbox.mockRejectedValueOnce({
      body: { code: 'github_cli_unavailable' },
    });
    render();
    await flush();
    expect(container.textContent).toContain(
      'Install the GitHub CLI on the daemon host',
    );
    const retry = [
      ...container.querySelectorAll<HTMLButtonElement>('button'),
    ].find((element) => element.textContent === 'Try again')!;
    act(() => retry.click());
    await flush();
    expect(container.textContent).toContain(
      'Description for owner/repository#1',
    );
  });

  it('limits sidebar checks, reviewers and comments to five and expands each independently', async () => {
    const response = detail();
    const value = response.pullRequest;
    value.checksDetails = Array.from({ length: 8 }, (_, i) => ({
      ...value.checksDetails[0],
      name: `Check ${i}`,
    }));
    value.requestedReviewers = Array.from({ length: 8 }, (_, i) => ({
      ...value.requestedReviewers[0],
      login: `Reviewer ${i}`,
    }));
    value.comments = Array.from({ length: 8 }, (_, i) => ({
      ...value.comments[0],
      id: `c${i}`,
      body: `Comment ${i}`,
    }));
    loadDetail.mockResolvedValue(response);
    render();
    await flush();
    expect(container.textContent).not.toContain('Check 7');
    expect(container.textContent).not.toContain('Reviewer 7');
    expect(container.textContent).not.toContain('Comment 7');
    click('code-review-checks-expand');
    expect(container.textContent).toContain('Check 7');
    expect(container.textContent).not.toContain('Comment 7');
    click('code-review-reviewers-expand');
    click('code-review-comments-expand');
    expect(container.textContent).toContain('Reviewer 7');
    expect(container.textContent).toContain('Comment 7');
    click('code-review-checks-expand');
    expect(container.textContent).not.toContain('Check 7');
  });

  it('omits hidden HTML markers from comment previews without changing activity', async () => {
    const response = detail();
    response.pullRequest.comments[0].body =
      '<!-- bot-metadata\n stage=1 -->\n### **Visible review summary**';
    loadDetail.mockResolvedValue(response);
    render();
    await flush();
    const context = container.querySelector(
      '[data-testid="code-review-context"]',
    )!;
    expect(context.textContent).toContain('Visible review summary');
    expect(context.innerHTML).not.toContain('bot-metadata');
    expect(
      context.querySelector(
        '[title="reviewer: ### **Visible review summary**"]',
      ),
    ).not.toBeNull();
    expect(context.textContent).not.toContain('###');
    expect(context.textContent).not.toContain('**');
    selectTab('Activity');
    expect(
      container.querySelector('[role="tabpanel"][data-state="active"]')
        ?.textContent,
    ).toContain(response.pullRequest.comments[0].body);
  });

  it('renders bounded patches and activity, with safe external links', async () => {
    const response = detail();
    response.pullRequest.truncated.comments = true;
    response.pullRequest.files[0].patchTruncated = true;
    response.pullRequest.checksDetails[0].url = 'javascript:alert(1)';
    loadDetail.mockResolvedValue(response);
    render();
    await flush();
    expect(container.textContent).not.toContain('Some results are limited');
    expect(
      [...container.querySelectorAll('a')].some((anchor) =>
        anchor.getAttribute('href')?.startsWith('javascript:'),
      ),
    ).toBe(false);
    selectTab('Files');
    expect(container.textContent).toContain('@@ -1 +1 @@');
    expect(container.textContent).toContain('This patch is truncated');
    selectTab('Activity');
    expect(
      container.querySelector('[role="tabpanel"][data-state="active"]')
        ?.textContent,
    ).toContain('Please cover account switching.');
  });

  it('shows each reviewer state and latest review comment count without a PR-wide verdict', async () => {
    const response = detail();
    response.pullRequest.reviewDecision = 'changes_requested';
    response.pullRequest.reviewers = [
      {
        kind: 'user',
        login: 'commenter',
        url: null,
        state: 'COMMENTED',
        commentCount: 1,
      },
      {
        kind: 'user',
        login: 'waiting',
        url: null,
        state: 'REVIEW_REQUIRED',
        commentCount: 0,
      },
      {
        kind: 'user',
        login: 'approver',
        url: null,
        state: 'APPROVED',
        commentCount: 0,
      },
      {
        kind: 'user',
        login: 'review-bot',
        url: null,
        state: 'CHANGES_REQUESTED',
        commentCount: 5,
      },
    ];
    loadDetail.mockResolvedValue(response);
    render();
    await flush();
    const rows = [
      ...container.querySelectorAll('[data-testid="code-review-reviewer"]'),
    ];
    expect(rows.map((row) => row.getAttribute('data-state'))).toEqual([
      'changes_requested',
      'review_required',
      'approved',
      'commented',
    ]);
    expect(rows[0].textContent).toContain('review-bot5');
    expect(rows[3].textContent).toContain('commenter1');
    expect(
      rows[0].querySelector('[aria-label="5 comments in the latest review"]'),
    ).not.toBeNull();
    expect(
      rows[1].querySelector('[role="img"]')?.getAttribute('aria-label'),
    ).toBe('Review required');
    expect(
      container.querySelector('[data-testid="code-review-context"]')
        ?.textContent,
    ).not.toContain('Changes requested');
  });

  it('distinguishes same-name checks by workflow and event and prioritizes failures', async () => {
    const response = detail();
    response.pullRequest.checksDetails = [
      {
        id: 'pass',
        name: 'route',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        url: null,
        workflowName: 'Review',
        event: 'pull_request',
      },
      {
        id: 'queue',
        name: 'route',
        status: 'QUEUED',
        conclusion: null,
        url: null,
        workflowName: 'Review',
        event: 'pull_request_target',
      },
      {
        id: 'fail',
        name: 'Web Shell E2E',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        url: null,
      },
      {
        id: 'run',
        name: 'review-pr',
        status: 'IN_PROGRESS',
        conclusion: null,
        url: null,
      },
    ];
    loadDetail.mockResolvedValue(response);
    render();
    await flush();
    const rows = [
      ...container.querySelectorAll('[data-testid="code-review-check"]'),
    ];
    expect(rows.map((row) => row.textContent)).toEqual([
      'Web Shell E2E',
      'review-pr',
      'route (Review · pull_request_target)',
      'route (Review · pull_request)',
    ]);
    expect(rows.map((row) => row.getAttribute('data-state'))).toEqual([
      'failing',
      'pending',
      'pending',
      'passing',
    ]);
  });

  it('keeps bounded-data counts and GitHub access without the four repeated notices', async () => {
    const response = detail();
    response.pullRequest.truncated.comments = true;
    response.pullRequest.truncated.reviews = true;
    loadDetail.mockResolvedValue(response);
    render();
    await flush();
    selectTab('Activity');
    expect(container.textContent).not.toContain('Some results are limited');
    expect(container.textContent).not.toContain('Showing a limited result');
    expect(container.textContent).not.toContain('View all activity');
    expect(container.textContent).toContain('Activity 1+');
    expect(
      container.querySelector(
        '[title="Showing a limited result. View the full list on GitHub."]',
      ),
    ).not.toBeNull();
    expect(
      [...container.querySelectorAll('a')].filter(
        (link) => link.textContent === 'Open in GitHub',
      ),
    ).toHaveLength(1);
  });

  it('labels incomplete or capped search results explicitly', async () => {
    const response = inbox();
    response.search.assigned.incompleteResults = true;
    loadInbox.mockResolvedValue(response);
    render();
    await flush();
    expect(container.textContent).toContain(
      'GitHub returned limited search results',
    );
  });
});
