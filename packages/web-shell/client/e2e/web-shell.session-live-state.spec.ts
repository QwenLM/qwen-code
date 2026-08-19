import { expect, test } from '@playwright/test';
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
