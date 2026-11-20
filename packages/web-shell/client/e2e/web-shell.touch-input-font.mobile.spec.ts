/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Page } from '@playwright/test';

const landscapeTablet = { width: 1024, height: 768 };

// Chromium does not implement -webkit-touch-callout. Open only its feature
// gate in the test (in both the document and the adopted shadow sheets).
// Keep the production declarations, selectors and pointer condition intact.
async function enableSafariRuleInChromium(page: Page) {
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
        browserName,
        page,
      }) => {
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
        if (browserName === 'webkit') {
          test.skip(
            !media.safari,
            'This WebKit build lacks the Safari feature gate',
          );
        } else {
          await enableSafariRuleInChromium(page);
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

test('keeps desktop portal fields at the compact size @smoke', async ({
  browser,
  browserName,
  baseURL,
}) => {
  const page = await browser.newPage({ baseURL, viewport: landscapeTablet });
  try {
    await page.goto(harnessUrl('embedded', 'skill', true));
    const input = page.locator(
      '[data-web-shell-portal-root] input[data-slot="input"]:not([type])',
    );
    await expect(input).toHaveCount(1);
    expect(
      await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
    ).toBe(false);
    // Isolate the pointer check from the vendor feature check.
    if (browserName === 'chromium') await enableSafariRuleInChromium(page);
    await expect(input).toHaveCSS('font-size', '14px');
  } finally {
    await page.close();
  }
});
