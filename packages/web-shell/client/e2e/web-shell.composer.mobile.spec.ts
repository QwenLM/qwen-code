/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Mobile composer backend (#5958). Runs under the `mobile-chromium` (Pixel 7)
// and `mobile-webkit` (iPhone 13) projects — both emulate touch, coarse
// pointer, and no hover — where the composer must render the plain-textarea
// backend instead of CodeMirror.

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
  replayCompleteEvent,
  turnCompleteEvent,
  type DaemonRequestRecord,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';
import {
  emptyMobileComposerLayout,
  expectEmptyMobileComposerAnchored,
  expectEmptyMobileWelcomeChromeVisible,
  gotoEmptyMobileWelcomeHarness,
} from './utils/emptyMobileComposer';
import { createGitWorkspaceScenario } from './utils/gitScenario';

const COMPOSER_TEXTAREA = 'textarea[data-web-shell-composer-editor]';
const SIDEBAR_WIDTH_STORAGE_KEY = 'qwen-code-web-shell-sidebar-width';
const TEST_KEYBOARD_TOP = 437.5;

async function installTestSoftwareKeyboard(page: Page): Promise<void> {
  await page.addInitScript((keyboardTop) => {
    let open = false;
    const listeners = new Map<string, Set<EventListener>>();
    const emit = (type: string) => {
      for (const listener of listeners.get(type) ?? []) {
        listener(new Event(type));
      }
    };
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        get height() {
          return open ? keyboardTop : window.innerHeight;
        },
        get width() {
          return window.innerWidth;
        },
        get offsetTop() {
          return 0;
        },
        get offsetLeft() {
          return 0;
        },
        get pageTop() {
          return 0;
        },
        get pageLeft() {
          return 0;
        },
        get scale() {
          return 1;
        },
        addEventListener(type: string, listener: EventListener) {
          const entries = listeners.get(type) ?? new Set<EventListener>();
          entries.add(listener);
          listeners.set(type, entries);
        },
        removeEventListener(type: string, listener: EventListener) {
          listeners.get(type)?.delete(listener);
        },
      },
    });

    const setKeyboard = (nextOpen: boolean) => {
      if (open === nextOpen) return;
      open = nextOpen;
      document.querySelector('[data-test-software-keyboard]')?.remove();
      if (open) {
        // Opaque band standing in for the software keyboard. Its `top` is the
        // visible-viewport bottom edge and it intercepts every pointer that
        // still lands under it (#17859), so a composer that has not been
        // lifted onto the inset is genuinely unreachable in these tests.
        const keyboard = document.createElement('div');
        keyboard.dataset.testSoftwareKeyboard = '';
        Object.assign(keyboard.style, {
          position: 'fixed',
          top: `${keyboardTop}px`,
          right: '0',
          bottom: '0',
          left: '0',
          zIndex: '10000',
          background: '#25272a',
          pointerEvents: 'auto',
        });
        document.body.append(keyboard);
      }
      emit('resize');
    };
    (
      window as typeof window & {
        __setTestSoftwareKeyboard: (visible: boolean) => void;
        __setTestSoftwareKeyboardSilently: (visible: boolean) => void;
      }
    ).__setTestSoftwareKeyboard = setKeyboard;
    // Same state change without the `visualViewport` resize. A shell that only
    // hears window resize must still recompute, and this is the only way to
    // tell that listener apart from the viewport one.
    (
      window as typeof window & {
        __setTestSoftwareKeyboardSilently: (visible: boolean) => void;
      }
    ).__setTestSoftwareKeyboardSilently = (nextOpen: boolean) => {
      if (open === nextOpen) return;
      open = nextOpen;
      document.querySelector('[data-test-software-keyboard]')?.remove();
    };
    document.addEventListener(
      'focusout',
      (event) => {
        if (
          event.target instanceof HTMLTextAreaElement &&
          event.target.matches('[data-web-shell-composer-editor]')
        ) {
          setKeyboard(false);
        }
      },
      true,
    );
  }, TEST_KEYBOARD_TOP);
}

async function setTestSoftwareKeyboard(
  page: Page,
  visible: boolean,
): Promise<void> {
  await page.evaluate((nextVisible) => {
    (
      window as typeof window & {
        __setTestSoftwareKeyboard: (visible: boolean) => void;
      }
    ).__setTestSoftwareKeyboard(nextVisible);
  }, visible);
}

async function expectUncoveredStableSend(
  page: Page,
  testInfo: TestInfo,
  label: string,
) {
  const send = page.locator('[data-web-shell-composer-submit]');
  const box = await send.boundingBox();
  expect(box).not.toBeNull();
  const screenshotPath = testInfo.outputPath(`${label}-before-tap.png`);
  await page.screenshot({ path: screenshotPath });
  await testInfo.attach(`${label}-before-tap`, {
    path: screenshotPath,
    contentType: 'image/png',
  });
  expect(box!.y + box!.height).toBeLessThanOrEqual(TEST_KEYBOARD_TOP);
  const center = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  expect(
    await page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      const target = document.querySelector('[data-web-shell-composer-submit]');
      return hit instanceof Node && target?.contains(hit);
    }, center),
  ).toBe(true);
  await page.touchscreen.tap(center.x, center.y);
}

async function measureWelcomeLayout(page: Page) {
  return page.getByTestId('chat-pane-container').evaluate((pane) => {
    const measure = (selector: string) => {
      const element = pane.querySelector(selector);
      return element ? element.getBoundingClientRect() : null;
    };
    const paneRect = pane.getBoundingClientRect();
    const header = measure('[data-e2e-mobile-welcome-header]');
    const welcomeFooter = measure('[data-e2e-mobile-welcome-footer]');
    const composer = measure('[data-web-shell-composer-surface]');
    const send = measure('[data-web-shell-composer-submit]');
    if (!header || !welcomeFooter || !composer || !send) {
      throw new Error('Expected the mobile welcome chrome to render.');
    }
    return {
      paneTop: paneRect.top,
      paneBottom: paneRect.bottom,
      headerTop: header.top,
      headerBottom: header.bottom,
      welcomeFooterTop: welcomeFooter.top,
      composerTop: composer.top,
      composerBottom: composer.bottom,
      sendBottom: send.bottom,
    };
  });
}

test('simple mobile composer grows and submits Chinese multiline input @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await page.goto(
    `/e2e/composer-layout-harness.html?composerVariant=simple&tags=false&sessionId=${scenario.sessionId}`,
  );
  await completeReplay(page, daemon, scenario.sessionId);
  const composer = page.locator('[data-web-shell-composer-variant="simple"]');
  const textarea = composer.locator(COMPOSER_TEXTAREA);
  const content = composer.locator('[data-web-shell-composer-content]');
  const send = composer.locator('[data-web-shell-composer-submit]');
  await expect(textarea).toBeVisible();
  await expect(composer.locator('.cm-editor')).toHaveCount(0);
  await expect(send).toBeVisible();
  await expect(send).toBeDisabled();
  await expect(
    composer.getByRole('button', {
      name: 'Start voice dictation',
      exact: true,
    }),
  ).toHaveCount(0);
  const restingHeight = (await content.boundingBox())!.height;
  expect(restingHeight).toBeLessThanOrEqual(72);
  await textarea.fill('第一行');
  await textarea.press('Enter');
  await page.keyboard.insertText('第二行');
  await expect(textarea).toHaveValue('第一行\n第二行');
  expect(daemon.promptRequests()).toHaveLength(0);
  await expect
    .poll(async () => (await content.boundingBox())!.height)
    .toBeGreaterThan(restingHeight);
  await send.tap();
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  expectPromptBodyToContainText(
    firstRequestBody(daemon.promptRequests()),
    '第一行\n第二行',
  );
  await expect(textarea).toHaveValue('');
});

