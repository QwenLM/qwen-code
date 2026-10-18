import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type {
  DaemonGitHubAccountPullRequest,
  DaemonGitHubPullRequestDetailResponse,
  DaemonGitHubPullRequestInbox,
  DaemonGitHubPullRequestSettings,
} from '@qwen-code/sdk/daemon';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

const FEATURE = 'github_code_review';
const ACCOUNT = { host: 'github.com', login: 'fixture-user' };
const ALPHA = 'https://github.com/fixture/alpha/pull/42';
const BETA = 'https://github.com/fixture/beta/pull/42';
const GAMMA = 'https://github.com/fixture/gamma/pull/9';
const REVIEW = 'https://github.com/fixture/review/pull/7';
const ASSIGNED = 'https://github.com/fixture/assigned/pull/8';
const UNCLONED = 'https://github.com/external/uncloned/pull/99';
const AUTHOR_AVATAR = 'https://avatars.githubusercontent.com/u/100?v=4';
const FAILED_AVATAR = 'https://avatars.githubusercontent.com/u/101?v=4';
const REVIEW_AVATAR = 'https://avatars.githubusercontent.com/u/200?v=4';
const COMMENT_AVATAR = 'https://avatars.githubusercontent.com/u/300?v=4';
const REQUESTED_AVATAR = 'https://avatars.githubusercontent.com/u/400?v=4';
const INBOX_WIDTH_KEY = 'qwen-code-review-inbox-width';
const CONTEXT_WIDTH_KEY = 'qwen-code-review-context-width';

function pullRequest(
  url: string,
  revision = 1,
): DaemonGitHubAccountPullRequest {
  const parsed = new URL(url);
  const [owner, name, , number] = parsed.pathname.slice(1).split('/');
  const title =
    url === ALPHA
      ? 'Alpha same-number PR'
      : url === BETA
        ? 'Beta same-number PR'
        : url === REVIEW
          ? 'Review-requested PR'
          : url === ASSIGNED
            ? 'Assigned PR'
            : url === GAMMA
              ? 'Later-page PR'
              : 'Uncloned repository PR';
  return {
    repository: {
      host: parsed.host,
      nameWithOwner: `${owner}/${name}`,
      url: `${parsed.origin}/${owner}/${name}`,
    },
    number: Number(number),
    title: `${title} R${revision}`,
    url,
    author: url === REVIEW || url === ASSIGNED ? 'reviewer' : ACCOUNT.login,
    authorAvatarUrl: url === BETA ? FAILED_AVATAR : AUTHOR_AVATAR,
    state: 'open',
    updatedAt: 1_800_000_000 + (url === GAMMA ? 3 : url === ALPHA ? 2 : 1),
  };
}

function inbox(page: number, revision: number): DaemonGitHubPullRequestInbox {
  const summary = {
    totalCount: 3,
    incompleteResults: false,
    searchLimitReached: false,
  };
  return {
    v: 1,
    scope: 'account',
    account: ACCOUNT,
    authored: (page === 1 ? [ALPHA, BETA] : [BETA, GAMMA]).map((url) =>
      pullRequest(url, revision),
    ),
    needsMyReview: (page === 1 ? [REVIEW] : [REVIEW, ASSIGNED]).map((url) =>
      pullRequest(url, revision),
    ),
    page,
    limit: 50,
    hasMore: { authored: page === 1, needsMyReview: page === 1 },
    search: {
      authored: summary,
      reviewRequested: { ...summary, totalCount: 1 },
      assigned: { ...summary, totalCount: 2 },
    },
  };
}

function detail(
  url: string,
  revision: number,
): DaemonGitHubPullRequestDetailResponse {
  const row = pullRequest(url, revision);
  return {
    v: 1,
    scope: 'account',
    account: ACCOUNT,
    repository: row.repository,
    pullRequest: {
      ...row,
      headRefName: `fix/pr-${row.number}`,
      reviewDecision: 'review_required',
      checks: 'pending',
      body: `Details for ${row.repository.nameWithOwner}. Read revision ${revision}.`,
      baseRefName: 'main',
      baseRefOid: 'a'.repeat(40),
      headRefOid: url === ALPHA ? 'b'.repeat(40) : 'c'.repeat(40),
      createdAt: 1_799_000_000,
      additions: 3,
      deletions: 1,
      changedFiles: 1,
      mergeable: 'MERGEABLE',
      files: [
        {
          path: 'src/account-owner.ts',
          status: 'modified',
          additions: 3,
          deletions: 1,
          patch:
            '@@ -1 +1,3 @@\n-oldOwner();\n+accountOwner();\n+checkRevision();\n+return result;',
          patchTruncated: false,
        },
      ],
      checksDetails: Array.from({ length: 7 }, (_, index) => ({
        name: `pipeline-${index + 1}`,
        status: 'completed',
        conclusion: 'success',
        url: `${row.repository.url}/actions/runs/${index + 1}`,
      })),
      reviews: [
        {
          id: 'review-1',
          author: 'reviewer',
          authorAvatarUrl: REVIEW_AVATAR,
          body: 'Verify repository identity before displaying the result.',
          state: 'CHANGES_REQUESTED',
          createdAt: 1_800_000_001,
          url: `${url}#pullrequestreview-1`,
        },
      ],
      comments: Array.from({ length: 7 }, (_, index) => ({
        id: `comment-${index + 1}`,
        author: 'reviewer',
        authorAvatarUrl: COMMENT_AVATAR,
        body: `Account review comment ${index + 1}.`,
        createdAt: 1_800_000_002 + index,
        url: `${url}#discussion_r${index + 1}`,
        path: 'src/account-owner.ts',
        line: index + 1,
      })),
      requestedReviewers: Array.from({ length: 7 }, (_, index) => ({
        kind: 'user' as const,
        login: `reviewer-${index + 1}`,
        avatarUrl: REQUESTED_AVATAR,
        url: `https://github.com/reviewer-${index + 1}`,
      })),
      truncated: {
        files: false,
        checks: false,
        reviews: false,
        comments: false,
        requestedReviewers: false,
      },
    },
  };
}

