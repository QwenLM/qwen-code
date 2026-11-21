/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ndJsonStream } from './ndJsonStream.js';

const encoder = new TextEncoder();
const message = { jsonrpc: '2.0', method: 'notification' };

function fixture(rejectCancel = false) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn(() => {
    if (rejectCancel) throw new Error('upstream cancellation failed');
  });
  const input = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel,
  });
  const { readable } = ndJsonStream(new WritableStream<Uint8Array>(), input);
  return {
    input,
    readable,
    cancel,
    controller,
    cleanup() {
      if (cancel.mock.calls.length === 0) controller.close();
    },
  };
}

describe('legacy NDJSON cancellation', () => {
  it('reports an already locked input through the readable without throwing synchronously', async () => {
    const input = new ReadableStream<Uint8Array>();
    const existingReader = input.getReader();
    try {
      const { readable } = ndJsonStream(
        new WritableStream<Uint8Array>(),
        input,
      );
      const reader = readable.getReader();
      try {
        await expect(reader.read()).rejects.toThrow(/ReadableStream is locked/);
      } finally {
        reader.releaseLock();
      }
    } finally {
      existingReader.releaseLock();
    }
  });

  it('does not parse or enqueue a queued chunk after immediate cancellation', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cancel = vi.fn();
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify(message) + '\n'));
      },
      cancel,
    });
    const { readable } = ndJsonStream(new WritableStream<Uint8Array>(), input);
    const enqueue = vi.spyOn(
      ReadableStreamDefaultController.prototype,
      'enqueue',
    );
    try {
      await readable.cancel('stop');
      expect(cancel).toHaveBeenCalledExactlyOnceWith('stop');
      expect(input.locked).toBe(false);
      expect(enqueue).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      enqueue.mockRestore();
      error.mockRestore();
    }
  });

  it('stops later frames in the same chunk when a message hook cancels its reader', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cancel = vi.fn();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      cancel,
    });
    let cancellation: Promise<void> | undefined;
    const observed = vi.fn(() => {
      cancellation = reader.cancel('fatal');
    });
    const { readable } = ndJsonStream(new WritableStream<Uint8Array>(), input, {
      onMessageObserved: observed,
    });
    const reader = readable.getReader();
    const messages = [1, 2, 3].map((n) => ({ ...message, params: { n } }));
    const first = reader.read();
    controller.enqueue(
      encoder.encode(
        messages.map((value) => JSON.stringify(value)).join('\n') + '\n',
      ),
    );
    const enqueue = vi.spyOn(
      ReadableStreamDefaultController.prototype,
      'enqueue',
    );
    try {
      expect((await first).value).toEqual(messages[0]);
      expect(cancellation).toBeDefined();
      await cancellation;
      expect.soft(enqueue).toHaveBeenCalledOnce();
      expect.soft(error).not.toHaveBeenCalled();
      expect(observed).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledExactlyOnceWith('fatal');
      expect(input.locked).toBe(false);
      expect(await reader.read()).toEqual({ done: true, value: undefined });
    } finally {
      await reader.cancel('cleanup').catch(() => {});
      reader.releaseLock();
      enqueue.mockRestore();
      error.mockRestore();
    }
  });

  it.each([false, true])(
    'preserves all frames without cancellation (split across chunks: %s)',
    async (split) => {
      const stream = fixture();
      const messages = [1, 2, 3].map((n) => ({ ...message, params: { n } }));
      const payload =
        messages.map((value) => JSON.stringify(value)).join('\n') + '\n';
      const splitAt = split ? payload.indexOf('"n":2') + 4 : payload.length;
      stream.controller.enqueue(encoder.encode(payload.slice(0, splitAt)));
      if (split) {
        stream.controller.enqueue(encoder.encode(payload.slice(splitAt)));
      }
      stream.controller.close();
      const reader = stream.readable.getReader();
      try {
        for (const value of messages) {
          expect((await reader.read()).value).toEqual(value);
        }
        expect(await reader.read()).toEqual({ done: true, value: undefined });
        expect(stream.cancel).not.toHaveBeenCalled();
        expect(stream.input.locked).toBe(false);
      } finally {
        reader.releaseLock();
      }
    },
  );

  it('forwards cancellation before data and releases the upstream lock', async () => {
    const stream = fixture();
    const reason = new Error('consumer stopped');
    const close = vi.spyOn(ReadableStreamDefaultController.prototype, 'close');
    try {
      await stream.readable.cancel(reason);
      expect(close).not.toHaveBeenCalled();
      expect(stream.cancel).toHaveBeenCalledExactlyOnceWith(reason);
      expect(stream.input.locked).toBe(false);
    } finally {
      close.mockRestore();
      stream.cleanup();
    }
  });

  it('waits for asynchronous upstream cancellation to settle', async () => {
    let finishCancel!: () => void;
    const pendingCancel = new Promise<void>((resolve) => {
      finishCancel = resolve;
    });
    const cancel = vi.fn(() => pendingCancel);
    const input = new ReadableStream<Uint8Array>({ cancel });
    const { readable } = ndJsonStream(new WritableStream<Uint8Array>(), input);
    let resolved = false;
    const cancellation = readable.cancel('stop').then(() => {
      resolved = true;
    });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(cancel).toHaveBeenCalledExactlyOnceWith('stop');
      expect(resolved).toBe(false);
      expect(input.locked).toBe(false);
    } finally {
      finishCancel();
      await cancellation;
    }
    expect(resolved).toBe(true);
  });

  it('forwards reader cancellation after a complete message', async () => {
    const stream = fixture();
    const reader = stream.readable.getReader();
    stream.controller.enqueue(encoder.encode(JSON.stringify(message) + '\n'));
    try {
      expect((await reader.read()).value).toEqual(message);
      await reader.cancel('done');
      expect(stream.cancel).toHaveBeenCalledExactlyOnceWith('done');
      expect(stream.input.locked).toBe(false);
    } finally {
      reader.releaseLock();
      stream.cleanup();
    }
  });

  it('settles a pending downstream read on cancellation', async () => {
    const stream = fixture();
    const reader = stream.readable.getReader();
    try {
      const pending = reader.read();
      await reader.cancel('stop');
      expect(await pending).toEqual({ done: true, value: undefined });
      expect(stream.cancel).toHaveBeenCalledExactlyOnceWith('stop');
      expect(stream.input.locked).toBe(false);
    } finally {
      reader.releaseLock();
      stream.cleanup();
    }
  });

  it('forwards repeated cancellation only once', async () => {
    const stream = fixture();
    try {
      await stream.readable.cancel('first');
      await stream.readable.cancel('second');
      expect(stream.cancel).toHaveBeenCalledExactlyOnceWith('first');
      expect(stream.input.locked).toBe(false);
    } finally {
      stream.cleanup();
    }
  });

  it('releases the lock even when upstream cancellation rejects', async () => {
    const stream = fixture(true);
    try {
      await expect(stream.readable.cancel('stop')).resolves.toBeUndefined();
      expect(stream.cancel).toHaveBeenCalledExactlyOnceWith('stop');
      expect(stream.input.locked).toBe(false);
    } finally {
      stream.cleanup();
    }
  });

  it('preserves normal messages and clean EOF', async () => {
    const stream = fixture();
    stream.controller.enqueue(encoder.encode(JSON.stringify(message) + '\n'));
    stream.controller.close();
    const reader = stream.readable.getReader();
    try {
      expect((await reader.read()).value).toEqual(message);
      expect(await reader.read()).toEqual({ done: true, value: undefined });
      expect(stream.cancel).not.toHaveBeenCalled();
      expect(stream.input.locked).toBe(false);
    } finally {
      reader.releaseLock();
    }
  });

  it('keeps logging malformed JSON and reading subsequent messages', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stream = fixture();
    stream.controller.enqueue(
      encoder.encode('invalid JSON\n' + JSON.stringify(message) + '\n'),
    );
    stream.controller.close();
    const reader = stream.readable.getReader();
    try {
      expect((await reader.read()).value).toEqual(message);
      expect(await reader.read()).toEqual({ done: true, value: undefined });
      expect(error).toHaveBeenCalledOnce();
      expect(stream.input.locked).toBe(false);
    } finally {
      reader.releaseLock();
      error.mockRestore();
    }
  });
});
