/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileTooLargeError, readFileInRange } from './readFileInRange.js';
import {
  READ_FILE_TIMEOUT_MS,
  ReadFileTimeoutError,
  runReadFileExecution,
} from './readFileExecution.js';
import { emitReadFileDiagnostic } from './diagnosticInterceptors.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: vi.fn(actual.stat),
    readFile: vi.fn(actual.readFile),
  };
});
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});
vi.mock('./diagnosticInterceptors.js', () => ({
  emitReadFileDiagnostic: vi.fn(),
}));

// 验证真实读取入口的阶段观测和流取消，不依赖挂起用户文件系统。
describe('Read I/O cancellation', () => {
  let directory: string;
  let filePath: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'read-deadline-'));
    filePath = path.join(directory, 'file.txt');
    await fsp.writeFile(filePath, 'hello\nworld');
  });
  afterEach(async () => {
    vi.useRealTimers();
    await fsp.rm(directory, { recursive: true, force: true });
  });

  it.each(['stat', 'read_file'] as const)(
    'bounds a stalled %s through the actual range reader',
    async (phase) => {
      let started!: () => void;
      const ioStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let finish!: () => void;
      const native =
        await vi.importActual<typeof import('node:fs/promises')>(
          'node:fs/promises',
        );
      const stats = await native.stat(filePath);
      if (phase === 'stat') {
        vi.mocked(fsp.stat).mockImplementationOnce(() => {
          started();
          return new Promise((resolve) => {
            finish = () => resolve(stats);
          });
        });
      } else {
        vi.mocked(fsp.readFile).mockImplementationOnce(() => {
          started();
          return new Promise((resolve) => {
            finish = () => resolve('late content');
          });
        });
      }
      vi.useFakeTimers();
      const publish = vi.fn();
      const pending = runReadFileExecution(
        new AbortController().signal,
        async (signal) => {
          const value = await readFileInRange(
            filePath,
            0,
            undefined,
            undefined,
            signal,
          );
          publish(value);
          return { llmContent: value.content, returnDisplay: value.content };
        },
      );
      const outcome = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      await ioStarted;
      await vi.advanceTimersByTimeAsync(READ_FILE_TIMEOUT_MS);
      expect(await outcome).toBeInstanceOf(ReadFileTimeoutError);
      expect(emitReadFileDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            event: 'finished',
            status: 'timeout',
            phases: [phase],
          }),
        }),
      );
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(publish).not.toHaveBeenCalled();
      if (phase === 'read_file') {
        const options = vi.mocked(fsp.readFile).mock.calls[0][1] as {
          signal: AbortSignal;
        };
        expect(options.signal.aborted).toBe(true);
      }
    },
  );

  it('closes a streaming file descriptor whose open callback arrives after timeout', async () => {
    const native = await vi.importActual<typeof import('node:fs')>('node:fs');
    const stats = await fsp.stat(filePath);
    vi.mocked(fsp.stat).mockResolvedValueOnce(
      Object.assign(stats, { size: 11 * 1024 * 1024 }),
    );
    let finishOpen!: () => void;
    let started!: () => void;
    const opening = new Promise<void>((resolve) => {
      started = resolve;
    });
    let closed!: () => void;
    const closeFinished = new Promise<void>((resolve) => {
      closed = resolve;
    });
    vi.mocked(fs.createReadStream).mockImplementationOnce((name, options) =>
      native.createReadStream(name, {
        ...(typeof options === 'object' ? options : {}),
        fs: {
          open(name, flags, mode, callback) {
            finishOpen = () => native.open(name, flags, mode, callback);
            started();
          },
          read: native.read,
          close(fd, callback) {
            native.close(fd, (error) => {
              callback(error);
              closed();
            });
          },
        },
      }),
    );
    vi.useFakeTimers();
    const pending = runReadFileExecution(
      new AbortController().signal,
      async (signal) => {
        const value = await readFileInRange(
          filePath,
          0,
          undefined,
          undefined,
          signal,
        );
        return { llmContent: value.content, returnDisplay: value.content };
      },
    );
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await opening;
    await vi.advanceTimersByTimeAsync(READ_FILE_TIMEOUT_MS);
    expect(await outcome).toBeInstanceOf(ReadFileTimeoutError);
    finishOpen();
    await closeFinished;
  });
});

