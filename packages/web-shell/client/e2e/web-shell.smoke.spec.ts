import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  permissionRequestEvent,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
  type DaemonRequestRecord,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

const COMPOSER_VIEWPORT_HEIGHTS = [1000, 800, 600] as const;

test('loads replayed transcript and connects to fake daemon @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Hello from replay', { id: 1 }),
      assistantTextEvent('Hello from fake daemon', { id: 2 }),
      turnCompleteEvent('prompt-replay', { id: 3 }),
    ],
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);

  await expect(page.locator('[data-web-shell-message-list]')).toContainText(
    'Hello from replay',
  );
  await expect(page.locator('[data-web-shell-message-list]')).toContainText(
    'Hello from fake daemon',
  );
});

test('submits a prompt and renders a streamed assistant response @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  await fillComposer(page, 'Ping from browser smoke');
  await page.locator('[data-web-shell-composer-submit]').click();

  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  const promptRequest = firstRequest(daemon.promptRequests());
  expect(promptRequest.method).toBe('POST');
  expect(promptRequest.path).toBe(`/session/${scenario.sessionId}/prompt`);
  expectPromptBodyToContainText(
    requestBodyRecord(promptRequest),
    'Ping from browser smoke',
  );

  await daemon.sse.split(assistantTextEvent('Pong from fake SSE', { id: 10 }));
  await daemon.sendEvent(turnCompleteEvent('prompt-e2e', { id: 11 }));

  await expect(page.locator('[data-web-shell-message-list]')).toContainText(
    'Pong from fake SSE',
  );
});

test('keeps later SSE connections alive when an earlier one is cancelled @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  await page.reload();
  await daemon.sse.waitForConnection(scenario.sessionId);
  await completeReplay(page, daemon, scenario.sessionId);
  await fillComposer(page, 'Second connection should still stream');
  await page.locator('[data-web-shell-composer-submit]').click();

  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  await daemon.sse.split(
    assistantTextEvent('Reconnect-safe SSE payload', { id: 20 }),
  );
  await daemon.sendEvent(turnCompleteEvent('prompt-reconnect', { id: 21 }));

  await expect(page.locator('[data-web-shell-message-list]')).toContainText(
    'Reconnect-safe SSE payload',
  );
});

test('clears fake SSE connection records when streams close or error @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  const baseURL = String(testInfo.project.use.baseURL);

  await page.goto('data:text/html,<html></html>');
  await openRawSseConnection(page, baseURL, scenario.sessionId);
  const firstConnection = await daemon.sse.waitForConnection(
    scenario.sessionId,
  );
  expect(firstConnection.sessionId).toBe(scenario.sessionId);

  await daemon.sse.close();
  await expect
    .poll(async () => (await daemon.sse.connections()).length)
    .toBe(0);

  await openRawSseConnection(page, baseURL, scenario.sessionId);
  const secondConnection = await daemon.sse.waitForConnection(
    scenario.sessionId,
  );
  expect(secondConnection.sessionId).toBe(scenario.sessionId);

  await daemon.sse.error('test SSE error');
  await expect
    .poll(async () => (await daemon.sse.connections()).length)
    .toBe(0);
});

test('submits permission decisions through the fake daemon @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    events: [permissionRequestEvent('perm-1', { id: 1 })],
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);

  await expect(page.locator('[data-web-shell-permission-panel]')).toBeVisible();
  await page
    .locator('[data-web-shell-permission-option][data-option-id="allow_once"]')
    .click();

  await expect.poll(() => daemon.permissionRequests().length).toBe(1);
  const permissionRequest = firstRequest(daemon.permissionRequests());
  expect(permissionRequest.method).toBe('POST');
  expect(permissionRequest.path).toBe(
    `/session/${scenario.sessionId}/permission/perm-1`,
  );
  expect(requestBodyRecord(permissionRequest)).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });
});