async function installCodeReview(
  page: Page,
  baseURL: string,
  options: {
    enabled?: boolean;
    locked?: boolean;
    supported?: boolean;
    noWorkspaces?: boolean;
  } = {},
) {
  const scenario = createWebShellDaemonScenario({
    workspaceCwd: '/workspace/unrelated-local-folder',
  });
  scenario.capabilities.features = scenario.capabilities.features.filter(
    (feature) =>
      feature !== 'workspace_github_code_review' && feature !== FEATURE,
  );
  if (options.supported !== false) scenario.capabilities.features.push(FEATURE);
  if (options.noWorkspaces) scenario.capabilities.workspaces = [];
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  const avatarRequests: string[] = [];
  await page.route('https://avatars.githubusercontent.com/**', (route) => {
    avatarRequests.push(route.request().url());
    return route.fulfill(
      route.request().url() === FAILED_AVATAR
        ? { status: 404, body: 'not found' }
        : {
            contentType: 'image/svg+xml',
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#6c55d9"/></svg>',
          },
    );
  });
  const settings: DaemonGitHubPullRequestSettings = {
    v: 1,
    enabled: options.enabled !== false,
    userEnabled: options.enabled === false ? null : true,
    locked: options.locked === true,
  };
  const requests: Array<{
    method: string;
    path: string;
    page: number;
    url: string | null;
  }> = [];
  const writes: Array<Record<string, unknown>> = [];
  const state = {
    revision: 1,
    partial: false,
    reviewSummary: false,
    delayedPage: undefined as
      | { page: number; promise: Promise<void> }
      | undefined,
    delayedDetail: undefined as
      | { url: string; promise: Promise<void> }
      | undefined,
  };
  await page.route('**/github/prs/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pageNumber = Number(url.searchParams.get('page') ?? '1');
    const ref = url.searchParams.get('url');
    requests.push({
      method: request.method(),
      path: url.pathname,
      page: pageNumber,
      url: ref,
    });
    if (url.pathname === '/github/prs/settings') {
      if (request.method() === 'POST') {
        const body = request.postDataJSON() as Record<string, unknown>;
        writes.push(body);
        if (settings.locked)
          return route.fulfill({
            status: 409,
            json: { code: 'github_setting_locked' },
          });
        settings.enabled = body.enabled === true;
        settings.userEnabled = body.enabled === true;
      }
      return route.fulfill({ json: { ...settings } });
    }
    if (request.method() !== 'GET')
      return route.fulfill({
        status: 405,
        json: { code: 'read_only_fixture' },
      });
    if (!settings.enabled)
      return route.fulfill({ status: 404, json: { code: 'feature_disabled' } });
    if (url.pathname === '/github/prs/inbox') {
      const response = inbox(pageNumber, state.revision);
      if (state.delayedPage?.page === pageNumber)
        await state.delayedPage.promise;
      return route.fulfill({ json: response });
    }
    if (url.pathname !== '/github/prs/detail')
      return route.fulfill({
        status: 404,
        json: { code: 'unexpected_workspace_fallback' },
      });
    if (!ref || !/^https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+$/.test(ref))
      return route.fulfill({
        status: 400,
        json: { code: 'invalid_pull_request_ref' },
      });
    if (new URL(ref).host !== ACCOUNT.host)
      return route.fulfill({
        status: 400,
        json: { code: 'github_host_mismatch' },
      });
    const response = detail(ref, state.revision);
    if (state.partial) {
      response.pullRequest.files[0].patch = null;
      response.pullRequest.truncated.files = true;
    }
    if (state.reviewSummary) {
      response.pullRequest.reviewers = [
        {
          kind: 'user',
          login: 'review-bot',
          avatarUrl: REVIEW_AVATAR,
          url: null,
          state: 'CHANGES_REQUESTED',
          commentCount: 5,
        },
        ...response.pullRequest.requestedReviewers
          .slice(0, 3)
          .map((reviewer) => ({
            ...reviewer,
            state: 'REVIEW_REQUIRED',
            commentCount: 0,
          })),
        {
          kind: 'user',
          login: 'dev-bot',
          avatarUrl: COMMENT_AVATAR,
          url: null,
          state: 'COMMENTED',
          commentCount: 1,
        },
      ];
      response.pullRequest.comments[0].body =
        '<!-- hidden-metadata -->\n### **Review summary**';
      response.pullRequest.checksDetails = [
        {
          name: 'route',
          workflowName: 'Review',
          event: 'pull_request',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          url: null,
        },
        {
          name: 'route',
          workflowName: 'Review',
          event: 'pull_request_target',
          status: 'QUEUED',
          conclusion: null,
          url: null,
        },
        {
          name: 'web-shell E2E Smoke',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          url: null,
        },
        {
          name: 'review-pr',
          status: 'IN_PROGRESS',
          conclusion: null,
          url: null,
        },
        {
          name: 'precheck-pr',
          status: 'COMPLETED',
          conclusion: 'SKIPPED',
          url: null,
        },
      ];
      response.pullRequest.truncated.comments = true;
      response.pullRequest.truncated.reviews = true;
    }
    if (state.delayedDetail?.url === ref) await state.delayedDetail.promise;
    return route.fulfill({ json: response });
  });
  return { daemon, requests, writes, state, settings, avatarRequests };
}

