import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { COLLAPSED_SESSION_SECTIONS_STORAGE_KEY } from '../components/sidebar/collapsedSessionSections';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

test('persists collapsed session groups across reload @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createOrganizedScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);

  const backendSection = page.locator('section[aria-label="Backend"]');
  const backendHeader = backendSection.getByRole('button', {
    name: /^Backend/,
  });
  await expect(backendHeader).toHaveAttribute('aria-expanded', 'true');
  await expect(backendSection).toContainText('API review');

  await backendHeader.click();
  await expect(backendHeader).toHaveAttribute('aria-expanded', 'false');
  await expect(backendSection).not.toContainText('API review');
  await expect
    .poll(async () =>
      page.evaluate(
        (key) => window.localStorage.getItem(key),
        COLLAPSED_SESSION_SECTIONS_STORAGE_KEY,
      ),
    )
    .toBe(JSON.stringify(['group:group-backend']));

  await page.reload();
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  await completeReplay(
    page,
    daemon,
    scenario.sessionId,
    scenario.events.length,
  );

  const backendAfterReload = page.locator('section[aria-label="Backend"]');
  const backendHeaderAfterReload = backendAfterReload.getByRole('button', {
    name: /^Backend/,
  });
  await expect(backendHeaderAfterReload).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(backendAfterReload).not.toContainText('API review');
  await expect(page.locator('section[aria-label="Ungrouped"]')).toContainText(
    'Release notes',
  );
});

test('keeps long session details inside a constrained WebShell @smoke', async ({
  page,
}, testInfo) => {
  const longTitle = 'longunbrokensessiontitle'.repeat(24);
  const scenario = createOrganizedScenario(longTitle);
  const daemon = await installScenario(page, scenario, testInfo);

  await page.setViewportSize({ width: 700, height: 500 });
  await gotoSession(page, scenario, daemon);

  const webShellRoot = page.locator('[data-web-shell-root]');
  await page.getByRole('button', { name: 'Toggle menu' }).click();
  const sessionTitle = webShellRoot.getByText(longTitle, { exact: true });
  await expect(sessionTitle).toBeVisible();

  await sessionTitle.hover();
  const details = page.getByRole('dialog', { name: longTitle });
  const title = details.getByTitle(longTitle);
  const copyAction = details.getByRole('button', {
    name: 'Copy session ID',
  });
  await expect(details).toBeVisible();
  await expect(title).toHaveAttribute('title', longTitle);
  await expect(copyAction).toBeVisible();
  await expect(
    details.getByText(scenario.sessionId, { exact: true }),
  ).toBeVisible();

  await expectDetailsInsideRoot(webShellRoot, details);

  for (const size of [
    { width: 620, height: 400 },
    { width: 520, height: 320 },
  ]) {
    await page.setViewportSize(size);
    // Close the details popover before re-hovering: at constrained sizes it
    // can flip to cover its own anchor row and intercept the hover.
    await page.mouse.move(0, 0);
    await expect(details).toBeHidden();
    await sessionTitle.hover();
    await expect(details).toBeVisible();
    await expectDetailsInsideRoot(webShellRoot, details);
    await expect(copyAction).toBeVisible();
  }

  const titleMetrics = await title.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      clientHeight: element.clientHeight,
      lineHeight: Number.parseFloat(style.lineHeight),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    };
  });
  expect(titleMetrics.clientHeight).toBeLessThanOrEqual(
    titleMetrics.lineHeight + 1,
  );
  expect(titleMetrics.scrollWidth).toBeGreaterThan(titleMetrics.clientWidth);
});

async function expectDetailsInsideRoot(
  root: Locator,
  details: Locator,
): Promise<void> {
  await expect
    .poll(async () => {
      const [rootBox, detailsBox] = await Promise.all([
        root.boundingBox(),
        details.boundingBox(),
      ]);
      if (!rootBox || !detailsBox) return false;
      const tolerance = 1;
      return (
        detailsBox.x >= rootBox.x - tolerance &&
        detailsBox.y >= rootBox.y - tolerance &&
        detailsBox.x + detailsBox.width <=
          rootBox.x + rootBox.width + tolerance &&
        detailsBox.y + detailsBox.height <=
          rootBox.y + rootBox.height + tolerance
      );
    })
    .toBe(true);
}

function createOrganizedScenario(
  currentSessionDisplayName = 'E2E Harness Session',
): WebShellDaemonScenario {
  const workspaceCwd = '/tmp/qwen-web-shell-e2e';
  const sessionId = 'web-shell-e2e-session';
  return createWebShellDaemonScenario({
    workspaceCwd,
    sessionId,
    capabilities: {
      features: [
        'session_events',
        'permission_vote',
        'session_permission_vote',
        'session_scope_override',
        'workspace_settings',
        'workspace_voice',
        'session_organization',
      ],
    },
    sessionGroups: [
      {
        id: 'group-backend',
        name: 'Backend',
        color: 'green',
        order: 0,
        createdAt: '2026-07-04T00:00:00.000Z',
        updatedAt: '2026-07-04T00:00:00.000Z',
      },
    ],
    sessions: [
      {
        sessionId,
        workspaceCwd,
        createdAt: '2026-07-03T00:00:00.000Z',
        updatedAt: '2026-07-03T00:00:00.000Z',
        displayName: currentSessionDisplayName,
        clientCount: 1,
        hasActivePrompt: false,
        groupId: null,
        color: null,
      },
      {
        sessionId: 'session-api-review',
        workspaceCwd,
        createdAt: '2026-07-03T00:00:00.000Z',
        updatedAt: '2026-07-03T00:00:00.000Z',
        displayName: 'API review',
        clientCount: 0,
        hasActivePrompt: false,
        groupId: 'group-backend',
        color: null,
      },
      {
        sessionId: 'session-release-notes',
        workspaceCwd,
        createdAt: '2026-07-03T00:00:00.000Z',
        updatedAt: '2026-07-03T00:00:00.000Z',
        displayName: 'Release notes',
        clientCount: 0,
        hasActivePrompt: false,
        groupId: null,
        color: null,
      },
    ],
  });
}

async function installScenario(
  page: Page,
  scenario: WebShellDaemonScenario,
  testInfo: TestInfo,
): Promise<MockDaemonController> {
  return installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
}

async function gotoSession(
  page: Page,
  scenario: WebShellDaemonScenario,
  daemon: MockDaemonController,
): Promise<void> {
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  await completeReplay(
    page,
    daemon,
    scenario.sessionId,
    scenario.events.length,
  );
}

async function completeReplay(
  page: Page,
  daemon: MockDaemonController,
  sessionId?: string,
  replayedCount = 0,
): Promise<void> {
  const connection = await daemon.sse.waitForConnection(sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount,
    }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);
}
