/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  calls: [] as Array<{
    method: string;
    args: unknown;
  }>,
  dispatch: vi.fn(async (method: string, args: unknown): Promise<unknown> => {
    backend.calls.push({ method, args });
    if (method === 'browsers.get') {
      return {
        id: 'chrome',
        name: 'Chrome',
        type: 'extension',
        family: 'chrome',
      };
    }
    if (method === 'browser.documentation') return 'browser docs';
    if (method === 'browser.user.history') return [];
    if (method === 'tabs.new') return { id: 'tab-1' };
    if (method === 'tab.goto') return null;
    if (method === 'tab.dialog.accept' || method === 'tab.dialog.dismiss')
      return null;
    if (method === 'locator.click' || method === 'locator.downloadMedia')
      return null;
    if (method === 'playwright.domSnapshot') return '- button [ref=e2]';
    if (method.startsWith('dom_cua.') || method.startsWith('cua.')) return null;
    if (method === 'tab.screenshot') {
      return {
        base64: 'iVBORw0KGgo=',
        width: 1280,
        height: 720,
        viewport: { width: 1280, height: 720 },
        devicePixelRatio: 2,
        coordinateSpace: 'css-pixels',
      };
    }
    throw new Error(`unexpected call: ${method}`);
  }),
  stop: vi.fn(async () => undefined),
}));

vi.mock('./runtime.js', () => ({
  createBrowserBackend: vi.fn(async () => backend),
}));

import { createBrowserBackend } from './runtime.js';
import { closeBrowserRuntime, setupBrowserRuntime } from './index.js';

afterEach(async () => {
  await closeBrowserRuntime();
  backend.calls.length = 0;
  vi.clearAllMocks();
});

