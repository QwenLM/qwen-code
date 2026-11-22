import { devices, expect, test, type Locator } from '@playwright/test';
import {
  createSessionListDensityScenario,
  LONG_SESSION_TITLE,
} from './utils/sessionListDensityFixture';
import {
  gotoSession,
  installScenario,
  resolveBaseURL,
} from './visuals/harness';

async function closeMenuWithEscape(menu: Locator) {
  await expect
    .poll(
      () =>
        menu.evaluate((element) => element.contains(document.activeElement)),
      { message: 'Keyboard focus must enter the opened menu before Escape' },
    )
    .toBe(true);
  await menu.press('Escape');
}

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
      scenario.sessions.push({
        ...scenario.sessions.at(-1)!,
        sessionId: 'wide-coarse-continuation',
        displayName: 'Wide coarse continuation metadata',
        needsContinuation: true,
        goal: {
          status: 'active',
          objective: 'Verify metadata outside the narrow-host branch',
          updatedAt: '2026-07-03T00:00:00.000Z',
        },
      });
      const daemon = await installScenario(page, scenario, baseURL);
      await gotoSession(page, scenario, daemon, 'dark');
      const toggle = page.getByRole('button', { name: 'Toggle menu' });
      await toggle.tap();
      const drawer = page.getByRole('dialog', { name: 'Workspace sidebar' });
      const sidebar = drawer.getByRole('complementary', {
        name: 'Workspace sidebar',
      });
      await expect(sidebar).toBeVisible();
      await expect(sidebar).not.toHaveAttribute('data-narrow');
      const wideRow = sidebar
        .locator('[data-web-shell-session-title]')
        .filter({ hasText: 'Wide coarse continuation metadata' })
        .locator('..');
      await expect(
        wideRow.locator('[class*="sessionContinuation"]'),
      ).toBeVisible();
      await expect(wideRow).toHaveCSS('flex-wrap', 'nowrap');
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
    scenario.sessions.push({
      ...scenario.sessions.at(-1)!,
      sessionId: 'embedded-crowded-density',
      displayName: 'Embedded crowded row with PR and goal metadata',
      hasActivePrompt: true,
      isWaitingForUserQuestion: true,
    });
    scenario.sessions.push({
      ...scenario.sessions.at(-1)!,
      sessionId: 'embedded-continuation-density',
      displayName: 'Embedded continuation row with PR and goal metadata',
      hasActivePrompt: false,
      needsContinuation: true,
      isWaitingForUserQuestion: false,
      isWaitingForPermission: false,
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
    const menu = page.getByRole('menu');
    await closeMenuWithEscape(menu);
    await expect(menu).toHaveCount(0);
    const crowdedRow = sidebar
      .getByTestId('recent-sessions')
      .locator('[data-web-shell-session-title]')
      .filter({ hasText: 'Embedded crowded row with PR and goal metadata' })
      .locator('..');
    const attention = crowdedRow.locator('[class*="sessionAttention"]');
    const goal = crowdedRow.getByTestId('session-goal-marker');
    const crowdedMore = crowdedRow.getByRole('button', {
      name: 'More actions',
      exact: true,
    });
    await expect(attention).toBeVisible();
    await expect(crowdedRow.locator('[class*="sessionLoading"]')).toBeVisible();
    const [goalBox, attentionBox, crowdedMoreBox, crowdedRowBox] =
      await Promise.all([
        goal.boundingBox(),
        attention.boundingBox(),
        crowdedMore.boundingBox(),
        crowdedRow.boundingBox(),
      ]);
    if (!goalBox || !attentionBox || !crowdedMoreBox || !crowdedRowBox)
      throw new Error('The embedded crowded row is not laid out.');
    await testInfo.attach('embedded-crowded-layout', {
      body: JSON.stringify({ goalBox, attentionBox, crowdedMoreBox }),
      contentType: 'application/json',
    });
    expect(attentionBox.y).toBeGreaterThanOrEqual(
      goalBox.y + goalBox.height - 0.5,
    );
    expect(crowdedMoreBox.x + crowdedMoreBox.width).toBeLessThanOrEqual(
      crowdedRowBox.x + crowdedRowBox.width + 0.5,
    );
    await goal.click({ trial: true });
    await crowdedMore.tap();
    await expect(
      page.getByRole('menuitem', { name: 'Pin', exact: true }),
    ).toBeVisible();
    await closeMenuWithEscape(menu);
    await expect(menu).toHaveCount(0);
    const continuationRow = sidebar
      .getByTestId('recent-sessions')
      .locator('[data-web-shell-session-title]')
      .filter({
        hasText: 'Embedded continuation row with PR and goal metadata',
      })
      .locator('..');
    const continuation = continuationRow.locator(
      '[class*="sessionContinuation"]',
    );
    await expect(continuation).toBeVisible();
    await expect(continuation).toHaveCSS('opacity', '1');
    await expect(
      continuationRow.locator('[class*="sessionMetaSlotReserved"]'),
    ).toHaveCSS('display', 'contents');
    const continuationGoal = continuationRow.getByTestId('session-goal-marker');
    const continuationMore = continuationRow.getByRole('button', {
      name: 'More actions',
      exact: true,
    });
    const [rowBounds, goalBounds, continuationBounds, moreBounds] =
      await Promise.all([
        continuationRow.boundingBox(),
        continuationGoal.boundingBox(),
        continuation.boundingBox(),
        continuationMore.boundingBox(),
      ]);
    if (!rowBounds || !goalBounds || !continuationBounds || !moreBounds)
      throw new Error('The embedded continuation row is not laid out.');
    const actionBox = await continuationRow
      .locator('[class*="sessionActions"]')
      .boundingBox();
    if (!actionBox)
      throw new Error('The embedded action layer is not laid out.');
    await testInfo.attach('embedded-continuation-layout', {
      body: JSON.stringify({
        goalBounds,
        continuationBounds,
        moreBounds,
        actionBox,
      }),
      contentType: 'application/json',
    });
    expect(actionBox.height).toBeCloseTo(moreBounds.height, 1);
    expect(continuationBounds.y).toBeGreaterThanOrEqual(
      goalBounds.y + goalBounds.height - 0.5,
    );
    expect(moreBounds.x + moreBounds.width).toBeLessThanOrEqual(
      rowBounds.x + rowBounds.width + 0.5,
    );
    await continuationGoal.click({ trial: true });
    await continuationMore.tap();
    await expect(
      page.getByRole('menuitem', { name: 'Pin', exact: true }),
    ).toBeVisible();
    await closeMenuWithEscape(menu);
    await expect(menu).toHaveCount(0);
    await expect(continuationMore).toBeFocused();
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
    const statusRows = [
      {
        sessionId: 'recent-running-density',
        displayName: 'Recent running row with PR and goal metadata',
        statusClass: 'sessionLoading',
        state: { hasActivePrompt: true },
      },
      {
        sessionId: 'recent-crowded-density',
        displayName: 'Recent crowded row with PR and goal metadata',
        statusClass: 'sessionAttention',
        state: {
          hasActivePrompt: true,
          isWaitingForUserQuestion: true,
          isWaitingForPermission: false,
        },
      },
      {
        sessionId: 'recent-approval-density',
        displayName: 'Recent approval row with PR and goal metadata',
        statusClass: 'sessionAttention',
        state: {
          hasActivePrompt: true,
          isWaitingForUserQuestion: false,
          isWaitingForPermission: true,
        },
      },
      {
        sessionId: 'recent-continuation-density',
        displayName: 'Recent continuation row with PR and goal metadata',
        statusClass: 'sessionContinuation',
        state: {
          hasActivePrompt: false,
          needsContinuation: true,
          isWaitingForUserQuestion: false,
          isWaitingForPermission: false,
        },
      },
    ] as const;
    for (const metadata of statusRows) {
      scenario.sessions.push({
        ...scenario.sessions.at(-1)!,
        ...metadata.state,
        sessionId: metadata.sessionId,
        displayName: metadata.displayName,
      });
    }
    const daemon = await installScenario(page, scenario, baseURL);
    await gotoSession(page, scenario, daemon, 'dark');
    await page.getByRole('button', { name: 'Toggle menu' }).tap();
    const sidebar = page.getByRole('complementary', {
      name: 'Workspace sidebar',
    });
    await expect(sidebar).toBeVisible();
    const recent = sidebar.getByTestId('recent-sessions');
    await expect(recent).toBeVisible();
    await recent
      .getByRole('button', { name: 'Show 1 more', exact: true })
      .click();
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
    expect(
      runningSpinnerBox.x + runningSpinnerBox.width <= runningGoalBox.x + 0.5 ||
        runningGoalBox.x + runningGoalBox.width <= runningSpinnerBox.x + 0.5 ||
        runningSpinnerBox.y + runningSpinnerBox.height <=
          runningGoalBox.y + 0.5 ||
        runningGoalBox.y + runningGoalBox.height <= runningSpinnerBox.y + 0.5,
      'running and goal must not overlap in either dimension',
    ).toBe(true);
    await runningGoal.click({ trial: true });
    for (const metadata of statusRows) {
      const candidateRow = recent
        .locator('[data-web-shell-session-title]')
        .filter({ hasText: metadata.displayName })
        .locator('..');
      const pr = candidateRow.getByRole('link', { name: /Pull Request/ });
      const goal = candidateRow.getByTestId('session-goal-marker');
      const status = candidateRow.locator(`[class*="${metadata.statusClass}"]`);
      await expect(status).toBeVisible();
      const statuses = candidateRow.locator(
        '[class*="sessionAttention"], [class*="sessionContinuation"], [class*="sessionLoading"]',
      );
      await expect(statuses).toHaveCount(
        metadata.statusClass === 'sessionAttention' ? 2 : 1,
      );
      for (const marker of await statuses.all()) {
        await expect(marker).toBeVisible();
        await expect(marker).toHaveCSS('opacity', '1');
      }
      await expect(pr).toHaveText(/#52484 \+1/);
      await expect(pr).toHaveAttribute('aria-label', /2 total.*Closed/);
      await expect(pr).toHaveAttribute(
        'href',
        'https://github.com/o/r/pull/52484',
      );
      await expect(goal).toBeVisible();
      await expect(
        candidateRow.locator('[class*="sessionMetaSlotReserved"]'),
      ).toHaveCSS('display', 'contents');
      const candidateMore = candidateRow.getByRole('button', {
        name: 'More actions',
        exact: true,
      });
      await candidateRow.scrollIntoViewIfNeeded();
      const [rowBox, titleBox, prBox, goalBox, statusBox, moreBox] =
        await Promise.all([
          candidateRow.boundingBox(),
          candidateRow.locator('[data-web-shell-session-title]').boundingBox(),
          pr.boundingBox(),
          goal.boundingBox(),
          status.boundingBox(),
          candidateMore.boundingBox(),
        ]);
      if (!rowBox || !titleBox || !prBox || !goalBox || !statusBox || !moreBox)
        throw new Error(`${metadata.sessionId} is not laid out.`);
      const statusBoxes: NonNullable<typeof statusBox>[] = [];
      for (const marker of await statuses.all()) {
        const markerBox = await marker.boundingBox();
        if (!markerBox)
          throw new Error(`${metadata.sessionId} has an unlaid status marker.`);
        statusBoxes.push(markerBox);
      }
      await testInfo.attach(`crowded-${metadata.sessionId}`, {
        body: JSON.stringify({
          rowBox,
          titleBox,
          prBox,
          goalBox,
          statusBox,
          statusBoxes,
          moreBox,
        }),
        contentType: 'application/json',
      });
      const metadataBoxes = [titleBox, prBox, goalBox, ...statusBoxes] as const;
      for (const box of metadataBoxes) {
        expect(box.x).toBeGreaterThanOrEqual(rowBox.x - 0.5);
        expect(box.x + box.width).toBeLessThanOrEqual(
          rowBox.x + rowBox.width + 0.5,
        );
        expect(box.y).toBeGreaterThanOrEqual(rowBox.y - 0.5);
        expect(box.y + box.height).toBeLessThanOrEqual(
          rowBox.y + rowBox.height + 0.5,
        );
        const separated =
          box.x + box.width <= moreBox.x + 0.5 ||
          moreBox.x + moreBox.width <= box.x + 0.5 ||
          box.y + box.height <= moreBox.y + 0.5 ||
          moreBox.y + moreBox.height <= box.y + 0.5;
        expect(separated, `${metadata.sessionId} overlaps More`).toBe(true);
      }
      for (
        let firstIndex = 0;
        firstIndex < metadataBoxes.length;
        firstIndex++
      ) {
        const first = metadataBoxes[firstIndex]!;
        for (
          let secondIndex = firstIndex + 1;
          secondIndex < metadataBoxes.length;
          secondIndex++
        ) {
          const second = metadataBoxes[secondIndex]!;
          const separated =
            first.x + first.width <= second.x + 0.5 ||
            second.x + second.width <= first.x + 0.5 ||
            first.y + first.height <= second.y + 0.5 ||
            second.y + second.height <= first.y + 0.5;
          expect(
            separated,
            `${metadata.sessionId} overlaps metadata at ${firstIndex}:${secondIndex}`,
          ).toBe(true);
        }
      }
      const actionBox = await candidateRow
        .locator('[class*="sessionActions"]')
        .boundingBox();
      if (!actionBox) throw new Error('The action layer is not laid out.');
      expect(actionBox.height).toBeCloseTo(moreBox.height, 1);
      const point = {
        x: rowBox.x + rowBox.width - 4,
        y: statusBox.y + statusBox.height / 2,
      };
      expect(point.y).toBeGreaterThan(moreBox.y + moreBox.height);
      const hitBeforeTap = await page.evaluate(({ x, y }) => {
        const target = document.elementFromPoint(x, y);
        return {
          tag: target?.tagName,
          className: target?.getAttribute('class'),
          insideActions: Boolean(target?.closest('[class*="sessionActions"]')),
          insideMore: Boolean(
            target?.closest('button[aria-label="More actions"]'),
          ),
        };
      }, point);
      await testInfo.attach(`crowded-${metadata.sessionId}-hit-check`, {
        body: JSON.stringify({
          point,
          actionBox,
          moreBox,
          hitBeforeTap,
        }),
        contentType: 'application/json',
      });
      expect(hitBeforeTap.insideActions).toBe(false);
      expect(hitBeforeTap.insideMore).toBe(false);
      await page.mouse.click(point.x, point.y);

      await expect(
        page.getByRole('dialog', { name: 'Workspace sidebar' }),
      ).toHaveCount(0);
      expect(page.url()).toMatch(
        new RegExp(`/session/${metadata.sessionId}(?:[?#]|$)`),
      );
      await page.getByRole('button', { name: 'Toggle menu' }).tap();
      await expect(sidebar).toBeVisible();
      const showMore = recent.getByRole('button', {
        name: 'Show 1 more',
        exact: true,
      });
      if (await showMore.isVisible()) await showMore.tap();
      await goal.click({ trial: true });
      await pr.click({ trial: true });
      await candidateMore.tap();
      const menu = page.getByRole('menu');
      await expect(
        menu.getByRole('menuitem', { name: 'Pin', exact: true }),
      ).toBeVisible();
      await closeMenuWithEscape(menu);
      await expect(menu).toHaveCount(0);
      await expect(candidateMore).toBeFocused();
      const titlePoint = {
        x: titleBox.x + titleBox.width - 2,
        y: titleBox.y + titleBox.height / 2,
      };
      expect(titlePoint.x).toBeLessThan(moreBox.x);
      const titleHit = await page.evaluate(({ x, y }) => {
        const target = document.elementFromPoint(x, y);
        return {
          insideTitle: Boolean(
            target?.closest('[data-web-shell-session-title]'),
          ),
          insideActions: Boolean(target?.closest('[class*="sessionActions"]')),
          insideMore: Boolean(
            target?.closest('button[aria-label="More actions"]'),
          ),
        };
      }, titlePoint);
      await testInfo.attach(`crowded-${metadata.sessionId}-title-hit-check`, {
        body: JSON.stringify({ titlePoint, titleBox, moreBox, titleHit }),
        contentType: 'application/json',
      });
      expect(titleHit.insideTitle).toBe(true);
      expect(titleHit.insideActions).toBe(false);
      expect(titleHit.insideMore).toBe(false);
      await page.mouse.click(titlePoint.x, titlePoint.y);
      await expect(
        page.getByRole('dialog', { name: 'Workspace sidebar' }),
      ).toHaveCount(0);
      expect(page.url()).toMatch(
        new RegExp(`/session/${metadata.sessionId}(?:[?#]|$)`),
      );
      await page.getByRole('button', { name: 'Toggle menu' }).tap();
      await expect(sidebar).toBeVisible();
      if (await showMore.isVisible()) await showMore.tap();
    }
    await more.tap();
    const menu = page.getByRole('menu');
    await expect(
      menu.getByRole('menuitem', { name: 'Pin', exact: true }),
    ).toBeVisible();
    await expect(
      menu.getByRole('menuitem', { name: 'Archive', exact: true }),
    ).toBeEnabled();
    await closeMenuWithEscape(menu);
    const escapedMenuState = await page.evaluate(() => {
      const remaining = document.querySelector('[role="menu"]');
      return {
        id: remaining?.id,
        owner: remaining?.getAttribute('aria-labelledby'),
        text: remaining?.textContent,
        html: remaining?.outerHTML.slice(0, 1800),
        focused: document.activeElement?.outerHTML.slice(0, 600),
        menuCount: document.querySelectorAll('[role="menu"]').length,
      };
    });
    await expect(menu, JSON.stringify(escapedMenuState)).toHaveCount(0);
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
