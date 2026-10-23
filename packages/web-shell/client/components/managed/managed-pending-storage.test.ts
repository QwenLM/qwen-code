// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from '../../test/fake-indexeddb';
import {
  readManagedPending,
  saveManagedPending,
} from './managed-pending-storage';

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('managed-pending-storage', () => {
  it('keeps a small payload inline in sessionStorage', async () => {
    vi.stubGlobal('indexedDB', createFakeIndexedDB().factory);

    expect(await saveManagedPending('draft', { text: 'small' })).toBe(true);
    expect(sessionStorage.getItem('draft')).toBe('{"text":"small"}');
    expect(await readManagedPending('draft')).toEqual({ text: 'small' });
  });

  it('spills a large payload to IndexedDB and reads it back', async () => {
    const fake = createFakeIndexedDB();
    vi.stubGlobal('indexedDB', fake.factory);
    const value = { text: 'x'.repeat(200 * 1024) };

    expect(await saveManagedPending('draft', value)).toBe(true);
    const reference = JSON.parse(sessionStorage.getItem('draft')!);
    expect(reference).toMatchObject({ storage: 'indexeddb' });
    expect(typeof reference.pendingId).toBe('string');
    expect(await readManagedPending('draft')).toEqual(value);
  });

  it('refuses a stored request that belongs to another key', async () => {
    const fake = createFakeIndexedDB();
    vi.stubGlobal('indexedDB', fake.factory);
    fake.db.seed('requests', 'other-id', { key: 'other', value: 1 });
    sessionStorage.setItem(
      'draft',
      JSON.stringify({ storage: 'indexeddb', pendingId: 'other-id' }),
    );

    await expect(readManagedPending('draft')).rejects.toThrow(
      'The pending request belongs to another client.',
    );
  });

  it('removes overwritten spilled requests and deletes the last one on clear', async () => {
    const fake = createFakeIndexedDB();
    vi.stubGlobal('indexedDB', fake.factory);
    const first = { text: 'x'.repeat(200 * 1024) };
    const second = { text: 'y'.repeat(200 * 1024) };
    await saveManagedPending('draft', first);
    const { pendingId } = JSON.parse(sessionStorage.getItem('draft')!);
    await saveManagedPending('draft', second);
    expect(fake.stores.get('requests')?.has(pendingId)).toBe(false);
    expect(await readManagedPending('draft')).toEqual(second);
    expect(fake.stores.get('requests')?.size).toBe(1);
    await saveManagedPending('draft');
    expect(sessionStorage.getItem('draft')).toBeNull();
    expect(fake.stores.get('requests')?.size).toBe(0);
  });

  it('fails soft when the database cannot be opened', async () => {
    vi.stubGlobal('indexedDB', createFakeIndexedDB({ failOpen: true }).factory);
    const value = { text: 'x'.repeat(200 * 1024) };

    expect(await saveManagedPending('draft', value)).toBe(false);
    expect(sessionStorage.getItem('draft')).toBeNull();
  });

  it('surfaces a blocked open when reading a spilled request', async () => {
    const fake = createFakeIndexedDB({ blockedThenSuccess: true });
    vi.stubGlobal('indexedDB', fake.factory);
    sessionStorage.setItem(
      'draft',
      JSON.stringify({ storage: 'indexeddb', pendingId: 'held' }),
    );

    await expect(readManagedPending('draft')).rejects.toThrow(
      'Pending request database is blocked.',
    );
  });
});