test('simple mobile add drawer keeps advanced controls in advanced mode @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  scenario.capabilities.features.push(
    'workspace_file_upload',
    'workspace_qualified_rest_core',
  );
  scenario.capabilities.workspaces = [
    { id: 'primary', cwd: scenario.workspaceCwd, primary: true, trusted: true },
  ];
  const daemon = await installScenario(page, scenario, testInfo);
  await page.goto(
    `/e2e/composer-layout-harness.html?composerVariant=simple&tags=false&sessionId=${scenario.sessionId}`,
  );
  await completeReplay(page, daemon, scenario.sessionId);
  const composer = page.locator('[data-web-shell-composer]');
  await expect(composer.locator('[data-web-shell-model-button]')).toHaveCount(
    0,
  );
  await composer.getByTestId('composer-add-menu-trigger').tap();
  const drawer = page.locator('[data-web-shell-mobile-add-menu]');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-web-shell-model-button]')).toHaveCount(0);
  await expect(drawer.locator('[data-web-shell-mode-button]')).toHaveCount(0);
  expect(
    await drawer.getByRole('button').evaluateAll((buttons) =>
      buttons
        .filter((button) => button.textContent?.trim())
        .map(
          (button) =>
            button.getAttribute('aria-label') ?? button.textContent?.trim(),
        )
        .filter(Boolean),
    ),
  ).toEqual([
    'Photos',
    'Take photo',
    'Attach files',
    'Upload to workspace',
    'Reference file',
    'Extensions',
    'MCP',
    'Skills',
  ]);
  await expect(
    drawer
      .getByTestId('composer-add-menu-reference-file')
      .getByText('Reference file', { exact: true }),
  ).toBeVisible();
  await drawer.getByRole('button', { name: /^close$/i }).tap();
  await composer.locator('[data-web-shell-composer-expand]').tap();
  await expect(composer).toHaveAttribute(
    'data-web-shell-composer-variant',
    'default',
  );
  const model = composer.locator('[data-web-shell-model-button]');
  await expect(model).toBeVisible();
  await expect(composer.locator('[data-web-shell-mode-button]')).toBeVisible();
  await model.tap();
  const picker = page.locator('[data-web-shell-model-sheet]');
  await expect(picker).toBeVisible();
  await expect
    .poll(() =>
      picker.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  await expect(picker.locator('input[type="search"]')).not.toBeFocused();
  const modelLabel = picker
    .locator('[data-model-id] [class*="dropdownItemLabel"]')
    .first();
  await expect(modelLabel).toHaveCSS('white-space', 'normal');
  const labelWidth = await modelLabel.evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(labelWidth.scroll).toBeLessThanOrEqual(labelWidth.client + 1);
  await picker
    .getByRole('button', { name: 'Qwen Test Alt', exact: true })
    .tap();
  await expect.poll(() => daemon.modelRequests().length).toBe(1);
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: 'Done', exact: true }).tap();
  await expect(picker).toBeHidden();
  await expect(model).toBeFocused();
  await composer.getByTestId('composer-add-menu-trigger').tap();
  await expect(drawer).toBeVisible();
  const rows = drawer.locator('[data-vaul-no-drag] button');
  const layout = await rows.evaluateAll((buttons) =>
    buttons.map((button) => ({
      minHeight: getComputedStyle(button).minHeight,
      hasIcon: Boolean(
        button.querySelector(':scope > span[aria-hidden="true"]'),
      ),
    })),
  );
  expect(layout.length).toBeGreaterThan(8);
  expect(layout.every((row) => row.minHeight === '52px' && row.hasIcon)).toBe(
    true,
  );
});

test('keeps the unavailable-model authorize action reachable inside the mobile sheet @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  const params = new URLSearchParams({
    sessionId: scenario.sessionId,
    theme: 'dark',
    sidebar: 'false',
    unavailableModels: '1',
    unavailableMount: '1',
  });
  await page.goto(`/e2e/settings-harness.html?${params}`);
  await completeReplay(page, daemon, scenario.sessionId);
  await page.locator('[data-web-shell-model-button]').tap();
  const sheet = page.locator('[data-web-shell-model-sheet]');
  await expect(sheet).toBeVisible();
  const modelSection = sheet.locator('[data-web-shell-model-submenu-trigger]');
  if (await modelSection.count()) await modelSection.tap();
  const disabled = sheet.locator(
    '[data-web-shell-unavailable-model][data-model-id="qwen-max"]',
  );
  await expect(disabled).toBeVisible();
  await expect(disabled).toBeInViewport({ ratio: 1 });
  await disabled.tap({ force: true });
  const hint = page.locator('[data-web-shell-unavailable-model-tooltip]');
  const authorize = hint.getByRole('button', { name: 'Authorize' });
  await expect(authorize).toBeVisible();
  await hint.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  const box = (await authorize.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  await page.screenshot({
    path: testInfo.outputPath('unavailable-authorize-mobile.png'),
  });
  await authorize.evaluate((button) => {
    button.addEventListener('click', () => {
      document.documentElement.dataset.authorizeClicked = 'true';
    });
  });
  await authorize.tap();
  await expect(page.locator('html')).toHaveAttribute(
    'data-authorize-clicked',
    'true',
  );
  await expect(sheet).toBeVisible();
});

