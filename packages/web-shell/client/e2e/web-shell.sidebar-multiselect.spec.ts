import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

test('sidebar selection preserves layout and archives without confirmation', async ({
  page,
}, testInfo) => {
  const cwd = '/tmp/sidebar-selection';
  const scenario = createWebShellDaemonScenario({
    workspaceCwd: cwd,
    sessionId: 'current',
    capabilities: {
      features: [
        'session_archive',
        'session_archive_idle_guard',
        'session_organization',
      ],
    },
    sessions: ['current', 'first', 'second'].map((id) => ({
      sessionId: id,
      workspaceCwd: cwd,
      displayName: `Selection ${id}`,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      clientCount: 0,
      hasActivePrompt: false,
    })),
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  const archives: string[][] = [];
  await page.route('**/sessions/archive', async (route) => {
    const body = route.request().postDataJSON();
    expect(body.requireIdle).toBe(true);
    archives.push(body.sessionIds);
    await route.fulfill({
      json: {
        archived: body.sessionIds,
        alreadyArchived: [],
        notFound: [],
        errors: [],
      },
    });
  });
  await page.goto('/session/current');
  await daemon.sse.waitForConnection('current');
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: 'current', replayedCount: 0 }),
  );
  const toggle = page.getByRole('button', {
    name: 'Select sessions',
    exact: true,
  });
  await expect(toggle).toBeVisible();
  const before = await toggle.boundingBox();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect(await toggle.boundingBox()).toEqual(before);
  await page
    .getByRole('checkbox', { name: 'Select Selection first', exact: true })
    .first()
    .click();
  await page
    .getByRole('checkbox', { name: 'Select Selection second', exact: true })
    .first()
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: '2 sessions selected' }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('sidebar-multiselect.png'),
  });
  await page
    .getByRole('button', { name: 'Archive', exact: true })
    .last()
    .click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(archives.flat().sort()).toEqual(['first', 'second']);
});
