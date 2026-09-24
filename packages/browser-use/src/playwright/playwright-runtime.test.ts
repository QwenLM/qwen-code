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
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BridgeEvent, ChromeBridge } from '../bridge/index.js';
import { BrowserRuntimeError } from '../core/errors.js';
import type {
  BrowserUserTabInfo,
  ScreenshotEnvelope,
  TabInfo,
} from '../core/primitives.js';
import { BrowserSdkContext } from '../sdk/context.js';
import { TabProxy } from '../sdk/tab.js';
import { PlaywrightRuntime } from './playwright-runtime.js';

const playwrightMocks = vi.hoisted(() => ({
  connectOverCDP: vi.fn(),
}));

vi.mock('./playwright-core-loader.js', () => ({
  chromium: { connectOverCDP: playwrightMocks.connectOverCDP },
}));

// The runtime takes its timers from node:timers, which vi.useFakeTimers()
// leaves alone; routing them through the globals lets the fake clock drive
// the bounds the tests below advance past.
vi.mock('node:timers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers')>();
  return {
    ...actual,
    setTimeout: (callback: () => void, ms?: number) =>
      globalThis.setTimeout(callback, ms),
    clearTimeout: (handle: NodeJS.Timeout | undefined) =>
      globalThis.clearTimeout(handle),
  };
});

const runtimes: PlaywrightRuntime[] = [];

beforeEach(() => {
  playwrightMocks.connectOverCDP.mockReset();
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
});