test('model sheet rows and search field stay touch-sized, including on a tablet @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  scenario.capabilities.features.push('workspace_model_reload');
  scenario.state.configOptions = [
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'none', name: 'Thinking off' },
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
      _meta: { 'qwenCode/reasoning': { defaultEffort: 'high' } },
    },
  ];
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);

  await page.locator('[data-web-shell-model-button]').tap();
  const sheet = page.locator('[data-web-shell-model-sheet]');
  await expect(sheet).toBeVisible();

  const heightsOf = (locator: ReturnType<typeof page.locator>) =>
    locator.evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().height),
    );

  const effortRows = sheet.locator('[data-web-shell-effort]');
  await expect(effortRows.first()).toBeVisible();
  const effortHeights = await heightsOf(effortRows);
  expect(effortHeights.length).toBeGreaterThan(0);
  for (const height of effortHeights) {
    expect(height).toBeGreaterThanOrEqual(44);
  }

  // The Thinking row is a plain div; the switch inside it is the control, so
  // its own hit rect has to reach 44px. Tap 11px above the track — outside the
  // primitive's 8px pad, inside the sheet's 13px one — and require a toggle.
  // The drawer slides up from below the fold. Coordinate-based taps must wait
  // for it to arrive, or they land on whatever scrolled past that point.
  await expect
    .poll(async () => {
      const first = (await sheet.boundingBox())!.y;
      await page.waitForTimeout(120);
      return (await sheet.boundingBox())!.y === first;
    })
    .toBe(true);

  const thinking = sheet.locator('[data-web-shell-thinking-toggle]');
  await expect(thinking).toBeVisible();
  // The reasoning controls arrive asynchronously and the switch is disabled
  // until they do. Anchor on the fixture's settled value (high) rather than
  // on whatever the switch happens to read mid-hydration.
  await expect(sheet.locator('[data-web-shell-effort="high"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(thinking).toBeEnabled();
  await expect(thinking).toHaveAttribute('data-state', 'checked');
  const pad = await thinking.evaluate((node) =>
    parseFloat(getComputedStyle(node, '::after').insetBlockStart),
  );
  const track = (await thinking.boundingBox())!;
  // The hit rect, not the pad constant: a smaller switch track must not
  // shrink the target below 44px while the pad still reads 13.
  expect(track.height + 2 * Math.abs(pad)).toBeGreaterThanOrEqual(44);
  const thinkingRow = sheet.locator('[data-web-shell-thinking-row]');
  expect((await thinkingRow.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const hit = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x as number, y as number);
      return el?.closest('[data-web-shell-thinking-toggle]')
        ? 'switch'
        : (el?.outerHTML.slice(0, 160) ?? 'none');
    },
    [track.x + track.width / 2, track.y - 11],
  );
  expect(hit).toBe('switch');
  await page.touchscreen.tap(track.x + track.width / 2, track.y - 11);
  await expect.poll(() => daemon.configOptionRequests().length).toBe(1);
  // The toggle's own payload, not an effort row's: turning Thinking off sends
  // 'none'. An effort row would have sent 'low' or 'high'.
  expect(daemon.configOptionRequests()[0]!.body).toEqual({
    configId: 'reasoning_effort',
    value: 'none',
    persist: true,
  });

  const done = sheet.locator('[data-web-shell-model-sheet-done]');
  await expect(done).toBeVisible();
  const doneBox = (await done.boundingBox())!;
  expect(doneBox.height).toBeGreaterThanOrEqual(44);

  const section = sheet.locator('[data-web-shell-model-submenu-trigger]');
  // The section row carries its own taller floor; the row rule must not
  // shrink it.
  expect((await section.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await section.tap();
  const rows = sheet.locator('[data-model-id]');
  await expect(rows.first()).toBeVisible();
  const rowHeights = await heightsOf(rows);
  expect(rowHeights.length).toBeGreaterThan(0);
  for (const height of rowHeights) {
    expect(height).toBeGreaterThanOrEqual(44);
  }

  const search = sheet.locator('input[type="search"]');
  await expect(search).toBeVisible();
  // Measured at the phone width too: a later 'md:h-11' would keep the tablet
  // assertion green while putting the phone back at 32px.
  expect((await search.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const refresh = sheet.getByRole('button', {
    name: 'Refresh models',
    exact: true,
  });
  await expect(refresh).toBeVisible();
  const refreshBox = (await refresh.boundingBox())!;
  expect(refreshBox.width).toBeGreaterThanOrEqual(44);
  expect(refreshBox.height).toBeGreaterThanOrEqual(44);

  // A landscape tablet still matches the coarse-pointer half of the sheet
  // query, but now also matches the Input's md: breakpoint.
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(search).toBeVisible();
  const fontSize = await search.evaluate((node) =>
    parseFloat(getComputedStyle(node).fontSize),
  );
  expect(fontSize).toBeGreaterThanOrEqual(16);
  expect((await search.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test('simple mobile composer switches directly to advanced mode without losing its draft or attachments @smoke', async ({
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
  const daemon = await installScenario(page, scenario, testInfo);
  await page.goto(
    `/e2e/composer-layout-harness.html?composerVariant=simple&tags=false&sessionId=${scenario.sessionId}`,
  );
  await completeReplay(page, daemon, scenario.sessionId);
  const composer = page.locator('[data-web-shell-composer]');
  const textarea = composer.locator(COMPOSER_TEXTAREA);
  const microphone = composer.getByRole('button', {
    name: 'Start voice dictation',
    exact: true,
  });
  const modeButton = composer.locator(
    '[data-web-shell-composer-expand], [data-web-shell-composer-collapse]',
  );
  const send = composer.locator('[data-web-shell-composer-submit]');
  await expect(modeButton).toHaveAccessibleName('Switch to advanced mode');
  await expect(microphone).toBeVisible();
  await expect(send).toBeHidden();
  const modeBox = (await modeButton.boundingBox())!;
  const micBox = (await microphone.boundingBox())!;
  expect(modeBox.x + modeBox.width).toBeLessThanOrEqual(micBox.x);
  await expect(
    modeButton.locator('..').locator('button:visible').last(),
  ).toHaveAccessibleName('Start voice dictation');

  await modeButton.tap();
  await expect(modeButton).toHaveAccessibleName('Switch to simple mode');
  await expect(composer).toHaveAttribute(
    'data-web-shell-composer-variant',
    'default',
  );
  await expect(microphone).toBeVisible();
  await expect(send).toBeVisible();
  await expect(send).toBeDisabled();
  const advancedModeBox = (await modeButton.boundingBox())!;
  const advancedMicBox = (await microphone.boundingBox())!;
  const advancedSendBox = (await send.boundingBox())!;
  expect(advancedModeBox.x + advancedModeBox.width).toBeLessThanOrEqual(
    advancedMicBox.x,
  );
  expect(advancedMicBox.x + advancedMicBox.width).toBeLessThanOrEqual(
    advancedSendBox.x,
  );
  expect(
    advancedSendBox.x - advancedMicBox.x - advancedMicBox.width,
  ).toBeLessThanOrEqual(12);
  await expect(
    modeButton.locator('..').locator('button:visible').last(),
  ).toHaveAttribute('data-web-shell-composer-submit');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await modeButton.tap();
  await expect(modeButton).toHaveAccessibleName('Switch to advanced mode');

  await textarea.fill('保留中文草稿和附件');
  await expect(microphone).toBeHidden();
  await expect(send).toBeVisible();
  const typedModeBox = (await modeButton.boundingBox())!;
  const sendBox = (await send.boundingBox())!;
  expect(typedModeBox.x + typedModeBox.width).toBeLessThanOrEqual(sendBox.x);
  await expect(
    modeButton.locator('..').locator('button:visible').last(),
  ).toHaveAttribute('data-web-shell-composer-submit');
  await composer
    .locator('input[type="file"]')
    .last()
    .setInputFiles({
      name: 'retained-note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('retained attachment'),
    });
  const attachments = composer.locator('[data-web-shell-composer-attachments]');
  await expect(attachments).toBeVisible();
  const textareaNode = (await textarea.elementHandle())!;
  const attachmentText = await attachments.textContent();
  await expect(composer).toHaveAttribute(
    'data-web-shell-composer-variant',
    'simple',
  );

  await modeButton.tap();
  await expect(composer).toHaveAttribute(
    'data-web-shell-composer-variant',
    'default',
  );
  await expect(
    composer.locator('[data-web-shell-mobile-editing-actions]'),
  ).toBeVisible();
  await expect(composer.locator('[data-web-shell-model-button]')).toBeVisible();
  await expect(modeButton).toHaveAccessibleName('Switch to simple mode');
  await expect(microphone).toBeVisible();
  await expect(send).toBeVisible();
  await expect(
    modeButton.locator('..').locator('button:visible').last(),
  ).toHaveAttribute('data-web-shell-composer-submit');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-web-shell-expanded-editor]')).toHaveCount(0);
  await expect(textarea).toHaveValue('保留中文草稿和附件');
  expect(
    await textareaNode.evaluate(
      (node) =>
        node ===
        document.querySelector('textarea[data-web-shell-composer-editor]'),
    ),
  ).toBe(true);
  expect(await attachments.textContent()).toBe(attachmentText);

  await modeButton.tap();
  await expect(composer).toHaveAttribute(
    'data-web-shell-composer-variant',
    'simple',
  );
  await expect(
    composer.locator('[data-web-shell-mobile-editing-actions]'),
  ).toHaveCount(0);
  await expect(textarea).toHaveValue('保留中文草稿和附件');
  await expect(modeButton).toHaveAccessibleName('Switch to advanced mode');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    await textareaNode.evaluate(
      (node) =>
        node ===
        document.querySelector('textarea[data-web-shell-composer-editor]'),
    ),
  ).toBe(true);
  expect(await attachments.textContent()).toBe(attachmentText);

  await composer
    .getByRole('button', { name: 'Remove retained-note.txt', exact: true })
    .tap();
  await expect(attachments).toHaveCount(0);
  await composer.locator('[data-web-shell-composer-submit]').tap();
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  const submitted = JSON.stringify(firstRequestBody(daemon.promptRequests()));
  expect(submitted).toContain('保留中文草稿和附件');
  await expect(textarea).toHaveValue('');
  await expect(attachments).toHaveCount(0);
});

test('switching to simple mode exits Shell before sending the retained draft @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  const shellRequests: string[] = [];
  await page.route(/\/shell\/?(?:\?|$)/, async (route) => {
    shellRequests.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        exitCode: 0,
        output: 'Fixture only',
        aborted: false,
      }),
    });
  });
  await page.goto(
    `/e2e/composer-layout-harness.html?composerVariant=simple&tags=false&sessionId=${scenario.sessionId}`,
  );
  await completeReplay(page, daemon, scenario.sessionId);
  const composer = page.locator('[data-web-shell-composer]');
  const textarea = composer.locator(COMPOSER_TEXTAREA);
  const shellPrefix = textarea.locator('..').getByText('!', { exact: true });
  await expect(textarea).toBeVisible();
  const original = await textarea.elementHandle();
  const placeholder = await textarea.getAttribute('placeholder');
  const draft = '保留普通聊天草稿';
  await textarea.fill(draft);
  await composer.locator('[data-web-shell-composer-expand]').tap();
  await expect(composer).toHaveAttribute(
    'data-web-shell-composer-variant',
    'default',
  );
  await composer.getByTestId('composer-add-menu-trigger').tap();
  const drawer = page.locator('[data-web-shell-mobile-add-menu]');
  await drawer.getByRole('button', { name: 'Shell mode', exact: true }).tap();
  await expect(drawer).toBeHidden();
  await expect(textarea).toHaveAttribute(
    'placeholder',
    'Enter terminal command',
  );
  await expect(shellPrefix).toBeVisible();
  await composer.locator('[data-web-shell-composer-collapse]').tap();
  await expect(composer).toHaveAttribute(
    'data-web-shell-composer-variant',
    'simple',
  );
  await expect(textarea).toHaveValue(draft);
  expect(
    await textarea.evaluate((node, before) => node === before, original),
  ).toBe(true);
  expect.soft(await textarea.getAttribute('placeholder')).toBe(placeholder);
  expect.soft(await shellPrefix.count()).toBe(0);
  await composer.locator('[data-web-shell-composer-submit]').tap();
  await expect
    .poll(() => daemon.promptRequests().length + shellRequests.length)
    .toBe(1);
  expect(shellRequests).toEqual([]);
  expect(daemon.promptRequests()).toHaveLength(1);
  expectPromptBodyToContainText(
    firstRequestBody(daemon.promptRequests()),
    draft,
  );
  await expect(textarea).toHaveValue('');
});

test('renders the textarea backend instead of CodeMirror on touch devices', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);

  await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
});

