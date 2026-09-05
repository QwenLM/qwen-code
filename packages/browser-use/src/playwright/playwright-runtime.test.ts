/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Browser,
  BrowserContext,
  Dialog,
  Frame,
  Locator,
  Page,
} from 'playwright-core';
import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChromeBridge } from '../bridge/index.js';
import type { ScreenshotEnvelope, TabInfo } from '../core/primitives.js';
import { PlaywrightRuntime } from './playwright-runtime.js';

const playwrightMocks = vi.hoisted(() => ({
  connectOverCDP: vi.fn(),
}));

vi.mock('playwright-core', () => ({
  chromium: { connectOverCDP: playwrightMocks.connectOverCDP },
}));

const runtimes: PlaywrightRuntime[] = [];

beforeEach(() => {
  playwrightMocks.connectOverCDP.mockReset();
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
});

describe('PlaywrightRuntime command contracts', () => {
  it('selects Chrome by canonical id, family, or client type', async () => {
    const fixture = await runtimeFixture();

    for (const id of ['chrome', 'extension']) {
      await expect(
        fixture.runtime.dispatch('browsers.get', { id }),
      ).resolves.toEqual(
        expect.objectContaining({
          id: 'chrome',
          family: 'chrome',
          type: 'extension',
        }),
      );
    }
    await expect(
      fixture.runtime.dispatch('browsers.get', { id: 'edge' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('delegates tab navigation to Playwright', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);

    await fixture.runtime.dispatch('tab.goto', {
      tabId: tab.id,
      url: 'https://example.com/next',
    });
    await fixture.runtime.dispatch('tab.back', { tabId: tab.id });
    await fixture.runtime.dispatch('tab.reload', {
      tabId: tab.id,
    });

    expect(fixture.page.goto).toHaveBeenCalledWith('https://example.com/next');
    expect(fixture.page.goBack).toHaveBeenCalledWith();
    expect(fixture.page.reload).toHaveBeenCalledWith();
  });

  it('builds locator plans and delegates read and input operations', async () => {
    const fixture = await runtimeFixture();
    fixture.locator.evaluate
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('hello');
    const tab = await createTab(fixture.runtime);
    const steps = [
      {
        kind: 'getByRole' as const,
        role: 'button',
        name: { regex: 'save', flags: 'i' },
        exact: true,
      },
      { kind: 'first' as const },
    ];

    await expect(
      fixture.runtime.dispatch('locator.count', {
        tabId: tab.id,
        steps,
      }),
    ).resolves.toBe(3);
    await fixture.runtime.dispatch('locator.click', {
      tabId: tab.id,
      steps,
      button: 'right',
      modifiers: ['Shift'],
      force: true,
      timeoutMs: 456,
    });
    await fixture.runtime.dispatch('locator.type', {
      tabId: tab.id,
      steps,
      value: 'hello',
      timeoutMs: 789,
    });

    expect(fixture.page.getByRole).toHaveBeenCalledWith('button', {
      name: /save/i,
      exact: true,
    });
    expect(fixture.locator.first).toHaveBeenCalled();
    expect(fixture.locator.click).toHaveBeenCalledWith({
      button: 'right',
      modifiers: ['Shift'],
      force: true,
      timeout: 456,
    });
    expect(fixture.locator.pressSequentially).toHaveBeenCalledWith('hello', {
      timeout: 789,
    });
    expect(fixture.locator.press).not.toHaveBeenCalled();
    expect(fixture.page.bringToFront).toHaveBeenCalledTimes(2);
    expect(fixture.page.evaluate).toHaveBeenCalledTimes(2);
  });

  it('reports when Chrome browser UI swallows locator typing', async () => {
    const fixture = await runtimeFixture();
    fixture.locator.evaluate.mockResolvedValue('');
    const tab = await createTab(fixture.runtime);

    await expect(
      fixture.runtime.dispatch('locator.type', {
        tabId: tab.id,
        steps: [{ kind: 'locator', selector: '#field' }],
        value: 'hello',
      }),
    ).rejects.toMatchObject({ code: 'INPUT_BLOCKED' });
  });

  it('uses short locator action defaults without shortening explicit waits', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    const steps = [{ kind: 'locator' as const, selector: '#target' }];

    await fixture.runtime.dispatch('locator.click', { tabId: tab.id, steps });
    await fixture.runtime.dispatch('locator.getAttribute', {
      tabId: tab.id,
      steps,
      name: 'aria-label',
    });
    await fixture.runtime.dispatch('locator.waitFor', {
      tabId: tab.id,
      steps,
      state: 'visible',
    });

    expect(fixture.locator.click).toHaveBeenCalledWith({
      button: 'left',
      modifiers: [],
      timeout: 5_000,
    });
    expect(fixture.locator.getAttribute).toHaveBeenCalledWith('aria-label', {
      timeout: 1_000,
    });
    expect(fixture.locator.waitFor).toHaveBeenCalledWith({
      state: 'visible',
      timeout: 30_000,
    });
  });

  it('brings the target page forward and drains renderer input tasks', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);

    await fixture.runtime.dispatch('locator.click', {
      tabId: tab.id,
      steps: [{ kind: 'locator', selector: '#button' }],
    });

    expect(fixture.page.bringToFront).toHaveBeenCalledOnce();
    expect(fixture.locator.click).toHaveBeenCalledOnce();
    expect(fixture.page.evaluate).toHaveBeenCalledOnce();
    expect(fixture.page.bringToFront.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.locator.click.mock.invocationCallOrder[0] ?? 0,
    );
    expect(fixture.locator.click.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.page.evaluate.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('delegates coordinate input and snapshot capture', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);

    await fixture.runtime.dispatch('cua.click', {
      tabId: tab.id,
      x: 12,
      y: 34,
      button: 2,
      keypress: ['Alt'],
    });
    await expect(
      fixture.runtime.dispatch('playwright.domSnapshot', {
        tabId: tab.id,
      }),
    ).resolves.toBe('- button "Save" [ref=e1]');

    expect(fixture.page.keyboard.down).toHaveBeenCalledWith('Alt');
    expect(fixture.page.mouse.click).toHaveBeenCalledWith(12, 34, {
      button: 'middle',
    });
    expect(fixture.page.keyboard.up).toHaveBeenCalledWith('Alt');
    expect(fixture.page.ariaSnapshot).toHaveBeenCalledWith({ mode: 'ai' });
    expect(fixture.page.bringToFront).toHaveBeenCalledTimes(1);
  });

  it('delegates snapshot ref actions to Playwright aria-ref locators', async () => {
    const fixture = await runtimeFixture();
    fixture.locator.count.mockResolvedValue(1);
    fixture.page.ariaSnapshot.mockResolvedValueOnce(
      '- heading "Settings" [level=1]\n- button "Save" [ref=e1]',
    );
    const tab = await createTab(fixture.runtime);

    await expect(
      fixture.runtime.dispatch('dom_cua.get_visible_dom', {
        tabId: tab.id,
      }),
    ).resolves.toBe('- button "Save" [ref=e1]');
    await fixture.runtime.dispatch('dom_cua.click', {
      tabId: tab.id,
      node_id: 'f1e2',
    });
    await fixture.runtime.dispatch('dom_cua.type', {
      tabId: tab.id,
      text: 'hello',
    });
    await fixture.runtime.dispatch('dom_cua.keypress', {
      tabId: tab.id,
      keys: ['Control', 'a'],
    });
    await fixture.runtime.dispatch('dom_cua.scroll', {
      tabId: tab.id,
      node_id: 'f1e2',
      x: 0,
      y: 200,
    });

    expect(fixture.page.locator).toHaveBeenCalledWith('aria-ref=f1e2');
    expect(fixture.locator.click).toHaveBeenCalledWith({
      button: 'left',
      modifiers: [],
      timeout: 30_000,
    });
    expect(fixture.page.keyboard.insertText).toHaveBeenCalledWith('hello');
    expect(fixture.page.keyboard.press).toHaveBeenCalledWith('Control+a');
    expect(fixture.locator.hover).toHaveBeenCalledWith();
    expect(fixture.page.mouse.wheel).toHaveBeenCalledWith(0, 200);
    expect(fixture.locator.pressSequentially).not.toHaveBeenCalled();
    expect(fixture.locator.press).not.toHaveBeenCalled();
    expect(fixture.page.bringToFront).toHaveBeenCalledTimes(4);
  });

  it('dispatches the browser back mouse button through CDP', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);

    await fixture.runtime.dispatch('cua.click', {
      tabId: tab.id,
      x: 12,
      y: 34,
      button: 4,
      keypress: ['Shift'],
    });

    expect(fixture.page.mouse.click).not.toHaveBeenCalled();
    expect(fixture.cdp.send).toHaveBeenNthCalledWith(
      1,
      'Input.dispatchMouseEvent',
      {
        type: 'mousePressed',
        x: 12,
        y: 34,
        button: 'back',
        buttons: 8,
        clickCount: 1,
        modifiers: 8,
      },
    );
    expect(fixture.cdp.send).toHaveBeenNthCalledWith(
      2,
      'Input.dispatchMouseEvent',
      {
        type: 'mouseReleased',
        x: 12,
        y: 34,
        button: 'back',
        buttons: 0,
        clickCount: 1,
        modifiers: 8,
      },
    );
    expect(fixture.cdp.detach).toHaveBeenCalledOnce();
  });

  it('preserves an auxiliary click failure when cleanup also fails', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    fixture.cdp.send.mockRejectedValueOnce(new Error('primary input failure'));
    fixture.page.keyboard.up.mockRejectedValueOnce(
      new Error('modifier cleanup failure'),
    );
    fixture.cdp.detach.mockRejectedValueOnce(
      new Error('session cleanup failure'),
    );

    await expect(
      fixture.runtime.dispatch('cua.click', {
        tabId: tab.id,
        x: 12,
        y: 34,
        button: 4,
        keypress: ['Shift'],
      }),
    ).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      message: 'cua.click failed: primary input failure',
    });
    expect(fixture.page.keyboard.up).toHaveBeenCalledWith('Shift');
    expect(fixture.cdp.detach).toHaveBeenCalledOnce();
  });

  it('binds a registered tab to the page with the matching target id', async () => {
    const fixture = await runtimeFixture({ unrelatedPage: true });

    const tab = await createTab(fixture.runtime);

    await expect(
      fixture.runtime.dispatch('tab.title', { tabId: tab.id }),
    ).resolves.toBe('Fixture');
  });

  it('delegates locator reads, form actions, and waits', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    const steps = [{ kind: 'locator' as const, selector: '#field' }];

    await expect(
      fixture.runtime.dispatch('locator.getAttribute', {
        tabId: tab.id,
        steps,
        name: 'aria-label',
        timeoutMs: 11,
      }),
    ).resolves.toBe('Field');
    await fixture.runtime.dispatch('locator.fill', {
      tabId: tab.id,
      steps,
      value: 'value',
      timeoutMs: 12,
    });
    await fixture.runtime.dispatch('locator.downloadMedia', {
      tabId: tab.id,
      steps,
      timeoutMs: 16,
    });
    await expect(
      fixture.runtime.dispatch('locator.selectOption', {
        tabId: tab.id,
        steps,
        value: { label: 'Choice' },
        timeoutMs: 13,
      }),
    ).resolves.toBeNull();
    await fixture.runtime.dispatch('locator.setChecked', {
      tabId: tab.id,
      steps,
      checked: true,
      force: true,
      timeoutMs: 15,
    });
    await fixture.runtime.dispatch('locator.waitFor', {
      tabId: tab.id,
      steps,
      state: 'hidden',
      timeoutMs: 14,
    });

    expect(fixture.page.locator).toHaveBeenCalledWith('#field');
    expect(fixture.locator.getAttribute).toHaveBeenCalledWith('aria-label', {
      timeout: 11,
    });
    expect(fixture.locator.fill).toHaveBeenCalledWith('value', { timeout: 12 });
    expect(fixture.locator.dispatchEvent).toHaveBeenCalledWith(
      'change',
      { bubbles: true },
      { timeout: 12 },
    );
    expect(fixture.locator.evaluate).toHaveBeenCalledWith(
      expect.any(Function),
      undefined,
      { timeout: 16 },
    );
    expect(fixture.locator.selectOption).toHaveBeenCalledWith(
      { label: 'Choice' },
      { timeout: 13 },
    );
    expect(fixture.locator.setChecked).toHaveBeenCalledWith(true, {
      force: true,
      timeout: 15,
    });
    expect(fixture.locator.waitFor).toHaveBeenCalledWith({
      state: 'hidden',
      timeout: 14,
    });
  });

  it('uses Playwright navigation watchers without polling URLs', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);

    const waiterId = (await fixture.runtime.dispatch(
      'playwright.expectNavigation.begin',
      {
        tabId: tab.id,
        url: '**/complete',
        waitUntil: 'load',
        timeoutMs: 2_000,
      },
    )) as string;
    await fixture.runtime.dispatch('playwright.expectNavigation.wait', {
      tabId: tab.id,
      waiterId,
    });

    expect(fixture.page.waitForNavigation).toHaveBeenCalledWith({
      url: '**/complete',
      waitUntil: 'load',
      timeout: 2_000,
    });
  });

  it('returns an opaque result after observing a download', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);

    await expect(
      fixture.runtime.dispatch('playwright.waitForEvent', {
        tabId: tab.id,
        event: 'download',
        timeoutMs: 1_234,
      }),
    ).resolves.toEqual({});
    expect(fixture.page.waitForEvent).toHaveBeenCalledWith('download', {
      timeout: 1_234,
    });
  });

  it('bounds unresolved file choosers and navigation waiters', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    const chooser = {
      isMultiple: () => false,
      setFiles: vi.fn(async () => undefined),
    };
    fixture.page.waitForEvent.mockResolvedValue(chooser);
    const chooserIds: string[] = [];
    const waiterIds: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      const chooserResult = (await fixture.runtime.dispatch(
        'playwright.waitForEvent',
        {
          tabId: tab.id,
          event: 'filechooser',
        },
      )) as { chooserId: string };
      chooserIds.push(chooserResult.chooserId);
      waiterIds.push(
        (await fixture.runtime.dispatch('playwright.expectNavigation.begin', {
          tabId: tab.id,
        })) as string,
      );
    }

    await expect(
      fixture.runtime.dispatch('fileChooser.setFiles', {
        tabId: tab.id,
        chooserId: chooserIds[0],
        files: ['/unused'],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      fixture.runtime.dispatch('playwright.expectNavigation.wait', {
        tabId: tab.id,
        waiterId: waiterIds[0],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      fixture.runtime.dispatch('playwright.expectNavigation.wait', {
        tabId: tab.id,
        waiterId: waiterIds.at(-1),
      }),
    ).resolves.toBeNull();
  });

  it('returns encoded screenshot bytes across the JSON boundary', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);

    const screenshot = (await fixture.runtime.dispatch('tab.screenshot', {
      tabId: tab.id,
    })) as ScreenshotEnvelope;

    expect(fixture.page.screenshot).toHaveBeenCalledWith({
      type: 'png',
      scale: 'css',
    });
    expect(Buffer.from(screenshot.base64, 'base64')).toEqual(png(2, 3));
    expect(screenshot).toMatchObject({
      width: 2,
      height: 3,
      viewport: { width: 800, height: 600 },
      devicePixelRatio: 2,
      coordinateSpace: 'css-pixels',
    });
  });

  it('keeps screenshot clips in viewport coordinates after scrolling', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    fixture.page.evaluate.mockResolvedValueOnce({
      width: 800,
      height: 600,
      contentWidth: 1_600,
      contentHeight: 2_400,
      devicePixelRatio: 2,
      scrollX: 120,
      scrollY: 700,
    });
    fixture.page.screenshot.mockResolvedValueOnce(png(200, 100));

    await fixture.runtime.dispatch('tab.screenshot', {
      tabId: tab.id,
      clip: { x: 10, y: 20, width: 200, height: 100 },
    });

    expect(fixture.page.screenshot).toHaveBeenCalledWith({
      type: 'png',
      scale: 'css',
      clip: { x: 10, y: 20, width: 200, height: 100 },
    });
  });

  it('captures a large viewport without changing its coordinate scale', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    fixture.page.evaluate.mockResolvedValueOnce({
      width: 2_560,
      height: 1_440,
      contentWidth: 2_560,
      contentHeight: 1_440,
      devicePixelRatio: 2,
    });
    fixture.page.screenshot.mockResolvedValueOnce(png(2_560, 1_440));

    await expect(
      fixture.runtime.dispatch('tab.screenshot', { tabId: tab.id }),
    ).resolves.toBeDefined();
    expect(fixture.page.screenshot).toHaveBeenCalledWith({
      type: 'png',
      scale: 'css',
    });
  });

  it('keeps actionable Playwright errors in the model-facing message', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    fixture.page.goto.mockRejectedValueOnce(
      new Error('element is not visible because a dialog covers it'),
    );

    await expect(
      fixture.runtime.dispatch('tab.goto', {
        tabId: tab.id,
        url: 'https://example.com/',
      }),
    ).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      message: expect.stringContaining(
        'element is not visible because a dialog covers it',
      ),
    });
  });

  it('fails page operations immediately while a JavaScript dialog is open', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    const dialog = {
      type: () => 'confirm',
      message: () => 'Continue?',
      defaultValue: () => '',
      accept: vi.fn(async () => undefined),
      dismiss: vi.fn(async () => undefined),
    } as unknown as Dialog;
    const listener = fixture.page.on.mock.calls.find(
      ([event]) => event === 'dialog',
    )?.[1] as ((value: Dialog) => void) | undefined;
    expect(listener).toBeDefined();
    listener?.(dialog);

    const titleCalls = fixture.page.title.mock.calls.length;
    await expect(
      fixture.runtime.dispatch('tabs.list', { browserId: 'chrome' }),
    ).resolves.toEqual([expect.objectContaining({ id: tab.id, title: null })]);
    expect(fixture.page.title).toHaveBeenCalledTimes(titleCalls);

    await expect(
      fixture.runtime.dispatch('tab.goto', {
        tabId: tab.id,
        url: 'https://example.com/',
      }),
    ).rejects.toMatchObject({ code: 'DIALOG_OPEN' });
    expect(fixture.page.goto).not.toHaveBeenCalled();
    await expect(
      fixture.runtime.dispatch('tab.getJsDialog', { tabId: tab.id }),
    ).resolves.toMatchObject({ type: 'confirm', message: 'Continue?' });

    await fixture.runtime.dispatch('tab.dialog.dismiss', { tabId: tab.id });
    expect(dialog.dismiss).toHaveBeenCalledOnce();
    await fixture.runtime.dispatch('tab.goto', {
      tabId: tab.id,
      url: 'https://example.com/',
    });
    expect(fixture.page.goto).toHaveBeenCalledOnce();
  });

  it('does not impose an origin allowlist on Playwright navigation', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);

    await fixture.runtime.dispatch('tab.goto', {
      tabId: tab.id,
      url: 'https://outside.example/path',
    });

    expect(fixture.page.goto).toHaveBeenCalledWith(
      'https://outside.example/path',
    );
  });

  it('invalidates public tab handles when the transport disconnects', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);

    fixture.disconnect();

    await expect(
      fixture.runtime.dispatch('tab.url', { tabId: tab.id }),
    ).rejects.toMatchObject({ code: 'STALE_BROWSER_SESSION' });
    expect(playwrightMocks.connectOverCDP).toHaveBeenCalledTimes(1);
  });

  it('releases stale tab state before reconnecting Playwright', async () => {
    const fixture = await runtimeFixture();
    const oldTab = await createTab(fixture.runtime);

    fixture.disconnect();
    const newTab = await createTab(fixture.runtime);

    expect(newTab.id).not.toBe(oldTab.id);
    expect(playwrightMocks.connectOverCDP).toHaveBeenCalledTimes(2);
    await expect(
      fixture.runtime.dispatch('tabs.list', { browserId: 'chrome' }),
    ).resolves.toEqual([expect.objectContaining({ id: newTab.id })]);
    await expect(
      fixture.runtime.dispatch('tab.url', { tabId: oldTab.id }),
    ).rejects.toMatchObject({ code: 'STALE_BROWSER_SESSION' });
  });

  it('releases tab and transport state when a page closes', async () => {
    const fixture = await runtimeFixture();
    const oldTab = await createTab(fixture.runtime);
    const listener = fixture.page.on.mock.calls.find(
      ([event]) => event === 'close',
    )?.[1] as (() => void) | undefined;
    expect(listener).toBeDefined();

    listener?.();

    await expect(
      fixture.runtime.dispatch('tabs.list', { browserId: 'chrome' }),
    ).resolves.toEqual([]);
    await expect(
      fixture.runtime.dispatch('tab.url', { tabId: oldTab.id }),
    ).rejects.toMatchObject({ code: 'STALE_TAB' });

    const newTab = await createTab(fixture.runtime);
    expect(newTab.id).not.toBe(oldTab.id);
    expect(
      fixture.request.mock.calls.filter(([method]) => method === 'tabs.attach'),
    ).toHaveLength(2);
  });
});

