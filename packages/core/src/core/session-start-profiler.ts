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

export const SESSION_START_PROFILE_ENV = 'QWEN_CODE_PROFILE_SESSION_START';

export interface SessionStartProfileRecord {
  timestamp: string;
  source: SessionStartSource;
  ok: boolean;
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

function writeProfileRecord(record: SessionStartProfileRecord): void {
  const dir = path.join(Storage.getRuntimeBaseDir(), 'session-start-perf');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best-effort hardening on filesystems without POSIX chmod semantics.
  }
  const filename = `session-start-${record.timestamp.slice(0, 10)}.jsonl`;
  const filePath = path.join(dir, filename);
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    try {
      fs.fchmodSync(fd, 0o600);
    } catch {
      // Best-effort hardening; profiling output must not block startup.
    }
    fs.appendFileSync(fd, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
    });
  } finally {
    fs.closeSync(fd);
  }
}

const disabledProfiler: SessionStartProfiler = {
  enabled: false,
  async time<T>(_stage: string, fn: () => T | Promise<T>): Promise<T> {
    return await fn();
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
    } catch {
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

  return new EnabledSessionStartProfiler(source, {
    now: options.now ?? (() => performance.now()),
    getTimestamp: options.getTimestamp ?? (() => new Date()),
    writeRecord: options.writeRecord ?? writeProfileRecord,
  });
}
