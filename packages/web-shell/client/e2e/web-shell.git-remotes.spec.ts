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

test('sidebar git picker manages remotes: list, add, remove @smoke', async ({
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
  // Submit from the focused BUTTON (mouse or Tab+Enter): the in-flight
  // disable blurs it, and the restore must put focus back on it.
  await popover.locator('[data-testid="remote-add-submit"]').focus();
  await page.keyboard.press('Enter');

  await expect(
    popover.getByText('error: remote origin already exists.'),
  ).toBeVisible();
  // The failed add changed nothing: still exactly one remote row.
  await expect(popover.locator('[class*="remoteRow"]')).toHaveCount(1);
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (document.activeElement as HTMLElement | null)?.dataset?.['testid'] ??
          null,
      ),
    )
    .toBe('remote-add-submit');
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
        extraFetchUrls: 0,
        extraPushUrls: 0,
        promisor: false,
        customRefspec: false,
        otherSettings: 0,
      },
      {
        name: 'upstream',
        fetchUrl: 'git@example.com:u/r.git',
        pushUrl: 'git@example.com:u/r.git',
        extraFetchUrls: 0,
        extraPushUrls: 0,
        promisor: false,
        customRefspec: false,
        otherSettings: 0,
      },
    ],
  });
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto('/');

  const popover = await openRemotesPanel(page);
  await expect(popover.locator('[class*="remoteRow"]')).toHaveCount(2);

  await popover.locator('input[placeholder="Search remotes"]').fill('upstream');
  await expect(popover.locator('[class*="remoteRow"]')).toHaveCount(1);
  await expect(popover.getByText('upstream')).toBeVisible();

  // A URL substring matches too.
  await popover.locator('input[placeholder="Search remotes"]').fill('o/r.git');
  await expect(popover.locator('[class*="remoteRow"]')).toHaveCount(1);
  await expect(popover.getByText('origin')).toBeVisible();
});

test('the add form fits inside the popover clip', async ({
  page,
}, testInfo) => {
  const scenario = createGitWorkspaceScenario();
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto('/');

  const popover = await openRemotesPanel(page);
  // Geometry, not fill()/click(): Playwright scrolls the overflow container
  // into place before interacting, so an off-clip Add button still passes a
  // click-based assertion.
  const form = popover.locator('[class*="addRemoteForm"]');
  const formBox = await form.boundingBox();
  const popBox = await popover.boundingBox();
  expect(formBox).toBeTruthy();
  expect(popBox).toBeTruthy();
  expect(formBox!.x + formBox!.width).toBeLessThanOrEqual(
    popBox!.x + popBox!.width + 1,
  );
  const addBtn = popover.locator('[data-testid="remote-add-submit"]');
  const btnBox = await addBtn.boundingBox();
  expect(btnBox).toBeTruthy();
  expect(btnBox!.x + btnBox!.width).toBeLessThanOrEqual(
    popBox!.x + popBox!.width + 1,
  );
  // Single-row layout: the inputs must shrink, not wrap the Add button
  // onto a second line that would also sit inside the clip.
  const nameBox = await popover
    .locator('[data-testid="remote-add-name"]')
    .boundingBox();
  expect(nameBox).toBeTruthy();
  expect(Math.abs(btnBox!.y - nameBox!.y)).toBeLessThan(2);
});

test('the remotes list keeps rows and chrome inside the clip while scrolled', async ({
  page,
}, testInfo) => {
  // A stressed fixture: enough rows to scroll the 480px clip, and a long
  // single-token name carrying a badge so the row's shrink rules engage.
  const longName = 'staging-mirror-for-the-payments-monorepo';
  const scenario = createGitWorkspaceScenario({
    gitRemotes: Array.from({ length: 15 }, (_, i) => ({
      name: i === 0 ? longName : `remote-${i}`,
      fetchUrl: `https://example.com/${i}/r.git`,
      pushUrl: `https://example.com/${i}/r.git`,
      extraFetchUrls: 0,
      extraPushUrls: 0,
      promisor: i === 0,
      customRefspec: i === 0,
      otherSettings: i === 0 ? 2 : 0,
    })),
  });
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto('/');

  const popover = await openRemotesPanel(page);

  const rows = popover.locator('[class*="remoteRow"]');
  await expect(rows).toHaveCount(15);
  // Preconditions of the shrink witness: row 0's badge is what makes the
  // row overflow, and its name is what gets clipped.
  await expect(rows.nth(0).locator('[class*="remoteBadge"]')).toBeVisible();
  expect(
    await rows
      .nth(0)
      .locator('[class*="remoteName"]')
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true);
  // The URL keeps a floor: shrink must not lay it out at zero width.
  expect(
    (await rows.nth(0).locator('[class*="remoteUrl"]').boundingBox())!.width,
  ).toBeGreaterThan(0);

  // Measure the clip on the settled layout (rows rendered), not on the
  // loading commit's shorter box.
  const popBox = await popover.boundingBox();
  expect(popBox).toBeTruthy();
  for (let i = 0; i < 15; i++) {
    const row = rows.nth(i);
    const box = await row.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.x + box!.width).toBeLessThanOrEqual(
      popBox!.x + popBox!.width + 1,
    );
    const btnBox = await row
      .locator('[data-testid^="remote-remove-"]')
      .boundingBox();
    expect(btnBox).toBeTruthy();
    expect(btnBox!.x + btnBox!.width).toBeLessThanOrEqual(
      popBox!.x + popBox!.width + 1,
    );
  }

  // The sticky header and add form must stay pinned inside the clip at
  // both scroll extremes.
  const list = popover.locator('[class*="addRemoteForm"]').locator('..');
  const chromeInClip = async () => {
    const formBox = await popover
      .locator('[class*="addRemoteForm"]')
      .boundingBox();
    const backBox = await popover
      .locator('[data-testid="remotes-back"]')
      .boundingBox();
    expect(formBox).toBeTruthy();
    expect(backBox).toBeTruthy();
    expect(formBox!.y).toBeGreaterThanOrEqual(popBox!.y - 1);
    expect(formBox!.y + formBox!.height).toBeLessThanOrEqual(
      popBox!.y + popBox!.height + 1,
    );
    expect(backBox!.y).toBeGreaterThanOrEqual(popBox!.y - 1);
  };
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  // Pin the precondition: without overflow the sticky assertions below
  // would measure an unscrolled layout and certify nothing.
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await chromeInClip();
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  await chromeInClip();

  // Focus-scrolling the last Remove button must clear the sticky add form
  // (scroll-padding on the scrollport), not land behind its opaque band.
  const lastBtn = rows.nth(14).locator('[data-testid^="remote-remove-"]');
  await lastBtn.focus();
  const lastBox = await lastBtn.boundingBox();
  const formBox = await popover
    .locator('[class*="addRemoteForm"]')
    .boundingBox();
  expect(lastBox).toBeTruthy();
  expect(formBox).toBeTruthy();
  expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(formBox!.y + 1);
});
