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

test('opening a goal from the card header loads its session @smoke', async ({
  page,
  baseURL,
}) => {
  const daemon = await openGoals(page, baseURL!, multiWorkspaceOverrides);

  const secondaryCard = page
    .locator('[role="listitem"]')
    .filter({ hasText: 'secondary goal' });
  const pillColor = await secondaryCard
    .getByTestId('goal-status')
    .evaluate((el) => getComputedStyle(el).color);
  // Untinted anchor: the plain --foreground the strip status falls back to
  // when its [data-status] rule is gone. Without it, deleting BOTH the pill
  // and strip rules would keep the equality assertion green.
  const untintedFg = await secondaryCard
    .locator('[class*="cardTitle"]')
    .evaluate((el) => getComputedStyle(el).color);
  // The header action's colour cue must be painted: it reads the interactive
  // blue, distinct from the grey control icons beside it.
  const [headerColor, editColor] = await secondaryCard.evaluate((card) => {
    const header = card.querySelector(
      '[data-testid="goal-open-session"]',
    ) as HTMLElement;
    const edit = card.querySelector(
      'button[aria-label="Edit goal"]',
    ) as HTMLElement;
    return [getComputedStyle(header).color, getComputedStyle(edit).color];
  });
  expect(headerColor).not.toBe(editColor);
  expect(headerColor).not.toBe(untintedFg);
  await secondaryCard.getByTestId('goal-open-session').click();

  // The transcript IS the goal's history: the header action must land on the
  // owning session's route and leave the Goals page.
  await page.waitForURL('**/session/sess-secondary**');
  await expect(page.getByTestId('goals-page')).toHaveCount(0);

  // The session must load in the GOAL's workspace runtime, not the primary:
  // the load request carries the secondary cwd.
  const loadRequest = daemon.requests.find(
    (r) => r.method === 'POST' && r.path === '/session/sess-secondary/load',
  );
  expect((loadRequest?.body as { cwd?: string } | null)?.cwd).toBe(
    '/e2e/secondary',
  );

  // The strip's lifecycle tint must actually be painted and read the same
  // state as the card it came from: deleting the strip's [data-status]
  // colour rule falls back to plain foreground and goes red here.
  const strip = page.getByTestId('goal-status-strip');
  await expect(strip).toBeVisible();
  // Identify which goal the strip shows — the route alone could be satisfied
  // by an unrelated session's strip.
  await expect(strip).toContainText('secondary goal');
  const [stripStatusColor, stripActivityColor] = await strip.evaluate(
    (root) => {
      const status = root.querySelector('[data-status]') as HTMLElement;
      const activity = root.querySelector('[class*="activity"]') as HTMLElement;
      return [getComputedStyle(status).color, getComputedStyle(activity).color];
    },
  );
  expect(stripStatusColor).toBe(pillColor);
  expect(stripStatusColor).not.toBe(stripActivityColor);
  expect(stripStatusColor).not.toBe(untintedFg);

  // The strip's Goals-page jump is navigation too: it must wear the same
  // interactive blue as the card's header jump, not the grey control class
  // its edit/pause/clear siblings use. Deleting the .goalsAction rule (or
  // the class wiring) falls back to grey and goes red here.
  const [stripGoalsColor, stripEditColor] = await strip.evaluate((root) => {
    const goals = root.querySelector(
      '[data-testid="goal-open-goals"]',
    ) as HTMLElement;
    const edit = root.querySelector(
      'button[aria-label="Edit goal"]',
    ) as HTMLElement;
    return [getComputedStyle(goals).color, getComputedStyle(edit).color];
  });
  expect(stripGoalsColor).toBe(headerColor);
  expect(stripGoalsColor).not.toBe(stripEditColor);
  expect(stripGoalsColor).not.toBe(untintedFg);
});