type Harness = Awaited<ReturnType<typeof installCodeReview>>;

function githubReads(harness: Harness) {
  return harness.requests.filter(
    (request) => request.path !== '/github/prs/settings',
  );
}

function expectReadOnly(harness: Harness) {
  expect(
    githubReads(harness).every(
      (request) =>
        request.method === 'GET' && request.path.startsWith('/github/prs/'),
    ),
  ).toBe(true);
  expect(harness.daemon.promptRequests()).toHaveLength(0);
  expect(
    harness.daemon.requests.filter(
      (request) =>
        request.method !== 'GET' &&
        /\/sessions?(?:\/|$)|\/github\//.test(request.path),
    ),
  ).toEqual([]);
}

function prRow(page: Page, url: string) {
  return page.locator(
    `[data-testid="code-review-pr-row"][data-pr-url=${JSON.stringify(url)}]`,
  );
}

async function openWorkbench(page: Page, pr = ALPHA, suffix = '') {
  await page.goto(
    `/code-review?language=en-US${pr ? `&pr=${encodeURIComponent(pr)}` : ''}${suffix}`,
  );
  await expect(page.getByTestId('code-review-page')).toBeVisible();
}

async function releaseResponse(
  page: Page,
  matches: (url: URL) => boolean,
  release: () => void,
) {
  const response = page.waitForResponse((event) =>
    matches(new URL(event.url())),
  );
  release();
  await (await response).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(name);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
  const geometry = await page.getByTestId('code-review-inbox').boundingBox();
  const contextGeometry = await page
    .getByTestId('code-review-context')
    .boundingBox();
  const bodyGeometry = await page.getByTestId('code-review-body').boundingBox();
  const tabs = await page.getByRole('tab').evaluateAll((elements) =>
    elements.map((element) => ({
      text: element.textContent,
      selected: element.getAttribute('aria-selected'),
      state: element.getAttribute('data-state'),
      color: getComputedStyle(element).color,
      afterOpacity: getComputedStyle(element, '::after').opacity,
    })),
  );
  const statePath = info.outputPath(`${name}-state.json`);
  await writeFile(
    statePath,
    JSON.stringify({ geometry, contextGeometry, bodyGeometry, tabs }, null, 2),
  );
  await info.attach(`${name}-state.json`, {
    path: statePath,
    contentType: 'application/json',
  });
}

async function paneWidth(page: Page, name: 'inbox' | 'context' | 'body') {
  const box = await page.getByTestId(`code-review-${name}`).boundingBox();
  return box?.width ?? 0;
}

async function expectPaneWidth(
  page: Page,
  name: 'inbox' | 'context',
  width: number,
) {
  await expect
    .poll(async () => Math.abs((await paneWidth(page, name)) - width))
    .toBeLessThanOrEqual(2);
}

async function dragPane(page: Page, name: 'inbox' | 'context', delta: number) {
  const handle = page.getByTestId(`code-review-${name}-resize`);
  await expect(handle).toBeVisible();
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = Math.min(box.y + 80, page.viewportSize()!.height - 20);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(
    Math.max(10, Math.min(page.viewportSize()!.width - 10, x + delta)),
    y,
    { steps: 12 },
  );
  await page.mouse.up();
}

