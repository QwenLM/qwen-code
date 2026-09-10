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

import type { BridgeEvent, ChromeBridge } from '../bridge/index.js';
import { BrowserRuntimeError } from '../core/errors.js';
import type { ScreenshotEnvelope, TabInfo } from '../core/primitives.js';
import { BrowserSdkContext } from '../sdk/context.js';
import { TabProxy } from '../sdk/tab.js';
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

  it('enables tab-scoped focus emulation once without activating the window', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    await fixture.runtime.dispatch('tabs.get', {
      browserId: 'chrome',
      tabId: tab.id,
    });
    await createTab(fixture.runtime);

    const focusCalls = fixture.request.mock.calls.filter(
      ([method, params]) =>
        method === 'cdp.send' &&
        params?.method === 'Emulation.setFocusEmulationEnabled',
    );
    expect(focusCalls).toEqual([
      [
        'cdp.send',
        {
          tabId: 17,
          method: 'Emulation.setFocusEmulationEnabled',
          params: { enabled: true },
        },
      ],
    ]);
    expect(fixture.page.bringToFront).not.toHaveBeenCalled();
  });

  it('detaches the tab if background focus setup fails', async () => {
    const fixture = await runtimeFixture();
    const request = fixture.request.getMockImplementation()!;
    fixture.request.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        if (params.method === 'Emulation.setFocusEmulationEnabled')
          throw new Error('focus setup failed');
        return await request(method, params);
      },
    );

    await expect(createTab(fixture.runtime)).rejects.toThrow(
      'focus setup failed',
    );
    expect(fixture.request).toHaveBeenCalledWith(
      'tabs.detach',
      { tabId: 17 },
      2_000,
    );
    await expect(
      fixture.runtime.dispatch('tabs.list', { browserId: 'chrome' }),
    ).resolves.toEqual([]);
  });

  it('builds locator plans and delegates read and input operations', async () => {
    const fixture = await runtimeFixture();
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
      noWaitAfter: true,
    });
    expect(fixture.locator.pressSequentially).toHaveBeenCalledWith('hello', {
      timeout: 789,
    });
    expect(fixture.locator.press).not.toHaveBeenCalled();
    expect(fixture.page.bringToFront).not.toHaveBeenCalled();
    expect(fixture.page.evaluate).toHaveBeenCalledTimes(2);
  });

  it('reports when Chrome browser UI swallows locator typing', async () => {
    const fixture = await runtimeFixture();
    fixture.typingState.evaluate.mockResolvedValue(true);
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
      noWaitAfter: true,
    });
    expect(fixture.locator.getAttribute).toHaveBeenCalledWith('aria-label', {
      timeout: 1_000,
    });
    expect(fixture.locator.waitFor).toHaveBeenCalledWith({
      state: 'visible',
      timeout: 30_000,
    });
  });

  it('keeps locator keypress deadlines separate from navigation', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    const steps = [{ kind: 'locator' as const, selector: '#field' }];

    for (const timeoutMs of [undefined, 1234]) {
      await fixture.runtime.dispatch('locator.press', {
        tabId: tab.id,
        steps,
        value: 'Enter',
        timeoutMs,
      });
      expect(fixture.locator.press).toHaveBeenLastCalledWith('Enter', {
        timeout: timeoutMs ?? 5_000,
        noWaitAfter: true,
      });
    }
  });

  it('drains renderer input tasks without bringing the page forward', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);

    await fixture.runtime.dispatch('locator.click', {
      tabId: tab.id,
      steps: [{ kind: 'locator', selector: '#button' }],
    });

    expect(fixture.page.bringToFront).not.toHaveBeenCalled();
    expect(fixture.locator.click).toHaveBeenCalledOnce();
    expect(fixture.page.evaluate).toHaveBeenCalledOnce();
    expect(fixture.locator.click.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.page.evaluate.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    new Error(
      'page.evaluate: Execution context was destroyed, most likely because of a navigation',
    ),
    {
      message:
        'page.evaluate: Execution context was destroyed, most likely because of a navigation.',
    },
  ])(
    'preserves successful input when the drain loses its context (%j)',
    async (error) => {
      const fixture = await runtimeFixture();
      const tab = await createTab(fixture.runtime);
      fixture.page.evaluate.mockRejectedValueOnce(error);

      await expect(
        fixture.runtime.dispatch('locator.selectOption', {
          tabId: tab.id,
          steps: [{ kind: 'locator', selector: '#sort' }],
          value: 'price',
        }),
      ).resolves.toBeNull();

      expect(fixture.locator.selectOption).toHaveBeenCalledExactlyOnceWith(
        'price',
        { timeout: 5_000 },
      );
      expect(fixture.page.evaluate).toHaveBeenCalledOnce();
      expect(
        fixture.locator.selectOption.mock.invocationCallOrder[0],
      ).toBeLessThan(fixture.page.evaluate.mock.invocationCallOrder[0] ?? 0);
    },
  );

  it('bounds the auxiliary input drain while a new page context is pending', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    let rejectDrain!: (error: Error) => void;
    const drain = new Promise<never>((_resolve, reject) => {
      rejectDrain = reject;
    });
    fixture.page.evaluate.mockReturnValueOnce(drain);
    vi.useFakeTimers();
    try {
      const settled = vi.fn();
      const operation = fixture.runtime
        .dispatch('locator.press', {
          tabId: tab.id,
          steps: [{ kind: 'locator', selector: '#submit' }],
          value: 'Enter',
        })
        .then(settled);
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.page.evaluate).toHaveBeenCalledOnce();
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);
      await operation;
      expect(settled).toHaveBeenCalledExactlyOnceWith(null);
      expect(fixture.locator.press).toHaveBeenCalledOnce();
      rejectDrain(new Error('late navigation context failure'));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    'selection failed',
    'Execution context was destroyed, most likely because of a navigation',
  ])(
    'preserves input errors without running the drain (%s)',
    async (message) => {
      const fixture = await runtimeFixture();
      const tab = await createTab(fixture.runtime);
      fixture.locator.selectOption.mockRejectedValueOnce(new Error(message));

      await expect(
        fixture.runtime.dispatch('locator.selectOption', {
          tabId: tab.id,
          steps: [{ kind: 'locator', selector: '#sort' }],
          value: 'price',
        }),
      ).rejects.toMatchObject({
        message: `locator.selectOption failed: ${message}`,
      });

      expect(fixture.locator.selectOption).toHaveBeenCalledOnce();
      expect(fixture.page.evaluate).not.toHaveBeenCalled();
    },
  );

  it('preserves unrelated errors from the input drain', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    fixture.page.evaluate.mockRejectedValueOnce(new Error('renderer failed'));

    await expect(
      fixture.runtime.dispatch('locator.selectOption', {
        tabId: tab.id,
        steps: [{ kind: 'locator', selector: '#sort' }],
        value: 'price',
      }),
    ).rejects.toMatchObject({
      message: 'locator.selectOption failed: renderer failed',
    });

    expect(fixture.locator.selectOption).toHaveBeenCalledOnce();
    expect(fixture.page.evaluate).toHaveBeenCalledOnce();
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
    expect(fixture.page.bringToFront).not.toHaveBeenCalled();
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
      noWaitAfter: true,
    });
    expect(fixture.page.keyboard.insertText).toHaveBeenCalledWith('hello');
    expect(fixture.page.keyboard.press).toHaveBeenCalledWith('Control+a');
    expect(fixture.locator.hover).toHaveBeenCalledWith();
    expect(fixture.page.mouse.wheel).toHaveBeenCalledWith(0, 200);
    expect(fixture.locator.pressSequentially).not.toHaveBeenCalled();
    expect(fixture.locator.press).not.toHaveBeenCalled();
    expect(fixture.page.bringToFront).not.toHaveBeenCalled();
  });

  it('rejects unsupported DOM CUA options through the public SDK before input', async () => {
    const fixture = await runtimeFixture();
    const info = await createTab(fixture.runtime);
    const tab = new TabProxy(
      new BrowserSdkContext(fixture.runtime),
      'chrome',
      info,
    );

    const targetedText = { node_id: 'e1', text: 'hello' };
    await expect(tab.dom_cua.type(targetedText)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('dom_cua.click({ node_id })'),
    });
    for (const operation of [
      () => tab.dom_cua.click({ node_id: 'e1', force: true } as never),
      () => tab.dom_cua.double_click({ node_id: 'e1', force: true } as never),
      () => tab.dom_cua.keypress({ node_id: 'e1', keys: ['Enter'] } as never),
      () => tab.dom_cua.scroll({ x: 0, y: 100, unsupported: true } as never),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    }
    expect(fixture.page.keyboard.insertText).not.toHaveBeenCalled();
    expect(fixture.page.keyboard.press).not.toHaveBeenCalled();
    expect(fixture.locator.click).not.toHaveBeenCalled();
    expect(fixture.locator.dblclick).not.toHaveBeenCalled();
    expect(fixture.page.mouse.wheel).not.toHaveBeenCalled();
  });

  it('explains invalid keypress shapes in the error message without sending keys', async () => {
    const fixture = await runtimeFixture();
    const info = await createTab(fixture.runtime);
    const tab = new TabProxy(
      new BrowserSdkContext(fixture.runtime),
      'chrome',
      info,
    );

    for (const api of [tab.cua, tab.dom_cua]) {
      for (const options of ['Enter', { keys: 'Enter' }]) {
        await expect(api.keypress(options as never)).rejects.toMatchObject({
          code: 'INVALID_ARGUMENT',
          message: expect.stringContaining('keypress({ keys: ["Enter"] })'),
        });
      }
    }
    expect(fixture.page.keyboard.press).not.toHaveBeenCalled();
  });

  it('preserves focused input and snapshot ref normalization through the SDK', async () => {
    const fixture = await runtimeFixture();
    fixture.locator.count.mockResolvedValue(1);
    const info = await createTab(fixture.runtime);
    const tab = new TabProxy(
      new BrowserSdkContext(fixture.runtime),
      'chrome',
      info,
    );

    await tab.dom_cua.click({ node_id: ' f1e2 ' });
    await tab.dom_cua.type({ text: 'hello' });
    await tab.dom_cua.keypress({ keys: ['Control', 'a'] });
    await tab.cua.keypress({ keys: ['Enter'] });
    await tab.dom_cua.scroll({ node_id: ' f1e2 ', x: 0, y: 200 });

    expect(fixture.page.locator).toHaveBeenCalledWith('aria-ref=f1e2');
    expect(fixture.locator.click).toHaveBeenCalledOnce();
    expect(fixture.page.keyboard.insertText).toHaveBeenCalledExactlyOnceWith(
      'hello',
    );
    expect(fixture.page.keyboard.press.mock.calls).toEqual([
      ['Control+a'],
      ['Enter'],
    ]);
    expect(fixture.page.mouse.wheel).toHaveBeenCalledWith(0, 200);
    expect(fixture.page.bringToFront).not.toHaveBeenCalled();
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

  it('releases the mouse button when a drag move fails', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    fixture.page.mouse.move
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('move failed'));

    await expect(
      fixture.runtime.dispatch('cua.drag', {
        tabId: tab.id,
        path: [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
          { x: 3, y: 3 },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      message: 'cua.drag failed: move failed',
    });
    expect(fixture.page.mouse.down).toHaveBeenCalledOnce();
    expect(fixture.page.mouse.up).toHaveBeenCalledOnce();
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
    expect(fixture.locator.dispatchEvent).not.toHaveBeenCalled();
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

  it('waits for navigation independently after a successful SDK click', async () => {
    const fixture = await runtimeFixture();
    const tab = new TabProxy(
      new BrowserSdkContext(fixture.runtime),
      'chrome',
      await createTab(fixture.runtime),
    );
    let finishNavigation!: (value: null) => void;
    const navigation = new Promise<null>((resolve) => {
      finishNavigation = resolve;
    });
    fixture.page.waitForNavigation.mockReturnValueOnce(navigation);
    const dispatch = vi.spyOn(fixture.runtime, 'dispatch');
    const finished = vi.fn();
    const operation = tab.playwright
      .expectNavigation(
        async () => {
          await tab.playwright.getByRole('button', { name: 'Submit' }).click();
          return 'submitted';
        },
        { timeoutMs: 20_000 },
      )
      .then(finished);

    await vi.waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        'playwright.expectNavigation.wait',
        expect.any(Object),
      ),
    );
    expect(fixture.locator.click).toHaveBeenCalledExactlyOnceWith({
      button: 'left',
      modifiers: [],
      timeout: 5_000,
      noWaitAfter: true,
    });
    expect(fixture.page.waitForNavigation).toHaveBeenCalledWith({
      timeout: 20_000,
      waitUntil: 'load',
    });
    expect(
      fixture.page.waitForNavigation.mock.invocationCallOrder[0],
    ).toBeLessThan(fixture.locator.click.mock.invocationCallOrder[0] ?? 0);
    expect(finished).not.toHaveBeenCalled();

    finishNavigation(null);
    await operation;
    expect(finished).toHaveBeenCalledWith('submitted');
  });

  it('preserves a navigation failure without repeating successful input', async () => {
    const fixture = await runtimeFixture();
    const tab = new TabProxy(
      new BrowserSdkContext(fixture.runtime),
      'chrome',
      await createTab(fixture.runtime),
    );
    fixture.page.waitForNavigation.mockRejectedValueOnce(
      new Error('navigation timed out'),
    );

    await expect(
      tab.playwright.expectNavigation(() =>
        tab.playwright.getByRole('button', { name: 'Submit' }).click(),
      ),
    ).rejects.toMatchObject({
      message: 'playwright.expectNavigation.wait failed: navigation timed out',
    });
    expect(fixture.locator.click).toHaveBeenCalledOnce();
  });

  it.each(['click', 'press'] as const)(
    'preserves a real locator %s failure without retrying it',
    async (method) => {
      const fixture = await runtimeFixture();
      const tab = await createTab(fixture.runtime);
      fixture.locator[method].mockRejectedValueOnce(
        new Error('input timed out'),
      );

      await expect(
        fixture.runtime.dispatch(`locator.${method}`, {
          tabId: tab.id,
          steps: [{ kind: 'locator', selector: '#field' }],
          ...(method === 'press' ? { value: 'Enter' } : {}),
        }),
      ).rejects.toMatchObject({
        message: `locator.${method} failed: input timed out`,
      });
      expect(fixture.locator[method]).toHaveBeenCalledOnce();
      expect(fixture.page.evaluate).not.toHaveBeenCalled();
    },
  );

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
      clip: { x: 0, y: 0, width: 2, height: 3 },
    })) as ScreenshotEnvelope;

    expect(fixture.page.screenshot).not.toHaveBeenCalled();
    expect(fixture.request).toHaveBeenCalledWith(
      'cdp.send',
      {
        tabId: 17,
        method: 'Page.captureScreenshot',
        params: {
          format: 'jpeg',
          quality: 80,
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: 2, height: 3, scale: 0.5 },
        },
      },
      5_000,
    );
    expect(Buffer.from(screenshot.base64, 'base64')).toEqual(jpeg(2, 3));
    expect(screenshot).toMatchObject({
      mimeType: 'image/jpeg',
      width: 2,
      height: 3,
      viewport: { width: 800, height: 600 },
      devicePixelRatio: 2,
      coordinateSpace: 'css-pixels',
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

  it('cancels navigation waiters when a dialog blocks the SDK wait leg', async () => {
    const fixture = await runtimeFixture();
    const tab = new TabProxy(
      new BrowserSdkContext(fixture.runtime),
      'chrome',
      await createTab(fixture.runtime),
    );
    const dispatch = vi.spyOn(fixture.runtime, 'dispatch');
    await expect(
      tab.playwright.expectNavigation(() => {
        openDialog(fixture, 'confirm', 'Leave?');
      }),
    ).rejects.toMatchObject({ code: 'DIALOG_OPEN' });
    const cancel = dispatch.mock.calls.find(
      ([method]) => method === 'playwright.expectNavigation.cancel',
    );
    const beginIndex = dispatch.mock.calls.findIndex(
      ([method]) => method === 'playwright.expectNavigation.begin',
    );
    const waiterId = await dispatch.mock.results[beginIndex]!.value;
    expect(cancel).toEqual([
      'playwright.expectNavigation.cancel',
      { tabId: tab.id, waiterId },
    ]);
    fixture.emitEvent({
      type: 'event',
      tabId: 17,
      method: 'Page.javascriptDialogClosed',
      params: {},
    });
    await expect(
      fixture.runtime.dispatch('playwright.expectNavigation.wait', {
        tabId: tab.id,
        waiterId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each(['accept', 'dismiss'] as const)(
    'rejects stale dialog %s handles without touching the new dialog',
    async (method) => {
      const fixture = await runtimeFixture();
      const tab = new TabProxy(
        new BrowserSdkContext(fixture.runtime),
        'chrome',
        await createTab(fixture.runtime),
      );
      const first = openDialog(fixture, 'confirm', 'Leave?');
      const old = await tab.getJsDialog();
      if (old?.type !== 'confirm') throw new Error('Expected confirm');
      const second = openDialog(fixture, 'confirm', 'Delete records?');
      await expect(old[method]()).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(first[method]).not.toHaveBeenCalled();
      expect(second[method]).not.toHaveBeenCalled();
      const fresh = await tab.getJsDialog();
      if (fresh?.type !== 'confirm') throw new Error('Expected confirm');
      await fresh[method]();
      expect(second[method]).toHaveBeenCalledOnce();
      openDialog(fixture, 'confirm', 'Another?');
      await expect(fresh[method]()).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    },
  );

  it('accepts beforeunload dialogs through the SDK', async () => {
    const fixture = await runtimeFixture();
    const tab = new TabProxy(
      new BrowserSdkContext(fixture.runtime),
      'chrome',
      await createTab(fixture.runtime),
    );
    const current = openDialog(fixture, 'beforeunload', 'Leave?');
    const dialog = await tab.getJsDialog();
    if (dialog?.type !== 'beforeunload')
      throw new Error('Expected beforeunload');
    await dialog.accept();
    expect(current.accept).toHaveBeenCalledOnce();
    expect(current.dismiss).not.toHaveBeenCalled();
  });

  it('unblocks a tab when Chrome closes a dialog externally without navigation', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    const dialog = openDialog(fixture, 'confirm', 'Leave?');
    fixture.emitEvent({
      type: 'event',
      tabId: 17,
      method: 'Page.javascriptDialogClosed',
      params: {},
    });
    await expect(
      fixture.runtime.dispatch('tab.title', { tabId: tab.id }),
    ).resolves.toBe('Fixture');
    await expect(
      fixture.runtime.dispatch('tab.getJsDialog', { tabId: tab.id }),
    ).resolves.toBeNull();
    expect(dialog.accept).not.toHaveBeenCalled();
    expect(dialog.dismiss).not.toHaveBeenCalled();
  });

  it('preserves dialog order when Chrome batches close and open events', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    queueMicrotask(() => openDialog(fixture, 'alert', 'First'));
    fixture.emitEvent({
      type: 'event',
      tabId: 17,
      method: 'Page.javascriptDialogClosed',
      params: {},
    });
    queueMicrotask(() => openDialog(fixture, 'confirm', 'Second'));
    await expect(
      fixture.runtime.dispatch('tab.getJsDialog', { tabId: tab.id }),
    ).resolves.toMatchObject({ message: 'Second' });
    fixture.emitEvent({
      type: 'event',
      tabId: 18,
      method: 'Page.javascriptDialogClosed',
      params: {},
    });
    await expect(
      fixture.runtime.dispatch('tab.getJsDialog', { tabId: tab.id }),
    ).resolves.toMatchObject({ message: 'Second' });
    fixture.emitEvent({
      type: 'event',
      tabId: 17,
      method: 'Page.javascriptDialogClosed',
      params: {},
    });
    await expect(
      fixture.runtime.dispatch('tab.getJsDialog', { tabId: tab.id }),
    ).resolves.toBeNull();
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

    await fixture.runtime.dispatch(
      'tab.dialog.dismiss',
      await dialogArgs(fixture.runtime, tab.id),
    );
    expect(dialog.dismiss).toHaveBeenCalledOnce();
    await fixture.runtime.dispatch('tab.goto', {
      tabId: tab.id,
      url: 'https://example.com/',
    });
    expect(fixture.page.goto).toHaveBeenCalledOnce();
  });

  it('clears the cached dialog when Chrome reports it already gone', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    const dialog = {
      type: () => 'confirm',
      message: () => 'Continue?',
      defaultValue: () => '',
      accept: vi.fn(async () => {
        throw new Error('No JavaScript dialog is open');
      }),
      dismiss: vi.fn(async () => {
        throw new Error('No JavaScript dialog is open');
      }),
    } as unknown as Dialog;
    const listener = fixture.page.on.mock.calls.find(
      ([event]) => event === 'dialog',
    )?.[1] as ((value: Dialog) => void) | undefined;
    expect(listener).toBeDefined();
    listener?.(dialog);

    await expect(
      fixture.runtime.dispatch(
        'tab.dialog.dismiss',
        await dialogArgs(fixture.runtime, tab.id),
      ),
    ).rejects.toMatchObject({ code: 'OPERATION_FAILED' });
    await fixture.runtime.dispatch('tab.goto', {
      tabId: tab.id,
      url: 'https://example.com/',
    });
    expect(fixture.page.goto).toHaveBeenCalledOnce();
  });

  it('keeps a dialog that opened while an earlier accept was in flight', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    const listener = fixture.page.on.mock.calls.find(
      ([event]) => event === 'dialog',
    )?.[1] as ((value: Dialog) => void) | undefined;
    expect(listener).toBeDefined();
    const second = {
      type: () => 'confirm',
      message: () => 'Really?',
      defaultValue: () => '',
      accept: vi.fn(async () => undefined),
      dismiss: vi.fn(async () => undefined),
    } as unknown as Dialog;
    const first = {
      type: () => 'alert',
      message: () => 'First',
      defaultValue: () => '',
      accept: vi.fn(async () => {
        listener?.(second);
      }),
      dismiss: vi.fn(async () => undefined),
    } as unknown as Dialog;
    listener?.(first);

    await fixture.runtime.dispatch(
      'tab.dialog.accept',
      await dialogArgs(fixture.runtime, tab.id),
    );

    await expect(
      fixture.runtime.dispatch('tab.getJsDialog', { tabId: tab.id }),
    ).resolves.toMatchObject({ type: 'confirm', message: 'Really?' });
    await expect(
      fixture.runtime.dispatch('tab.goto', {
        tabId: tab.id,
        url: 'https://example.com/',
      }),
    ).rejects.toMatchObject({ code: 'DIALOG_OPEN' });
  });

  it('clears the cached dialog when the page navigates', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    const listeners = new Map(
      fixture.page.on.mock.calls as Array<[string, (value: never) => void]>,
    );
    const dialogListener = listeners.get('dialog') as
      | ((value: Dialog) => void)
      | undefined;
    expect(dialogListener).toBeDefined();
    dialogListener?.({
      type: () => 'confirm',
      message: () => 'Leave?',
      defaultValue: () => '',
      accept: vi.fn(async () => undefined),
      dismiss: vi.fn(async () => undefined),
    } as unknown as Dialog);
    const navigatedListener = listeners.get('framenavigated') as
      | (() => void)
      | undefined;
    expect(navigatedListener).toBeDefined();

    navigatedListener?.();

    await fixture.runtime.dispatch('tab.goto', {
      tabId: tab.id,
      url: 'https://example.com/',
    });
    expect(fixture.page.goto).toHaveBeenCalledOnce();
  });

  it('records console.warn entries at the warn level', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    const listener = fixture.page.on.mock.calls.find(
      ([event]) => event === 'console',
    )?.[1] as ((value: unknown) => void) | undefined;
    expect(listener).toBeDefined();
    listener?.({
      type: () => 'warning',
      text: () => 'deprecated API',
      location: () => ({ url: '' }),
    });

    await expect(
      fixture.runtime.dispatch('dev.logs', {
        tabId: tab.id,
        levels: ['warning'],
      }),
    ).resolves.toEqual([
      expect.objectContaining({ level: 'warn', message: 'deprecated API' }),
    ]);
    await expect(
      fixture.runtime.dispatch('dev.logs', { tabId: tab.id, levels: ['log'] }),
    ).resolves.toEqual([]);
  });

  it('lists tabs when a derived popup fails to attach', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    fixture.request.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'tabs.queryDerived')
          return [
            {
              providerTabId: 18,
              title: 'Popup',
              url: 'https://example.com/popup',
              derivedFromProviderTabId: 17,
            },
          ];
        if (method === 'tabs.attach' && params.tabId === 18)
          throw new Error('Cannot attach to target');
        return null;
      },
    );

    await expect(
      fixture.runtime.dispatch('tabs.list', { browserId: 'chrome' }),
    ).resolves.toEqual([expect.objectContaining({ id: tab.id })]);
  });

  it('propagates a lost connection while syncing derived tabs', async () => {
    const fixture = await runtimeFixture();
    await createTab(fixture.runtime);
    fixture.request.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'tabs.queryDerived')
          return [
            {
              providerTabId: 18,
              title: 'Popup',
              url: 'https://example.com/popup',
              derivedFromProviderTabId: 17,
            },
          ];
        if (method === 'tabs.attach' && params.tabId === 18)
          throw new BrowserRuntimeError(
            'BROWSER_DISCONNECTED',
            'Chrome extension disconnected',
          );
        return null;
      },
    );

    await expect(
      fixture.runtime.dispatch('tabs.list', { browserId: 'chrome' }),
    ).rejects.toMatchObject({ code: 'BROWSER_DISCONNECTED' });
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

  it('drops a late derived-tab response and removes all bridge listeners on stop', async () => {
    const fixture = await runtimeFixture();
    await createTab(fixture.runtime);
    const original = fixture.request.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    const response = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    fixture.request.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'tabs.get') return await response;
        return await original(method, params);
      },
    );
    fixture.emitEvent({
      type: 'event',
      tabId: 18,
      method: 'qwenBrowser.derivedTabTracked',
      params: { openerTabId: 17 },
    });
    await fixture.runtime.stop();
    expect(fixture.listenerCount()).toBe(0);
    finish({ providerTabId: 18, title: 'Popup', url: 'about:blank' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      fixture.request.mock.calls.filter(([method]) => method === 'tabs.attach'),
    ).toEqual([['tabs.attach', { tabId: 17 }]]);
  });

  it('joins concurrent stops until debugger release finishes', async () => {
    const fixture = await runtimeFixture();
    await createTab(fixture.runtime);
    const original = fixture.request.getMockImplementation()!;
    let finish!: () => void;
    const response = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let detaching = false;
    fixture.request.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'tabs.detach') {
          detaching = true;
          await response;
        }
        return await original(method, params);
      },
    );
    const first = fixture.runtime.stop();
    await vi.waitFor(() => expect(detaching).toBe(true));
    const finished = vi.fn();
    const second = fixture.runtime.stop().then(finished);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).not.toHaveBeenCalled();
    expect(fixture.stopBridge).not.toHaveBeenCalled();
    finish();
    await Promise.all([first, second]);
    expect(fixture.stopBridge).toHaveBeenCalledTimes(1);
    expect(
      fixture.request.mock.calls.filter(([method]) => method === 'tabs.detach'),
    ).toHaveLength(1);
  });

  it('releases the old transport before reconnecting after Playwright disconnects', async () => {
    const fixture = await runtimeFixture();
    const oldTab = await createTab(fixture.runtime);
    fixture.browserDisconnect();
    const newTab = await createTab(fixture.runtime);
    expect(newTab.id).not.toBe(oldTab.id);
    expect(playwrightMocks.connectOverCDP).toHaveBeenCalledTimes(2);
    expect(
      fixture.request.mock.calls
        .filter(
          ([method]) => method === 'tabs.attach' || method === 'tabs.detach',
        )
        .map(([method]) => method),
    ).toEqual(['tabs.attach', 'tabs.detach', 'tabs.attach']);
    await expect(
      fixture.runtime.dispatch('tab.url', { tabId: oldTab.id }),
    ).rejects.toMatchObject({ code: 'STALE_BROWSER_SESSION' });
  });

  it('drains an attachment admitted before stop without registering it', async () => {
    const fixture = await runtimeFixture();
    const original = fixture.request.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attached = false;
    fixture.request.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'tabs.attach') {
          attached = true;
          await gate;
        }
        return await original(method, params);
      },
    );
    const pending = createTab(fixture.runtime).then(
      (value) => value,
      (error) => error,
    );
    await vi.waitFor(() => expect(attached).toBe(true));
    const stopping = fixture.runtime.stop();
    release();
    const result = await pending;
    await stopping;
    expect(result).toMatchObject({ code: 'NOT_RUNNING' });
    expect(
      fixture.request.mock.calls.filter(([method]) => method === 'tabs.detach'),
    ).toHaveLength(1);
    expect(
      fixture.request.mock.calls.some(
        ([, params]) => params?.method === 'Emulation.setFocusEmulationEnabled',
      ),
    ).toBe(false);
  });

  it('releases crashed tabs before registering the same provider again', async () => {
    const fixture = await runtimeFixture();
    const oldTab = await createTab(fixture.runtime);
    const crash = fixture.page.on.mock.calls.find(
      ([event]) => event === 'crash',
    )?.[1] as () => void;
    crash();
    await expect(
      fixture.runtime.dispatch('tab.url', { tabId: oldTab.id }),
    ).rejects.toMatchObject({ code: 'STALE_TAB' });
    const newTab = await createTab(fixture.runtime);
    expect(newTab.id).not.toBe(oldTab.id);
    const oldClose = fixture.page.on.mock.calls.find(
      ([event]) => event === 'close',
    )?.[1] as () => void;
    oldClose();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(
      fixture.request.mock.calls.filter(([method]) => method === 'tabs.attach'),
    ).toHaveLength(2);
    expect(
      fixture.request.mock.calls.filter(([method]) => method === 'tabs.detach'),
    ).toHaveLength(1);
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
  typingState: {
    evaluate: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
  cdp: {
    send: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
  };
  request: ReturnType<typeof vi.fn>;
  disconnect(): void;
  browserDisconnect(): void;
  listenerCount(): number;
  stopBridge: ReturnType<typeof vi.fn>;
  emitEvent(event: BridgeEvent): void;
}

async function createTab(runtime: PlaywrightRuntime): Promise<TabInfo> {
  return (await runtime.dispatch('tabs.new', {
    browserId: 'chrome',
  })) as TabInfo;
}

async function dialogArgs(runtime: PlaywrightRuntime, tabId: string) {
  const descriptor = (await runtime.dispatch('tab.getJsDialog', { tabId })) as {
    dialogId: string;
  };
  return { tabId, dialogId: descriptor.dialogId };
}

function openDialog(
  fixture: RuntimeFixture,
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload',
  message: string,
) {
  const dialog = {
    type: () => type,
    message: () => message,
    defaultValue: () => '',
    accept: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => undefined),
  };
  const listener = fixture.page.on.mock.calls.find(
    ([event]) => event === 'dialog',
  )?.[1] as ((dialog: Dialog) => void) | undefined;
  expect(listener).toBeDefined();
  listener!(dialog as unknown as Dialog);
  return dialog;
}

async function runtimeFixture(
  options: { unrelatedPage?: boolean } = {},
): Promise<RuntimeFixture> {
  const locator = fakeLocator();
  const typingState = {
    evaluate: vi.fn(async () => false),
    dispose: vi.fn(async () => undefined),
  };
  locator.methods.evaluateHandle.mockResolvedValue(typingState);
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
  const browserOn = vi.fn();
  const browser = {
    contexts: vi.fn(() => [context]),
    isConnected: vi.fn(() => true),
    on: browserOn,
  } as unknown as Browser;
  playwrightMocks.connectOverCDP.mockResolvedValue(browser);

  const connectionListeners = new Set<(connected: boolean) => void>();
  const eventListeners = new Set<(event: BridgeEvent) => void>();
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
      if (method === 'cdp.send' && params.method === 'Page.getLayoutMetrics')
        return {
          cssVisualViewport: {
            clientWidth: 800,
            clientHeight: 600,
            pageX: 0,
            pageY: 0,
          },
          cssContentSize: { x: 0, y: 0, width: 800, height: 600 },
        };
      if (method === 'cdp.send' && params.method === 'Runtime.evaluate')
        return { result: { value: 2 } };
      if (method === 'cdp.send' && params.method === 'Page.captureScreenshot')
        return { data: jpeg(2, 3).toString('base64') };
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
    onEvent(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    onConnectionChange(listener) {
      connectionListeners.add(listener);
      return () => {
        connectionListeners.delete(listener);
      };
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
    typingState,
    cdp,
    request,
    stopBridge: bridge.stop as ReturnType<typeof vi.fn>,
    browserDisconnect() {
      browserOn.mock.calls.at(-1)?.[1]();
    },
    listenerCount() {
      return eventListeners.size + connectionListeners.size;
    },
    emitEvent(event) {
      for (const listener of eventListeners) listener(event);
    },
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
    dblclick: ReturnType<typeof vi.fn>;
    hover: ReturnType<typeof vi.fn>;
    press: ReturnType<typeof vi.fn>;
    pressSequentially: ReturnType<typeof vi.fn>;
    evaluate: ReturnType<typeof vi.fn>;
    evaluateHandle: ReturnType<typeof vi.fn>;
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
    evaluateHandle: vi.fn(),
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
      move: ReturnType<typeof vi.fn>;
      down: ReturnType<typeof vi.fn>;
      up: ReturnType<typeof vi.fn>;
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
    screenshot: vi.fn(async () => {
      throw new Error('Screenshots must not use Playwright capture');
    }),
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

function jpeg(width: number, height: number): Buffer {
  const buffer = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0, 0xff, 0xd9,
  ]);
  buffer.writeUInt16BE(width, 9);
  buffer.writeUInt16BE(height, 7);
  return buffer;
}
