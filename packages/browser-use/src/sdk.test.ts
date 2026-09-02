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
      return { id: 'user-chrome', name: 'User Chrome' };
    }
    if (method === 'browser.documentation') return 'browser docs';
    if (method === 'browser.user.history') return [];
    if (method === 'tabs.new') return { id: 'tab-1' };
    if (method === 'locator.click') return null;
    if (method === 'tab.screenshot') {
      return {
        mediaType: 'image/png',
        base64: 'iVBORw0KGgo=',
      };
    }
    throw new Error(`unexpected call: ${method}`);
  }),
  close: vi.fn(async () => undefined),
}));

vi.mock('./sdk-backend.js', () => ({
  createBrowserBackend: vi.fn(async () => backend),
}));

import { createBrowserBackend } from './sdk-backend.js';
import { closeBrowserRuntime, setupBrowserRuntime } from './index.mjs';

interface NodeReplBrowserRuntime {
  emitImage(image: unknown): Promise<void>;
}

afterEach(async () => {
  await closeBrowserRuntime();
  backend.calls.length = 0;
  vi.clearAllMocks();
});

describe('Browser SDK in the existing Node REPL', () => {
  it('reuses one agent and backend across Node REPL cells', async () => {
    const runtime = {
      emitImage: async () => undefined,
    } satisfies NodeReplBrowserRuntime;

    const agent = await setupBrowserRuntime(runtime);
    const browser = await agent.browsers.get('user-chrome');
    expect(await browser.documentation()).toBe('browser docs');
    expect(await setupBrowserRuntime(runtime)).toBe(agent);

    expect(backend.calls.map(({ method }) => method)).toEqual([
      'browsers.get',
      'browser.documentation',
    ]);
  });

  it('serializes History and locator requests without a Host Call bridge', async () => {
    const runtime = nodeReplRuntime();
    const agent = await setupBrowserRuntime(runtime);
    const browser = await agent.browsers.get('user-chrome');
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

    expect(backend.calls).toContainEqual(
      expect.objectContaining({
        method: 'browser.user.history',
        args: {
          browserId: 'user-chrome',
          options: {
            queries: ['qwen'],
            from: '2026-08-01T00:00:00.000Z',
            limit: 5,
          },
        },
      }),
    );
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
  });

  it('converts screenshot base64 into the existing emitImage byte shape', async () => {
    const runtime = nodeReplRuntime();
    const agent = await setupBrowserRuntime(runtime);
    const browser = await agent.browsers.get('user-chrome');
    const tab = await browser.tabs.new();
    const screenshot = await tab.screenshot();

    expect(screenshot.mimeType).toBe('image/png');
    expect(Buffer.isBuffer(screenshot.bytes)).toBe(true);
    expect(Buffer.from(screenshot.bytes).toString('base64')).toBe(
      'iVBORw0KGgo=',
    );
  });

  it('keeps model values behind a JSON boundary', async () => {
    const runtime = nodeReplRuntime();
    const agent = await setupBrowserRuntime(runtime);
    const browser = await agent.browsers.get('user-chrome');
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

  it('rejects initialization without the existing Node REPL runtime', async () => {
    await expect(
      setupBrowserRuntime(undefined as unknown as NodeReplBrowserRuntime),
    ).rejects.toThrow('requires the Qwen nodeRepl object');
  });

  it('can retry after backend setup fails', async () => {
    const createBackend = vi.mocked(createBrowserBackend);
    createBackend.mockRejectedValueOnce(new Error('install failed'));
    const runtime = nodeReplRuntime();

    await expect(setupBrowserRuntime(runtime)).rejects.toThrow(
      'install failed',
    );
    await expect(setupBrowserRuntime(runtime)).resolves.toBeDefined();
    expect(createBackend).toHaveBeenCalledTimes(2);
  });
});

function nodeReplRuntime(): NodeReplBrowserRuntime {
  return {
    emitImage: async () => undefined,
  };
}
