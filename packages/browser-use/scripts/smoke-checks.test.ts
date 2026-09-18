/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { transformSync } from 'esbuild';
import { BrowserRuntimeError } from '../src/bridge/errors.js';
import { jpegDimensions } from '../src/playwright/runtime-helpers.js';

const preflight = readFileSync(
  new URL('./managed-chrome-preflight.ts', import.meta.url),
  'utf8',
);
const screenshotCheck = preflight.match(
  /const screenshotBytes =[\s\S]*?(?=\n\s*await runtime\.dispatch\('playwright\.evaluate')/,
)?.[0];
assert.ok(screenshotCheck, 'Preflight screenshot assertion must be exercised');

function validateScreenshot(bytes: Buffer, mimeType = 'image/jpeg'): void {
  runInNewContext(screenshotCheck!, {
    Buffer,
    assert,
    jpegDimensions,
    screenshot: { base64: bytes.toString('base64'), mimeType },
  });
}

describe('preflight screenshot validation', () => {
  // JPEG SOF dimensions, independently encoded for the required 100x50 clip.
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 50, 0, 100, 1, 1, 0x11, 0, 0xff, 0xd9,
  ]);

  it('accepts the JPEG clip returned by the screenshot contract', () => {
    expect(() => validateScreenshot(jpeg)).not.toThrow();
  });

  it('rejects the wrong decoded dimensions', () => {
    const oversized = Buffer.from(jpeg);
    oversized.writeUInt16BE(200, 9);
    expect(() => validateScreenshot(oversized)).toThrow();
  });

  it('rejects a mismatched MIME type', () => {
    expect(() => validateScreenshot(jpeg, 'image/png')).toThrow();
  });

  it('rejects a PNG header even with the expected IHDR dimensions', () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(100, 16);
    png.writeUInt32BE(50, 20);
    expect(() => validateScreenshot(png, 'image/png')).toThrow();
  });
});

describe('smoke observation claims', () => {
  const smoke = readFileSync(
    new URL('./smoke-qwen-saucedemo.ts', import.meta.url),
    'utf8',
  );
  const checks = smoke.match(/const checks = \{[\s\S]*?\n {4}\};/)?.[0];
  assert.ok(checks, 'Smoke checks must be exercised');
  const helperStart = smoke.indexOf('function stagedRuntimeImported(');
  const helperEnd = smoke.indexOf('\n}\n', helperStart) + 3;
  assert.ok(helperStart >= 0, 'stagedRuntimeImported must be exercised');
  const stagedRuntimeImported = runInNewContext(
    transformSync(smoke.slice(helperStart, helperEnd), {
      loader: 'ts',
      target: 'node22',
    }).code + '\nstagedRuntimeImported;',
    {},
  ) as (
    calls: Array<{ code: string; output: string }>,
    browserRuntimeRoot: string,
    builtinSkillRoot: string,
  ) => boolean;

  it.each([
    '// .type( .click( .finalize(',
    'nodeRepl.write(".type( .click( .finalize(");',
  ])('does not report SDK setup from unrelated action text: %s', (code) => {
    const result = runInNewContext(checks + '\nchecks;', {
      calls: [{ code, output: '' }],
      joinedCode: code,
      joinedOutput: 'Total: $36.69',
      browserRuntimeEntry: '/skill/runtime/index.js',
      browserRuntimeRoot: '/skill/runtime',
      builtinSkillRoot: '/skill',
      stagedRuntimeImported,
      events: [],
      browserModuleRoot: '/runtime/node_modules',
      successfulModuleRootRegistered: () => true,
      completion: {
        url: 'https://www.saucedemo.com/checkout-complete.html',
        snapshot: 'Thank you for your order!',
      },
      cartMatchesLowestThree: true,
      finalAnswer: '$36.69',
    }) as Record<string, boolean>;

    expect(result.browserSdkImported).toBe(false);
    expect(result.checkoutCompletionObserved).toBe(true);
    expect(result.reportedTotalIsExpected).toBe(true);
  });

  it.each([
    [
      'a literal entry path',
      "await (await import('/skill/runtime/index.js')).setupBrowserRuntime();",
      true,
    ],
    [
      'an entry built from the staged runtime directory',
      "const SKILL_BASE = '/skill/runtime';\nawait (await import(SKILL_BASE + '/index.js')).setupBrowserRuntime();",
      true,
    ],
    [
      'an entry built from the skill root',
      "const base = '/skill';\nglobalThis.SKILL_BASE = base;\nawait (await import(SKILL_BASE + '/runtime/index.js')).setupBrowserRuntime();",
      true,
    ],
    [
      'a runtime loaded from somewhere else',
      "await (await import('/elsewhere/runtime/index.js')).setupBrowserRuntime();",
      false,
    ],
    [
      'the skill root without setup',
      "import('/skill/runtime/index.js');",
      false,
    ],
    [
      'a staged import that threw and fell back to a foreign entry',
      "let sdk; try { sdk = await import('/skill/runtime/index.js'); } catch { sdk = await import('/repo/packages/browser-use/dist/index.js'); } await sdk.setupBrowserRuntime();",
      false,
    ],
    [
      'the setup export reached through an alias',
      "const { setupBrowserRuntime: setup } = await import('/skill/runtime/index.js');\nawait setup();",
      true,
    ],
    [
      'the skill root echoed in prose next to a foreign import',
      "// staged at /skill/runtime/index.js\nawait (await import('/elsewhere/index.js')).setupBrowserRuntime();",
      false,
    ],
  ])('reports SDK setup for %s', (_label, code, expected) => {
    const result = runInNewContext(checks + '\nchecks;', {
      calls: [{ code, output: '' }],
      joinedCode: code,
      joinedOutput: 'Total: $36.69',
      browserRuntimeEntry: '/skill/runtime/index.js',
      browserRuntimeRoot: '/skill/runtime',
      builtinSkillRoot: '/skill',
      stagedRuntimeImported,
      events: [],
      browserModuleRoot: '/runtime/node_modules',
      successfulModuleRootRegistered: () => true,
      completion: {
        url: 'https://www.saucedemo.com/checkout-complete.html',
        snapshot: 'Thank you for your order!',
      },
      cartMatchesLowestThree: true,
      finalAnswer: '$36.69',
    }) as Record<string, boolean>;
    expect(result.browserSdkImported).toBe(expected);
  });
});

