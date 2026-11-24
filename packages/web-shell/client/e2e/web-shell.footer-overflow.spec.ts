import { expect, test, type Locator } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

async function expectContainedFooter(sidebar: Locator) {
  const bounds = (await sidebar.boundingBox())!;
  const footer = sidebar.locator('[data-web-shell-sidebar-footer]');
  const buttons = await footer.getByRole('button').all();
  expect(buttons.length).toBeGreaterThanOrEqual(6);
  for (const button of buttons) {
    const box = (await button.boundingBox())!;
    const label = await button.getAttribute('aria-label');
    expect(box.x, label ?? 'footer button').toBeGreaterThanOrEqual(
      bounds.x - 1,
    );
    expect(box.x + box.width, label ?? 'footer button').toBeLessThanOrEqual(
      bounds.x + bounds.width + 1,
    );
    expect(box.y, label ?? 'footer button').toBeGreaterThanOrEqual(
      bounds.y - 1,
    );
    expect(box.y + box.height, label ?? 'footer button').toBeLessThanOrEqual(
      bounds.y + bounds.height + 1,
    );
  }
  const body = await sidebar
    .locator('[data-web-shell-sidebar-body]')
    .boundingBox();
  const footerBox = (await footer.boundingBox())!;
  expect(body!.y + body!.height).toBeLessThanOrEqual(footerBox.y + 1);
  const version = sidebar.getByText('v0.0.0-e2e', { exact: true });
  if (await version.isVisible()) {
    const versionBox = (await version.boundingBox())!;
    expect(body!.y + body!.height).toBeLessThanOrEqual(versionBox.y + 1);
  }
}

for (const width of [220, 300]) {
  test(`Home-only utility footer stays inside a ${width}px sidebar @smoke`, async ({
    page,
    baseURL,
  }, info) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript((savedWidth) => {
      localStorage.setItem(
        'qwen-code-web-shell-sidebar-width',
        String(savedWidth),
      );
    }, width);
    await installMockDaemon(page, createWebShellDaemonScenario(), { baseURL });
    await page.goto('/e2e/navigation-rail-harness.html?rich-footer');
    const sidebar = page.getByRole('complementary', {
      name: 'Workspace sidebar',
    });
    await expect(
      page.locator('[data-web-shell-composer-editor] .cm-content'),
    ).toBeVisible();
    await expect(sidebar).toHaveCSS('width', `${width}px`);
    await expect(page.locator('[data-web-shell-navigation-rail]')).toHaveCount(
      0,
    );
    await expect(
      sidebar.getByText('v0.0.0-e2e', { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath('rich-footer-expanded.png'),
    });
    await expectContainedFooter(sidebar);
    await sidebar
      .getByRole('button', { name: 'Collapse', exact: true })
      .click();
    await expect(sidebar).toHaveCSS('width', '56px');
    await expectContainedFooter(sidebar);
    await sidebar.getByRole('button', { name: 'Expand', exact: true }).click();
    await expect(sidebar).toHaveCSS('width', `${width}px`);
    await expectContainedFooter(sidebar);
  });
}

test('minimal footer keeps collapse at the bottom-right', async ({
  page,
  baseURL,
}) => {
  await installMockDaemon(page, createWebShellDaemonScenario(), { baseURL });
  await page.goto('/e2e/navigation-rail-harness.html?minimal');
  const sidebar = page.getByRole('complementary', {
    name: 'Workspace sidebar',
  });
  const collapse = sidebar.getByRole('button', {
    name: 'Collapse',
    exact: true,
  });
  await expect(collapse).toBeVisible();
  const bounds = (await sidebar.boundingBox())!;
  const button = (await collapse.boundingBox())!;
  expect(button.x).toBeGreaterThanOrEqual(bounds.x + bounds.width - 50);
  expect(button.y).toBeGreaterThanOrEqual(bounds.y + bounds.height - 50);
});

test('rich footer keeps expansion reachable in a short container', async ({
  page,
  baseURL,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 400 });
  await installMockDaemon(page, createWebShellDaemonScenario(), { baseURL });
  await page.goto('/e2e/navigation-rail-harness.html?rich-footer');
  const sidebar = page.getByRole('complementary', {
    name: 'Workspace sidebar',
  });
  await sidebar.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(sidebar).toHaveCSS('width', '56px');
  const expand = sidebar.getByRole('button', { name: 'Expand', exact: true });
  for (const height of [400, 320]) {
    await page.setViewportSize({ width: 1440, height });
    const sidebarBox = (await sidebar.boundingBox())!;
    const expandBox = (await expand.boundingBox())!;
    await page.screenshot({
      path: info.outputPath(`rich-footer-collapsed-${height}.png`),
    });
    expect(expandBox.y + expandBox.height).toBeLessThanOrEqual(
      sidebarBox.y + sidebarBox.height + 1,
    );
    if (height === 320) {
      const footer = sidebar.locator('[data-web-shell-sidebar-footer]');
      await footer.hover();
      await page.mouse.wheel(0, 200);
      await expect
        .poll(() => footer.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
    }
  }
  await expand.click();
  await expect(sidebar).toHaveCSS('width', '300px');
});
