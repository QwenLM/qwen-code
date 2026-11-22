import { devices, expect, test } from '@playwright/test';
import {
  createSessionListDensityScenario,
  LONG_SESSION_TITLE,
} from './utils/sessionListDensityFixture';
import {
  gotoSession,
  installScenario,
  resolveBaseURL,
} from './visuals/harness';

test.describe('Chromium CDP drawer gestures', () => {
  test.skip(
    ({ browserName }) => browserName === 'webkit',
    'These gestures require Chromium CDP.',
  );

  test('Drawer menus scope Escape and allow native touch scrolling @smoke', async ({
    browser,
  }, testInfo) => {
    const baseURL = resolveBaseURL(testInfo);
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      viewport: { width: 390, height: 280 },
      baseURL,
      reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage();
      const scenario = createSessionListDensityScenario();
      const daemon = await installScenario(page, scenario, baseURL);
      await gotoSession(page, scenario, daemon, 'dark');
      const toggle = page.getByRole('button', { name: 'Toggle menu' });
      await toggle.tap();
      const drawer = page.getByRole('dialog', { name: 'Workspace sidebar' });
      const sidebar = drawer.getByRole('complementary', {
        name: 'Workspace sidebar',
      });
      await expect(sidebar).toBeVisible();
      const row = sidebar
        .locator('[data-web-shell-session-title]')
        .filter({ hasText: LONG_SESSION_TITLE })
        .locator('..');
      const titleBox = await row
        .locator('[data-web-shell-session-title]')
        .boundingBox();
      if (!titleBox) throw new Error('The long session title is not laid out.');
      expect(titleBox.width).toBeGreaterThan(110);
      const prLink = row.locator('a[href]');
      await prLink.evaluate((link) => {
        link.addEventListener('click', (event) => event.preventDefault());
      });
      await prLink.dblclick();
      await expect(
        sidebar.getByRole('textbox', { name: /^Rename:/ }),
      ).toHaveCount(0);
      await row
        .getByRole('button', { name: 'More actions', exact: true })
        .tap();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await menu.press('Escape');
      await expect(menu).toHaveCount(0);
      const drawerStayedOpen = await drawer.isVisible();
      const more = row.getByRole('button', {
        name: 'More actions',
        exact: true,
      });
      await expect(more).toBeFocused();
      await expect(sidebar).toBeVisible();
      await expect(more).toHaveCSS('opacity', '1');
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      await more.tap();
      await expect(menu).toBeVisible();
      await menu.getByRole('menuitem', { name: 'Group', exact: true }).tap();
      const groupMenu = page.getByRole('menu');
      const groupItem = groupMenu.getByRole('menuitemradio').first();
      await expect(groupItem).toBeVisible();
      await expect(
        page.locator('[data-slot="dropdown-menu-content"]'),
      ).toHaveCount(0);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(groupItem).toBeFocused();
      await groupItem.press('Escape');
      await expect(groupMenu).toHaveCount(0);
      await expect(drawer).toBeVisible();
      await expect(more).toBeFocused();
      await more.tap();
      await expect(menu).toBeVisible();
      await expect(
        sidebar.getByRole('textbox', { name: /^Rename:/ }),
      ).toHaveCount(0);
      const bounds = await menu.boundingBox();
      if (!bounds) throw new Error('The drawer menu is not laid out.');
      const overflow = await menu.evaluate(
        (element) => element.scrollHeight - element.clientHeight,
      );
      expect(overflow, 'The fixture must force menu overflow').toBeGreaterThan(
        0,
      );
      const client = await context.newCDPSession(page);
      const x = bounds.x + bounds.width / 2;
      const startY = bounds.y + bounds.height * 0.8;
      const endY = bounds.y + bounds.height * 0.2;
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y: startY }],
      });
      for (let step = 1; step <= 4; step++) {
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: startY + ((endY - startY) * step) / 4 }],
        });
        await page.waitForTimeout(40);
      }
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      const scrollTopAfterGesture = await menu.evaluate(
        (element) => element.scrollTop,
      );
      await testInfo.attach('drawer-menu-interaction', {
        body: JSON.stringify({
          drawerStayedOpen,
          overflow,
          scrollTopAfterGesture,
        }),
        contentType: 'application/json',
      });
      expect(
        drawerStayedOpen,
        'Escape must leave the drawer open after closing its menu',
      ).toBe(true);
      expect(
        scrollTopAfterGesture,
        'A menu swipe must scroll the menu',
      ).toBeGreaterThan(0);
      await menu.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(drawer).toBeVisible();
      await more.tap();
      await expect(menu).toBeVisible();
      await menu.dblclick({ position: { x: 4, y: 4 } });
      await expect(
        sidebar.getByRole('textbox', { name: /^Rename:/ }),
      ).toHaveCount(0);
      await menu.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(drawer).toBeVisible();
      await expect(more).toBeFocused();
      await more.press('Escape');
      await expect(drawer).toHaveCount(0);
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    } finally {
      await context.close();
    }
  });
});

