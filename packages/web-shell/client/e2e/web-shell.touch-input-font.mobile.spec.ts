/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Page } from '@playwright/test';

const landscapeTablet = { width: 1024, height: 768 };

// Playwright's Linux WebKit and Chromium may not expose the iOS Safari
// feature gate. Open only that gate when missing to test the actual selectors,
// stylesheet adoption and pointer condition in those engines. This does not
// test native iOS feature detection or focus zoom.
async function enableSafariRuleForTest(page: Page) {
  await page.evaluate(() => {
    const shadow = document.querySelector(
      '[data-web-shell-shadow-host="portals"]',
    )?.shadowRoot;
    const sheets = [
      ...document.styleSheets,
      ...document.adoptedStyleSheets,
      ...(shadow?.styleSheets ?? []),
      ...(shadow?.adoptedStyleSheets ?? []),
    ];
    for (const sheet of new Set(sheets)) {
      Array.from(sheet.cssRules).forEach((rule, index) => {
        if (
          rule instanceof CSSSupportsRule &&
          /^\(-webkit-touch-callout:\s*none\)$/.test(rule.conditionText)
        ) {
          const body = Array.from(rule.cssRules, (child) => child.cssText).join(
            '\n',
          );
          sheet.deleteRule(index);
          sheet.insertRule(`@supports (display: block) { ${body} }`, index);
        }
      });
    }
  });
}

function harnessUrl(entry: string, dialog: string, shadow: boolean) {
  return `/e2e/touch-input-font-harness.html?entry=${entry}&dialog=${dialog}${
    shadow ? '&shadow' : ''
  }`;
}

for (const entry of ['standalone', 'embedded'] as const) {
  for (const dialog of ['skill', 'runtime'] as const) {
    for (const shadow of [false, true]) {
      const destination = shadow ? 'shadow portal' : 'document portal';
      test(`${entry} ${dialog} inputs reach 16px in the ${destination} @smoke`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize(landscapeTablet);
        await page.goto(harnessUrl(entry, dialog, shadow));

        const portal = page.locator('[data-web-shell-portal-root]');
        const input = portal.locator('input[data-slot="input"]:not([type])');
        await expect(input).toHaveCount(1);
        const media = await page.evaluate(() => ({
          coarse: matchMedia('(hover: none) and (pointer: coarse)').matches,
          landscape: matchMedia('(min-width: 768px)').matches,
          safari: CSS.supports('-webkit-touch-callout', 'none'),
        }));
        expect(media.coarse).toBe(true);
        expect(media.landscape).toBe(true);
        if (!media.safari) {
          testInfo.annotations.push({
            type: 'emulated Safari feature gate',
            description: 'This browser does not support -webkit-touch-callout.',
          });
          await enableSafariRuleForTest(page);
        }
        await expect(input).toHaveCSS('font-size', '16px');
        for (const field of ['App search', 'App textarea', 'App editor']) {
          await expect(page.getByLabel(field, { exact: true })).toHaveCSS(
            'font-size',
            '16px',
          );
        }
        await expect(page.locator('.cm-line')).toHaveCSS('font-size', '16px');
        await expect(page.getByLabel('Host input')).toHaveCSS(
          'font-size',
          '14px',
        );
      });
    }
  }
}

test.describe('desktop pointer', () => {
  test.use({ hasTouch: false, isMobile: false, viewport: landscapeTablet });

  test('keeps desktop portal fields at the compact size @smoke', async ({
    page,
  }) => {
    await page.goto(harnessUrl('embedded', 'skill', true));
    const input = page.locator(
      '[data-web-shell-portal-root] input[data-slot="input"]:not([type])',
    );
    await expect(input).toHaveCount(1);
    const media = await page.evaluate(() => ({
      coarse: matchMedia('(pointer: coarse)').matches,
      safari: CSS.supports('-webkit-touch-callout', 'none'),
    }));
    expect(media.coarse).toBe(false);
    // Isolate the pointer check from the vendor feature check.
    if (!media.safari) await enableSafariRuleForTest(page);
    await expect(input).toHaveCSS('font-size', '14px');
  });
});
