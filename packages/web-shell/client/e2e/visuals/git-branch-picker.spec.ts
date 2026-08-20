/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  turnCompleteEvent,
  userTextEvent,
} from '../utils/mockDaemon';
import {
  captureScreenshot,
  gotoSession,
  installScenario,
  resolveBaseURL,
  VISUAL_VIEWPORT,
} from './harness';

test.use({ viewport: { ...VISUAL_VIEWPORT } });

test('branch picker, commit dialog, create PR form', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    capabilities: {
      features: [
        'session_events',
        'permission_vote',
        'session_permission_vote',
        'session_scope_override',
        'session_source_metadata',
        'workspace_settings',
        'workspace_voice',
        'workspace_github_prs',
      ],
    },
    gitStatus: {
      v: 2,
      workspaceCwd: '/mock/workspace',
      branch: 'feat/demo',
      detached: false,
      staged: 2,
      unstaged: 1,
      untracked: 1,
      conflicted: 0,
      hasUpstream: true,
      ahead: 3,
      behind: 0,
      stashCount: 0,
      operation: null,
      computedAt: Date.now(),
    },
    events: [
      userTextEvent('Add a branch picker to the web shell', { id: 1 }),
      assistantTextEvent(
        'Done! I added the branch picker with search, checkout, and commit support.',
        { id: 2 },
      ),
      turnCompleteEvent('prompt-1', { id: 3 }),
    ],
  });

  const daemon = await installScenario(
    page,
    scenario,
    resolveBaseURL(testInfo),
  );
  await gotoSession(page, scenario, daemon, 'dark');

  // Wait for the composer to be ready
  await expect(page.locator('[data-web-shell-composer]')).toBeVisible({
    timeout: 10000,
  });
  await page.waitForTimeout(1000);

  // Click the branch chip in the composer toolbar to open the branch picker
  const branchChip = page.locator('[data-web-shell-git-branch]').first();
  await expect(branchChip).toBeVisible({ timeout: 5000 });
  await branchChip.click();
  await page.waitForTimeout(1500);

  // Screenshot 1: Branch picker popover
  await captureScreenshot(page, '01-branch-picker');

  // Click "Commit" action in the picker
  const commitAction = page.locator('button:has-text("Commit")').first();
  await expect(commitAction).toBeVisible({ timeout: 3000 });
  await commitAction.click();
  await page.waitForTimeout(2000);

  // Screenshot 2: Commit dialog
  await captureScreenshot(page, '02-commit-dialog');

  // Click "Create Pull Request" button
  const createPrBtn = page
    .locator(
      'button:has-text("Create Pull Request"), button:has-text("Create PR")',
    )
    .first();
  await expect(createPrBtn).toBeVisible({ timeout: 3000 });
  await createPrBtn.click();
  await page.waitForTimeout(2000);

  // Screenshot 3: Create PR form
  await captureScreenshot(page, '03-create-pr-form');
});
