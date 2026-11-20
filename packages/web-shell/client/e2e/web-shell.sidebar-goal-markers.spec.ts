import { expect, test, type Page } from '@playwright/test';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
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

async function openSidebar(
  page: Page,
  baseURL: string,
  scenario = createWebShellDaemonScenario({ sessions: goalSessions }),
) {
  await installMockDaemon(page, scenario, { baseURL });
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
  return scenario;
}

const row = (page: Page, name: string) =>
  page.locator('[class*="sessionRow"]').filter({ hasText: name });

// Both transition cases need this exact wiring. workspace_session_live_state
// is the switch: without it the client never refetches the catalog and both
// cases stop exercising the notification path. The repaint case then fails as
// a bare locator timeout with nothing naming the missing capability; the
// clearing case may still pass, because a slower catalog refresh can drop the
// marker inside its timeout. The interval only sets the cadence —
// resolveSessionLiveStatePollInterval rejects anything below 1_000 and falls
// back to 5_000, so the 250 this block used to advertise was silently ignored.
// File-local on purpose: the other specs inline different feature subsets.
const liveGoalScenario = () =>
  createWebShellDaemonScenario({
    sessions: goalSessions,
    capabilities: {
      sessionLiveStatePollIntervalMs: 1_000,
      features: [
        'session_events',
        'permission_vote',
        'session_permission_vote',
        'session_scope_override',
        'session_source_metadata',
        'session_btw_stream',
        'workspace_settings',
        'workspace_voice',
        'workspace_session_live_state',
      ],
    },
  });

// The child's journal hook persists the projection and bumps the catalog
// clock — the effect of the goal-changed notification. Mutate the scenario the
// mock routes read by reference; no manual refresh follows.
function applyHarnessGoal(
  scenario: ReturnType<typeof createWebShellDaemonScenario>,
  goal: DaemonSessionSummary['goal'],
) {
  const target = scenario.sessions.find(
    (item) => item.sessionId === 'web-shell-e2e-session',
  )!;
  target.goal = goal;
  scenario.sessionCatalogVersion = {
    ...scenario.sessionCatalogVersion,
    revision: scenario.sessionCatalogVersion.revision + 1,
  };
}

test('sidebar shows lifecycle-tinted goal markers from the catalog @smoke', async ({
  page,
  baseURL,
}) => {
  await openSidebar(page, baseURL!);

  // Pin the fixture rows and the marker count so a missing row or marker
  // cannot make the colour lookups below vacuously pass.
  for (const name of [
    'E2E Harness Session',
    'Paused Goal Session',
    'Complete Goal Session',
    'Plain Session',
  ]) {
    await expect(row(page, name)).toHaveCount(1);
  }
  await expect(page.getByTestId('session-goal-marker')).toHaveCount(2);

  const activeMarker = row(page, 'E2E Harness Session').getByTestId(
    'session-goal-marker',
  );
  await expect(activeMarker.locator('svg')).toHaveAttribute(
    'data-status',
    'running',
  );
  const pausedMarker = row(page, 'Paused Goal Session').getByTestId(
    'session-goal-marker',
  );
  await expect(pausedMarker.locator('svg')).toHaveAttribute(
    'data-status',
    'attention',
  );

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
  expect(pausedColor).not.toBeNull();
  expect(titleColor).not.toBeNull();
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

test('a goal-changed catalog bump repaints the marker without a reload @smoke', async ({
  page,
  baseURL,
}) => {
  // Live-state polling drives the catalog clock: a goal transition writes
  // the sidecar in the child and bumps the catalog version, and the
  // polling client must refetch and repaint the marker on its own.
  const scenario = liveGoalScenario();
  await openSidebar(page, baseURL!, scenario);

  const activeMarker = row(page, 'E2E Harness Session').getByTestId(
    'session-goal-marker',
  );
  await expect(activeMarker.locator('svg')).toHaveAttribute(
    'data-status',
    'running',
    { timeout: 30000 },
  );

  applyHarnessGoal(scenario, {
    status: 'paused',
    objective: 'keep the loop running',
    updatedAt: '2026-11-17T00:01:00.000Z',
  });

  await expect(activeMarker.locator('svg')).toHaveAttribute(
    'data-status',
    'attention',
    { timeout: 30000 },
  );
  await expect(activeMarker).toHaveAttribute(
    'aria-label',
    'Goal: Paused — keep the loop running',
  );
});

test('a goal-changed catalog bump removes the marker when the goal is cleared @smoke', async ({
  page,
  baseURL,
}) => {
  // Clearing is the transition a maintainer most wants witnessed: the child
  // deletes the sidecar and bumps the clock, and the polling client must drop
  // the marker on its own. Driven like the repaint case above — by-reference
  // mutation plus a revision bump — because a reload would assert the load
  // path instead of the notification path this covers.
  const scenario = liveGoalScenario();
  await openSidebar(page, baseURL!, scenario);

  const activeMarker = row(page, 'E2E Harness Session').getByTestId(
    'session-goal-marker',
  );
  await expect(activeMarker.locator('svg')).toHaveAttribute(
    'data-status',
    'running',
    { timeout: 30000 },
  );
  await expect(page.getByTestId('session-goal-marker')).toHaveCount(2);

  applyHarnessGoal(scenario, undefined);

  await expect(activeMarker).toHaveCount(0, { timeout: 30000 });
  // activeMarker is a descendant of an ancestor-filtered row locator, so a
  // count of 0 is also satisfied when the row itself unmounts. Pin the
  // survivors: the session must stay listed, and the other goal-bearing row
  // must keep its marker (2 before the clear, 1 after).
  await expect(row(page, 'E2E Harness Session')).toHaveCount(1);
  await expect(page.getByTestId('session-goal-marker')).toHaveCount(1);
});
