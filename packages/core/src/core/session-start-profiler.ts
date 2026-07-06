/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Storage } from '../config/storage.js';
import type { SessionStartSource } from '../hooks/types.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { isNodeError } from '../utils/errors.js';

export const SESSION_START_PROFILE_ENV = 'QWEN_CODE_PROFILE_SESSION_START';

const debugLogger = createDebugLogger('SESSION_START_PROFILER');

export interface SessionStartProfileRecord {
  timestamp: string;
  source: SessionStartSource;
  ok: boolean;
  /**
   * Wall-clock session start duration. The sum of `stages` can differ from
   * `totalMs` because some stages overlap and unmeasured code runs between
   * stages.
   */
  totalMs: number;
  stages: Record<string, number>;
  extraHistoryLength?: number;
  historyLength?: number;
  snapshotEntryCount?: number;
  deferredReminderCount?: number;
  failedStage?: string;
}

export interface SessionStartProfileFinishAttrs {
  ok: boolean;
  extraHistoryLength?: number;
  historyLength?: number;
  snapshotEntryCount?: number;
  deferredReminderCount?: number;
}

export interface SessionStartProfiler {
  readonly enabled: boolean;
  time<T>(stage: string, fn: () => T | Promise<T>): Promise<T>;
  timeSync<T>(stage: string, fn: () => T): T;
  finish(attrs: SessionStartProfileFinishAttrs): void;
}

interface SessionStartProfilerOptions {
  enabled?: boolean;
  now?: () => number;
  getTimestamp?: () => Date;
  writeRecord?: (record: SessionStartProfileRecord) => void;
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function getAppendProfileOpenFlags(): number {
  const constants = fs.constants;
  const noFollow = constants.O_NOFOLLOW;
  if (noFollow === undefined) {
    throw new Error('session-start profiler requires O_NOFOLLOW support');
  }
  return (
    (constants.O_APPEND ?? 0) |
    (constants.O_CREAT ?? 0) |
    (constants.O_WRONLY ?? 0) |
    noFollow
  );
}

function assertSafeProfileDirectory(dir: string): void {
  const dirStat = fs.lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error('session-start profiler path must be a real directory');
  }
}

function assertSafeExistingProfileFile(filePath: string): void {
  try {
    const fileStat = fs.lstatSync(filePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error('session-start profiler path must be a real file');
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

function writeProfileRecord(record: SessionStartProfileRecord): void {
  const dir = path.join(Storage.getRuntimeBaseDir(), 'session-start-perf');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Node does not expose a portable fd-relative append here; parent-directory
  // replacement is best-effort while O_NOFOLLOW protects the JSONL file itself.
  assertSafeProfileDirectory(dir);
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best-effort hardening on filesystems without POSIX chmod semantics.
  }
  const filename = `session-start-${record.timestamp.slice(0, 10)}.jsonl`;
  const filePath = path.join(dir, filename);
  assertSafeExistingProfileFile(filePath);
  const fd = fs.openSync(filePath, getAppendProfileOpenFlags(), 0o600);
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error('session-start profiler path must be a real file');
    }
    try {
      fs.fchmodSync(fd, 0o600);
    } catch {
      // Best-effort hardening; profiling output must not block startup.
    }
    fs.appendFileSync(fd, Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'), {
      flush: true,
    });
  } finally {
    fs.closeSync(fd);
  }
}

const disabledProfiler: SessionStartProfiler = {
  enabled: false,
  time<T>(_stage: string, fn: () => T | Promise<T>): Promise<T> {
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error);
    }
  },
  timeSync<T>(_stage: string, fn: () => T): T {
    return fn();
  },
  finish(): void {},
};

class EnabledSessionStartProfiler implements SessionStartProfiler {
  readonly enabled = true;
  private readonly source: SessionStartSource;
  private readonly now: () => number;
  private readonly getTimestamp: () => Date;
  private readonly writeRecord: (record: SessionStartProfileRecord) => void;
  private readonly startMs: number;
  private readonly stages: Record<string, number> = {};
  private failedStage: string | undefined;
  private finished = false;

  constructor(
    source: SessionStartSource,
    options: Required<
      Pick<SessionStartProfilerOptions, 'now' | 'getTimestamp' | 'writeRecord'>
    >,
  ) {
    this.source = source;
    this.now = options.now;
    this.getTimestamp = options.getTimestamp;
    this.writeRecord = options.writeRecord;
    this.startMs = this.now();
  }

  async time<T>(stage: string, fn: () => T | Promise<T>): Promise<T> {
    const start = this.now();
    try {
      return await fn();
    } catch (error) {
      this.failedStage ??= stage;
      throw error;
    } finally {
      this.recordStage(stage, start, this.now());
    }
  }

  timeSync<T>(stage: string, fn: () => T): T {
    const start = this.now();
    try {
      return fn();
    } catch (error) {
      this.failedStage ??= stage;
      throw error;
    } finally {
      this.recordStage(stage, start, this.now());
    }
  }

  finish(attrs: SessionStartProfileFinishAttrs): void {
    if (this.finished) {
      return;
    }
    this.finished = true;

    try {
      const record: SessionStartProfileRecord = {
        timestamp: this.getTimestamp().toISOString(),
        source: this.source,
        ok: attrs.ok,
        totalMs: roundMs(this.now() - this.startMs),
        stages: { ...this.stages },
        ...(attrs.extraHistoryLength !== undefined
          ? { extraHistoryLength: attrs.extraHistoryLength }
          : {}),
        ...(attrs.historyLength !== undefined
          ? { historyLength: attrs.historyLength }
          : {}),
        ...(attrs.snapshotEntryCount !== undefined
          ? { snapshotEntryCount: attrs.snapshotEntryCount }
          : {}),
        ...(attrs.deferredReminderCount !== undefined
          ? { deferredReminderCount: attrs.deferredReminderCount }
          : {}),
        ...(this.failedStage ? { failedStage: this.failedStage } : {}),
      };

      this.writeRecord(record);
    } catch (error) {
      const code = isNodeError(error) ? error.code : undefined;
      try {
        debugLogger.debug('session-start-profiler write failed', {
          name: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : undefined,
          ...(code ? { code } : {}),
        });
      } catch {
        // Recovery logging must not propagate into session creation.
      }
      // Profiling must never affect session creation.
    }
  }

  private recordStage(stage: string, start: number, end: number): void {
    const previous = this.stages[stage] ?? 0;
    this.stages[stage] = roundMs(previous + end - start);
  }
}

export function createSessionStartProfiler(
  source: SessionStartSource,
  options: SessionStartProfilerOptions = {},
): SessionStartProfiler {
  const enabled =
    options.enabled ?? process.env[SESSION_START_PROFILE_ENV] === '1';
  if (!enabled) {
    return disabledProfiler;
  }

  try {
    debugLogger.debug('session-start-profiler enabled', { source });
  } catch {
    // Activation logging must not affect session startup.
  }

  return new EnabledSessionStartProfiler(source, {
    now: options.now ?? (() => performance.now()),
    getTimestamp: options.getTimestamp ?? (() => new Date()),
    writeRecord: options.writeRecord ?? writeProfileRecord,
  });
}
