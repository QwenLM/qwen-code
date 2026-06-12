/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnoozeStore } from './snooze.js';

let dir: string;
let path: string;
let clock: { now: number };
const nowFn = () => clock.now;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-snooze-'));
  path = join(dir, 'snooze.state');
  clock = { now: 1_000_000 };
});

describe('SnoozeStore', () => {
  it('snooze(60,"all") makes isSnoozed true for any kind', async () => {
    const store = await SnoozeStore.open(path, nowFn);
    await store.snooze(60, 'all');
    expect(store.isSnoozed('permission.required')).toBe(true);
    expect(store.isSnoozed('task.completed')).toBe(true);
    const active = store.active();
    expect(active).not.toBeNull();
    expect(active!.scope).toBe('all');
    expect(active!.until).toBe(1_000_000 + 60_000);
  });

  it('expires when the clock advances past until', async () => {
    const store = await SnoozeStore.open(path, nowFn);
    await store.snooze(60, 'all');
    expect(store.isSnoozed('x')).toBe(true);
    clock.now = 1_000_000 + 60_000; // exactly at until → not < until → inactive
    expect(store.isSnoozed('x')).toBe(false);
    expect(store.active()).toBeNull();
  });

  it('scope to a single kind only suppresses that kind', async () => {
    const store = await SnoozeStore.open(path, nowFn);
    await store.snooze(60, 'permission.required');
    expect(store.isSnoozed('task.completed')).toBe(false);
    expect(store.isSnoozed('permission.required')).toBe(true);
  });

  it('clear() makes it inactive', async () => {
    const store = await SnoozeStore.open(path, nowFn);
    await store.snooze(60, 'all');
    await store.clear();
    expect(store.active()).toBeNull();
    expect(store.isSnoozed('x')).toBe(false);
  });

  it('persists an active snooze across reopen', async () => {
    const a = await SnoozeStore.open(path, nowFn);
    await a.snooze(60, 'all');
    const b = await SnoozeStore.open(path, nowFn);
    expect(b.isSnoozed('x')).toBe(true);
    expect(b.active()!.scope).toBe('all');
  });

  it('reads inactive after reopen when the snooze has already expired', async () => {
    const a = await SnoozeStore.open(path, nowFn);
    await a.snooze(60, 'all');
    clock.now = 1_000_000 + 120_000; // past until
    const b = await SnoozeStore.open(path, nowFn);
    expect(b.active()).toBeNull();
    expect(b.isSnoozed('x')).toBe(false);
  });

  it('reopen after clear reads inactive (empty state file is valid JSON)', async () => {
    const a = await SnoozeStore.open(path, nowFn);
    await a.snooze(60, 'all');
    await a.clear();
    const b = await SnoozeStore.open(path, nowFn);
    expect(b.active()).toBeNull();
  });
});

describe('SnoozeStore multi-snooze (cycle 77)', () => {
  it('holds independent windows per scope simultaneously', async () => {
    const s = await SnoozeStore.open(path, nowFn);
    await s.snooze(60, 'permission.required');
    await s.snooze(120, 'task.completed');
    expect(s.isSnoozed('permission.required')).toBe(true);
    expect(s.isSnoozed('task.completed')).toBe(true);
    // permission expires first; task is still snoozed.
    clock.now += 61_000;
    expect(s.isSnoozed('permission.required')).toBe(false);
    expect(s.isSnoozed('task.completed')).toBe(true);
  });

  it('snoozing one scope does not clobber another', async () => {
    const s = await SnoozeStore.open(path, nowFn);
    await s.snooze(60, 'all');
    await s.snooze(60, 'task.completed');
    // 'all' is still active → suppresses every kind.
    expect(s.isSnoozed('permission.required')).toBe(true);
    expect(
      s
        .activeList()
        .map((e) => e.scope)
        .sort(),
    ).toEqual(['all', 'task.completed']);
  });

  it('clear(scope) drops one entry and leaves the others', async () => {
    const s = await SnoozeStore.open(path, nowFn);
    await s.snooze(60, 'all');
    await s.snooze(60, 'task.completed');
    await s.clear('all');
    expect(s.isSnoozed('permission.required')).toBe(false); // 'all' gone
    expect(s.isSnoozed('task.completed')).toBe(true); // kept
  });

  it('clear() with no scope drops every entry', async () => {
    const s = await SnoozeStore.open(path, nowFn);
    await s.snooze(60, 'all');
    await s.snooze(60, 'task.completed');
    await s.clear();
    expect(s.activeList()).toEqual([]);
    expect(s.active()).toBeNull();
  });

  it('active() prefers the all entry, else the latest-ending', async () => {
    const s = await SnoozeStore.open(path, nowFn);
    await s.snooze(60, 'permission.required');
    await s.snooze(120, 'task.completed');
    // No 'all' → representative is the latest-ending (task.completed).
    expect(s.active()!.scope).toBe('task.completed');
    await s.snooze(30, 'all');
    // 'all' present → representative is 'all' even though it ends soonest.
    expect(s.active()!.scope).toBe('all');
  });

  it('round-trips multiple entries across reopen', async () => {
    const a = await SnoozeStore.open(path, nowFn);
    await a.snooze(60, 'all');
    await a.snooze(120, 'task.completed');
    const b = await SnoozeStore.open(path, nowFn);
    expect(
      b
        .activeList()
        .map((e) => e.scope)
        .sort(),
    ).toEqual(['all', 'task.completed']);
  });

  it('migrates a legacy single-state file to one entry', async () => {
    // Cycle-15 on-disk shape: { until, scope }.
    writeFileSync(
      path,
      JSON.stringify({
        until: clock.now + 60_000,
        scope: 'permission.required',
      }),
    );
    const s = await SnoozeStore.open(path, nowFn);
    expect(s.isSnoozed('permission.required')).toBe(true);
    expect(s.isSnoozed('task.completed')).toBe(false);
    expect(s.active()!.scope).toBe('permission.required');
  });
});
