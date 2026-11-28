/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readDaemonDiscoveries,
  writeDaemonDiscovery,
  type DaemonDiscoveryEntry,
} from './daemon-discovery.js';
import {
  readDaemonOccupancy,
  startDaemonOccupancyPublisher,
} from './daemon-occupancy.js';
import type { StreamOccupancySnapshot } from './sse-occupancy.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

function occupancy(restEvents: number): StreamOccupancySnapshot {
  return {
    total: restEvents,
    bySurface: {
      restEvents,
      agentEvents: 0,
      generation: 0,
      artifactLibrary: 0,
      hostedEvents: 0,
      acpSse: 0,
      acpWs: 0,
    },
    byListener: { primary: restEvents, 'local-control': 0, 'remote-access': 0 },
  };
}

describe('daemon occupancy snapshots', () => {
  let dir: string;
  let entry: DaemonDiscoveryEntry;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-occupancy-'));
    const record = {
      v: 1 as const,
      port: 4170,
      pid: process.pid,
      hostname: '127.0.0.1',
      url: 'http://127.0.0.1:4170',
      primaryWorkspace: dir,
      workspaces: [dir],
      auth: 'none' as const,
      startedAt: new Date().toISOString(),
    };
    entry = { record, path: writeDaemonDiscovery(record, dir) };
  });

  afterEach(async () => {
    await stop?.();
    stop = undefined;
    vi.useRealTimers();
    vi.mocked(fsp.rename).mockClear();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('reads only complete, versioned samples from the matching daemon', async () => {
    expect(readDaemonOccupancy(entry)).toBeUndefined();
    stop = startDaemonOccupancyPublisher(entry, () => occupancy(2), vi.fn());
    await vi.waitFor(() => {
      expect(readDaemonOccupancy(entry)).toEqual({
        ...occupancy(2),
        asOf: expect.any(String),
        stale: false,
      });
    });
    expect(readDaemonDiscoveries(dir)).toEqual({
      entries: [entry],
      invalid: [],
    });
    expect(
      readDaemonOccupancy({
        ...entry,
        record: {
          ...entry.record,
          startedAt: new Date(
            Date.parse(entry.record.startedAt) + 1,
          ).toISOString(),
        },
      }),
    ).toBeUndefined();

    const name = (await fsp.readdir(dir)).find((file) =>
      file.startsWith('occupancy-'),
    );
    expect(name).toBeDefined();
    const file = path.join(dir, name!);
    if (process.platform !== 'win32') {
      expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
    }
    const sample = JSON.parse(await fsp.readFile(file, 'utf8'));
    await fsp.writeFile(
      file,
      JSON.stringify({
        ...sample,
        asOf: new Date(Date.now() - 16_000).toISOString(),
      }),
    );
    expect(readDaemonOccupancy(entry)?.stale).toBe(true);
    await fsp.writeFile(file, JSON.stringify({ ...sample, total: 3 }));
    expect(readDaemonOccupancy(entry)).toBeUndefined();
    await fsp.writeFile(file, '{"v":1,');
    expect(readDaemonOccupancy(entry)).toBeUndefined();
    await stop();
    expect(await fsp.readdir(dir)).toEqual([path.basename(entry.path)]);
  });

  it('preserves the previous sample when a refresh fails and retries on the next tick', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const getOccupancy = vi.fn(() => occupancy(1));
    const onWriteError = vi.fn(() => {
      throw new Error('diagnostic sink unavailable');
    });
    stop = startDaemonOccupancyPublisher(entry, getOccupancy, onWriteError);
    await vi.waitFor(() => {
      expect(readDaemonOccupancy(entry)?.total).toBe(1);
    });
    getOccupancy.mockReturnValue(occupancy(3));
    vi.mocked(fsp.rename).mockRejectedValueOnce(new Error('rename failed'));

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => {
      expect(onWriteError).toHaveBeenCalledOnce();
    });
    expect(readDaemonOccupancy(entry)?.total).toBe(1);
    expect((await fsp.readdir(dir)).some((file) => file.endsWith('.tmp'))).toBe(
      false,
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => {
      expect(readDaemonOccupancy(entry)?.total).toBe(3);
    });
  });

  it('joins a pending write during shutdown without queuing more samples', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    let allowRename!: () => void;
    const readyToRename = new Promise<void>((resolve) => {
      allowRename = resolve;
    });
    vi.mocked(fsp.rename).mockImplementationOnce(async (from, to) => {
      await readyToRename;
      await actual.rename(from, to);
    });
    const getOccupancy = vi.fn(() => occupancy(1));
    stop = startDaemonOccupancyPublisher(entry, getOccupancy, vi.fn());
    try {
      await vi.waitFor(() => {
        expect(fsp.rename).toHaveBeenCalledOnce();
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(getOccupancy).toHaveBeenCalledOnce();
      let stopped = false;
      const closing = stop().then(() => {
        stopped = true;
      });
      await new Promise(setImmediate);
      expect(stopped).toBe(false);
      allowRename();
      await closing;
      expect(await fsp.readdir(dir)).toEqual([path.basename(entry.path)]);
    } finally {
      allowRename();
    }
  });
});
