import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

const workspaceCwd = '/tmp/touch-sidebar-workspace';

test('supports touch single-trigger Action Sheet, details, group subpage, dialog rename, long press, and workspace menu @smoke', async ({
  page,
}, testInfo) => {
  const renamedRequests: Array<{ sessionId: string; displayName: string }> = [];
  const organizationRequests: Array<{
    sessionId: string;
    body: Record<string, unknown>;
  }> = [];

  const scenario = createWebShellDaemonScenario({
    workspaceCwd,
    sessionId: 'sess-current',
    capabilities: {
      features: [
        'session_events',
        'session_organization',
        'session_archive',
        'session_export',
        'workspace_session_metadata',
        'workspace_qualified_rest_core',
      ],
      workspaces: [
        { id: 'ws-primary', cwd: workspaceCwd, primary: true, trusted: true },
        {
          id: 'ws-secondary',
          cwd: '/tmp/touch-sidebar-secondary',
          primary: false,
          trusted: true,
        },
      ],
    },
    sessions: [
      {
        sessionId: 'sess-current',
        workspaceCwd,
        displayName: 'Current conversation',
        updatedAt: '2026-11-28T09:00:00Z',
        clientCount: 1,
      },
      {
        sessionId: 'sess-target',
        workspaceCwd,
        displayName: 'Long title for touch sidebar actions testing',
        updatedAt: '2026-11-28T10:00:00Z',
        branch: { name: 'feat/touch-actions' },
        clientCount: 0,
      },
    ],
  });

  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });

  await page.route(/\/session-groups(?:\?|$)/, async (route) => {
    await route.fulfill({
      json: {
        groups: [{ id: 'grp-mobile', name: 'Mobile', color: 'blue' }],
        colorOptions: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
      },
    });
  });

  await page.route(
    /\/sessions?\/[^/]+\/organization(?:\?|$)/,
    async (route) => {
      const url = new URL(route.request().url());
      const parts = url.pathname.split('/');
      const sessionId = decodeURIComponent(parts[parts.length - 2]!);
      const body = (route.request().postDataJSON() ?? {}) as Record<
        string,
        unknown
      >;
      organizationRequests.push({ sessionId, body });
      await route.fulfill({ json: { ok: true } });
    },
  );

  await page.route(/\/sessions?\/[^/]+\/metadata(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/');
    const sessionId = decodeURIComponent(parts[parts.length - 2]!);
    const body = (route.request().postDataJSON() ?? {}) as {
      displayName?: string;
    };
    const displayName = body.displayName ?? '';
    renamedRequests.push({ sessionId, displayName });
    await route.fulfill({ json: { sessionId, displayName } });
  });

  await page.goto(`/session/${scenario.sessionId}?lang=en`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: scenario.sessionId,
      replayedCount: scenario.events.length,
    }),
  );

  // Open the mobile sidebar drawer.
  const openSidebar = page.getByRole('button', {
    name: 'Toggle menu',
    exact: true,
  });
  await openSidebar.tap();

  const sidebar = page.locator('[data-sidebar-shell]');
  await expect(sidebar).toBeVisible();

  const targetRow = sidebar
    .getByLabel('Ungrouped')
    .locator('[class*="sessionRow"]')
    .filter({ hasText: 'Long title for touch sidebar actions testing' });
  await expect(targetRow).toBeVisible();

  // Recent sessions row also converges to a single More button on touch.
  const recentRow = sidebar
    .getByTestId('recent-sessions')
    .locator('[class*="sessionRow"]')
    .filter({ hasText: 'Long title for touch sidebar actions testing' });
  await expect(
    recentRow.getByRole('button', { name: 'More actions', exact: true }),
  ).toHaveCount(1);
  await expect(
    recentRow.getByRole('button', { name: 'Archive', exact: true }),
  ).toHaveCount(0);

  // Single More button only (no inline Pin) with enlarged touch dimensions.
  await expect(
    targetRow.getByRole('button', { name: 'Pin', exact: true }),
  ).toHaveCount(0);
  const moreButton = targetRow.getByRole('button', {
    name: 'More actions',
    exact: true,
  });
  await expect(moreButton).toHaveCount(1);
  const rowBox = await targetRow.boundingBox();
  const moreBox = await moreButton.boundingBox();
  expect(rowBox).not.toBeNull();
  expect(moreBox).not.toBeNull();
  expect(rowBox!.height).toBeGreaterThanOrEqual(40);
  expect(moreBox!.width).toBeGreaterThanOrEqual(36);
  expect(moreBox!.height).toBeGreaterThanOrEqual(36);

  // Tapping More actions opens the bottom Action Sheet with embedded details.
  await moreButton.tap();
  const sheet = page.locator('[data-web-shell-session-action-sheet]');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(
    'Long title for touch sidebar actions testing',
  );
  await expect(sheet).toContainText(workspaceCwd);
  await expect(sheet).toContainText('feat/touch-actions');
  await expect(sheet).toContainText('sess-target');
  await expect(sheet.locator('[data-web-shell-session-id-copy]')).toBeVisible();
  // Active session must not have switched.
  expect(page.url()).toContain('/session/sess-current');

  // Navigate to the in-sheet Group subpage and assign a group.
  await sheet.getByRole('button', { name: 'Group' }).tap();
  const mobileGroup = sheet.getByRole('menuitemradio', { name: 'Mobile' });
  await expect(mobileGroup).toBeVisible();
  await mobileGroup.tap();
  await expect.poll(() => organizationRequests.length).toBe(1);
  expect(organizationRequests[0]).toEqual({
    sessionId: 'sess-target',
    body: { groupId: 'grp-mobile', color: null },
  });
  await expect(sheet).toHaveCount(0);

  // Rename via Action Sheet opens SessionRenameDialog instead of inline edit.
  await moreButton.tap();
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Rename', exact: true }).tap();
  const dialog = page.locator('[data-web-shell-dialog]');
  await expect(dialog).toBeVisible();
  const input = dialog.locator('input');
  await input.fill('Renamed on touch phone');
  await dialog.getByRole('button', { name: /^save$/i }).tap();
  await expect.poll(() => renamedRequests.length).toBe(1);
  expect(renamedRequests[0]).toEqual({
    sessionId: 'sess-target',
    displayName: 'Renamed on touch phone',
  });

  // Long press on the session row opens the Action Sheet without switching.
  await targetRow.locator('[data-web-shell-session-title]').evaluate((el) => {
    const down = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'touch',
      pointerId: 7,
      isPrimary: true,
      clientX: 40,
      clientY: 40,
    });
    el.dispatchEvent(down);
  });
  await page.waitForTimeout(520);
  await expect(sheet).toBeVisible();
  expect(page.url()).toContain('/session/sess-current');
  await sheet.getByRole('button', { name: /^close$/i }).tap();
  await expect(sheet).toHaveCount(0);

  // Workspace header actions are visible without hover and expose WorkspaceMenu.
  const wsActions = sidebar.locator('[data-workspace-actions]').first();
  await expect(wsActions).toBeVisible();
  const wsTrigger = wsActions.getByRole('button', {
    name: 'Workspace actions',
    exact: true,
  });
  await expect(wsTrigger).toBeVisible();
  await wsTrigger.tap();
  const wsSummary = page.locator('[data-web-shell-workspace-menu-summary]');
  await expect(wsSummary).toBeVisible();
  await expect(wsSummary).toContainText(workspaceCwd);
});