test('opens slash menu, resume dialog, model dialog, and theme dialog @smoke', async ({
  page,
}, testInfo) => {
  const resumedSessionId = 'previous-session';
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  await fillComposer(page, '/');
  await expect(page.locator('[data-web-shell-slash-menu]')).toBeVisible();
  const composingEscapePrevented = await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    (document.activeElement ?? document.body).dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(composingEscapePrevented).toBe(false);
  await expect(page.locator('[data-web-shell-slash-menu]')).toBeVisible();

  await submitLocalCommand(page, '/resume');
  await expect(page.locator('[data-web-shell-resume-dialog]')).toBeVisible();
  await page
    .locator(
      `[data-web-shell-resume-session][data-session-id="${resumedSessionId}"]`,
    )
    .click();
  await expect(page.locator('[data-web-shell-resume-dialog]')).toHaveCount(0);
  await completeReplay(page, daemon, resumedSessionId);

  await submitLocalCommand(page, '/model');
  await expect(page.locator('[data-web-shell-model-dialog]')).toBeVisible();
  await page
    .locator('[data-web-shell-model-option][data-model-id="qwen-test-alt"]')
    .click();
  await expect(page.locator('[data-web-shell-model-dialog]')).toHaveCount(0);
  await expect.poll(() => daemon.modelRequests().length).toBe(1);
  const modelRequest = firstRequest(daemon.modelRequests());
  expect(modelRequest.method).toBe('POST');
  expect(modelRequest.path).toBe(`/session/${resumedSessionId}/model`);
  expect(requestBodyRecord(modelRequest)).toEqual({
    modelId: 'qwen-test-alt',
  });

  await page.reload();
  await completeReplay(page, daemon);
  await submitLocalCommand(page, '/model');
  await expect(page.locator('[data-web-shell-model-dialog]')).toBeVisible();
  await expect(
    page.locator(
      '[data-web-shell-model-option][data-model-id="qwen-test-alt"]',
    ),
  ).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'close' }).click();
  await expect(page.locator('[data-web-shell-model-dialog]')).toHaveCount(0);

  await submitLocalCommand(page, '/theme');
  await expect(page.locator('[data-web-shell-theme-dialog]')).toBeVisible();
  await page
    .locator('[data-web-shell-theme-option][data-theme-id="light"]')
    .click();
  await expect(page.locator('[data-web-shell-theme-dialog]')).toHaveCount(0);
});

test('selects and scrolls scheduled-task prompt references @smoke', async ({
  page,
}, testInfo) => {
  const extensions = Array.from({ length: 20 }, (_, index) => ({
    id: `extension-${index + 1}`,
    name: `extension-${index + 1}`,
    displayName: `Extension ${index + 1}`,
    description: '',
    version: '1.0.0',
    isActive: true,
    path: `/extensions/${index + 1}`,
    capabilities: {},
  }));
  const scenario = createWebShellDaemonScenario({
    extensions: { extensions },
  });
  const daemon = await installScenario(page, scenario, testInfo);
  await page.route('**/scheduled-tasks', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ tasks: [] }),
    });
  });

  await gotoSession(page, scenario, daemon);
  await page.getByRole('button', { name: 'Scheduled Tasks' }).click();
  await page.getByRole('button', { name: 'New scheduled task' }).click();

  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect
    .poll(() => prompt.evaluate((element) => getComputedStyle(element).cursor))
    .toBe('text');

  const extensionsButton = page.getByRole('button', { name: 'Extensions' });
  const promptStyles = await prompt.evaluate((element) => {
    const style = getComputedStyle(element);
    return { backgroundColor: style.backgroundColor, color: style.color };
  });
  const referenceButtonStyles = await page
    .getByRole('button', { name: /^(Extensions|Skills|MCP)$/ })
    .evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
          color: style.color,
        };
      }),
    );
  expect(referenceButtonStyles).toHaveLength(3);
  for (const style of referenceButtonStyles) {
    expect(style.backgroundColor).toBe(promptStyles.backgroundColor);
    expect(style.borderColor).not.toBe(promptStyles.color);
    expect(style.color).not.toBe(promptStyles.color);
  }

  await extensionsButton.hover();
  await expect
    .poll(() =>
      extensionsButton.evaluate((element) => {
        const style = getComputedStyle(element);
        return { borderColor: style.borderColor, color: style.color };
      }),
    )
    .toEqual({
      borderColor: promptStyles.color,
      color: promptStyles.color,
    });
  await extensionsButton.click();

  const picker = page.getByRole('listbox', { name: 'Reference picker' });
  await expect(picker).toBeVisible();
  await expect
    .poll(() =>
      picker.evaluate(
        (element) => element.scrollHeight > element.clientHeight + 1,
      ),
    )
    .toBe(true);

  await picker.hover();
  await page.mouse.wheel(0, 400);
  await expect
    .poll(() => picker.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);

  await page.getByRole('option', { name: /extension-20 Extension 20/ }).click();
  await expect(prompt).toContainText('extension-20');
  const promptBox = await prompt.boundingBox();
  if (!promptBox) throw new Error('Prompt editor has no bounding box');
  const blankPosition = {
    x: promptBox.width - 40,
    y: promptBox.height / 2,
  };
  const tag = prompt.locator('[data-prompt-tag-serialized]');
  const remove = prompt.locator('[data-prompt-tag-remove]');

  await prompt.hover({ position: blankPosition });
  await expect(
    remove.evaluate((element) => element.matches(':hover')),
  ).resolves.toBe(false);
  await prompt.click({ position: blankPosition });
  await expect(tag).toBeVisible();

  await remove.click();
  await expect(prompt).not.toContainText('extension-20');
});

