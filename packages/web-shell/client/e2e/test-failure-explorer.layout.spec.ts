/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, test, type Locator, type Page } from '@playwright/test';

let script: string;
let styles: string;

test.beforeAll(async () => {
  const result = await build({
    entryPoints: [
      fileURLToPath(
        new URL(
          '../../../../integrations/test-failure-explorer/src/app/fixtures/LayoutHarness.tsx',
          import.meta.url,
        ),
      ),
    ],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    outfile: 'layout.js',
    write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  script = result.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
  styles = result.outputFiles.find((file) => file.path.endsWith('.css'))!.text;
});

async function openReport(page: Page, width: number) {
  await page.setViewportSize({ width, height: 640 });
  await page.setContent(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>',
  );
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page
    .getByRole('checkbox', { name: 'Select f0:a0', exact: true })
    .check();
}

async function expandSummary(page: Page) {
  await page.locator('.reported-counts > summary').click();
  await page.locator('.warnings > summary').click();
}

async function expectReachable(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  expect(
    await control.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.x + box.width / 2,
        box.y + box.height / 2,
      );
      return hit === element || (hit !== null && element.contains(hit));
    }),
  ).toBe(true);
}

async function expectFixedFrame(page: Page) {
  expect(
    await page
      .locator('.explorer')
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBe(640);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(
    640,
  );
  const request = page.getByRole('textbox', { name: 'Analysis request' });
  await expectReachable(request);
  await request.click();
  await expect(request).toBeFocused();
}

for (const width of [320, 900]) {
  test(`expanded report keeps entries, pagination and copy reachable at ${width}px @smoke`, async ({
    page,
  }) => {
    await openReport(page, width);
    await expandSummary(page);
    expect(
      await page
        .locator('.entries-scroll')
        .evaluate((element) => element.clientHeight),
    ).toBeGreaterThanOrEqual(96);
    const second = page.getByRole('checkbox', {
      name: 'Select f0:a1',
      exact: true,
    });
    await expectReachable(second);
    await second.check();
    await expect(second).toBeChecked();
    const entry = page.locator('.entry-button').first();
    await expectReachable(entry);
    await entry.click();
    if (width < 620)
      await page.getByRole('button', { name: 'Back to entries' }).click();
    const next = page.getByRole('button', {
      name: 'Next entries',
      exact: true,
    });
    await expectReachable(next);
    await next.click();
    await expect(page.locator('.entry-button')).toHaveCount(1);
    const previous = page.getByRole('button', {
      name: 'Previous entries',
      exact: true,
    });
    await expectReachable(previous);
    await previous.click();
    await expect(page.locator('.entry-button')).toHaveCount(25);
    await expectFixedFrame(page);
  });

  test(`expanded report keeps diagnostics and fragment pagination reachable at ${width}px @smoke`, async ({
    page,
  }) => {
    await openReport(page, width);
    await page.locator('.entry-button').first().click();
    await expandSummary(page);
    await expect(page.locator('.detail-scroll pre')).toContainText(
      'Diagnostic line 0',
    );
    expect(
      await page
        .locator('.detail-scroll')
        .evaluate((element) => element.clientHeight),
    ).toBeGreaterThanOrEqual(96);
    const next = page.getByRole('button', { name: 'Next detail fragment' });
    await expectReachable(next);
    await next.click();
    await expect(page.locator('.detail-scroll pre')).not.toContainText(
      'Diagnostic line 0:',
    );
    const previous = page.getByRole('button', {
      name: 'Previous detail fragment',
    });
    await expectReachable(previous);
    await previous.click();
    await expect(page.locator('.detail-scroll pre')).toContainText(
      'Diagnostic line 0',
    );
    await expectFixedFrame(page);
  });
}
