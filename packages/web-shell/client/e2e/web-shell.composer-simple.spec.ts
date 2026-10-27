/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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

async function openComposerHarness(
  page: Page,
  testInfo: TestInfo,
  {
    voice = false,
    tags = true,
    variant = 'simple',
  }: { voice?: boolean; tags?: boolean; variant?: 'simple' | 'default' } = {},
) {
  const scenario = createWebShellDaemonScenario(
    voice
      ? {
          capabilities: { features: ['voice_transcribe', 'workspace_voice'] },
          voice: { enabled: true, mode: 'tap' },
        }
      : {},
  );
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(
    `/e2e/composer-layout-harness.html?composerVariant=${variant}&tags=${tags}&sessionId=${scenario.sessionId}`,
  );
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId, replayedCount: 0 }),
  );
  return { composer: page.locator('[data-web-shell-composer]'), daemon };
}

async function expectInsideComposer(control: Locator, content: Locator) {
  await expect(control).toBeVisible();
  const viewport = control.page().viewportSize()!;
  await expect
    .poll(
      async () => {
        const box = await control.boundingBox();
        const outer = await content.boundingBox();
        if (!box || !outer) return false;
        return (
          box.x >= Math.max(0, outer.x) - 1 &&
          box.y >= Math.max(0, outer.y) - 1 &&
          box.x + box.width <=
            Math.min(viewport.width, outer.x + outer.width) + 1 &&
          box.y + box.height <=
            Math.min(viewport.height, outer.y + outer.height) + 1
        );
      },
      { message: 'The entire element stays inside its container and viewport' },
    )
    .toBe(true);
}

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

for (const touch of [false, true]) {
  test.describe(`${touch ? 'touch' : 'desktop'} short viewport`, () => {
    test.use({
      viewport: { width: touch ? 390 : 600, height: 500 },
      hasTouch: touch,
      isMobile: touch,
    });

    test('keeps actions and the final draft line reachable with 18 tags @smoke', async ({
      page,
    }, testInfo) => {
      const { composer, daemon } = await openComposerHarness(page, testInfo);
      const editor = composer.locator(
        touch
          ? 'textarea[data-web-shell-composer-editor]'
          : '.cm-content[contenteditable="true"]',
      );
      const content = composer.locator('[data-web-shell-composer-content]');
      const send = composer.locator('[data-web-shell-composer-submit]');
      const add = composer.getByTestId('composer-add-menu-trigger');
      const tags = composer.locator('[data-web-shell-composer-tag]');
      const draft = Array.from(
        { length: 30 },
        (_, index) => `Draft line ${index + 1}`,
      ).join('\n');
      await expect(editor).toBeEditable();
      await expect(tags).toHaveCount(18);
      const original = await editor.elementHandle();
      await editor.fill(draft);
      await expect(send).toBeEnabled();
      await expectInsideComposer(send, content);
      await expectInsideComposer(add, content);

      if (touch) {
        await composer.locator('[data-web-shell-composer-expand]').click();
        await expect(composer).toHaveAttribute(
          'data-web-shell-composer-variant',
          'default',
        );
        await expect(editor).toHaveValue(draft);
        await expectInsideComposer(send, content);
        await composer.locator('[data-web-shell-composer-collapse]').click();
        await expect(composer).toHaveAttribute(
          'data-web-shell-composer-variant',
          'simple',
        );
        expect(
          await editor.evaluate((node, before) => node === before, original),
        ).toBe(true);
        await expect(editor).toHaveValue(draft);
        await expect(tags).toHaveCount(18);
        await expectInsideComposer(send, content);
        await expectInsideComposer(add, content);
        await editor.evaluate((node: HTMLTextAreaElement) => {
          node.scrollTop = node.scrollHeight;
        });
        expect(
          await editor.evaluate(
            (node: HTMLTextAreaElement) =>
              node.scrollHeight > node.clientHeight &&
              node.scrollTop > 0 &&
              node.scrollTop + node.clientHeight >= node.scrollHeight - 1,
          ),
        ).toBe(true);
      } else {
        const scroller = composer.locator('.cm-scroller');
        await scroller.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        await expectInsideComposer(
          editor.locator('.cm-line').filter({ hasText: /^Draft line 30$/ }),
          scroller,
        );
        expect(
          await scroller.evaluate((node) => node.scrollTop),
        ).toBeGreaterThan(0);
      }
      expect(daemon.promptRequests()).toHaveLength(0);
    });
  });
}

