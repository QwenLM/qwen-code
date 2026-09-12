/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import vm from 'node:vm';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { serializeJson } from '../core/serialize-json.js';
import type { BrowserSdkContext } from './context.js';
import { TabProxy } from './tab.js';
import type { BrowserTab, JsonSerializable } from './types.js';

function fixture() {
  const document = { title: 'Fixture', calls: 0 };
  const realm = vm.createContext({
    document,
    element: { tagName: 'BODY' },
    elements: [{ tagName: 'DIV' }, { tagName: 'DIV' }],
  });
  const context = {
    // Mirror the production pipeline: the completion value is ??-ed to null,
    // serialized in the page, and parsed back here.
    call: vi.fn(async (_method: string, args: { script: string }) => {
      const value = await (vm.runInContext(
        `(async () => {\n${args.script}\n})()`,
        realm,
      ) as Promise<unknown>);
      return JSON.parse(serializeJson(value ?? null)) as unknown;
    }),
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
        ? f.page.evaluate(source, arg as never)
        : mode === 'one'
          ? f.locator.evaluate(source, arg as never)
          : f.locator.evaluateAll(source, arg as never);
    };

    it.each([
      NaN,
      Infinity,
      { value: -Infinity },
      { value: undefined },
      new Date(0),
      /pattern/,
      new Map(),
      [1, undefined],
      { value: () => 1 },
    ])('rejects non-JSON arguments before dispatch (%j)', (arg) => {
      expect(() => evaluate('arg', arg)).toThrow('must be JSON-serializable');
    });

    it('preserves JSON object keys without creating an argument prototype', async () => {
      const arg = JSON.parse('{"__proto__":{"polluted":true},"answer":42}');
      await expect(evaluate('Object.keys(arg).sort()', arg)).resolves.toEqual([
        '__proto__',
        'answer',
      ]);
      await expect(evaluate('arg.polluted === undefined', arg)).resolves.toBe(
        true,
      );
    });

    it.each<[string, unknown]>([
      ['document.title', 'Fixture'],
      ['document.title;', 'Fixture'],
      ['document.title // comment', 'Fixture'],
      ['var x = 1;\nx + 1;', 2],
      [' ', null],
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
          ? f.page.evaluate(source)
          : mode === 'one'
            ? f.locator.evaluate(source)
            : f.locator.evaluateAll(source);
      await expect(result).rejects.toThrow('Value must be JSON-serializable');
      expect(f.document.calls).toBe(0);
    });
  },
);

it('publishes JSON types and distinguishes undefined from void results', () => {
  const check = (tab: BrowserTab) => {
    const locator = tab.playwright.locator('button');
    // @ts-expect-error Date is not a JSON result.
    void tab.playwright.evaluate<Date>(() => new Date());
    // @ts-expect-error Inferred Date results must also be rejected.
    void locator.evaluate(() => new Date());
    // @ts-expect-error Nested Date results are not JSON data.
    void locator.evaluateAll(() => ({ date: new Date() }));
    // @ts-expect-error Date arguments must be rejected.
    void tab.playwright.evaluate(() => 1, new Date());
    expectTypeOf(tab.playwright.evaluate(() => undefined)).toEqualTypeOf<
      Promise<null>
    >();
    const discarded: () => void = () => 42;
    expectTypeOf(tab.playwright.evaluate(discarded)).toEqualTypeOf<
      Promise<JsonSerializable>
    >();
    expectTypeOf(locator.evaluate(async () => ({ value: 1 }))).toEqualTypeOf<
      Promise<{ value: number }>
    >();
    expectTypeOf(locator.evaluateAll(() => [1, 'two'] as const)).toEqualTypeOf<
      Promise<readonly [1, 'two']>
    >();
  };
  expectTypeOf(check).toBeFunction();
});

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
