/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApnsStore } from './apnsStore.js';

describe('ApnsStore', () => {
  let dir: string;
  let path: string;
  let clock: number;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rc-apns-'));
    path = join(dir, 'apns.json');
    clock = 1000;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const open = () => ApnsStore.open(path, () => clock);

  it('registers a subscription and returns it with an id', async () => {
    const store = await open();
    const rec = await store.register({
      tokenId: 'tkn_a',
      deviceToken: 'dead beef'.replace(' ', ''),
      bundleId: 'dev.qwen.rc',
      shellVersion: '1.0.0',
    });
    expect(rec.id).toMatch(/[0-9a-f]+/);
    expect(rec).toMatchObject({
      tokenId: 'tkn_a',
      deviceToken: 'deadbeef',
      bundleId: 'dev.qwen.rc',
      shellVersion: '1.0.0',
      createdAt: 1000,
      lastSeenAt: 1000,
    });
  });

  it('is unique on (tokenId, deviceToken): re-register updates lastSeenAt, no duplicate', async () => {
    const store = await open();
    const first = await store.register({
      tokenId: 'tkn_a',
      deviceToken: 'dt1',
      bundleId: 'b',
      shellVersion: '1.0.0',
    });
    clock = 5000;
    const second = await store.register({
      tokenId: 'tkn_a',
      deviceToken: 'dt1',
      bundleId: 'b',
      shellVersion: '1.1.0',
    });
    expect(second.id).toBe(first.id); // same row
    expect(second.lastSeenAt).toBe(5000);
    expect(second.shellVersion).toBe('1.1.0'); // refreshed
    expect(store.listAll()).toHaveLength(1);
  });

  it('treats the same deviceToken under a different token as a separate row', async () => {
    const store = await open();
    await store.register({
      tokenId: 'tkn_a',
      deviceToken: 'dt1',
      bundleId: 'b',
      shellVersion: '1',
    });
    await store.register({
      tokenId: 'tkn_b',
      deviceToken: 'dt1',
      bundleId: 'b',
      shellVersion: '1',
    });
    expect(store.listAll()).toHaveLength(2);
  });

  it('remove(id) deletes one row; returns false when absent', async () => {
    const store = await open();
    const rec = await store.register({
      tokenId: 't',
      deviceToken: 'dt',
      bundleId: 'b',
      shellVersion: '1',
    });
    expect(await store.remove('nope')).toBe(false);
    expect(await store.remove(rec.id)).toBe(true);
    expect(store.listAll()).toHaveLength(0);
  });

  it('removeByToken cascades all of a token id and reports the count', async () => {
    const store = await open();
    await store.register({
      tokenId: 'victim',
      deviceToken: 'd1',
      bundleId: 'b',
      shellVersion: '1',
    });
    await store.register({
      tokenId: 'victim',
      deviceToken: 'd2',
      bundleId: 'b',
      shellVersion: '1',
    });
    await store.register({
      tokenId: 'other',
      deviceToken: 'd3',
      bundleId: 'b',
      shellVersion: '1',
    });
    expect(await store.removeByToken('victim')).toBe(2);
    expect(store.listAll().map((r) => r.tokenId)).toEqual(['other']);
    expect(await store.removeByToken('victim')).toBe(0); // idempotent
  });

  it('persists across reopen and stores at mode 0600', async () => {
    const store = await open();
    await store.register({
      tokenId: 't',
      deviceToken: 'dt',
      bundleId: 'b',
      shellVersion: '1',
    });
    const reopened = await ApnsStore.open(path, () => clock);
    expect(reopened.listAll()).toHaveLength(1);
    // 0600 (owner read/write only)
    const { statSync } = await import('node:fs');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toContain('deviceToken');
  });

  it('listForToken filters by token id', async () => {
    const store = await open();
    await store.register({
      tokenId: 'a',
      deviceToken: 'd1',
      bundleId: 'b',
      shellVersion: '1',
    });
    await store.register({
      tokenId: 'b',
      deviceToken: 'd2',
      bundleId: 'b',
      shellVersion: '1',
    });
    expect(store.listForToken('a').map((r) => r.deviceToken)).toEqual(['d1']);
  });
});