test('the account entry stays visible while off and its toggle controls reads @smoke', async ({
  page,
  baseURL,
}) => {
  const harness = await installCodeReview(page, baseURL!, { enabled: false });
  await page.goto('/?language=en-US');
  await page.getByRole('button', { name: 'Code review', exact: true }).click();
  await expect(page.getByTestId('code-review-gate')).toBeVisible();
  expect(githubReads(harness)).toEqual([]);
  await page
    .getByRole('button', { name: 'Enable Code Review', exact: true })
    .click();
  await expect(page.getByTestId('code-review-page')).toBeVisible();
  await expect(prRow(page, ALPHA)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Workspace', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Code Review settings' }).click();
  await page.getByRole('switch', { name: 'Enable Code Review' }).click();
  await expect(page.getByTestId('code-review-gate')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Code review', exact: true }),
  ).toBeVisible();
  expect(harness.writes).toEqual([{ enabled: true }, { enabled: false }]);
  expectReadOnly(harness);
});

test('a system-locked disabled setting cannot be enabled from the gate', async ({
  page,
  baseURL,
}) => {
  const harness = await installCodeReview(page, baseURL!, {
    enabled: false,
    locked: true,
  });
  await page.goto('/code-review?language=en-US');
  await expect(page.getByTestId('code-review-gate')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Enable Code Review', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('This setting is managed by your administrator.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Code Review settings' }).click();
  await expect(
    page.getByRole('switch', { name: 'Enable Code Review' }),
  ).toBeDisabled();
  expect(harness.writes).toEqual([]);
  expect(githubReads(harness)).toEqual([]);
});

test('an older daemon receives no account GitHub reads', async ({
  page,
  baseURL,
}) => {
  const harness = await installCodeReview(page, baseURL!, { supported: false });
  await page.goto('/code-review?language=en-US');
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  await expect(page.getByTestId('code-review-page')).toHaveCount(0);
  expect(githubReads(harness)).toEqual([]);
});

test('an account with no local workspaces can open its inbox and PR detail @smoke', async ({
  page,
  baseURL,
}) => {
  const harness = await installCodeReview(page, baseURL!, {
    noWorkspaces: true,
  });
  await page.goto('/?language=en-US');
  await page.getByRole('button', { name: 'Code review', exact: true }).click();
  await expect(prRow(page, ALPHA)).toBeVisible();
  await prRow(page, BETA).click();
  await expect(page.getByTestId('code-review-detail')).toContainText(
    'Details for fixture/beta.',
  );
  await expect(
    page.getByRole('button', { name: 'Workspace', exact: true }),
  ).toHaveCount(0);
  expectReadOnly(harness);
});

test('equal PR numbers across repositories remain distinct and late detail cannot replace the selection @smoke', async ({
  page,
  baseURL,
}) => {
  const harness = await installCodeReview(page, baseURL!);
  let release!: () => void;
  harness.state.delayedDetail = {
    url: ALPHA,
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  await openWorkbench(page);
  await expect
    .poll(() => harness.requests.some((request) => request.url === ALPHA))
    .toBe(true);
  await expect(
    page.locator('[data-testid="code-review-pr-row"][data-pr-number="42"]'),
  ).toHaveCount(2);
  await prRow(page, BETA).click();
  await expect(page.getByTestId('code-review-detail')).toContainText(
    'Details for fixture/beta.',
  );
  await releaseResponse(
    page,
    (url) =>
      url.pathname === '/github/prs/detail' &&
      url.searchParams.get('url') === ALPHA,
    release,
  );
  await expect(page.getByTestId('code-review-detail')).toContainText(
    'Details for fixture/beta.',
  );
  await expect(page.getByTestId('code-review-detail')).not.toContainText(
    'Details for fixture/alpha.',
  );
  expect(new URL(page.url()).searchParams.get('pr')).toBe(BETA);
  expectReadOnly(harness);
});

test('filtering and a full URL can open an uncloned repository independently of legacy workspace state @smoke', async ({
  page,
  baseURL,
}) => {
  const harness = await installCodeReview(page, baseURL!);
  await openWorkbench(page, ALPHA, '&workspace=unknown-retired-workspace');
  await expect(page.getByTestId('code-review-detail')).toContainText(
    'Details for fixture/alpha.',
  );
  const search = page.getByTestId('code-review-search');
  await search.fill('Beta same-number');
  await expect(page.getByTestId('code-review-pr-row')).toHaveCount(1);
  await search.fill(UNCLONED);
  await search.press('Enter');
  await expect(page.getByTestId('code-review-detail')).toContainText(
    'Details for external/uncloned.',
  );
  expect(new URL(page.url()).searchParams.get('pr')).toBe(UNCLONED);
  expect(new URL(page.url()).searchParams.has('workspace')).toBe(false);
  expectReadOnly(harness);
});

test('pagination merges by full URL and sorts without duplicate rows @smoke', async ({
  page,
  baseURL,
}) => {
  const harness = await installCodeReview(page, baseURL!);
  await openWorkbench(page);
  await expect(page.getByTestId('code-review-load-more')).toBeEnabled();
  const initialPages = harness.requests
    .filter((request) => request.path === '/github/prs/inbox')
    .map((request) => request.page);
  expect(initialPages.length).toBeGreaterThan(0);
  expect(initialPages.every((page) => page === 1)).toBe(true);
  await page.getByTestId('code-review-load-more').click();
  await expect(prRow(page, GAMMA)).toBeVisible();
  const authored = page.getByRole('region', {
    name: 'Authored by you',
    exact: true,
  });
  const needsReview = page.getByRole('region', {
    name: 'Needs my review',
    exact: true,
  });
  await expect(authored.getByTestId('code-review-pr-row')).toHaveCount(3);
  await expect(needsReview.getByTestId('code-review-pr-row')).toHaveCount(2);
  expect(
    await authored
      .getByTestId('code-review-pr-row')
      .evaluateAll((rows) =>
        rows.map((element) => element.getAttribute('data-pr-url')),
      ),
  ).toEqual([GAMMA, ALPHA, BETA]);
  expect(
    harness.requests
      .filter((request) => request.path === '/github/prs/inbox')
      .map((request) => request.page)
      .slice(initialPages.length),
  ).toEqual([2]);
  expectReadOnly(harness);
});

test('refresh discards a late page from the previous inbox generation', async ({
  page,
  baseURL,
}) => {
  const harness = await installCodeReview(page, baseURL!);
  let release!: () => void;
  harness.state.delayedPage = {
    page: 2,
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  await openWorkbench(page);
  await page.getByTestId('code-review-load-more').click();
  await expect
    .poll(() =>
      harness.requests.some(
        (request) => request.path === '/github/prs/inbox' && request.page === 2,
      ),
    )
    .toBe(true);
  harness.state.revision = 2;
  await page.getByTestId('code-review-refresh').click();
  await expect(prRow(page, ALPHA)).toContainText('R2');
  await releaseResponse(
    page,
    (url) =>
      url.pathname === '/github/prs/inbox' &&
      url.searchParams.get('page') === '2',
    release,
  );
  await expect(prRow(page, GAMMA)).toHaveCount(0);
  await expect(prRow(page, ALPHA)).toContainText('R2');
  await expect(page.getByTestId('code-review-detail')).toContainText(
    'Read revision 2.',
  );
  expectReadOnly(harness);
});

test('returning to the narrow list and reloading preserve URL-based selection', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const harness = await installCodeReview(page, baseURL!);
  await openWorkbench(page, '');
  await prRow(page, BETA).click();
  await expect(page.getByTestId('code-review-detail')).toContainText(
    'Details for fixture/beta.',
  );
  await page.goBack();
  await expect(page.getByTestId('code-review-detail')).not.toBeVisible();
  await expect(prRow(page, BETA)).toBeVisible();
  expect(new URL(page.url()).searchParams.has('pr')).toBe(false);
  await prRow(page, BETA).click();
  await page.getByTestId('code-review-detail-back').click();
  await expect(page.getByTestId('code-review-detail')).not.toBeVisible();
  await expect(prRow(page, BETA)).toBeVisible();
  expect(new URL(page.url()).searchParams.has('pr')).toBe(false);
  await prRow(page, ALPHA).click();
  await page.reload();
  await expect(page.getByTestId('code-review-detail')).toContainText(
    'Details for fixture/alpha.',
  );
  expect(new URL(page.url()).searchParams.get('pr')).toBe(ALPHA);
  expectReadOnly(harness);
});

test('a different host clears old detail and a legacy numeric ref never falls back to a local repository', async ({
  page,
  baseURL,
}) => {
  const harness = await installCodeReview(page, baseURL!);
  await openWorkbench(page);
  await expect(page.getByTestId('code-review-detail')).toContainText(
    'Details for fixture/alpha.',
  );
  await page
    .getByTestId('code-review-search')
    .fill('https://elsewhere.example/fixture/alpha/pull/42');
  await page.getByTestId('code-review-search').press('Enter');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('code-review-detail')).toHaveCount(0);
  await openWorkbench(page, '42', '&workspace=unknown-retired-workspace');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('code-review-detail')).toHaveCount(0);
  expectReadOnly(harness);
});

