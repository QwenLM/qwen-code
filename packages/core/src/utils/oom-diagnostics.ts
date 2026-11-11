/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import v8 from 'node:v8';
import {
  BRAND_TEMP_PATH_SLUG,
  BRAND_FIXED_ENV_PREFIX,
} from '../config/brand.js';
import { diagnosticLogger, PROCESS_LOG_FILE_NAME } from './diagnosticLogger.js';
import { runLogger } from './runLogger.js';

export const OOM_DIAG_ENABLED_ENV = `${BRAND_FIXED_ENV_PREFIX}OOM_DIAG`;
export const OOM_DIAG_THRESHOLDS_ENV = `${BRAND_FIXED_ENV_PREFIX}OOM_DIAG_THRESHOLDS_MB`;
export const OOM_DIAG_DIR_ENV = `${BRAND_FIXED_ENV_PREFIX}OOM_DIAG_DIR`;
export const DEFAULT_OOM_DIAG_THRESHOLDS_MB = [2560, 3072] as const;

const CHECK_INTERVAL_MS = 5_000;
const MAX_THRESHOLD_COUNT = 2;

interface OomDiagnosticsDependencies {
  env?: NodeJS.ProcessEnv;
  isBun?: boolean;
  pid?: number;
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
  cliVersion?: string;
  homeDir?: string;
  memoryUsage?: () => NodeJS.MemoryUsage;
  getHeapStatistics?: typeof v8.getHeapStatistics;
  writeHeapSnapshot?: typeof v8.writeHeapSnapshot;
  mkdirSync?: typeof fs.mkdirSync;
  writeFileSync?: typeof fs.writeFileSync;
  appendFileSync?: typeof fs.appendFileSync;
  setInterval?: (
    callback: () => void,
    delay: number,
  ) => NodeJS.Timeout;
  clearInterval?: (interval: NodeJS.Timeout) => void;
  getProcessLogPath?: () => string | undefined;
  now?: () => Date;
}

let timer: NodeJS.Timeout | null = null;
let clearActiveInterval: (interval: NodeJS.Timeout) => void = (interval) =>
  globalThis.clearInterval(interval);

function mbFromBytes(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

export function parseOomDiagnosticThresholds(
  raw: string | undefined,
): number[] {
  return parseThresholdConfig(raw).thresholds;
}

function parseThresholdConfig(raw: string | undefined): {
  thresholds: number[];
  valid: boolean;
} {
  if (raw === undefined || raw.trim() === '') {
    return {
      thresholds: [...DEFAULT_OOM_DIAG_THRESHOLDS_MB],
      valid: true,
    };
  }

  const parts = raw.split(',').map((part) => part.trim());
  const values = parts.map(Number);
  if (
    parts.length > MAX_THRESHOLD_COUNT ||
    parts.some((part) => part === '') ||
    values.some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    )
  ) {
    return {
      thresholds: [...DEFAULT_OOM_DIAG_THRESHOLDS_MB],
      valid: false,
    };
  }

  return {
    thresholds: [...new Set(values)].sort((left, right) => left - right),
    valid: true,
  };
}

function isExplicitlyEnabled(value: string | undefined): boolean {
  return value === '1';
}

