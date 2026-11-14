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

test('aggregates goals from every workspace and badges each card @smoke', async ({
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

test('the create form targets the picked workspace @smoke', async ({
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
  // The skipped workspace is accounted for in the UI, not silently absent.
  await expect(page.getByTestId('goals-skipped')).toBeVisible();
  // The page never asks; the mock mirrors the route's trust gate. The
  // route-level rejection itself is pinned in routes/goals.test.ts and
  // workspace-qualified-rest.test.ts — this fetch only exercises the double.
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

test('both surfaces agree on the primary goal even if the map carries a primary key', async ({
  page,
  baseURL,
}) => {
  // The mock must keep ONE primary snapshot: a goalsByWorkspace entry keyed
  // by the primary id is ignored, so the two listings can never disagree.
  await openGoals(page, baseURL!, {
    ...multiWorkspaceOverrides,
    goalsByWorkspace: {
      ...multiWorkspaceOverrides.goalsByWorkspace,
      'ws-primary': {
        sessionId: 'sess-primary-divergent',
        displayName: 'divergent copy',
        snapshot: goalSnapshot('divergent primary copy', 9_000),
      },
    },
  });

  await expect(page.getByText('primary goal')).toBeVisible();
  await expect(page.getByText('divergent primary copy')).toHaveCount(0);
  const qualified = await page.evaluate(() =>
    fetch('/workspaces/ws-primary/goals').then((r) => r.json()),
  );
  expect(
    qualified.goals.map((g: { condition: string }) => g.condition),
  ).toEqual(['primary goal']);

  // Pausing from the primary card flips the card the user is looking at.
  const primaryCard = page
    .locator('[role="listitem"]')
    .filter({ hasText: 'primary goal' });
  await primaryCard.getByRole('button', { name: 'Pause goal' }).click();
  await expect(primaryCard.getByText('Paused', { exact: true })).toBeVisible();
});

test('a retry after a failed creation targets the newly picked workspace', async ({
  page,
  baseURL,
}) => {
  // Fail the goal-control POST once so the first attempt strands a session
  // in the secondary workspace; switching the picker must allocate a fresh
  // session in the primary, not reuse the stranded one.
  const daemon = await installMockDaemon(
    page,
    createWebShellDaemonScenario(multiWorkspaceOverrides),
    { baseURL: baseURL! },
  );
  await page.route('**/session/*/goal', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 500,
        json: { error: 'injected goal failure' },
      });
    } else {
      await route.continue();
    }
  });
  await page.goto('/?language=en-US&instanceId=host&instanceType=dsw');
  await page.getByRole('button', { name: 'Goals', exact: true }).click();
  await expect(page.getByTestId('goals-page')).toBeVisible();

  await page.getByRole('button', { name: 'New goal' }).click();
  await page.locator('select').selectOption('/e2e/secondary');
  await page.locator('textarea').fill('stranded retry goal');
  await page.getByRole('button', { name: 'Set goal' }).click();
  await expect(page.getByText('injected goal failure')).toBeVisible();
  // The stranding must be real: the session allocation succeeded before the
  // goal control failed, so a retry has a stranded session to (not) reuse.
  expect(
    daemon.requests.some(
      (r) =>
        r.method === 'POST' &&
        r.path === '/session' &&
        (r.body as { cwd?: string } | null)?.cwd === '/e2e/secondary',
    ),
  ).toBe(true);

  await page.unroute('**/session/*/goal');
  await page.locator('select').selectOption('/e2e/primary');
  const requestsBeforeRetry = daemon.requests.length;
  await page.getByRole('button', { name: 'Set goal' }).click();

  // Scope to post-retry requests: an earlier page-load allocation must not
  // be able to satisfy this assertion.
  await expect
    .poll(() =>
      daemon.requests
        .slice(requestsBeforeRetry)
        .some(
          (r) =>
            r.method === 'POST' &&
            r.path === '/session' &&
            (r.body as { cwd?: string } | null)?.cwd === '/e2e/primary',
        ),
    )
    .toBe(true);
});

test('an unavailable picker target is refused without touching the session', async ({
  page,
  baseURL,
}) => {
  // Simulate a stale selection: the form keeps a cwd that the current
  // capability list no longer advertises as trusted. The App guard must
  // refuse BEFORE createNewSession, which would clear the current session.
  const daemon = await openGoals(page, baseURL!, multiWorkspaceOverrides);

  await page.getByRole('button', { name: 'New goal' }).click();
  await page.evaluate(() => {
    const select = document.querySelector('select')!;
    const option = document.createElement('option');
    option.value = '/e2e/gone';
    option.textContent = 'gone';
    select.appendChild(option);
  });
  await page.locator('select').selectOption('/e2e/gone');
  await page.locator('textarea').fill('goal into the void');
  const requestsBeforeSubmit = daemon.requests.length;
  await page.getByRole('button', { name: 'Set goal' }).click();

  await expect(
    page.getByText('The selected workspace is unavailable or untrusted.'),
  ).toBeVisible();
  expect(
    daemon.requests
      .slice(requestsBeforeSubmit)
      .filter((r) => r.method === 'POST' && r.path === '/session'),
  ).toHaveLength(0);
});
