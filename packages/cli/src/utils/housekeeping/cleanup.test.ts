/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { OpenAILogger, Storage } from '@qwen-code/qwen-code-core';
import {
  cleanupOldDebugLogs,
  cleanupOldFileHistoryBackups,
  cleanupOldOpenAILogs,
  cleanupOldSubagentTranscripts,
  getCutoffDate,
} from './cleanup.js';

vi.mock('node:fs/promises', { spy: true });

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FILE_HISTORY_DIR = 'file-history';
const DEBUG_DIR = 'debug';
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const AGENT_SESSION_ID = `${UUID_C}-agent-Explore-g2tss0`;
const VALID_DEBUG_SESSION_IDS = new Set([
  UUID_A,
  UUID_B,
  UUID_C,
  AGENT_SESSION_ID,
]);

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

  it('keeps oversized retention values within the valid Date range', () => {
    const cutoff = getCutoffDate(Number.MAX_VALUE);
    expect(cutoff.getTime()).toBe(-8_640_000_000_000_000);
    expect(() => cutoff.toISOString()).not.toThrow();
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

  it('keeps the project-local subagents root after it becomes empty', async () => {
    const old = new Date(Date.now() - 60 * MS_PER_DAY);
    mkSessionDir(subagentsRoot, 'stale', old);

    const r = await cleanupOldSubagentTranscripts({
      cutoffDate: cutoff,
      subagentsRoot,
    });

    expect(r).toEqual({ removed: 1, errors: 0 });
    expect(fs.existsSync(subagentsRoot)).toBe(true);
    expect(fs.readdirSync(subagentsRoot)).toEqual([]);
  });
});

