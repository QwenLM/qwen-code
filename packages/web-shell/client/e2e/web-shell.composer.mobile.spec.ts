/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Mobile composer backend (#5958). Runs under the `mobile-chromium` (Pixel 7)
// and `mobile-webkit` (iPhone 13) projects — both emulate touch, coarse
// pointer, and no hover — where the composer must render the plain-textarea
// backend instead of CodeMirror.

import { expect, test, type Page, type TestInfo } from '@playwright/test';
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

const COMPOSER_TEXTAREA = 'textarea[data-web-shell-composer-editor]';
const SIDEBAR_WIDTH_STORAGE_KEY = 'qwen-code-web-shell-sidebar-width';

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

  await textarea.tap();
  await textarea.fill('Composer remains interactive on touch devices');
  await expect(textarea).toHaveValue(
    'Composer remains interactive on touch devices',
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
  expect(sidebarWidth).toBeCloseTo(drawerWidth * 0.7, 0);
  expect(sidebarWidth).toBeLessThanOrEqual(drawerWidth);

  await page.screenshot({
    path: 'client/e2e/test-results/responsive-sidebar-drawer.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Collapse' }).tap();
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
  await page.getByRole('button', { name: 'Collapse' }).click();
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

test('history arrows recall the first welcome submission @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await page.goto('/');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.fill('First input from mobile');
  await page.locator('[data-web-shell-composer-submit]').tap();
  await completeReplay(page, daemon, scenario.sessionId);
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  await daemon.sendEvent(turnCompleteEvent('prompt-mobile', { id: 11 }));
  await expect(textarea).toHaveValue('');

  const draft = 'New draft 😀\nsecond line';
  await textarea.fill(draft);
  await page.getByRole('button', { name: 'Previous input', exact: true }).tap();
  await expect(textarea).toHaveValue('First input from mobile');
  await expect(textarea).toBeFocused();
  await page.getByRole('button', { name: 'Next input', exact: true }).tap();
  await expect(textarea).toHaveValue(draft);
  expect(daemon.promptRequests()).toHaveLength(1);
});

for (const width of [390, 240]) {
  test(`history arrows restore the draft without submitting at ${width}px @smoke`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      localStorage.setItem(
        'qwen-web-shell-history',
        JSON.stringify(['first input', 'second input']),
      );
    });
    const scenario = createWebShellDaemonScenario();
    const daemon = await installScenario(page, scenario, testInfo);
    await gotoSession(page, scenario, daemon);
    const textarea = page.locator(COMPOSER_TEXTAREA);
    const draft = '当前草稿 😀\nsecond line';
    await textarea.fill(draft);
    const previous = page.getByRole('button', {
      name: 'Previous input',
      exact: true,
    });
    const next = page.getByRole('button', { name: 'Next input', exact: true });
    for (const button of [
      previous,
      next,
      page.getByRole('button', { name: 'Hide keyboard', exact: true }),
      page.getByRole('button', { name: 'Expand editor', exact: true }),
    ]) {
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
    await next.tap();
    await expect(textarea).toHaveValue(draft);
    await previous.tap();
    await expect(textarea).toHaveValue('second input');
    await expect(textarea).toBeFocused();
    await previous.tap();
    await expect(textarea).toHaveValue('first input');
    await previous.tap();
    await expect(textarea).toHaveValue('first input');
    await next.tap();
    await expect(textarea).toHaveValue('second input');
    await next.tap();
    await expect(textarea).toHaveValue(draft);
    await next.tap();
    await expect(textarea).toHaveValue(draft);
    expect(daemon.promptRequests()).toHaveLength(0);
  });
}

test('history arrows leave the draft intact when history is empty', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.fill('keep this draft');
  await page.getByRole('button', { name: 'Previous input', exact: true }).tap();
  await page.getByRole('button', { name: 'Next input', exact: true }).tap();
  await expect(textarea).toHaveValue('keep this draft');
  expect(daemon.promptRequests()).toHaveLength(0);
});

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