interface RuntimeFixture {
  runtime: PlaywrightRuntime;
  page: ReturnType<typeof fakePage>['methods'];
  locator: ReturnType<typeof fakeLocator>['methods'];
  cdp: {
    send: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
  };
  request: ReturnType<typeof vi.fn>;
  disconnect(): void;
}

async function createTab(runtime: PlaywrightRuntime): Promise<TabInfo> {
  return (await runtime.dispatch('tabs.new', {
    browserId: 'chrome',
  })) as TabInfo;
}

async function runtimeFixture(
  options: { unrelatedPage?: boolean } = {},
): Promise<RuntimeFixture> {
  const locator = fakeLocator();
  const page = fakePage(locator.value);
  const unrelatedPage = options.unrelatedPage
    ? fakePage(locator.value, 'Unrelated popup')
    : undefined;
  const pageTargetIds = new Map<Page, string>([[page.value, 'target-17']]);
  if (unrelatedPage !== undefined)
    pageTargetIds.set(unrelatedPage.value, 'target-popup');
  const cdp = {
    send: vi.fn(
      async (_method: string, _params?: Record<string, unknown>) => ({}),
    ),
    detach: vi.fn(async () => undefined),
  };
  const context = {
    waitForEvent: vi.fn(async (event: string, eventOptions?: unknown) => {
      if (event !== 'page')
        throw new Error(`unexpected context event: ${event}`);
      const predicate = (
        eventOptions as { predicate?: (candidate: Page) => Promise<boolean> }
      )?.predicate;
      for (const candidate of [unrelatedPage?.value, page.value]) {
        if (
          candidate !== undefined &&
          (!predicate || (await predicate(candidate)))
        )
          return candidate;
      }
      throw new Error('No page matched the registration target');
    }),
    pages: vi.fn(() => [page.value]),
    newCDPSession: vi.fn(async (candidate: Page) => {
      let forwarded = false;
      return {
        send: async (method: string, params?: Record<string, unknown>) => {
          if (method === 'Target.getTargetInfo') {
            return {
              targetInfo: { targetId: pageTargetIds.get(candidate) },
            };
          }
          forwarded = true;
          return await cdp.send(method, params);
        },
        detach: async () => {
          if (forwarded) await cdp.detach();
        },
      };
    }),
  } as unknown as BrowserContext;
  page.methods.context.mockReturnValue(context);
  unrelatedPage?.methods.context.mockReturnValue(context);
  const browser = {
    contexts: vi.fn(() => [context]),
    isConnected: vi.fn(() => true),
  } as unknown as Browser;
  playwrightMocks.connectOverCDP.mockResolvedValue(browser);

  const connectionListeners: Array<(connected: boolean) => void> = [];
  const request = vi.fn(
    async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'tabs.create') {
        return {
          providerTabId: 17,
          title: 'Fixture',
          url: 'about:blank',
        };
      }
      if (method === 'tabs.queryDerived') return [];
      if (method === 'cdp.send' && params.method === 'Target.getTargetInfo') {
        return {
          targetInfo: {
            targetId: 'target-17',
            type: 'page',
            title: 'Fixture',
            url: 'about:blank',
          },
        };
      }
      return null;
    },
  );
  const bridge: ChromeBridge = {
    start: vi.fn(async () => undefined),
    isConnected: () => true,
    request,
    onEvent: () => () => undefined,
    onConnectionChange(listener) {
      connectionListeners.push(listener);
      return () => undefined;
    },
    stop: vi.fn(async () => undefined),
  };
  const runtime = new PlaywrightRuntime({
    bridge,
  });
  runtimes.push(runtime);
  return {
    runtime,
    page: page.methods,
    locator: locator.methods,
    cdp,
    request,
    disconnect() {
      for (const listener of connectionListeners) listener(false);
    },
  };
}

