/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { devices, expect, test } from '@playwright/test';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { createWebShellDaemonScenario } from '../utils/mockDaemon';
import {
  captureScreenshot,
  gotoSession,
  installScenario,
  resolveBaseURL,
  type VisualTheme,
} from './harness';

const LONG_TITLE = '优化 iPhone 会话列表标题与拉取请求审阅流程';
const THEMES: readonly VisualTheme[] = ['dark', 'light'];

function createSessionListScenario() {
  const workspaceCwd = '/tmp/qwen-web-shell-mobile-sidebar';
  const sessions: DaemonSessionSummary[] = [
    {
      sessionId: 'density-long-title',
      workspaceCwd,
      createdAt: '2026-07-03T00:00:00.000Z',
      updatedAt: '2026-07-03T00:00:00.000Z',
      displayName: LONG_TITLE,
      clientCount: 1,
      hasActivePrompt: false,
      prs: [
        {
          number: 52484,
          state: 'open',
          url: 'https://github.com/QwenLM/qwen-code/pull/52484',
        },
      ],
    },
  ];
  const scenario = createWebShellDaemonScenario({
    workspaceCwd,
    sessionId: 'density-long-title',
    displayName: LONG_TITLE,
    sessions,
  });
  scenario.capabilities.features.push(
    'session_organization',
    'session_archive',
    'session_archive_idle_guard',
  );
  return scenario;
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

      expect(sidebarBox.width).toBeCloseTo(390 * 0.85, 1);
      // Preserve the visible PR state while keeping at least 120px for the title.
      expect(titleBox.width).toBeGreaterThan(120);
      await expect(
        row.getByRole('button', { name: 'Pin', exact: true }),
      ).toHaveCount(0);
      await expect(prBadge).toHaveCSS('margin-left', '2px');
      await expect(prBadge).toHaveCSS('padding-left', '2px');
      await expect(prBadge).toHaveCSS('padding-right', '2px');
      await expect(prBadge).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(
        prBadge.locator('svg.lucide-git-pull-request'),
      ).toBeVisible();
      await captureScreenshot(page, `iphone-session-list-${theme}`);

      await row
        .getByRole('button', { name: 'More actions', exact: true })
        .tap();
      const menu = page.getByRole('menu');
      await expect(
        menu.getByRole('menuitem', { name: 'Pin', exact: true }),
      ).toBeVisible();
      await captureScreenshot(page, `iphone-session-list-menu-${theme}`);
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
    await expect(
      row.getByRole('button', { name: 'Pin', exact: true }),
    ).toHaveCount(0);
    await expect(prBadge).toHaveCSS('margin-left', '2px');
    await expect(prBadge).toHaveCSS('padding-left', '2px');
    await expect(prBadge).toHaveCSS('padding-right', '2px');
    await expect(prBadge).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(prBadge.locator('svg.lucide-git-pull-request')).toBeVisible();
    const titleBox = await title.boundingBox();
    if (!titleBox)
      throw new Error('The desktop session title is not laid out.');
    expect(titleBox.width).toBeGreaterThan(120);
    await captureScreenshot(page, `desktop-session-list-${theme}`);

    await more.click();
    const menu = page.getByRole('menu');
    await expect(
      menu.getByRole('menuitem', { name: 'Pin', exact: true }),
    ).toBeVisible();
    await captureScreenshot(page, `desktop-session-list-menu-${theme}`);
  });
}
