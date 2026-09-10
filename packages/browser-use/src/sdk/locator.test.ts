/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

import type { BrowserSdkContext } from './context.js';
import { TabProxy } from './tab.js';

function fixture() {
  const document = { title: 'Fixture', calls: 0 };
  const realm = vm.createContext({
    document,
    element: { tagName: 'BODY' },
    elements: [{ tagName: 'DIV' }, { tagName: 'DIV' }],
  });
  const context = {
    call: vi.fn(
      async (_method: string, args: { script: string }) =>
        await (vm.runInContext(
          `(async () => {\n${args.script}\n})()`,
          realm,
        ) as Promise<unknown>),
    ),
  } as unknown as BrowserSdkContext;
  const tab = new TabProxy(context, 'chrome', {
    id: 'tab-1',
    title: null,
    url: null,
  });
  return {
    document,
    page: tab.playwright,
    locator: tab.playwright.locator('div'),
  };
}

describe.each(['page', 'one', 'all'] as const)(
  '%s evaluation scripts',
  (mode) => {
    const evaluate = (source: string, arg?: unknown) => {
      const f = fixture();
      return mode === 'page'
        ? f.page.evaluate(source, arg)
        : mode === 'one'
          ? f.locator.evaluate(source, arg)
          : f.locator.evaluateAll(source, arg);
    };

    it.each<[string, unknown]>([
      ['document.title', 'Fixture'],
      ['document.title;', 'Fixture'],
      ['document.title // comment', 'Fixture'],
      ['var x = 1;\nx + 1;', 2],
      [' ', undefined],
      ['Promise.resolve(3);', 3],
      ['({ answer: 42 });', { answer: 42 }],
      [
        JSON.stringify('quoted "text"\nwith \\slashes'),
        'quoted "text"\nwith \\slashes',
      ],
    ])('returns the completion value of %s', async (source, expected) => {
      await expect(evaluate(source)).resolves.toEqual(expected);
    });

    it('preserves lexical argument and element access', async () => {
      const source =
        mode === 'page'
          ? 'arg.value;'
          : mode === 'one'
            ? 'element.tagName + arg.value;'
            : 'elements.length + arg.value;';
      await expect(evaluate(source, { value: 3 })).resolves.toBe(
        mode === 'page' ? 3 : mode === 'one' ? 'BODY3' : 5,
      );
    });

    it('does not invoke a function-valued string', async () => {
      const f = fixture();
      const source = '() => { document.calls++; return 7; }';
      const result =
        mode === 'page'
          ? await f.page.evaluate(source)
          : mode === 'one'
            ? await f.locator.evaluate(source)
            : await f.locator.evaluateAll(source);
      expect(typeof result).toBe('function');
      expect(f.document.calls).toBe(0);
    });
  },
);

it('preserves synchronous and asynchronous function arguments', async () => {
  const f = fixture();
  await expect(
    f.page.evaluate((arg) => arg.value + 1, { value: 2 }),
  ).resolves.toBe(3);
  await expect(
    f.locator.evaluate((element, arg) => element.tagName + arg, 3),
  ).resolves.toBe('BODY3');
  await expect(
    f.locator.evaluateAll(
      async (elements, arg) => elements.length + (await Promise.resolve(arg)),
      3,
    ),
  ).resolves.toBe(5);
});