test('anchors the empty mobile composer with the textarea backend', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  await installScenario(page, scenario, testInfo);

  await gotoEmptyMobileWelcomeHarness(page);
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await expect(textarea).toBeVisible();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await expectEmptyMobileWelcomeChromeVisible(page);

  const layout = await emptyMobileComposerLayout(page);
  expectEmptyMobileComposerAnchored(layout);

  // The bottom-anchored compact layout above is gated on the visual viewport
  // actually being occluded. With no keyboard open the group must stay
  // vertically centred, so this pins the `inset > 0` half of the toggle:
  // forcing the attribute on would bottom-anchor a phone that has no keyboard.
  const unoccluded = await page
    .getByTestId('chat-pane-container')
    .evaluate((chatPane) => {
      const root = document.querySelector('[data-web-shell-root]');
      const pane = chatPane.getBoundingClientRect();
      const header = chatPane
        .querySelector('[data-e2e-mobile-welcome-header]')!
        .getBoundingClientRect();
      const composer = chatPane
        .querySelector('[data-web-shell-composer-surface]')!
        .getBoundingClientRect();
      return {
        occluded: root?.hasAttribute('data-visual-viewport-occluded') ?? null,
        inset: root
          ? getComputedStyle(root).getPropertyValue(
              '--web-shell-visual-viewport-inset-bottom',
            )
          : null,
        paneTop: pane.top,
        paneBottom: pane.bottom,
        headerTop: header.top,
        headerBottom: header.bottom,
        composerTop: composer.top,
        composerBottom: composer.bottom,
        footerBottom:
          chatPane
            .querySelector('[data-e2e-mobile-welcome-footer]')
            ?.getBoundingClientRect().bottom ?? null,
      };
    });
  expect(unoccluded.occluded).toBe(false);
  expect(unoccluded.inset).toBe('0px');
  const paneCentre = (unoccluded.paneTop + unoccluded.paneBottom) / 2;
  const groupCentre =
    (unoccluded.headerTop +
      (unoccluded.footerBottom ?? unoccluded.headerBottom)) /
    2;
  expect(Math.abs(groupCentre - paneCentre)).toBeLessThan(20);

  await textarea.tap();
  await textarea.fill('Composer remains interactive on touch devices');
  await expect(textarea).toHaveValue(
    'Composer remains interactive on touch devices',
  );
});

test('recomputes the inset from a window resize the visual viewport never emits', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  await installScenario(page, scenario, testInfo);
  await installTestSoftwareKeyboard(page);
  await gotoEmptyMobileWelcomeHarness(page);

  const inset = () =>
    page.evaluate(() =>
      getComputedStyle(
        document.querySelector('[data-web-shell-root]') as HTMLElement,
      )
        .getPropertyValue('--web-shell-visual-viewport-inset-bottom')
        .trim(),
    );

  await setTestSoftwareKeyboard(page, true);
  await expect.poll(inset).not.toBe('0px');
  const occludedInset = await inset();
  expect(Number.parseFloat(occludedInset)).toBeGreaterThan(0);

  // The keyboard state changes and the viewport stays silent; only the window
  // resize below can deliver the new geometry to the shell.
  await page.evaluate(() => {
    (
      window as typeof window & {
        __setTestSoftwareKeyboardSilently: (visible: boolean) => void;
      }
    ).__setTestSoftwareKeyboardSilently(false);
    window.dispatchEvent(new Event('resize'));
  });

  await expect.poll(inset).toBe('0px');
});

test('submits welcome and follow-up prompts on the first tap above a software keyboard @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await installTestSoftwareKeyboard(page);
  await page.goto('/?language=en');
  const installTapGeometry = () =>
    page.evaluate(() => {
      type TapEvent = {
        type: string;
        target: string;
        active: string;
        top: number | null;
        viewportHeight: number;
      };
      const events: TapEvent[] = [];
      (
        window as typeof window & { __sendTapGeometry: TapEvent[] }
      ).__sendTapGeometry = events;
      for (const type of [
        'pointerdown',
        'mousedown',
        'pointerup',
        'mouseup',
        'click',
        'focusout',
        'focusin',
      ]) {
        document.addEventListener(
          type,
          (event) => {
            if (!(event.target instanceof Element)) return;
            const send = event.target.closest(
              '[data-web-shell-composer-submit]',
            );
            const editor = event.target.closest(
              '[data-web-shell-composer-editor]',
            );
            if (!send && !editor) return;
            const currentSend = document.querySelector(
              '[data-web-shell-composer-submit]',
            );
            events.push({
              type,
              target: send ? 'send' : 'editor',
              active: document.activeElement?.tagName ?? 'none',
              top: currentSend?.getBoundingClientRect().top ?? null,
              viewportHeight: window.visualViewport?.height ?? -1,
            });
          },
          true,
        );
      }
    });
  const takeTapGeometry = () =>
    page.evaluate(() => {
      const state = window as typeof window & {
        __sendTapGeometry: Array<{
          type: string;
          target: string;
          active: string;
          top: number | null;
          viewportHeight: number;
        }>;
      };
      return state.__sendTapGeometry.splice(0);
    });

  await installTapGeometry();
  const welcome = page.locator(COMPOSER_TEXTAREA);
  await welcome.tap();
  await welcome.fill('hi');
  await expect(welcome).toBeFocused();
  await setTestSoftwareKeyboard(page, true);
  await expectUncoveredStableSend(page, testInfo, 'welcome');
  const welcomeEvents = await takeTapGeometry();
  await testInfo.attach('welcome-tap-events', {
    body: JSON.stringify(welcomeEvents, null, 2),
    contentType: 'application/json',
  });
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  expect(JSON.stringify(daemon.promptRequests()[0]?.body)).toContain('hi');
  const welcomeSendEvents = welcomeEvents.filter(
    ({ target, type }) =>
      target === 'send' && (type === 'pointerdown' || type === 'click'),
  );
  expect(welcomeSendEvents.map(({ type }) => type)).toEqual([
    'pointerdown',
    'click',
  ]);
  expect(welcomeSendEvents[0]?.top).toBe(welcomeSendEvents[1]?.top);

  await expect(page).toHaveURL(new RegExp(`/session/${scenario.sessionId}`));
  await daemon.sse.waitForConnection(scenario.sessionId);
  await expect(
    page.locator('[data-web-shell-composer-submit]'),
  ).toHaveAttribute('aria-label', 'Stop');
  await daemon.sendEvent(
    assistantTextEvent('Done.', { id: 100, sessionId: scenario.sessionId }),
  );
  await daemon.sendEvent(
    turnCompleteEvent('prompt-e2e', {
      id: 101,
      sessionId: scenario.sessionId,
    }),
  );
  await expect(
    page.locator('[data-web-shell-composer-submit]'),
  ).toHaveAttribute('aria-label', 'Send message');
  await installTapGeometry();
  const followUp = page.locator(COMPOSER_TEXTAREA);
  await expect(followUp).toBeVisible();
  await followUp.tap();
  await followUp.fill('follow up');
  await setTestSoftwareKeyboard(page, true);
  await expectUncoveredStableSend(page, testInfo, 'follow-up');
  const followUpEvents = await takeTapGeometry();
  await testInfo.attach('follow-up-tap-events', {
    body: JSON.stringify(followUpEvents, null, 2),
    contentType: 'application/json',
  });
  await expect.poll(() => daemon.promptRequests().length).toBe(2);
  expect(JSON.stringify(daemon.promptRequests()[1]?.body)).toContain(
    'follow up',
  );
  const followUpSendEvents = followUpEvents.filter(
    ({ target, type }) =>
      target === 'send' && (type === 'pointerdown' || type === 'click'),
  );
  expect(followUpSendEvents.map(({ type }) => type)).toEqual([
    'pointerdown',
    'click',
  ]);
  expect(followUpSendEvents[0]?.top).toBe(followUpSendEvents[1]?.top);
});

