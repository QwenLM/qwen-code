/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  toolCallEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

for (const lineCount of [3, 20]) {
  test(`wrapped ${lineCount}-line diff remains scrollable in a short review panel`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    const diff = `@@ -0,0 +1,${lineCount} @@\n${Array.from(
      { length: lineCount },
      (_, i) => `+    ${i}-${'long-path/'.repeat(30)}`,
    ).join('\n')}`;
    const scenario = createWebShellDaemonScenario({
      events: [
        userTextEvent('Update these files.', { id: 1 }),
        ...Array.from({ length: 12 }, (_, i) =>
          toolCallEvent(
            `edit-${i}`,
            'edit',
            { file_path: `src/file-${i}.ts` },
            {
              id: i + 2,
              rawOutput: { fileName: `src/file-${i}.ts`, fileDiff: diff },
            },
          ),
        ),
        turnCompleteEvent('edit-files', { id: 14 }),
      ],
    });
    const daemon = await installMockDaemon(page, scenario, {
      baseURL: String(testInfo.project.use.baseURL),
    });
    await page.goto(`/session/${scenario.sessionId}?language=en`);
    await daemon.sse.waitForConnection(scenario.sessionId);
    await daemon.sendEvent(
      replayCompleteEvent({ sessionId: scenario.sessionId }),
    );
    await page.getByRole('button', { name: 'Toggle right panel' }).click();
    await page
      .getByRole('complementary', { name: 'Right panel' })
      .getByRole('button', { name: /^Changes/ })
      .click();
    await page
      .getByRole('button', { name: 'src/file-0.ts', exact: true })
      .click();

    const lines = page.getByLabel('File diff', { exact: true }).last();
    await expect(lines).toBeVisible();
    const dimensions = await lines.evaluate((element) => ({
      height: element.clientHeight,
      scrollHeight: element.scrollHeight,
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
      viewHeight: element.parentElement!.clientHeight,
      viewScrollHeight: element.parentElement!.scrollHeight,
    }));
    expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.height);
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
    expect(dimensions.viewScrollHeight).toBeLessThanOrEqual(
      dimensions.viewHeight,
    );
    await lines.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() => lines.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    const lastRow = lines.locator(':scope > div').last();
    const bottom = await lastRow.boundingBox();
    const viewport = await lines.boundingBox();
    expect(bottom!.y + bottom!.height).toBeLessThanOrEqual(
      viewport!.y + viewport!.height + 1,
    );
    await page.screenshot({
      path: testInfo.outputPath(`diff-${lineCount}-lines.png`),
    });
  });
}
