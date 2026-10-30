/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModRuntime } from './runtime.js';
import type {
  ModToolCheck,
  ModToolNext,
  ModToolResult,
} from './tool-events.js';
import type { ModReply, ModWorkerRequest } from './types.js';

interface FakeWorker extends EventEmitter {
  messages: ModWorkerRequest[];
  terminate: ReturnType<typeof vi.fn>;
  reply: (reply: ModReply, root: number, phase?: number) => void;
}

const workers = vi.hoisted(() => [] as FakeWorker[]);

vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: class extends EventEmitter {
      messages: ModWorkerRequest[] = [];
      stdout = null;
      stderr = null;
      terminate = vi.fn(async () => 0);
      constructor() {
        super();
        workers.push(this);
      }
      postMessage(request: ModWorkerRequest) {
        this.messages.push(request);
      }
      reply(reply: ModReply, root: number, phase?: number) {
        this.emit('message', {
          ...reply,
          root,
          phase:
            phase ??
            this.messages.findLast((message) => message.root === root)?.phase ??
            0,
        });
      }
    },
  };
});

const input = { tool: 'write_file', tool_use_id: 'call-1', path: '/unused' };
const result: ModToolResult = { result: 'native result' };
const signal = () => new AbortController().signal;
const rejection = (pending: Promise<unknown>) =>
  pending.then(
    () => undefined,
    (error: unknown) => error,
  );
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const message = <T extends ModWorkerRequest['type']>(
  worker: FakeWorker,
  type: T,
) => {
  const found = worker.messages.findLast((item) => item.type === type);
  if (!found) throw new Error(`Missing ${type} request`);
  return found as Extract<ModWorkerRequest, { type: T }>;
};

