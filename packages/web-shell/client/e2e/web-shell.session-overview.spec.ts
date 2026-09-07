import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

const workspaceCwd = '/tmp/session-overview-e2e/project';
const sessions = [
  {
    sessionId: 'approval-session',
    displayName: 'Approve fixture',
    isWaitingForPermission: true,
    hasActivePrompt: true,
  },
  {
    sessionId: 'question-session',
    displayName: 'Question fixture',
    isWaitingForUserQuestion: true,
    hasActivePrompt: true,
  },
  {
    sessionId: 'running-session',
    displayName: 'Running fixture',
    hasActivePrompt: true,
  },
  {
    sessionId: 'idle-session',
    displayName: 'Idle fixture',
    hasActivePrompt: false,
  },
].map((session, index) => ({
  ...session,
  workspaceCwd,
  clientCount: 1,
  updatedAt: '2026-09-07T00:00:00.000Z',
  branch: {
    name:
      session.sessionId === 'idle-session'
        ? 'feature/idle-search'
        : 'feature/overview-preview',
    baseBranch: 'main',
  },
  prs: Array.from(
    { length: session.sessionId === 'question-session' ? 8 : 1 },
    (_, prIndex) => ({
      number: 4567 + index + prIndex * 10,
      url: `https://github.com/example/repo/pull/${4567 + index + prIndex * 10}`,
      state: 'open' as const,
      issues: [
        {
          number: 1234 + prIndex,
          url: `https://github.com/example/repo/issues/${1234 + prIndex}`,
          state: 'open' as const,
        },
      ],
    }),
  ),
}));

test.beforeEach(async ({ page }, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    workspaceCwd,
    sessionId: 'idle-session',
    displayName: 'Idle fixture',
    sessions,
    capabilities: {
      features: [
        'session_events',
        'session_source_metadata',
        'workspace_session_live_state',
        'session_archive',
        'workspace_session_metadata',
      ],
    },
  });
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Session Overview', exact: true })
    .click();
  await expect(
    page
      .locator('[data-web-shell-session-panel]')
      .getByRole('button', { name: 'Approve fixture', exact: true }),
  ).toBeVisible();
});

