/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Transferable, Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModRuntime } from './runtime.js';
import type { ModToolNext } from './tool-events.js';
import type { ModWorkerReply, ModWorkerRequest } from './types.js';

interface ObservedWorker extends Worker {
  requests: ModWorkerRequest[];
  replies: ModWorkerReply[];
}

const workers = vi.hoisted(() => [] as ObservedWorker[]);

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      requests: ModWorkerRequest[] = [];
      replies: ModWorkerReply[] = [];

      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        workers.push(this);
        this.on('message', (reply: ModWorkerReply) => this.replies.push(reply));
      }

      override postMessage(
        request: ModWorkerRequest,
        transferList?: readonly Transferable[],
      ): void {
        this.requests.push(request);
        super.postMessage(request, transferList);
      }
    },
  };
});

const input = { tool: 'write_file', tool_use_id: 'call-1', path: '/waiting' };
const signal = () => new AbortController().signal;
const waitOptions = { timeout: 5000, interval: 5 };
const waitForAbort = async (active: AbortSignal) => {
  if (!active.aborted)
    await new Promise<void>((resolve) =>
      active.addEventListener('abort', () => resolve(), { once: true }),
    );
};
const request = <T extends ModWorkerRequest['type']>(
  worker: ObservedWorker,
  type: T,
  root?: number,
) => {
  const found = worker.requests.findLast(
    (item) => item.type === type && (root === undefined || item.root === root),
  );
  if (!found) throw new Error(`Missing ${type} request`);
  return found as Extract<ModWorkerRequest, { type: T }>;
};
const activities = (worker: ObservedWorker, root: number, phase: number) =>
  worker.replies.filter(
    (reply): reply is Extract<ModWorkerReply, { type: 'activity' }> =>
      reply.type === 'activity' && reply.root === root && reply.phase === phase,
  );
const expectCharged = (
  worker: ObservedWorker,
  active: { root: number; phase: number },
) => {
  const current = activities(worker, active.root, active.phase);
  expect(current.length).toBeGreaterThan(0);
  expect(current.at(-1)?.operation).toBeUndefined();
  expect(current.every((reply) => reply.operation === undefined)).toBe(true);
};