describe('readFileInRange not-text detection', () => {
  // '// 刷新时间' encoded as GBK (CP936).
  const gbk = Buffer.from([
    0x2f, 0x2f, 0x20, 0xcb, 0xa2, 0xd0, 0xc2, 0xca, 0xb1, 0xbc, 0xe4, 0x0a,
  ]);
  let directory: string;
  let filePath: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'read-not-text-'));
    filePath = path.join(directory, 'file.cs');
  });
  afterEach(async () => {
    await fsp.rm(directory, { recursive: true, force: true });
  });

  async function readStreamingByteByByte(maxBytes?: number) {
    const native = await vi.importActual<typeof import('node:fs')>('node:fs');
    const stats = await fsp.stat(filePath);
    vi.mocked(fsp.stat).mockResolvedValueOnce(
      Object.assign(stats, { size: 11 * 1024 * 1024 }),
    );
    vi.mocked(fs.createReadStream).mockImplementationOnce((name, options) =>
      native.createReadStream(name, {
        ...(typeof options === 'object' ? options : {}),
        highWaterMark: 1,
      }),
    );
    return readFileInRange(filePath, 0, undefined, maxBytes);
  }

  it('counts split UTF-16LE surrogate pairs as complete characters', async () => {
    const bytes = Buffer.from('\uFEFF😀😀', 'utf16le');
    await fsp.writeFile(filePath, bytes);
    const result = await readStreamingByteByByte(bytes.length);
    expect(result.content).toBe('😀😀');
    expect(result.totalBytes).toBe(Buffer.byteLength('😀😀'));
    expect(result.readBytes).toBe(Buffer.byteLength('😀😀'));
  });

  it('flags legacy bytes on the fast path and keeps the lossy text', async () => {
    await fsp.writeFile(filePath, gbk);
    const result = await readFileInRange(filePath);
    expect(result.notText).toBe('not_utf8');
    expect(result.content).toBe(gbk.toString('utf8'));
  });

  it('flags legacy bytes on the streaming path', async () => {
    await fsp.writeFile(filePath, gbk);
    const result = await readStreamingByteByByte();
    expect(fs.createReadStream).toHaveBeenCalled();
    expect(result.notText).toBe('not_utf8');
    expect(result.content).toBe(gbk.toString('utf8'));
  });

  it('accepts UTF-8 split across stream chunks', async () => {
    await fsp.writeFile(filePath, '\uFEFF// 刷新时间 😀\r\nnext\n');
    const result = await readStreamingByteByByte();
    expect(result.notText).toBeUndefined();
    expect(result.content).toBe('// 刷新时间 😀\nnext\n');
    expect(result.totalLines).toBe(3);
  });

  it.each(['fast', 'streaming'] as const)(
    'decodes UTF-16LE with BOM on the %s path',
    async (mode) => {
      await fsp.writeFile(filePath, Buffer.from('\uFEFF// 刷新时间 😀\r\nnext\r\n', 'utf16le'));
      const result = mode === 'fast'
        ? await readFileInRange(filePath)
        : await readStreamingByteByByte();
      expect(result.notText).toBeUndefined();
      expect(result.content).toBe('// 刷新时间 😀\nnext\n');
      expect(result.totalLines).toBe(3);
    },
  );

  it.each([Buffer.alloc(0), Buffer.from('a')])(
    'reads a stream shorter than the BOM detection prefix',
    async (bytes) => {
      await fsp.writeFile(filePath, bytes);
      const result = await readStreamingByteByByte();
      expect(result.notText).toBeUndefined();
      expect(result.content).toBe(bytes.toString());
    },
  );

  it('flags a stream that ends inside a multibyte sequence', async () => {
    await fsp.writeFile(filePath, Buffer.from([0x61, 0xe5, 0x88]));
    const result = await readStreamingByteByByte();
    expect(result.notText).toBe('not_utf8');
  });

  it.each([
    ['incomplete UTF-8', Buffer.from([0x61, 0xe5]), 1, 4],
    ['incomplete encoding prefix', Buffer.from([0xe5]), 0, 3],
    ['unpaired UTF-16LE surrogate', Buffer.from('\uFEFFa\uD800', 'utf16le'), 1, 4],
  ] as const)(
    'rejects when flushing %s at EOF exceeds the byte limit',
    async (_name, bytes, maxBytes, decodedBytes) => {
      await fsp.writeFile(filePath, bytes);
      await expect(readStreamingByteByByte(maxBytes)).rejects.toEqual(
        new FileTooLargeError(decodedBytes, maxBytes),
      );
      const result = await readStreamingByteByByte(decodedBytes);
      expect(result.totalBytes).toBe(decodedBytes);
      expect(Buffer.byteLength(result.content)).toBe(decodedBytes);
    },
  );
});