function isBunRuntime(): boolean {
  return Boolean(
    (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun,
  );
}

export function startOomDiagnostics(
  dependencies: OomDiagnosticsDependencies = {},
): void {
  if (timer) return;

  const env = dependencies.env ?? process.env;
  if (!isExplicitlyEnabled(env[OOM_DIAG_ENABLED_ENV])) return;

  if (dependencies.isBun ?? isBunRuntime()) {
    runLogger.warn(
      '[oom-diag] OOM diagnostics are only supported by the Node.js runtime; skipping on Bun.',
    );
    return;
  }

  const thresholdConfig = parseThresholdConfig(
    env[OOM_DIAG_THRESHOLDS_ENV],
  );
  const thresholds = thresholdConfig.thresholds;
  const rawThresholds = env[OOM_DIAG_THRESHOLDS_ENV];
  if (!thresholdConfig.valid) {
    runLogger.warn(
      `[oom-diag] Invalid ${OOM_DIAG_THRESHOLDS_ENV}="${rawThresholds}"; using defaults ${DEFAULT_OOM_DIAG_THRESHOLDS_MB.join(',')}MB.`,
    );
  }

  const pid = dependencies.pid ?? process.pid;
  const outputDir =
    env[OOM_DIAG_DIR_ENV] ||
    path.join(
      dependencies.homeDir ?? os.homedir(),
      `${BRAND_TEMP_PATH_SLUG}-oom-diag`,
      `run-${pid}`,
    );
  const mkdirSync = dependencies.mkdirSync ?? fs.mkdirSync;
  try {
    mkdirSync(outputDir, { recursive: true });
  } catch (error) {
    runLogger.warn(
      `[oom-diag] Failed to create output directory ${outputDir}: ${String(error)}`,
    );
    return;
  }

  const memoryUsage = dependencies.memoryUsage ?? process.memoryUsage;
  const getHeapStatistics =
    dependencies.getHeapStatistics ?? v8.getHeapStatistics;
  const writeHeapSnapshot =
    dependencies.writeHeapSnapshot ?? v8.writeHeapSnapshot;
  const writeFileSync = dependencies.writeFileSync ?? fs.writeFileSync;
  const appendFileSync = dependencies.appendFileSync ?? fs.appendFileSync;
  const getProcessLogPath =
    dependencies.getProcessLogPath ??
    (() => diagnosticLogger.getProcessLogPath());
  const now = dependencies.now ?? (() => new Date());
  const infoFilePath = path.join(outputDir, 'oom-diag-info.txt');
  let heapLimitMb: number;
  try {
    heapLimitMb = mbFromBytes(getHeapStatistics().heap_size_limit);
  } catch (error) {
    runLogger.warn(
      `[oom-diag] Failed to read heap statistics: ${String(error)}`,
    );
    return;
  }

  try {
    const header = [
      '[OOM Diagnostics]',
      `time: ${now().toISOString()}`,
      `cli version: ${dependencies.cliVersion ?? env['CLI_VERSION'] ?? 'unknown'}`,
      `pid: ${pid}`,
      `platform: ${dependencies.platform ?? process.platform}`,
      `arch: ${dependencies.arch ?? process.arch}`,
      `runtime: node ${dependencies.nodeVersion ?? process.versions.node}`,
      `heap limit: ${heapLimitMb}MB`,
      `thresholds: ${thresholds.join(',')}MB`,
      `NODE_OPTIONS: ${env['NODE_OPTIONS'] ?? ''}`,
      `${PROCESS_LOG_FILE_NAME}: ${getProcessLogPath() ?? 'unknown'}`,
      '',
      '--- Files (send this whole folder) ---',
      '',
      '(waiting for heap to cross thresholds)',
      '',
    ].join('\n');
    writeFileSync(infoFilePath, header);
  } catch (error) {
    runLogger.warn(
      `[oom-diag] Failed to initialize ${infoFilePath}: ${String(error)}`,
    );
  }

  runLogger.log(
    `[oom-diag] active, heap limit=${heapLimitMb}MB, thresholds=${thresholds.join(',')}MB, output dir=${outputDir}`,
  );
  if (heapLimitMb < thresholds[0]) {
    runLogger.warn(
      `[oom-diag] Heap limit ${heapLimitMb}MB is below the first threshold ${thresholds[0]}MB; only the Node.js near-heap-limit snapshot may fire.`,
    );
  }

  const taken = new Set<number>();
  let lastSnapshotHeapUsedMb: number | undefined;
  const checkAndDump = () => {
    const heapUsedMb = mbFromBytes(memoryUsage().heapUsed);
    if (
      lastSnapshotHeapUsedMb !== undefined &&
      heapUsedMb <= lastSnapshotHeapUsedMb
    ) {
      return;
    }
    const threshold = thresholds.find(
      (candidate) => !taken.has(candidate) && heapUsedMb >= candidate,
    );
    if (threshold === undefined) return;

    // Mark before the synchronous write so a failed snapshot is not retried
    // every five seconds under severe memory pressure.
    taken.add(threshold);
    lastSnapshotHeapUsedMb = heapUsedMb;
    const snapshotNumber = taken.size;
    const target = path.join(
      outputDir,
      `snapshot${snapshotNumber}-${heapUsedMb.toFixed(0)}MB-${now().getTime()}.heapsnapshot`,
    );
    runLogger.warn(
      `[oom-diag] Heap reached ${heapUsedMb.toFixed(0)}MB (threshold ${threshold}MB), writing snapshot${snapshotNumber}.`,
    );
    try {
      const snapshotPath = writeHeapSnapshot(target);
      runLogger.warn(
        `[oom-diag] snapshot${snapshotNumber} written: ${snapshotPath}`,
      );
      try {
        appendFileSync(infoFilePath, `${snapshotPath}\n`);
      } catch (error) {
        runLogger.warn(
          `[oom-diag] Failed to append snapshot path to ${infoFilePath}: ${String(error)}`,
        );
      }
    } catch (error) {
      runLogger.warn(
        `[oom-diag] Failed to write snapshot${snapshotNumber}: ${String(error)}`,
      );
    }
  };

  const setIntervalFn =
    dependencies.setInterval ??
    ((callback, delay) => globalThis.setInterval(callback, delay));
  clearActiveInterval =
    dependencies.clearInterval ??
    ((interval) => globalThis.clearInterval(interval));
  timer = setIntervalFn(checkAndDump, CHECK_INTERVAL_MS);
  timer.unref();
}

export function stopOomDiagnostics(): void {
  if (!timer) return;
  clearActiveInterval(timer);
  timer = null;
}
