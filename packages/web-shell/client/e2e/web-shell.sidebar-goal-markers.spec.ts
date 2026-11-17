import { expect, test, type Page } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

const WORKSPACE_CWD = '/tmp/qwen-web-shell-e2e';

function session(
  sessionId: string,
  displayName: string,
  goal?: { status: string; objective: string; updatedAt: string },
) {
  return {
    sessionId,
    workspaceCwd: WORKSPACE_CWD,
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:00:00.000Z',
    displayName,
    clientCount: 0,
    hasActivePrompt: false,
    ...(goal ? { goal } : {}),
  };
}

const goalSessions = [
  session('web-shell-e2e-session', 'E2E Harness Session', {
    status: 'active',
    objective: 'keep the loop running',
    updatedAt: '2026-11-17T00:00:00.000Z',
  }),
  session('paused-goal-session', 'Paused Goal Session', {
    status: 'paused',
    objective: 'wait for the user',
    updatedAt: '2026-11-17T00:00:00.000Z',
  }),
  session('complete-goal-session', 'Complete Goal Session', {
    status: 'complete',
    objective: 'already done',
    updatedAt: '2026-11-17T00:00:00.000Z',
  }),
  session('plain-session', 'Plain Session'),
];

async function openSidebar(page: Page, baseURL: string) {
  await installMockDaemon(
    page,
    createWebShellDaemonScenario({ sessions: goalSessions }),
    { baseURL },
  );
  await page.goto('/?language=en-US&instanceId=host&instanceType=dsw');
  // Expand the workspace section if it is collapsed.
  const workspaceButton = page
    .locator('button')
    .filter({ hasText: 'qwen-web-shell-e2e' })
    .first();
  await workspaceButton.waitFor({ timeout: 30000 });
  if ((await workspaceButton.getAttribute('aria-expanded')) !== 'true') {
    await workspaceButton.click();
  }
  await page
    .locator('[class*="sessionRow"]')
    .filter({ hasText: 'Paused Goal Session' })
    .waitFor({ timeout: 30000 });
}

const row = (page: Page, name: string) =>
  page.locator('[class*="sessionRow"]').filter({ hasText: name });

test('sidebar shows lifecycle-tinted goal markers from the catalog @smoke', async ({
  page,
  baseURL,
}) => {
  await openSidebar(page, baseURL!);

  const activeMarker = row(page, 'E2E Harness Session').getByTestId(
    'session-goal-marker',
  );
  await expect(activeMarker).toHaveAttribute('data-status', 'running');
  const pausedMarker = row(page, 'Paused Goal Session').getByTestId(
    'session-goal-marker',
  );
  await expect(pausedMarker).toHaveAttribute('data-status', 'attention');

  // The tones are actually painted and distinct from each other and from
  // the untinted session title.
  const [activeColor, pausedColor, titleColor] = await page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('[class*="sessionRow"]'),
    );
    const color = (rowText: string, sel: string) => {
      const r = rows.find((el) => el.textContent?.includes(rowText));
      const el = r?.querySelector<HTMLElement>(sel);
      return el ? getComputedStyle(el).color : null;
    };
    return [
      color('E2E Harness Session', '[data-testid="session-goal-marker"] svg'),
      color('Paused Goal Session', '[data-testid="session-goal-marker"] svg'),
      color('Plain Session', '[data-web-shell-session-title]'),
    ];
  });
  expect(activeColor).not.toBeNull();
  expect(activeColor).not.toBe(pausedColor);
  expect(activeColor).not.toBe(titleColor);
  expect(pausedColor).not.toBe(titleColor);

  // Completed goals and goal-less sessions render no marker.
  await expect(
    row(page, 'Complete Goal Session').getByTestId('session-goal-marker'),
  ).toHaveCount(0);
  await expect(
    row(page, 'Plain Session').getByTestId('session-goal-marker'),
  ).toHaveCount(0);

  // The marker carries the localized status and objective.
  await expect(pausedMarker).toHaveAttribute(
    'aria-label',
    'Goal: Paused — wait for the user',
  );
});

test('clicking a goal marker opens its session @smoke', async ({
  page,
  baseURL,
}) => {
  await openSidebar(page, baseURL!);

  await row(page, 'Paused Goal Session')
    .getByTestId('session-goal-marker')
    .click();

  await page.waitForURL('**/session/paused-goal-session**', {
    timeout: 30000,
  });
});
