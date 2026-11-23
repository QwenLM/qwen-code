import { expect, test, type Page } from '@playwright/test';

async function go(
  page: Page,
  scenario:
    | 'no-add-history'
    | 'no-add-running'
    | 'wide-git'
    | 'interactive-git'
    | 'managed-worktree'
    | 'long-model',
) {
  await page.goto(`/e2e/touch-composer-fixture.html?scenario=${scenario}`);
  await expect(
    page.locator('textarea[data-web-shell-composer-editor]'),
  ).toBeVisible();
}

test('without Add, a Shell click keeps history search focused without changing the draft @smoke', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await go(page, 'no-add-history');
  const textarea = page.locator('textarea[data-web-shell-composer-editor]');
  await textarea.fill('retained draft');
  await page.getByRole('button', { name: 'Input history', exact: true }).tap();
  const search = page.locator('[data-web-shell-composer-history-search]');
  await expect(search).toBeFocused();
  await search.fill('abc');
  await page.evaluate(() => {
    const state = window as unknown as { draftFocusins: number };
    state.draftFocusins = 0;
    document
      .querySelector('textarea[data-web-shell-composer-editor]')!
      .addEventListener('focusin', () => {
        state.draftFocusins += 1;
      });
  });
  await page.getByRole('button', { name: 'Shell mode', exact: true }).click();
  await expect(search).toBeFocused();
  await page.keyboard.type('xyz');
  await expect(search).toHaveValue('abcxyz');
  await expect(textarea).toHaveValue('retained draft');
  expect(
    await page.evaluate(
      () => (window as unknown as { draftFocusins: number }).draftFocusins,
    ),
  ).toBe(0);
});

test('context menus and unconfirmed Git input survive responsive placement @smoke', async ({
  page,
}) => {
  await page.setViewportSize({ width: 528, height: 844 });
  await go(page, 'interactive-git');
  const actions = page.locator('[data-web-shell-mobile-editing-actions]');
  await expect(actions).toHaveAttribute('data-mobile-layout', 'medium');
  const chip = page.getByTestId('git-mode-chip');
  await chip.tap();
  await page.getByRole('radio').nth(1).tap();
  const branchInput = page.getByTestId('git-mode-branch-input');
  await branchInput.fill('feature/unconfirmed');
  for (const width of [390, 528]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(branchInput).toBeVisible();
    await expect(branchInput).toHaveValue('feature/unconfirmed');
  }
  await page.keyboard.press('Escape');
  await expect(branchInput).toHaveCount(0);
  await chip.tap();
  await expect(page.getByRole('radio').first()).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(branchInput).toHaveCount(0);
  await page.keyboard.press('Escape');
  const workspace = page.getByRole('button', {
    name: 'Workspace',
    exact: true,
  });
  await expect(workspace).toHaveAttribute('aria-expanded', 'false');
  await workspace.tap();
  await expect(page.getByRole('menu')).toBeVisible();
  for (const width of [390, 528]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('menuitemradio')).toHaveCount(2);
  }
});

test('narrow below-composer context buttons receive their first top-edge tap @smoke', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await go(page, 'wide-git');
  const textarea = page.locator('textarea[data-web-shell-composer-editor]');
  await expect(
    page.locator('[data-web-shell-composer-context-row]'),
  ).toBeVisible();
  const surfaceBox = (await page
    .locator('[data-web-shell-composer-surface]')
    .boundingBox())!;
  const surfaceBottom = surfaceBox.y + surfaceBox.height;
  const workspace = page.getByRole('button', {
    name: 'Workspace',
    exact: true,
  });
  const workspaceBox = (await workspace.boundingBox())!;
  expect(workspaceBox.y).toBeGreaterThanOrEqual(surfaceBottom);
  await page.touchscreen.tap(
    workspaceBox.x + workspaceBox.width / 2,
    workspaceBox.y + 2,
  );
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(textarea).not.toBeFocused();
  await page.keyboard.press('Escape');
  const chip = page.getByTestId('git-mode-chip');
  const branchBox = (await chip.boundingBox())!;
  expect(branchBox.y).toBeGreaterThanOrEqual(surfaceBottom);
  await page.touchscreen.tap(
    branchBox.x + branchBox.width / 2,
    branchBox.y + 2,
  );
  await expect(page.getByRole('radio')).toHaveCount(3);
  await expect(textarea).not.toBeFocused();
});

