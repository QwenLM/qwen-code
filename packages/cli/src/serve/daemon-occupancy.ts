/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { DaemonDiscoveryEntry } from './daemon-discovery.js';
import type { StreamOccupancySnapshot } from './sse-occupancy.js';

const SNAPSHOT_VERSION = 1;
const REFRESH_INTERVAL_MS = 5_000;
const STALE_AFTER_MS = 3 * REFRESH_INTERVAL_MS;

export interface DaemonOccupancySample {
  asOf: string;
  total: number;
  bySurface: Record<string, number>;
  byListener: Record<string, number>;
  stale: boolean;
}

function snapshotPath({ record, path: discoveryPath }: DaemonDiscoveryEntry) {
  const identity = createHash('sha256')
    .update(
      JSON.stringify([
        record.port,
        record.pid,
        record.startedAt,
        record.pidNamespace,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
  return path.join(
    path.dirname(discoveryPath),
    `occupancy-${record.port}-${identity}.json`,
  );
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBreakdown(
  value: unknown,
  total: number,
): value is Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const counts: unknown[] = Object.values(value);
  return (
    counts.length > 0 &&
    counts.every(isCount) &&
    counts.reduce((sum, count) => sum + count, 0) === total
  );
}

export function readDaemonOccupancy(
  entry: DaemonDiscoveryEntry,
): DaemonOccupancySample | undefined {
  const target = snapshotPath(entry);
  let data: unknown;
  try {
    if (!fs.lstatSync(target).isFile()) return undefined;
    data = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return undefined;
  }
  if (data === null || typeof data !== 'object') return undefined;
  const { v, asOf, total, bySurface, byListener } = data as Record<
    string,
    unknown
  >;
  if (
    v !== SNAPSHOT_VERSION ||
    typeof asOf !== 'string' ||
    !isCount(total) ||
    !isBreakdown(bySurface, total) ||
    !isBreakdown(byListener, total)
  ) {
    return undefined;
  }
  const sampleTime = Date.parse(asOf);
  if (!Number.isFinite(sampleTime)) return undefined;
  const age = Date.now() - sampleTime;
  return {
    asOf: new Date(sampleTime).toISOString(),
    total,
    bySurface,
    byListener,
    stale: age < 0 || age >= STALE_AFTER_MS,
  };
}

export function removeDaemonOccupancy(entry: DaemonDiscoveryEntry): void {
  try {
    fs.rmSync(snapshotPath(entry), { force: true });
  } catch {
    // The remaining file is only addressable by its original discovery record.
  }
}

export function startDaemonOccupancyPublisher(
  entry: DaemonDiscoveryEntry,
  getOccupancy: () => StreamOccupancySnapshot,
  onWriteError: (error: unknown) => void,
): () => Promise<void> {
  const target = snapshotPath(entry);
  let pending: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let reportedFailure = false;

  async function publish(): Promise<void> {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const payload = {
        v: SNAPSHOT_VERSION,
        asOf: new Date().toISOString(),
        ...getOccupancy(),
      };
      await fsp.writeFile(temporary, `${JSON.stringify(payload)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      await fsp.rename(temporary, target);
      reportedFailure = false;
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => {});
      if (!reportedFailure) {
        reportedFailure = true;
        try {
          onWriteError(error);
        } catch {
          // A failed diagnostic sink must not interrupt snapshot refreshes.
        }
      }
    }
  }

  function refresh(): void {
    if (pending || stopping) return;
    pending = publish().finally(() => {
      pending = undefined;
    });
  }

  const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
  timer.unref();
  refresh();
  return () => {
    if (!stopping) {
      clearInterval(timer);
      // The process exit handler cannot await I/O. A graceful close also
      // joins any rename already in flight and clears its result.
      removeDaemonOccupancy(entry);
      stopping = pending
        ? pending.then(() => fsp.rm(target, { force: true }).catch(() => {}))
        : Promise.resolve();
    }
    return stopping;
  };
}