test('a stopped goal shows its lifecycle tone and budget progress @smoke', async ({
  page,
  baseURL,
}) => {
  const base = goalSnapshot('budgeted goal', 1_000);
  // Two workspaces → two cards, so the card-scoped reads below are exercised
  // against a real sibling, not a lone card.
  await openGoals(page, baseURL!, {
    capabilities: { workspaces: [PRIMARY, SECONDARY] },
    goalSnapshot: {
      ...base,
      goal: {
        ...base.goal,
        status: 'paused' as const,
        turnCount: 3,
        turnBudget: 20,
      },
    },
    goalsByWorkspace: {
      'ws-secondary': {
        sessionId: 'sess-sibling',
        displayName: 'sibling session',
        snapshot: goalSnapshot('sibling goal', 2_000),
      },
    },
  });

  // Scope every read to the identified goal card so the sibling card can
  // never satisfy the assertions by accident.
  const card = page
    .locator('[role="listitem"]')
    .filter({ hasText: 'budgeted goal' });
  await expect(page.locator('[role="listitem"]')).toHaveCount(2);
  await expect(card.getByTestId('goal-status')).toHaveAttribute(
    'data-status',
    'attention',
  );
  const turnsBar = card.getByTestId('goal-budget-turns');
  await expect(turnsBar).toHaveAttribute('aria-valuenow', '15');
  // Real-browser proof the fill actually renders at the ratio: aria alone
  // would stay green with an empty bar. The fill is 15% of its track.
  const widths = await turnsBar.evaluate((track) => {
    const fill = track.firstElementChild as HTMLElement;
    return {
      track: track.getBoundingClientRect().width,
      fill: fill.getBoundingClientRect().width,
    };
  });
  expect(widths.track).toBeGreaterThan(0);
  expect(Math.abs(widths.fill - widths.track * 0.15)).toBeLessThan(1);

  // The tint and the link cue must actually be painted: reverting the link
  // to the meta grey or deleting a [data-status] colour rule has to go red.
  // untintedFg is the card title's plain --foreground — the colour the pill
  // falls back to when its [data-status] rule is gone, so a tinted pill must
  // differ from it (an equality-only check would survive a double deletion).
  const [
    fillBg,
    trackBg,
    linkColor,
    metaColor,
    pillColor,
    pillBg,
    untintedFg,
    headerColor,
  ] = await card.evaluate((cardEl) => {
    const track = cardEl.querySelector(
      '[data-testid="goal-budget-turns"]',
    ) as HTMLElement;
    const fill = track.firstElementChild as HTMLElement;
    const link = cardEl.querySelector(
      '[data-testid="goal-session-link"]',
    ) as HTMLElement;
    const meta = cardEl.querySelector(
      '[data-testid="goal-activity"]',
    ) as HTMLElement;
    const pill = cardEl.querySelector(
      '[data-testid="goal-status"]',
    ) as HTMLElement;
    const title = cardEl.querySelector('[class*="cardTitle"]') as HTMLElement;
    const header = cardEl.querySelector(
      '[data-testid="goal-open-session"]',
    ) as HTMLElement;
    return [
      getComputedStyle(fill).backgroundColor,
      getComputedStyle(track).backgroundColor,
      getComputedStyle(link).color,
      getComputedStyle(meta).color,
      getComputedStyle(pill).color,
      getComputedStyle(pill).backgroundColor,
      getComputedStyle(title).color,
      getComputedStyle(header).color,
    ];
  });
  expect(fillBg).not.toBe(trackBg);
  expect(fillBg).not.toBe('rgba(0, 0, 0, 0)');
  expect(linkColor).not.toBe(metaColor);
  // Positive witness for the link's blue: it reads the same interactive
  // token as the header action, so deleting the blue (not just recolouring
  // to something else) goes red.
  expect(linkColor).toBe(headerColor);
  expect(linkColor).not.toBe(untintedFg);
  // The paused fill reads the PILL's attention token; deleting the pill's
  // attention rule makes them diverge. (The strip's attention rule is pinned
  // by the paused-goal navigation case below.) The pill background must also
  // differ from the plain muted track, and the pill colour from the untinted
  // foreground anchor.
  expect(fillBg).toBe(pillColor);
  expect(pillBg).not.toBe(trackBg);
  expect(pillColor).not.toBe(untintedFg);
});

