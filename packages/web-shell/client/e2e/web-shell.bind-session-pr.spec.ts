import { expect, test, type Page } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  type MockDaemonController,
} from './utils/mockDaemon';

const workspaceCwd = '/tmp/bind-session-pr-e2e/project';
const prUrl = 'https://github.com/example/repo/pull/16865';
const sessions = ['bind-current', 'bind-other'].map((sessionId) => ({
  sessionId,
  displayName:
    sessionId === 'bind-current' ? 'Current fixture' : 'Other fixture',
  workspaceCwd,
  clientCount: 1,
  hasActivePrompt: false,
  updatedAt: '2026-11-11T00:00:00.000Z',
  prs: [],
}));

let daemon: MockDaemonController;

test.beforeEach(async ({ page }, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    workspaceCwd,
    sessionId: 'bind-current',
    displayName: 'Current fixture',
    // The scenario keeps the array by reference and the metadata PATCH
    // handler replaces entries, so give each test its own copy.
    sessions: sessions.map((session) => ({ ...session, prs: [] })),
    capabilities: {
      features: [
        'session_events',
        'session_source_metadata',
        'workspace_session_live_state',
        'workspace_session_metadata',
        'workspace_qualified_rest_core',
      ],
    },
    gitHubPrs: {
      v: 1,
      workspaceCwd,
      available: true,
      pullRequests: [
        {
          number: 16865,
          title: 'feat: bindable PR',
          url: prUrl,
          author: 'octocat',
          headRefName: 'feat/bindable',
          state: 'open',
          reviewDecision: 'approved',
          checks: 'passing',
          updatedAt: 1_800_000_000,
        },
      ],
    },
  });
  daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page
    .getByRole('button', { name: 'Session Overview', exact: true })
    .click();
  await expect(
    page
      .locator('[data-web-shell-session-panel]')
      .getByRole('button', { name: 'Current fixture', exact: true }),
  ).toBeVisible();
});

function metadataPatches() {
  return daemon.requests.filter(
    (request) =>
      request.method === 'PATCH' && /\/metadata\/?$/.test(request.path),
  );
}

async function openBindDialog(page: Page, rowName: string) {
  const row = page
    .locator('[data-web-shell-session-panel] tbody tr')
    .filter({ hasText: rowName });
  await row.getByRole('button', { name: 'Bind PR', exact: true }).click();
  const input = page.locator('input[aria-label="Bind PR"]');
  await expect(input).toBeVisible();
  return input;
}

test('binds a URL to the current session and refreshes the badge @smoke', async ({
  page,
}) => {
  const input = await openBindDialog(page, 'Current fixture');
  await input.fill(prUrl);
  await page.getByRole('button', { name: 'Bind', exact: true }).click();
  await expect(input).toHaveCount(0);
  const patches = metadataPatches();
  expect(patches).toHaveLength(1);
  // The panel binds the current session through its own session route when
  // the connection identifies it, and through the workspace route otherwise;
  // the daemon accepts both. The exact three-branch routing is pinned by the
  // SessionOverviewPanel unit tests with a controlled connection.
  expect(patches[0].path).toMatch(
    /^(\/workspaces\/[^/]+)?\/session\/bind-current\/metadata$/,
  );
  expect(patches[0].body).toMatchObject({ pr: { number: 16865, url: prUrl } });
  const row = page
    .locator('[data-web-shell-session-panel] tbody tr')
    .filter({ hasText: 'Current fixture' });
  await expect(row.getByText('#16865')).toBeVisible();
});

test('resolves a typed number through the workspace PR list @smoke', async ({
  page,
}) => {
  const input = await openBindDialog(page, 'Current fixture');
  await input.fill('16865');
  await page.getByRole('button', { name: 'Bind', exact: true }).click();
  await expect(input).toHaveCount(0);
  const patches = metadataPatches();
  expect(patches).toHaveLength(1);
  expect(patches[0].body).toMatchObject({
    pr: { number: 16865, url: prUrl, state: 'open' },
  });
});

test('asks for the URL when the number is not in the open list @smoke', async ({
  page,
}) => {
  const input = await openBindDialog(page, 'Current fixture');
  await input.fill('42');
  await page.getByRole('button', { name: 'Bind', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('#42');
  await expect(input).toBeVisible();
  expect(metadataPatches()).toHaveLength(0);
});

test('rejects invalid input without a PATCH @smoke', async ({ page }) => {
  const input = await openBindDialog(page, 'Current fixture');
  await input.fill('not-a-pr');
  await page.getByRole('button', { name: 'Bind', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(metadataPatches()).toHaveLength(0);
});

test('binds another session through the workspace-scoped route @smoke', async ({
  page,
}) => {
  const input = await openBindDialog(page, 'Other fixture');
  await input.fill(prUrl);
  await page.getByRole('button', { name: 'Bind', exact: true }).click();
  await expect(input).toHaveCount(0);
  const patches = metadataPatches();
  expect(patches).toHaveLength(1);
  expect(patches[0].path).toBe(
    `/workspaces/${encodeURIComponent(workspaceCwd)}/session/bind-other/metadata`,
  );
  expect(patches[0].body).toMatchObject({ pr: { number: 16865, url: prUrl } });
});

// The mock's workspace-ownership guard must reject a bind addressed through
// a workspace the session does not belong to, mirroring production's
// workspace_mismatch. Driven with a raw PATCH because the UI always addresses
// a session through its own workspace.
test('rejects a bind routed through the wrong workspace @smoke', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const res = await fetch(
      `/workspaces/${encodeURIComponent('/tmp/not-the-session-workspace')}/session/bind-current/metadata`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pr: {
            number: 16865,
            url: 'https://github.com/example/repo/pull/16865',
          },
        }),
      },
    );
    return { status: res.status, body: await res.json() };
  });
  expect(result.status).toBe(400);
  expect(result.body.code).toBe('workspace_mismatch');
  const session = daemon.scenario.sessions.find(
    (s) => s.sessionId === 'bind-current',
  );
  expect(session?.prs ?? []).toHaveLength(0);
});

test('rejects a bind whose workspace segment cannot be decoded @smoke', async ({
  page,
}) => {
  // %E0%A4%A is an invalid UTF-8 percent-sequence: decodeURIComponent throws,
  // and the guard must fail closed rather than treat it as an unscoped route.
  const result = await page.evaluate(async () => {
    const res = await fetch(
      '/workspaces/%E0%A4%A/session/bind-current/metadata',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pr: {
            number: 16865,
            url: 'https://github.com/example/repo/pull/16865',
          },
        }),
      },
    );
    return { status: res.status, body: await res.json() };
  });
  expect(result.status).toBe(400);
  expect(result.body.code).toBe('workspace_mismatch');
  const session = daemon.scenario.sessions.find(
    (s) => s.sessionId === 'bind-current',
  );
  expect(session?.prs ?? []).toHaveLength(0);
});
