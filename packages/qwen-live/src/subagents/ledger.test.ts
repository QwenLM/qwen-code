/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubagentsLedger } from './ledger.js';
import {
  MAX_SUBAGENTS_SNAPSHOT_BYTES,
  parseSubagentsControlResult,
  parseSubagentsSnapshot,
} from './types.js';

function task(
  id: string,
  status:
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted' = 'running',
) {
  return {
    id,
    kind: 'harness' as const,
    title: id,
    status,
    request: 'Request',
    createdAt: 1,
    updatedAt: 1,
  };
}

afterEach(() => vi.useRealTimers());

describe('SubagentsLedger', () => {
  it('counts cancelled monitors as completed while keeping their cancellation detail and other terminal outcomes', () => {
    const ledger = new SubagentsLedger();
    for (const [id, kind, source, status] of [
      ['monitor', 'proactive', 'audio', 'cancelled'],
      ['timer', 'proactive', 'timer', 'cancelled'],
      ['harness', 'harness', undefined, 'cancelled'],
      ['failed', 'proactive', 'camera', 'failed'],
      ['interrupted', 'proactive', 'screen', 'interrupted'],
      ['completed', 'harness', undefined, 'completed'],
    ] as const) {
      ledger.upsert({ ...task(id), kind, source });
      ledger.result(id, status, status);
    }
    const snapshot = ledger.snapshot();
    expect(snapshot.counts).toEqual({
      running: 0,
      completed: 2,
      needsAttention: 0,
      failed: 1,
      interrupted: 1,
      cancelled: 2,
    });
    expect(snapshot.tasks.find((entry) => entry.id === 'monitor')?.status).toBe(
      'cancelled',
    );
    expect(parseSubagentsSnapshot(snapshot)).toBeDefined();
    ledger.dispose();
  });

  it.each([false, true])(
    'retains cancelled monitor completion counts outside the first page (cancel first: %s)',
    (cancelFirst) => {
      const ledger = new SubagentsLedger();
      const monitor = {
        ...task('proactive:monitor'),
        kind: 'proactive' as const,
        source: 'audio, screen',
      };
      ledger.upsert(monitor);
      if (cancelFirst) ledger.result(monitor.id, 'cancelled', 'Cancelled');
      for (let index = 0; index < 40; index += 1)
        ledger.upsert({ ...task(`running:${index}`), updatedAt: index + 2 });
      if (!cancelFirst) ledger.result(monitor.id, 'cancelled', 'Cancelled');
      const before = ledger.snapshot();
      expect(before.tasks.some((entry) => entry.id === monitor.id)).toBe(false);
      expect(before.counts).toEqual({
        running: 40,
        completed: 1,
        needsAttention: 0,
        failed: 0,
        interrupted: 0,
        cancelled: 0,
      });
      expect(before.omitted).toBe(9);
      ledger.upsert({ ...monitor, status: 'cancelled' });
      ledger.update(monitor.id, { status: 'cancelled' });
      expect(ledger.snapshot().counts).toEqual(before.counts);
      expect(ledger.get(monitor.id)?.status).toBe('cancelled');
      ledger.dispose();
    },
  );

  it('counts only actionable waiting tasks as Needs you, not queued announcements, failures or interruptions', () => {
    const ledger = new SubagentsLedger();
    ledger.upsert({
      ...task('proactive:monitor'),
      kind: 'proactive',
      status: 'monitoring',
      pendingNotifications: 2,
      notification: 'queued',
    });
    ledger.upsert({
      ...task('proactive:delivering'),
      kind: 'proactive',
      status: 'delivering',
      pendingNotifications: 1,
      notification: 'speaking',
    });
    ledger.upsert({ ...task('harness:queued'), status: 'queued' });
    ledger.upsert({ ...task('harness:permission'), status: 'waiting' });
    ledger.upsert(task('harness:failed'));
    ledger.result('harness:failed', 'failed', 'Task failed');
    ledger.upsert(task('harness:interrupted'));
    ledger.result('harness:interrupted', 'interrupted', 'Call ended');
    expect(ledger.snapshot().counts).toEqual({
      running: 4,
      completed: 0,
      needsAttention: 1,
      failed: 1,
      interrupted: 1,
      cancelled: 0,
    });
    ledger.update('harness:permission', { status: 'running' });
    expect(ledger.snapshot().counts.needsAttention).toBe(0);
    ledger.update('proactive:monitor', {
      pendingNotifications: 0,
      notification: 'delivered',
    });
    expect(ledger.snapshot().counts.needsAttention).toBe(0);
    ledger.dispose();
  });

  it('preserves waiting attention outside detail retention while archived failures stay separate', () => {
    const ledger = new SubagentsLedger();
    ledger.upsert({ ...task('waiting:oldest'), status: 'waiting' });
    ledger.upsert(task('failed:archived'));
    ledger.result('failed:archived', 'failed', 'Failure');
    ledger.upsert(task('interrupted:archived'));
    ledger.result('interrupted:archived', 'interrupted', 'Interrupted');
    for (let index = 0; index < 40; index += 1) {
      ledger.upsert({ ...task(`running:${index}`), updatedAt: index + 2 });
    }
    const before = ledger.snapshot();
    expect(before.tasks.some((entry) => entry.id === 'waiting:oldest')).toBe(
      false,
    );
    expect(before.counts).toEqual({
      running: 41,
      completed: 0,
      needsAttention: 1,
      failed: 1,
      interrupted: 1,
      cancelled: 0,
    });
    ledger.update('waiting:oldest', { status: 'running' });
    expect(ledger.snapshot().counts.needsAttention).toBe(0);
    expect(ledger.snapshot().counts.failed).toBe(1);
    expect(ledger.snapshot().counts.interrupted).toBe(1);
    ledger.dispose();
  });

  it('deduplicates logical tasks, keeps terminal states and counts independently of visible retention', () => {
    const ledger = new SubagentsLedger();
    for (let i = 0; i < 40; i++) ledger.upsert(task(`harness:${i}`));
    ledger.upsert(task('harness:39'));
    ledger.result('harness:0', 'completed', 'Done');
    ledger.result('harness:1', 'failed', 'Failed');
    ledger.result('harness:2', 'cancelled', 'Cancelled');
    ledger.result('harness:3', 'interrupted', 'Unknown');
    ledger.upsert(task('harness:0', 'completed'));
    const snapshot = ledger.snapshot();
    expect(snapshot.tasks).toHaveLength(32);
    expect(snapshot.omitted).toBe(8);
    expect(snapshot.counts).toEqual({
      running: 36,
      completed: 1,
      needsAttention: 0,
      failed: 1,
      cancelled: 1,
      interrupted: 1,
    });
    expect(parseSubagentsSnapshot(snapshot)).toBeDefined();
  });

  it('retains every active detail and pages them without reordering on output', () => {
    const ledger = new SubagentsLedger();
    for (let index = 0; index < 100; index++)
      ledger.upsert({ ...task(`job:${index}`), createdAt: index });
    ledger.append('job:0', 'message', 'Oldest task still has its output');
    const first = ledger.page(0, 'job:0');
    const second = ledger.page(32);
    const third = ledger.page(64);
    const last = ledger.page(96);
    expect(first.total).toBe(100);
    expect(first.snapshot.tasks).toHaveLength(32);
    expect(first.snapshot.omitted).toBe(68);
    expect(first.selected?.output).toBe('Oldest task still has its output');
    expect(ledger.get('job:0')?.output).toBe(first.selected?.output);
    expect(
      new Set(
        [first, second, third, last].flatMap((page) =>
          page.snapshot.tasks.map((value) => value.id),
        ),
      ).size,
    ).toBe(100);
    const before = first.snapshot.tasks.map((value) => value.id);
    ledger.append('job:50', 'message', 'More output');
    expect(ledger.page().snapshot.tasks.map((value) => value.id)).toEqual(
      before,
    );
    for (const page of [first, second, third, last])
      expect(parseSubagentsControlResult({ type: 'page', page })).toBeDefined();
    first.selected!.output = 'mutated consumer copy';
    expect(ledger.get('job:0')?.output).toBe(
      'Oldest task still has its output',
    );
    ledger.dispose();
  });

  it('evicts only old terminal history, keeps archived counts, and ignores archived terminal replay', () => {
    const ledger = new SubagentsLedger();
    ledger.upsert(task('active'));
    for (let index = 0; index < 40; index++) {
      const id = `done:${index.toString().padStart(2, '0')}`;
      ledger.upsert(task(id));
      ledger.result(id, 'completed', 'done');
    }
    const page = ledger.page();
    expect(page.total).toBe(33);
    expect(page.snapshot.counts.running).toBe(1);
    expect(page.snapshot.counts.completed).toBe(40);
    expect(ledger.get('active')).toBeDefined();
    expect(ledger.get('done:00')).toBeUndefined();
    ledger.upsert(task('done:00', 'completed'));
    ledger.result('done:00', 'completed', 'late replay');
    expect(ledger.page()).toEqual(page);
    ledger.dispose();
  });

  it('ignores late output and status replay for completed tasks', () => {
    const ledger = new SubagentsLedger();
    ledger.upsert(task('job:1'));
    ledger.result('job:1', 'completed', 'confirmed result');
    const before = ledger.snapshot();
    ledger.append('job:1', 'message', 'late chunk');
    ledger.update('job:1', { status: 'running', activity: 'late start' });
    ledger.result('job:1', 'failed', 'late duplicate');
    expect(ledger.snapshot()).toEqual(before);
  });

  it('bounds UTF-8 snapshots and public output, retains counts and strips terminal controls', () => {
    const ledger = new SubagentsLedger();
    for (let i = 0; i < 32; i++) {
      ledger.upsert({ ...task(`job:${i}`), request: '中文'.repeat(4096) });
      for (let j = 0; j < 26; j++)
        ledger.append(
          `job:${i}`,
          'tool',
          `${j} 中文😀 ${'\\"\n'.repeat(1000)}`,
        );
      ledger.append(`job:${i}`, 'message', '\u001b[31mVisible\u001b[0m');
    }
    const snapshot = ledger.snapshot();
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(
      MAX_SUBAGENTS_SNAPSHOT_BYTES,
    );
    expect(parseSubagentsSnapshot(snapshot)).toBeDefined();
    expect(snapshot.counts.running).toBe(32);
    expect(snapshot.tasks.some((value) => value.outputTruncated)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('\\u001b');
    const page = ledger.page(0, 'job:0');
    for (const row of page.snapshot.tasks) {
      row.canStop = false;
      row.stopReason = 'unsupported';
    }
    expect(parseSubagentsControlResult({ type: 'page', page })).toBeDefined();
  });

  it('coalesces updates, publishes latest state and stops timers on disposal', () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    const ledger = new SubagentsLedger(changed);
    ledger.upsert(task('job:1'));
    ledger.append('job:1', 'message', 'hello');
    ledger.append('job:1', 'message', ' world');
    expect(changed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(changed).toHaveBeenCalledOnce();
    expect(changed.mock.calls[0]?.[0].tasks[0].output).toBe('hello world');
    ledger.result('job:1', 'completed', 'result');
    ledger.dispose();
    vi.advanceTimersByTime(500);
    expect(changed).toHaveBeenCalledOnce();
  });
});
