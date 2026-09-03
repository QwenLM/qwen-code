/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  bridgeAgentViewTerminal,
  type AgentViewTerminalBytes,
  type AgentViewTerminalDisposable,
  type AgentViewTerminalPty,
  type AgentViewTerminalSize,
} from './terminal-bridge.js';

describe('bridgeAgentViewTerminal', () => {
  it('writes AsyncIterable stdin bytes into the PTY', async () => {
    const pty = new FakeTerminalPty();
    const stdout = new MemoryWritable();

    await expect(
      bridgeAgentViewTerminal({
        stdin: bytes(['hello ', Buffer.from('world')]),
        stdout,
        pty,
      }),
    ).resolves.toEqual({ reason: 'stdin-ended' });

    expect(pty.input()).toBe('hello world');
  });

  it('preserves Uint8Array subarray offsets when writing stdin bytes', async () => {
    const pty = new FakeTerminalPty();
    const chunk = new Uint8Array([0, 104, 101, 108, 108, 111, 0]).subarray(
      1,
      6,
    );

    await expect(
      bridgeAgentViewTerminal({
        stdin: bytes([chunk]),
        stdout: new MemoryWritable(),
        pty,
      }),
    ).resolves.toEqual({ reason: 'stdin-ended' });

    expect(pty.input()).toBe('hello');
  });

  it('writes Readable stdin bytes into the PTY', async () => {
    const pty = new FakeTerminalPty();

    await bridgeAgentViewTerminal({
      stdin: Readable.from([Buffer.from('abc'), Buffer.from('123')]),
      stdout: new MemoryWritable(),
      pty,
    });

    expect(pty.input()).toBe('abc123');
  });

  it('writes PTY output bytes to stdout', async () => {
    const pty = new FakeTerminalPty();
    const stdout = new MemoryWritable();
    const done = bridgeAgentViewTerminal({
      stdin: bytes(['input']),
      stdout,
      pty,
    });

    pty.emitData('output ');
    pty.emitData(Buffer.from('bytes'));

    await done;
    expect(stdout.output()).toBe('output bytes');
  });

  it('detaches when stdout write fails after output closes', async () => {
    const pty = new FakeTerminalPty();
    let releaseInput: (() => void) | undefined;
    const done = bridgeAgentViewTerminal({
      stdin: delayedInput((release) => {
        releaseInput = release;
      }),
      stdout: new FailingWritable(),
      pty,
    });

    pty.emitData('output');

    await expect(done).resolves.toEqual({ reason: 'detached' });
    releaseInput?.();
  });

  it('forwards resize events to the PTY', async () => {
    const pty = new FakeTerminalPty();
    let resize: ((size: AgentViewTerminalSize) => void) | undefined;
    let releaseInput: (() => void) | undefined;
    const done = bridgeAgentViewTerminal({
      stdin: delayedInput((release) => {
        releaseInput = release;
      }),
      stdout: new MemoryWritable(),
      pty,
      onResize: (callback) => {
        resize = callback;
      },
    });

    resize?.({ columns: 120, rows: 40 });
    releaseInput?.();
    await done;

    expect(pty.resizes).toEqual([{ columns: 120, rows: 40 }]);
  });

  it('swallows a rejecting pty.resize without an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let resize: ((size: AgentViewTerminalSize) => void) | undefined;
      let releaseInput: (() => void) | undefined;
      const pty: AgentViewTerminalPty = {
        write: () => {},
        onData: () => ({ dispose: () => {} }),
        resize: () => Promise.reject(new Error('pty gone')),
      };
      const done = bridgeAgentViewTerminal({
        stdin: delayedInput((release) => {
          releaseInput = release;
        }),
        stdout: new MemoryWritable(),
        pty,
        onResize: (callback) => {
          resize = callback;
        },
      });

      resize?.({ columns: 120, rows: 40 });
      // Let the rejected resize promise settle before ending the bridge.
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseInput?.();

      await expect(done).resolves.toEqual({ reason: 'stdin-ended' });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', unhandled);
    }
  });

  it('disposes listeners and resolves when detached', async () => {
    const pty = new FakeTerminalPty();
    const stdout = new MemoryWritable();
    const controller = new AbortController();
    let releaseInput: (() => void) | undefined;
    const done = bridgeAgentViewTerminal({
      stdin: delayedInput((release) => {
        releaseInput = release;
      }),
      stdout,
      pty,
      detachSignal: controller.signal,
    });

    pty.emitData('before');
    controller.abort();
    pty.emitData('after');
    releaseInput?.();

    await expect(done).resolves.toEqual({ reason: 'detached' });
    expect(stdout.output()).toBe('before');
    expect(pty.listenerCount).toBe(0);
  });

  it('detaches immediately when the detach signal is already aborted', async () => {
    const pty = new FakeTerminalPty();
    const controller = new AbortController();
    controller.abort();

    await expect(
      bridgeAgentViewTerminal({
        stdin: bytes(['late input']),
        stdout: new MemoryWritable(),
        pty,
        detachSignal: controller.signal,
      }),
    ).resolves.toEqual({ reason: 'detached' });

    expect(pty.input()).toBe('');
  });

  it('does not destroy Readable stdin when detached', async () => {
    const pty = new FakeTerminalPty();
    const stdin = new Readable({
      read() {},
    });
    const controller = new AbortController();
    const done = bridgeAgentViewTerminal({
      stdin,
      stdout: new MemoryWritable(),
      pty,
      detachSignal: controller.signal,
    });

    controller.abort();

    await expect(done).resolves.toEqual({ reason: 'detached' });
    expect(stdin.destroyed).toBe(false);
    stdin.destroy();
  });

  it('continues disposing listeners after one dispose throws', async () => {
    const disposed: string[] = [];
    const pty: AgentViewTerminalPty = {
      write: () => {},
      onData: () => ({
        dispose: () => {
          disposed.push('data');
          throw new Error('dispose failed');
        },
      }),
      resize: () => {},
    };

    await expect(
      bridgeAgentViewTerminal({
        stdin: bytes([]),
        stdout: new MemoryWritable(),
        pty,
        onResize: () => ({
          dispose: () => {
            disposed.push('resize');
          },
        }),
      }),
    ).resolves.toEqual({ reason: 'stdin-ended' });

    expect(disposed).toEqual(['data', 'resize']);
  });

  it('cleans up setup listeners when resize registration throws', async () => {
    const disposed: string[] = [];
    const stdout = new MemoryWritable();
    const pty: AgentViewTerminalPty = {
      write: () => {},
      onData: () => ({
        dispose: () => {
          disposed.push('data');
        },
      }),
    };

    await expect(
      bridgeAgentViewTerminal({
        stdin: bytes([]),
        stdout,
        pty,
        onResize: () => {
          throw new Error('resize registration failed');
        },
      }),
    ).rejects.toThrow('resize registration failed');

    expect(disposed).toEqual(['data']);
    expect(stdout.listenerCount('error')).toBe(0);
  });

  it('ignores iterator return rejections on detach', async () => {
    const pty = new FakeTerminalPty();
    const controller = new AbortController();
    const stdin: AsyncIterable<AgentViewTerminalBytes> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<AgentViewTerminalBytes>>(() => {}),
        return: () => Promise.reject(new Error('return failed')),
      }),
    };
    const done = bridgeAgentViewTerminal({
      stdin,
      stdout: new MemoryWritable(),
      pty,
      detachSignal: controller.signal,
    });

    controller.abort();

    await expect(done).resolves.toEqual({ reason: 'detached' });
  });

  it('detaches when a PTY write fails', async () => {
    const pty: AgentViewTerminalPty = {
      write: () => Promise.reject(new Error('pty closed')),
      onData: () => ({ dispose: () => {} }),
    };

    await expect(
      bridgeAgentViewTerminal({
        stdin: bytes(['input']),
        stdout: new MemoryWritable(),
        pty,
      }),
    ).resolves.toEqual({ reason: 'detached' });
  });

  it('drains pending stdout writes when the input pump fails', async () => {
    const pty = new FakeTerminalPty();
    const stdout = new DeferredWritable();
    const stdin: AsyncIterable<AgentViewTerminalBytes> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          Promise.reject<IteratorResult<AgentViewTerminalBytes>>(
            new Error('stdin failed'),
          ),
      }),
    };

    const done = bridgeAgentViewTerminal({ stdin, stdout, pty });
    pty.emitData('output');

    // Let microtasks settle: the output write reaches DeferredWritable._write
    // (which defers the callback) and the pump failure reaches the finally.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The bridge must not settle while the write callback is deferred.
    let settled = false;
    void done.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    stdout.flush();
    await expect(done).rejects.toThrow('stdin failed');
    expect(stdout.output()).toBe('output');
  });

  it('pauses the PTY source when stdout signals backpressure', async () => {
    const pty = new FakeTerminalPty();
    const stdout = new BackpressureWritable();
    let releaseInput: (() => void) | undefined;
    const done = bridgeAgentViewTerminal({
      stdin: delayedInput((release) => {
        releaseInput = release;
      }),
      stdout,
      pty,
    });

    pty.emitData('x'.repeat(64));

    // Let the chained write execute: stdout.write returns false, bridge pauses.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pty.paused).toBe(true);

    // Flush stdout so the internal buffer drains and 'drain' fires.
    stdout.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pty.paused).toBe(false);

    releaseInput?.();
    await done;
    expect(stdout.output()).toBe('x'.repeat(64));
  });

  it('resumes the PTY when the bridge aborts with a pending backpressured write', async () => {
    const pty = new FakeTerminalPty();
    const stdout = new BackpressureWritable();
    const controller = new AbortController();
    let releaseInput: (() => void) | undefined;
    const done = bridgeAgentViewTerminal({
      stdin: delayedInput((release) => {
        releaseInput = release;
      }),
      stdout,
      pty,
      detachSignal: controller.signal,
    });

    pty.emitData('x'.repeat(64));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pty.paused).toBe(true);

    // Abort while the write callback is still deferred.
    controller.abort();
    releaseInput?.();

    // The bridge drains pending writes before settling, so flush the callback.
    stdout.flush();
    await expect(done).resolves.toEqual({ reason: 'detached' });
    expect(pty.paused).toBe(false);
  });
});