test('A touch embedded host sizes dense rows by its own width @smoke', async ({
  browser,
}, testInfo) => {
  const baseURL = resolveBaseURL(testInfo);
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    viewport: { width: 1000, height: 700 },
    baseURL,
    reducedMotion: 'reduce',
  });
  try {
    const page = await context.newPage();
    const scenario = createSessionListDensityScenario();
    scenario.capabilities.features.push('workspace_qualified_rest_core');
    scenario.sessions.push({
      sessionId: 'embedded-density',
      workspaceCwd: scenario.workspaceCwd,
      createdAt: '2026-07-03T00:00:00.000Z',
      updatedAt: '2026-07-03T00:00:00.000Z',
      displayName: 'Embedded narrow row with PR and goal metadata',
      clientCount: 0,
      hasActivePrompt: false,
      prs: [
        {
          number: 9517,
          state: 'merged',
          url: 'https://github.com/o/r/pull/9517',
        },
        {
          number: 52484,
          state: 'closed',
          url: 'https://github.com/o/r/pull/52484',
        },
      ],
      goal: {
        status: 'active',
        objective: 'Verify a narrow embedded host',
        updatedAt: '2026-07-03T00:00:00.000Z',
      },
      branch: { name: 'feature/density', baseBranch: 'main' },
    });
    await installScenario(page, scenario, baseURL);
    await page.goto('/e2e/navigation-rail-harness.html?narrow');
    await page.getByTestId('host-shell').evaluate((host) => {
      host.style.width = '200px';
    });
    await page.getByRole('button', { name: 'Toggle menu' }).tap();
    const sidebar = page.getByRole('complementary', {
      name: 'Workspace sidebar',
    });
    await expect(sidebar).toHaveAttribute('data-narrow', '');
    const row = sidebar
      .getByTestId('recent-sessions')
      .locator('[data-web-shell-session-title]')
      .filter({ hasText: 'Embedded narrow row with PR and goal metadata' })
      .locator('..');
    await expect(row.getByRole('link', { name: /Pull Request/ })).toBeVisible();
    await expect(row.getByTestId('session-goal-marker')).toBeVisible();
    await expect(row.locator('[class*="sessionGitIcon"]')).toBeHidden();
    const more = row.getByRole('button', { name: 'More actions', exact: true });
    const [rowBox, moreBox, sidebarBox] = await Promise.all([
      row.boundingBox(),
      more.boundingBox(),
      sidebar.boundingBox(),
    ]);
    if (!rowBox || !moreBox || !sidebarBox)
      throw new Error('The embedded Recent row is not laid out.');
    await testInfo.attach('embedded-layout', {
      body: JSON.stringify({ rowBox, moreBox, sidebarBox }),
      contentType: 'application/json',
    });
    expect(moreBox.x + moreBox.width).toBeLessThanOrEqual(
      rowBox.x + rowBox.width + 0.5,
    );
    expect(moreBox.x + moreBox.width).toBeLessThanOrEqual(
      sidebarBox.x + sidebarBox.width + 0.5,
    );
    await more.tap();
    await expect(
      page.getByRole('menuitem', { name: 'Pin', exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test('Recent touch rows keep actions reachable and preserve pointer focus @smoke', async ({
  browser,
}, testInfo) => {
  const baseURL = resolveBaseURL(testInfo);
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    viewport: { width: 240, height: 700 },
    baseURL,
    reducedMotion: 'reduce',
  });
  try {
    const page = await context.newPage();
    const scenario = createSessionListDensityScenario();
    scenario.capabilities.features.push('workspace_qualified_rest_core');
    scenario.sessions.push({
      sessionId: 'recent-density',
      workspaceCwd: scenario.workspaceCwd,
      createdAt: '2026-07-03T00:00:00.000Z',
      updatedAt: '2026-07-03T00:00:00.000Z',
      displayName: 'Recent narrow row with PR and goal metadata',
      clientCount: 0,
      hasActivePrompt: false,
      prs: [
        {
          number: 9517,
          state: 'merged',
          url: 'https://github.com/o/r/pull/9517',
        },
        {
          number: 52484,
          state: 'closed',
          url: 'https://github.com/o/r/pull/52484',
        },
      ],
      goal: {
        status: 'active',
        objective: 'Verify small drawer interactions',
        updatedAt: '2026-07-03T00:00:00.000Z',
      },
      branch: { name: 'feature/density', baseBranch: 'main' },
    });
    scenario.sessions.push({
      ...scenario.sessions.at(-1)!,
      sessionId: 'recent-running-density',
      displayName: 'Recent running row with PR and goal metadata',
      hasActivePrompt: true,
    });
    const daemon = await installScenario(page, scenario, baseURL);
    await gotoSession(page, scenario, daemon, 'dark');
    await page.getByRole('button', { name: 'Toggle menu' }).tap();
    const sidebar = page.getByRole('complementary', {
      name: 'Workspace sidebar',
    });
    await expect(sidebar).toBeVisible();
    const recent = sidebar.getByTestId('recent-sessions');
    await expect(recent).toBeVisible();
    const row = recent
      .locator('[data-web-shell-session-title]')
      .filter({ hasText: 'Recent narrow row with PR and goal metadata' })
      .locator('..');
    await expect(row).toHaveCount(1);
    const more = row.getByRole('button', {
      name: 'More actions',
      exact: true,
    });
    await expect(more).toBeVisible();
    await expect(
      row.getByRole('button', { name: 'Pin', exact: true }),
    ).toHaveCount(0);
    await expect(
      row.getByRole('button', { name: 'Archive', exact: true }),
    ).toHaveCount(0);
    await expect(row.locator('[class*="sessionMetaSlot"]')).toHaveAttribute(
      'style',
      /--session-actions-width:\s*26px/,
    );
    await expect(row.locator('[class*="sessionActions"]')).toHaveCSS(
      'opacity',
      '1',
    );
    await expect(row.locator('[class*="sessionActions"]')).toHaveCSS(
      'pointer-events',
      'auto',
    );
    await expect(row.locator('[class*="sessionGitIcon"]')).toBeHidden();
    await expect(row.getByRole('link', { name: /Pull Request/ })).toBeVisible();
    await expect(row.getByTestId('session-goal-marker')).toBeVisible();
    const [buttonBox, sidebarBox] = await Promise.all([
      more.boundingBox(),
      sidebar.boundingBox(),
    ]);
    if (!buttonBox || !sidebarBox)
      throw new Error('Recent row is not visible.');
    const rowBox = await row.boundingBox();
    if (!rowBox) throw new Error('Recent row is not visible.');
    await testInfo.attach('narrow-recent-geometry', {
      body: JSON.stringify({ buttonBox, rowBox, sidebarBox }, null, 2),
      contentType: 'application/json',
    });
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(
      rowBox.x + rowBox.width + 0.5,
    );
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(
      sidebarBox.x + sidebarBox.width + 0.5,
    );
    const runningRow = recent
      .locator('[data-web-shell-session-title]')
      .filter({ hasText: 'Recent running row with PR and goal metadata' })
      .locator('..');
    const runningGoal = runningRow.getByTestId('session-goal-marker');
    const runningSpinner = runningRow.locator('[class*="sessionLoading"]');
    await expect(runningSpinner).toBeVisible();
    const [runningRowBox, runningGoalBox, runningMore, runningSpinnerBox] =
      await Promise.all([
        runningRow.boundingBox(),
        runningGoal.boundingBox(),
        runningRow
          .getByRole('button', { name: 'More actions', exact: true })
          .boundingBox(),
        runningSpinner.boundingBox(),
      ]);
    if (!runningRowBox || !runningGoalBox || !runningMore || !runningSpinnerBox)
      throw new Error('The running Recent row is not laid out.');
    expect(runningMore.x + runningMore.width).toBeLessThanOrEqual(
      runningRowBox.x + runningRowBox.width + 0.5,
    );
    await testInfo.attach('narrow-running-recent-geometry', {
      body: JSON.stringify({
        runningRowBox,
        runningGoalBox,
        runningMore,
        runningSpinnerBox,
      }),
      contentType: 'application/json',
    });
    expect(runningSpinnerBox.x).toBeGreaterThanOrEqual(
      runningGoalBox.x + runningGoalBox.width - 0.5,
    );
    await runningGoal.click({ trial: true });
    await more.tap();
    const menu = page.getByRole('menu');
    await expect(
      menu.getByRole('menuitem', { name: 'Pin', exact: true }),
    ).toBeVisible();
    await expect(
      menu.getByRole('menuitem', { name: 'Archive', exact: true }),
    ).toBeEnabled();
    await menu.press('Escape');
    await expect(menu).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 700 });
    await expect(
      page.getByRole('dialog', { name: 'Workspace sidebar' }),
    ).toHaveCount(0);
    const expandedSidebar = page.getByRole('complementary', {
      name: 'Workspace sidebar',
    });
    const expandedMore = expandedSidebar
      .getByTestId('recent-sessions')
      .locator('[data-web-shell-session-title]')
      .filter({ hasText: 'Recent narrow row with PR and goal metadata' })
      .locator('..')
      .getByRole('button', { name: 'More actions', exact: true });
    const baselinePointerEvents = await page.evaluate(
      () => document.body.style.pointerEvents,
    );
    await expandedMore.tap();
    await expect(menu).toBeVisible();
    const outsideMenu = { x: 1000, y: 400 };
    await testInfo.attach('recent-menu-outside-hit', {
      body: JSON.stringify(
        await page.evaluate(({ x, y }) => {
          const target = document.elementFromPoint(x, y);
          return {
            tag: target?.tagName,
            role: target?.getAttribute('role'),
            bodyPointerEvents: document.body.style.pointerEvents,
          };
        }, outsideMenu),
      ),
      contentType: 'application/json',
    });
    await page.mouse.click(outsideMenu.x, outsideMenu.y);
    await expect(menu).toHaveCount(0);
    await expect(expandedSidebar).toBeVisible();
    await expect(expandedMore).not.toBeFocused();
    await expect
      .poll(() => page.evaluate(() => document.body.style.pointerEvents))
      .toBe(baselinePointerEvents);
  } finally {
    await context.close();
  }
});
