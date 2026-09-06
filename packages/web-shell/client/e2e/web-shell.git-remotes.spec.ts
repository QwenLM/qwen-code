/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Page } from '@playwright/test';
import {
  installMockDaemon,
  type MockDaemonController,
} from './utils/mockDaemon';
import { createGitWorkspaceScenario } from './utils/gitScenario';

async function openSidebarGitPicker(page: Page) {
  // The workspace header's git pill in the left sidebar.
  const pill = page.locator(`button[aria-label="Git — main"]`);
  await expect(pill).toBeVisible({ timeout: 10_000 });
  await pill.click();
  const popover = page.locator('[data-slot="popover-content"]');
  await expect(popover).toBeVisible({ timeout: 5_000 });
  return popover;
}

async function openRemotesPanel(page: Page) {
  const popover = await openSidebarGitPicker(page);
  await popover.locator('[data-testid="branch-picker-manage-remotes"]').click();
  await expect(popover.locator('[data-testid="remotes-back"]')).toBeVisible();
  return popover;
}

function remoteRequests(daemon: MockDaemonController, suffix: string) {
  return daemon.requests.filter(
    (r) =>
      /^\/workspaces\/.+\/git\/remote/.test(r.path) && r.path.endsWith(suffix),
  );
}

test('sidebar git picker manages remotes: list, add, remove', async ({
  page,
}, testInfo) => {
  const scenario = createGitWorkspaceScenario();
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto('/');

  const popover = await openRemotesPanel(page);

  // The default fixture lists origin with its URL.
  const originRow = popover.locator('[data-testid="remote-remove-origin"]');
  await expect(originRow).toBeVisible();
  await expect(popover.getByText('https://example.com/o/r.git')).toBeVisible();

  // Add a remote; the mock answers with the fresh list.
  await popover.locator('[data-testid="remote-add-name"]').fill('fork');
  await popover
    .locator('[data-testid="remote-add-url"]')
    .fill('https://example.com/f/r.git');
  await popover.locator('[data-testid="remote-add-submit"]').click();
  await expect(
    popover.locator('[data-testid="remote-remove-fork"]'),
  ).toBeVisible();
  await expect(popover.getByText('Added remote fork')).toBeVisible();

  const adds = remoteRequests(daemon, '/git/remote');
  expect(adds).toHaveLength(1);
  expect(adds[0]!.method).toBe('POST');
  expect(adds[0]!.body).toEqual({
    name: 'fork',
    url: 'https://example.com/f/r.git',
  });

  // Remove uses a two-click confirm: the first click only arms the button.
  await originRow.click();
  expect(remoteRequests(daemon, '/git/remote/remove')).toHaveLength(0);
  await originRow.click();
  await expect(originRow).toHaveCount(0);
  await expect(popover.getByText('Removed remote origin')).toBeVisible();

  const removes = remoteRequests(daemon, '/git/remote/remove');
  expect(removes).toHaveLength(1);
  expect(removes[0]!.body).toEqual({ name: 'origin' });

  // Back returns to the branch listing.
  await popover.locator('[data-testid="remotes-back"]').click();
  await expect(popover.getByText('Update Project')).toBeVisible();
});

test('remotes panel surfaces a duplicate add as an error', async ({
  page,
}, testInfo) => {
  const scenario = createGitWorkspaceScenario();
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto('/');

  const popover = await openRemotesPanel(page);

  await popover.locator('[data-testid="remote-add-name"]').fill('origin');
  await popover
    .locator('[data-testid="remote-add-url"]')
    .fill('https://example.com/other.git');
  await popover.locator('[data-testid="remote-add-submit"]').click();

  await expect(
    popover.getByText('error: remote origin already exists.'),
  ).toBeVisible();
  // The failed add changed nothing: still exactly one remote row.
  await expect(popover.locator('[class*="remoteRow"]')).toHaveCount(1);
});

test('remotes panel search filters by name and URL', async ({
  page,
}, testInfo) => {
  const scenario = createGitWorkspaceScenario({
    gitRemotes: [
      {
        name: 'origin',
        fetchUrl: 'https://example.com/o/r.git',
        pushUrl: 'https://example.com/o/r.git',
      },
      {
        name: 'upstream',
        fetchUrl: 'git@example.com:u/r.git',
        pushUrl: 'git@example.com:u/r.git',
      },
    ],
  });
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto('/');

  const popover = await openRemotesPanel(page);
  await expect(popover.locator('[class*="remoteRow"]')).toHaveCount(2);

  await popover
    .locator('input[placeholder="Search for branches and actions"]')
    .fill('upstream');
  await expect(popover.locator('[class*="remoteRow"]')).toHaveCount(1);
  await expect(popover.getByText('upstream')).toBeVisible();

  // A URL substring matches too.
  await popover
    .locator('input[placeholder="Search for branches and actions"]')
    .fill('o/r.git');
  await expect(popover.locator('[class*="remoteRow"]')).toHaveCount(1);
  await expect(popover.getByText('origin')).toBeVisible();
});