function fakeLocator(): {
  value: Locator;
  methods: {
    first: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    click: ReturnType<typeof vi.fn>;
    hover: ReturnType<typeof vi.fn>;
    press: ReturnType<typeof vi.fn>;
    pressSequentially: ReturnType<typeof vi.fn>;
    evaluate: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
    fill: ReturnType<typeof vi.fn>;
    dispatchEvent: ReturnType<typeof vi.fn>;
    selectOption: ReturnType<typeof vi.fn>;
    setChecked: ReturnType<typeof vi.fn>;
    waitFor: ReturnType<typeof vi.fn>;
  };
} {
  const methods = {
    first: vi.fn(),
    last: vi.fn(),
    nth: vi.fn(),
    filter: vi.fn(),
    and: vi.fn(),
    or: vi.fn(),
    locator: vi.fn(),
    contentFrame: vi.fn(),
    count: vi.fn(async () => 3),
    click: vi.fn(async () => undefined),
    dblclick: vi.fn(async () => undefined),
    hover: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    pressSequentially: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => undefined),
    getAttribute: vi.fn(async () => 'Field'),
    fill: vi.fn(async () => undefined),
    dispatchEvent: vi.fn(async () => undefined),
    selectOption: vi.fn(async () => ['choice']),
    setChecked: vi.fn(async () => undefined),
    waitFor: vi.fn(async () => undefined),
  };
  const value = methods as unknown as Locator;
  methods.first.mockReturnValue(value);
  methods.last.mockReturnValue(value);
  methods.nth.mockReturnValue(value);
  methods.filter.mockReturnValue(value);
  methods.and.mockReturnValue(value);
  methods.or.mockReturnValue(value);
  methods.locator.mockReturnValue(value);
  return { value, methods };
}

