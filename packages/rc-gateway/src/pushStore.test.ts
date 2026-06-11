/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PushStore } from './pushStore.js';

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'rc-push-')), 'push.json');
}

const SUB_A = { endpoint: 'https://push/1', keys: { p256dh: 'p', auth: 'a' } };

describe('PushStore', () => {
  it('adds a record bound to a token id', async () => {
    const store = await PushStore.open(tempPath());
    const rec = await store.add('tokA', SUB_A);
    expect(rec.id).toMatch(/^[0-9a-f]+$/);
    expect(rec.tokenId).toBe('tokA');
    expect(typeof rec.createdAt).toBe('number');
    expect(store.listFor('tokA')).toHaveLength(1);
  });

  it('de-dups by (tokenId, endpoint) returning the same record', async () => {
    const store = await PushStore.open(tempPath());
    const first = await store.add('tokA', SUB_A);
    const again = await store.add('tokA', SUB_A);
    expect(again.id).toBe(first.id);
    expect(store.listFor('tokA')).toHaveLength(1);
  });

  it('treats the same endpoint under a different token as distinct', async () => {
    const store = await PushStore.open(tempPath());
    const a = await store.add('tokA', SUB_A);
    const b = await store.add('tokB', SUB_A);
    expect(b.id).not.toBe(a.id);
    expect(store.listAll()).toHaveLength(2);
    expect(store.listFor('tokB')).toHaveLength(1);
  });

  it('gets, removes (idempotently), and persists across reopen', async () => {
    const path = tempPath();
    const store = await PushStore.open(path);
    const rec = await store.add('tokA', SUB_A);

    expect(store.get(rec.id)).toBeDefined();
    expect(await store.remove(rec.id)).toBe(true);
    expect(await store.remove(rec.id)).toBe(false);

    const reopened = await PushStore.open(path);
    expect(reopened.get(rec.id)).toBeUndefined();
    expect(reopened.listAll()).toHaveLength(0);
  });

  it('setPrefs sets, clears (removes the field), reports missing, and persists', async () => {
    const path = tempPath();
    const store = await PushStore.open(path);
    const rec = await store.add('tokA', SUB_A);

    expect(await store.setPrefs(rec.id, ['task.completed'])).toBe(true);
    expect(store.get(rec.id)!.prefs).toEqual(['task.completed']);

    // Persists across reopen.
    const reopened = await PushStore.open(path);
    expect(reopened.get(rec.id)!.prefs).toEqual(['task.completed']);

    // undefined removes the field (record reads "receive all").
    expect(await store.setPrefs(rec.id, undefined)).toBe(true);
    expect('prefs' in store.get(rec.id)!).toBe(false);
    const reopened2 = await PushStore.open(path);
    expect('prefs' in reopened2.get(rec.id)!).toBe(false);

    // Empty array is preserved (explicit "receive nothing").
    expect(await store.setPrefs(rec.id, [])).toBe(true);
    expect(store.get(rec.id)!.prefs).toEqual([]);

    // Missing id → false.
    expect(await store.setPrefs('missing', ['x'])).toBe(false);
  });

  it('setPrefs stores a copy, not the caller reference', async () => {
    const store = await PushStore.open(tempPath());
    const rec = await store.add('tokA', SUB_A);
    const input = ['task.completed'];
    await store.setPrefs(rec.id, input);
    input.push('mutated');
    expect(store.get(rec.id)!.prefs).toEqual(['task.completed']);
  });

  it('setQuietHours sets a copied window, clears it, and reports missing', async () => {
    const path = tempPath();
    const store = await PushStore.open(path);
    const rec = await store.add('tokA', SUB_A);
    const input = { from: '23:00', to: '07:00', timezone: 'America/New_York' };

    expect(await store.setQuietHours(rec.id, input)).toBe(true);
    input.from = '00:00'; // mutate the caller object after the call
    expect(store.get(rec.id)!.quietHours).toEqual({
      from: '23:00',
      to: '07:00',
      timezone: 'America/New_York',
    });

    // Persists across reopen.
    const reopened = await PushStore.open(path);
    expect(reopened.get(rec.id)!.quietHours).toEqual({
      from: '23:00',
      to: '07:00',
      timezone: 'America/New_York',
    });

    expect(await store.setQuietHours(rec.id, undefined)).toBe(true);
    expect(store.get(rec.id)!.quietHours).toBeUndefined();

    expect(await store.setQuietHours('missing', input)).toBe(false);
  });

  it('setMaxPerHour sets, clears, persists, and reports missing (cycle 46)', async () => {
    const path = tempPath();
    const store = await PushStore.open(path);
    const rec = await store.add('tokA', SUB_A);

    expect(await store.setMaxPerHour(rec.id, 10)).toBe(true);
    expect(store.get(rec.id)!.maxPerHour).toBe(10);

    // Persists across reopen.
    const reopened = await PushStore.open(path);
    expect(reopened.get(rec.id)!.maxPerHour).toBe(10);

    expect(await store.setMaxPerHour(rec.id, undefined)).toBe(true);
    expect(store.get(rec.id)!.maxPerHour).toBeUndefined();

    expect(await store.setMaxPerHour('missing', 5)).toBe(false);
  });

  it('persists the file at mode 0600', async () => {
    const path = tempPath();
    const store = await PushStore.open(path);
    await store.add('tokA', SUB_A);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });
});
