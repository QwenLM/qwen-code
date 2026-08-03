/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Locator } from '@playwright/test';

for (const kind of ['bash', 'execute'] as const) {
  test(`keeps collapsible ${kind} output inside the message layout @smoke`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await page.goto(`/e2e/webui-tool-output-layout-harness.html?kind=${kind}`);

    const messages = page.locator('.chat-viewer-messages');
    const output = page.locator(`.${kind}-toolcall-output-subtle`);
    const toggle = page.locator('button[aria-expanded]');

    await expect(messages).toBeVisible();
    await expect(output).toBeVisible();
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-label', 'Expand output');

    const collapsed = await readOverflowMetrics(messages, output);
    expect(collapsed.outputScrollWidth).toBeGreaterThan(
      collapsed.outputClientWidth,
    );
    expect(collapsed.messagesScrollWidth).toBe(collapsed.messagesClientWidth);

    const messagesBox = await messages.boundingBox();
    const toggleBox = await toggle.boundingBox();
    if (!messagesBox || !toggleBox) {
      throw new Error('Expected visible message and toggle bounding boxes.');
    }
    expect(toggleBox.x).toBeGreaterThanOrEqual(messagesBox.x);
    expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(
      messagesBox.x + messagesBox.width,
    );

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const expanded = await readOverflowMetrics(messages, output);
    expect(expanded.outputScrollWidth).toBeGreaterThan(
      expanded.outputClientWidth,
    );
    expect(expanded.messagesScrollWidth).toBe(expanded.messagesClientWidth);

    const reachableScrollLeft = await output.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
      return element.scrollLeft;
    });
    expect(reachableScrollLeft).toBeGreaterThan(0);
  });
}

async function readOverflowMetrics(messages: Locator, output: Locator) {
  const messagesMetrics = await messages.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  const outputMetrics = await output.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));

  return {
    messagesClientWidth: messagesMetrics.clientWidth,
    messagesScrollWidth: messagesMetrics.scrollWidth,
    outputClientWidth: outputMetrics.clientWidth,
    outputScrollWidth: outputMetrics.scrollWidth,
  };
}