test('a paused goal strip paints the attention tone @smoke', async ({
  page,
  baseURL,
}) => {
  // The running-tone case above never paints the strip in attention; this
  // one pins the strip's attention rule itself — deleting it falls back to
  // the plain foreground and goes red against both anchors.
  const base = goalSnapshot('paused strip goal', 1_000);
  await openGoals(page, baseURL!, {
    goalSnapshot: {
      ...base,
      goal: { ...base.goal, status: 'paused' as const },
    },
  });

  const card = page
    .locator('[role="listitem"]')
    .filter({ hasText: 'paused strip goal' });
  const pillColor = await card
    .getByTestId('goal-status')
    .evaluate((el) => getComputedStyle(el).color);
  const untintedFg = await card
    .locator('[class*="cardTitle"]')
    .evaluate((el) => getComputedStyle(el).color);
  await card.getByTestId('goal-session-link').click();
  await page.waitForURL('**/session/**', { timeout: 15000 });

  const strip = page.getByTestId('goal-status-strip');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('paused strip goal');
  await expect(strip.locator('[data-status]')).toHaveAttribute(
    'data-status',
    'attention',
  );
  const stripColor = await strip
    .locator('[data-status]')
    .evaluate((el) => getComputedStyle(el).color);
  expect(stripColor).toBe(pillColor);
  expect(stripColor).not.toBe(untintedFg);
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

  // The acceptance criterion is WHERE the goal landed, not just the
  // allocation body: the page must list it badged secondary, the secondary's
  // qualified listing must carry it, and the primary's must not.
  await page.getByRole('button', { name: 'Goals', exact: true }).click();
  await expect(page.getByTestId('goals-page')).toBeVisible();
  const createdCard = page
    .locator('[role="listitem"]')
    .filter({ hasText: 'ship the secondary goal' });
  await expect(createdCard).toBeVisible();
  await expect(createdCard.getByTestId('goal-workspace')).toContainText(
    'Secondary Project',
  );
  const secondaryListing = await page.evaluate(() =>
    fetch('/workspaces/ws-secondary/goals').then((r) => r.json()),
  );
  expect(
    secondaryListing.goals.map((g: { condition: string }) => g.condition),
  ).toContain('ship the secondary goal');
  const primaryListing = await page.evaluate(() =>
    fetch('/goals').then((r) => r.json()),
  );
  expect(
    primaryListing.goals.map((g: { condition: string }) => g.condition),
  ).not.toContain('ship the secondary goal');
});

test('pausing a secondary goal uses its own session route @smoke', async ({
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

test('one workspace failing keeps the others listed @smoke', async ({
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

test('an untrusted secondary is neither listed nor requested @smoke', async ({
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

test('an advertised workspace with no goals lists empty, not an error @smoke', async ({
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

test('a single workspace keeps the plain primary-only view @smoke', async ({
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

test('both surfaces agree on the primary goal even if the map carries a primary key @smoke', async ({
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

test('a retry after a failed creation targets the newly picked workspace @smoke', async ({
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

  // The retried goal must land in the PICKED workspace (primary), and the
  // stranded secondary session must stay goal-free — reuse would have put
  // the goal in the secondary instead.
  await page.getByRole('button', { name: 'Goals', exact: true }).click();
  await expect(page.getByTestId('goals-page')).toBeVisible();
  const retriedCard = page
    .locator('[role="listitem"]')
    .filter({ hasText: 'stranded retry goal' });
  await expect(retriedCard).toBeVisible();
  await expect(retriedCard.getByTestId('goal-workspace')).toContainText(
    'primary',
  );
  const secondaryListing = await page.evaluate(() =>
    fetch('/workspaces/ws-secondary/goals').then((r) => r.json()),
  );
  expect(
    secondaryListing.goals.map((g: { condition: string }) => g.condition),
  ).not.toContain('stranded retry goal');
});

test('a stale picker selection reconciles to the default workspace @smoke', async ({
  page,
  baseURL,
}) => {
  // Simulate a stale selection: the form keeps a cwd that the capability
  // list does not carry. The dialog must reconcile BOTH the control and the
  // submit to the default (primary) instead of sending the vanished cwd to
  // the App guard — the goal lands in the primary, no refusal toast.
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
  await page.getByRole('button', { name: 'Set goal' }).click();

  await expect
    .poll(() =>
      daemon.requests.some(
        (r) =>
          r.method === 'POST' &&
          r.path === '/session' &&
          (r.body as { cwd?: string } | null)?.cwd === '/e2e/primary',
      ),
    )
    .toBe(true);
  await expect(
    page.getByText('The selected workspace is unavailable or untrusted.'),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Goals', exact: true }).click();
  await expect(page.getByTestId('goals-page')).toBeVisible();
  const reconciledCard = page
    .locator('[role="listitem"]')
    .filter({ hasText: 'goal into the void' });
  await expect(reconciledCard).toBeVisible();
  await expect(reconciledCard.getByTestId('goal-workspace')).toContainText(
    'primary',
  );
});