test.describe('dictation completion', () => {
  for (const { touch, fallback, variant } of [
    { touch: false, fallback: false, variant: 'simple' },
    { touch: true, fallback: false, variant: 'simple' },
    { touch: true, fallback: true, variant: 'simple' },
    { touch: true, fallback: true, variant: 'default' },
  ] as const) {
    test.describe(`${touch ? 'touch' : 'desktop'} ${variant} ${fallback ? 'fallback' : 'native'}`, () => {
      test.use({
        viewport: { width: touch ? 390 : 600, height: 844 },
        hasTouch: touch,
        isMobile: touch,
      });

      test('restores the same editor, focus, and multiline transcript height @smoke', async ({
        page,
        browserName,
      }, testInfo) => {
        test.skip(browserName !== 'chromium', 'Uses Chromium fake media');
        if (fallback) {
          await page.addInitScript(() => {
            const supports = CSS.supports.bind(CSS);
            CSS.supports = (property: string, value?: string) =>
              property === 'field-sizing'
                ? false
                : value === undefined
                  ? supports(property)
                  : supports(property, value);
          });
        }
        const transcript = Array.from(
          { length: 8 },
          (_, index) => `Transcript line ${index + 1}`,
        ).join('\n');
        const commands: string[] = [];
        await page.routeWebSocket(/\/voice\/stream(?:\?|$)/, (socket) => {
          socket.onMessage((message) => {
            if (typeof message !== 'string') return;
            const { type } = JSON.parse(message) as { type: string };
            commands.push(type);
            if (type === 'stop') {
              socket.send(JSON.stringify({ type: 'final', text: transcript }));
            }
          });
        });
        const { composer, daemon } = await openComposerHarness(page, testInfo, {
          voice: true,
          tags: false,
          variant,
        });
        const editor = composer.locator(
          touch
            ? 'textarea[data-web-shell-composer-editor]'
            : '.cm-content[contenteditable="true"]',
        );
        await expect(editor).toBeVisible();
        if (fallback) {
          await page.addStyleTag({
            content:
              'textarea[data-web-shell-composer-editor] { field-sizing: fixed !important; }',
          });
          await expect(editor).toHaveCSS('field-sizing', 'fixed');
          expect(
            await page.evaluate(() => CSS.supports('field-sizing', 'content')),
          ).toBe(false);
        }
        const original = await editor.elementHandle();
        await composer
          .getByRole('button', { name: 'Start voice dictation', exact: true })
          .click();
        const stop = composer.getByRole('button', {
          name: 'Stop dictation',
          exact: true,
        });
        await expect(stop).toBeVisible();
        if (variant === 'simple') await expect(editor).toBeHidden();
        await stop.click();
        await expect(editor).toBeVisible();
        expect(
          await editor.evaluate((node, before) => node === before, original),
        ).toBe(true);
        if (touch) {
          await expect(editor).toHaveValue(`${transcript} `);
          await expect
            .soft(
              editor,
              'Dictation returns focus after the editor is revealed',
            )
            .toBeFocused();
          await expect
            .poll(async () => (await editor.boundingBox())!.height)
            .toBeGreaterThan(100);
          expect((await editor.boundingBox())!.height).toBeLessThanOrEqual(
            variant === 'simple' ? 201 : 301,
          );
        } else {
          await expect(editor.locator('.cm-line')).toHaveText(
            transcript.split('\n'),
          );
          await expect(editor).toBeFocused();
        }
        await expect(
          composer.locator('[data-web-shell-composer-submit]'),
        ).toBeEnabled();
        expect(commands).toEqual(['start', 'stop']);
        expect(daemon.promptRequests()).toHaveLength(0);
      });
    });
  }
});
