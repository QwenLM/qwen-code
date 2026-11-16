import { expect, test, type Page } from '@playwright/test';

const alpha = 'model-alpha(openai)';
const beta = 'model-beta(anthropic)';
const gamma = 'model-gamma(openai)';

async function openDemo(page: Page, query = '') {
  await page.goto(`/e2e/model-picker-content-demo.html${query}`);
  await expect(page.locator('[data-demo-composer="left"]')).toBeVisible();
}

async function openPicker(page: Page, pane = 'left', reasoning = false) {
  await page
    .locator(`[data-demo-composer="${pane}"] [data-web-shell-model-button]`)
    .click();
  if (reasoning) {
    await expect(page.locator('[data-demo-header]')).toHaveCount(0);
    await page.locator('[data-web-shell-model-submenu-trigger]').click();
    await expect(
      page.locator('[data-web-shell-model-submenu] [data-demo-header]'),
    ).toBeVisible();
  }
  await expect(page.locator(`[data-demo-header="${pane}"]`)).toBeVisible();
}

function row(page: Page, id: string) {
  return page.locator(
    `[data-web-shell-toolbar-popover][data-state="open"] [data-model-id="${id}"]`,
  );
}

async function stats(page: Page) {
  return JSON.parse(
    (await page.locator('#demo-stats').textContent()) || '{}',
  ) as {
    mounts: number;
    disposes: number;
    actions: number;
    leftSelections: number;
    rightSelections: number;
  };
}

test('mounts host content and follows each composer current model', async ({
  page,
}) => {
  await openDemo(page);
  await openPicker(page);
  const leftHeader = page.locator('[data-demo-header="left"]');
  await expect(leftHeader).toHaveAttribute('data-current-model', alpha);
  await expect(leftHeader).toHaveAttribute(
    'data-workspace-cwd',
    '/example/left',
  );
  const leftComposerId = await leftHeader.getAttribute('data-composer-id');
  await expect(row(page, alpha)).toContainText('Example Alpha');
  await expect(row(page, alpha)).toContainText('Special rate');
  await expect(row(page, alpha)).toContainText('0.5×');
  await expect(row(page, gamma)).toHaveAttribute('aria-disabled', 'true');
  const mounted = (await stats(page)).mounts;

  await page.evaluate((modelId) => {
    window.dispatchEvent(
      new CustomEvent('model-picker-current-model', {
        detail: { pane: 'left', modelId },
      }),
    );
  }, beta);
  await expect(leftHeader).toHaveAttribute('data-current-model', beta);
  expect((await stats(page)).mounts).toBe(mounted);
  await row(page, alpha).hover();
  await expect(leftHeader).toHaveAttribute('data-current-model', beta);
  await page.getByTestId('outside').click();
  await openPicker(page, 'right');
  const rightHeader = page.locator('[data-demo-header="right"]');
  await expect(rightHeader).toHaveAttribute('data-current-model', beta);
  await expect(rightHeader).toHaveAttribute(
    'data-workspace-cwd',
    '/example/right',
  );
  expect(await rightHeader.getAttribute('data-composer-id')).not.toBe(
    leftComposerId,
  );
  await row(page, alpha).click();
  expect((await stats(page)).rightSelections).toBe(1);
  expect((await stats(page)).leftSelections).toBe(0);
});

for (const query of ['', '?reasoning=1', '?reasoning=1&shadow=1&theme=light']) {
  test(`keeps host overlay actions inside the picker ${query}`, async ({
    page,
  }, testInfo) => {
    await openDemo(page, query);
    await openPicker(page, 'left', query.includes('reasoning=1'));
    await row(page, alpha).focus();
    const overlay = page.locator(
      `[data-demo-overlay="${alpha}"][data-demo-pane="left"]`,
    );
    await expect(overlay).toBeVisible();
    await overlay.getByRole('button', { name: 'Read model details' }).click();
    await expect(page.locator('[data-demo-header="left"]')).toBeVisible();
    expect((await stats(page)).actions).toBe(1);
    expect((await stats(page)).leftSelections).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('host-overlay.png') });
    if (query.includes('shadow=1')) {
      expect(
        await overlay.evaluate(
          (element) => element.getRootNode() instanceof ShadowRoot,
        ),
      ).toBe(true);
      await expect(page.locator('[data-demo-header="left"]')).toHaveAttribute(
        'data-theme',
        'light',
      );
    }
    await overlay
      .getByRole('button', { name: 'Read model details' })
      .press('Escape');
    await expect(overlay).toBeHidden();
    await expect(page.locator('[data-demo-header="left"]')).toBeVisible();
    await page.getByTestId('outside').click();
    await expect(overlay).toHaveCount(0);
    await expect(page.locator('[data-demo-header="left"]')).toHaveCount(0);
    const final = await stats(page);
    expect(final.disposes).toBe(final.mounts);
  });
}

test('disposes filtered rows and mounts fresh content on reopening', async ({
  page,
}) => {
  await openDemo(page);
  await openPicker(page);
  const before = await stats(page);
  await page.getByRole('searchbox').fill('Beta');
  await expect(row(page, alpha)).toHaveCount(0);
  await expect(row(page, beta)).toContainText('Example Beta');
  await expect(page.locator(`[data-demo-overlay="${alpha}"]`)).toHaveCount(0);
  expect((await stats(page)).disposes).toBeGreaterThan(before.disposes);
  await page.getByRole('searchbox').fill('');
  await expect(row(page, alpha)).toContainText('Example Alpha');
  expect((await stats(page)).mounts).toBeGreaterThan(before.mounts);
  await page.getByTestId('outside').click();
  await expect(page.locator('[data-demo-header]')).toHaveCount(0);
  const closed = await stats(page);
  expect(closed.disposes).toBe(closed.mounts);
  await openPicker(page);
  expect((await stats(page)).mounts).toBeGreaterThan(closed.mounts);
});

for (const failure of ['decline', 'throw']) {
  test(`restores unavailable-model content and explanation after ${failure}`, async ({
    page,
  }) => {
    await openDemo(page, `?failure=${failure}`);
    await openPicker(page);
    const disabled = row(page, gamma);
    await expect(disabled).toContainText('Example Gamma');
    await expect(disabled.locator('[data-demo-model]')).toHaveCount(0);
    await disabled.focus();
    await expect(
      page.locator('[data-web-shell-unavailable-model-tooltip]'),
    ).toContainText('This model is unavailable in the current demo plan.');
    await disabled.click({ force: true });
    expect((await stats(page)).leftSelections).toBe(0);
    await expect(page.locator('[data-demo-header="left"]')).toBeVisible();
  });
}

test('lets a touch host consume a row click before selection', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await openDemo(page, '?touch=1');
  await openPicker(page);
  await row(page, alpha).tap();
  const overlay = page.locator(`[data-demo-overlay="${alpha}"]`);
  await expect(overlay).toBeVisible();
  await expect(page.locator('[data-demo-header="left"]')).toBeVisible();
  expect((await stats(page)).leftSelections).toBe(0);
  await overlay.getByRole('button', { name: 'Read model details' }).tap();
  await expect.poll(async () => (await stats(page)).actions).toBe(1);
  expect((await stats(page)).leftSelections).toBe(0);
  await expect(page.locator('[data-demo-header="left"]')).toBeVisible();
  await context.close();
});
