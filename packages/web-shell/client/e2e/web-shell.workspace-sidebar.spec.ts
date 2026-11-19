import { expect, test, type Page } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

const workspaces = ['primary', 'second', 'third'].map((name, index) => ({
  id: `sidebar-${name}`,
  cwd: `/tmp/sidebar-${name}`,
  primary: index === 0,
  trusted: true,
}));
let scenario: WebShellDaemonScenario;
let daemon: MockDaemonController;

function sessionDate(workspaceIndex: number, index: number): Date {
  if (workspaceIndex < 2 || index < 2)
    return new Date(2026, 0, workspaceIndex === 1 ? 1 : 2, 0, index);
  if (index < 5) return new Date(2025, 11, 20, 0, index);
  return new Date(2025, 9, 1, 0, index);
}

function workspaceRow(page: Page, index: number) {
  return page.locator(`[data-sidebar-workspace="${workspaces[index]!.cwd}"]`);
}

function header(page: Page, index: number) {
  return workspaceRow(page, index).locator('button[aria-expanded]').first();
}

async function order(page: Page) {
  return page
    .locator('[data-sidebar-workspace]')
    .evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-sidebar-workspace')),
    );
}

async function openWorkspaceFilter(page: Page) {
  const displayOptions = page.getByRole('button', {
    name: 'Display options',
    exact: true,
  });
  await expect(displayOptions).toBeVisible();
  await displayOptions.locator('../..').hover();
  await displayOptions.click();
  await page.getByRole('menuitem', { name: /^Workspace/ }).hover();
  await expect(
    page.getByRole('menuitemradio', { name: 'All', exact: true }),
  ).toBeVisible();
}

async function openGroupBy(page: Page) {
  const displayOptions = page.getByRole('button', {
    name: 'Display options',
    exact: true,
  });
  await expect(displayOptions).toBeVisible();
  await displayOptions.locator('../..').hover();
  await displayOptions.click();
  await page.getByRole('menuitem', { name: /^Group by/ }).hover();
  await expect(
    page.getByRole('menuitemradio', { name: 'Workspace', exact: true }),
  ).toBeVisible();
}

async function startDrag(page: Page, index: number) {
  const box = await header(page, index).boundingBox();
  if (!box) throw new Error('Missing workspace header');
  await page.mouse.move(box.x + 70, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 85, box.y + box.height / 2, { steps: 5 });
  await expect(header(page, 0)).toHaveAttribute('aria-expanded', 'false');
  await expect(header(page, 1)).toHaveAttribute('aria-expanded', 'false');
  await expect(header(page, 2)).toHaveAttribute('aria-expanded', 'false');
}

test.beforeEach(async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  scenario = createWebShellDaemonScenario({
    workspaceCwd: workspaces[0]!.cwd,
    sessionId: 'sidebar-primary-0',
    capabilities: {
      features: [
        'multi_workspace_sessions',
        'workspace_qualified_rest_core',
        'workspace_order',
        'session_organization',
      ],
      workspaces,
    },
    sessions: workspaces.flatMap((workspace, workspaceIndex) =>
      Array.from({ length: 7 }, (_, index) => ({
        sessionId: `${workspace.id}-${index}`,
        workspaceCwd: workspace.cwd,
        displayName: `${workspace.id} session ${index + 1}`,
        createdAt: sessionDate(workspaceIndex, index).toISOString(),
        updatedAt: sessionDate(workspaceIndex, index).toISOString(),
        clientCount: 0,
        hasActivePrompt: false,
      })),
    ),
  });
  daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: scenario.sessionId, replayedCount: 0 }),
  );
  await expect(header(page, 2)).toBeVisible();
  await expect(header(page, 0)).toHaveAttribute('draggable', 'true');
});