for (const viewportHeight of COMPOSER_VIEWPORT_HEIGHTS) {
  test(`grows long text to the responsive composer cap at ${viewportHeight}px @smoke`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: viewportHeight });
    const scenario = createWebShellDaemonScenario();
    const daemon = await installScenario(page, scenario, testInfo);

    await gotoSession(page, scenario, daemon);
    const surface = page.locator('[data-web-shell-composer-surface]');
    const initialHeight = await composerHeight(page);
    expect(initialHeight).toBe(140);

    await replaceComposerText(
      page,
      Array.from(
        { length: 10 },
        (_, index) => `Visible line ${index + 1}`,
      ).join('\n'),
    );
    await expect
      .poll(() => composerHeight(page))
      .toBeGreaterThan(initialHeight);

    await replaceComposerText(
      page,
      Array.from({ length: 80 }, (_, index) => `Capped line ${index + 1}`).join(
        '\n',
      ),
    );
    await expectCappedComposerLayout(page, viewportHeight);
    await expect(surface).toBeVisible();

    await page.keyboard.press('Control+r');
    const historySearch = surface.locator('input');
    await expect(historySearch).toBeVisible();
    const searchPanel = historySearch.locator('..').locator('..');
    await expect
      .poll(async () => {
        const [panelBox, surfaceBox] = await Promise.all([
          searchPanel.boundingBox(),
          surface.boundingBox(),
        ]);
        if (!panelBox || !surfaceBox) return Number.POSITIVE_INFINITY;
        return panelBox.y + panelBox.height - surfaceBox.y;
      })
      .toBeLessThanOrEqual(-7);
    await page.keyboard.press('Escape');
    await expect(historySearch).toHaveCount(0);

    const modeButton = page.locator('[data-web-shell-mode-button]');
    await modeButton.click();
    const modeDropdown = page.locator(
      '[data-web-shell-toolbar-popover][data-state="open"]',
    );
    await expect(modeDropdown).toBeVisible();
    await expect
      .poll(async () => {
        const [dropdownBox, buttonBox] = await Promise.all([
          modeDropdown.boundingBox(),
          modeButton.boundingBox(),
        ]);
        if (!dropdownBox || !buttonBox) return Number.POSITIVE_INFINITY;
        return dropdownBox.y + dropdownBox.height - buttonBox.y;
      })
      .toBeLessThanOrEqual(-3);

    const modelButton = page.locator('[data-web-shell-model-button]');
    await modelButton.click();
    await expect(
      page.locator('[data-web-shell-toolbar-popover] input[type="search"]'),
    ).toBeVisible();
    await modeButton.click();
    await expect(modeDropdown).toBeVisible();
    await expect(modeDropdown.locator('input[type="search"]')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await replaceComposerText(page, 'Short draft');
    await expect.poll(() => composerHeight(page)).toBe(initialHeight);
  });
}

