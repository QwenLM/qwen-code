/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Worker } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import { ModRuntime } from './runtime.js';

const workers = vi.hoisted(() => [] as Worker[]);

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        workers.push(this);
        this.stdout?.resume();
        this.stderr?.resume();
        Object.defineProperties(this, {
          stdout: { value: null },
          stderr: { value: null },
        });
      }
    },
  };
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
});

it('loads and runs a real Mod when the worker has no captured output streams', async () => {
  const log = vi.fn();
  const signal = new AbortController().signal;
  const runtime = await ModRuntime.create(
    {
      root: '/fixture',
      entry: '/fixture/mod.js',
      source: `export function register(on) {
        on('session.start', async ($, e, next) => {
          await $.command.register({name:'hello',description:'Hello'});
          $.ui.log('started');
          return next(e);
        });
        on('command.run', {command:'hello'}, () => ({text:'hello'}));
      }`,
    },
    '/workspace',
    log,
    signal,
  );
  try {
    expect(log).toHaveBeenCalledWith(
      { to: 'transcript', text: 'started' },
      'mod',
    );
    expect(runtime.getCommands()).toEqual([
      { name: 'hello', description: 'Hello' },
    ]);
    expect(await runtime.runCommand('hello', '', signal)).toBe('hello');
  } finally {
    await runtime.dispose();
  }
});