describe('smoke price reads', () => {
  const smoke = readFileSync(
    new URL('./smoke-qwen-saucedemo.ts', import.meta.url),
    'utf8',
  );
  const start = smoke.indexOf('function pricesFromCall(');
  const end = smoke.indexOf('\n}\n', start) + 3;
  assert.ok(start >= 0 && end > start, 'pricesFromCall must be exercised');
  const pricesFromCall = runInNewContext(
    transformSync(smoke.slice(start, end), { loader: 'ts', target: 'node22' })
      .code + '\npricesFromCall;',
    {},
  ) as (
    calls: Array<{ code: string; output: string }>,
    selector: string,
    expectedCount: number,
    scope: 'inventory' | 'cart',
  ) => number[] | null;
  const inventory = {
    code: "tab.playwright.locator('.inventory_item_price').allTextContents()",
    output: "[ '$29.99', '$9.99', '$15.99', '$49.99', '$7.99', '$15.99' ]",
  };
  const cartConfirmed = {
    code: 'tab.url()',
    output: 'https://www.saucedemo.com/cart.html',
  };
  const cart = {
    code: "tab.playwright.locator('.cart_item .inventory_item_price').allTextContents()",
    output: "[ '$7.99', '$9.99', '$15.99' ]",
  };

  it('attributes reads to the inventory or the cart by the cart.html confirmation', () => {
    const calls = [inventory, cartConfirmed, cart];
    expect(
      pricesFromCall(calls, '.inventory_item_price', 6, 'inventory'),
    ).toEqual([29.99, 9.99, 15.99, 49.99, 7.99, 15.99]);
    expect(pricesFromCall(calls, '.inventory_item_price', 3, 'cart')).toEqual([
      7.99, 9.99, 15.99,
    ]);
  });

  it('reports no cart read without a cart.html confirmation, even for a three-price read', () => {
    // A run that only sorted the inventory "Price (low to high)" and read it
    // again printed three matching prices without ever visiting the cart.
    const sortedInventory = {
      code: "tab.playwright.locator('.inventory_item_price').allTextContents()",
      output: "[ '$7.99', '$9.99', '$15.99', '$15.99', '$29.99', '$49.99' ]",
    };
    expect(
      pricesFromCall(
        [inventory, sortedInventory],
        '.inventory_item_price',
        3,
        'cart',
      ),
    ).toBeNull();
    expect(
      pricesFromCall([inventory, cart], '.inventory_item_price', 3, 'cart'),
    ).toBeNull();
  });

  it('takes the leading prices when the same cell echoes a selection afterwards', () => {
    const inventoryWithEcho = {
      code: "const prices = await tab.playwright.locator('.inventory_item_price').allTextContents(); nodeRepl.write(JSON.stringify(prices)); nodeRepl.write(JSON.stringify(prices.slice(0, 3)));",
      output:
        '["$29.99","$9.99","$15.99","$49.99","$7.99","$15.99"]["$7.99","$9.99","$15.99"]',
    };
    expect(
      pricesFromCall(
        [inventoryWithEcho],
        '.inventory_item_price',
        6,
        'inventory',
      ),
    ).toEqual([29.99, 9.99, 15.99, 49.99, 7.99, 15.99]);
    // An inventory echo is never a cart read.
    expect(
      pricesFromCall([inventoryWithEcho], '.inventory_item_price', 3, 'cart'),
    ).toBeNull();
    const cartWithEcho = {
      code: "const cartPrices = await tab.playwright.locator('.inventory_item_price').allTextContents(); nodeRepl.write(JSON.stringify(cartPrices)); nodeRepl.write('subtotal $33.97');",
      output: '["$7.99","$9.99","$15.99"] subtotal $33.97',
    };
    expect(
      pricesFromCall(
        [inventoryWithEcho, cartConfirmed, cartWithEcho],
        '.inventory_item_price',
        3,
        'cart',
      ),
    ).toEqual([7.99, 9.99, 15.99]);
  });

  it('ignores reads that did not use allTextContents on the price class', () => {
    const innerText = {
      code: "tab.playwright.locator('.inventory_item_price').first().innerText()",
      output: '$29.99 $9.99 $15.99 $49.99 $7.99 $15.99',
    };
    expect(
      pricesFromCall([innerText], '.inventory_item_price', 6, 'inventory'),
    ).toBeNull();
    expect(
      pricesFromCall(
        [cartConfirmed, innerText],
        '.inventory_item_price',
        3,
        'cart',
      ),
    ).toBeNull();
  });
});

