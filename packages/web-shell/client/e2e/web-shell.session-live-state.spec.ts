import { expect, test } from '@playwright/test';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

test('uses live-state instead of polling the full session catalog @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    capabilities: {
      features: [
        'session_events',
        'session_source_metadata',
        'workspace_session_live_state',
      ],
    },
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  const fullCatalogRequests = () =>
    daemon.requests.filter(
      (request) =>
        request.method === 'GET' &&
        (/^\/workspace\/.+\/sessions\/?$/.test(request.path) ||
          /^\/workspaces\/[^/]+\/sessions\/?$/.test(request.path)),
    ).length;
  const liveStateRequests = () =>
    daemon.requests.filter(
      (request) =>
        request.method === 'GET' &&
        /^\/workspaces\/[^/]+\/sessions\/live-state\/?$/.test(request.path),
    ).length;

  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  await expect.poll(liveStateRequests).toBeGreaterThanOrEqual(2);
  const settledCatalogRequests = fullCatalogRequests();
  const settledLiveStateRequests = liveStateRequests();
  expect(settledCatalogRequests).toBe(1);

  await expect
    .poll(liveStateRequests)
    .toBeGreaterThan(settledLiveStateRequests);
  expect(fullCatalogRequests()).toBe(settledCatalogRequests);

  await page.getByRole('tab', { name: 'Channels' }).click();
  await expect.poll(fullCatalogRequests).toBe(settledCatalogRequests + 1);
  const requestsAfterSourceChange = fullCatalogRequests();
  const liveRequestsAfterSourceChange = liveStateRequests();

  await expect
    .poll(liveStateRequests)
    .toBeGreaterThan(liveRequestsAfterSourceChange);
  expect(fullCatalogRequests()).toBe(requestsAfterSourceChange);
});

test('scopes live-state sessions to the requested workspace', async ({
  page,
}, testInfo) => {
  const primaryCwd = '/tmp/qwen-live-primary';
  const secondaryCwd = '/tmp/qwen-live-secondary';
  const sessions = [
    {
      sessionId: 'primary-live',
      workspaceCwd: primaryCwd,
      createdAt: '2026-07-03T00:00:00.000Z',
      updatedAt: '2026-07-03T00:00:00.000Z',
      displayName: 'Primary live',
      clientCount: 1,
      hasActivePrompt: false,
    },
    {
      sessionId: 'secondary-live',
      workspaceCwd: secondaryCwd,
      createdAt: '2026-07-03T00:00:00.000Z',
      updatedAt: '2026-07-03T00:00:00.000Z',
      displayName: 'Secondary live',
      clientCount: 1,
      hasActivePrompt: false,
    },
  ] satisfies DaemonSessionSummary[];
  const scenario = createWebShellDaemonScenario({
    workspaceCwd: primaryCwd,
    sessionId: 'primary-live',
    displayName: 'Primary live',
    sessions,
    capabilities: {
      features: [
        'session_events',
        'session_source_metadata',
        'workspace_session_live_state',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: primaryCwd,
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: secondaryCwd,
          primary: false,
          trusted: true,
        },
      ],
    },
  });
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  const baseURL = String(testInfo.project.use.baseURL);

  const primaryState = await page.evaluate(
    async ({ baseURL, cwd }) => {
      const response = await fetch(
        `${baseURL}/workspaces/${encodeURIComponent(cwd)}/sessions/live-state`,
      );
      return response.json();
    },
    { baseURL, cwd: primaryCwd },
  );
  const secondaryState = await page.evaluate(
    async ({ baseURL, cwd }) => {
      const response = await fetch(
        `${baseURL}/workspaces/${encodeURIComponent(cwd)}/sessions/live-state`,
      );
      return response.json();
    },
    { baseURL, cwd: secondaryCwd },
  );

  expect(primaryState.sessions.map((session) => session.sessionId)).toEqual([
    'primary-live',
  ]);
  expect(secondaryState.sessions.map((session) => session.sessionId)).toEqual([
    'secondary-live',
  ]);
});