test('workspace filtering survives reload and restores defaults', async ({
  page,
}, testInfo) => {
  const secondLabel = workspaces[1]!.cwd.split('/').at(-1)!;
  await openWorkspaceFilter(page);
  await expect(
    page.getByRole('menuitemradio', { name: 'All', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: testInfo.outputPath('workspace-filter.png') });
  await page
    .getByRole('menuitemradio', { name: secondLabel, exact: true })
    .click();
  await expect.poll(() => order(page)).toEqual([workspaces[1]!.cwd]);
  await page.reload();
  await expect(header(page, 1)).toBeVisible();
  expect(await order(page)).toEqual([workspaces[1]!.cwd]);
  await openWorkspaceFilter(page);
  await expect(
    page.getByRole('menuitemradio', { name: secondLabel, exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  await page
    .getByRole('menuitemradio', { name: 'No workspace', exact: true })
    .click();
  await expect.poll(() => order(page)).toEqual([]);
  await openWorkspaceFilter(page);
  await page
    .getByRole('menuitem', { name: 'Restore defaults', exact: true })
    .click();
  await expect
    .poll(() => order(page))
    .toEqual(workspaces.map((workspace) => workspace.cwd));
});

test('activity date grouping filters, persists, and restores workspace grouping', async ({
  page,
}, testInfo) => {
  await page.clock.setFixedTime(new Date(2026, 0, 2, 12));
  await openGroupBy(page);
  await expect(
    page.getByRole('menuitemradio', { name: 'Workspace', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: testInfo.outputPath('group-by-menu.png') });
  await page
    .getByRole('menuitemradio', { name: 'Activity date', exact: true })
    .click();
  await expect.poll(() => order(page)).toEqual([]);
  await expect(
    page.getByText('Recent conversations', { exact: true }),
  ).toBeVisible();
  const today = page.getByRole('region', { name: 'Today', exact: true });
  const thisWeek = page.getByRole('region', {
    name: 'This week',
    exact: true,
  });
  const last30Days = page.getByRole('region', {
    name: 'Last 30 days',
    exact: true,
  });
  const older = page.getByRole('region', { name: 'Older', exact: true });
  await expect(today).toContainText('· 9');
  await today.getByRole('button', { name: 'Show 4 more', exact: true }).click();
  await expect(today).toContainText('sidebar-primary session 7');
  await expect(today).toContainText('sidebar-third session 2');
  await expect(thisWeek).toContainText('sidebar-second session 7');
  await expect(last30Days).toContainText('sidebar-third session 3');
  await expect(older).toContainText('sidebar-third session 6');
  await page.screenshot({ path: testInfo.outputPath('activity-date.png') });

  await openWorkspaceFilter(page);
  await page
    .getByRole('menuitemradio', { name: 'sidebar-second', exact: true })
    .click();
  await expect(today).toHaveCount(0);
  await expect(last30Days).toHaveCount(0);
  await expect(older).toHaveCount(0);
  await expect(thisWeek).toContainText('sidebar-second session 7');
  await expect(thisWeek).not.toContainText('sidebar-primary');
  await expect(thisWeek).not.toContainText('sidebar-third');

  await page.reload();
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: scenario.sessionId, replayedCount: 0 }),
  );
  await expect(thisWeek).toBeVisible();
  await expect(thisWeek).toContainText('sidebar-second session 7');
  await openGroupBy(page);
  await expect(
    page.getByRole('menuitemradio', { name: 'Activity date', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await openWorkspaceFilter(page);
  await expect(
    page.getByRole('menuitemradio', { name: 'sidebar-second', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  await page
    .getByRole('menuitem', { name: 'Restore defaults', exact: true })
    .click();
  await expect
    .poll(() => order(page))
    .toEqual(workspaces.map((workspace) => workspace.cwd));
  await expect(today).toHaveCount(0);
  await expect(thisWeek).toHaveCount(0);
});

test('bulk collapse/expand retains headers and five-session previews', async ({
  page,
}, testInfo) => {
  await page
    .getByRole('button', { name: 'Collapse all workspaces', exact: true })
    .locator('../..')
    .hover();
  await page
    .getByRole('button', { name: 'Collapse all workspaces', exact: true })
    .click();
  for (let index = 0; index < workspaces.length; index++) {
    await expect(header(page, index)).toBeVisible();
    await expect(header(page, index)).toHaveAttribute('aria-expanded', 'false');
  }
  await page.reload();
  await expect(header(page, 2)).toHaveAttribute('aria-expanded', 'false');
  await page
    .getByRole('button', { name: 'Expand all workspaces', exact: true })
    .locator('../..')
    .hover();
  await page
    .getByRole('button', { name: 'Expand all workspaces', exact: true })
    .click();
  for (let index = 0; index < workspaces.length; index++) {
    await expect(header(page, index)).toHaveAttribute('aria-expanded', 'true');
    await expect(
      workspaceRow(page, index).locator('[data-web-shell-session-title]'),
    ).toHaveCount(5);
  }
  await page.screenshot({ path: testInfo.outputPath('expanded.png') });
});

test('drag sorts, temporarily collapses and restores mixed expansion and Show more @smoke', async ({
  page,
}, testInfo) => {
  await workspaceRow(page, 0)
    .getByRole('button', { name: 'Show 2 more', exact: true })
    .click();
  await workspaceRow(page, 1)
    .getByRole('button', { name: 'Show 2 more', exact: true })
    .click();
  await expect(
    workspaceRow(page, 0).locator('[data-web-shell-session-title]'),
  ).toHaveCount(7);
  await expect(
    workspaceRow(page, 1).locator('[data-web-shell-session-title]'),
  ).toHaveCount(7);
  await header(page, 2).click();
  await startDrag(page, 1);
  await expect(
    workspaceRow(page, 0).locator('[data-web-shell-session-title]').first(),
  ).toBeHidden();
  await expect(
    workspaceRow(page, 1).locator('[data-web-shell-session-title]').first(),
  ).toBeHidden();
  const target = await header(page, 0).boundingBox();
  if (!target) throw new Error('Missing drop target');
  await page.mouse.move(target.x + 80, target.y + 2, { steps: 8 });
  await page.screenshot({ path: testInfo.outputPath('dragging.png') });
  await page.mouse.up();
  await expect
    .poll(() => order(page))
    .toEqual([workspaces[1]!.cwd, workspaces[0]!.cwd, workspaces[2]!.cwd]);
  await expect(header(page, 0)).toHaveAttribute('aria-expanded', 'true');
  await expect(header(page, 1)).toHaveAttribute('aria-expanded', 'true');
  await expect(header(page, 2)).toHaveAttribute('aria-expanded', 'false');
  await expect(
    workspaceRow(page, 0).locator('[data-web-shell-session-title]:visible'),
  ).toHaveCount(7);
  await expect(
    workspaceRow(page, 1).locator('[data-web-shell-session-title]:visible'),
  ).toHaveCount(7);
  await page.screenshot({ path: testInfo.outputPath('dropped.png') });
  await expect
    .poll(() => scenario.workspaceOrder)
    .toEqual([workspaces[1]!.cwd, workspaces[0]!.cwd, workspaces[2]!.cwd]);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect
    .poll(() => order(page))
    .toEqual([workspaces[1]!.cwd, workspaces[0]!.cwd, workspaces[2]!.cwd]);
  await page.evaluate(
    (cwds) =>
      localStorage.setItem(
        `qwen.web-shell.sidebar.workspace-order:${location.origin}`,
        JSON.stringify(cwds),
      ),
    workspaces.map((entry) => entry.cwd).reverse(),
  );
  await page.reload();
  await expect
    .poll(() => order(page))
    .toEqual([workspaces[1]!.cwd, workspaces[0]!.cwd, workspaces[2]!.cwd]);
});

test('menu sorting saves on the server and a failed save restores the previous order @smoke', async ({
  page,
}) => {
  await header(page, 0).hover();
  await workspaceRow(page, 0)
    .getByRole('button', { name: 'Workspace actions', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Move down', exact: true }).click();
  const saved = [workspaces[1]!.cwd, workspaces[0]!.cwd, workspaces[2]!.cwd];
  await expect.poll(() => scenario.workspaceOrder).toEqual(saved);
  scenario.workspaceOrderSaveError = true;
  await header(page, 0).hover();
  await workspaceRow(page, 0)
    .getByRole('button', { name: 'Workspace actions', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Move up', exact: true }).click();
  await expect(
    page
      .getByText(
        'Could not load or save workspace order. Reload and try again.',
        { exact: true },
      )
      .first(),
  ).toBeVisible();
  expect(await order(page)).toEqual(saved);
  expect(scenario.workspaceOrder).toEqual(saved);
});

test('cancelling and dropping outside restore display without persisting an order', async ({
  page,
}) => {
  await header(page, 2).click();
  await startDrag(page, 0);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(header(page, 0)).toHaveAttribute('aria-expanded', 'true');
  await expect(header(page, 2)).toHaveAttribute('aria-expanded', 'false');
  await startDrag(page, 1);
  await page.mouse.move(1000, 100, { steps: 10 });
  await page.mouse.up();
  await expect(header(page, 1)).toHaveAttribute('aria-expanded', 'true');
  await expect(header(page, 2)).toHaveAttribute('aria-expanded', 'false');
  expect(await order(page)).toEqual(
    workspaces.map((workspace) => workspace.cwd),
  );
  expect(scenario.workspaceOrder).toEqual([]);
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem(
        `qwen.web-shell.sidebar.workspace-order:${window.location.origin}`,
      ),
    ),
  ).toBeNull();
});
