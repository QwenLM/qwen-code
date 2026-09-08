import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

for (const { name, advertisedInterval, expectedInterval } of [
  {
    name: 'older daemon',
    advertisedInterval: undefined,
    expectedInterval: 5000,
  },
  {
    name: 'ten-second override',
    advertisedInterval: 10000,
    expectedInterval: 10000,
  },
  { name: 'custom interval', advertisedInterval: 7500, expectedInterval: 7500 },
  { name: 'invalid capability', advertisedInterval: 0, expectedInterval: 5000 },
]) {
  test(`uses the daemon live-state cadence for ${name}`, async ({
    page,
  }, testInfo) => {
    const scenario = createWebShellDaemonScenario({
      capabilities: {
        ...(advertisedInterval === undefined
          ? {}
          : { sessionLiveStatePollIntervalMs: advertisedInterval }),
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
    const liveRequests = () =>
      daemon.requests.filter(
        (request) =>
          request.method === 'GET' &&
          /^\/workspaces\/[^/]+\/sessions\/live-state\/?$/.test(request.path),
      ).length;
    const expectCadence = async () => {
      const before = liveRequests();
      await page.clock.runFor(expectedInterval - 1);
      expect(liveRequests()).toBe(before);
      await page.clock.runFor(1);
      await expect.poll(liveRequests).toBe(before + 1);
    };

    await page.clock.install({ time: new Date('2026-09-08T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-09-08T01:00:00Z'));
    await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
    await expect(page.locator('[data-web-shell-root]')).toBeVisible();
    await expect.poll(liveRequests).toBeGreaterThan(0);
    await expectCadence();

    const beforeReload = liveRequests();
    await page.reload();
    await expect(page.locator('[data-web-shell-root]')).toBeVisible();
    await expect.poll(liveRequests).toBeGreaterThan(beforeReload);
    await expectCadence();
  });
}