test('medium host-managed worktree keeps its chevron inside and usable @smoke', async ({
  page,
}) => {
  await page.setViewportSize({ width: 528, height: 844 });
  await go(page, 'managed-worktree');
  const actions = page.locator('[data-web-shell-mobile-editing-actions]');
  await expect(actions).toHaveAttribute('data-mobile-layout', 'medium');
  const row = actions.locator('[class*="mobileContextRow"]');
  const chip = page.getByTestId('managed-worktree-chip');
  const chevron = chip.locator('span[class*="chevron"]');
  const rowBox = (await row.boundingBox())!;
  const chevronBox = (await chevron.boundingBox())!;
  expect(chevronBox.x + chevronBox.width).toBeLessThanOrEqual(
    rowBox.x + rowBox.width,
  );
  expect(
    await chevron.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return (
        document
          .elementFromPoint(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2,
          )
          ?.closest('[data-testid="managed-worktree-chip"]') !== null
      );
    }),
  ).toBe(true);
  await chevron.tap();
  await expect(page.getByRole('radio')).toHaveCount(2);
});

test('without Add, repeat history activation retains history focus and retained draft @smoke', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await go(page, 'no-add-history');
  const textarea = page.locator('textarea[data-web-shell-composer-editor]');
  await textarea.fill('retained draft');
  const history = page.getByRole('button', {
    name: 'Input history',
    exact: true,
  });
  const search = page.locator('[data-web-shell-composer-history-search]');
  await history.tap();
  await expect(search).toBeFocused();
  await search.fill('abc');
  await page.evaluate(() => {
    const state = window as unknown as { draftFocusins: number };
    state.draftFocusins = 0;
    document
      .querySelector('textarea[data-web-shell-composer-editor]')!
      .addEventListener('focusin', () => {
        state.draftFocusins += 1;
      });
  });
  await history.tap();
  expect(
    await page.evaluate(
      () => (window as unknown as { draftFocusins: number }).draftFocusins,
    ),
  ).toBe(0);
  await expect(search).toBeFocused();
  await page.keyboard.type('xyz');
  await expect(search).toHaveValue('xyz');
  await expect(textarea).toHaveValue('retained draft');
});

test('without Add, running stop and send stay inside a 240px composer @smoke', async ({
  page,
}) => {
  await page.setViewportSize({ width: 240, height: 740 });
  await go(page, 'no-add-running');
  const textarea = page.locator('textarea[data-web-shell-composer-editor]');
  await textarea.fill('a retained draft');
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  await expect(send).toBeVisible();
  await expect(stop).toBeVisible();
  await expect(stop).toBeEnabled();
  const sendBox = (await send.boundingBox())!;
  const stopBox = (await stop.boundingBox())!;
  const surfaceBox = (await page
    .locator('[data-web-shell-composer-surface]')
    .boundingBox())!;
  for (const box of [sendBox, stopBox]) {
    expect(box.x).toBeGreaterThanOrEqual(surfaceBox.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(
      surfaceBox.x + surfaceBox.width + 1,
    );
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    240,
  );
});

test('wide long-workspace Git control stays visible with real 44px targets @smoke', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await go(page, 'wide-git');
  const actions = page.locator('[data-web-shell-mobile-editing-actions]');
  await expect(actions).toHaveAttribute('data-mobile-layout', 'wide');
  const workspaceLabel = actions.locator(
    '[aria-label="Workspace"] [data-slot="select-value"]',
  );
  await expect(workspaceLabel).toContainText('long-workspace-name-');
  const [clientWidth, scrollWidth] = await workspaceLabel.evaluate((label) => [
    label.clientWidth,
    label.scrollWidth,
  ]);
  expect(scrollWidth).toBeGreaterThan(clientWidth);
  const label = actions.locator('[data-web-shell-git-branch-label]');
  await expect(label).toBeVisible();
  expect((await label.boundingBox())!.width).toBeGreaterThan(0);
  for (const selector of [
    '[aria-label="Workspace"]',
    '[data-web-shell-git-branch]',
  ]) {
    const target = actions.locator(selector).first();
    const box = (await target.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});

test('a long model label stays readable without escaping the composer @smoke', async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 844 });
  await go(page, 'long-model');
  const button = page.locator('[data-web-shell-model-button]');
  const label = button.locator('[class*="toolBtnText"]').first();
  await expect(label).toBeVisible();
  await expect(label).toContainText('An unnecessarily long');
  const fullTextWidth = await label.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().width;
  });
  expect(fullTextWidth).toBeGreaterThan(300);
  expect(await label.evaluate((el) => el.clientWidth)).toBeGreaterThan(0);
  await expect(label).toHaveCSS('text-overflow', 'ellipsis');
  const buttonBox = (await button.boundingBox())!;
  const surfaceBox = (await page
    .locator('[data-web-shell-composer-surface]')
    .boundingBox())!;
  expect(buttonBox.x).toBeGreaterThanOrEqual(surfaceBox.x);
  expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(
    surfaceBox.x + surfaceBox.width + 1,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    768,
  );
});