describe('cleanupOldOpenAILogs', () => {
  let logDir: string;
  let cutoff: Date;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-openai-logs-test-'));
    cutoff = new Date(Date.now() - 7 * MS_PER_DAY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  function mkLog(name: string, mtime: Date): string {
    const p = path.join(logDir, name);
    fs.writeFileSync(p, '{}');
    fs.utimesSync(p, mtime, mtime);
    return p;
  }

  function openAILogName(
    timestamp: Date,
    id = 'a1b2c3d4',
    suffix?: string,
  ): string {
    return `openai-${timestamp.toISOString().replace(/:/g, '-')}-${id}${suffix ? `-${suffix}` : ''}.json`;
  }

  it('returns zero result when the log dir does not exist', async () => {
    const r = await cleanupOldOpenAILogs({
      logDir: path.join(logDir, 'nope'),
      cutoffDate: cutoff,
    });
    expect(r).toEqual({ removed: 0, errors: 0, completed: true });
  });

  it('removes logs whose filename date is older than the cutoff, even with a fresh mtime', async () => {
    // Filename date is authoritative when parseable: the mtime may have been
    // touched long after the log was written.
    const old = mkLog(
      openAILogName(new Date(Date.now() - 30 * MS_PER_DAY)),
      new Date(),
    );
    const r = await cleanupOldOpenAILogs({ logDir, cutoffDate: cutoff });
    expect(r).toEqual({ removed: 1, errors: 0, completed: true });
    expect(fs.existsSync(old)).toBe(false);
    // The project-local log dir itself is never removed.
    expect(fs.existsSync(logDir)).toBe(true);
  });

  it('keeps logs whose filename date is newer than the cutoff', async () => {
    const recent = new Date(Date.now() - 1 * MS_PER_DAY);
    const name = openAILogName(recent, 'b2c3d4e5', 'side-query-session-title');
    const fresh = mkLog(name, recent);
    const r = await cleanupOldOpenAILogs({ logDir, cutoffDate: cutoff });
    expect(r).toEqual({ removed: 0, errors: 0, completed: true });
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('preserves old openai-prefixed JSON files not emitted by OpenAILogger', async () => {
    const oldPrefixedFile = mkLog(
      'openai-not-a-date.json',
      new Date(Date.now() - 30 * MS_PER_DAY),
    );
    const missingId = mkLog(
      'openai-2026-06-01T10-00-00.000Z.json',
      new Date(Date.now() - 30 * MS_PER_DAY),
    );
    const r = await cleanupOldOpenAILogs({ logDir, cutoffDate: cutoff });
    expect(r).toEqual({ removed: 0, errors: 0, completed: true });
    expect(fs.existsSync(oldPrefixedFile)).toBe(true);
    expect(fs.existsSync(missingId)).toBe(true);
  });

  it('recognizes the current OpenAILogger filename contract', async () => {
    const logger = new OpenAILogger(logDir);
    const generated = await logger.logInteraction(
      { model: 'test-model' },
      { choices: [] },
      undefined,
      'side-query:session-title',
    );

    const r = await cleanupOldOpenAILogs({
      logDir,
      cutoffDate: new Date(Date.now() + MS_PER_DAY),
    });
    expect(r).toEqual({ removed: 1, errors: 0, completed: true });
    expect(fs.existsSync(generated)).toBe(false);
  });

  it('uses mtime to disambiguate files dated exactly on the cutoff day', async () => {
    const cutoffDay = cutoff.toISOString().slice(0, 10);
    const olderThanCutoff = mkLog(
      `openai-${cutoffDay}T00-00-00.000Z-a1b2c3d4.json`,
      new Date(cutoff.getTime() - MS_PER_HOUR),
    );
    const newerThanCutoff = mkLog(
      `openai-${cutoffDay}T23-59-59.999Z-b2c3d4e5-subagent-Explore-g2tss0.json`,
      new Date(cutoff.getTime() + MS_PER_HOUR),
    );
    const r = await cleanupOldOpenAILogs({ logDir, cutoffDate: cutoff });
    expect(r).toEqual({ removed: 1, errors: 0, completed: true });
    expect(fs.existsSync(olderThanCutoff)).toBe(false);
    expect(fs.existsSync(newerThanCutoff)).toBe(true);
  });

  it('ignores non-matching files and directories', async () => {
    const note = mkLog('notes.txt', new Date(Date.now() - 60 * MS_PER_DAY));
    const otherLog = mkLog(
      'openai-logs.txt',
      new Date(Date.now() - 60 * MS_PER_DAY),
    );
    const dirWithMatchingName = path.join(
      logDir,
      'openai-2026-06-01T00-00-00.000Z-a1b2c3d4.json',
    );
    fs.mkdirSync(dirWithMatchingName);

    const r = await cleanupOldOpenAILogs({ logDir, cutoffDate: cutoff });
    expect(r).toEqual({ removed: 0, errors: 0, completed: true });
    expect(fs.existsSync(note)).toBe(true);
    expect(fs.existsSync(otherLog)).toBe(true);
    expect(fs.existsSync(dirWithMatchingName)).toBe(true);
  });

  it('returns incomplete without opening the directory when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const r = await cleanupOldOpenAILogs({
      logDir,
      cutoffDate: cutoff,
      signal: controller.signal,
    });

    expect(r).toEqual({ removed: 0, errors: 0, completed: false });
  });

  it('checks cancellation for every directory entry', async () => {
    const old = new Date(Date.now() - 30 * MS_PER_DAY);
    for (let i = 0; i < 10; i++) {
      mkLog(`notes-${i}.txt`, old);
    }
    for (let i = 0; i < 10; i++) {
      mkLog(openAILogName(old, i.toString(16).padStart(8, '0')), old);
    }

    let checks = 0;
    const signal = {
      get aborted() {
        checks++;
        return checks > 5;
      },
    } as AbortSignal;

    const r = await cleanupOldOpenAILogs({
      logDir,
      cutoffDate: cutoff,
      signal,
    });

    expect(r.completed).toBe(false);
    expect(checks).toBeGreaterThan(5);
    expect(r.removed).toBeLessThan(10);
  });

  it('settles a partially populated deletion batch before returning', async () => {
    const old = new Date(Date.now() - 30 * MS_PER_DAY);
    for (let i = 0; i < 10; i++) {
      mkLog(openAILogName(old, i.toString(16).padStart(8, '0')), old);
    }

    let unlinkStarted = false;
    let releaseUnlink: (() => void) | undefined;
    vi.mocked(fsPromises.unlink).mockImplementation(async (filePath) => {
      unlinkStarted = true;
      await new Promise<void>((resolve) => {
        releaseUnlink = resolve;
      });
      fs.unlinkSync(filePath);
    });
    const signal = {
      get aborted() {
        return unlinkStarted;
      },
    } as AbortSignal;

    let settled = false;
    const cleanup = cleanupOldOpenAILogs({
      logDir,
      cutoffDate: cutoff,
      signal,
    }).then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => expect(releaseUnlink).toBeTypeOf('function'));
    await Promise.resolve();
    try {
      expect(settled).toBe(false);
    } finally {
      releaseUnlink?.();
    }
    const r = await cleanup;

    expect(r).toEqual({ removed: 1, errors: 0, completed: false });
  });

  it.skipIf(process.platform === 'win32')(
    'rejects when the log directory cannot be scanned',
    async () => {
      fs.chmodSync(logDir, 0o000);
      try {
        await expect(
          cleanupOldOpenAILogs({ logDir, cutoffDate: cutoff }),
        ).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        fs.chmodSync(logDir, 0o700);
      }
    },
  );
});

