/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';

const state = vi.hoisted(() => ({ directory: '', build: undefined }));
vi.mock('esbuild', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    default: {
      build(options) {
        if (!options.entryPoints['mod-worker'])
          return Promise.resolve({ metafile: {} });
        state.build = actual.build({
          ...options,
          entryPoints: { 'mod-worker': options.entryPoints['mod-worker'] },
          outdir: state.directory,
        });
        return state.build;
      },
    },
  };
});
// Import the real build configuration without cleaning the shared dist directory.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal()),
  rmSync: vi.fn(),
}));

let worker;
afterEach(async () => {
  await worker?.terminate();
  worker = undefined;
  if (state.directory)
    await rm(state.directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it('runs a relocated bundled worker with TypeScript and relative imports', async () => {
  state.directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'qwen-mod-worker-bundle-')),
  );
  vi.stubEnv('DEV', 'false');
  vi.resetModules();
  await import('../../esbuild.config.js');
  await state.build;
  await writeFile(
    path.join(state.directory, 'package.json'),
    '{"type":"module"}',
  );
  await writeFile(
    path.join(state.directory, 'helper.ts'),
    'export const greeting: string = "bundled";',
  );
  worker = new Worker(path.join(state.directory, 'mod-worker.js'), {
    workerData: new SharedArrayBuffer(4),
  });
  const dispatch = (request) =>
    new Promise((resolve, reject) => {
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onMessage = (reply) => {
        if (reply.type === 'log') return;
        cleanup();
        if (reply.type === 'error') reject(new Error(reply.message));
        else resolve(JSON.parse(reply.json));
      };
      const cleanup = () => {
        worker.off('error', onError);
        worker.off('message', onMessage);
      };
      worker.on('error', onError);
      worker.on('message', onMessage);
      worker.postMessage(request);
    });
  const commands = await dispatch({
    type: 'load',
    cwd: state.directory,
    plugins: [
      {
        id: 'fixture',
        name: 'fixture',
        options: { value: 'option' },
        source: {
          root: state.directory,
          entry: path.join(state.directory, 'entry.ts'),
          source: `import { greeting } from './helper.js'; export function register(on, options) {
      on('session.start', async ($, e, next) => { await $.command.register({ name: 'hello', description: 'Bundled' }); return next(e); });
      on('command.run', {command:'hello'}, () => ({text: greeting + ':' + options.value + ':' + typeof process}));
    }`,
        },
      },
    ],
  });
  expect(commands).toEqual({
    tools: false,
    commands: [{ name: 'hello', description: 'Bundled', plugin: 'fixture' }],
  });
  expect(
    await dispatch({ type: 'command', command: 'hello', args: '' }),
  ).toEqual({ text: 'bundled:option:undefined' });
});