test('detail renders files and feedback and bounds right-column sections to five until expanded', async ({
  page,
  baseURL,
}) => {
  const harness = await installCodeReview(page, baseURL!);
  harness.state.partial = true;
  await openWorkbench(page);
  const selected = page.getByTestId('code-review-detail');
  await expect(selected).toContainText('Details for fixture/alpha.');
  await expect(page.getByText(/^pipeline-\d+$/)).toHaveCount(5);
  await page.getByTestId('code-review-checks-expand').click();
  await expect(page.getByText(/^pipeline-\d+$/)).toHaveCount(7);
  await expect(page.getByText(/^reviewer-\d+$/)).toHaveCount(5);
  await page.getByTestId('code-review-reviewers-expand').click();
  await expect(page.getByText(/^reviewer-\d+$/)).toHaveCount(7);
  await expect(page.getByText(/^Account review comment \d+\.$/)).toHaveCount(5);
  await page.getByTestId('code-review-comments-expand').click();
  await expect(page.getByText(/^Account review comment \d+\.$/)).toHaveCount(7);
  await selected.getByRole('tab', { name: /Files/ }).click();
  await expect(selected).toContainText('src/account-owner.ts');
  await expect(
    selected.getByText('Patch unavailable. View this change on GitHub.'),
  ).toBeVisible();
  await selected.getByRole('tab', { name: /Activity/ }).click();
  await expect(selected).toContainText(
    'Verify repository identity before displaying the result.',
  );
  expectReadOnly(harness);
});

