/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { AppendChannel } from './append-channel.js';
import type { TranscriptFileSystem } from './append-channel-file-system.js';
import type { FileHandle } from 'node:fs/promises';

function createMockFileSystem(): TranscriptFileSystem & {
  files: Map<string, Buffer>;
} {
  const files = new Map<string, Buffer>();
  return {
    files,
    mkdir: vi.fn().mockResolvedValue(undefined),
    open: vi.fn(async (filePath, flags) => {
      if (flags === 'a' || flags === 'a+') {
        if (!files.has(filePath)) {
          files.set(filePath, Buffer.alloc(0));
        }
      }
      if (flags === 'wx') {
        if (files.has(filePath)) {
          const error = new Error('EEXIST') as NodeJS.ErrnoException;
          error.code = 'EEXIST';
          throw error;
        }
        files.set(filePath, Buffer.alloc(0));
      }
      const buffer = files.get(filePath) ?? Buffer.alloc(0);
      return {
        stat: async () => ({
          size: buffer.length,
        }),
        read: async (
          b: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          const pos = position === null ? buffer.length : position;
          const copied = buffer.copy(b, offset, pos, pos + length);
          return { bytesRead: copied };
        },
        write: async (
          data: Buffer,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          const dataBuffer = data.subarray(offset, offset + length);
          const pos = position === null ? buffer.length : position;
          const before = buffer.subarray(0, pos);
          const after = buffer.subarray(pos + dataBuffer.length);
          files.set(filePath, Buffer.concat([before, dataBuffer, after]));
          return { bytesWritten: dataBuffer.length };
        },
        writeFile: async (data: Buffer) => {
          files.set(filePath, Buffer.from(data));
        },
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as FileHandle;
    }),
    appendFile: vi.fn(async (filePath, data) => {
      const existing = files.get(filePath) ?? Buffer.alloc(0);
      files.set(filePath, Buffer.concat([existing, Buffer.from(data)]));
    }),
    rm: vi.fn(async (filePath) => {
      files.delete(filePath);
    }),
  };
}

describe('AppendChannel', () => {
  it('appends encoded JSONL entries', async () => {
    const fs = createMockFileSystem();
    const channel = new AppendChannel({
      filePath: '/tmp/t.jsonl',
      fileSystem: fs,
      flushIntervalMs: 0,
    });

    await channel.append([
      { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', parentUuid: null, isSidechain: false, cwd: '/', sessionId: 's1', userType: 'external', version: '1', message: {} },
    ]);
    await channel.flush();

    const content = fs.files.get('/tmp/t.jsonl')?.toString('utf8');
    expect(content).toContain('"type":"user"');
    expect(content).toContain('"uuid":"u1"');
    expect(content?.endsWith('\n')).toBe(true);
  });

  it('ensures a trailing newline before appending', async () => {
    const fs = createMockFileSystem();
    fs.files.set('/tmp/t.jsonl', Buffer.from('existing'));
    const channel = new AppendChannel({
      filePath: '/tmp/t.jsonl',
      fileSystem: fs,
      flushIntervalMs: 0,
    });

    await channel.append([
      { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', parentUuid: null, isSidechain: false, cwd: '/', sessionId: 's1', userType: 'external', version: '1', message: {} },
    ]);
    await channel.flush();

    const content = fs.files.get('/tmp/t.jsonl')?.toString('utf8');
    expect(content).toMatch(/existing\n.*"type":"user"/s);
  });

  it('reads all committed data', async () => {
    const fs = createMockFileSystem();
    fs.files.set('/tmp/t.jsonl', Buffer.from('{"type":"user"}\n'));
    const channel = new AppendChannel({
      filePath: '/tmp/t.jsonl',
      fileSystem: fs,
    });

    const all = await channel.readAll();
    expect(all.toString('utf8')).toBe('{"type":"user"}\n');
  });

  it('poisons itself after a file system failure', async () => {
    const fs = createMockFileSystem();
    fs.appendFile = vi.fn().mockRejectedValue(new Error('disk full'));
    const channel = new AppendChannel({
      filePath: '/tmp/t.jsonl',
      fileSystem: fs,
      flushIntervalMs: 0,
    });

    await expect(
      channel.append([
        { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', parentUuid: null, isSidechain: false, cwd: '/', sessionId: 's1', userType: 'external', version: '1', message: {} },
      ]),
    ).rejects.toThrow('disk full');

    expect(() => channel.append([])).toThrow('disk full');
  });

  it('does not poison the channel when a commit observer fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fs = createMockFileSystem();
    const channel = new AppendChannel({
      filePath: '/tmp/t.jsonl',
      fileSystem: fs,
      flushIntervalMs: 0,
      commitObserver: vi.fn().mockRejectedValue(new Error('observer failed')),
    });

    await channel.append([
      { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', parentUuid: null, isSidechain: false, cwd: '/', sessionId: 's1', userType: 'external', version: '1', message: {} },
    ]);
    await channel.flush();

    expect(fs.files.get('/tmp/t.jsonl')?.toString('utf8')).toContain('"type":"user"');

    await channel.append([
      { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01.000Z', parentUuid: 'u1', isSidechain: false, cwd: '/', sessionId: 's1', userType: 'external', version: '1', message: {} },
    ]);
    await channel.close();
    warnSpy.mockRestore();
  });

  it('closes cleanly and rejects further appends', async () => {
    const fs = createMockFileSystem();
    const channel = new AppendChannel({
      filePath: '/tmp/t.jsonl',
      fileSystem: fs,
    });

    await channel.close();
    expect(() =>
      channel.append([
        { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', parentUuid: null, isSidechain: false, cwd: '/', sessionId: 's1', userType: 'external', version: '1', message: {} },
      ]),
    ).toThrow('AppendChannel is closed');
  });

  it('creates a transcript exclusively', async () => {
    const fs = createMockFileSystem();
    const channel = new AppendChannel({
      filePath: '/tmp/t.jsonl',
      fileSystem: fs,
    });

    await channel.createExclusive([
      { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', parentUuid: null, isSidechain: false, cwd: '/', sessionId: 's1', userType: 'external', version: '1', message: {} },
    ]);

    const content = fs.files.get('/tmp/t.jsonl')?.toString('utf8');
    expect(content).toContain('"type":"user"');
  });

  it('deletes the transcript file', async () => {
    const fs = createMockFileSystem();
    fs.files.set('/tmp/t.jsonl', Buffer.from('old'));
    const channel = new AppendChannel({
      filePath: '/tmp/t.jsonl',
      fileSystem: fs,
    });

    await channel.deleteFile();
    expect(fs.files.has('/tmp/t.jsonl')).toBe(false);
  });
});
