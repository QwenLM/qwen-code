/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { WriterCoordinator } from './writer-coordinator.js';
import type { TranscriptFileSystem } from './append-channel-file-system.js';
import type { TranscriptPathFileSystem } from '../path/transcript-path-file-system.js';
import type { FileHandle } from 'node:fs/promises';

function createMockFileSystem(): TranscriptFileSystem &
  TranscriptPathFileSystem & {
    files: Map<string, Buffer>;
  } {
  const files = new Map<string, Buffer>();
  return {
    files,
    realpath: vi.fn(async (p) => p),
    mkdir: vi.fn().mockResolvedValue(undefined),
    open: vi.fn(async (filePath, flags) => {
      if (flags === 'a' && !files.has(filePath)) {
        files.set(filePath, Buffer.alloc(0));
      }
      const buffer = files.get(filePath) ?? Buffer.alloc(0);
      return {
        stat: async () => ({ size: buffer.length }),
        read: async (b: Buffer, offset: number, length: number, position: number) => {
          const copied = buffer.copy(b, offset, position, position + length);
          return { bytesRead: copied };
        },
        write: async (data: string, position: number) => {
          const dataBuffer = Buffer.from(data, 'utf8');
          const before = buffer.subarray(0, position);
          const after = buffer.subarray(position + dataBuffer.length);
          files.set(filePath, Buffer.concat([before, dataBuffer, after]));
          return { bytesWritten: dataBuffer.length };
        },
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as FileHandle;
    }),
    appendFile: vi.fn(async (filePath, data) => {
      const existing = files.get(filePath) ?? Buffer.alloc(0);
      files.set(filePath, Buffer.concat([existing, Buffer.from(data)]));
    }),
    rm: vi.fn().mockResolvedValue(undefined),
  };
}

describe('WriterCoordinator', () => {
  it('acquires one append channel per canonical path', async () => {
    const fs = createMockFileSystem();
    const coordinator = new WriterCoordinator({ fileSystem: fs });

    const leaseA = await coordinator.acquire('/tmp/t.jsonl');
    const leaseB = await coordinator.acquire('/tmp/t.jsonl');

    expect(leaseA.filePath).toBe('/tmp/t.jsonl');
    expect(leaseB.filePath).toBe('/tmp/t.jsonl');

    await leaseA.append([
      { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', parentUuid: null, isSidechain: false, cwd: '/', sessionId: 's1', userType: 'external', version: '1', message: {} },
    ]);
    await leaseA.release();
    await leaseB.release();

    const content = fs.files.get('/tmp/t.jsonl')?.toString('utf8');
    expect(content).toContain('"uuid":"u1"');
  });

  it('flushes all channels', async () => {
    const fs = createMockFileSystem();
    const coordinator = new WriterCoordinator({ fileSystem: fs });

    const lease = await coordinator.acquire('/tmp/t.jsonl');
    await lease.append([
      { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', parentUuid: null, isSidechain: false, cwd: '/', sessionId: 's1', userType: 'external', version: '1', message: {} },
    ]);
    await coordinator.flushAll();

    expect(fs.files.get('/tmp/t.jsonl')?.length).toBeGreaterThan(0);
    await lease.release();
  });

  it('closes all channels', async () => {
    const fs = createMockFileSystem();
    const coordinator = new WriterCoordinator({ fileSystem: fs });

    const lease = await coordinator.acquire('/tmp/t.jsonl');
    await lease.release();
    await coordinator.close();

    await expect(coordinator.acquire('/tmp/t.jsonl')).rejects.toThrow('closed');
  });
});