test('Chinese light desktop has a compact account inbox with no workspace header', async ({
  page,
  baseURL,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const harness = await installCodeReview(page, baseURL!);
  await page.goto(
    `/code-review?pr=${encodeURIComponent(ALPHA)}&language=zh-CN&theme=light`,
  );
  await expect(page.locator('html')).toHaveClass(/theme-light/);
  await expect(
    page.getByRole('button', { name: '代码审查', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: '我创建的', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: '待我审查', exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('code-review-detail')).toContainText(
    'Details for fixture/alpha.',
  );
  const width = (await page.getByTestId('code-review-inbox').boundingBox())!
    .width;
  expect(width).toBeGreaterThanOrEqual(320);
  expect(width).toBeLessThanOrEqual(360);
  await expect(
    page.getByRole('button', { name: 'Workspace', exact: true }),
  ).toHaveCount(0);
  await screenshot(page, testInfo, 'account-zh-light.png');
  expectReadOnly(harness);
});

test('dark and narrow layouts keep account detail usable without horizontal overflow', async ({
  page,
  baseURL,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const harness = await installCodeReview(page, baseURL!);
  await page.goto(
    `/code-review?pr=${encodeURIComponent(ALPHA)}&language=zh-CN&theme=dark`,
  );
  await expect(page.locator('html')).toHaveClass(/theme-dark/);
  await expect(page.getByTestId('code-review-detail')).toContainText(
    'Details for fixture/alpha.',
  );
  await screenshot(page, testInfo, 'account-zh-dark.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('code-review-detail')).toBeVisible();
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(layout.content).toBeLessThanOrEqual(layout.width + 1);
  await screenshot(page, testInfo, 'account-narrow.png');
  expectReadOnly(harness);
});

test('both separators resize by pointer and keyboard within their bounds @smoke', async ({
  page,
  baseURL,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const harness = await installCodeReview(page, baseURL!);
  await openWorkbench(page);
  await expectPaneWidth(page, 'inbox', 340);
  await expectPaneWidth(page, 'context', 300);
  for (const name of ['inbox', 'context']) {
    const handle = page.getByTestId(`code-review-${name}-resize`);
    await expect(handle).toHaveAttribute('role', 'separator');
    await expect(handle).toHaveAttribute('tabindex', '0');
  }
  await dragPane(page, 'inbox', 80);
  await expectPaneWidth(page, 'inbox', 420);
  await dragPane(page, 'context', -60);
  await expectPaneWidth(page, 'context', 360);
  await dragPane(page, 'inbox', -1200);
  await expectPaneWidth(page, 'inbox', 280);
  await dragPane(page, 'inbox', 1200);
  await expectPaneWidth(page, 'inbox', 520);
  await dragPane(page, 'context', 1200);
  await expectPaneWidth(page, 'context', 240);
  await dragPane(page, 'context', -1200);
  await expectPaneWidth(page, 'context', 440);
  const inboxHandle = page.getByTestId('code-review-inbox-resize');
  await inboxHandle.focus();
  await inboxHandle.press('Home');
  await expectPaneWidth(page, 'inbox', 280);
  await inboxHandle.press('ArrowRight');
  await expect.poll(() => paneWidth(page, 'inbox')).toBeGreaterThan(280);
  await inboxHandle.press('End');
  await expectPaneWidth(page, 'inbox', 520);
  const contextHandle = page.getByTestId('code-review-context-resize');
  await contextHandle.focus();
  await contextHandle.press('End');
  await expectPaneWidth(page, 'context', 240);
  await contextHandle.press('ArrowLeft');
  await expect.poll(() => paneWidth(page, 'context')).toBeGreaterThan(240);
  await contextHandle.press('Home');
  await expectPaneWidth(page, 'context', 440);
  expect(await paneWidth(page, 'body')).toBeGreaterThanOrEqual(359);
  await screenshot(page, testInfo, 'panes-dragged.png');
  expectReadOnly(harness);
});

test('pane widths survive PR selection, reload and narrow-layout round trips', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const harness = await installCodeReview(page, baseURL!);
  await openWorkbench(page);
  await expectPaneWidth(page, 'inbox', 340);
  await expectPaneWidth(page, 'context', 300);
  await dragPane(page, 'inbox', 60);
  await dragPane(page, 'context', -40);
  await expectPaneWidth(page, 'inbox', 400);
  await expectPaneWidth(page, 'context', 340);
  await expect
    .poll(() =>
      page.evaluate(
        ([left, right]) => [
          localStorage.getItem(left),
          localStorage.getItem(right),
        ],
        [INBOX_WIDTH_KEY, CONTEXT_WIDTH_KEY],
      ),
    )
    .toEqual(['400', '340']);
  await prRow(page, BETA).click();
  await expect(page.getByTestId('code-review-detail')).toContainText(
    'Details for fixture/beta.',
  );
  await expectPaneWidth(page, 'inbox', 400);
  await expectPaneWidth(page, 'context', 340);
  await page.reload();
  await expect(page.getByTestId('code-review-detail')).toContainText(
    'Details for fixture/beta.',
  );
  await expectPaneWidth(page, 'inbox', 400);
  await expectPaneWidth(page, 'context', 340);
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(page.getByTestId('code-review-inbox-resize')).toBeVisible();
  await expect(
    page.getByTestId('code-review-context-resize'),
  ).not.toBeVisible();
  const body = (await page.getByTestId('code-review-body').boundingBox())!;
  const context = (await page
    .getByTestId('code-review-context')
    .boundingBox())!;
  expect(context.y).toBeGreaterThanOrEqual(body.y + body.height - 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('code-review-inbox-resize')).not.toBeVisible();
  await expect(
    page.getByTestId('code-review-context-resize'),
  ).not.toBeVisible();
  await expect(page.getByTestId('code-review-detail-back')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expectPaneWidth(page, 'inbox', 400);
  await expectPaneWidth(page, 'context', 340);
  expect(new URL(page.url()).searchParams.get('pr')).toBe(BETA);
  expectReadOnly(harness);
});

for (const invalid of [
  { name: 'corrupt', inbox: '{invalid', context: 'NaN', expected: [340, 300] },
  { name: 'oversized', inbox: '99999', context: '99999', expected: [520, 440] },
]) {
  test(`${invalid.name} stored pane widths remain safe and usable`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ inboxKey, contextKey, inbox, context }) => {
        localStorage.setItem(inboxKey, inbox);
        localStorage.setItem(contextKey, context);
      },
      {
        inboxKey: INBOX_WIDTH_KEY,
        contextKey: CONTEXT_WIDTH_KEY,
        inbox: invalid.inbox,
        context: invalid.context,
      },
    );
    const harness = await installCodeReview(page, baseURL!);
    await openWorkbench(page);
    await expectPaneWidth(page, 'inbox', invalid.expected[0]);
    await expectPaneWidth(page, 'context', invalid.expected[1]);
    expect(await paneWidth(page, 'body')).toBeGreaterThanOrEqual(359);
    expect(errors).toEqual([]);
    expectReadOnly(harness);
  });
}

test('denied pane storage does not prevent rendering or dragging', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const originalGet = Storage.prototype.getItem;
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key.startsWith('qwen-code-review-'))
        throw new DOMException('Storage denied', 'SecurityError');
      return originalGet.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('qwen-code-review-'))
        throw new DOMException('Storage denied', 'SecurityError');
      return originalSet.call(this, key, value);
    };
  });
  const harness = await installCodeReview(page, baseURL!);
  await openWorkbench(page);
  await expectPaneWidth(page, 'inbox', 340);
  await expectPaneWidth(page, 'context', 300);
  await dragPane(page, 'inbox', 50);
  await dragPane(page, 'context', -30);
  await expectPaneWidth(page, 'inbox', 390);
  await expectPaneWidth(page, 'context', 330);
  await prRow(page, BETA).click();
  await expect(page.getByTestId('code-review-detail')).toContainText(
    'Details for fixture/beta.',
  );
  expect(errors).toEqual([]);
  expectReadOnly(harness);
});