for (const viewportHeight of COMPOSER_VIEWPORT_HEIGHTS) {
  test(`bounds shared attachments and long text at ${viewportHeight}px @smoke`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: viewportHeight });
    const scenario = createWebShellDaemonScenario({
      sessionId: `composer-layout-${viewportHeight}`,
    });
    const daemon = await installScenario(page, scenario, testInfo);

    await gotoComposerLayoutHarness(page, scenario, daemon);
    const tags = page.locator('[data-web-shell-composer-tag]');
    await expect(tags).toHaveCount(18);
    await expect(tags.first()).toBeVisible();

    await pasteComposerImages(page, 8);
    const images = page.locator(
      '[data-web-shell-composer-attachments] img[src^="data:image/png;base64,"]',
    );
    await expect(images).toHaveCount(8);
    await expectImagesDecoded(images);
    await replaceComposerText(
      page,
      Array.from(
        { length: 80 },
        (_, index) => `Attachment line ${index + 1}`,
      ).join('\n'),
    );

    await expectCappedComposerLayout(page, viewportHeight);
    const attachments = page.locator('[data-web-shell-composer-attachments]');
    await expect(attachments).toBeVisible();
    await expect
      .poll(async () => (await attachments.boundingBox())?.height ?? 0)
      .toBeLessThanOrEqual(136);
    await expect
      .poll(() =>
        attachments.evaluate(
          (element) => element.scrollHeight > element.clientHeight + 1,
        ),
      )
      .toBe(true);

    if (viewportHeight === 600) {
      await tags
        .first()
        .locator('[data-web-shell-composer-tag-trigger]')
        .hover();
      const portalRoot = page.locator('[data-web-shell-portal-root]');
      const tooltip = portalRoot.locator(
        '[data-web-shell-composer-tag-tooltip]',
      );
      await expect(tooltip).toBeVisible();
      await expect
        .poll(async () =>
          tooltip.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const tolerance = 1;
            return (
              getComputedStyle(element).overflowY === 'auto' &&
              rect.top >= 8 - tolerance &&
              rect.left >= 8 - tolerance &&
              rect.right <= window.innerWidth - 8 + tolerance &&
              rect.bottom <= window.innerHeight - 8 + tolerance
            );
          }),
        )
        .toBe(true);
    }

    await attachments.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(async () => {
        const [attachmentsBox, imageBox] = await Promise.all([
          attachments.boundingBox(),
          images.last().boundingBox(),
        ]);
        if (!attachmentsBox || !imageBox) return false;
        const tolerance = 1;
        return (
          imageBox.y >= attachmentsBox.y - tolerance &&
          imageBox.y + imageBox.height <=
            attachmentsBox.y + attachmentsBox.height + tolerance
        );
      })
      .toBe(true);
  });
}

test('lets a pasted image grow the composer without collapsing the text viewport @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  const initialHeight = await composerHeight(page);
  await pasteComposerImages(page, 1);

  const image = page.locator(
    '[data-web-shell-composer-surface] img[src^="data:image/png;base64,"]',
  );
  await expect(image).toHaveCount(1);
  await expectImagesDecoded(image);
  await expect.poll(() => composerHeight(page)).toBeGreaterThan(initialHeight);
  await expect
    .poll(async () => {
      const box = await page
        .locator('[data-web-shell-composer-editor]')
        .boundingBox();
      return box?.height ?? 0;
    })
    .toBeGreaterThanOrEqual(44);

  await image.locator('..').getByRole('button').click();
  await expect(image).toHaveCount(0);
  await expect.poll(() => composerHeight(page)).toBe(initialHeight);
});

async function installScenario(
  page: Page,
  scenario: WebShellDaemonScenario,
  testInfo: TestInfo,
): Promise<MockDaemonController> {
  return installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
}

async function gotoSession(
  page: Page,
  scenario: WebShellDaemonScenario,
  daemon: MockDaemonController,
): Promise<void> {
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  await completeReplay(
    page,
    daemon,
    scenario.sessionId,
    scenario.events.length,
  );
}

async function gotoComposerLayoutHarness(
  page: Page,
  scenario: WebShellDaemonScenario,
  daemon: MockDaemonController,
): Promise<void> {
  await page.goto(
    `/e2e/composer-layout-harness.html?sessionId=${encodeURIComponent(scenario.sessionId)}`,
  );
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  await completeReplay(page, daemon, scenario.sessionId);
}

async function completeReplay(
  page: Page,
  daemon: MockDaemonController,
  sessionId?: string,
  replayedCount = 0,
): Promise<void> {
  const connection = await daemon.sse.waitForConnection(sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount,
    }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);
}

async function fillComposer(page: Page, text: string): Promise<void> {
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.click();
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+A' : 'Control+A',
  );
  await page.keyboard.type(text);
}

async function replaceComposerText(page: Page, text: string): Promise<void> {
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.click();
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+A' : 'Control+A',
  );
  await page.keyboard.insertText(text);
}

async function pasteComposerImages(page: Page, count: number): Promise<void> {
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.evaluate((element, imageCount) => {
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const binary = atob(pngBase64);
    const pngBytes = Uint8Array.from(binary, (byte) => byte.charCodeAt(0));
    const clipboard = new DataTransfer();
    for (let index = 0; index < imageCount; index += 1) {
      clipboard.items.add(
        new File([pngBytes], `pasted-${index + 1}.png`, { type: 'image/png' }),
      );
    }
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    );
  }, count);
}

