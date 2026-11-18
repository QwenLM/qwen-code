import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

declare global {
  interface Window {
    __sessionSearchOldStarted?: boolean;
    __sessionSearchOldServed?: boolean;
    __releaseSessionSearchOld?: () => void;
  }
}

const cwd = '/tmp/qwen-web-shell-e2e';
const secondCwd = '/tmp/search-second';
const now = new Date().toISOString();
const output = '../../.qwen/e2e-tests/session-search-evidence';
const summary = (
  sessionId: string,
  displayName: string,
  workspaceCwd = cwd,
) => ({
  sessionId,
  displayName,
  workspaceCwd,
  createdAt: now,
  updatedAt: now,
  clientCount: 0,
  hasActivePrompt: false,
});

for (const theme of ['light', 'dark']) {
  test(`${theme}: modal, keyboard, focus, content search, empty state, narrow layout`, async ({
    page,
    baseURL,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await installMockDaemon(
      page,
      createWebShellDaemonScenario({
        sessions: [
          summary('alpha', 'Authentication architecture'),
          summary('beta', 'Build the onboarding flow'),
        ],
      }),
      { baseURL },
    );
    await page.route('**/sessions/search?*', async (route) => {
      const query = new URL(route.request().url()).searchParams.get('q');
      await route.fulfill({
        json: {
          results:
            query === 'indexing'
              ? [
                  {
                    session: summary(
                      'content-hit',
                      'Database performance review',
                    ),
                    snippet:
                      'The indexing pipeline batches updates every 500ms.',
                  },
                ]
              : [],
        },
      });
    });
    await page.goto(`/?theme=${theme}&language=en-US`, {
      waitUntil: 'domcontentloaded',
    });
    const trigger = page
      .getByRole('button', { name: 'Search sessions', exact: true })
      .first();
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Search sessions' });
    const input = dialog.getByRole('textbox', {
      name: 'Search sessions',
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(input).toBeFocused();
    await expect(dialog.getByRole('option')).toHaveCount(2);
    await page.screenshot({ path: `${output}/after-${theme}-recent.png` });
    await input.press('ArrowDown');
    await expect(dialog.getByRole('option').nth(1)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await input.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await input.fill('indexing');
    await expect(dialog.getByRole('option')).toHaveCount(1);
    await expect(
      dialog.getByText('The indexing pipeline batches updates every 500ms.'),
    ).toBeVisible();
    await page.screenshot({ path: `${output}/after-${theme}-content.png` });
    await input.fill('nothing-matches-here');
    await expect(dialog.getByRole('option')).toHaveCount(0);
    await expect(
      dialog.getByText('No sessions found', { exact: false }),
    ).toBeVisible();
    await page.screenshot({ path: `${output}/after-${theme}-empty.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${output}/after-${theme}-narrow.png` });
    await page.mouse.click(3, 3);
    await expect(dialog).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('workspace-qualified identity and standalone search navigate correctly', async ({
  page,
  baseURL,
}) => {
  const scenario = createWebShellDaemonScenario({
    capabilities: {
      features: [
        'session_events',
        'permission_vote',
        'session_permission_vote',
        'session_scope_override',
        'session_source_metadata',
        'workspace_qualified_rest_core',
        'standalone_sessions_v1',
      ],
      workspaces: [
        { id: 'primary', cwd, primary: true, trusted: true },
        { id: 'secondary', cwd: secondCwd, primary: false, trusted: true },
      ],
    },
    sessions: [
      summary('same-id', 'Primary shared session'),
      summary('same-id', 'Secondary shared session', secondCwd),
    ],
    standaloneSessions: [
      {
        ...summary(
          'standalone-chat',
          'Independent planning',
          '/tmp/standalone/standalone-chat',
        ),
        sourceType: 'standalone',
        context: { kind: 'standalone' },
      },
    ],
  });
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  await page.goto('/?language=en-US', { waitUntil: 'domcontentloaded' });
  const trigger = page
    .getByRole('button', { name: 'Search sessions', exact: true })
    .first();
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Search sessions' });
  await expect(dialog.getByText('Primary shared session')).toBeVisible();
  await expect(dialog.getByText('Secondary shared session')).toBeVisible();
  await expect(dialog.getByText('Independent planning')).toBeVisible();
  await dialog.getByRole('textbox').fill('Secondary');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await dialog.getByRole('textbox').press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(
      () =>
        daemon.requests.find(
          (request) =>
            request.path === '/session/same-id/load' &&
            request.method === 'POST',
        )?.body,
    )
    .toMatchObject({ cwd: secondCwd });
  await expect(page).toHaveURL(/session\/same-id/);
  await page.goto('/?language=en-US', { waitUntil: 'domcontentloaded' });
  await trigger.click();
  await dialog.getByRole('textbox').fill('Independent');
  await dialog.getByRole('option').click();
  await expect(page).toHaveURL(/session\/standalone-chat\?context=standalone/);
});

test('collapsed preview keeps the search dialog open and restores usable focus', async ({
  page,
  baseURL,
}) => {
  await installMockDaemon(page, createWebShellDaemonScenario(), { baseURL });
  await page.goto('/?language=en-US', { waitUntil: 'domcontentloaded' });
  const rail = page.locator('[data-web-shell-navigation-rail]');
  const home = rail.locator('[data-web-shell-home-trigger]');
  await rail.getByRole('button', { name: 'Collapse', exact: true }).click();
  await home.hover();
  const preview = page.locator('[data-web-shell-home-popover]');
  const trigger = preview.getByRole('button', {
    name: 'Search sessions',
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Search sessions' });
  const input = dialog.getByRole('textbox');
  await expect(input).toBeFocused();
  await input.fill('e2e');
  await page.mouse.move(1200, 700);
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await expect(input).toBeFocused();
  await input.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
    )
    .toMatch(/Search sessions|Home/);
  await page.reload();
  await expect(page.locator('[data-web-shell-home-column]')).toBeHidden();
});

test('pending and failed content requests keep local matches and discard stale results', async ({
  page,
  baseURL,
}) => {
  await installMockDaemon(
    page,
    createWebShellDaemonScenario({
      sessions: [
        summary('alpha', 'Authentication architecture'),
        summary('beta', 'Authentication flow'),
      ],
    }),
    { baseURL },
  );
  // A real fetch is cancelled with the query change, so its route.fulfill can
  // never deliver the old body. Answer content search in page code and ignore
  // the abort signal so the old response actually reaches the hook; that is
  // the only way its stale-result guards can be observed.
  await page.addInitScript(
    ({ staleSession }) => {
      const originalFetch = window.fetch.bind(window);
      const releases: Array<() => void> = [];
      window.__releaseSessionSearchOld = () => {
        for (const release of releases.splice(0)) release();
      };
      window.fetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (!url.pathname.endsWith('/sessions/search')) {
          return originalFetch(input, init);
        }
        const query = url.searchParams.get('q');
        if (query === 'old-query') {
          window.__sessionSearchOldStarted = true;
          await new Promise<void>((resolve) => releases.push(resolve));
          window.__sessionSearchOldServed = true;
          return new Response(
            JSON.stringify({
              results: [{ session: staleSession, snippet: 'old-query' }],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (query === 'Authentication') {
          return new Response(JSON.stringify({ error: 'Unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ results: [] }), {
          headers: { 'Content-Type': 'application/json' },
        });
      };
    },
    { staleSession: summary('stale-hit', 'Old stale match') },
  );
  await page.goto('/?language=en-US', { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('button', { name: 'Search sessions', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Search sessions' });
  const input = dialog.getByRole('textbox');
  await input.fill('old-query');
  await expect
    .poll(() => page.evaluate(() => window.__sessionSearchOldStarted === true))
    .toBe(true);
  await expect(dialog.getByRole('listbox')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await input.fill('Authentication');
  await expect(dialog.getByRole('option')).toHaveCount(2);
  await expect(dialog.getByRole('option').first()).toHaveText(
    /Authentication architecture/,
  );
  await expect(
    dialog.getByText('Some sessions could not be searched.'),
  ).toBeVisible();
  await page.evaluate(() => window.__releaseSessionSearchOld?.());
  await expect
    .poll(() => page.evaluate(() => window.__sessionSearchOldServed === true))
    .toBe(true);
  // ArrowDown re-renders the list only after the released response settled, so
  // a stale row that leaked into state has to surface here.
  await input.press('ArrowDown');
  await expect(dialog.getByRole('option').nth(1)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(dialog.getByRole('option')).toHaveCount(2);
  await expect(dialog.getByText('Old stale match')).toHaveCount(0);
  await expect(dialog.getByRole('listbox')).toHaveAttribute(
    'aria-busy',
    'false',
  );
});
