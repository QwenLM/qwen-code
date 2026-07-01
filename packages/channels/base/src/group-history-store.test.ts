import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GroupHistoryStore } from './group-history-store.js';
import type { GroupHistoryEntry } from './group-history-store.js';

function filePath(): string {
  return join(
    mkdtempSync(join(tmpdir(), 'qwen-group-history-')),
    'history.jsonl',
  );
}

function entry(text: string, senderId = 'u1'): GroupHistoryEntry {
  return {
    senderId,
    senderName: senderId,
    text,
    timestamp: 1,
  };
}

describe('GroupHistoryStore', () => {
  it('does not create a file when limit is zero or negative', () => {
    const path = filePath();
    const store = new GroupHistoryStore(path);

    store.record('k', entry('a'), 0);
    store.record('k', entry('b'), -1);

    expect(existsSync(path)).toBe(false);
    expect(store.size('k')).toBe(0);
    expect(store.drain('k', 10)).toEqual([]);
  });

  it('keeps only the latest entries up to the limit', () => {
    const store = new GroupHistoryStore(filePath());

    store.record('k', entry('a'), 2);
    store.record('k', entry('b'), 2);
    store.record('k', entry('c'), 2);

    expect(store.drain('k', 2).map((item) => item.text)).toEqual(['b', 'c']);
  });

  it('replays only the latest entries from disk', () => {
    const path = filePath();
    const store = new GroupHistoryStore(path);

    store.record('k', entry('a'), 2);
    store.record('k', entry('b'), 2);
    store.record('k', entry('c'), 2);

    expect(
      new GroupHistoryStore(path).drain('k', 2).map((item) => item.text),
    ).toEqual(['b', 'c']);
  });

  it('persists pending history across store instances', () => {
    const path = filePath();
    const first = new GroupHistoryStore(path);

    first.record('k', entry('a'), 10);

    const second = new GroupHistoryStore(path);
    expect(second.drain('k', 10).map((item) => item.text)).toEqual(['a']);
  });

  it('ignores malformed JSONL lines while preserving valid records', () => {
    const path = filePath();
    const valid = {
      type: 'message',
      key: 'k',
      limit: 10,
      entry: entry('a'),
      recordedAt: 1,
    };
    writeFileSync(path, `${JSON.stringify(valid)}\n{bad json\n`, 'utf-8');

    const store = new GroupHistoryStore(path);
    store.record('k', entry('b'), 10);

    expect(store.drain('k', 10).map((item) => item.text)).toEqual(['a', 'b']);
    expect(readFileSync(path, 'utf-8')).not.toContain('{bad json');
  });

  it('persists state after compaction', () => {
    const path = filePath();
    const first = new GroupHistoryStore(path, { compactAfterRecords: 2 });

    first.record('k', entry('a'), 10);
    first.record('k', entry('b'), 10);
    first.record('k', entry('c'), 10);

    const second = new GroupHistoryStore(path);
    expect(second.drain('k', 10).map((item) => item.text)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('drains and clears a key on disk', () => {
    const path = filePath();
    const store = new GroupHistoryStore(path);

    store.record('k', entry('a'), 10);

    expect(store.drain('k', 10).map((item) => item.text)).toEqual(['a']);
    expect(new GroupHistoryStore(path).drain('k', 10)).toEqual([]);
  });

  it('compacts drained records while preserving other keys', () => {
    const path = filePath();
    const store = new GroupHistoryStore(path);

    store.record('drained', entry('a'), 10);
    store.record('kept', entry('b'), 10);

    expect(store.drain('drained', 10).map((item) => item.text)).toEqual(['a']);
    const data = readFileSync(path, 'utf-8');
    expect(data).not.toContain('"key":"drained"');
    expect(data).toContain('"key":"kept"');
    expect(
      new GroupHistoryStore(path).drain('kept', 10).map((item) => item.text),
    ).toEqual(['b']);
  });

  it('clears all keys on disk', () => {
    const path = filePath();
    const store = new GroupHistoryStore(path);

    store.record('a', entry('a'), 10);
    store.record('b', entry('b'), 10);
    store.clearAll();

    const next = new GroupHistoryStore(path);
    expect(next.drain('a', 10)).toEqual([]);
    expect(next.drain('b', 10)).toEqual([]);
  });

  it('does not treat unreadable existing stores as empty', () => {
    const path = mkdtempSync(join(tmpdir(), 'qwen-group-history-dir-'));
    const store = new GroupHistoryStore(path);

    expect(() => store.record('k', entry('a'), 10)).toThrow();
  });

  it('evicts oldest keys when max keys is reached', () => {
    const store = new GroupHistoryStore(filePath(), { maxKeys: 2 });

    store.record('a', entry('a'), 10);
    store.record('b', entry('b'), 10);
    store.record('c', entry('c'), 10);

    expect(store.size('a')).toBe(0);
    expect(store.size('b')).toBe(1);
    expect(store.size('c')).toBe(1);
  });

  it('writes JSONL records', () => {
    const path = filePath();
    const store = new GroupHistoryStore(path);

    store.record('k', entry('a'), 10);

    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: 'message',
      key: 'k',
      entry: { text: 'a' },
    });
  });
});