async function* bytes(
  chunks: AgentViewTerminalBytes[],
): AsyncIterable<AgentViewTerminalBytes> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function* delayedInput(
  registerRelease: (release: () => void) => void,
): AsyncIterable<AgentViewTerminalBytes> {
  await new Promise<void>((resolve) => {
    registerRelease(resolve);
  });
  yield 'late';
}

class FakeTerminalPty implements AgentViewTerminalPty {
  private readonly inputChunks: Buffer[] = [];
  private dataCallbacks: Array<(data: AgentViewTerminalBytes) => void> = [];
  readonly resizes: AgentViewTerminalSize[] = [];
  paused = false;

  get listenerCount(): number {
    return this.dataCallbacks.length;
  }

  write(data: Buffer): void {
    this.inputChunks.push(Buffer.from(data));
  }

  onData(
    callback: (data: AgentViewTerminalBytes) => void,
  ): AgentViewTerminalDisposable {
    this.dataCallbacks.push(callback);
    return {
      dispose: () => {
        this.dataCallbacks = this.dataCallbacks.filter(
          (item) => item !== callback,
        );
      },
    };
  }

  resize(size: AgentViewTerminalSize): void {
    this.resizes.push(size);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  emitData(data: AgentViewTerminalBytes): void {
    for (const callback of this.dataCallbacks) {
      callback(data);
    }
  }

  input(): string {
    return Buffer.concat(this.inputChunks).toString('utf8');
  }
}

class MemoryWritable extends Writable {
  private readonly chunks: Buffer[] = [];

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  output(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

class DeferredWritable extends Writable {
  private readonly chunks: Buffer[] = [];
  private pending: Array<() => void> = [];

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    this.pending.push(callback);
  }

  flush(): void {
    for (const cb of this.pending.splice(0)) cb();
  }

  output(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

class FailingWritable extends Writable {
  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback(new Error('stdout closed'));
  }
}

class BackpressureWritable extends Writable {
  private readonly chunks: Buffer[] = [];
  private pending: Array<() => void> = [];

  constructor() {
    super({ highWaterMark: 16 });
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    this.pending.push(callback);
  }

  flush(): void {
    for (const cb of this.pending.splice(0)) cb();
  }

  output(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}