describe('PlaywrightRuntime command contracts', () => {
  describe.each([
    'playwright.evaluate',
    'locator.evaluate',
    'locator.evaluateAll',
  ] as const)('%s JSON results', (method) => {
    async function evaluate(script: string) {
      const fixture = await runtimeFixture();
      const tab = await createTab(fixture.runtime);
      const evaluation =
        method === 'playwright.evaluate'
          ? fixture.page.evaluate
          : method === 'locator.evaluate'
            ? fixture.locator.evaluate
            : fixture.locator.evaluateAll;
      evaluation.mockImplementation(
        async (
          callback: (target: unknown, source?: string) => Promise<unknown>,
          source: string,
        ) => {
          const result =
            method === 'playwright.evaluate'
              ? await callback(source)
              : await callback(
                  method === 'locator.evaluateAll' ? [{}, {}] : {},
                  source,
                );
          // Model lossy transport conversion after the page callback returns.
          return result === undefined
            ? undefined
            : JSON.parse(JSON.stringify(result));
        },
      );
      return await fixture.runtime.dispatch(method, {
        tabId: tab.id,
        ...(method === 'playwright.evaluate'
          ? {}
          : { steps: [{ kind: 'locator', selector: 'button' }] }),
        script,
      });
    }

    it.each([
      'NaN',
      'Infinity',
      'new Date(0)',
      '/pattern/',
      'new Map()',
      '({ value: undefined })',
      '({ value: () => 1 })',
      '[undefined]',
    ])('rejects %s before transport can alter it', async (value) => {
      await expect(evaluate(`return ${value};`)).rejects.toMatchObject({
        code: 'OPERATION_FAILED',
        message: expect.stringContaining('JSON-serializable'),
      });
    });

    it('preserves JSON results, repeated references, and top-level undefined', async () => {
      await expect(evaluate('return undefined;')).resolves.toBeNull();
      await expect(
        evaluate(
          'const value = { a: [1, true, null] }; return [value, value];',
        ),
      ).resolves.toEqual([{ a: [1, true, null] }, { a: [1, true, null] }]);
      await expect(
        evaluate('return JSON.parse(\'{"__proto__":{"value":1}}\');'),
      ).resolves.toEqual(JSON.parse('{"__proto__":{"value":1}}'));
    });

    it('preserves access to a page global named result', async () => {
      await expect(
        evaluate(
          'globalThis.result = 42; try { return result; } finally { delete globalThis.result; }',
        ),
      ).resolves.toBe(42);
    });
  });

  it('rejects deep locator plans and zero operation timeouts before startup', async () => {
    const fixture = await runtimeFixture();
    let steps: unknown[] = [{ kind: 'locator', selector: 'button' }];
    for (let level = 1; level < 1_000; level++) {
      steps = [{ kind: 'and', steps }];
    }
    for (const args of [
      { tabId: 'tab-1', steps },
      {
        tabId: 'tab-1',
        steps: [{ kind: 'locator', selector: 'button' }],
        timeoutMs: 0,
      },
    ]) {
      await expect(
        fixture.runtime.dispatch('locator.click', args),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(playwrightMocks.connectOverCDP).not.toHaveBeenCalled();
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it('reports invalid nested locator plans before starting the bridge', async () => {
    const fixture = await runtimeFixture();
    fixture.request.mockClear();
    await expect(
      fixture.runtime.dispatch('locator.count', {
        tabId: 'tab-1',
        steps: [{ kind: 'and', steps: [{ kind: 'locator' }] }],
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('steps.0.steps.0.selector'),
    });
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it('classifies an uncompilable locator regex as INVALID_ARGUMENT', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    for (const text of [{ regex: '(' }, { regex: 'a', flags: 'uv' }]) {
      await expect(
        fixture.runtime.dispatch('locator.count', {
          tabId: tab.id,
          steps: [{ kind: 'getByText', text }],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
  });

  it.each(['constructor', 'hasOwnProperty', '__proto__'])(
    'rejects inherited Object.prototype keys as unknown methods: %s',
    async (method) => {
      const fixture = await runtimeFixture();
      await expect(fixture.runtime.dispatch(method, {})).rejects.toMatchObject({
        code: 'UNKNOWN_METHOD',
      });
      expect(fixture.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    'playwright.evaluate',
    'locator.evaluate',
    'locator.evaluateAll',
  ] as const)(
    'bounds the full %s call with a timeout error',
    async (method) => {
      const fixture = await runtimeFixture();
      const tab = await createTab(fixture.runtime);
      const evaluate =
        method === 'playwright.evaluate'
          ? fixture.page.evaluate
          : method === 'locator.evaluate'
            ? fixture.locator.evaluate
            : fixture.locator.evaluateAll;
      let resolve: (value: unknown) => void = () => undefined;
      const pending = new Promise<unknown>((done) => {
        resolve = done;
      });
      evaluate.mockReturnValueOnce(pending);
      vi.useFakeTimers();
      try {
        const result = fixture.runtime
          .dispatch(method, {
            tabId: tab.id,
            ...(method === 'playwright.evaluate'
              ? {}
              : { steps: [{ kind: 'locator', selector: 'body' }] }),
            script: 'return new Promise(() => {});',
            timeoutMs: 100,
          })
          .catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(100);
        expect(await result).toMatchObject({
          code: 'OPERATION_TIMEOUT',
        });
        expect(evaluate).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        resolve(null);
        vi.useRealTimers();
      }
    },
  );

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

  it('discovers profiles without binding and selects before starting the bridge', async () => {
    const selected: string[] = [];
    const start = vi.fn(async () => {
      expect(selected).toEqual(['chrome:profile-b']);
    });
    const fixture = await runtimeFixture({
      bridgeOverrides: {
        start,
        profiles: async () =>
          ['a', 'b'].map((id) => ({
            extensionInstanceId: `profile-${id}`,
            hostInstanceId: `host-${id}`,
            protocolVersion: 3,
            extensionProtocolVersion: 3,
            socketPath: `/profile-${id}`,
            pid: 1,
            ...(id === 'b'
              ? { profileName: 'Chrome · Work', lastUsed: true }
              : {}),
          })),
        selectProfile: (id) => {
          if (selected.length === 0) selected.push(id);
        },
      },
    });
    const profiles = await fixture.runtime.dispatch('browsers.list', {});
    expect(profiles).toEqual([
      expect.objectContaining({
        id: 'chrome:profile-a',
        name: 'Chrome · profile-a',
      }),
      expect.objectContaining({
        id: 'chrome:profile-b',
        name: 'Chrome · Work',
      }),
    ]);
    expect(start).not.toHaveBeenCalled();
    expect(selected).toEqual([]);
    await expect(
      fixture.runtime.dispatch('browsers.get', { id: 'chrome:profile-b' }),
    ).resolves.toMatchObject({ id: 'chrome:profile-b' });
    expect(start).toHaveBeenCalledOnce();
    await expect(
      fixture.runtime.dispatch('tabs.new', { browserId: 'chrome:profile-b' }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('a profile that never connects does not become the runtime id', async () => {
    const start = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        new BrowserRuntimeError(
          'BROWSER_DISCONNECTED',
          'Chrome extension is not connected',
        ),
      )
      .mockResolvedValue(undefined);
    const fixture = await runtimeFixture({
      bridgeOverrides: { start, selectProfile: () => undefined },
    });
    await expect(
      fixture.runtime.dispatch('browsers.get', { id: 'chrome:typo' }),
    ).rejects.toMatchObject({ code: 'BROWSER_DISCONNECTED' });
    expect(fixture.runtime.browserId).toBe('chrome');
    await expect(
      fixture.runtime.dispatch('browsers.get', { id: 'chrome:profile-a' }),
    ).resolves.toMatchObject({ id: 'chrome:profile-a' });
  });

  it('rejects profile discovery once shutdown starts', async () => {
    const profiles = vi.fn(async () => []);
    const start = vi.fn(async () => undefined);
    const fixture = await runtimeFixture({
      bridgeOverrides: { profiles, start },
    });
    const stopping = fixture.runtime.stop();
    await expect(
      fixture.runtime.dispatch('browsers.list', {}),
    ).rejects.toMatchObject({ code: 'NOT_RUNNING' });
    await stopping;
    await expect(
      fixture.runtime.dispatch('browsers.list', {}),
    ).rejects.toMatchObject({ code: 'NOT_RUNNING' });
    expect(profiles).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('delegates tab navigation to Playwright', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);

    await fixture.runtime.dispatch('tab.goto', {
      tabId: tab.id,
      url: 'https://example.com/next',
    });
    await fixture.runtime.dispatch('tab.back', { tabId: tab.id });
    await fixture.runtime.dispatch('tab.forward', { tabId: tab.id });
    await fixture.runtime.dispatch('tab.reload', {
      tabId: tab.id,
    });

    expect(fixture.page.goto).toHaveBeenCalledWith('https://example.com/next');
    expect(fixture.page.goBack).toHaveBeenCalledExactlyOnceWith({
      waitUntil: 'commit',
      timeout: 30_000,
    });
    expect(fixture.page.goForward).toHaveBeenCalledExactlyOnceWith({
      waitUntil: 'commit',
      timeout: 30_000,
    });
    expect(fixture.page.reload).toHaveBeenCalledWith();
  });

  it.each(['file:///etc/passwd', 'chrome://settings', 'about:blank'])(
    'rejects a non-http(s) tab.goto URL: %s',
    async (url) => {
      const fixture = await runtimeFixture();
      const tab = await createTab(fixture.runtime);

      // Navigating the user's real Chrome to file:// would hand local file
      // contents to this tab's evaluate/domSnapshot reads.
      await expect(
        fixture.runtime.dispatch('tab.goto', { tabId: tab.id, url }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(fixture.page.goto).not.toHaveBeenCalled();
    },
  );

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

  it('cleans up a tab closed during focus setup and allows registration again', async () => {
    const fixture = await runtimeFixture();
    const request = fixture.request.getMockImplementation()!;
    fixture.request.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        const result = await request(method, params);
        if (params.method === 'Emulation.setFocusEmulationEnabled')
          fixture.page.isClosed.mockReturnValue(true);
        return result;
      },
    );

    await expect(createTab(fixture.runtime)).rejects.toMatchObject({
      code: 'STALE_TAB',
    });
    expect(fixture.request).toHaveBeenCalledWith(
      'tabs.detach',
      { tabId: 17 },
      2_000,
    );
    await expect(
      fixture.runtime.dispatch('tabs.list', { browserId: 'chrome' }),
    ).resolves.toEqual([]);
    await expect(
      fixture.runtime.dispatch('tabs.selected', { browserId: 'chrome' }),
    ).resolves.toBeNull();

    fixture.page.isClosed.mockReturnValue(false);
    fixture.request.mockImplementation(request);
    await expect(createTab(fixture.runtime)).resolves.toMatchObject({
      title: 'Fixture',
    });
    expect(
      fixture.request.mock.calls.filter(([method]) => method === 'tabs.attach'),
    ).toHaveLength(2);
  });

  it.each([
    ['the page reports itself closed', 'isClosed'],
    ['the close event already released the tab', 'close'],
  ] as const)(
    'reports STALE_TAB when %s while a page command runs',
    async (_label, signal) => {
      const fixture = await runtimeFixture();
      const tab = await createTab(fixture.runtime);
      // The pinned playwright-core client renders a closed target as a plain
      // Error (only TimeoutError sets `name`), and evaluate-channel text
      // fails closed, so the dispatcher must decide from the tab's own state.
      fixture.page.evaluate.mockImplementation(async () => {
        if (signal === 'isClosed') {
          fixture.page.isClosed.mockReturnValue(true);
        } else {
          const onClose = fixture.page.on.mock.calls.find(
            ([event]) => event === 'close',
          )?.[1] as (() => void) | undefined;
          expect(onClose).toBeDefined();
          onClose!();
        }
        throw new Error(
          'page.evaluate: Target page, context or browser has been closed',
        );
      });
      await expect(
        fixture.runtime.dispatch('playwright.evaluate', {
          tabId: tab.id,
          script: 'return 1;',
        }),
      ).rejects.toMatchObject({ code: 'STALE_TAB' });
      fixture.page.isClosed.mockReturnValue(false);
    },
  );

  it('builds locator plans and delegates read and input operations', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    const steps = [
      {
        kind: 'getByRole' as const,
        role: 'button',
        name: 'Save',
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
      name: 'Save',
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
    new TypeError('globalThis.setTimeout is not a function'),
    new Error('page timer shim rejected the drain'),
    new Error('renderer failed'),
  ])(
    'preserves successful input when the auxiliary drain fails (%j)',
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

  it('clears the drain bound when the page settles first', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
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
      expect(settled).toHaveBeenCalledExactlyOnceWith(null);
      expect(fixture.page.evaluate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      await operation;
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

  it.each(['playwright.domSnapshot', 'dom_cua.get_visible_dom'] as const)(
    'preserves the full Playwright snapshot through %s',
    async (method) => {
      const fixture = await runtimeFixture();
      const raw = [
        '- generic [active] [ref=e1]:',
        '  - grid [ref=e6]:',
        '    - rowgroup [ref=e7]:',
        '      - row [ref=e8]:',
        '        - gridcell "Acme Corp" [ref=e9]',
        '  - table [ref=e10]:',
        '    - rowgroup [ref=e11]:',
        '      - row [ref=e12]:',
        '        - cell "Native Cell" [ref=e13]',
        '  - generic "pointer container" [ref=e14] [cursor=pointer]:',
        '    - img "Nested Image" [ref=e15]',
        '  - button "Control Button" [ref=e17]',
        '  - paragraph [ref=e18]: Static paragraph',
        '  - heading "Static heading" [level=2] [ref=e19]',
        '  - iframe [ref=e20]:',
        '    - cell "Frame cell" [ref=f1e2]',
      ].join('\n');
      fixture.page.ariaSnapshot.mockResolvedValue(raw);
      const tab = await createTab(fixture.runtime);

      await expect(
        fixture.runtime.dispatch(method, { tabId: tab.id }),
      ).resolves.toBe(raw);
      expect(fixture.page.ariaSnapshot).toHaveBeenCalledWith({ mode: 'ai' });
    },
  );

  it('delegates snapshot ref actions to Playwright aria-ref locators', async () => {
    const fixture = await runtimeFixture();
    fixture.locator.count.mockResolvedValue(1);
    const raw = [
      '- heading "Settings" [level=1]',
      '- iframe [ref=e2]:',
      '  - button "Save" [ref=f1e2]',
    ].join('\n');
    fixture.page.ariaSnapshot.mockResolvedValueOnce(raw);
    const tab = await createTab(fixture.runtime);

    await expect(
      fixture.runtime.dispatch('dom_cua.get_visible_dom', {
        tabId: tab.id,
      }),
    ).resolves.toBe(raw);
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

  it('invalidates snapshot refs when the main frame navigates', async () => {
    const fixture = await runtimeFixture();
    fixture.locator.count.mockResolvedValue(1);
    const tab = await createTab(fixture.runtime);
    await fixture.runtime.dispatch('playwright.domSnapshot', {
      tabId: tab.id,
    });
    await fixture.runtime.dispatch('dom_cua.click', {
      tabId: tab.id,
      node_id: 'e1',
    });
    expect(fixture.locator.click).toHaveBeenCalledOnce();

    // Playwright restarts ref numbering on the new document, so the old
    // snapshot's refs must stop resolving instead of hitting a stranger.
    const navigated = fixture.page.on.mock.calls.find(
      ([event]) => event === 'framenavigated',
    )?.[1] as ((frame: Frame) => void) | undefined;
    expect(navigated).toBeDefined();
    navigated!(fixture.page.mainFrame() as Frame);

    await expect(
      fixture.runtime.dispatch('dom_cua.click', {
        tabId: tab.id,
        node_id: 'e1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_LOCATOR' });
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
    fixture.page.ariaSnapshot.mockResolvedValue(
      '- iframe [ref=e1]:\n  - button "Save" [ref=f1e2]',
    );
    await tab.dom_cua.get_visible_dom();

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
    expect(fixture.page.mouse.move).toHaveBeenCalledExactlyOnceWith(12, 34);
    expect(fixture.page.mouse.move.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.cdp.send.mock.invocationCallOrder[0] ?? 0,
    );
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
    // All three other pages and the matching page were each probed once.
    expect(fixture.probeDetach).toHaveBeenCalledTimes(4);
    expect(fixture.cdp.detach).not.toHaveBeenCalled();
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
    const downloadStartedAt = Date.now();
    await fixture.runtime.dispatch('locator.downloadMedia', {
      tabId: tab.id,
      steps,
      timeoutMs: 16,
    });
    const downloadFinishedAt = Date.now();
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
      expect.any(Number),
      { timeout: 16 },
    );
    const deadline = fixture.locator.evaluate.mock.calls[0]?.[1];
    expect(deadline).toBeGreaterThanOrEqual(downloadStartedAt + 16);
    expect(deadline).toBeLessThanOrEqual(downloadFinishedAt + 16);
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

  it('validates upload paths before handing them to the file chooser', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    const setFiles = vi.fn(async () => undefined);
    fixture.page.waitForEvent.mockResolvedValueOnce({
      isMultiple: () => true,
      setFiles,
    });
    const chooser = (await fixture.runtime.dispatch('playwright.waitForEvent', {
      tabId: tab.id,
      event: 'filechooser',
    })) as { chooserId: string };
    expect(chooser).toEqual({
      chooserId: expect.stringMatching(/^chooser-/),
      multiple: true,
    });
    const setChooserFiles = (files: string[], timeoutMs?: number) =>
      fixture.runtime.dispatch('fileChooser.setFiles', {
        tabId: tab.id,
        chooserId: chooser.chooserId,
        files,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    const directory = await mkdtemp(join(tmpdir(), 'browser-use-upload-'));
    try {
      const file = join(directory, 'upload.txt');
      await writeFile(file, 'payload');
      const rejected: Array<[files: string[], reason: string]> = [
        [['relative/upload.txt'], 'absolute'],
        [[join(directory, 'missing.txt')], 'does not exist'],
        [[directory], 'not a file'],
      ];
      for (const [files, reason] of rejected)
        await expect(setChooserFiles(files)).rejects.toMatchObject({
          code: 'INVALID_ARGUMENT',
          message: expect.stringContaining(reason),
        });
      expect(setFiles).not.toHaveBeenCalled();

      await expect(setChooserFiles([file], 1_000)).resolves.toBeNull();
      expect(setFiles).toHaveBeenCalledExactlyOnceWith([await realpath(file)], {
        timeout: 1_000,
      });
      await expect(setChooserFiles([file])).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

  it('keeps an abandoned navigation waiter from surfacing as an unhandled rejection', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    let abort!: (error: Error) => void;
    // A vi.fn records settled results by attaching its own rejection handler
    // to the returned promise, which would count as handling the rejection
    // this test watches for; the plain function leaves the waiter unobserved.
    Object.assign(fixture.page, {
      waitForNavigation: () =>
        new Promise<null>((_resolve, reject) => {
          abort = reject;
        }),
    });
    const waiterId = (await fixture.runtime.dispatch(
      'playwright.expectNavigation.begin',
      { tabId: tab.id },
    )) as string;
    await fixture.runtime.dispatch('playwright.expectNavigation.cancel', {
      tabId: tab.id,
      waiterId,
    });

    // vitest ignores unhandled errors off Linux, so the check is explicit.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      abort(new Error('Navigation aborted'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    await expect(
      fixture.runtime.dispatch('playwright.expectNavigation.wait', {
        tabId: tab.id,
        waiterId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
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

  it('passes prompt text to accept and nothing for a confirm', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    const prompt = openDialog(fixture, 'prompt', 'Name?');
    await fixture.runtime.dispatch('tab.dialog.accept', {
      ...(await dialogArgs(fixture.runtime, tab.id)),
      promptText: 'Codex',
    });
    expect(prompt.accept).toHaveBeenCalledExactlyOnceWith('Codex');

    const confirm = openDialog(fixture, 'confirm', 'Continue?');
    await fixture.runtime.dispatch(
      'tab.dialog.accept',
      await dialogArgs(fixture.runtime, tab.id),
    );
    expect(confirm.accept).toHaveBeenCalledExactlyOnceWith(undefined);
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
      tabId: 22,
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

  it('drops a dialog the bridge already reported closed before Playwright delivered it', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    // Chrome reported the opening and the close in one chunk, so both bridge
    // events run before Playwright hands the dialog over from a later
    // macrotask (its in-process dispatcher hops through setImmediate).
    fixture.emitEvent(dialogEvent('Page.javascriptDialogOpening'));
    fixture.emitEvent(dialogEvent('Page.javascriptDialogClosed'));
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        openDialog(fixture, 'alert', 'Already gone');
        resolve();
      }),
    );
    await expect(
      fixture.runtime.dispatch('tab.getJsDialog', { tabId: tab.id }),
    ).resolves.toBeNull();
    await expect(
      fixture.runtime.dispatch('tab.title', { tabId: tab.id }),
    ).resolves.toBe('Fixture');
  });

  it('keeps a dialog whose close the bridge has not reported', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    // A close belonging to a dialog that was open before the tab was
    // attached must not be charged to the dialog that opens next.
    fixture.emitEvent(dialogEvent('Page.javascriptDialogClosed'));
    fixture.emitEvent(dialogEvent('Page.javascriptDialogOpening'));
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        openDialog(fixture, 'confirm', 'Still open');
        resolve();
      }),
    );
    await expect(
      fixture.runtime.dispatch('tab.getJsDialog', { tabId: tab.id }),
    ).resolves.toMatchObject({ message: 'Still open' });
    await expect(
      fixture.runtime.dispatch('tab.title', { tabId: tab.id }),
    ).rejects.toMatchObject({ code: 'DIALOG_OPEN' });
  });

  it('pairs batched dialog events with their deliveries in order', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    // [opening, closed, opening] in one chunk: the first delivery is the
    // closed dialog and the second is live.
    fixture.emitEvent(dialogEvent('Page.javascriptDialogOpening'));
    fixture.emitEvent(dialogEvent('Page.javascriptDialogClosed'));
    fixture.emitEvent(dialogEvent('Page.javascriptDialogOpening'));
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        openDialog(fixture, 'alert', 'First');
        openDialog(fixture, 'confirm', 'Second');
        resolve();
      }),
    );
    await expect(
      fixture.runtime.dispatch('tab.getJsDialog', { tabId: tab.id }),
    ).resolves.toMatchObject({ message: 'Second' });
    fixture.emitEvent(dialogEvent('Page.javascriptDialogClosed'));
    await expect(
      fixture.runtime.dispatch('tab.getJsDialog', { tabId: tab.id }),
    ).resolves.toBeNull();
  });

  it('retires a traced opening Playwright never delivered', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    // The bridge reports an opening and a close that Playwright never hands
    // over (its dispatcher can auto-close without dispatching). Once the
    // delivery turn has passed, the entry must stop charging later dialogs.
    fixture.emitEvent(dialogEvent('Page.javascriptDialogOpening'));
    fixture.emitEvent(dialogEvent('Page.javascriptDialogClosed'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    fixture.emitEvent(dialogEvent('Page.javascriptDialogOpening'));
    openDialog(fixture, 'confirm', 'Live');
    await expect(
      fixture.runtime.dispatch('tab.getJsDialog', { tabId: tab.id }),
    ).resolves.toMatchObject({ message: 'Live' });
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
    await expect(
      fixture.runtime.dispatch('tabs.get', {
        browserId: 'chrome',
        tabId: tab.id,
      }),
    ).resolves.toEqual(expect.objectContaining({ id: tab.id, title: null }));
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

  it('gates a tab that a dialog already blocked when it was attached', async () => {
    const fixture = await runtimeFixture();
    // Chrome does not replay Page.javascriptDialogOpening for a dialog that
    // opened before attach and Playwright never delivers one, so the
    // attach-time renderer probe is the only signal; here it never settles.
    blockAttachProbe(fixture);
    vi.useFakeTimers();
    let tab: TabInfo;
    try {
      const created = createTab(fixture.runtime);
      await vi.advanceTimersByTimeAsync(1_000);
      tab = await created;
    } finally {
      vi.useRealTimers();
    }

    await expect(
      fixture.runtime.dispatch('playwright.domSnapshot', { tabId: tab.id }),
    ).rejects.toMatchObject({ code: 'DIALOG_OPEN' });
    await expect(
      fixture.runtime.dispatch('tab.goto', {
        tabId: tab.id,
        url: 'https://example.com/',
      }),
    ).rejects.toMatchObject({ code: 'DIALOG_OPEN' });
    expect(fixture.page.goto).not.toHaveBeenCalled();
    // The blocked tab stays listable without waiting on its renderer.
    await expect(
      fixture.runtime.dispatch('tabs.get', {
        browserId: 'chrome',
        tabId: tab.id,
      }),
    ).resolves.toMatchObject({ id: tab.id, title: null });

    const descriptor = (await fixture.runtime.dispatch('tab.getJsDialog', {
      tabId: tab.id,
    })) as { dialogId: string };
    expect(descriptor.dialogId).toBe('dialog-open-at-attach');
    await fixture.runtime.dispatch('tab.dialog.dismiss', {
      tabId: tab.id,
      dialogId: descriptor.dialogId,
    });
    expect(fixture.request).toHaveBeenCalledWith('cdp.send', {
      tabId: 17,
      method: 'Page.handleJavaScriptDialog',
      params: { accept: false },
    });
    await expect(
      fixture.runtime.dispatch('tab.title', { tabId: tab.id }),
    ).resolves.toBe('Fixture');
  });

  it('unblocks the tab when Chrome closes a pre-attach dialog', async () => {
    const fixture = await runtimeFixture();
    blockAttachProbe(fixture);
    vi.useFakeTimers();
    let tab: TabInfo;
    try {
      const created = createTab(fixture.runtime);
      await vi.advanceTimersByTimeAsync(1_000);
      tab = await created;
    } finally {
      vi.useRealTimers();
    }
    await expect(
      fixture.runtime.dispatch('tab.title', { tabId: tab.id }),
    ).rejects.toMatchObject({ code: 'DIALOG_OPEN' });

    fixture.emitEvent(dialogEvent('Page.javascriptDialogClosed'));

    await expect(
      fixture.runtime.dispatch('tab.title', { tabId: tab.id }),
    ).resolves.toBe('Fixture');
    await expect(
      fixture.runtime.dispatch('tab.getJsDialog', { tabId: tab.id }),
    ).resolves.toBeNull();
  });

  it('times out tab.title when the page never yields a title', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    fixture.page.title.mockReturnValue(new Promise<string>(() => {}));
    vi.useFakeTimers();
    try {
      const result = fixture.runtime
        .dispatch('tab.title', { tabId: tab.id })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await result).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists a tab whose title read never settles with a null title', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    fixture.page.title.mockReturnValue(new Promise<string>(() => {}));
    vi.useFakeTimers();
    try {
      const result = fixture.runtime
        .dispatch('tabs.list', { browserId: 'chrome' })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await result).toEqual([
        expect.objectContaining({ id: tab.id, title: null }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the session while a registering tab’s title read never settles', async () => {
    const fixture = await runtimeFixture();
    fixture.page.title.mockReturnValue(new Promise<string>(() => {}));
    vi.useFakeTimers();
    try {
      const created = fixture.runtime
        .dispatch('tabs.new', { browserId: 'chrome' })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await created).toMatchObject({ title: null });
      const stopped = fixture.runtime.stop().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(await stopped).not.toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
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
      | ((frame: Frame) => void)
      | undefined;
    expect(navigatedListener).toBeDefined();

    navigatedListener?.(fixture.page.mainFrame() as Frame);

    await fixture.runtime.dispatch('tab.goto', {
      tabId: tab.id,
      url: 'https://example.com/',
    });
    expect(fixture.page.goto).toHaveBeenCalledOnce();
  });

  it('keeps the cached dialog when a subframe navigates', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    const listeners = new Map(
      fixture.page.on.mock.calls as Array<[string, (value: never) => void]>,
    );
    const dialogListener = listeners.get('dialog') as
      | ((value: Dialog) => void)
      | undefined;
    dialogListener?.({
      type: () => 'confirm',
      message: () => 'Leave?',
      defaultValue: () => '',
      accept: vi.fn(async () => undefined),
      dismiss: vi.fn(async () => undefined),
    } as unknown as Dialog);
    const navigatedListener = listeners.get('framenavigated') as
      | ((frame: Frame) => void)
      | undefined;
    expect(navigatedListener).toBeDefined();

    navigatedListener?.({} as Frame);

    await expect(
      fixture.runtime.dispatch('tab.goto', {
        tabId: tab.id,
        url: 'https://example.com/',
      }),
    ).rejects.toMatchObject({ code: 'DIALOG_OPEN' });
    expect(fixture.page.goto).not.toHaveBeenCalled();
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
              providerTabId: 22,
              title: 'Popup',
              url: 'https://example.com/popup',
              derivedFromProviderTabId: 17,
            },
          ];
        if (method === 'tabs.attach' && params.tabId === 22)
          throw new Error('Cannot attach to target');
        return null;
      },
    );

    await expect(
      fixture.runtime.dispatch('tabs.list', { browserId: 'chrome' }),
    ).resolves.toEqual([expect.objectContaining({ id: tab.id })]);
  });

  it('lists healthy derived tabs after an earlier popup fails to attach', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    fixture.derivedTabs.push({ providerTabId: 22 }, { providerTabId: 23 });
    const request = fixture.request.getMockImplementation()!;
    fixture.request.mockImplementation(async (method, params = {}) => {
      if (method === 'tabs.attach' && params.tabId === 22)
        throw new Error('Cannot attach to target');
      return await request(method, params);
    });

    await expect(
      fixture.runtime.dispatch('tabs.list', { browserId: 'chrome' }),
    ).resolves.toEqual([
      expect.objectContaining({ id: tab.id }),
      expect.objectContaining({ title: 'Nested popup' }),
    ]);
    expect(fixture.request).toHaveBeenCalledWith('tabs.attach', { tabId: 23 });
  });

  it.each(['BROWSER_DISCONNECTED', 'STALE_BROWSER_SESSION'] as const)(
    'propagates %s after an earlier derived-tab attachment failure',
    async (code) => {
      const fixture = await runtimeFixture();
      await createTab(fixture.runtime);
      fixture.derivedTabs.push({ providerTabId: 22 }, { providerTabId: 23 });
      const request = fixture.request.getMockImplementation()!;
      fixture.request.mockImplementation(async (method, params = {}) => {
        if (method === 'tabs.attach' && params.tabId === 22)
          throw new Error('Cannot attach to target');
        if (method === 'tabs.attach' && params.tabId === 23)
          throw new BrowserRuntimeError(code, 'Chrome session lost');
        return await request(method, params);
      });

      await expect(
        fixture.runtime.dispatch('tabs.list', { browserId: 'chrome' }),
      ).rejects.toMatchObject({ code });
      expect(fixture.request).toHaveBeenCalledWith('tabs.attach', {
        tabId: 23,
      });
    },
  );

  it('propagates a lost connection while syncing derived tabs', async () => {
    const fixture = await runtimeFixture();
    await createTab(fixture.runtime);
    fixture.request.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'tabs.queryDerived')
          return [
            {
              providerTabId: 22,
              title: 'Popup',
              url: 'https://example.com/popup',
              derivedFromProviderTabId: 17,
            },
          ];
        if (method === 'tabs.attach' && params.tabId === 22)
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

  it('lists open user tabs newest first and leaves non-http tabs undiscoverable', async () => {
    const fixture = await runtimeFixture();
    const original = fixture.request.getMockImplementation()!;
    fixture.request.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'tabs.queryOpen')
          return [
            {
              providerTabId: 21,
              title: 'Mail',
              url: 'https://mail.example/a',
              lastOpened: '2026-09-01T00:00:00Z',
            },
            { providerTabId: 22, title: 'Mail', url: 'https://mail.example/b' },
            {
              providerTabId: 23,
              title: 'Mail',
              url: 'https://mail.example/c',
              lastOpened: '2026-09-07T00:00:00Z',
            },
            {
              providerTabId: 24,
              title: 'Secrets',
              url: 'file:///Users/x/.aws/credentials',
              lastOpened: '2026-09-08T00:00:00Z',
            },
          ];
        return await original(method, params);
      },
    );
    const listed = (await fixture.runtime.dispatch('browser.user.openTabs', {
      browserId: 'chrome',
    })) as Array<{ id: string; url: string | null }>;
    expect(listed.map((tab) => tab.url)).toEqual([
      'https://mail.example/c',
      'https://mail.example/a',
      'https://mail.example/b',
    ]);
    // A filtered-out tab never became a discovery record, so it cannot be
    // claimed by guessing its shape either.
    await expect(
      fixture.runtime.dispatch('browser.user.claimTab', {
        browserId: 'chrome',
        tab: {
          id: listed[0]!.id.replace(/open-.*/, 'open-elsewhere'),
          title: 'Secrets',
          url: 'file:///Users/x/.aws/credentials',
        },
      }),
    ).rejects.toMatchObject({ code: 'TAB_NOT_GRANTED' });
  });

  it('claims a discovered user tab only while it still matches discovery', async () => {
    const fixture = await runtimeFixture();
    const original = fixture.request.getMockImplementation()!;
    const current = {
      providerTabId: 17,
      title: 'Fixture',
      url: 'https://example.com/',
    };
    fixture.request.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'tabs.queryOpen') return [{ ...current }];
        if (method === 'tabs.get') return current;
        return await original(method, params);
      },
    );
    const claim = (tab: unknown) =>
      fixture.runtime.dispatch('browser.user.claimTab', {
        browserId: 'chrome',
        tab,
      });
    const attachCalls = () =>
      fixture.request.mock.calls.filter(([method]) => method === 'tabs.attach');

    const [open] = (await fixture.runtime.dispatch('browser.user.openTabs', {
      browserId: 'chrome',
    })) as BrowserUserTabInfo[];
    if (open === undefined) throw new Error('Expected one open tab');
    expect(open).toEqual({
      id: expect.stringMatching(/^open-/),
      title: 'Fixture',
      url: 'https://example.com/',
    });

    await expect(claim('open-unknown')).rejects.toMatchObject({
      code: 'TAB_NOT_GRANTED',
    });
    await expect(claim({ ...open, title: 'Edited' })).rejects.toMatchObject({
      code: 'STALE_TAB',
    });
    current.url = 'https://example.com/moved';
    await expect(claim(open.id)).rejects.toMatchObject({ code: 'STALE_TAB' });
    expect(attachCalls()).toEqual([]);

    current.url = 'https://example.com/';
    await expect(claim(open.id)).resolves.toEqual({
      id: expect.stringMatching(/^tab-/),
      title: 'Fixture',
      url: 'about:blank',
    });
    // The renderer probe attaches first; registration's attach is a no-op.
    expect(attachCalls()).toEqual([
      ['tabs.attach', { tabId: 17 }],
      ['tabs.attach', { tabId: 17 }],
    ]);
    await expect(
      fixture.runtime.dispatch('tabs.selected', { browserId: 'chrome' }),
    ).resolves.toMatchObject({ title: 'Fixture' });
  });

  it('re-claiming a controlled tab never probes or releases it', async () => {
    const fixture = await runtimeFixture();
    const first = await claimOpenTab(fixture);
    // A dialog under this session's own debugger blocks the renderer.
    blockAttachProbe(fixture);
    await expect(claimOpenTab(fixture)).resolves.toMatchObject({
      id: first.id,
    });
    expect(fixture.request).not.toHaveBeenCalledWith('tabs.release', {
      tabId: 17,
    });
  });

  it('releases the probed tab when the probe fails before answering', async () => {
    const fixture = await runtimeFixture();
    blockAttachProbe(fixture, () =>
      Promise.reject(
        new BrowserRuntimeError('OPERATION_FAILED', 'Target crashed'),
      ),
    );
    await expect(claimOpenTab(fixture)).rejects.toThrow('Target crashed');
    expect(fixture.request).toHaveBeenCalledWith('tabs.release', { tabId: 17 });
  });

  it('hands back a tab whose unattached dialog blocks its renderer', async () => {
    const fixture = await runtimeFixture();
    // Chrome's own dialog UI owns the modal: the renderer never answers.
    blockAttachProbe(fixture);
    vi.useFakeTimers();
    try {
      const claimed = claimOpenTab(fixture).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await claimed).toMatchObject({
        code: 'DIALOG_OPEN',
        message: expect.stringContaining('only the user can close'),
      });
    } finally {
      vi.useRealTimers();
    }
    const methods = fixture.request.mock.calls.map(([method]) => method);
    expect(methods).toContain('tabs.release');
    // Only the probe attached; Playwright registration never started.
    expect(methods.filter((method) => method === 'tabs.attach')).toHaveLength(
      1,
    );
    await expect(
      fixture.runtime.dispatch('tabs.list', { browserId: 'chrome' }),
    ).resolves.toEqual([]);
  });

  it('adopts a tracked popup only when its opener is a controlled tab', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    const original = fixture.request.getMockImplementation()!;
    fixture.request.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'tabs.get')
          return { providerTabId: 22, title: 'Popup', url: 'about:blank' };
        return await original(method, params);
      },
    );
    const popupTracked = (openerTabId: number): BridgeEvent => ({
      type: 'event',
      tabId: 22,
      method: 'qwenBrowser.derivedTabTracked',
      params: { openerTabId },
    });
    const lookups = () =>
      fixture.request.mock.calls.filter(([method]) => method === 'tabs.get');

    fixture.emitEvent(popupTracked(99));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lookups()).toEqual([]);

    fixture.emitEvent(popupTracked(17));
    await vi.waitFor(async () => {
      await expect(
        fixture.runtime.dispatch('tabs.list', { browserId: 'chrome' }),
      ).resolves.toHaveLength(2);
    });
    expect(lookups()).toEqual([['tabs.get', { tabId: 22 }]]);
    await expect(
      fixture.runtime.dispatch('tabs.list', { browserId: 'chrome' }),
    ).resolves.toEqual([
      expect.objectContaining({ id: tab.id }),
      expect.objectContaining({ title: 'Popup', url: 'about:blank' }),
    ]);
    await expect(
      fixture.runtime.dispatch('tabs.selected', { browserId: 'chrome' }),
    ).resolves.toMatchObject({ id: tab.id });
  });

  it('keeps the selected tab when listing adopts a derived popup', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    await expect(
      fixture.runtime.dispatch('tabs.selected', { browserId: 'chrome' }),
    ).resolves.toMatchObject({ id: tab.id });
    const original = fixture.request.getMockImplementation()!;
    fixture.request.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'tabs.queryDerived')
          return [
            {
              providerTabId: 22,
              title: 'Popup',
              url: 'about:blank',
              derivedFromProviderTabId: 17,
            },
          ];
        return await original(method, params);
      },
    );

    await expect(
      fixture.runtime.dispatch('tabs.list', { browserId: 'chrome' }),
    ).resolves.toEqual([
      expect.objectContaining({ id: tab.id }),
      expect.objectContaining({ title: 'Popup' }),
    ]);
    await expect(
      fixture.runtime.dispatch('tabs.selected', { browserId: 'chrome' }),
    ).resolves.toMatchObject({ id: tab.id });
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
      tabId: 22,
      method: 'qwenBrowser.derivedTabTracked',
      params: { openerTabId: 17 },
    });
    await fixture.runtime.stop();
    expect(fixture.listenerCount()).toBe(0);
    finish({ providerTabId: 22, title: 'Popup', url: 'about:blank' });
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

  it.each(['handoff', 'cleanup'] as const)(
    'finalizes a re-registered crashed provider once for %s',
    async (disposition) => {
      const fixture = await runtimeFixture();
      const oldTab = await createTab(fixture.runtime);
      const listeners = new Map(
        fixture.page.on.mock.calls as Array<[string, () => void]>,
      );
      listeners.get('crash')!();
      const newTab = await createTab(fixture.runtime);
      expect(newTab.id).not.toBe(oldTab.id);
      listeners.get('close')!();

      await fixture.runtime.dispatch('tabs.finalize', {
        browserId: 'chrome',
        keep:
          disposition === 'handoff'
            ? [{ tabId: newTab.id, status: 'handoff' }]
            : [],
      });

      expect(
        fixture.request.mock.calls.filter(
          ([method]) => method === 'tabs.close',
        ),
      ).toEqual(
        disposition === 'handoff' ? [] : [['tabs.close', { tabId: 17 }]],
      );
    },
  );

  it.each(['STALE_TAB', 'OPERATION_FAILED'] as const)(
    'only forgets a crash-retained tab when cleanup reports it gone: %s',
    async (code) => {
      const fixture = await runtimeFixture();
      await createTab(fixture.runtime);
      const listeners = new Map(
        fixture.page.on.mock.calls as Array<[string, () => void]>,
      );
      listeners.get('crash')!();
      listeners.get('close')!();
      const request = fixture.request.getMockImplementation()!;
      const error = new BrowserRuntimeError(code, 'Controlled cleanup failure');
      fixture.request.mockImplementation(async (method, params = {}) => {
        if (method === 'tabs.close') throw error;
        return await request(method, params);
      });
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = fixture.runtime.dispatch('tabs.finalize', {
            browserId: 'chrome',
            keep: [],
          });
          if (code === 'STALE_TAB') await expect(result).resolves.toBeNull();
          else await expect(result).rejects.toBe(error);
        }
        expect(
          fixture.request.mock.calls.filter(
            ([method]) => method === 'tabs.close',
          ),
        ).toHaveLength(code === 'STALE_TAB' ? 1 : 2);
      } finally {
        fixture.request.mockImplementation(request);
      }
    },
  );

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

  it('finalizes created, deliverable, and handoff tabs by disposition', async () => {
    const disposable = await runtimeFixture();
    await createTab(disposable.runtime);
    await disposable.runtime.dispatch('tabs.finalize', {
      browserId: 'chrome',
      keep: [],
    });
    expect(disposable.request).toHaveBeenCalledWith('tabs.close', {
      tabId: 17,
    });

    const claimed = await runtimeFixture();
    const candidates = (await claimed.runtime.dispatch(
      'browser.user.openTabs',
      { browserId: 'chrome' },
    )) as Array<{ id: string; title: string | null; url: string | null }>;
    await claimed.runtime.dispatch('browser.user.claimTab', {
      browserId: 'chrome',
      tab: candidates[0],
    });
    await claimed.runtime.dispatch('tabs.finalize', {
      browserId: 'chrome',
    });
    expect(claimed.request).toHaveBeenCalledWith('tabs.release', { tabId: 17 });
    expect(claimed.request).not.toHaveBeenCalledWith(
      'tabs.close',
      expect.anything(),
    );

    const deliverable = await runtimeFixture();
    const deliverableTab = await createTab(deliverable.runtime);
    await deliverable.runtime.dispatch('tabs.finalize', {
      browserId: 'chrome',
      keep: [{ tabId: deliverableTab.id, status: 'deliverable' }],
    });
    expect(deliverable.request).toHaveBeenCalledWith('tabs.release', {
      tabId: 17,
    });
    expect(deliverable.request).not.toHaveBeenCalledWith(
      'tabs.close',
      expect.anything(),
    );

    const handoff = await runtimeFixture();
    const handoffTab = await createTab(handoff.runtime);
    await handoff.runtime.dispatch('tabs.finalize', {
      browserId: 'chrome',
      keep: [{ tabId: handoffTab.id, status: 'handoff' }],
    });
    await expect(
      handoff.runtime.dispatch('tab.url', { tabId: handoffTab.id }),
    ).resolves.toBe('about:blank');
    expect(handoff.request).not.toHaveBeenCalledWith(
      'tabs.close',
      expect.anything(),
    );
    expect(handoff.request).not.toHaveBeenCalledWith(
      'tabs.release',
      expect.anything(),
    );
    await handoff.runtime.dispatch('tabs.finalize', {
      browserId: 'chrome',
      keep: [],
    });
    expect(handoff.request).toHaveBeenCalledWith('tabs.close', { tabId: 17 });

    const popup = await runtimeFixture();
    await createTab(popup.runtime);
    popup.derivedTabs.push(
      {
        providerTabId: 23,
        derivedFromProviderTabId: 22,
        title: 'Nested popup',
        url: 'https://example.com/nested-popup',
      },
      {
        providerTabId: 22,
        derivedFromProviderTabId: 17,
        title: 'Popup',
        url: 'https://example.com/popup',
      },
    );
    await popup.runtime.dispatch('tabs.finalize', {
      browserId: 'chrome',
      keep: [],
    });
    expect(popup.request).toHaveBeenCalledWith('tabs.close', { tabId: 22 });
    expect(popup.request).toHaveBeenCalledWith('tabs.close', { tabId: 23 });

    const latePopup = await runtimeFixture();
    await createTab(latePopup.runtime);
    latePopup.openTabs.splice(0, 1, {
      providerTabId: 22,
      title: 'Late popup',
      url: 'https://example.com/late-popup',
    });
    const lateCandidates = (await latePopup.runtime.dispatch(
      'browser.user.openTabs',
      { browserId: 'chrome' },
    )) as Array<{ id: string; title: string | null; url: string | null }>;
    await latePopup.runtime.dispatch('browser.user.claimTab', {
      browserId: 'chrome',
      tab: lateCandidates[0],
    });
    latePopup.derivedTabs.push({
      providerTabId: 22,
      derivedFromProviderTabId: 17,
      title: 'Late popup',
      url: 'https://example.com/late-popup',
    });
    await latePopup.runtime.dispatch('tabs.finalize', {
      browserId: 'chrome',
      keep: [],
    });
    expect(latePopup.request).toHaveBeenCalledWith('tabs.close', { tabId: 22 });
    expect(latePopup.request).not.toHaveBeenCalledWith('tabs.release', {
      tabId: 22,
    });

    const crashed = await runtimeFixture();
    await createTab(crashed.runtime);
    const crashHandler = crashed.page.on.mock.calls.find(
      ([event]) => event === 'crash',
    )?.[1] as (() => void) | undefined;
    expect(crashHandler).toBeDefined();
    crashHandler?.();
    await crashed.runtime.dispatch('tabs.finalize', {
      browserId: 'chrome',
      keep: [],
    });
    expect(crashed.request).toHaveBeenCalledWith('tabs.close', { tabId: 17 });
  });

  it.each(['created', 'claimed', 'deliverable', 'handoff'] as const)(
    'preserves %s disposition and cleans healthy popups after an attachment failure',
    async (disposition) => {
      const fixture = await runtimeFixture();
      let tab: TabInfo;
      if (disposition === 'claimed') {
        const candidates = (await fixture.runtime.dispatch(
          'browser.user.openTabs',
          { browserId: 'chrome' },
        )) as Array<{ id: string }>;
        tab = (await fixture.runtime.dispatch('browser.user.claimTab', {
          browserId: 'chrome',
          tab: candidates[0],
        })) as TabInfo;
      } else {
        tab = await createTab(fixture.runtime);
      }
      fixture.derivedTabs.push({ providerTabId: 22 }, { providerTabId: 23 });
      const request = fixture.request.getMockImplementation()!;
      fixture.request.mockImplementation(async (method, params = {}) => {
        if (method === 'tabs.attach' && params.tabId === 22) {
          throw new Error('Popup attachment failed');
        }
        return await request(method, params);
      });

      await expect(
        fixture.runtime.dispatch('tabs.finalize', {
          browserId: 'chrome',
          keep:
            disposition === 'handoff' || disposition === 'deliverable'
              ? [{ tabId: tab.id, status: disposition }]
              : [],
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('Popup attachment failed'),
      });

      expect(fixture.request).toHaveBeenCalledWith('tabs.close', { tabId: 23 });
      expect(fixture.request).not.toHaveBeenCalledWith('tabs.close', {
        tabId: 22,
      });
      if (disposition === 'handoff') {
        expect(fixture.request).not.toHaveBeenCalledWith('tabs.close', {
          tabId: 17,
        });
        expect(fixture.request).not.toHaveBeenCalledWith('tabs.release', {
          tabId: 17,
        });
        await expect(
          fixture.runtime.dispatch('tab.url', { tabId: tab.id }),
        ).resolves.toBe('about:blank');
      } else {
        expect(fixture.request).toHaveBeenCalledWith(
          disposition === 'created' ? 'tabs.close' : 'tabs.release',
          { tabId: 17 },
        );
        if (disposition !== 'created') {
          expect(fixture.request).not.toHaveBeenCalledWith('tabs.close', {
            tabId: 17,
          });
        }
        await expect(
          fixture.runtime.dispatch('tab.url', { tabId: tab.id }),
        ).rejects.toMatchObject({ code: 'STALE_TAB' });
      }
    },
  );

  it('cleans known tabs and reports a failed derived-tab query', async () => {
    const fixture = await runtimeFixture();
    await createTab(fixture.runtime);
    const request = fixture.request.getMockImplementation()!;
    fixture.request.mockImplementation(async (method, params = {}) => {
      if (method === 'tabs.queryDerived')
        throw new Error('Derived query failed');
      return await request(method, params);
    });

    await expect(
      fixture.runtime.dispatch('tabs.finalize', {
        browserId: 'chrome',
        keep: [],
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Derived query failed'),
    });
    expect(fixture.request).toHaveBeenCalledWith('tabs.close', { tabId: 17 });
  });

  it('finalizes an agent-created popup after its opener closes', async () => {
    const fixture = await runtimeFixture();
    await createTab(fixture.runtime);
    const closeHandler = fixture.page.on.mock.calls.find(
      ([event]) => event === 'close',
    )?.[1] as (() => void) | undefined;
    expect(closeHandler).toBeDefined();
    closeHandler?.();
    fixture.derivedTabs.push({
      providerTabId: 22,
      derivedFromProviderTabId: 17,
      title: 'Orphaned popup',
      url: 'https://example.com/orphaned-popup',
    });

    await fixture.runtime.dispatch('tabs.finalize', {
      browserId: 'chrome',
      keep: [],
    });

    expect(fixture.request).toHaveBeenCalledWith('tabs.close', { tabId: 22 });
  });

  it('syncs authoritative derived tabs without changing the selected tab', async () => {
    const fixture = await runtimeFixture();
    const selected = await createTab(fixture.runtime);
    fixture.derivedTabs.push(
      {
        providerTabId: 23,
        derivedFromProviderTabId: 22,
        title: 'Nested popup',
        url: 'https://example.com/nested-popup',
      },
      {
        providerTabId: 22,
        derivedFromProviderTabId: 17,
        title: 'Popup',
        url: 'https://example.com/popup',
      },
    );

    await expect(
      fixture.runtime.dispatch('tabs.list', { browserId: 'chrome' }),
    ).resolves.toHaveLength(3);
    await expect(
      fixture.runtime.dispatch('tabs.selected', { browserId: 'chrome' }),
    ).resolves.toMatchObject({ id: selected.id });
  });

  it('cleans up controlled tabs when the runtime closes', async () => {
    const created = await runtimeFixture();
    await createTab(created.runtime);
    await created.runtime.stop();
    expect(created.request).toHaveBeenCalledWith('tabs.close', { tabId: 17 });

    const claimed = await runtimeFixture();
    const candidates = (await claimed.runtime.dispatch(
      'browser.user.openTabs',
      { browserId: 'chrome' },
    )) as Array<{ id: string }>;
    await claimed.runtime.dispatch('browser.user.claimTab', {
      browserId: 'chrome',
      tab: candidates[0],
    });
    await claimed.runtime.stop();
    expect(claimed.request).toHaveBeenCalledWith('tabs.release', { tabId: 17 });

    const handoff = await runtimeFixture();
    const handoffTab = await createTab(handoff.runtime);
    await handoff.runtime.dispatch('tabs.finalize', {
      browserId: 'chrome',
      keep: [{ tabId: handoffTab.id, status: 'handoff' }],
    });
    await handoff.runtime.stop();
    expect(handoff.request).toHaveBeenCalledWith('tabs.close', { tabId: 17 });
  });

  it('preserves crashed tab ownership when detachment emits close', async () => {
    const fixture = await runtimeFixture();
    await createTab(fixture.runtime);
    for (const event of ['crash', 'close']) {
      const handler = fixture.page.on.mock.calls.find(
        ([name]) => name === event,
      )?.[1];
      expect(handler).toBeDefined();
      handler?.();
    }

    await fixture.runtime.stop();

    expect(fixture.request).toHaveBeenCalledWith('tabs.close', { tabId: 17 });
    expect(
      fixture.request.mock.calls.filter(([method]) => method === 'tabs.detach'),
    ).toEqual([['tabs.detach', { tabId: 17 }, 2_000]]);
  });

  it('closes derived tabs on stop without admitting new attachments', async () => {
    const fixture = await runtimeFixture();
    await createTab(fixture.runtime);
    fixture.derivedTabs.push(
      { providerTabId: 22, derivedFromProviderTabId: 17 },
      { providerTabId: 23, derivedFromProviderTabId: 22 },
    );

    await fixture.runtime.stop();

    for (const tabId of [17, 22, 23]) {
      expect(fixture.request).toHaveBeenCalledWith('tabs.close', { tabId });
    }
    expect(
      fixture.request.mock.calls.filter(([method]) => method === 'tabs.attach'),
    ).toEqual([['tabs.attach', { tabId: 17 }]]);
    expect(fixture.listenerCount()).toBe(0);
    expect(fixture.stopBridge).toHaveBeenCalledOnce();
  });

  it('retains authoritative popup ownership during shutdown', async () => {
    const fixture = await runtimeFixture();
    const candidates = (await fixture.runtime.dispatch(
      'browser.user.openTabs',
      {
        browserId: 'chrome',
      },
    )) as Array<{ id: string }>;
    await fixture.runtime.dispatch('browser.user.claimTab', {
      browserId: 'chrome',
      tab: candidates[0],
    });
    fixture.derivedTabs.push({ providerTabId: 17 });

    await fixture.runtime.stop();

    expect(fixture.request).toHaveBeenCalledWith('tabs.close', { tabId: 17 });
    expect(fixture.request).not.toHaveBeenCalledWith('tabs.release', {
      tabId: 17,
    });
  });

  it('validates every kept tab before finalization mutates Chrome', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);

    await expect(
      fixture.runtime.dispatch('tabs.finalize', {
        browserId: 'chrome',
        keep: [
          { tabId: tab.id, status: 'deliverable' },
          { tabId: tab.id, status: 'handoff' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(fixture.request).not.toHaveBeenCalledWith(
      'tabs.close',
      expect.anything(),
    );
    expect(fixture.request).not.toHaveBeenCalledWith(
      'tabs.release',
      expect.anything(),
    );
  });

  it('rejects an unknown kept tab id before finalization mutates Chrome', async () => {
    const fixture = await runtimeFixture();
    await createTab(fixture.runtime);

    await expect(
      fixture.runtime.dispatch('tabs.finalize', {
        browserId: 'chrome',
        keep: [{ tabId: 'tab-not-registered', status: 'deliverable' }],
      }),
    ).rejects.toMatchObject({ code: 'STALE_TAB' });
    expect(fixture.request).not.toHaveBeenCalledWith(
      'tabs.close',
      expect.anything(),
    );
    expect(fixture.request).not.toHaveBeenCalledWith(
      'tabs.release',
      expect.anything(),
    );
  });

  it('rejects a kept tab whose page already closed before finalization mutates Chrome', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    const closeHandler = fixture.page.on.mock.calls.find(
      ([name]) => name === 'close',
    )?.[1];
    expect(closeHandler).toBeDefined();
    closeHandler?.();

    await expect(
      fixture.runtime.dispatch('tabs.finalize', {
        browserId: 'chrome',
        keep: [{ tabId: tab.id, status: 'deliverable' }],
      }),
    ).rejects.toMatchObject({ code: 'STALE_TAB' });
    expect(fixture.request).not.toHaveBeenCalledWith(
      'tabs.close',
      expect.anything(),
    );
    expect(fixture.request).not.toHaveBeenCalledWith(
      'tabs.release',
      expect.anything(),
    );
  });

  it('rejects an invalid keep set without cleanup even when synchronization fails', async () => {
    const fixture = await runtimeFixture();
    const tab = await createTab(fixture.runtime);
    const request = fixture.request.getMockImplementation()!;
    fixture.request.mockImplementation(async (method, params = {}) => {
      if (method === 'tabs.queryDerived')
        throw new Error('Derived query failed');
      return await request(method, params);
    });

    await expect(
      fixture.runtime.dispatch('tabs.finalize', {
        browserId: 'chrome',
        keep: [
          { tabId: tab.id, status: 'deliverable' },
          { tabId: tab.id, status: 'handoff' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(fixture.request).not.toHaveBeenCalledWith(
      'tabs.close',
      expect.anything(),
    );
    expect(fixture.request).not.toHaveBeenCalledWith(
      'tabs.release',
      expect.anything(),
    );
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
  derivedTabs: Array<Record<string, unknown>>;
  openTabs: Array<Record<string, unknown>>;
  probeDetach: ReturnType<typeof vi.fn>;
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

function dialogEvent(
  method: 'Page.javascriptDialogOpening' | 'Page.javascriptDialogClosed',
  tabId = 17,
): BridgeEvent {
  return { type: 'event', tabId, method, params: {} };
}

function blockAttachProbe(
  fixture: RuntimeFixture,
  answer = (): Promise<unknown> => new Promise<never>(() => {}),
): void {
  // A dialog already open when the tab attaches is replayed by neither
  // Chrome nor Playwright, but the modal blocks the renderer — so the
  // attach probe's Runtime.evaluate never answers.
  const request = fixture.request.getMockImplementation()!;
  fixture.request.mockImplementation(
    (method: string, params: Record<string, unknown> = {}) =>
      method === 'cdp.send' && params.method === 'Runtime.evaluate'
        ? answer()
        : request(method, params),
  );
}

async function claimOpenTab(fixture: RuntimeFixture): Promise<TabInfo> {
  const [open] = (await fixture.runtime.dispatch('browser.user.openTabs', {
    browserId: 'chrome',
  })) as BrowserUserTabInfo[];
  return (await fixture.runtime.dispatch('browser.user.claimTab', {
    browserId: 'chrome',
    tab: open,
  })) as TabInfo;
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
  options: {
    unrelatedPage?: boolean;
    bridgeOverrides?: Partial<ChromeBridge>;
  } = {},
): Promise<RuntimeFixture> {
  const locator = fakeLocator();
  const typingState = {
    evaluate: vi.fn(async () => false),
    dispose: vi.fn(async () => undefined),
  };
  locator.methods.evaluateHandle.mockResolvedValue(typingState);
  const page = fakePage(locator.value);
  const popupPage = fakePage(locator.value, 'Popup');
  const unrelatedPage = options.unrelatedPage
    ? fakePage(locator.value, 'Unrelated popup')
    : undefined;
  const nestedPopupPage = fakePage(locator.value, 'Nested popup');
  const pageTargetIds = new Map<Page, string>([
    [page.value, 'target-17'],
    [popupPage.value, 'target-22'],
    [nestedPopupPage.value, 'target-23'],
  ]);
  if (unrelatedPage !== undefined)
    pageTargetIds.set(unrelatedPage.value, 'target-popup');
  // Registration probes each candidate page over its own CDP session; those
  // sessions never forward a command, so their release is recorded apart from
  // the operation session's detach.
  const probeDetach = vi.fn();
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
      for (const candidate of [
        unrelatedPage?.value,
        nestedPopupPage.value,
        popupPage.value,
        page.value,
      ]) {
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
          else probeDetach();
        },
      };
    }),
  } as unknown as BrowserContext;
  page.methods.context.mockReturnValue(context);
  popupPage.methods.context.mockReturnValue(context);
  nestedPopupPage.methods.context.mockReturnValue(context);
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
  const derivedTabs: Array<Record<string, unknown>> = [];
  const openTabs: Array<Record<string, unknown>> = [
    {
      providerTabId: 17,
      title: 'Fixture',
      url: 'https://example.com/',
    },
  ];
  const request = vi.fn(
    async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'tabs.create') {
        return {
          providerTabId: 17,
          title: 'Fixture',
          url: 'about:blank',
        };
      }
      if (method === 'tabs.queryOpen') return openTabs;
      if (method === 'tabs.queryDerived') return derivedTabs;
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
      if (method === 'tabs.get') {
        return (
          openTabs.find((tab) => tab['providerTabId'] === params.tabId) ?? {
            providerTabId: params.tabId,
            title: 'Fixture',
            url: 'https://example.com/',
          }
        );
      }
      if (method === 'cdp.send' && params.method === 'Target.getTargetInfo') {
        const tabId = params.tabId as number;
        return {
          targetInfo: {
            targetId: `target-${tabId}`,
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
    ...options.bridgeOverrides,
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
    derivedTabs,
    openTabs,
    probeDetach,
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
    evaluateAll: ReturnType<typeof vi.fn>;
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
    evaluateAll: vi.fn(async () => undefined),
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
    mainFrame: ReturnType<typeof vi.fn>;
    bringToFront: ReturnType<typeof vi.fn>;
    evaluate: ReturnType<typeof vi.fn>;
    title: ReturnType<typeof vi.fn>;
    isClosed: ReturnType<typeof vi.fn>;
    goto: ReturnType<typeof vi.fn>;
    goBack: ReturnType<typeof vi.fn>;
    goForward: ReturnType<typeof vi.fn>;
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
