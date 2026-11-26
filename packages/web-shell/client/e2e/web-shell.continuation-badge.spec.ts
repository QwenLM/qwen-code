import { expect, test, type Page } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

const workspaceCwd = '/tmp/continuation-primary';

// The workspace tree is the live-state-owned surface: its rows merge the
// live-state ticks (and the continuation watermark) through the catalog
// store. The cross-workspace Recent region re-reads raw pages on its own
// 10 s cadence and is asserted separately.
function treeBadge(page: Page) {
  return page
    .locator(`[data-sidebar-workspace="${workspaceCwd}"]`)
    .locator('[data-web-shell-session-continuation]');
}

function recentBadge(page: Page) {
  return page
    .getByTestId('recent-sessions')
    .locator('[data-web-shell-session-continuation]');
}

function scenarioSessions() {
  return [
    {
      sessionId: 'current-chat',
      workspaceCwd,
      displayName: 'current-chat',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:05:00.000Z',
      clientCount: 1,
      hasActivePrompt: false,
    },
    {
      sessionId: 'interrupted-chat',
      workspaceCwd,
      displayName: 'interrupted-chat',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      clientCount: 0,
      hasActivePrompt: false,
      needsContinuation: true,
    },
  ];
}

function scenarioCapabilities() {
  return {
    sessionLiveStatePollIntervalMs: 250,
    features: [
      'session_events',
      'session_source_metadata',
      'workspace_session_metadata',
      'workspace_session_live_state',
      'workspace_qualified_rest_core',
    ],
    workspaces: [
      { id: 'primary', cwd: workspaceCwd, primary: true, trusted: true },
    ],
  };
}

async function installLiveStateOverride(
  page: Page,
  state: {
    hasActivePrompt?: boolean;
    updatedAt?: string;
  },
) {
  await page.route(
    /\/workspaces\/[^/]+\/sessions\/live-state\/?$/,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          v: 1,
          catalogVersion: { generation: 'continuation-gen', revision: 1 },
          sessions: [
            {
              sessionId: 'interrupted-chat',
              clientCount: 1,
              hasActivePrompt: state.hasActivePrompt ?? false,
              isWaitingForPermission: false,
              isWaitingForUserQuestion: false,
              ...(state.updatedAt !== undefined
                ? { updatedAt: state.updatedAt }
                : {}),
            },
          ],
        }),
      });
    },
  );
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
});

test('sidebar marks a cold interrupted session and hides the badge while it runs', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    workspaceCwd,
    sessionId: 'current-chat',
    displayName: 'current-chat',
    sessions: scenarioSessions(),
    sessionCatalogVersion: { generation: 'continuation-gen', revision: 1 },
    capabilities: scenarioCapabilities(),
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: scenario.sessionId, replayedCount: 0 }),
  );

  // The cold interrupted session carries the visible continuation badge in
  // the workspace tree and in the Recent region.
  await expect(treeBadge(page)).toBeVisible();
  await expect(treeBadge(page)).toHaveText('Continue');
  await expect(treeBadge(page)).toHaveAttribute(
    'aria-label',
    'Continue execution needed',
  );
  await expect(recentBadge(page)).toBeVisible();

  // A live-state tick showing the prompt running hides the tree badge.
  await installLiveStateOverride(page, { hasActivePrompt: true });
  await expect(treeBadge(page)).toHaveCount(0);
  await expect(
    page
      .locator(`[data-sidebar-workspace="${workspaceCwd}"]`)
      .locator('[data-web-shell-session-running]'),
  ).toBeVisible();
});

test('a newer live terminal watermark clears the tree badge ahead of any catalog re-read', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    workspaceCwd,
    sessionId: 'current-chat',
    displayName: 'current-chat',
    sessions: scenarioSessions(),
    sessionCatalogVersion: { generation: 'continuation-gen', revision: 1 },
    capabilities: scenarioCapabilities(),
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: scenario.sessionId, replayedCount: 0 }),
  );
  await expect(treeBadge(page)).toBeVisible();

  // The continuation settled: the live watermark advances past the row's
  // persisted activity while the session is idle again. The raw catalog
  // fixture still carries the flag and the Recent region only re-reads every
  // 10 s, so clearing within 5 s proves the watermark path, not a re-read.
  await installLiveStateOverride(page, {
    hasActivePrompt: false,
    updatedAt: '2026-01-01T00:09:00.000Z',
  });
  await expect(treeBadge(page)).toHaveCount(0, { timeout: 5_000 });
});

test('the Recent region clears the badge on its raw catalog re-read', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    workspaceCwd,
    sessionId: 'current-chat',
    displayName: 'current-chat',
    sessions: scenarioSessions(),
    sessionCatalogVersion: { generation: 'continuation-gen', revision: 1 },
    capabilities: scenarioCapabilities(),
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: scenario.sessionId, replayedCount: 0 }),
  );
  await expect(recentBadge(page)).toBeVisible();

  // The server stops reporting the flag (the continuation settled and the
  // ledger's last terminal is now completed). The Recent region re-reads raw
  // pages on its 10 s cadence and drops the badge without a page reload.
  await page.route(/\/workspaces?\/[^/]+\/sessions(?:\?|$)/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessions: scenarioSessions().map(
          ({ needsContinuation: _flag, ...session }) => session,
        ),
      }),
    });
  });
  await expect(recentBadge(page)).toHaveCount(0, { timeout: 15_000 });
});
