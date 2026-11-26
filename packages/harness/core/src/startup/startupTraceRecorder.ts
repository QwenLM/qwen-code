/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  performance,
  PerformanceObserver,
  type PerformanceEntry,
} from 'node:perf_hooks';
import { ENV_STARTUP_TRACE } from '../config/brand.js';
import { runLogger } from '../utils/runLogger.js';
import {
  onStartupMilestone,
  type StartupMilestone,
} from '../utils/startupTrace.js';

export const STARTUP_TRACE_FILE_NAME = 'startup-trace.json';
const STARTUP_TRACE_VERSION = 1;

export type StartupTraceMode = 'tui' | 'headless' | 'daemon' | 'acp';

export interface StartupTraceRecorderOptions {
  readonly mode: StartupTraceMode;
  /** Milestones whose first arrival writes the trace; exit always writes. */
  readonly flushOn: readonly StartupMilestone[];
  /** Defaults to the directory of the run-scoped process log. */
  readonly outputDir?: string;
}

interface StartupTraceEntry {
  readonly type: string;
  readonly name: string;
  readonly startTime: number;
  readonly duration?: number;
  readonly detail?: unknown;
}

export interface StartupTraceFile {
  readonly version: number;
  readonly pid: number;
  readonly mode: StartupTraceMode;
  readonly timeOrigin: number;
  readonly flushReason: StartupMilestone | 'exit';
  readonly entries: readonly StartupTraceEntry[];
  readonly memory: Readonly<Record<string, NodeJS.MemoryUsage>>;
}

/**
 * Collects the process `performance` timeline for local startup analysis.
 * StartupProfiler clears its marks after flushing, so entries are captured by
 * an observer as they are created rather than read back at the end.
 */
export class StartupTraceRecorder {
  private readonly entries: StartupTraceEntry[] = [];
  private readonly memory: Record<string, NodeJS.MemoryUsage> = {};
  private readonly observer: PerformanceObserver;
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly options: StartupTraceRecorderOptions) {
    // Entries before observe() come from the buffer; later ones only via the
    // observer (or takeRecords), so the two sources never overlap.
    for (const entry of performance.getEntries()) this.push(entry);
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) this.push(entry);
    });
    this.observer.observe({ entryTypes: ['mark', 'measure'] });
    this.unsubscribe = onStartupMilestone((name, key) => {
      this.memory[key] = process.memoryUsage();
      if (this.options.flushOn.includes(name)) void this.write(name);
    });
  }

  /** Synchronous so it can run from the exit cleanup; overwrites earlier writes. */
  writeSync(): void {
    if (this.disposed) return;
    const target = this.targetPath();
    if (!target) return;
    try {
      this.drainObserver();
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(this.snapshot('exit')));
    } catch (error) {
      runLogger.warn('[startup-trace] write failed', error);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer.disconnect();
    this.unsubscribe();
  }

  snapshot(flushReason: StartupTraceFile['flushReason']): StartupTraceFile {
    return {
      version: STARTUP_TRACE_VERSION,
      pid: process.pid,
      mode: this.options.mode,
      timeOrigin: performance.timeOrigin,
      flushReason,
      entries: [...this.entries].sort((a, b) => a.startTime - b.startTime),
      memory: { ...this.memory },
    };
  }

  private async write(reason: StartupMilestone): Promise<void> {
    const target = this.targetPath();
    if (!target || this.disposed) return;
    try {
      this.drainObserver();
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify(this.snapshot(reason)));
    } catch (error) {
      runLogger.warn('[startup-trace] write failed', error);
    }
  }

  /** Observer callbacks are batched; pull pending entries before writing. */
  private drainObserver(): void {
    for (const entry of this.observer.takeRecords()) this.push(entry);
  }

  private push(entry: PerformanceEntry): void {
    if (entry.entryType !== 'mark' && entry.entryType !== 'measure') return;
    const detail = (entry as PerformanceEntry & { detail?: unknown }).detail;
    this.entries.push({
      type: entry.entryType,
      name: entry.name,
      startTime: entry.startTime,
      ...(entry.entryType === 'measure' ? { duration: entry.duration } : {}),
      ...(detail !== undefined && detail !== null ? { detail } : {}),
    });
  }

  private targetPath(): string | undefined {
    const logPath = runLogger.getDebugLogPath();
    const dir = this.options.outputDir ?? (logPath && path.dirname(logPath));
    return dir ? path.join(dir, STARTUP_TRACE_FILE_NAME) : undefined;
  }
}

/** Returns a recorder only when ENV_STARTUP_TRACE is `1`; otherwise costs nothing. */
export function installStartupTraceRecorder(
  options: StartupTraceRecorderOptions,
  env: NodeJS.ProcessEnv = process.env,
): StartupTraceRecorder | undefined {
  if (env[ENV_STARTUP_TRACE] !== '1') return undefined;
  try {
    return new StartupTraceRecorder(options);
  } catch (error) {
    runLogger.warn('[startup-trace] recorder unavailable', error);
    return undefined;
  }
}
