/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  cleanupOldFileHistoryBackups,
  cleanupOldSubagentTranscripts,
  getCutoffDate,
} from './cleanup.js';

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FILE_HISTORY_DIR = 'file-history';

// Use utimesSync (not vi.useFakeTimers) for mtime fixtures — fake timers
// don't affect fs mtime. Day-scale windows avoid Windows FAT 2s resolution
// flakiness.
function setMtime(dir: string, mtime: Date): void {
  fs.utimesSync(dir, mtime, mtime);
}

function mkSessionDir(root: string, sessionId: string, mtime: Date): string {
  const dir = path.join(root, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  // Touch a file inside so the dir survives sweeps that rely on mtime.
  fs.writeFileSync(path.join(dir, 'snapshot'), 'x');
  setMtime(dir, mtime);
  return dir;
}

describe('getCutoffDate', () => {
  it('returns now - N days for N > 0', () => {
    const before = Date.now();
    const cutoff = getCutoffDate(30);
    const after = Date.now();
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 30 * MS_PER_DAY);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - 30 * MS_PER_DAY);
  });

  it('clamps to 1 hour when cleanupPeriodDays = 0 (active-session safety)', () => {
    const before = Date.now();
    const cutoff = getCutoffDate(0);
    const after = Date.now();
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - MS_PER_HOUR);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - MS_PER_HOUR);
  });

  it('treats negative values as 0 (defends against schema-bypass)', () => {
    // Without this clamp, getCutoffDate(-1) would return now + 1day, which
    // is in the future, and EVERY existing dir (mtime < future) would be
    // swept — including the currently active session.
    const before = Date.now();
    const cutoff = getCutoffDate(-1);
    const after = Date.now();
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - MS_PER_HOUR);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - MS_PER_HOUR);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after); // NOT in future
  });
});

