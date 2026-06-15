/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { browseDaemons, type BonjourBrowserLike } from './browser.js';
import type { RawBrowseService } from './advert.js';

function fakeBonjour(services: RawBrowseService[]) {
  const calls = { find: 0, stop: 0, destroy: 0 };
  const bonjour: BonjourBrowserLike = {
    find: (opts, onUp) => {
      calls.find++;
      expect(opts.type).toBe('qwen-rc');
      // Emit all known services synchronously via the callback.
      for (const s of services) onUp?.(s);
      return {
        on: () => {},
        stop: () => {
          calls.stop++;
        },
      };
    },
    destroy: () => {
      calls.destroy++;
    },
  };
  return { bonjour, calls };
}

const svc = (over: Partial<RawBrowseService> = {}): RawBrowseService => {
  const name = over.name ?? 'kitchen-app';
  return {
    name,
    host: 'kitchen.local',
    port: 7070,
    txt: { version: '1', name, workspace: 'app', tlsRequired: 'true' },
    ...over,
  };
};

describe('browseDaemons', () => {
  it('collects, normalizes, dedupes and sorts within the timeout', async () => {
    const fb = fakeBonjour([
      svc({ name: 'z', host: 'z.local', port: 2 }),
      svc({ name: 'a', host: 'a.local', port: 9 }),
      svc({ name: 'z', host: 'z.local', port: 5 }), // dup name → latest wins
    ]);
    const records = await browseDaemons({
      factory: () => fb.bonjour,
      timeoutMs: 10,
      wait: () => Promise.resolve(),
    });
    expect(records.map((r) => r.name)).toEqual(['a', 'z']);
    expect(records.find((r) => r.name === 'z')?.port).toBe(5);
    expect(fb.calls.find).toBe(1);
    expect(fb.calls.destroy).toBe(1); // socket torn down after the window
  });

  it('returns [] and still tears down when nothing advertises', async () => {
    const fb = fakeBonjour([]);
    const records = await browseDaemons({
      factory: () => fb.bonjour,
      timeoutMs: 5,
      wait: () => Promise.resolve(),
    });
    expect(records).toEqual([]);
    expect(fb.calls.destroy).toBe(1);
  });

  it('drops services with no usable host', async () => {
    const fb = fakeBonjour([
      svc({ name: 'ok' }),
      svc({ name: 'bad', host: undefined, addresses: [] }),
    ]);
    const records = await browseDaemons({
      factory: () => fb.bonjour,
      timeoutMs: 5,
      wait: () => Promise.resolve(),
    });
    expect(records.map((r) => r.name)).toEqual(['ok']);
  });
});
