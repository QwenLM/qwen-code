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
    await expect(page.getByText('Loading...', { exact: true })).toHaveCount(0);

    for (const width of [1200, 360]) {
      await page.setViewportSize({ width, height: 844 });
      const row = (await content.boundingBox())!;
      const addBox = (await add.boundingBox())!;
      const editorBox = (await editor.boundingBox())!;
      const sendBox = (await send.boundingBox())!;
      expect(row.height).toBeLessThanOrEqual(72);
      expect(addBox.x + addBox.width).toBeLessThanOrEqual(editorBox.x + 1);
      expect(editorBox.x + editorBox.width).toBeLessThanOrEqual(sendBox.x + 1);
      expect(addBox.y).toBeLessThan(row.y + row.height);
      expect(sendBox.y).toBeLessThan(row.y + row.height);
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

test('simple add menu exposes model controls to keyboard users', async ({
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
  const model = page.locator('[data-web-shell-model-button]');
  await expect(model).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(model).toBeHidden();
  await expect(add).toBeFocused();
  await page.keyboard.press('Enter');
  for (let step = 0; step < 20; step += 1) {
    if (await model.evaluate((element) => element === document.activeElement))
      break;
    await page.keyboard.press('Tab');
  }
  await expect(model).toBeFocused();
  await page.keyboard.press('Enter');
  const picker = page.locator('[data-web-shell-toolbar-popover]');
  await expect(picker).toBeVisible();
  await expect(picker.locator('input[type="search"]')).toBeFocused();
  await page.keyboard.type('Alt');
  await page.keyboard.press('Tab');
  await expect(
    picker.getByRole('button', { name: 'Qwen Test Alt', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => daemon.modelRequests().length).toBe(1);
  expect(JSON.stringify(daemon.modelRequests()[0].body)).toContain(
    'qwen-test-alt',
  );
  await page.keyboard.press('Escape');
  await expect(model).toBeHidden();
});