test('keeps the custom-footer mobile welcome group inside the pane above a software keyboard @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await installTestSoftwareKeyboard(page);
  await gotoEmptyMobileWelcomeHarness(page, { customFooter: true });
  await expectEmptyMobileWelcomeChromeVisible(page);

  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.tap();
  await textarea.fill('custom footer welcome');
  await expect(textarea).toBeFocused();
  await setTestSoftwareKeyboard(page, true);

  const viewportHeight = page.viewportSize()!.height;
  const expectedInset = `${viewportHeight - TEST_KEYBOARD_TOP}px`;
  await expect
    .poll(() =>
      page
        .locator('[data-web-shell-root]')
        .evaluate((element) =>
          getComputedStyle(element)
            .getPropertyValue('--web-shell-visual-viewport-inset-bottom')
            .trim(),
        ),
    )
    .toBe(expectedInset);

  const layout = await measureWelcomeLayout(page);

  const screenshotPath = testInfo.outputPath(
    'custom-footer-welcome-keyboard-open.png',
  );
  await page.screenshot({ path: screenshotPath });
  await testInfo.attach('custom-footer-welcome-keyboard-open', {
    path: screenshotPath,
    contentType: 'image/png',
  });
  await testInfo.attach('custom-footer-welcome-layout', {
    body: JSON.stringify(layout, null, 2),
    contentType: 'application/json',
  });

  // The inset is reserved by the pane padding, so the whole shrink-to-content
  // welcome group must stay inside the pane instead of being displaced above
  // its `overflow: hidden` box by the inset a second time.
  expect(layout.headerTop).toBeGreaterThanOrEqual(layout.paneTop);
  expect(layout.headerBottom).toBeLessThanOrEqual(layout.welcomeFooterTop);
  expect(layout.welcomeFooterTop).toBeLessThanOrEqual(layout.composerTop);
  expect(layout.composerBottom).toBeLessThanOrEqual(layout.paneBottom);
  expect(layout.composerBottom).toBeLessThanOrEqual(TEST_KEYBOARD_TOP);
  expect(layout.sendBottom).toBeLessThanOrEqual(TEST_KEYBOARD_TOP);

  await expectUncoveredStableSend(page, testInfo, 'custom-footer-welcome');
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  expect(JSON.stringify(daemon.promptRequests()[0]?.body)).toContain(
    'custom footer welcome',
  );
});

test('keeps Send above the keyboard when the welcome footer outgrows the reduced pane @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await installTestSoftwareKeyboard(page);
  await gotoEmptyMobileWelcomeHarness(page, { customFooter: true });
  await expectEmptyMobileWelcomeChromeVisible(page);

  // Grow the host welcome footer until header + footer + composer no longer
  // fit the inset-reduced pane. A centred group would then overflow both ways
  // and leave Send under the keyboard; anchoring it to the bottom of the
  // padded content box sends the overflow upward instead.
  await page
    .locator('[data-e2e-mobile-welcome-footer]:visible')
    .evaluate((element) => {
      (element as HTMLElement).style.minHeight = '360px';
    });

  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.tap();
  await textarea.fill('tall welcome footer');
  await expect(textarea).toBeFocused();
  await setTestSoftwareKeyboard(page, true);

  const layout = await measureWelcomeLayout(page);
  await testInfo.attach('tall-welcome-footer-layout', {
    body: JSON.stringify(layout, null, 2),
    contentType: 'application/json',
  });

  // The group demonstrably overflowed the content box (its top starts above
  // the pane), yet the composer stays on the reserved inset instead of
  // following the overflow below the keyboard.
  expect(layout.headerTop).toBeLessThan(layout.paneTop);
  expect(layout.composerBottom).toBeLessThanOrEqual(TEST_KEYBOARD_TOP);
  expect(layout.sendBottom).toBeLessThanOrEqual(TEST_KEYBOARD_TOP);

  await expectUncoveredStableSend(page, testInfo, 'tall-welcome-footer');
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  expect(JSON.stringify(daemon.promptRequests()[0]?.body)).toContain(
    'tall welcome footer',
  );
});

test('keeps voice controls reachable on an extra-narrow touch viewport @smoke', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 240, height: 700 });
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
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  const model = page.locator('[data-web-shell-model-button]');
  const add = page.getByRole('button', { name: 'Add to message' });
  const voice = page.getByRole('button', { name: 'Start voice dictation' });
  const send = page.locator('[data-web-shell-composer-submit]');
  await expect(model).toBeVisible();
  await expect(add).toBeVisible();
  await expect(voice).toBeVisible();
  await expect(send).toBeVisible();

  await voice.tap();

  const activeToolbar = page.locator('[data-mobile-voice-active="true"]');
  await expect(activeToolbar).toBeVisible();
  await expect(model).toBeHidden();
  await expect(add).toBeHidden();
  await expect(send).toBeVisible();
  await expect(activeToolbar.locator('button:visible')).toHaveCount(2);
  await expect(
    page.locator('[data-web-shell-mobile-editing-actions]'),
  ).toBeHidden();
  await expect(page.locator('[data-web-shell-git-branch]')).toBeHidden();
});

test('keeps a persisted wide sidebar inside the mobile drawer and exposes close', async ({
  page,
}, testInfo) => {
  await page.addInitScript(
    ([key, width]) => {
      window.localStorage.setItem(key, width);
    },
    [SIDEBAR_WIDTH_STORAGE_KEY, '512'] as const,
  );
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  await page.getByRole('button', { name: 'Toggle menu' }).tap();

  const drawer = page.getByRole('dialog', { name: 'Workspace sidebar' });
  const sidebar = page.getByRole('complementary', {
    name: 'Workspace sidebar',
  });
  await expect(drawer).toBeVisible();
  await expect(sidebar).toBeVisible();
  const { drawerWidth, sidebarWidth } = await sidebar.evaluate((element) => ({
    drawerWidth: element.parentElement?.getBoundingClientRect().width ?? 0,
    sidebarWidth: element.getBoundingClientRect().width,
  }));
  expect(sidebarWidth).toBeCloseTo(
    Math.min(Math.max(drawerWidth * 0.85, 220), 420),
    0,
  );
  expect(sidebarWidth).toBeLessThanOrEqual(drawerWidth);

  await page.screenshot({
    path: 'client/e2e/test-results/responsive-sidebar-drawer.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Collapse', exact: true }).tap();
  await expect(drawer).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => window.localStorage.getItem(key),
        SIDEBAR_WIDTH_STORAGE_KEY,
      ),
    )
    .toBe('512');

  await page.setViewportSize({ width: 700, height: 915 });
  await page.getByRole('button', { name: 'Toggle menu' }).click();
  await expect(drawer).toBeVisible();
  await expect
    .poll(() =>
      sidebar.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeCloseTo(420, 0);
  await page.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(drawer).toBeHidden();

  await page.setViewportSize({ width: 1000, height: 915 });
  await expect(sidebar).toBeVisible();
  // Width stays at the mobile-mount clamp: resize re-clamping only shrinks
  // within a session, and the drawer never expands toward the persisted 512.
  await expect
    .poll(() =>
      sidebar.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeCloseTo(420, 0);
});

test('tap, type, and Send submit through the shared prompt pipeline', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.tap();
  await page.keyboard.type('Ping from mobile');
  await expect(textarea).toHaveValue('Ping from mobile');

  const send = page.locator('[data-web-shell-composer-submit]');
  await expect(send).toBeEnabled();
  await send.tap();

  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  expectPromptBodyToContainText(
    firstRequestBody(daemon.promptRequests()),
    'Ping from mobile',
  );
  await expect(textarea).toHaveValue('');

  await daemon.sse.split(assistantTextEvent('Pong from fake SSE', { id: 10 }));
  await daemon.sendEvent(turnCompleteEvent('prompt-mobile', { id: 11 }));
  await expect(page.locator('[data-web-shell-message-list]')).toContainText(
    'Pong from fake SSE',
  );
});

test('Enter inserts a newline and does not submit', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.tap();
  await page.keyboard.type('line one');
  const singleLineHeight = (await textarea.boundingBox())!.height;
  await page.keyboard.press('Enter');
  await page.keyboard.type('line two');
  await page.keyboard.press('Enter');
  await page.keyboard.type('line three');

  await expect(textarea).toHaveValue('line one\nline two\nline three');
  expect(daemon.promptRequests()).toHaveLength(0);
  // The textarea auto-grows with its content instead of scrolling inside a
  // single visible line.
  await expect
    .poll(async () => (await textarea.boundingBox())!.height)
    .toBeGreaterThan(singleLineHeight);
});

