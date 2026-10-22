/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

const labels = {
  en: {
    start: 'Start voice dictation',
    stop: 'Stop dictation',
    dismiss: 'Dismiss voice message',
    error: 'No voice model is configured for this workspace.',
    noSpeech: 'No speech detected.',
    permission:
      'Microphone blocked. Click the camera/lock icon in the address bar to allow the mic for this site, and enable your browser under System Settings → Privacy → Microphone, then retry.',
  },
  'zh-CN': {
    start: '开始语音输入',
    stop: '停止语音输入',
    dismiss: '关闭语音提示',
    error: '当前工作区未配置语音模型。',
    noSpeech: '未检测到语音。',
    permission:
      '麦克风权限被阻止。请点击地址栏中的摄像头或锁图标，允许此网站使用麦克风，并在系统设置 → 隐私 → 麦克风中允许浏览器使用麦克风，然后重试。',
  },
} as const;

async function openVoiceSession(
  page: Page,
  testInfo: TestInfo,
  language: keyof typeof labels,
) {
  await page.addInitScript((language) => {
    localStorage.setItem('qwen-code-web-shell-language', language);
  }, language);
  const scenario = createWebShellDaemonScenario({
    voice: { enabled: true, mode: 'tap' },
  });
  scenario.capabilities.features.push('voice_transcribe');
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}`);
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId, replayedCount: 0 }),
  );
  await expect(
    page.getByRole('button', { name: labels[language].start, exact: true }),
  ).toBeVisible();
}

for (const language of ['en', 'zh-CN'] as const) {
  test(`localizes and dismisses voice errors, then permits retry (${language})`, async ({
    page,
  }, testInfo) => {
    let connections = 0;
    await page.routeWebSocket(/\/voice\/stream(?:\?|$)/, (ws) => {
      connections++;
      ws.onMessage((message) => {
        if (typeof message !== 'string') return;
        if (JSON.parse(message).type === 'start') {
          ws.send(
            JSON.stringify({
              type: 'error',
              message: labels.en.error,
            }),
          );
        }
      });
    });
    await openVoiceSession(page, testInfo, language);
    const idle = page.getByRole('button', {
      name: labels[language].start,
      exact: true,
    });
    const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
    await editor.click();
    await page.keyboard.insertText('Keep this draft');
    const idleColor = await idle.evaluate(
      (node) => getComputedStyle(node).color,
    );
    await idle.click();
    const bubble = page.getByText(labels[language].error, { exact: true });
    await expect(bubble).toBeVisible();
    const retry = page.getByRole('button', {
      name: new RegExp(
        labels[language].error.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      ),
    });
    await expect(retry).toHaveAttribute('title', labels[language].error);
    await page.mouse.move(0, 0);
    await expect
      .poll(() => retry.evaluate((node) => getComputedStyle(node).color))
      .not.toBe(idleColor);
    await page.screenshot({
      path: testInfo.outputPath(`voice-error-${language}.png`),
    });
    if (language === 'zh-CN') {
      await page.locator('[data-web-shell-composer-surface]').screenshot({
        path: testInfo.outputPath('voice-error-zh-CN-composer.png'),
      });
    }
    const dismiss = page.getByRole('button', {
      name: labels[language].dismiss,
      exact: true,
    });
    await expect(dismiss).toBeVisible();
    if (language === 'en') await dismiss.click();
    else {
      await dismiss.focus();
      await page.keyboard.press('Enter');
    }
    await expect(bubble).toHaveCount(0);
    await expect(idle).toBeVisible();
    await page.mouse.move(0, 0);
    await expect
      .poll(() => idle.evaluate((node) => getComputedStyle(node).color))
      .toBe(idleColor);
    expect(connections).toBe(1);
    await expect(editor).toHaveText('Keep this draft');
    await page.screenshot({
      path: testInfo.outputPath(`voice-dismissed-${language}.png`),
    });
    if (language === 'zh-CN') {
      await page.locator('[data-web-shell-composer-surface]').screenshot({
        path: testInfo.outputPath('voice-dismissed-zh-CN-composer.png'),
      });
    }
    await idle.click();
    await expect(bubble).toBeVisible();
    expect(connections).toBe(2);
  });

  test(`localizes and dismisses no-speech feedback (${language})`, async ({
    page,
  }, testInfo) => {
    let connections = 0;
    await page.routeWebSocket(/\/voice\/stream(?:\?|$)/, (ws) => {
      connections++;
      ws.onMessage((message) => {
        if (typeof message !== 'string') return;
        const type = JSON.parse(message).type;
        if (type === 'start')
          ws.send(JSON.stringify({ type: 'interim', text: '' }));
        if (type === 'stop')
          ws.send(JSON.stringify({ type: 'final', text: '' }));
      });
    });
    await openVoiceSession(page, testInfo, language);
    await page
      .getByRole('button', { name: labels[language].start, exact: true })
      .click();
    await page
      .getByRole('button', { name: labels[language].stop, exact: true })
      .click();
    const notice = page.getByText(labels[language].noSpeech, { exact: true });
    await expect(notice).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`voice-no-speech-${language}.png`),
    });
    await page
      .getByRole('button', { name: labels[language].dismiss, exact: true })
      .click();
    await expect(notice).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: labels[language].start, exact: true }),
    ).toBeVisible();
    expect(connections).toBe(1);
  });

  test(`keeps long voice feedback and close control within a narrow viewport (${language})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException('Permission denied', 'NotAllowedError');
      };
    });
    await openVoiceSession(page, testInfo, language);
    await page
      .getByRole('button', { name: labels[language].start, exact: true })
      .click();
    const text = page.getByText(labels[language].permission, { exact: true });
    const dismiss = page.getByRole('button', {
      name: labels[language].dismiss,
      exact: true,
    });
    await expect(text).toBeVisible();
    await expect(dismiss).toBeVisible();
    const box = (await text.boundingBox())!;
    const closeBox = (await dismiss.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(closeBox.x).toBeGreaterThan(box.x + box.width / 2);
    expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(390);
    expect(closeBox.y).toBeLessThan(box.y + box.height / 2);
    await page.screenshot({
      path: testInfo.outputPath(`voice-permission-narrow-${language}.png`),
    });
    await dismiss.click();
    await expect(text).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: labels[language].start, exact: true }),
    ).toBeVisible();
  });
}
