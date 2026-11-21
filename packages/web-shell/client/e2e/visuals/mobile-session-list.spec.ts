/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { devices, expect, test } from '@playwright/test';
import {
  captureScreenshot,
  gotoSession,
  installScenario,
  resolveBaseURL,
  type VisualTheme,
} from './harness';
import {
  createSessionListDensityScenario,
  LONG_SESSION_TITLE,
} from '../utils/sessionListDensityFixture';

const LONG_TITLE = LONG_SESSION_TITLE;
const THEMES: readonly VisualTheme[] = ['dark', 'light'];
const IS_BASE_CAPTURE = process.env.WEB_SHELL_VISUALS_ARM === 'before';

function createSessionListScenario() {
  return createSessionListDensityScenario();
}

for (const theme of THEMES) {
  test(`iPhone session list prioritizes the title (${theme})`, async ({
    browser,
  }, testInfo) => {
    const baseURL = resolveBaseURL(testInfo);
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      viewport: { width: 390, height: 844 },
      baseURL,
      reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage();
      const scenario = createSessionListScenario();
      const daemon = await installScenario(page, scenario, baseURL);
      const organizationWrites: unknown[] = [];
      if (!IS_BASE_CAPTURE) {
        await page.route(
          /\/(?:workspaces\/[^/]+\/)?session\/density-long-title\/organization$/,
          async (route) => {
            organizationWrites.push(route.request().postDataJSON());
            const pinnedAt = '2026-07-03T00:00:00.000Z';
            scenario.sessions = scenario.sessions.map((session) =>
              session.sessionId === 'density-long-title'
                ? { ...session, isPinned: true, pinnedAt }
                : session,
            );
            scenario.sessionCatalogVersion = {
              ...scenario.sessionCatalogVersion,
              revision: scenario.sessionCatalogVersion.revision + 1,
            };
            await route.fulfill({
              json: {
                sessionId: 'density-long-title',
                isPinned: true,
                pinnedAt: '2026-07-03T00:00:00.000Z',
                groupId: null,
                color: null,
              },
            });
          },
        );
      }
      await gotoSession(page, scenario, daemon, theme);
      await page.getByRole('button', { name: 'Toggle menu' }).tap();
      const drawer = page.getByRole('dialog', { name: 'Workspace sidebar' });
      const sidebar = drawer.getByRole('complementary', {
        name: 'Workspace sidebar',
      });
      await expect(sidebar).toBeVisible();
      const title = sidebar
        .locator('[data-web-shell-session-title]')
        .filter({ hasText: LONG_TITLE });
      await expect(title).toHaveCount(1);
      const row = title.locator('..');
      const prBadge = row.getByRole('link', {
        name: 'Pull Request #52484',
        exact: true,
      });
      await expect(prBadge).toBeVisible();
      await expect(prBadge).toContainText('#52484');

      const titleBox = await title.boundingBox();
      const sidebarBox = await sidebar.boundingBox();
      if (!titleBox || !sidebarBox)
        throw new Error('The iPhone sidebar or session title is not laid out.');
      const metrics = {
        viewport: page.viewportSize(),
        sidebarWidth: sidebarBox.width,
        titleWidth: titleBox.width,
        pinButtons: await row
          .getByRole('button', { name: 'Pin', exact: true })
          .count(),
        prMarginLeft: await prBadge.evaluate(
          (element) => getComputedStyle(element).marginLeft,
        ),
        prPaddingLeft: await prBadge.evaluate(
          (element) => getComputedStyle(element).paddingLeft,
        ),
      };
      await testInfo.attach('iphone-session-list-metrics', {
        body: JSON.stringify(metrics, null, 2),
        contentType: 'application/json',
      });

      expect(sidebarBox.width).toBeCloseTo(
        IS_BASE_CAPTURE ? Math.min(Math.max(390 * 0.7, 276), 420) : 390 * 0.85,
        1,
      );
      if (!IS_BASE_CAPTURE) {
        // Leave room for DejaVu's wider PR-number metrics on the visual runner.
        expect(titleBox.width).toBeGreaterThan(110);
      }
      if (IS_BASE_CAPTURE) {
        await expect(
          row.getByRole('button', { name: 'Pin', exact: true }),
        ).toBeVisible();
      } else {
        await expect(
          row.getByRole('button', { name: 'Pin', exact: true }),
        ).toHaveCount(0);
        await expect(prBadge).toHaveCSS('margin-left', '2px');
        await expect(prBadge).toHaveCSS('padding-left', '2px');
        await expect(prBadge).toHaveCSS('padding-right', '2px');
        await expect(prBadge).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      }
      await captureScreenshot(page, `iphone-session-list-${theme}`);
      await expect(
        prBadge.locator('svg.lucide-git-pull-request'),
      ).toBeVisible();

      await row
        .getByRole('button', { name: 'More actions', exact: true })
        .tap();
      const menu = page.getByRole('menu');
      const pin = menu.getByRole('menuitem', { name: 'Pin', exact: true });
      if (IS_BASE_CAPTURE) await expect(pin).toHaveCount(0);
      else await expect(pin).toBeVisible();
      await captureScreenshot(page, `iphone-session-list-menu-${theme}`);
      if (!IS_BASE_CAPTURE) {
        await pin.tap();
        await expect.poll(() => organizationWrites.length).toBe(1);
        expect(organizationWrites[0]).toEqual({ isPinned: true });
        await expect(menu).toHaveCount(0);
        await row
          .getByRole('button', { name: 'More actions', exact: true })
          .tap();
        await expect(
          menu.getByRole('menuitem', { name: 'Unpin', exact: true }),
        ).toBeVisible();
      }
    } finally {
      await context.close();
    }
  });

  test(`Desktop session list uses the same density (${theme})`, async ({
    page,
  }, testInfo) => {
    const scenario = createSessionListScenario();
    const daemon = await installScenario(
      page,
      scenario,
      resolveBaseURL(testInfo),
    );
    await gotoSession(page, scenario, daemon, theme);
    const sidebar = page.getByRole('complementary', {
      name: 'Workspace sidebar',
    });
    const title = sidebar
      .locator('[data-web-shell-session-title]')
      .filter({ hasText: LONG_TITLE });
    await expect(title).toHaveCount(1);
    const row = title.locator('..');
    await row.hover();
    const prBadge = row.getByRole('link', {
      name: 'Pull Request #52484',
      exact: true,
    });
    const more = row.getByRole('button', { name: 'More actions', exact: true });
    await expect(prBadge).toBeVisible();
    await expect(prBadge).toContainText('#52484');
    await expect(more).toBeVisible();
    await expect(more).toHaveCSS('opacity', '1');
    if (IS_BASE_CAPTURE) {
      await expect(
        row.getByRole('button', { name: 'Pin', exact: true }),
      ).toBeVisible();
    } else {
      await expect(
        row.getByRole('button', { name: 'Pin', exact: true }),
      ).toHaveCount(0);
      await expect(prBadge).toHaveCSS('margin-left', '2px');
      await expect(prBadge).toHaveCSS('padding-left', '2px');
      await expect(prBadge).toHaveCSS('padding-right', '2px');
      await expect(prBadge).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const titleBox = await title.boundingBox();
      if (!titleBox)
        throw new Error('The desktop session title is not laid out.');
      expect(titleBox.width).toBeGreaterThan(120);
    }
    await captureScreenshot(page, `desktop-session-list-${theme}`);
    await expect(prBadge.locator('svg.lucide-git-pull-request')).toBeVisible();

    await more.click();
    const menu = page.getByRole('menu');
    const pin = menu.getByRole('menuitem', { name: 'Pin', exact: true });
    if (IS_BASE_CAPTURE) await expect(pin).toHaveCount(0);
    else await expect(pin).toBeVisible();
    await captureScreenshot(page, `desktop-session-list-menu-${theme}`);
  });
}