test('keeps the textarea scrollable once content exceeds the height cap', async ({
  page,
}, testInfo) => {
  // Regression: the textarea is .editorArea's last child and used to inherit
  // `overflow: clip`, which pinned scrollTop to 0 once auto-grow hit the
  // CSS max-height — content beyond the cap became unreachable.
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.tap();
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join(
    '\n',
  );
  await textarea.fill(lines);

  // Auto-grow stops at the cap…
  await expect
    .poll(async () => (await textarea.boundingBox())!.height)
    .toBeGreaterThan(250);
  const metrics = await textarea.evaluate((el) => {
    el.scrollTop = 10_000;
    return {
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      maxHeight: getComputedStyle(el).maxHeight,
    };
  });
  expect(metrics.maxHeight).toBe('300px');
  expect((await textarea.boundingBox())!.height).toBeLessThanOrEqual(304);
  // …and the overflowing content stays reachable by scrolling.
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  expect(metrics.scrollTop).toBeGreaterThan(0);
  expect(metrics.scrollTop).toBeGreaterThanOrEqual(
    metrics.scrollHeight - metrics.clientHeight - 2,
  );
});

test('slash commands typed as text still execute as commands', async ({
  page,
}, testInfo) => {
  // The textarea backend has no slash completion menu, but commands are
  // interpreted from the submitted text at the App layer, so typing them
  // out still works.
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.tap();
  await page.keyboard.type('/help');
  await page.locator('[data-web-shell-composer-submit]').tap();

  await expect(page.getByRole('dialog', { name: 'Help' })).toBeVisible();
  expect(daemon.promptRequests()).toHaveLength(0);
  await expect(textarea).toHaveValue('');
});

test('?composer=codemirror escape hatch forces the CodeMirror path', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await page.goto(
    `/session/${encodeURIComponent(scenario.sessionId)}?composer=codemirror`,
  );
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  await completeReplay(page, daemon, scenario.sessionId);

  await expect(page.locator('.cm-editor')).toBeVisible();
  await expect(page.locator(COMPOSER_TEXTAREA)).toHaveCount(0);
});

for (const width of [390, 240]) {
  test(`editing row keeps 44px touch targets and fits the viewport at ${width}px @smoke`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const scenario = createWebShellDaemonScenario();
    const daemon = await installScenario(page, scenario, testInfo);
    await gotoSession(page, scenario, daemon);
    const textarea = page.locator(COMPOSER_TEXTAREA);
    await textarea.fill('当前草稿 😀\nsecond line');
    const buttons = page
      .locator('[data-web-shell-mobile-editing-actions]')
      .getByRole('button');
    // Pin the controls this scenario must render before measuring them, so a
    // dropped button fails the test instead of shrinking the iterated set.
    // (Hide keyboard is visible only while focused, while its reserved slot is
    // always present; fill does focus it. The standalone dev host always opts
    // into the Add entry, so the no-Add contextual buttons — Input history and
    // the Shell toggle — never render here and this loop does not measure them.)
    await expect(
      page.getByRole('button', { name: 'Expand editor', exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole('button', { name: 'Hide keyboard', exact: true }),
    ).toHaveCount(1);
    expect(await buttons.count()).toBeGreaterThan(0);
    for (const button of await buttons.all()) {
      const bounds = await button.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
  });
}

test('mobile editing preserves draft, selection and keyboard dismissal @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.fill('检查 😀 draft\nsecond line');
  await textarea.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(3, 5),
  );
  await page.getByRole('button', { name: 'Expand editor' }).tap();
  const dialog = page.locator('[data-web-shell-expanded-editor]');
  const expanded = dialog.getByRole('textbox');
  await expect(expanded).toHaveValue('检查 😀 draft\nsecond line');
  expect(
    await expanded.evaluate((element: HTMLTextAreaElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([3, 5]);
  await expanded.fill('edited 😀\nsecond line');
  await expanded.evaluate((element: HTMLTextAreaElement) => {
    element.setSelectionRange(2, 6);
    element.dispatchEvent(new Event('select', { bubbles: true }));
  });
  await dialog.getByRole('button', { name: 'Done', exact: true }).tap();
  await expect(dialog).toBeHidden();
  await expect(textarea).toHaveValue('edited 😀\nsecond line');
  expect(
    await textarea.evaluate((element: HTMLTextAreaElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([2, 6]);
  await page.getByRole('button', { name: 'Hide keyboard' }).tap();
  await expect(textarea).not.toBeFocused();
  await expect(textarea).toHaveValue('edited 😀\nsecond line');
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('expanded mobile editing retains attachment paste and selection exemptions @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);
  await page.locator(COMPOSER_TEXTAREA).fill('keep draft');
  await page.getByRole('button', { name: 'Expand editor' }).tap();
  const expanded = page.locator('[data-web-shell-expanded-editor] textarea');
  const pasteLongText = (selected: boolean) =>
    expanded.evaluate((element: HTMLTextAreaElement, replace) => {
      element.setSelectionRange(0, replace ? element.value.length : 0);
      const clipboard = new DataTransfer();
      clipboard.setData('text/plain', 'pasted line\n'.repeat(250));
      const event = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }, selected);
  expect(await pasteLongText(true)).toBe(false);
  await expect(
    page.locator('[data-web-shell-composer-attachments]'),
  ).toHaveCount(0);
  expect(await pasteLongText(false)).toBe(true);
  await expect(
    page.locator('[data-web-shell-expanded-attachments]'),
  ).toContainText('Attached files/images: 1');
  await expanded.evaluate((element) => {
    const clipboard = new DataTransfer();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const bytes = Uint8Array.from(
      atob(canvas.toDataURL().split(',')[1]),
      (value) => value.charCodeAt(0),
    );
    clipboard.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    );
  });
  await expect(
    page.locator('[data-web-shell-expanded-attachments]'),
  ).toContainText('Attached files/images: 2');
  await page.getByRole('button', { name: 'Done', exact: true }).tap();
  const attachments = page.locator('[data-web-shell-composer-attachments]');
  await expect(attachments).toContainText('pasted line');
  await expect(
    page.locator('[data-web-shell-composer-images] img'),
  ).toHaveCount(1);
  await expect(page.locator(COMPOSER_TEXTAREA)).toHaveValue('keep draft');
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('mobile drawer inserts commands without replacing or submitting the draft @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.fill('keep my instructions');
  await page.getByRole('button', { name: 'Add to message' }).tap();
  const drawer = page.locator('[data-web-shell-mobile-add-menu]');
  await expect(drawer).toBeVisible();
  await page.getByRole('button', { name: 'All commands', exact: true }).tap();
  await page.getByRole('textbox', { name: 'Search commands' }).fill('goal');
  await drawer.getByRole('button', { name: /^\/goal/ }).tap();
  await expect(drawer).toBeHidden();
  await expect(textarea).toHaveValue('/goal keep my instructions');
  expect(daemon.promptRequests()).toHaveLength(0);
  await page.getByRole('button', { name: 'Add to message' }).tap();
  await page.getByRole('button', { name: 'Input history', exact: true }).tap();
  await expect(
    page.locator('[data-web-shell-composer-history-search]'),
  ).toBeVisible();
  await page
    .locator('[data-web-shell-composer-surface]')
    .getByRole('button', { name: 'close', exact: true })
    .tap();
  await expect(textarea).toHaveValue('/goal keep my instructions');
});

test('mobile stop remains reachable with a queued draft @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.fill('start a turn');
  await page.locator('[data-web-shell-composer-submit]').tap();
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  await textarea.fill('keep this follow-up');
  const stop = page.locator('[data-web-shell-composer-stop]');
  await expect(stop).toBeVisible();
  await expect(page.locator('[data-web-shell-composer-submit]')).toBeEnabled();
  await stop.tap();
  await expect
    .poll(() =>
      daemon.requests.some((request) => request.path.endsWith('/cancel')),
    )
    .toBe(true);
  await expect(textarea).toHaveValue('keep this follow-up');
});

// 412x360 is a smaller phone once the soft keyboard has resized the viewport.
// With attachments the composer fills its cap, leaving less room below the
// header than the search panel's minimum height.
test('mobile history search stays reachable above a soft keyboard @smoke', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 412, height: 360 });
  await page.addInitScript(() =>
    localStorage.setItem(
      'qwen-web-shell-history',
      JSON.stringify(
        Array.from({ length: 8 }, (_, index) => `saved input ${index + 1}`),
      ),
    ),
  );
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.tap();
  await pasteFiles(textarea, ['first.png', 'notes-one.txt', 'notes-two.txt']);
  await textarea.fill('working draft');
  await page.getByRole('button', { name: 'Add to message' }).tap();
  await page.getByRole('button', { name: 'Input history', exact: true }).tap();
  const search = page.locator('[data-web-shell-composer-history-search]');
  await expect(search).toBeFocused();
  const close = page
    .locator('[data-web-shell-composer-surface]')
    .getByRole('button', { name: 'close', exact: true });
  // Polled: the Add drawer's closing overlay briefly covers the page.
  for (const control of [search, close]) {
    await expect.poll(() => isUncovered(control, { topEdge: true })).toBe(true);
  }
  // Not even the panel's minimum height fits, so it overlaps the composer.
  const shift = await search.evaluate(
    (element) =>
      element
        .closest<HTMLElement>('[style*="--chat-editor-search-shift"]')
        ?.style.getPropertyValue('--chat-editor-search-shift') ?? null,
  );
  expect(shift).not.toBeNull();
  expect(Number.parseFloat(shift!)).toBeGreaterThan(0);
  await close.tap();
  await expect(textarea).toHaveValue('working draft');
  await expect(textarea).toBeFocused();
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('mobile context icon is centered in a compact toolbar target @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    state: {
      models: {
        currentModelId: 'qwen-test',
        availableModels: [
          { modelId: 'qwen-test', name: 'Qwen Test', contextLimit: 100_000 },
        ],
      },
    },
  });
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);
  await daemon.sendEvent({
    id: 20,
    v: 1,
    type: 'session_update',
    data: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: { usage: { inputTokens: 1000 } },
      },
    },
  });
  const context = page.locator('[data-web-shell-context-usage]');
  await expect(context).toBeVisible();
  const button = (await context.boundingBox())!;
  const icon = (await context.locator('svg').boundingBox())!;
  expect(button.width).toBe(44);
  expect(button.height).toBe(44);
  expect(
    Math.abs(icon.x + icon.width / 2 - button.x - button.width / 2),
  ).toBeLessThanOrEqual(1);
  const send = (await page
    .locator('[data-web-shell-composer-submit]')
    .boundingBox())!;
  expect(send.x - button.x - button.width).toBeGreaterThanOrEqual(0);
  expect(send.x - button.x - button.width).toBeLessThanOrEqual(4);
  const add = (await page
    .getByTestId('composer-add-menu-trigger')
    .boundingBox())!;
  const approval = (await page
    .locator('[data-web-shell-mode-button]')
    .boundingBox())!;
  expect(approval.x - add.x - add.width).toBe(0);
  await page.locator('[data-web-shell-composer]').screenshot({
    path: testInfo.outputPath('mobile-toolbar-spacing.png'),
  });
  await page.setViewportSize({ width: 1200, height: 844 });
  const percentage = context.locator('span[aria-hidden="true"]');
  await expect
    .poll(() =>
      percentage.evaluate((element) => {
        const label = element.getBoundingClientRect();
        const target = element.closest('button')!.getBoundingClientRect();
        return (
          label.width > 0 &&
          label.left >= target.left &&
          label.right <= target.right
        );
      }),
    )
    .toBe(true);
});