describe('ModRuntime root budget protocol', () => {
  const runtimes: ModRuntime[] = [];
  const createPending = () =>
    ModRuntime.create(
      { root: '/fixture', entry: '/fixture/mod.js', source: '' },
      '/workspace',
      vi.fn(),
      signal(),
    );
  const create = async () => {
    const pending = createPending();
    const worker = workers.at(-1)!;
    worker.reply(
      {
        type: 'result',
        json: JSON.stringify({
          tools: true,
          turnStart: false,
          promptSubmit: [],
          turnComplete: [],
          render: [],
          commands: [{ plugin: 'mod', name: 'hello', description: 'Hello' }],
        }),
      },
      message(worker, 'load').root,
    );
    const runtime = await pending;
    runtimes.push(runtime);
    return { runtime, worker };
  };
  const start = async (
    runtime: ModRuntime,
    worker: FakeWorker,
    next: ModToolNext,
    active = signal(),
  ) => {
    const pending = runtime.runTool(input, next, active);
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    return { pending, root: message(worker, 'tool').root };
  };
  const native = () => {
    const gate = deferred<ModToolResult>();
    const next = vi.fn<ModToolNext>((_input, active) => {
      active.addEventListener(
        'abort',
        () => gate.reject(new Error('native cancelled')),
        { once: true },
      );
      return gate.promise;
    });
    return { gate, next };
  };
  const beginNative = async (worker: FakeWorker, root: number, id = 1) => {
    worker.reply({ type: 'host-call', id, input }, root);
    await vi.advanceTimersByTimeAsync(0);
    worker.reply({ type: 'activity', revision: 1, operation: id }, root);
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
    workers.length = 0;
    vi.useRealTimers();
  });

  it('excludes a 90-second native wait and resumes the cumulative clock after its result', async () => {
    const { runtime, worker } = await create();
    const { gate, next } = native();
    const { pending, root } = await start(runtime, worker, next);
    const rejected = rejection(pending);
    await vi.advanceTimersByTimeAsync(5_000);
    await beginNative(worker, root);
    expect(next).toHaveBeenCalledExactlyOnceWith(
      input,
      expect.anything(),
      expect.any(Function),
    );
    expect(message(worker, 'native')).toMatchObject({ root, id: 1 });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(worker.terminate).not.toHaveBeenCalled();
    gate.resolve(result);
    await vi.advanceTimersByTimeAsync(0);
    expect(message(worker, 'host-result')).toMatchObject({ root, result });
    await vi.advanceTimersByTimeAsync(7_000 + 48_249);
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await rejected).toMatchObject({
      message: 'Mod dispatch timed out.',
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each(['wrong root', 'unknown operation', 'old revision'])(
    'continues charging when idle activity has %s',
    async (kind) => {
      const { runtime, worker } = await create();
      const { next } = native();
      const { pending, root } = await start(runtime, worker, next);
      const rejected = rejection(pending);
      worker.reply({ type: 'host-call', id: 1, input }, root);
      await vi.advanceTimersByTimeAsync(0);
      if (kind === 'old revision')
        worker.reply({ type: 'activity', revision: 2 }, root);
      worker.reply(
        {
          type: 'activity',
          revision: 1,
          operation: kind === 'unknown operation' ? 999 : 1,
        },
        kind === 'wrong root' ? root + 100 : root,
        message(worker, 'native').phase,
      );
      await vi.advanceTimersByTimeAsync(60_249);
      expect(worker.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await rejected).toMatchObject({
        message: 'Mod dispatch timed out.',
      });
      expect(worker.terminate).toHaveBeenCalledOnce();
    },
  );

  it('does not lend for a queued native operation before it actually starts', async () => {
    const { runtime, worker } = await create();
    const { next } = native();
    const { pending, root } = await start(runtime, worker, next);
    const rejected = rejection(pending);
    worker.reply({ type: 'host-call', id: 1, input }, root);
    worker.reply({ type: 'host-call', id: 2, input }, root);
    await vi.advanceTimersByTimeAsync(0);
    expect(next).toHaveBeenCalledOnce();
    expect(worker.messages.filter((item) => item.type === 'native')).toEqual([
      expect.objectContaining({ root, id: 1 }),
    ]);
    worker.reply({ type: 'activity', revision: 1, operation: 2 }, root);
    await vi.advanceTimersByTimeAsync(60_250);
    expect(await rejected).toMatchObject({
      message: 'Mod dispatch timed out.',
    });
    expect(next).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('charges the whole permission check and requires fresh idle activity after it returns', async () => {
    const { runtime, worker } = await create();
    const { gate, next } = native();
    let check!: ModToolCheck;
    next.mockImplementation((_changed, active, inspect) => {
      check = inspect;
      active.addEventListener(
        'abort',
        () => gate.reject(new Error('cancelled')),
        { once: true },
      );
      return gate.promise;
    });
    const { pending, root } = await start(runtime, worker, next);
    const rejected = rejection(pending);
    await beginNative(worker, root);
    await vi.advanceTimersByTimeAsync(90_000);
    const checked = check(
      { tool: input.tool, input: {}, ceiling: 'ask' },
      { decision: 'ask' },
      signal(),
    );
    const request = message(worker, 'tool-check');
    worker.reply({ type: 'activity', revision: 2, operation: 1 }, root);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.reply(
      { type: 'check-result', id: request.id, result: { decision: 'allow' } },
      root,
    );
    await expect(checked).resolves.toEqual({
      decision: 'allow',
      ceiling: 'ask',
    });
    await vi.advanceTimersByTimeAsync(30_249);
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await rejected).toMatchObject({
      message: 'Mod dispatch timed out.',
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('rejects stale native idle activity after a permission check is cancelled', async () => {
    const { runtime, worker } = await create();
    const { gate, next } = native();
    let check!: ModToolCheck;
    next.mockImplementation((_changed, active, inspect) => {
      check = inspect;
      active.addEventListener(
        'abort',
        () => gate.reject(new Error('cancelled')),
        { once: true },
      );
      return gate.promise;
    });
    const { pending, root } = await start(runtime, worker, next);
    const rejected = rejection(pending);
    await beginNative(worker, root);
    const nativePhase = message(worker, 'native').phase;
    const cancelCheck = new AbortController();
    const checked = check(
      { tool: input.tool, input: {} },
      { decision: 'ask' },
      cancelCheck.signal,
    );
    const checkRejected = rejection(checked);
    cancelCheck.abort();
    expect(await checkRejected).toMatchObject({
      message: 'Mod permission check cancelled.',
    });
    worker.reply(
      { type: 'activity', revision: 2, operation: 1 },
      root,
      nativePhase,
    );
    await vi.advanceTimersByTimeAsync(60_250);
    expect(await rejected).toMatchObject({
      message: 'Mod dispatch timed out.',
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('terminates 250ms after cancellation while lent, independently of native cleanup', async () => {
    const { runtime, worker } = await create();
    const gate = deferred<ModToolResult>();
    const next = vi.fn<ModToolNext>(() => gate.promise);
    const active = new AbortController();
    const { pending, root } = await start(runtime, worker, next, active.signal);
    const rejected = rejection(pending);
    await beginNative(worker, root);
    await vi.advanceTimersByTimeAsync(90_000);
    active.abort();
    expect(next.mock.calls[0]![1].aborted).toBe(true);
    worker.reply({ type: 'activity', revision: 2, operation: 1 }, root);
    await vi.advanceTimersByTimeAsync(249);
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(worker.terminate).toHaveBeenCalledOnce();
    gate.resolve(result);
    expect(await rejected).toMatchObject({
      message: 'Mod dispatch cancelled.',
    });
  });

  it.each(['load', 'command', 'end'] as const)(
    'keeps the %s wall-clock deadline',
    async (kind) => {
      let pending: Promise<unknown>;
      let worker: FakeWorker;
      if (kind === 'load') {
        pending = createPending();
        worker = workers.at(-1)!;
      } else {
        const created = await create();
        worker = created.worker;
        pending =
          kind === 'command'
            ? created.runtime.runCommand('hello', '', signal())
            : created.runtime.end('session', 'clear', signal());
      }
      const rejected = rejection(pending);
      worker.reply(
        { type: 'activity', revision: 1 },
        message(worker, kind).root,
      );
      const timeout = kind === 'end' ? 1_750 : 60_250;
      await vi.advanceTimersByTimeAsync(timeout - 1);
      expect(worker.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await rejected).toMatchObject({
        message: 'Mod dispatch timed out.',
      });
      expect(worker.terminate).toHaveBeenCalled();
    },
  );
});
