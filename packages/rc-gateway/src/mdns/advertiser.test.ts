/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MdnsAdvertiser,
  MDNS_UNAVAILABLE_KEYWORD,
  type BonjourLike,
} from './advertiser.js';
import { buildTxtRecord } from './advert.js';

function fakeBonjour() {
  const calls = {
    publish: [] as unknown[],
    unpublishAll: 0,
    destroy: 0,
  };
  let unpublishCb: (() => void) | undefined;
  const bonjour: BonjourLike = {
    publish: (opts) => {
      calls.publish.push(opts);
      return { stop: () => {} };
    },
    unpublishAll: (cb) => {
      calls.unpublishAll++;
      unpublishCb = cb;
    },
    destroy: () => {
      calls.destroy++;
    },
  };
  return { bonjour, calls, fireUnpublish: () => unpublishCb?.() };
}

const TXT = buildTxtRecord({
  name: 'kitchen-app',
  workspace: 'app',
  tlsRequired: true,
});

describe('MdnsAdvertiser', () => {
  it('publishes once with the DNS-SD service type and a txt copy', () => {
    const fb = fakeBonjour();
    const a = new MdnsAdvertiser({
      instanceName: 'kitchen-app',
      port: 7070,
      txt: TXT,
      factory: () => fb.bonjour,
    });
    a.start();
    expect(a.advertising).toBe(true);
    expect(a.instanceName).toBe('kitchen-app');
    expect(fb.calls.publish).toHaveLength(1);
    expect(fb.calls.publish[0]).toMatchObject({
      name: 'kitchen-app',
      type: 'qwen-rc',
      port: 7070,
      txt: { version: '1', tlsRequired: 'true' },
    });
  });

  it('Goodbye: stop() unpublishes then destroys, resolving when the callback fires', async () => {
    const fb = fakeBonjour();
    const a = new MdnsAdvertiser({
      instanceName: 'n',
      port: 1,
      txt: TXT,
      factory: () => fb.bonjour,
    });
    a.start();
    const p = a.stop(500);
    fb.fireUnpublish(); // bonjour signals Goodbye packets sent
    await p;
    expect(fb.calls.unpublishAll).toBe(1);
    expect(fb.calls.destroy).toBe(1);
    expect(a.advertising).toBe(false);
  });

  it('stop() resolves on the timeout even if unpublish never calls back', async () => {
    vi.useFakeTimers();
    try {
      const fb = fakeBonjour();
      const a = new MdnsAdvertiser({
        instanceName: 'n',
        port: 1,
        txt: TXT,
        factory: () => fb.bonjour,
      });
      a.start();
      const p = a.stop(500);
      await vi.advanceTimersByTimeAsync(500);
      await p;
      expect(fb.calls.destroy).toBe(1); // destroyed after the bounded wait
    } finally {
      vi.useRealTimers();
    }
  });

  it('MDNS_UNAVAILABLE_KEYWORD is exactly "mdns_unavailable"', () => {
    expect(MDNS_UNAVAILABLE_KEYWORD).toBe('mdns_unavailable');
  });

  it('stop() is a no-op when never started, and idempotent', async () => {
    const fb = fakeBonjour();
    const a = new MdnsAdvertiser({
      instanceName: 'n',
      port: 1,
      txt: TXT,
      factory: () => fb.bonjour,
    });
    await a.stop(); // never started
    expect(fb.calls.destroy).toBe(0);
    a.start();
    await a.stop(0);
    await a.stop(0); // second stop does nothing
    expect(fb.calls.destroy).toBe(1);
  });
});