function fakePage(
  locator: Locator,
  title = 'Fixture',
): {
  value: Page;
  methods: {
    on: ReturnType<typeof vi.fn>;
    bringToFront: ReturnType<typeof vi.fn>;
    evaluate: ReturnType<typeof vi.fn>;
    title: ReturnType<typeof vi.fn>;
    goto: ReturnType<typeof vi.fn>;
    goBack: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    context: ReturnType<typeof vi.fn>;
    locator: ReturnType<typeof vi.fn>;
    getByRole: ReturnType<typeof vi.fn>;
    mouse: {
      click: ReturnType<typeof vi.fn>;
      wheel: ReturnType<typeof vi.fn>;
    };
    keyboard: {
      down: ReturnType<typeof vi.fn>;
      up: ReturnType<typeof vi.fn>;
      press: ReturnType<typeof vi.fn>;
      insertText: ReturnType<typeof vi.fn>;
    };
    waitForNavigation: ReturnType<typeof vi.fn>;
    waitForEvent: ReturnType<typeof vi.fn>;
    screenshot: ReturnType<typeof vi.fn>;
    ariaSnapshot: ReturnType<typeof vi.fn>;
  };
} {
  let url = 'about:blank';
  const frame = {};
  const methods = {
    on: vi.fn(),
    mainFrame: vi.fn(() => frame as unknown as Frame),
    url: vi.fn(() => url),
    title: vi.fn(async () => title),
    isClosed: vi.fn(() => false),
    bringToFront: vi.fn(async () => undefined),
    goto: vi.fn(async (nextUrl: string) => {
      url = nextUrl;
      return null;
    }),
    goBack: vi.fn(async () => null),
    goForward: vi.fn(async () => null),
    reload: vi.fn(async () => null),
    context: vi.fn(),
    close: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => ({
      width: 800,
      height: 600,
      contentWidth: 800,
      contentHeight: 600,
      devicePixelRatio: 2,
    })),
    screenshot: vi.fn(async () => png(2, 3)),
    ariaSnapshot: vi.fn(async () => '- button "Save" [ref=e1]'),
    waitForURL: vi.fn(async () => undefined),
    waitForNavigation: vi.fn(async () => null),
    waitForEvent: vi.fn(async () => ({})),
    waitForLoadState: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined),
    locator: vi.fn(() => locator),
    getByRole: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    getByLabel: vi.fn(() => locator),
    getByPlaceholder: vi.fn(() => locator),
    getByTestId: vi.fn(() => locator),
    mouse: {
      click: vi.fn(async () => undefined),
      dblclick: vi.fn(async () => undefined),
      move: vi.fn(async () => undefined),
      down: vi.fn(async () => undefined),
      up: vi.fn(async () => undefined),
      wheel: vi.fn(async () => undefined),
    },
    keyboard: {
      down: vi.fn(async () => undefined),
      up: vi.fn(async () => undefined),
      press: vi.fn(async () => undefined),
      insertText: vi.fn(async () => undefined),
    },
  };
  return {
    value: methods as unknown as Page,
    methods,
  };
}

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}
