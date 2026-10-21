/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from '@playwright/test';
import { installMockDaemon } from './utils/mockDaemon';
import { createGitWorkspaceScenario } from './utils/gitScenario';

test('connected composer context background', async ({ page }, testInfo) => {
  const branch = `feature/${'a'.repeat(100)}`;
  const scenario = createGitWorkspaceScenario({
    gitStatus: { v: 2, workspaceCwd: '/tmp/qwen-web-shell-e2e', branch },
  });
  scenario.capabilities.workspaces.push({
    id: 'secondary',
    cwd: '/tmp/another-project',
    trusted: true,
    primary: false,
  });
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto('/?theme=light');
  const row = page.locator('[data-web-shell-composer-context-row]');
  await expect(row).toBeVisible();
  await expect(row).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const git = row.locator('[data-testid=git-mode-chip]');
  await expect(git).toHaveCSS('border-top-width', '0px');
  await expect(git).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(git.locator(':scope > svg')).toBeHidden();
  await expect(git).toHaveCSS('padding-right', '12px');
  await git.hover();
  await expect(page.getByRole('tooltip')).toHaveText(branch);
  await page.screenshot({ path: testInfo.outputPath('composer-light.png') });
  await git.click();
  await expect(page.locator('[data-slot=popover-content]')).toBeVisible();
  await expect(page.getByRole('tooltip')).toBeHidden();
  await page.keyboard.press('Escape');
  await row.getByRole('button', { name: 'Workspace', exact: true }).click();
  await expect(
    page.locator('[data-slot=dropdown-menu-content]'),
  ).toHaveAttribute('data-side', 'top');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await git.hover();
  await expect(page.getByRole('tooltip')).toHaveText(branch);
  const tooltip = page.locator('[data-slot="tooltip-content"]');
  expect(
    await tooltip.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('composer-mobile.png') });
});