describe('cleanupOldDebugLogs', () => {
  let qwenHome: string;
  let debugRoot: string;
  let cutoff: Date;

  beforeEach(() => {
    qwenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-debug-cleanup-'));
    debugRoot = path.join(qwenHome, DEBUG_DIR);
    vi.stubEnv('QWEN_HOME', qwenHome);
    // cleanupOldDebugLogs resolves its root via Storage.getGlobalDebugDir(),
    // which prefers QWEN_RUNTIME_DIR — pin it so an ambient value can never
    // redirect the sweep at the real debug dir.
    vi.stubEnv('QWEN_RUNTIME_DIR', qwenHome);
    cutoff = new Date(Date.now() - 30 * MS_PER_DAY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(qwenHome, { recursive: true, force: true });
  });

  function mkDebugLog(name: string, mtime: Date): string {
    fs.mkdirSync(debugRoot, { recursive: true });
    const p = path.join(debugRoot, name);
    fs.writeFileSync(p, 'log');
    fs.utimesSync(p, mtime, mtime);
    return p;
  }

  // Valid-session fixtures go through core's writer-side path builder so the
  // suite goes red if the sweeper's suffix/stem contract drifts from core's.
  function mkSessionLog(sessionId: string, mtime: Date): string {
    const p = Storage.getDebugLogPath(sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'log');
    fs.utimesSync(p, mtime, mtime);
    return p;
  }

  function cleanupDebugLogs(
    opts: Omit<Parameters<typeof cleanupOldDebugLogs>[0], 'isValidSessionId'>,
  ) {
    return cleanupOldDebugLogs({
      ...opts,
      isValidSessionId: (sessionId) => VALID_DEBUG_SESSION_IDS.has(sessionId),
    });
  }

  it('returns zero result when the debug dir does not exist', async () => {
    const r = await cleanupDebugLogs({ cutoffDate: cutoff });
    expect(r).toEqual({ removed: 0, errors: 0 });
  });

  it('removes session logs older than the cutoff, keeping recent ones', async () => {
    const old = mkSessionLog(UUID_A, new Date(Date.now() - 60 * MS_PER_DAY));
    const agent = mkSessionLog(
      AGENT_SESSION_ID,
      new Date(Date.now() - 60 * MS_PER_DAY),
    );
    const fresh = mkSessionLog(UUID_B, new Date(Date.now() - 1 * MS_PER_DAY));

    const r = await cleanupDebugLogs({ cutoffDate: cutoff });
    expect(r).toEqual({ removed: 2, errors: 0 });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(agent)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    // The debug dir itself is never removed.
    expect(fs.existsSync(debugRoot)).toBe(true);
  });

  it('preserves session ids listed in excludeSessionIds even if old', async () => {
    const current = mkSessionLog(
      UUID_A,
      new Date(Date.now() - 60 * MS_PER_DAY),
    );
    const other = mkSessionLog(UUID_B, new Date(Date.now() - 60 * MS_PER_DAY));

    const r = await cleanupDebugLogs({
      cutoffDate: cutoff,
      excludeSessionIds: new Set([UUID_A]),
    });
    expect(r).toEqual({ removed: 1, errors: 0 });
    expect(fs.existsSync(current)).toBe(true);
    expect(fs.existsSync(other)).toBe(false);
  });

  // 25 > SWEEP_CONCURRENCY (20): a batch-loop stride regression that only
  // visits the first batch would silently under-delete and still pass every
  // smaller fixture.
  it('sweeps stale logs spanning multiple concurrency batches', async () => {
    const old = new Date(Date.now() - 60 * MS_PER_DAY);
    const ids = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const id = `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
      ids.add(id);
      mkSessionLog(id, old);
    }

    const r = await cleanupOldDebugLogs({
      cutoffDate: cutoff,
      isValidSessionId: (sessionId) => ids.has(sessionId),
    });
    expect(r).toEqual({ removed: 25, errors: 0 });
    // The debug root itself must survive even when the sweep empties it —
    // debugLogger memoizes its ensure-dir step per path and would silently
    // drop the rest of a session's debug output after an rmdir.
    expect(fs.existsSync(debugRoot)).toBe(true);
    expect(fs.readdirSync(debugRoot)).toEqual([]);
  });

  it('leaves the latest symlink and the daemon subdir untouched', async () => {
    const old = mkSessionLog(UUID_A, new Date(Date.now() - 60 * MS_PER_DAY));

    // `latest` symlink → an old target: it must not be swept even though its
    // target is aged, because it is a symlink, not a `<uuid>.txt` file.
    const latest = path.join(debugRoot, 'latest');
    fs.symlinkSync(path.basename(old), latest);

    // `daemon/` subdir with an old file inside — size-rotated separately.
    const daemonDir = path.join(debugRoot, 'daemon');
    fs.mkdirSync(daemonDir);
    const daemonLog = path.join(daemonDir, 'serve-1.log');
    fs.writeFileSync(daemonLog, 'x');
    const old2 = new Date(Date.now() - 60 * MS_PER_DAY);
    fs.utimesSync(daemonLog, old2, old2);

    const r = await cleanupDebugLogs({ cutoffDate: cutoff });
    expect(r).toEqual({ removed: 1, errors: 0 });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.lstatSync(latest).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(daemonLog)).toBe(true);
  });

  it('ignores invalid-session-id .txt files even when old', async () => {
    const stray = mkDebugLog(
      'notes.txt',
      new Date(Date.now() - 60 * MS_PER_DAY),
    );
    const alsoStray = mkDebugLog(
      'latest.txt',
      new Date(Date.now() - 60 * MS_PER_DAY),
    );

    const r = await cleanupDebugLogs({ cutoffDate: cutoff });
    expect(r).toEqual({ removed: 0, errors: 0 });
    expect(fs.existsSync(stray)).toBe(true);
    expect(fs.existsSync(alsoStray)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'counts errors and continues when a file cannot be unlinked',
    async () => {
      const good = mkSessionLog(UUID_A, new Date(Date.now() - 60 * MS_PER_DAY));
      mkSessionLog(UUID_B, new Date(Date.now() - 60 * MS_PER_DAY));
      mkSessionLog(UUID_C, new Date(Date.now() - 60 * MS_PER_DAY));

      // Drop the write bit on the dir so unlink of any child fails (EACCES)
      // while readdir/stat still work.
      fs.chmodSync(debugRoot, 0o500);
      try {
        const r = await cleanupDebugLogs({ cutoffDate: cutoff });
        expect(r).toEqual({ removed: 0, errors: 3 });
        expect(fs.existsSync(good)).toBe(true);
      } finally {
        fs.chmodSync(debugRoot, 0o700);
      }
    },
  );
});