test('mobile workspace controls share the editing row without overlapping @smoke', async ({
  page,
}, testInfo) => {
  await installScenario(page, createGitWorkspaceScenario(), testInfo);
  await page.goto('/');
  const branch = page.locator('[data-web-shell-git-branch]');
  await expect(branch).toBeVisible({ timeout: 10_000 });
  const chevron = branch.locator(':scope > svg');
  await expect(chevron).toHaveCSS('width', '9px');
  await expect(chevron).toHaveCSS('height', '9px');
  await expect(
    page
      .getByRole('button', { name: 'Expand editor', exact: true })
      .locator('svg'),
  ).toHaveCSS('width', '18px');
  const branchBox = (await branch.boundingBox())!;
  const actions = page.locator('[data-web-shell-mobile-editing-actions]');
  await expect(actions.locator('[data-web-shell-git-branch]')).toBeVisible();
  const expandBox = (await page
    .getByRole('button', { name: 'Expand editor', exact: true })
    .boundingBox())!;
  expect(branchBox.x + branchBox.width).toBeLessThanOrEqual(expandBox.x);
});

for (const width of [240, 310, 320, 345, 390]) {
  test(`mobile workspace opens on the first tap and keeps editing controls accessible at ${width}px @smoke`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const workspaceCwd = `/tmp/${'long-workspace-name-'.repeat(6)}`;
    const scenario = createGitWorkspaceScenario({
      gitStatus: { v: 2, workspaceCwd, branch: 'main' },
    });
    scenario.capabilities.workspaces![0]!.cwd = workspaceCwd;
    scenario.capabilities.workspaces!.push({
      id: 'secondary',
      cwd: '/tmp/another-project',
      primary: false,
      trusted: true,
    });
    await installScenario(page, scenario, testInfo);
    await page.goto('/');
    const textarea = page.locator(COMPOSER_TEXTAREA);
    const composer = page.locator('[data-web-shell-composer]');
    const editingKeys = composer.locator(
      '[data-web-shell-mobile-editing-keys]',
    );
    const workspace = composer.locator('button[aria-label="Workspace"]');
    const keyboard = composer.getByRole('button', {
      name: 'Hide keyboard',
      exact: true,
    });
    await textarea.tap();
    await expect(keyboard).toBeVisible();
    await textarea.evaluate((element) => element.blur());
    await expect(keyboard).toBeHidden();
    await expect(
      composer.locator('button[aria-label="Hide keyboard"]'),
    ).toHaveCSS('visibility', 'hidden');
    const idleEditingHeight = (await editingKeys.boundingBox())!.height;
    await textarea.tap();
    await expect(keyboard).toBeVisible();
    const focusedEditingHeight = (await editingKeys.boundingBox())!.height;
    expect(
      Math.abs(focusedEditingHeight - idleEditingHeight),
    ).toBeLessThanOrEqual(1);
    const workspaceBeforeTap = (await workspace.boundingBox())!;
    const value = workspace.locator('[data-slot="select-value"]');
    const initialWorkspaceLabel = await value.innerText();
    if (await value.isVisible()) {
      expect(
        await value.evaluate(
          (element) => element.scrollWidth > element.clientWidth,
        ),
      ).toBe(true);
    }
    await expect(workspace).toHaveAttribute('aria-expanded', 'false');
    await workspace.tap();
    await expect(workspace).toHaveAttribute('aria-expanded', 'true');
    const workspaceMenu = page.getByRole('menu');
    const workspaceOptions = page.getByRole('menuitemradio');
    await expect(workspaceMenu).toBeVisible();
    const workspaceAfterTap = (await workspace.boundingBox())!;
    expect(workspaceAfterTap.y).toBeCloseTo(workspaceBeforeTap.y, 0);
    expect((await editingKeys.boundingBox())!.height).toBeCloseTo(
      focusedEditingHeight,
      0,
    );
    await expect(workspaceOptions).toHaveCount(2);
    await expect(workspaceOptions.first()).toBeVisible();
    await expect.poll(() => isUncovered(workspaceOptions.first())).toBe(true);
    await workspaceOptions.nth(1).tap();
    await expect(workspaceMenu).toHaveCount(0);
    await expect(value).toHaveText('another-project');
    await expect(value).not.toHaveText(initialWorkspaceLabel);
    await textarea.tap();
    await expect(keyboard).toBeVisible();
    const workspaceBox = (await workspace.boundingBox())!;
    const keyboardBox = (await keyboard.boundingBox())!;
    await expect(workspace.locator(':scope > svg')).toHaveCSS('width', '16px');
    expect(keyboardBox.y).toBeGreaterThanOrEqual(
      workspaceBox.y + workspaceBox.height,
    );
    const expandBox = (await composer
      .getByRole('button', { name: 'Expand editor', exact: true })
      .boundingBox())!;
    expect(Math.abs(keyboardBox.y - expandBox.y)).toBeLessThanOrEqual(1);
    expect(expandBox.x).toBeGreaterThanOrEqual(
      keyboardBox.x + keyboardBox.width,
    );
    expect(
      Math.abs(expandBox.x - keyboardBox.x - keyboardBox.width - 4),
    ).toBeLessThanOrEqual(1);
    expect(keyboardBox.width).toBeGreaterThanOrEqual(44);
    expect(keyboardBox.height).toBeGreaterThanOrEqual(44);
    expect(expandBox.width).toBeGreaterThanOrEqual(44);
    expect(expandBox.height).toBeGreaterThanOrEqual(44);
    expect(expandBox.x + expandBox.width).toBeLessThanOrEqual(width);
    const branchLabel = composer.locator('[data-web-shell-git-branch-label]');
    await expect(branchLabel).toHaveCount(1);
    if (width === 240) {
      await expect(value).toBeHidden();
      await expect(branchLabel).toBeHidden();
      await expect(workspace).toBeVisible();
      await expect(
        composer.locator('[data-web-shell-git-branch]'),
      ).toBeVisible();
    } else {
      if (await value.isVisible()) {
        expect(
          await value.evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
        ).toBe(true);
      }
      if (await branchLabel.isVisible()) {
        expect(
          await branchLabel.evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
        ).toBe(true);
      }
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await composer.screenshot({
      path: testInfo.outputPath(`mobile-composer-${width}.png`),
    });
  });
}

