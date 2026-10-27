/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileManagedSessionHistory,
  ManagedHistoryCache,
  ManagedHistoryUnavailableError,
  MANAGED_HISTORY_LIMITS,
} from './managed-session-history.js';

describe('verified file history', () => {
  let directory: string;
  let history: FileManagedSessionHistory;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'qwen-pr5-history-'));
    history = await FileManagedSessionHistory.create(directory);
  });

  afterEach(async () => {
    await history.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('preserves namespace identity, first insertion order and frozen roots', async () => {
    const commands = history.map<{ revision: number }>('command');
    history.begin();
    for (let i = 0; i < 300; i++)
      await commands.set(`id-${i}`, { revision: i });
    await history.flush();
    const root = history.rootDigest;
    await commands.set('id-3', { revision: 301 });
    expect(await history.get('command', 'id-3', root)).toEqual({ revision: 3 });
    expect(await commands.get('id-3')).toEqual({ revision: 301 });
    expect(await history.get('action', 'id-3')).toBeUndefined();
    const keys: string[] = [];
    for await (const [key] of commands) keys.push(key);
    expect(keys).toEqual(Array.from({ length: 300 }, (_, i) => `id-${i}`));
    expect(history.cacheUsage.bytes).toBeLessThanOrEqual(
      MANAGED_HISTORY_LIMITS.cacheBytes,
    );
  });

  it('does not publish an unfinished batch and discards its catalog additions', async () => {
    const actions = history.map<string>('action');
    await actions.set('old', 'requested');
    const root = history.rootDigest;
    history.begin();
    await actions.set('new', 'resolved');
    expect(await actions.get('new')).toBe('resolved');
    expect(history.rootDigest).toBe(root);
    history.discard();
    expect(await actions.get('new')).toBeUndefined();
    const entries = [];
    for await (const entry of actions) entries.push(entry);
    expect(entries).toEqual([['old', 'requested']]);
  });

  it('reconstructs a complete view instead of reusing an old sidecar root', async () => {
    await history.map<string>('event-id').set('old', '1');
    const next = await FileManagedSessionHistory.create(directory);
    try {
      expect(next.rootDigest).toBeNull();
      expect(next.directory).not.toBe(history.directory);
    } finally {
      await next.close();
    }
  });

  it('keeps cache usage bounded in bytes and count', () => {
    const cache = new ManagedHistoryCache<string>();
    for (let i = 0; i < 5000; i++) cache.set(String(i), String(i), 4096);
    expect(cache.size).toBeLessThanOrEqual(MANAGED_HISTORY_LIMITS.cacheEntries);
    expect(cache.byteLength).toBeLessThanOrEqual(
      MANAGED_HISTORY_LIMITS.cacheBytes,
    );
    cache.set('oversize', 'body', MANAGED_HISTORY_LIMITS.cacheBytes + 1);
    expect(cache.get('oversize')).toBeUndefined();
  });

  it('refuses a referenced missing page rather than answering absence', async () => {
    await history.map<string>('event-id').set('original', '1');
    const root = history.rootDigest!;
    await unlink(path.join(history.directory, root));
    // Force out the root without constructing history-sized input.
    for (let i = 0; i < 70; i++)
      await history
        .map<string>('resource')
        .set(String(i), `${i}:${'x'.repeat(65536)}`);
    await expect(history.get('event-id', 'absent', root)).rejects.toThrow();
  });

  const clearCache = (view: FileManagedSessionHistory) => {
    Reflect.get(view, 'owner').cache.clear();
  };

  it('replaces a corrupt derived blob only with bytes rebuilt from the source', async () => {
    await history.map('command').set('old', 1);
    let rebuilds = 0;
    history.setRebuilder(async (repair) => {
      rebuilds++;
      await repair.map('command').set('old', 1);
    });
    const root = history.rootDigest!;
    for (let attempt = 0; attempt < 2; attempt++) {
      await writeFile(path.join(history.directory, root), 'corrupt');
      clearCache(history);
      expect(await history.get('command', 'old')).toBe(1);
      expect(history.rootDigest).toBe(root);
      expect(rebuilds).toBe(attempt + 1);
    }
    clearCache(history);
    expect(await history.get('command', 'absent')).toBeUndefined();
  });

  it.each(['missing', 'corrupt'] as const)(
    'rebuilds a %s frozen view from its own source prefix with a different logical root',
    async (damage) => {
      const facts = history.map<{ a: number; b: number }>('command');
      await facts.set('old', { a: 1, b: 2 });
      history.setRebuilder(async (repair) => {
        await repair.map('command').set('old', { b: 2, a: 1 });
      });
      const frozen = history.snapshot();
      const root = frozen.rootDigest!;
      await facts.set('old', { a: 2, b: 3 });
      history.setRebuilder(async (repair) => {
        await repair.map('command').set('old', { a: 2, b: 3 });
      });
      if (damage === 'missing')
        await unlink(path.join(history.directory, root));
      else await writeFile(path.join(history.directory, root), 'damaged page');
      clearCache(history);
      expect(await frozen.get('command', 'old', root)).toEqual({ a: 1, b: 2 });
      expect(frozen.rootDigest).not.toBe(root);
      await unlink(path.join(frozen.directory, frozen.rootDigest!));
      clearCache(frozen);
      expect(await frozen.get('command', 'old', root)).toEqual({ a: 1, b: 2 });
      expect(await frozen.get('command', 'absent', root)).toBeUndefined();
      expect(await facts.get('old')).toEqual({ a: 2, b: 3 });
      await frozen.close();
    },
  );

  it('coalesces repair while preserving the bounded pending overlay and identity order', async () => {
    const facts = history.map<number>('command');
    await facts.set('committed', 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let rebuilds = 0;
    history.setRebuilder(async (repair) => {
      rebuilds++;
      started();
      await gate;
      await repair.map('command').set('committed', 1);
    });
    history.begin();
    await facts.set('pending', 2);
    await unlink(path.join(history.directory, history.rootDigest!));
    clearCache(history);
    const first = facts.get('committed');
    const absent = facts.get('absent');
    await entered;
    release();
    expect(await first).toBe(1);
    expect(await absent).toBeUndefined();
    expect(rebuilds).toBe(1);
    expect(await facts.get('pending')).toBe(2);
    await history.flush();
    const ids = [];
    for await (const id of facts.keys()) ids.push(id);
    expect(ids).toEqual(['committed', 'pending']);
  });

  it('refuses a source-prefix change during repair instead of answering from a newer head', async () => {
    await history.map('command').set('old', 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    history.setRebuilder(async (repair) => {
      started();
      await gate;
      await repair.map('command').set('old', 1);
    });
    const root = history.rootDigest!;
    await unlink(path.join(history.directory, root));
    clearCache(history);
    const reading = history.get('command', 'old');
    const rejected = reading.catch((error: unknown) => error);
    await entered;
    history.setRebuilder(async (repair) => {
      await repair.map('command').set('old', 2);
    });
    release();
    expect(await rejected).toMatchObject({
      message: expect.stringMatching(/prefix advanced/),
    });
    expect(history.rootDigest).toBe(root);
    expect(history.count('command')).toBe(1);
  });

  it('refuses a late failed read after another repair and a newer root publication', async () => {
    const facts = history.map<number>('command');
    await facts.set('old', 1);
    history.setRebuilder(async (repair) => {
      await repair.map('command').set('old', 1);
    });
    const root = history.rootDigest!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const readPage = Reflect.get(history, 'readPage') as (
      ref: string,
    ) => Promise<unknown>;
    let reads = 0;
    Reflect.set(history, 'readPage', async (ref: string) => {
      if (reads++ === 0) {
        started();
        await gate;
        throw new ManagedHistoryUnavailableError('delayed page read failed');
      }
      return readPage.call(history, ref);
    });
    const late = history.get('command', 'old', root);
    const rejected = late.catch((error: unknown) => error);
    await entered;
    await unlink(path.join(history.directory, root));
    clearCache(history);
    expect(await facts.get('old')).toBe(1);
    await facts.set('old', 2);
    release();
    expect(await rejected).toMatchObject({
      message: expect.stringMatching(/prefix advanced/),
    });
    expect(await facts.get('old')).toBe(2);
  });

  it('propagates canonical corruption without publishing an empty repaired view', async () => {
    await history.map('command').set('old', 1);
    history.setRebuilder(async () => {
      throw new Error('canonical journal is corrupt');
    });
    const root = history.rootDigest!;
    await unlink(path.join(history.directory, root));
    clearCache(history);
    await expect(history.get('command', 'absent')).rejects.toThrow(
      /canonical journal is corrupt/,
    );
    expect(history.rootDigest).toBe(root);
    expect(history.count('command')).toBe(1);
  });

  it('freezes catalog counts and a committed overlay across later publications', async () => {
    const facts = history.map<number>('command');
    await facts.set('first', 1);
    history.begin();
    await facts.set('first', 2);
    await facts.set('second', 3);
    const frozen = history.snapshot();
    const entries = frozen.map<number>('command')[Symbol.asyncIterator]();
    await history.flush();
    await facts.set('third', 4);
    const actual = [];
    for await (const entry of entries) actual.push(entry);
    expect(actual).toEqual([
      ['first', 2],
      ['second', 3],
    ]);
    expect(await frozen.map<number>('command').get('third')).toBeUndefined();
  });

  it('drains an in-flight body read before removing every fork of the owner', async () => {
    let finish!: (bytes: Buffer) => void;
    const waiting = new Promise<Buffer>((resolve) => {
      finish = resolve;
    });
    const fork = history.fork();
    const reading = fork.loadBody('pending', () => waiting);
    let removed = false;
    const closing = history.close().then(() => {
      removed = true;
    });
    await Promise.resolve();
    expect(removed).toBe(false);
    await expect(fork.map<boolean>('event-id').get('missing')).rejects.toThrow(
      /closing/,
    );
    finish(Buffer.from('verified'));
    expect((await reading).toString()).toBe('verified');
    await closing;
    expect(removed).toBe(true);
    await expect(
      fork.loadBody('pending', async () => Buffer.from('other')),
    ).rejects.toThrow(/closing/);
  });

  it('stores large legacy identities outside bounded leaf pages', async () => {
    const key = 'x'.repeat(70 * 1024);
    await history.map<boolean>('event-id').set(key, true);
    expect(await history.map<boolean>('event-id').get(key)).toBe(true);
    expect(
      await history.map<boolean>('event-id').get(`${key}y`),
    ).toBeUndefined();
    const [identity] = await history
      .map<boolean>('event-id')
      .keys()
      .next()
      .then((result) => [result.value]);
    expect(identity).toBe(key);
  });

  it('isolates derived roots while sharing the owner cache and lifecycle', async () => {
    await history.map<number>('command').set('source', 1);
    const query = history.emptyView();
    await query.map<number>('command').set('derived', 2);
    expect(query.directory).toBe(history.directory);
    expect(await query.map<number>('command').get('source')).toBeUndefined();
    expect(await history.map<number>('command').get('derived')).toBeUndefined();
    expect(query.cacheUsage).toEqual(history.cacheUsage);
    await query.close();
    await expect(query.map<number>('command').get('derived')).rejects.toThrow();
    expect(await history.map<number>('command').get('source')).toBe(1);
  });

  it('publishes shared content blocks atomically across independent roots', async () => {
    const query = history.emptyView();
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x5a);
    const [sourceRef, queryRef] = await Promise.all([
      history.writeBlock(bytes),
      query.writeBlock(bytes),
    ]);
    expect(queryRef).toBe(sourceRef);
    expect(
      (await query.readBlock(sourceRef, bytes.byteLength)).equals(bytes),
    ).toBe(true);
    await query.close();
    expect(
      (await history.readBlock(sourceRef, bytes.byteLength)).equals(bytes),
    ).toBe(true);
  });
});
