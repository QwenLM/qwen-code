import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';
import { completeReplay } from './visuals/harness';

async function openHarness(
  page: Page,
  testInfo: TestInfo,
  extras: Record<string, string> = {},
) {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  const params = new URLSearchParams({
    sessionId: scenario.sessionId,
    theme: 'dark',
    sidebar: 'false',
    unavailableModels: '1',
    ...extras,
  });
  await page.goto(`/e2e/settings-harness.html?${params}`);
  await completeReplay(page, daemon, scenario.sessionId);
  return daemon;
}

async function openPicker(page: Page) {
  await page.locator('[data-web-shell-model-button]').click();
  const disabled = page.locator(
    '[data-web-shell-unavailable-model][data-model-id="qwen-max"]',
  );
  await expect(disabled).toBeVisible();
  await expect(disabled).toHaveAttribute('aria-disabled', 'true');
  await expect(disabled).toContainText('Qwen Max');
  return disabled;
}

async function clipAround(page: Page, locators: readonly Locator[]) {
  const boxes = await Promise.all(
    locators.map((locator) => locator.boundingBox()),
  );
  const visible = boxes.filter(
    (box): box is NonNullable<(typeof boxes)[number]> => box != null,
  );
  expect(visible.length).toBeGreaterThan(0);
  const left = Math.min(...visible.map((box) => box.x));
  const top = Math.min(...visible.map((box) => box.y));
  const right = Math.max(...visible.map((box) => box.x + box.width));
  const bottom = Math.max(...visible.map((box) => box.y + box.height));
  const padding = 16;
  return {
    x: Math.max(0, left - padding),
    y: Math.max(0, top - padding),
    width: right - left + padding * 2,
    height: bottom - top + padding * 2,
  };
}

async function evidence(
  page: Page,
  name: string,
  locators: readonly Locator[],
) {
  const directory = resolve(
    '../../.qwen/e2e-tests/unavailable-models-evidence',
  );
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: resolve(directory, `${name}.png`),
    clip: await clipAround(page, locators),
  });
}

test('shows injected models as disabled rows in the composer picker', async ({
  page,
}, testInfo) => {
  await openHarness(page, testInfo);
  const disabled = await openPicker(page);
  await expect(
    page.locator('[data-web-shell-toolbar-popover]').filter({
      has: page.locator('[data-model-id="qwen-test"]'),
    }),
  ).toContainText('Qwen Test');
  await expect(
    page.locator('[data-web-shell-unavailable-model][data-model-id="gpt-5"]'),
  ).toContainText('GPT-5');
  await evidence(page, 'picker', [
    page.locator('[data-web-shell-model-button]'),
    page.locator('[data-web-shell-toolbar-popover]').first(),
    disabled,
  ]);
});

test('shows a host string tooltip on a disabled model', async ({
  page,
}, testInfo) => {
  await openHarness(page, testInfo);
  const disabled = await openPicker(page);
  await disabled.focus();
  const hint = page.locator('[data-web-shell-unavailable-model-tooltip]');
  await expect(
    hint.locator('[data-web-shell-unavailable-model-title]'),
  ).toHaveText('Qwen Max');
  await expect(hint).toContainText('Available on the Pro plan.');
  await evidence(page, 'tooltip', [
    page.locator('[data-web-shell-model-button]'),
    page.locator('[data-web-shell-toolbar-popover]').first(),
    hint,
  ]);
});

test('mounts an authorize action in the disabled-model hint', async ({
  page,
}, testInfo) => {
  await openHarness(page, testInfo, { unavailableMount: '1' });
  const disabled = await openPicker(page);
  await disabled.focus();
  const hint = page.locator('[data-web-shell-unavailable-model-tooltip]');
  await expect(
    hint.locator('[data-web-shell-unavailable-model-title]'),
  ).toHaveText('Qwen Max');
  await expect(hint.getByRole('button', { name: 'Authorize' })).toBeVisible();
  await expect(hint).toContainText('Not authorized for the current account.');
  await evidence(page, 'authorize', [
    page.locator('[data-web-shell-model-button]'),
    page.locator('[data-web-shell-toolbar-popover]').first(),
    hint,
  ]);
});
