import { expect, test, type Page } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

const PRIMARY = {
  id: 'ws-primary',
  cwd: '/e2e/primary',
  primary: true,
  trusted: true,
};
const SECONDARY = {
  id: 'ws-secondary',
  cwd: '/e2e/secondary',
  primary: false,
  trusted: true,
  displayName: 'Secondary Project',
};

function goalSnapshot(objective: string, setAt: number) {
  return {
    v: 2 as const,
    activity: 'idle' as const,
    goal: {
      goalId: `goal-${objective.replace(/\s+/g, '-')}`,
      revision: 1,
      objective,
      status: 'active' as const,
      evidenceCursor: { recordId: null },
      turnCount: 0,
      activeTimeMs: 0,
      createdAt: setAt,
      updatedAt: setAt,
    },
  };
}

type ScenarioOverrides = Parameters<typeof createWebShellDaemonScenario>[0];

async function openGoals(
  page: Page,
  baseURL: string,
  overrides: ScenarioOverrides,
) {
  const daemon = await installMockDaemon(
    page,
    createWebShellDaemonScenario(overrides),
    { baseURL },
  );
  await page.goto('/?language=en-US&instanceId=host&instanceType=dsw');
  await page.getByRole('button', { name: 'Goals', exact: true }).click();
  await expect(page.getByTestId('goals-page')).toBeVisible();
  return daemon;
}

const multiWorkspaceOverrides: ScenarioOverrides = {
  capabilities: { workspaces: [PRIMARY, SECONDARY] },
  goalSnapshot: goalSnapshot('primary goal', 1_000),
  goalsByWorkspace: {
    'ws-secondary': {
      sessionId: 'sess-secondary',
      displayName: 'secondary session',
      snapshot: goalSnapshot('secondary goal', 2_000),
    },
  },
};

test('aggregates goals from every workspace and badges each card', async ({
  page,
  baseURL,
}) => {
  const daemon = await openGoals(page, baseURL!, multiWorkspaceOverrides);

  await expect(page.getByText('primary goal')).toBeVisible();
  await expect(page.getByText('secondary goal')).toBeVisible();
  const badges = page.getByTestId('goal-workspace');
  await expect(badges).toHaveCount(2);
  // Newest first: the secondary goal (setAt 2000) sorts before the primary.
  await expect(badges.nth(0)).toContainText('Secondary Project');
  await expect(badges.nth(1)).toContainText('primary');

  const paths = daemon.requests.map((r) => `${r.method} ${r.path}`);
  expect(paths).toContain('GET /goals');
  expect(paths).toContain('GET /workspaces/ws-secondary/goals');
});

test('the create form targets the picked workspace', async ({
  page,
  baseURL,
}) => {
  const daemon = await openGoals(page, baseURL!, multiWorkspaceOverrides);

  await page.getByRole('button', { name: 'New goal' }).click();
  const picker = page.locator('select');
  await expect(picker).toBeVisible();
  await expect(picker.locator('option')).toHaveCount(2);
  await picker.selectOption('/e2e/secondary');
  await page.locator('textarea').fill('ship the secondary goal');
  await page.getByRole('button', { name: 'Set goal' }).click();

  await expect
    .poll(() =>
      daemon.requests.some(
        (r) =>
          r.method === 'POST' &&
          r.path === '/session' &&
          (r.body as { cwd?: string } | null)?.cwd === '/e2e/secondary',
      ),
    )
    .toBe(true);
});