describe('Browser SDK in the existing Node REPL', () => {
  it('reuses one agent and backend across Node REPL cells', async () => {
    const agent = await setupBrowserRuntime();
    const browser = await agent.browsers.get('chrome');
    expect(await browser.documentation()).toBe('browser docs');
    expect(await setupBrowserRuntime()).toBe(agent);

    expect(backend.calls.map(({ method }) => method)).toEqual([
      'browsers.get',
      'browser.documentation',
    ]);
  });

  it('does not rebind SDK objects after the runtime is replaced', async () => {
    const oldAgent = await setupBrowserRuntime();
    const oldBrowser = await oldAgent.browsers.get('chrome');
    const oldTab = await oldBrowser.tabs.new();
    const oldLocator = oldTab.playwright.locator('button');

    await closeBrowserRuntime();
    const newAgent = await setupBrowserRuntime();
    const dispatchCount = backend.dispatch.mock.calls.length;

    expect(newAgent).not.toBe(oldAgent);
    for (const operation of [
      () => oldAgent.browsers.list(),
      () => oldBrowser.tabs.new(),
      () => oldTab.url(),
      () => oldLocator.count(),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: 'STALE_BROWSER_SESSION',
      });
    }
    expect(backend.dispatch).toHaveBeenCalledTimes(dispatchCount);
    await expect(newAgent.browsers.get('chrome')).resolves.toBeDefined();
  });

  it('invalidates an operation that finishes after its runtime closes', async () => {
    const agent = await setupBrowserRuntime();
    const browser = await agent.browsers.get('chrome');
    let resolveOperation: (value: unknown) => void = () => undefined;
    const pendingOperation = new Promise<unknown>((resolve) => {
      resolveOperation = resolve;
    });
    backend.dispatch.mockReturnValueOnce(pendingOperation);

    const operation = browser.documentation();
    await closeBrowserRuntime();
    resolveOperation('browser docs');

    await expect(operation).rejects.toMatchObject({
      code: 'STALE_BROWSER_SESSION',
    });
  });

  it.each(['and', 'or', 'has', 'hasNot'] as const)(
    'rejects %s composition across tabs before dispatch',
    async (method) => {
      const agent = await setupBrowserRuntime();
      const browser = await agent.browsers.get('chrome');
      const tab = await browser.tabs.new();
      backend.dispatch.mockResolvedValueOnce({ id: 'tab-2' });
      const otherTab = await browser.tabs.new();
      const locator = tab.playwright.locator('button');
      const other = otherTab.playwright.getByText('Submit');
      const dispatchCount = backend.dispatch.mock.calls.length;

      expect(() =>
        method === 'and' || method === 'or'
          ? locator[method](other)
          : locator.filter({ [method]: other }),
      ).toThrow('expects a Locator from the same tab and browser session');
      expect(backend.dispatch).toHaveBeenCalledTimes(dispatchCount);
    },
  );

  it.each(['and', 'or', 'has', 'hasNot'] as const)(
    'rejects %s composition with an old session even when tab IDs match',
    async (method) => {
      const oldAgent = await setupBrowserRuntime();
      const oldBrowser = await oldAgent.browsers.get('chrome');
      const oldTab = await oldBrowser.tabs.new();
      const oldLocator = oldTab.playwright.getByText('Submit');
      await closeBrowserRuntime();

      const agent = await setupBrowserRuntime();
      const browser = await agent.browsers.get('chrome');
      const tab = await browser.tabs.new();
      expect(tab.id).toBe(oldTab.id);
      const locator = tab.playwright.locator('button');
      const dispatchCount = backend.dispatch.mock.calls.length;

      expect(() =>
        method === 'and' || method === 'or'
          ? locator[method](oldLocator)
          : locator.filter({ [method]: oldLocator }),
      ).toThrow('expects a Locator from the same tab and browser session');
      expect(backend.dispatch).toHaveBeenCalledTimes(dispatchCount);
    },
  );

  it('preserves compound locator steps within the same tab and session', async () => {
    const agent = await setupBrowserRuntime();
    const browser = await agent.browsers.get('chrome');
    const tab = await browser.tabs.new();
    const locator = tab.playwright.locator('button');
    const other = tab.playwright.getByText('Submit');
    const otherSteps = [{ kind: 'getByText', text: 'Submit' }];

    for (const method of ['and', 'or', 'has', 'hasNot'] as const) {
      const combined =
        method === 'and' || method === 'or'
          ? locator[method](other)
          : locator.filter({ [method]: other });
      await combined.click();
      expect(backend.calls.at(-1)).toEqual({
        method: 'locator.click',
        args: {
          tabId: tab.id,
          steps: [
            { kind: 'locator', selector: 'button' },
            method === 'and' || method === 'or'
              ? { kind: method, steps: otherSteps }
              : { kind: 'filter', [method]: otherSteps },
          ],
        },
      });
    }
  });

  it('serializes History and locator requests without a Host Call bridge', async () => {
    const agent = await setupBrowserRuntime();
    const browser = await agent.browsers.get('extension');
    await browser.user.history({
      queries: ['qwen'],
      from: new Date('2026-08-01T00:00:00.000Z'),
      limit: 5,
    });
    const tab = await browser.tabs.new();
    const crossRealmRegex = vm.runInNewContext('/log in/i') as RegExp;
    await tab.playwright
      .getByRole('button', { name: crossRealmRegex })
      .first()
      .click({ modifiers: ['Shift'] });
    await tab.playwright.locator('img').downloadMedia({ timeoutMs: 1_000 });
    await tab.playwright.domSnapshot();
    await tab.dom_cua.click({ node_id: 'f1e3' });
    await tab.dom_cua.type({ text: 'hello' });
    await tab.dom_cua.keypress({ keys: ['Control', 'a'] });
    await tab.dom_cua.scroll({ x: 0, y: 200 });
    await tab.cua.click({ x: 10, y: 20, button: 4 });

    expect(backend.calls).toContainEqual(
      expect.objectContaining({
        method: 'browser.user.history',
        args: {
          browserId: 'chrome',
          options: {
            queries: ['qwen'],
            from: '2026-08-01T00:00:00.000Z',
            limit: 5,
          },
        },
      }),
    );
    expect(backend.calls).toContainEqual({
      method: 'playwright.domSnapshot',
      args: { tabId: 'tab-1' },
    });
    expect(backend.calls).toContainEqual({
      method: 'dom_cua.click',
      args: { tabId: 'tab-1', node_id: 'f1e3' },
    });
    expect(backend.calls).toContainEqual({
      method: 'dom_cua.type',
      args: { tabId: 'tab-1', text: 'hello' },
    });
    expect(backend.calls).toContainEqual({
      method: 'dom_cua.keypress',
      args: { tabId: 'tab-1', keys: ['Control', 'a'] },
    });
    expect(backend.calls).toContainEqual({
      method: 'dom_cua.scroll',
      args: { tabId: 'tab-1', x: 0, y: 200 },
    });
    expect(backend.calls).toContainEqual({
      method: 'cua.click',
      args: { tabId: 'tab-1', x: 10, y: 20, button: 4 },
    });
    expect(backend.calls).toContainEqual(
      expect.objectContaining({
        method: 'locator.click',
        args: {
          tabId: 'tab-1',
          steps: [
            {
              kind: 'getByRole',
              role: 'button',
              name: { regex: 'log in', flags: 'i' },
            },
            { kind: 'first' },
          ],
          modifiers: ['Shift'],
        },
      }),
    );
    expect(backend.calls).toContainEqual({
      method: 'locator.downloadMedia',
      args: {
        tabId: 'tab-1',
        steps: [{ kind: 'locator', selector: 'img' }],
        timeoutMs: 1_000,
      },
    });
  });

  it('returns a screenshot with bytes and original image metadata', async () => {
    const agent = await setupBrowserRuntime();
    const browser = await agent.browsers.get('chrome');
    const tab = await browser.tabs.new();
    const screenshot = await tab.screenshot();

    expect(screenshot.bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(screenshot.bytes).toString('base64')).toBe(
      'iVBORw0KGgo=',
    );
    expect(screenshot).toEqual({
      bytes: screenshot.bytes,
      mimeType: 'image/png',
      metadata: {
        width: 1280,
        height: 720,
        viewport: { width: 1280, height: 720 },
        devicePixelRatio: 2,
        coordinateSpace: 'css-pixels',
      },
    });
  });

  it('rejects invalid locator composition and never coerces model values', async () => {
    const agent = await setupBrowserRuntime();
    const browser = await agent.browsers.get('chrome');
    const tab = await browser.tabs.new();
    const locator = tab.playwright.locator('button');

    expect(() =>
      locator.filter({ has: {} as unknown as typeof locator }),
    ).toThrow('filter has expects a Locator');

    await tab.goto(undefined as unknown as string);
    expect(backend.calls.at(-1)).toEqual({
      method: 'tab.goto',
      args: { tabId: 'tab-1' },
    });

    await tab.playwright.locator('img').downloadMedia();
    expect(backend.calls.at(-1)).toEqual({
      method: 'locator.downloadMedia',
      args: {
        tabId: 'tab-1',
        steps: [{ kind: 'locator', selector: 'img' }],
      },
    });
  });

  it('exposes only the actions supported by each dialog type', async () => {
    const agent = await setupBrowserRuntime();
    const browser = await agent.browsers.get('chrome');
    const tab = await browser.tabs.new();

    backend.dispatch.mockResolvedValueOnce({
      type: 'alert',
      message: 'Heads up',
      defaultPrompt: '',
    });
    const alert = await tab.getJsDialog();
    if (alert?.type !== 'alert') throw new Error('expected an alert dialog');
    expect(alert.message).toBe('Heads up');
    expect('accept' in alert).toBe(false);
    await alert.dismiss();

    backend.dispatch.mockResolvedValueOnce({
      type: 'prompt',
      message: 'Name',
      defaultPrompt: 'Qwen',
    });
    const prompt = await tab.getJsDialog();
    if (prompt?.type !== 'prompt') throw new Error('expected a prompt dialog');
    expect(prompt.defaultValue).toBe('Qwen');
    expect(() => prompt.accept(undefined as unknown as string)).toThrow(
      'Prompt dialog accept expects text',
    );
    await prompt.accept('Codex');

    expect(backend.calls).toContainEqual({
      method: 'tab.dialog.accept',
      args: { tabId: 'tab-1', promptText: 'Codex' },
    });
  });

  it('keeps model values behind a JSON boundary', async () => {
    const agent = await setupBrowserRuntime();
    const browser = await agent.browsers.get('chrome');
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const dispatchCount = backend.dispatch.mock.calls.length;

    await expect(browser.user.history(cyclic)).rejects.toThrow(
      'Browser operation arguments must be JSON-serializable',
    );
    expect(backend.dispatch).toHaveBeenCalledTimes(dispatchCount);

    const cyclicResult: Record<string, unknown> = {};
    cyclicResult['self'] = cyclicResult;
    backend.dispatch.mockResolvedValueOnce(cyclicResult);
    await expect(browser.documentation()).rejects.toThrow(
      'Browser operation result must be JSON-serializable',
    );
  });

  it('can retry after backend setup fails', async () => {
    const createBackend = vi.mocked(createBrowserBackend);
    createBackend.mockRejectedValueOnce(new Error('install failed'));

    await expect(setupBrowserRuntime()).rejects.toThrow('install failed');
    await expect(setupBrowserRuntime()).resolves.toBeDefined();
    expect(createBackend).toHaveBeenCalledTimes(2);
  });
});
