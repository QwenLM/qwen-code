import { expect, test, type Page } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

const workspaces = ['primary', 'second', 'third'].map((name, index) => ({
  id: `expansion-${name}`,
  cwd: `/tmp/expansion-${name}`,
  primary: index === 0,
  trusted: true,
}));
let scenario: WebShellDaemonScenario;

function workspaceRow(page: Page, index: number) {
  return page.locator(`[data-sidebar-workspace="${workspaces[index]!.cwd}"]`);
}

function header(page: Page, index: number) {
  return workspaceRow(page, index).locator('button[aria-expanded]').first();
}

function sessionTitles(page: Page, index: number) {
  return workspaceRow(page, index).locator('[data-web-shell-session-title]');
}

test.beforeEach(async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  scenario = createWebShellDaemonScenario({
    workspaceCwd: workspaces[0]!.cwd,
    sessionId: 'expansion-primary-0',
    capabilities: {
      features: [
        'multi_workspace_sessions',
        'workspace_qualified_rest_core',
        'workspace_order',
      ],
      workspaces,
    },
    sessions: workspaces.flatMap((workspace, workspaceIndex) =>
      Array.from({ length: workspaceIndex === 0 ? 16 : 2 }, (_, index) => ({
        sessionId: `${workspace.id}-${index}`,
        workspaceCwd: workspace.cwd,
        displayName: `${workspace.id} session ${index + 1}`,
        createdAt: new Date(2026, 0, 1, 0, index).toISOString(),
        updatedAt: new Date(2026, 0, 1, 0, index).toISOString(),
        clientCount: 0,
        hasActivePrompt: false,
      })),
    ),
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}?language=en`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: scenario.sessionId, replayedCount: 0 }),
  );
  await expect(header(page, 0)).toBeVisible();
  if ((await header(page, 0).getAttribute('aria-expanded')) !== 'true') {
    await header(page, 0).click();
  }
  await expect(header(page, 0)).toHaveAttribute('aria-expanded', 'true');
});

test('expands the session preview ten at a time and resets on collapse', async ({
  page,
}) => {
  await expect(sessionTitles(page, 0)).toHaveCount(5);
  const showTen = workspaceRow(page, 0).getByRole('button', {
    name: 'Show 10 more',
    exact: true,
  });
  await expect(showTen).toBeVisible();
  await showTen.click();
  await expect(sessionTitles(page, 0)).toHaveCount(15);
  await expect(
    workspaceRow(page, 0).getByRole('button', {
      name: 'Show 10 more',
      exact: true,
    }),
  ).toHaveCount(0);
  const showOne = workspaceRow(page, 0).getByRole('button', {
    name: 'Show 1 more',
    exact: true,
  });
  await expect(showOne).toBeVisible();
  await showOne.click();
  await expect(sessionTitles(page, 0)).toHaveCount(16);
  await expect(
    workspaceRow(page, 0).getByRole('button', { name: /Show \d+ more/ }),
  ).toHaveCount(0);

  await header(page, 0).click();
  await expect(header(page, 0)).toHaveAttribute('aria-expanded', 'false');
  await header(page, 0).click();
  await expect(header(page, 0)).toHaveAttribute('aria-expanded', 'true');
  await expect(sessionTitles(page, 0)).toHaveCount(5);
  await expect(
    workspaceRow(page, 0).getByRole('button', {
      name: 'Show 10 more',
      exact: true,
    }),
  ).toBeVisible();
});

test('labels the expansion step in Chinese', async ({ page }, testInfo) => {
  await page.goto(`/session/${scenario.sessionId}?language=zh-CN`);
  await expect(header(page, 0)).toBeVisible();
  if ((await header(page, 0).getAttribute('aria-expanded')) !== 'true') {
    await header(page, 0).click();
  }
  await expect(sessionTitles(page, 0)).toHaveCount(5);
  const showTen = workspaceRow(page, 0).getByRole('button', {
    name: '再显示 10 个',
    exact: true,
  });
  await expect(showTen).toBeVisible();
  await showTen.click();
  await expect(sessionTitles(page, 0)).toHaveCount(15);
  await expect(
    workspaceRow(page, 0).getByRole('button', {
      name: '再显示 1 个',
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('zh-cn-expanded.png') });
});