async function expectImagesDecoded(images: Locator): Promise<void> {
  await expect
    .poll(() =>
      images.evaluateAll((elements) =>
        elements.every(
          (element) =>
            element instanceof HTMLImageElement &&
            element.complete &&
            element.naturalWidth > 0 &&
            element.naturalHeight > 0,
        ),
      ),
    )
    .toBe(true);
}

async function expectCappedComposerLayout(
  page: Page,
  viewportHeight: number,
): Promise<void> {
  const maximumHeight = Math.min(350, viewportHeight * 0.4);
  await expect
    .poll(() => composerHeight(page))
    .toBeGreaterThanOrEqual(maximumHeight - 1);
  await expect
    .poll(() => composerHeight(page))
    .toBeLessThanOrEqual(maximumHeight + 1);

  const surface = page.locator('[data-web-shell-composer-surface]');
  const editorHost = page.locator('[data-web-shell-composer-editor]');
  const editorArea = editorHost.locator('..');
  const scroller = editorHost.locator('.cm-scroller');
  const content = scroller.locator('.cm-content');
  const toolbar = page
    .locator('[data-web-shell-composer-submit]')
    .locator('..')
    .locator('..');

  await expect
    .poll(async () => (await editorArea.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(44);
  await expect(toolbar).toBeVisible();
  await expect
    .poll(async () => {
      const [surfaceBox, toolbarBox] = await Promise.all([
        surface.boundingBox(),
        toolbar.boundingBox(),
      ]);
      if (!surfaceBox || !toolbarBox) return false;
      return (
        toolbarBox.y >= surfaceBox.y - 1 &&
        toolbarBox.y + toolbarBox.height <= surfaceBox.y + surfaceBox.height + 1
      );
    })
    .toBe(true);

  await expect
    .poll(() =>
      editorArea.evaluate((element) => getComputedStyle(element).overflowY),
    )
    .toBe('clip');
  await expect
    .poll(() =>
      editorHost.evaluate((element) => getComputedStyle(element).overflowY),
    )
    .toBe('clip');
  await expect
    .poll(() =>
      scroller.evaluate((element) => getComputedStyle(element).overflowY),
    )
    .toBe('auto');
  await expect
    .poll(() =>
      editorArea.evaluate(
        (element) => element.scrollHeight <= element.clientHeight + 1,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      editorHost.evaluate(
        (element) => element.scrollHeight <= element.clientHeight + 1,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) => element.scrollHeight > element.clientHeight + 1,
      ),
    )
    .toBe(true);
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop > 0))
    .toBe(true);
  await expect(content).toBeFocused();
}

async function composerHeight(page: Page): Promise<number> {
  const box = await page
    .locator('[data-web-shell-composer-surface]')
    .boundingBox();
  if (!box) throw new Error('Expected the composer surface to be visible.');
  return box.height;
}

async function submitLocalCommand(page: Page, text: string): Promise<void> {
  await fillComposer(page, text);
  await page.locator('[data-web-shell-composer-submit]').click();
}

async function openRawSseConnection(
  page: Page,
  baseURL: string,
  sessionId: string,
): Promise<void> {
  await page.evaluate(
    async ({ baseURL, sessionId }) => {
      const response = await fetch(
        `${baseURL}/session/${encodeURIComponent(sessionId)}/events`,
      );
      const holder = window as Window & {
        __webShellRawSseResponses?: Response[];
      };
      holder.__webShellRawSseResponses ??= [];
      holder.__webShellRawSseResponses.push(response);
    },
    { baseURL, sessionId },
  );
}

function firstRequest(
  requests: readonly DaemonRequestRecord[],
): DaemonRequestRecord {
  const request = requests[0];
  if (!request) throw new Error('Expected a recorded daemon request.');
  return request;
}

function requestBodyRecord(
  request: DaemonRequestRecord,
): Record<string, unknown> {
  expect(typeof request.body).toBe('object');
  expect(request.body).not.toBeNull();
  expect(Array.isArray(request.body)).toBe(false);
  return request.body as Record<string, unknown>;
}

function expectPromptBodyToContainText(
  body: Record<string, unknown>,
  text: string,
): void {
  const prompt = body['prompt'];
  expect(Array.isArray(prompt)).toBe(true);
  const blocks = prompt as readonly unknown[];
  expect(
    blocks.some(
      (block) =>
        isRecord(block) && block['type'] === 'text' && block['text'] === text,
    ),
  ).toBe(true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