test('pausing a secondary goal uses its own session route', async ({
  page,
  baseURL,
}) => {
  const daemon = await openGoals(page, baseURL!, multiWorkspaceOverrides);

  const secondaryCard = page
    .locator('[role="listitem"]')
    .filter({ hasText: 'secondary goal' });
  await secondaryCard.getByRole('button', { name: 'Pause goal' }).click();

  await expect
    .poll(() =>
      daemon.requests.some(
        (r) =>
          r.method === 'POST' &&
          r.path === '/session/sess-secondary/goal' &&
          (r.body as { action?: string } | null)?.action === 'pause',
      ),
    )
    .toBe(true);

  // The control must flip the SECONDARY card, not the primary's: the mock
  // resolves the target snapshot by session id like the real owner route.
  await expect(
    secondaryCard.getByText('Paused', { exact: true }),
  ).toBeVisible();
  const primaryCard = page
    .locator('[role="listitem"]')
    .filter({ hasText: 'primary goal' });
  await expect(
    primaryCard.getByText('In progress', { exact: true }),
  ).toBeVisible();
});

test('one workspace failing keeps the others listed', async ({
  page,
  baseURL,
}) => {
  // Install the mock first, then the failure override: Playwright runs the
  // most recently registered matching route, so a pre-installed override
  // would be shadowed by the mock's catch-all.
  await installMockDaemon(
    page,
    createWebShellDaemonScenario(multiWorkspaceOverrides),
    { baseURL: baseURL! },
  );
  await page.route('**/workspaces/ws-secondary/goals', async (route) => {
    await route.fulfill({
      status: 500,
      json: { error: 'secondary listing exploded' },
    });
  });
  await page.goto('/?language=en-US&instanceId=host&instanceType=dsw');
  await page.getByRole('button', { name: 'Goals', exact: true }).click();
  await expect(page.getByTestId('goals-page')).toBeVisible();

  await expect(page.getByText('primary goal')).toBeVisible();
  await expect(page.getByText('secondary listing exploded')).toBeVisible();
});

test('an untrusted secondary is neither listed nor requested', async ({
  page,
  baseURL,
}) => {
  const daemon = await openGoals(page, baseURL!, {
    ...multiWorkspaceOverrides,
    capabilities: {
      workspaces: [PRIMARY, { ...SECONDARY, trusted: false }],
    },
  });

  await expect(page.getByText('primary goal')).toBeVisible();
  expect(
    daemon.requests.filter((r) => r.path.includes('/workspaces/ws-secondary')),
  ).toHaveLength(0);
  // The page never asks, but the route itself must still reject a direct
  // read of an untrusted workspace even when the fixture gave it goals.
  const status = await page.evaluate(() =>
    fetch('/workspaces/ws-secondary/goals').then((r) => r.status),
  );
  expect(status).toBe(403);
});

test('an advertised workspace with no goals lists empty, not an error', async ({
  page,
  baseURL,
}) => {
  // Registration, not goals-map membership, is the route's gate: a project
  // with no active goals is the natural empty case, not a load failure.
  await openGoals(page, baseURL!, {
    capabilities: { workspaces: [PRIMARY, SECONDARY] },
    goalSnapshot: goalSnapshot('primary goal', 1_000),
  });

  await expect(page.getByText('primary goal')).toBeVisible();
  await expect(page.getByText('Workspace mismatch')).toHaveCount(0);
  await expect(page.getByTestId('goals-skipped')).toHaveCount(0);
});

test('a single workspace keeps the plain primary-only view', async ({
  page,
  baseURL,
}) => {
  // A genuine one-workspace daemon advertises exactly one entry — the
  // zero-workspace fallback is a different arm and must not stand in for it.
  const daemon = await openGoals(page, baseURL!, {
    capabilities: { workspaces: [PRIMARY] },
    goalSnapshot: goalSnapshot('primary goal', 1_000),
  });

  await expect(page.getByText('primary goal')).toBeVisible();
  await expect(page.getByTestId('goal-workspace')).toHaveCount(0);
  await page.getByRole('button', { name: 'New goal' }).click();
  await expect(page.locator('select')).toHaveCount(0);
  // Only the unqualified goals route — other /workspaces/<cwd>/* overview
  // requests (hooks, git) are unrelated to the Goals page.
  expect(
    daemon.requests.filter(
      (r) => r.path.startsWith('/workspaces/') && r.path.endsWith('/goals'),
    ),
  ).toHaveLength(0);
});