describe('real Mod worker root budget activity', () => {
  const runtimes: ModRuntime[] = [];
  const create = async (source: string) => {
    const runtime = await ModRuntime.create(
      { root: '/fixture', entry: '/fixture/mod.js', source },
      '/workspace',
      () => {},
      signal(),
    );
    runtimes.push(runtime);
    return { runtime, worker: workers.at(-1)! };
  };
  const start = async (
    runtime: ModRuntime,
    worker: ObservedWorker,
    next: ModToolNext,
  ) => {
    const controller = new AbortController();
    const pending = runtime.runTool(input, next, controller.signal);
    void pending.catch(() => {});
    await vi.waitFor(() => request(worker, 'native'), waitOptions);
    return {
      controller,
      pending,
      native: request(worker, 'native'),
    };
  };

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
    await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
  });

  it('lends an awaited native operation and settles cancellation before a healthy next root', async () => {
    const { runtime, worker } = await create(`export function register(on) {
      on('tool.call', async ($, e, next) => await next(e));
    }`);
    let settled = false;
    const next = vi.fn<ModToolNext>(async (changed, active) => {
      if (changed['path'] === '/healthy') return { result: 'healthy' };
      await waitForAbort(active);
      settled = true;
      return { result: 'cancelled' };
    });
    const running = await start(runtime, worker, next);
    await vi.waitFor(() => {
      expect(next).toHaveBeenCalledTimes(1);
      expect(
        activities(worker, running.native.root, running.native.phase).at(-1),
      ).toMatchObject({ operation: running.native.id });
    }, waitOptions);

    running.controller.abort();
    await expect(running.pending).rejects.toThrow(/cancelled/);
    expect(settled).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
    await expect(
      runtime.runTool({ ...input, path: '/healthy' }, next, signal()),
    ).resolves.toEqual({ result: 'healthy' });
    expect(request(worker, 'tool').root).toBeGreaterThan(running.native.root);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('charges a hanging tool.check while its native operation is still pending', async () => {
    const { runtime, worker } = await create(`export function register(on) {
      on('tool.call', ($, e, next) => next(e));
      on('tool.check', async ($) => {
        $.ui.log('check-entered');
        await new Promise(() => {});
      });
    }`);
    let settled = false;
    const next = vi.fn<ModToolNext>(async (changed, active, check) => {
      try {
        return {
          result: await check(
            { tool: changed.tool, input: changed },
            { decision: 'allow' },
            active,
          ),
        };
      } finally {
        settled = true;
      }
    });
    const running = await start(runtime, worker, next);
    await vi.waitFor(() => {
      const checking = request(worker, 'tool-check', running.native.root);
      expect(checking.operation).toBe(running.native.id);
      expect(checking.phase).toBeGreaterThan(running.native.phase);
      expect(
        worker.replies.some(
          (reply) =>
            reply.type === 'log' &&
            reply.root === checking.root &&
            reply.phase === checking.phase &&
            reply.text === 'check-entered',
        ),
      ).toBe(true);
      expectCharged(worker, checking);
    }, waitOptions);
    expect(settled).toBe(false);

    running.controller.abort();
    await expect(running.pending).rejects.toThrow(/cancelled/);
    expect(settled).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('charges a hanging ui.log observer alongside an awaited native operation', async () => {
    const { runtime, worker } = await create(`export function register(on) {
      on('tool.call', ($, e, next) => {
        const pending = next(e);
        $.ui.log('hold');
        return pending;
      });
      on('ui.log', {text:'hold'}, async ($) => {
        $.ui.log('observer-entered');
        await new Promise(() => {});
      });
    }`);
    let settled = false;
    const next = vi.fn<ModToolNext>(async (_changed, active) => {
      await waitForAbort(active);
      settled = true;
      return { result: 'cancelled' };
    });
    const running = await start(runtime, worker, next);
    await vi.waitFor(() => {
      expect(next).toHaveBeenCalledTimes(1);
      expect(
        worker.replies.some(
          (reply) =>
            reply.type === 'log' &&
            reply.root === running.native.root &&
            reply.text === 'observer-entered',
        ),
      ).toBe(true);
      expectCharged(worker, running.native);
    }, waitOptions);
    expect(settled).toBe(false);

    running.controller.abort();
    await expect(running.pending).rejects.toThrow(/cancelled/);
    expect(settled).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('charges continued guest Promise jobs after void next starts native work', async () => {
    const { runtime, worker } = await create(`export function register(on) {
      on('tool.call', async ($, e, next) => {
        void next(e);
        let jobs = 0;
        while (!next.signal.aborted) {
          await Promise.resolve();
          if (++jobs % 2048 === 0) $.ui.log('jobs-running:' + jobs);
        }
        return {deny:'cancelled'};
      });
    }`);
    let settled = false;
    const next = vi.fn<ModToolNext>(async (_changed, active) => {
      await waitForAbort(active);
      settled = true;
      return { result: 'cancelled' };
    });
    const running = await start(runtime, worker, next);
    await vi.waitFor(() => {
      expect(next).toHaveBeenCalledTimes(1);
      const progress = worker.replies.filter(
        (reply) =>
          reply.type === 'log' &&
          reply.root === running.native.root &&
          reply.phase === running.native.phase &&
          reply.text.startsWith('jobs-running:'),
      );
      expect(progress.length).toBeGreaterThanOrEqual(2);
      expectCharged(worker, running.native);
    }, waitOptions);
    expect(settled).toBe(false);

    running.controller.abort();
    await expect(running.pending).rejects.toThrow(/cancelled/);
    expect(settled).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
