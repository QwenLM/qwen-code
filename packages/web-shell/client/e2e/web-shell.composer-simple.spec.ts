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
} from './utils/mockDaemon';

for (const theme of ['light', 'dark']) {
  test(`simple composer keeps its resting row compact in ${theme} theme`, async ({
    page,
  }, testInfo) => {
    const scenario = createWebShellDaemonScenario();
    const daemon = await installMockDaemon(page, scenario, {
      baseURL: String(testInfo.project.use.baseURL),
    });
    await page.goto(
      `/e2e/composer-layout-harness.html?composerVariant=simple&tags=false&theme=${theme}&sessionId=${scenario.sessionId}`,
    );
    const connection = await daemon.sse.waitForConnection(scenario.sessionId);
    await daemon.sendEvent(
      replayCompleteEvent({
        sessionId: connection.sessionId,
        replayedCount: 0,
      }),
    );
    const composer = page.locator('[data-web-shell-composer-variant="simple"]');
    const content = composer.locator('[data-web-shell-composer-content]');
    const editor = composer.locator('[data-web-shell-composer-editor]');
    const add = composer.getByTestId('composer-add-menu-trigger');
    const send = composer.locator('[data-web-shell-composer-submit]');
    await expect(editor).toBeVisible();
    await expect(send).toBeVisible();
    await expect(send).toBeDisabled();
    await expect(composer.locator('button:visible')).toHaveCount(2);
    await expect(page.getByText('Loading...', { exact: true })).toHaveCount(0);

    for (const width of [1200, 360]) {
      await page.setViewportSize({ width, height: 844 });
      const row = (await content.boundingBox())!;
      const addBox = (await add.boundingBox())!;
      const editorBox = (await editor.boundingBox())!;
      const primaryBox = (await send.boundingBox())!;
      expect(row.height).toBeLessThanOrEqual(72);
      expect(addBox.x + addBox.width).toBeLessThanOrEqual(editorBox.x + 1);
      expect(editorBox.x + editorBox.width).toBeLessThanOrEqual(
        primaryBox.x + 1,
      );
      expect(addBox.y).toBeLessThan(row.y + row.height);
      expect(primaryBox.y).toBeLessThan(row.y + row.height);
      expect(
        await content.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await expect(
        composer.locator('[data-web-shell-model-button]'),
      ).toHaveCount(0);
      await expect(
        composer.locator('[data-web-shell-mode-button]'),
      ).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Start voice dictation' }),
      ).toHaveCount(0);
    }
    await page.screenshot({ path: testInfo.outputPath(`simple-${theme}.png`) });
  });
}

test('simple composer switches between available dictation and send', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () => new Promise(() => undefined),
      },
    });
  });
  const scenario = createWebShellDaemonScenario({
    capabilities: {
      features: ['voice_transcribe', 'workspace_voice'],
    },
    voice: { enabled: true },
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(
    `/e2e/composer-layout-harness.html?composerVariant=simple&tags=false&sessionId=${scenario.sessionId}`,
  );
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId, replayedCount: 0 }),
  );
  const composer = page.locator('[data-web-shell-composer-variant="simple"]');
  const editor = composer.locator('.cm-content[contenteditable="true"]');
  const microphone = composer.getByRole('button', {
    name: 'Start voice dictation',
    exact: true,
  });
  const send = composer.locator('[data-web-shell-composer-submit]');
  await expect(microphone).toBeVisible();
  await expect(microphone).toBeEnabled();
  await expect(send).toBeHidden();
  await expect(composer.locator('button:visible')).toHaveCount(2);

  await editor.fill('Ready to send');
  await expect(microphone).toBeHidden();
  await expect(send).toBeVisible();
  await expect(send).toBeEnabled();
  await expect(composer.locator('button:visible')).toHaveCount(2);

  await editor.fill('');
  await expect(microphone).toBeVisible();
  await expect(send).toBeHidden();
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('simple composer grows, submits, and cancels through the existing session', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(
    `/e2e/composer-layout-harness.html?composerVariant=simple&tags=false&sessionId=${scenario.sessionId}`,
  );
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId, replayedCount: 0 }),
  );
  const composer = page.locator('[data-web-shell-composer-variant="simple"]');
  const content = composer.locator('[data-web-shell-composer-content]');
  const editor = composer.locator('.cm-content[contenteditable="true"]');
  await expect(editor).toBeEditable();
  const restingHeight = (await content.boundingBox())!.height;
  const prompt = 'First line\n第二行\nThird line\nFourth line';
  await editor.fill(prompt);
  await expect
    .poll(async () => (await content.boundingBox())!.height)
    .toBeGreaterThan(restingHeight);
  const send = composer.locator('[data-web-shell-composer-submit]');
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  expect(JSON.stringify(daemon.promptRequests()[0].body)).toContain('第二行');
  await expect(editor.locator('.cm-placeholder')).toBeVisible();
  await expect(send).toBeEnabled();
  await send.click();
  await expect
    .poll(
      () =>
        daemon.requests.filter((request) => request.path.endsWith('/cancel'))
          .length,
    )
    .toBe(1);
});

test('simple add menu remains keyboard accessible without advanced controls', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(
    `/e2e/composer-layout-harness.html?composerVariant=simple&tags=false&sessionId=${scenario.sessionId}`,
  );
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId, replayedCount: 0 }),
  );
  const add = page.getByTestId('composer-add-menu-trigger');
  await expect(add).toBeEnabled();
  await add.focus();
  await page.keyboard.press('Enter');
  const fileMenu = page.getByTestId('composer-add-menu-file');
  await expect(fileMenu).toBeFocused();
  await expect(page.locator('[data-web-shell-model-button]')).toHaveCount(0);
  await expect(page.locator('[data-web-shell-mode-button]')).toHaveCount(0);
  await expect(page.getByTestId('composer-add-menu-plan')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('composer-add-menu-file-attach')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(fileMenu).toBeHidden();
  await expect(add).toBeFocused();
});
