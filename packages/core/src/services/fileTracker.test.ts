/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileTracker } from './fileTracker.js';

describe('FileTracker', () => {
  let tmpDir: string;
  let tracker: FileTracker;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'file-tracker-test-'));
    tracker = new FileTracker();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no files are tracked', () => {
    expect(tracker.getChangedPaths()).toEqual([]);
  });

  it('returns empty array when a tracked file has not changed', () => {
    const filePath = join(tmpDir, 'unchanged.txt');
    writeFileSync(filePath, 'hello world');
    tracker.record(filePath, 'hello world');

    expect(tracker.getChangedPaths()).toEqual([]);
  });

  it('detects external modification and returns the changed path', async () => {
    const filePath = join(tmpDir, 'modified.txt');
    const originalContent = 'original content';
    writeFileSync(filePath, originalContent);
    tracker.record(filePath, originalContent);

    // Simulate external modification — wait 10ms to ensure mtime changes
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(filePath, 'modified content');

    const changed = tracker.getChangedPaths();
    expect(changed).toContain(filePath);
  });

  it('does not report the same change twice', async () => {
    const filePath = join(tmpDir, 'once.txt');
    writeFileSync(filePath, 'original');
    tracker.record(filePath, 'original');

    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(filePath, 'changed');

    // First call detects the change
    const first = tracker.getChangedPaths();
    expect(first).toContain(filePath);

    // Second call should NOT re-report the same change
    const second = tracker.getChangedPaths();
    expect(second).not.toContain(filePath);
  });

  it('removes deleted files from tracking', async () => {
    const filePath = join(tmpDir, 'deleted.txt');
    writeFileSync(filePath, 'data');
    tracker.record(filePath, 'data');

    rmSync(filePath);

    const changed = tracker.getChangedPaths();
    expect(changed).not.toContain(filePath);
  });

  it('evicts files not accessed within MAX_TURN_AGE turns', async () => {
    const filePath = join(tmpDir, 'evict.txt');
    writeFileSync(filePath, 'content');
    tracker.setTurn(0);
    tracker.record(filePath, 'content');

    // Advance turn counter past MAX_TURN_AGE (10)
    for (let i = 1; i <= 11; i++) {
      tracker.setTurn(i);
    }

    // Even if content changes, the file should have been evicted
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(filePath, 'new content');
    const changed = tracker.getChangedPaths();
    expect(changed).not.toContain(filePath);
  });

  it('clear() removes all tracked files', async () => {
    const filePath = join(tmpDir, 'cleared.txt');
    writeFileSync(filePath, 'data');
    tracker.record(filePath, 'data');

    tracker.clear();

    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(filePath, 'changed data');
    expect(tracker.getChangedPaths()).toEqual([]);
  });
});
