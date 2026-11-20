/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Page } from '@playwright/test';
import {
  installMockDaemon,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';
import { createGitWorkspaceScenario } from './utils/gitScenario';

async function gotoSession(page: Page, scenario: WebShellDaemonScenario) {
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(page.locator('[data-web-shell-composer]')).toBeVisible({
    timeout: 10_000,
  });
}

// Same trigger route as the remotes spec: the environment panel's branch
// row opens the picker. Reusable without a reload — the kept-stash warning
// lives in component state, and the toggle must not close an open panel.
async function openBranchPicker(page: Page, scenario: WebShellDaemonScenario) {
  const environment = page.getByTestId('environment-panel');
  if (!(await environment.isVisible())) {
    await page.locator('[data-web-shell-environment-toggle]').click();
  }
  await expect(environment).toBeVisible();
  const branchRow = environment.getByRole('button', {
    name: scenario.gitStatus?.branch ?? 'main',
    exact: true,
  });
  await expect(branchRow).toBeVisible({ timeout: 10_000 });
  await branchRow.click();
  const popover = page.locator('[data-slot="popover-content"]');
  await expect(popover).toBeVisible({ timeout: 5_000 });
  return popover;
}

function checkoutRequests(daemon: MockDaemonController) {
  return daemon.requests.filter(
    (r) => r.method === 'POST' && /\/git\/checkout\/?$/.test(r.path),
  );
}

async function refuseCheckout(popover: ReturnType<Page['locator']>) {
  // 'main' appears in both the Recent and Local sections; either row
  // checks out the same ref.
  await popover
    .getByRole('button', { name: 'main', exact: true })
    .first()
    .click();
  await expect(
    popover.getByText('Switch blocked by uncommitted changes'),
  ).toBeVisible();
}

test('dirty checkout offers stash and switch, keeping the entry named @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createGitWorkspaceScenario({ gitCheckoutDirty: true });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await gotoSession(page, scenario);
  const popover = await openBranchPicker(page, scenario);
  await refuseCheckout(popover);

  // The plain refusal sent no resolution options.
  expect(checkoutRequests(daemon)).toHaveLength(1);
  expect(checkoutRequests(daemon)[0]!.body).toEqual({ ref: 'main' });

  await popover
    .getByRole('button', { name: 'Stash Changes and Switch' })
    .click();
  await expect.poll(() => checkoutRequests(daemon).length).toBe(2);
  expect(checkoutRequests(daemon)[1]!.body).toEqual({
    ref: 'main',
    stash: true,
  });

  // A stash success keeps the picker open so the kept-entry warning — the
  // only record of where the changes went — is painted immediately.
  await expect(popover).toBeVisible();
  await expect(
    popover.getByText(/kept in stash entry a1b2c3d4e5f6/),
  ).toBeVisible();

  // The warning is sticky: it survives a close/reopen too.
  await page.keyboard.press('Escape');
  await expect(popover).not.toBeVisible();
  await openBranchPicker(page, scenario);
  await expect(
    page
      .locator('[data-slot="popover-content"]')
      .getByText(/kept in stash entry a1b2c3d4e5f6/),
  ).toBeVisible();
});

test('dirty checkout offers discard and switch behind a confirm @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createGitWorkspaceScenario({ gitCheckoutDirty: true });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await gotoSession(page, scenario);
  const popover = await openBranchPicker(page, scenario);
  await refuseCheckout(popover);

  // First click only arms the confirmation — no request yet.
  await popover
    .getByRole('button', { name: 'Discard Changes and Switch…' })
    .click();
  await expect(
    popover.getByText(
      'Discard ALL uncommitted changes (including untracked files)? This cannot be undone.',
    ),
  ).toBeVisible();
  expect(checkoutRequests(daemon)).toHaveLength(1);

  await popover.getByRole('button', { name: 'Discard and Switch' }).click();
  await expect.poll(() => checkoutRequests(daemon).length).toBe(2);
  expect(checkoutRequests(daemon)[1]!.body).toEqual({
    ref: 'main',
    force: true,
  });
  await expect(popover).not.toBeVisible();
});

test('cancelling the checkout resolution sends nothing @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createGitWorkspaceScenario({ gitCheckoutDirty: true });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await gotoSession(page, scenario);
  const popover = await openBranchPicker(page, scenario);
  await refuseCheckout(popover);

  await popover.getByRole('button', { name: 'Cancel' }).click();
  await expect(
    popover.getByText('Switch blocked by uncommitted changes'),
  ).not.toBeVisible();
  expect(checkoutRequests(daemon)).toHaveLength(1);
});
