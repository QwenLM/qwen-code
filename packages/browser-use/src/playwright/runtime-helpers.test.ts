/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Page } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandSchemas } from '../core/schemas.js';
import {
  orderOpenTabs,
  pressKeyChord,
  providerTab,
  selectOptions,
  withModifiers,
  withTimeout,
} from './runtime-helpers.js';
import type { ProviderTab } from './runtime-state.js';

describe('provider tabs', () => {
  it('clamps title and url so a discovered tab round-trips through claimTab', () => {
    const tab = providerTab({
      providerTabId: 7,
      title: 't'.repeat(20_001),
      url: `https://app.example/?state=${'a'.repeat(20_001)}`,
    });
    expect(tab.title).toHaveLength(20_000);
    expect(tab.url).toHaveLength(20_000);
    expect(
      commandSchemas['browser.user.claimTab'].safeParse({
        browserId: 'chrome',
        tab: { id: 'open-1', title: tab.title, url: tab.url },
      }).success,
    ).toBe(true);
  });

  it('lists only http(s) tabs, most recently opened first', () => {
    const tabs: ProviderTab[] = [
      {
        providerTabId: 1,
        title: 'Gmail',
        url: 'https://mail.example/a',
        lastOpened: '2026-09-01T00:00:00.000Z',
      },
      { providerTabId: 2, title: 'Gmail', url: 'https://mail.example/b' },
      {
        providerTabId: 3,
        title: 'Gmail',
        url: 'https://mail.example/c',
        lastOpened: '2026-09-07T00:00:00.000Z',
      },
      {
        providerTabId: 4,
        title: 'credentials',
        url: 'file:///Users/x/.aws/credentials',
        lastOpened: '2026-09-08T00:00:00.000Z',
      },
      {
        providerTabId: 5,
        title: null,
        url: null,
        lastOpened: '2026-09-01T00:00:00.000Z',
      },
      {
        providerTabId: 6,
        title: 'Docs',
        url: 'http://docs.example/',
        lastOpened: 'yesterday',
      },
    ];
    expect(orderOpenTabs(tabs).map((tab) => tab.providerTabId)).toEqual([
      3, 1, 5, 2, 6,
    ]);
    expect(tabs.map((tab) => tab.providerTabId)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('evaluation deadlines', () => {
  afterEach(() => vi.useRealTimers());

  it('rejects an unresolved evaluation when its deadline expires', async () => {
    vi.useFakeTimers();
    const result = withTimeout(new Promise(() => {}), 100).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves early results and errors and clears their timers', async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve(42), 100)).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
    const failure = new Error('script failed');
    await expect(withTimeout(Promise.reject(failure), 100)).rejects.toBe(
      failure,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

function fixture() {
  const keyboard = {
    down: vi.fn(async (_key: string) => undefined),
    up: vi.fn(async (_key: string) => undefined),
  };
  return { keyboard, page: { keyboard } as unknown as Page };
}

describe('modifier cleanup', () => {
  it('releases all attempted keys when keydown fails', async () => {
    const { page, keyboard } = fixture();
    const failure = new Error('keydown failed');
    keyboard.down.mockRejectedValueOnce(failure);
    await expect(
      withModifiers(page, ['Control', 'Shift'], vi.fn()),
    ).rejects.toBe(failure);
    expect(keyboard.up).toHaveBeenCalledExactlyOnceWith('Control');
  });

  it('continues releases after keyup fails and preserves the action error', async () => {
    const { page, keyboard } = fixture();
    const failure = new Error('action failed');
    keyboard.up.mockRejectedValueOnce(new Error('keyup failed'));
    await expect(
      withModifiers(page, ['Control', 'Shift'], async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(keyboard.up.mock.calls).toEqual([['Shift'], ['Control']]);
  });

  it('does not rewrite a completed action into a failure when a release fails', async () => {
    const { page, keyboard } = fixture();
    keyboard.up.mockRejectedValueOnce(new Error('keyup failed'));
    await expect(
      withModifiers(page, ['Control', 'Shift'], async () => undefined),
    ).resolves.toBeUndefined();
    expect(keyboard.up.mock.calls).toEqual([['Shift'], ['Control']]);
  });
});

describe('key chord press', () => {
  it('releases every modifier when a chord token is rejected', async () => {
    const keyboard = {
      up: vi.fn(async (_key: string) => undefined),
      press: vi.fn(async (_chord: string) => {
        throw new Error('Unknown key: "Bogus"');
      }),
    };
    const page = { keyboard } as unknown as Page;
    await expect(pressKeyChord(page, ['Control', 'Bogus'])).rejects.toThrow(
      'Unknown key',
    );
    expect(keyboard.press).toHaveBeenCalledExactlyOnceWith('Control+Bogus');
    expect(keyboard.up.mock.calls).toEqual([['Bogus'], ['Control']]);
  });

  it('releases a held non-modifier token when a later chord token is rejected', async () => {
    const keyboard = {
      up: vi.fn(async (_key: string) => undefined),
      press: vi.fn(async (_chord: string) => {
        throw new Error('Unknown key: "Bogus"');
      }),
    };
    const page = { keyboard } as unknown as Page;
    await expect(
      pressKeyChord(page, ['Control', 'a', 'Bogus']),
    ).rejects.toThrow('Unknown key');
    expect(keyboard.up.mock.calls).toEqual([['Bogus'], ['a'], ['Control']]);
  });

  it('releases the tokens Playwright derives when one element embeds a separator', async () => {
    const keyboard = {
      up: vi.fn(async (_key: string) => undefined),
      press: vi.fn(async (_chord: string) => {
        throw new Error('Unknown key: "Del"');
      }),
    };
    const page = { keyboard } as unknown as Page;
    await expect(pressKeyChord(page, ['Control+Alt+Del'])).rejects.toThrow(
      'Unknown key',
    );
    expect(keyboard.press).toHaveBeenCalledExactlyOnceWith('Control+Alt+Del');
    expect(keyboard.up.mock.calls).toEqual([['Del'], ['Alt'], ['Control']]);
  });

  it('treats a standalone separator as the literal plus key, as Playwright does', async () => {
    const keyboard = {
      up: vi.fn(async (_key: string) => undefined),
      press: vi.fn(async (_chord: string) => {
        throw new Error('Unknown key: "Bogus"');
      }),
    };
    const page = { keyboard } as unknown as Page;
    await expect(
      pressKeyChord(page, ['Control', '+', 'Bogus']),
    ).rejects.toThrow('Unknown key');
    expect(keyboard.press).toHaveBeenCalledExactlyOnceWith('Control+++Bogus');
    expect(keyboard.up.mock.calls).toEqual([['Bogus'], ['+'], ['Control']]);
  });

  it('leaves the keyboard untouched after a successful chord', async () => {
    const keyboard = {
      up: vi.fn(async (_key: string) => undefined),
      press: vi.fn(async (_chord: string) => undefined),
    };
    const page = { keyboard } as unknown as Page;
    await pressKeyChord(page, ['Control', 'a']);
    expect(keyboard.press).toHaveBeenCalledExactlyOnceWith('Control+a');
    expect(keyboard.up).not.toHaveBeenCalled();
  });
});

describe('select option values', () => {
  it('normalizes a mixed string/descriptor array for Playwright', () => {
    expect(selectOptions(['a', { label: 'B' }])).toEqual([
      { value: 'a' },
      { label: 'B' },
    ]);
  });

  it('keeps homogeneous arrays in their compact form', () => {
    expect(selectOptions(['a', 'b'])).toEqual(['a', 'b']);
    expect(selectOptions([{ value: 'a' }, { index: 2 }])).toEqual([
      { value: 'a' },
      { index: 2 },
    ]);
    expect(selectOptions('a')).toBe('a');
    expect(selectOptions({ index: 2 })).toEqual({ index: 2 });
  });
});
