/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  HttpAntiResurrectionLedger,
  InMemoryAntiResurrectionLedger,
  LedgerKeyFactory,
} from './anti-resurrection-ledger.js';

describe('InMemoryAntiResurrectionLedger', () => {
  it('never refreshes or resurrects a raw event receipt', async () => {
    const ledger = new InMemoryAntiResurrectionLedger(
      new LedgerKeyFactory(randomBytes(32)),
    );
    const receivedAt = new Date('2026-07-22T00:00:00.000Z');
    const purgeAt = new Date('2026-07-23T00:00:00.000Z');
    const first = await ledger.ensureRawReceipt(
      'tenant-a',
      'event-a',
      receivedAt,
      purgeAt,
    );

    const retry = await ledger.ensureRawReceipt(
      'tenant-a',
      'event-a',
      new Date('2026-07-22T12:00:00.000Z'),
      new Date('2026-07-23T12:00:00.000Z'),
    );
    expect(retry).toEqual(first);

    await ledger.markRawPurged('tenant-a', 'event-a');
    const afterPurge = await ledger.ensureRawReceipt(
      'tenant-a',
      'event-a',
      receivedAt,
      purgeAt,
    );
    expect(afterPurge.state).toBe('purged');
    expect(afterPurge.purgeAt).toEqual(purgeAt);
  });

  it('keeps deletion state monotonic and tenant scoped', async () => {
    const ledger = new InMemoryAntiResurrectionLedger(
      new LedgerKeyFactory(randomBytes(32)),
    );
    const createdAt = new Date('2026-07-22T00:00:00.000Z');
    const first = await ledger.beginDeletion(
      'tenant-a',
      'memory-a',
      2,
      'repository',
      'user_request',
      createdAt,
    );
    await ledger.markErased('tenant-a', 'memory-a', 2);
    await expect(
      ledger.beginDeletion(
        'tenant-a',
        'memory-a',
        2,
        'repository',
        'maintainer_request',
        new Date('2026-07-23T00:00:00.000Z'),
      ),
    ).rejects.toThrow('binding conflict');
    expect(await ledger.getDeletion('tenant-a', 'memory-a', 2)).toMatchObject({
      key: first.key,
      reason: 'user_request',
      state: 'erased',
      createdAt,
    });
    expect(await ledger.getDeletion('tenant-b', 'memory-a', 2)).toBeNull();
  });
});

describe('HttpAntiResurrectionLedger', () => {
  it('rejects non-string timestamps from an untrusted ledger response', async () => {
    const ledger = new HttpAntiResurrectionLedger({
      baseUrl: 'https://ledger.example.test',
      bearerToken: 'test-token',
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            key: 'receipt-a',
            received_at: null,
            purge_at: '2026-07-23T00:00:00.000Z',
            state: 'received',
          }),
          { status: 200 },
        ),
    });

    await expect(ledger.getRawReceipt('tenant-a', 'event-a')).rejects.toThrow(
      'invalid raw receipt',
    );
  });
});