describe('cleanupOldFileHistoryBackups', () => {
  let qwenHome: string;
  let fileHistoryRoot: string;
  let cutoff: Date;

  beforeEach(() => {
    qwenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cleanup-test-'));
    fileHistoryRoot = path.join(qwenHome, FILE_HISTORY_DIR);
    vi.stubEnv('QWEN_HOME', qwenHome);
    cutoff = new Date(Date.now() - 30 * MS_PER_DAY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(qwenHome, { recursive: true, force: true });
  });

  it('returns zero result when root does not exist', async () => {
    const r = await cleanupOldFileHistoryBackups({ cutoffDate: cutoff });
    expect(r).toEqual({ removed: 0, errors: 0 });
  });

  it('removes empty root after sweeping nothing', async () => {
    fs.mkdirSync(fileHistoryRoot);
    const r = await cleanupOldFileHistoryBackups({ cutoffDate: cutoff });
    expect(r).toEqual({ removed: 0, errors: 0 });
    expect(fs.existsSync(fileHistoryRoot)).toBe(false);
  });

  it('preserves dirs younger than cutoff', async () => {
    const recent = new Date(Date.now() - 1 * MS_PER_DAY);
    mkSessionDir(fileHistoryRoot, 's1', recent);
    mkSessionDir(fileHistoryRoot, 's2', recent);
    mkSessionDir(fileHistoryRoot, 's3', recent);

    const r = await cleanupOldFileHistoryBackups({ cutoffDate: cutoff });
    expect(r).toEqual({ removed: 0, errors: 0 });
    expect(fs.readdirSync(fileHistoryRoot).sort()).toEqual(['s1', 's2', 's3']);
  });

  it('removes dirs older than cutoff', async () => {
    const old = new Date(Date.now() - 60 * MS_PER_DAY);
    mkSessionDir(fileHistoryRoot, 's1', old);
    mkSessionDir(fileHistoryRoot, 's2', old);
    mkSessionDir(fileHistoryRoot, 's3', old);

    const r = await cleanupOldFileHistoryBackups({ cutoffDate: cutoff });
    expect(r).toEqual({ removed: 3, errors: 0 });
    // Root is rmdir'd because it became empty.
    expect(fs.existsSync(fileHistoryRoot)).toBe(false);
  });

  it('preserves new dirs and sweeps old ones in mixed input', async () => {
    const recent = new Date(Date.now() - 1 * MS_PER_DAY);
    const old = new Date(Date.now() - 60 * MS_PER_DAY);
    mkSessionDir(fileHistoryRoot, 'old-1', old);
    mkSessionDir(fileHistoryRoot, 'old-2', old);
    mkSessionDir(fileHistoryRoot, 'new-1', recent);

    const r = await cleanupOldFileHistoryBackups({ cutoffDate: cutoff });
    expect(r).toEqual({ removed: 2, errors: 0 });
    expect(fs.readdirSync(fileHistoryRoot)).toEqual(['new-1']);
  });

  it('preserves session ids listed in excludeSessionIds even if old', async () => {
    const old = new Date(Date.now() - 60 * MS_PER_DAY);
    mkSessionDir(fileHistoryRoot, 'current', old);
    mkSessionDir(fileHistoryRoot, 'other', old);

    const r = await cleanupOldFileHistoryBackups({
      cutoffDate: cutoff,
      excludeSessionIds: new Set(['current']),
    });
    expect(r).toEqual({ removed: 1, errors: 0 });
    expect(fs.readdirSync(fileHistoryRoot)).toEqual(['current']);
  });

  it('ignores non-directory entries at root', async () => {
    fs.mkdirSync(fileHistoryRoot);
    fs.writeFileSync(path.join(fileHistoryRoot, 'README.md'), 'stray file');
    const old = new Date(Date.now() - 60 * MS_PER_DAY);
    mkSessionDir(fileHistoryRoot, 's1', old);

    const r = await cleanupOldFileHistoryBackups({ cutoffDate: cutoff });
    expect(r).toEqual({ removed: 1, errors: 0 });
    // The stray file survives (and so does the root dir, since not empty).
    expect(fs.readdirSync(fileHistoryRoot)).toEqual(['README.md']);
  });

  it('handles 100 old dirs without fd exhaustion', async () => {
    const old = new Date(Date.now() - 60 * MS_PER_DAY);
    for (let i = 0; i < 100; i++) {
      mkSessionDir(fileHistoryRoot, `s${i}`, old);
    }

    const r = await cleanupOldFileHistoryBackups({ cutoffDate: cutoff });
    expect(r).toEqual({ removed: 100, errors: 0 });
    expect(fs.existsSync(fileHistoryRoot)).toBe(false);
  });

  // POSIX-only: Windows chmod doesn't have the same "no-write-bit prevents
  // child unlink" semantics, so we can't reliably make a single dir's rm
  // fail without unmount/permission shenanigans. The error-counting path is
  // platform-independent; one OS verifying it is sufficient.
  it.skipIf(process.platform === 'win32')(
    'counts errors and continues sweep when one dir cannot be removed',
    async () => {
      const old = new Date(Date.now() - 60 * MS_PER_DAY);
      mkSessionDir(fileHistoryRoot, 'good-1', old);
      const badDir = path.join(fileHistoryRoot, 'bad');
      fs.mkdirSync(badDir);
      fs.writeFileSync(path.join(badDir, 'snapshot'), 'x');
      fs.utimesSync(badDir, old, old);
      mkSessionDir(fileHistoryRoot, 'good-2', old);

      // chmod 0o500 (r-x, no write) on the bad dir means rm cannot unlink
      // its child snapshot file, so rm({ recursive: true }) fails for it.
      // Other dirs are unaffected.
      fs.chmodSync(badDir, 0o500);

      try {
        const r = await cleanupOldFileHistoryBackups({ cutoffDate: cutoff });
        expect(r).toEqual({ removed: 2, errors: 1 });
        // 'bad' survives; the two good ones are gone.
        expect(fs.readdirSync(fileHistoryRoot)).toEqual(['bad']);
      } finally {
        // Restore so afterEach can rm the temp tree.
        fs.chmodSync(badDir, 0o700);
      }
    },
  );
});

describe('cleanupOldSubagentTranscripts', () => {
  let projectDir: string;
  let subagentsRoot: string;
  let cutoff: Date;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-subagent-cleanup-'),
    );
    subagentsRoot = path.join(projectDir, 'subagents');
    cutoff = new Date(Date.now() - 30 * MS_PER_DAY);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns zero result when the subagents root does not exist', async () => {
    const r = await cleanupOldSubagentTranscripts({
      cutoffDate: cutoff,
      subagentsRoot,
    });
    expect(r).toEqual({ removed: 0, errors: 0 });
  });

  it('removes session dirs older than cutoff, preserving recent and excluded ones', async () => {
    const old = new Date(Date.now() - 60 * MS_PER_DAY);
    const recent = new Date(Date.now() - 1 * MS_PER_DAY);
    mkSessionDir(subagentsRoot, 'current', old);
    mkSessionDir(subagentsRoot, 'stale', old);
    mkSessionDir(subagentsRoot, 'recent', recent);

    const r = await cleanupOldSubagentTranscripts({
      cutoffDate: cutoff,
      excludeSessionIds: new Set(['current']),
      subagentsRoot,
    });

    expect(r).toEqual({ removed: 1, errors: 0 });
    expect(fs.readdirSync(subagentsRoot).sort()).toEqual(['current', 'recent']);
  });
});