test('mobile compact branch keeps a visible conflict indicator and usable menu @smoke', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const scenario = createGitWorkspaceScenario({
    gitStatus: {
      v: 2,
      workspaceCwd: '/tmp/qwen-web-shell-e2e',
      branch: 'main',
      conflicted: 1,
    },
  });
  scenario.capabilities.workspaces!.push({
    id: 'secondary',
    cwd: '/tmp/another-project',
    primary: false,
    trusted: true,
  });
  await installScenario(page, scenario, testInfo);
  await page.goto('/');
  await page.locator(COMPOSER_TEXTAREA).tap();
  const branch = page.getByTestId('git-mode-chip');
  await expect(branch).toHaveAttribute(
    'aria-label',
    'Git mode: main — 1 conflicted',
  );
  const indicator = branch.locator('[data-tone="error"]');
  await expect(indicator).toHaveCount(1);
  await expect(indicator).toBeVisible();
  const indicatorBounds = (await indicator.boundingBox())!;
  expect(indicatorBounds.width).toBeGreaterThanOrEqual(7);
  expect(indicatorBounds.height).toBeGreaterThanOrEqual(7);
  expect(
    await indicator.evaluate((element) => getComputedStyle(element).display),
  ).not.toBe('none');
  await page.screenshot({
    path: testInfo.outputPath('branch-conflict-320.png'),
  });
  await branch.tap();
  await expect(branch).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('radio', { name: /Worktree/ })).toBeVisible();
});

// 412x450 is a Pixel 7 once the soft keyboard has resized the viewport. A
// second workspace and a long branch wrap the workspace row onto two lines.
test('mobile attachments stay reachable above a soft keyboard @smoke', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 412, height: 450 });
  const scenario = createGitWorkspaceScenario({
    gitStatus: {
      v: 2,
      workspaceCwd: '/tmp/qwen-web-shell-e2e',
      branch: `feature/${'a'.repeat(60)}`,
    },
  });
  scenario.capabilities.workspaces!.push({
    id: 'secondary',
    cwd: '/tmp/another-project',
    trusted: true,
    primary: false,
  });
  await installScenario(page, scenario, testInfo);
  await page.goto('/');
  const branch = page.locator('[data-web-shell-git-branch]');
  await expect(branch).toBeVisible({ timeout: 10_000 });
  const workspace = page
    .locator('[data-web-shell-composer-surface]')
    .getByRole('button', { name: 'Workspace', exact: true });
  expect((await branch.boundingBox())!.y).toBeGreaterThan(
    (await workspace.boundingBox())!.y,
  );
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.tap();
  await pasteFiles(textarea, ['first.png', 'notes-one.txt', 'notes-two.txt']);
  const remove = page.getByRole('button', { name: 'Remove notes-two.txt' });
  await expect(remove).toBeAttached();
  // The strip caps its own height, so the trailing card is scrolled to first.
  const strip = page.locator('[data-web-shell-composer-attachments]');
  await expect
    .poll(async () => {
      await strip.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      return isUncovered(remove);
    })
    .toBe(true);
});

// 412x360 is below the height at which the strip stays readable (see the
// design doc), so the strip is a sliver either way; what the height-cap rule
// must hold even there is that showing the workspace row never shrinks it.
test('mobile workspace row does not shrink the attachments strip @smoke', async ({
  page,
}, testInfo) => {
  const stripHeight = async (
    target: Page,
    scenario: WebShellDaemonScenario,
    withRow: boolean,
  ): Promise<number> => {
    await target.setViewportSize({ width: 412, height: 360 });
    await installScenario(target, scenario, testInfo);
    await target.goto('/');
    const textarea = target.locator(COMPOSER_TEXTAREA);
    await expect(textarea).toBeVisible();
    if (withRow) {
      await expect(target.locator('[data-web-shell-git-branch]')).toBeVisible({
        timeout: 10_000,
      });
    }
    await textarea.tap();
    await pasteFiles(textarea, ['first.png', 'notes-one.txt', 'notes-two.txt']);
    const strip = target.locator('[data-web-shell-composer-attachments]');
    // Attached, not visible: when the cap rule is broken the strip collapses
    // to 0px, and the comparison below — not the wait — should be what fails.
    await expect(strip).toBeAttached();
    return strip.evaluate((element) => element.getBoundingClientRect().height);
  };
  const withRow = await stripHeight(page, createGitWorkspaceScenario(), true);
  const secondPage = await page.context().newPage();
  try {
    const withoutRow = await stripHeight(
      secondPage,
      createWebShellDaemonScenario(),
      false,
    );
    expect(withRow).toBeGreaterThanOrEqual(withoutRow);
  } finally {
    await secondPage.close();
  }
});

// Pastes each file as its own clipboard event, like a phone keyboard does.
async function pasteFiles(textarea: Locator, names: string[]): Promise<void> {
  await textarea.evaluate(async (element, fileNames) => {
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 90;
    const png = await new Promise<Blob>((resolve) =>
      canvas.toBlob((blob) => resolve(blob!), 'image/png'),
    );
    for (const name of fileNames) {
      const data = new DataTransfer();
      data.items.add(
        name.endsWith('.png')
          ? new File([png], name, { type: 'image/png' })
          : new File(['notes\n'], name, { type: 'text/plain' }),
      );
      element.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, names);
}

// True when the control is topmost at its centre and, with `topEdge`, also
// just inside its top edge, so a control half under the header cannot pass.
function isUncovered(
  control: Locator,
  { topEdge = false } = {},
): Promise<boolean> {
  return control.evaluate((element, checkTopEdge) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const ys = [rect.top + rect.height / 2];
    if (checkTopEdge) ys.push(rect.top + 1);
    return ys.every((y) => {
      const hit = document.elementFromPoint(x, y);
      return element === hit || element.contains(hit);
    });
  }, topEdge);
}

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
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
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

function firstRequestBody(
  requests: readonly DaemonRequestRecord[],
): Record<string, unknown> {
  const request = requests[0];
  if (!request) throw new Error('Expected a recorded daemon request.');
  expect(typeof request.body).toBe('object');
  expect(request.body).not.toBeNull();
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
        typeof block === 'object' &&
        block !== null &&
        (block as Record<string, unknown>)['type'] === 'text' &&
        (block as Record<string, unknown>)['text'] === text,
    ),
  ).toBe(true);
}

test('mobile history search restores results and draft focus @smoke', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 240, height: 700 });
  await page.addInitScript(() =>
    localStorage.setItem(
      'qwen-web-shell-history',
      JSON.stringify(['older saved input', 'newer saved input']),
    ),
  );
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.fill('working draft');
  const open = async () => {
    await page.getByRole('button', { name: 'Add to message' }).tap();
    await page
      .getByRole('button', { name: 'Input history', exact: true })
      .tap();
  };
  await open();
  const search = page.locator('[data-web-shell-composer-history-search]');
  await expect(search).toBeFocused();
  expect((await search.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(search).toHaveCSS('font-size', '16px');
  await search.fill('older');
  await page.getByRole('button', { name: /older saved input/ }).tap();
  await expect(textarea).toHaveValue('older saved input');
  await expect(textarea).toBeFocused();
  await textarea.fill('another draft');
  await open();
  await page
    .locator('[data-web-shell-composer-surface]')
    .getByRole('button', { name: 'close', exact: true })
    .tap();
  await expect(textarea).toHaveValue('another draft');
  await expect(textarea).toBeFocused();
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('mobile Shell entry closes the drawer and returns editor focus @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.fill('keep draft');
  await page.getByRole('button', { name: 'Add to message', exact: true }).tap();
  await page.getByRole('button', { name: 'Shell mode', exact: true }).tap();
  await expect(textarea).toBeFocused();
  await expect(textarea).toHaveValue('keep draft');
  await expect(
    page.getByRole('button', { name: 'Exit Shell', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add to message', exact: true }).tap();
  const drawer = page.locator('[data-web-shell-mobile-add-menu]');
  await expect(
    drawer.getByRole('button', { name: 'All commands', exact: true }),
  ).toHaveCount(0);
  await expect(
    drawer.getByRole('button', { name: 'Skills', exact: true }),
  ).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Exit Shell', exact: true }).tap();
  await expect(textarea).toBeFocused();
  await expect(textarea).toHaveValue('keep draft');
  expect(daemon.promptRequests()).toHaveLength(0);
});