test('avatar URLs render images and failed images fall back to initials', async ({
  page,
  baseURL,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  const harness = await installCodeReview(page, baseURL!);
  await openWorkbench(page);
  const loaded = prRow(page, ALPHA).locator('img');
  await expect(loaded).toHaveAttribute('src', AUTHOR_AVATAR);
  try {
    await expect
      .poll(() =>
        loaded.evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
  } finally {
    const evidencePath = testInfo.outputPath('avatar-network.json');
    await writeFile(
      evidencePath,
      JSON.stringify({
        consoleErrors,
        requests: harness.avatarRequests,
        images: await page.locator('img').evaluateAll((images) =>
          images.map((image) => ({
            src: image.getAttribute('src'),
            complete: image.complete,
            naturalWidth: image.naturalWidth,
          })),
        ),
      }),
    );
    await testInfo.attach('avatar-network.json', {
      contentType: 'application/json',
      path: evidencePath,
    });
  }
  await expect
    .poll(() => harness.avatarRequests.includes(FAILED_AVATAR))
    .toBe(true);
  await expect(prRow(page, BETA).locator('img')).toHaveCount(0);
  await expect(prRow(page, BETA).getByText('F', { exact: true })).toBeVisible();
  const context = page.getByTestId('code-review-context');
  await expect(
    context.locator(`img[src=${JSON.stringify(COMMENT_AVATAR)}]`).first(),
  ).toBeVisible();
  await expect(
    context.locator(`img[src=${JSON.stringify(REQUESTED_AVATAR)}]`).first(),
  ).toBeVisible();
  await page
    .getByTestId('code-review-detail')
    .getByRole('tab', { name: /Activity/ })
    .click();
  await expect(
    page
      .getByTestId('code-review-body')
      .locator(`img[src=${JSON.stringify(REVIEW_AVATAR)}]`)
      .first(),
  ).toBeVisible();
  expectReadOnly(harness);
});

test('keyboard pane resizing survives reload', async ({
  page,
  baseURL,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const harness = await installCodeReview(page, baseURL!);
  await openWorkbench(page);
  await expectPaneWidth(page, 'inbox', 340);
  await expectPaneWidth(page, 'context', 300);
  await dragPane(page, 'inbox', 80);
  await dragPane(page, 'context', -40);
  await expectPaneWidth(page, 'inbox', 420);
  await expectPaneWidth(page, 'context', 340);
  const inboxHandle = page.getByTestId('code-review-inbox-resize');
  await inboxHandle.focus();
  await inboxHandle.press('ArrowRight');
  await expect.poll(() => paneWidth(page, 'inbox')).toBeGreaterThan(422);
  const contextHandle = page.getByTestId('code-review-context-resize');
  await contextHandle.focus();
  await contextHandle.press('ArrowLeft');
  await expect.poll(() => paneWidth(page, 'context')).toBeGreaterThan(342);
  const expected = {
    inbox: Math.round(await paneWidth(page, 'inbox')),
    context: Math.round(await paneWidth(page, 'context')),
  };
  const state = async () => ({
    inbox: await paneWidth(page, 'inbox'),
    context: await paneWidth(page, 'context'),
    stored: await page.evaluate(
      ([inboxKey, contextKey]) => ({
        inbox: localStorage.getItem(inboxKey),
        context: localStorage.getItem(contextKey),
      }),
      [INBOX_WIDTH_KEY, CONTEXT_WIDTH_KEY],
    ),
  });
  const beforeReload = await state();
  await page.reload();
  await expect(page.getByTestId('code-review-detail')).toBeVisible();
  const evidencePath = testInfo.outputPath('keyboard-reload.json');
  try {
    await expectPaneWidth(page, 'inbox', expected.inbox);
    await expectPaneWidth(page, 'context', expected.context);
    expect(beforeReload.stored).toEqual({
      inbox: String(expected.inbox),
      context: String(expected.context),
    });
  } finally {
    await writeFile(
      evidencePath,
      JSON.stringify({ expected, beforeReload, afterReload: await state() }),
    );
    await testInfo.attach('keyboard-reload.json', {
      contentType: 'application/json',
      path: evidencePath,
    });
  }
  expectReadOnly(harness);
});

test('review sidebar shows individual states and current jobs without repeated notices', async ({
  page,
  baseURL,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const harness = await installCodeReview(page, baseURL!);
  harness.state.reviewSummary = true;
  await openWorkbench(page, ALPHA, '&theme=light');
  const sidebar = page.getByTestId('code-review-context');
  const reviewers = sidebar.getByTestId('code-review-reviewer');
  await expect(reviewers).toHaveCount(5);
  await expect(reviewers.first()).toHaveAttribute(
    'data-state',
    'changes_requested',
  );
  await expect(reviewers.first()).toContainText('review-bot5');
  await expect(reviewers.last()).toContainText('dev-bot1');
  await expect(
    reviewers.nth(1).getByRole('img', { name: 'Review required' }),
  ).toBeVisible();
  await page.getByTestId('code-review-comments-expand').click();
  await expect(
    sidebar.getByText('Review summary', { exact: true }),
  ).toBeVisible();
  await expect(sidebar).not.toContainText('**');
  await expect(sidebar).not.toContainText('hidden-metadata');
  const checks = sidebar.getByTestId('code-review-check');
  await expect(checks).toHaveCount(5);
  await expect(checks.nth(0)).toContainText('web-shell E2E Smoke');
  await expect(checks.nth(1)).toContainText('review-pr');
  await expect(checks.nth(2)).toContainText(
    'route (Review · pull_request_target)',
  );
  await expect(checks.last()).toContainText('route (Review · pull_request)');
  await screenshot(page, testInfo, 'aligned-sidebar-light.png');
  await page
    .getByTestId('code-review-detail')
    .getByRole('tab', { name: /Activity/ })
    .click();
  await expect(
    page.getByText('Some results are limited.', { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Showing a limited result.', { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByText('View all activity', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Open in GitHub', exact: true }),
  ).toBeVisible();
  expectReadOnly(harness);
});