test('compact overview distinguishes states and filters checkbox selection @smoke', async ({
  page,
}) => {
  const panel = page.locator('[data-web-shell-session-panel]');
  await expect(
    panel.getByRole('columnheader', { name: 'Session ID' }),
  ).toHaveCount(0);
  for (const [status, label] of [
    ['needsApproval', 'Needs approval'],
    ['askUserQuestion', 'User input needed'],
    ['running', 'Running'],
    ['idle', 'Idle'],
  ] as const) {
    await expect(
      panel.locator(`[data-web-shell-session-status="${status}"]`),
    ).toHaveText(label);
    await expect(
      panel.locator(`[data-web-shell-session-status="${status}"]`),
    ).toHaveAttribute('title', label);
  }
  for (const name of [
    'Approve fixture',
    'Question fixture',
    'Running fixture',
  ]) {
    const row = panel.getByRole('row').filter({ hasText: name });
    await expect(
      row.getByRole('button', { name: 'Archive', exact: true }),
    ).toBeDisabled();
    await expect(
      row.getByRole('button', { name: 'Delete', exact: true }),
    ).toBeDisabled();
  }
  await expect(
    panel
      .locator('[data-web-shell-session-footer]')
      .getByRole('button', { name: 'Open in new tab', exact: true }),
  ).toHaveCount(0);
  await panel
    .getByRole('checkbox', { name: 'Select Idle fixture', exact: true })
    .check();
  await expect(
    panel
      .locator('[data-web-shell-session-footer]')
      .getByRole('button', { name: 'Open in new tab', exact: true }),
  ).toBeVisible();
  await expect(panel).toBeVisible();
  const filters = panel.getByRole('group', {
    name: 'Filter by session status',
  });
  await filters.getByRole('button', { name: /Needs attention/ }).click();
  await expect(panel.locator('[data-web-shell-session-title]')).toHaveCount(2);
  await expect(panel.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await filters.getByRole('button', { name: /All/ }).click();
  const search = panel.getByRole('textbox', {
    name: 'Search title, branch, PR or ID…',
  });
  for (const query of [
    'feature/idle-search',
    '#4570',
    'idle-session',
    'Idle fixture',
  ]) {
    await search.fill(query);
    await expect(panel.locator('[data-web-shell-session-title]')).toHaveText([
      'Idle fixture',
    ]);
  }
  await search.fill('');
  await expect(panel.locator('[data-web-shell-session-title]')).toHaveCount(4);
});

test('title hover exposes full metadata, permits copy, and links keep overview open @smoke', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await context.route('https://github.com/example/repo/**', (route) =>
    route.fulfill({ body: 'Synthetic external destination' }),
  );
  const panel = page.locator('[data-web-shell-session-panel]');
  const title = panel.getByRole('button', {
    name: 'Approve fixture',
    exact: true,
  });
  await title.hover();
  const dialog = page.getByRole('dialog', {
    name: 'Approve fixture',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(workspaceCwd);
  await expect(dialog).toContainText('feature/overview-preview');
  await expect(dialog).toContainText('Needs approval');
  await expect(dialog.locator('[data-web-shell-session-id]')).toHaveText(
    'approval-session',
  );
  await dialog.locator('[data-web-shell-session-id-copy]').click();
  await expect(dialog).toContainText('Session ID copied');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('approval-session');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('checkbox', { checked: true })).toHaveCount(0);
  const popupPromise = page.waitForEvent('popup');
  await dialog.getByRole('link', { name: /Pull Request #4567/ }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL('https://github.com/example/repo/pull/4567');
  await popup.close();
  await expect(panel).toBeVisible();
  await title.hover();
  await expect(
    dialog.getByRole('link', { name: /Issue #1234/ }),
  ).toHaveAttribute('href', 'https://github.com/example/repo/issues/1234');
});

test('details button supports keyboard and Escape restores focus without navigating @smoke', async ({
  page,
}) => {
  const panel = page.locator('[data-web-shell-session-panel]');
  await page.setViewportSize({ width: 900, height: 420 });
  const button = panel.getByRole('button', {
    name: 'Details for Question fixture',
  });
  await button.press('Enter');
  const dialog = page.getByRole('dialog', {
    name: 'Question fixture',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('User input needed');
  await expect(
    dialog.locator('[data-web-shell-session-id-copy]'),
  ).toBeFocused();
  await expect(
    dialog.locator('[data-web-shell-session-id-copy]'),
  ).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(panel).toBeVisible();
  await button.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('row opens a session without selecting it @smoke', async ({ page }) => {
  const panel = page.locator('[data-web-shell-session-panel]');
  const idle = panel.getByRole('row').filter({ hasText: 'Idle fixture' });
  await idle.locator('[data-web-shell-session-status]').click();
  await expect(panel).toHaveCount(0);
  await expect(page).toHaveURL(/\/session\/idle-session/);
});

test('keeps text selection and rename drafts in the overview @smoke', async ({
  page,
}) => {
  const panel = page.locator('[data-web-shell-session-panel]');
  const idle = panel.getByRole('row').filter({
    has: page.getByRole('checkbox', {
      name: 'Select Idle fixture',
      exact: true,
    }),
  });
  const workspace = await idle
    .locator('[data-web-shell-session-workspace]')
    .boundingBox();
  const branch = await idle
    .locator('[data-web-shell-session-git]')
    .boundingBox();
  expect(workspace).not.toBeNull();
  expect(branch).not.toBeNull();
  await page.mouse.move(workspace!.x + 2, workspace!.y + workspace!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    branch!.x + branch!.width / 2,
    branch!.y + branch!.height / 2,
    { steps: 10 },
  );
  await page.mouse.up();
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(
    false,
  );
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await idle.getByRole('button', { name: 'Rename', exact: true }).click();
  const editor = idle.getByRole('textbox', { name: 'Rename: Idle fixture' });
  await editor.fill('Unsaved rename');
  await idle
    .locator('td')
    .nth(2)
    .click({ position: { x: 130, y: 20 } });
  await expect(panel).toBeVisible();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('Unsaved rename');
  await editor.press('Escape');
  await expect(editor).toHaveCount(0);
});

test('replaces clicked details when hovering another entry @smoke', async ({
  page,
}) => {
  const panel = page.locator('[data-web-shell-session-panel]');
  await panel.getByRole('button', { name: 'Details for Idle fixture' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Idle fixture', exact: true }),
  ).toBeVisible();
  await panel
    .getByRole('button', { name: 'Approve fixture', exact: true })
    .hover();
  await expect(
    page.getByRole('dialog', { name: 'Approve fixture', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(
    page.getByRole('dialog', { name: 'Approve fixture', exact: true }),
  ).toHaveAttribute('data-state', 'open');
  await page.mouse.move(0, 0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