describe('smoke completion verification', () => {
  const smoke = readFileSync(
    new URL('./smoke-qwen-saucedemo.ts', import.meta.url),
    'utf8',
  );
  const helperStart = smoke.indexOf('async function verifySauceCompletion(');
  assert.ok(helperStart >= 0, 'Smoke verification helpers must be exercised');
  const helpers = transformSync(smoke.slice(helperStart), {
    loader: 'ts',
    target: 'node22',
  }).code;

  it('starts the bridge before ping and allows the reconnect alarm', async () => {
    let started = false;
    const stop = vi.fn(async () => undefined);
    const request = vi.fn(async (...args: unknown[]) => {
      expect(started).toBe(true);
      expect(args[0]).toBe('ping');
      expect((args[2] as number | undefined) ?? 35_000).toBeGreaterThanOrEqual(
        35_000,
      );
    });
    class Bridge {
      async start() {
        await Promise.resolve();
        started = true;
      }
      request = request;
    }
    class Runtime {
      browserId = 'chrome';
      stop = stop;
      async dispatch(method: string) {
        if (method === 'browser.user.openTabs') {
          return [{ url: 'https://www.saucedemo.com/checkout-complete.html' }];
        }
        if (method === 'browser.user.claimTab') return { id: 'completion' };
        return 'completed';
      }
    }
    const result = runInNewContext(
      helpers + '\nverifySauceCompletion("unused.socket");',
      {
        ChromeExtensionTransport: Bridge,
        PlaywrightRuntime: Runtime,
        isRecord: (value: unknown) =>
          value !== null && typeof value === 'object',
        Error,
        Date,
        setTimeout,
      },
    );

    await expect(result).resolves.toEqual({
      url: 'completed',
      snapshot: 'completed',
    });
    expect(request).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each(['TAB_DEBUGGER_CONFLICT', 'STALE_TAB'] as const)(
    'only retries a previous debugger attachment: %s',
    async (code) => {
      const error = new BrowserRuntimeError(code, 'Controlled claim failure');
      const dispatch = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValue({ id: 'completion' });
      const result = runInNewContext(
        helpers + '\nclaimAfterPreviousSessionExits(runtime, {});',
        { runtime: { browserId: 'chrome', dispatch }, Error, Date, setTimeout },
      );
      if (code === 'TAB_DEBUGGER_CONFLICT') {
        await expect(result).resolves.toEqual({ id: 'completion' });
        expect(dispatch).toHaveBeenCalledTimes(3);
      } else {
        await expect(result).rejects.toBe(error);
        expect(dispatch).toHaveBeenCalledOnce();
      }
    },
  );
});
