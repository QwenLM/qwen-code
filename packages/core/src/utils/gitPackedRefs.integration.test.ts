/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('packed-refs descriptor lifecycle in a Node Worker', () => {
  let root: string;
  let entry: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'test-packed-refs-'));
    entry = path.join(root, 'worker.cjs');
    await build({
      stdin: {
        contents: `
          import { parentPort, workerData } from 'node:worker_threads';
          import { ReadStream } from 'node:fs';
          import { open } from 'node:fs/promises';
          import path from 'node:path';
          import { readGitHead } from ${JSON.stringify(fileURLToPath(new URL('./gitUtils.ts', import.meta.url)))};
          process.on('warning', warning => parentPort.postMessage({ warning: warning.message }));
          const controller = new AbortController();
          let abortedDuringRead = false;
          if (workerData.mode === 'abort') {
            // Abort when the real stream delivers its first chunk, without racing a timer against disk I/O.
            const emit = ReadStream.prototype.emit;
            ReadStream.prototype.emit = function(event, ...args) {
              if (event === 'data') {
                abortedDuringRead = true;
                controller.abort(new Error('packed-refs cancelled'));
              }
              return Reflect.apply(emit, this, [event, ...args]);
            };
          }
          async function run() {
            const beforeStream = ['preabort', 'timeout'].includes(workerData.mode);
            const handles = [];
            const closed = [];
            let interruptedBeforeStream = false;
            let releaseStat;
            const probeFinished = new Promise(resolve => { releaseStat = resolve; });
            if (beforeStream) {
              const sample = await open(path.join(workerData.gitDir, 'HEAD'));
              const prototype = Object.getPrototypeOf(sample);
              await sample.close();
              const stat = prototype.stat;
              prototype.stat = async function(...args) {
                const result = await Reflect.apply(stat, this, args);
                // Only packed-refs exceeds one chunk in this fixture; leave HEAD reads unaffected.
                if (result.size > 1024) {
                  handles.push(this);
                  closed.push(new Promise(resolve => this.once('close', resolve)));
                  interruptedBeforeStream = true;
                  if (workerData.mode === 'preabort') {
                    controller.abort(new Error('packed-refs cancelled'));
                  } else {
                    // Complete stat after the probe actually times out, without assuming a fixed disk delay.
                    await probeFinished;
                  }
                }
                return result;
              };
            }
            const read = () => readGitHead(workerData, {
              signal: controller.signal,
              timeoutMs: workerData.mode === 'timeout' ? 1000 : 2000,
              throwOnTimeout: true,
            }).catch(error => ({ error: error.message })).finally(releaseStat);
            // The probe timer is unref'ed; keep the Worker alive while the injected stat is pending.
            const keepAlive = setInterval(() => {}, 1000);
            try {
              const heads = await Promise.all(beforeStream ? [read()] : [read(), read()]);
              await Promise.all(closed);
              parentPort.postMessage({
                heads, abortedDuringRead, interruptedBeforeStream,
                openHandles: handles.filter(handle => handle.fd !== -1).length,
              });
            } finally {
              clearInterval(keepAlive);
            }
          }
          run().catch(error => { throw error; });
        `,
        resolveDir: root,
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: entry,
    });
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each([
    'early-match',
    'end-match',
    'missing-ref',
    'abort',
    'preabort',
    'timeout',
  ])(
    'closes packed-refs without descriptor warnings after %s',
    async (mode) => {
      const worktreeRoot = path.join(root, mode);
      const gitDir = path.join(worktreeRoot, '.git');
      const commit = 'b'.repeat(40);
      const otherRefs = Array.from(
        { length: 100 },
        (_, index) => `${'a'.repeat(40)} refs/heads/other-${index}\n`,
      ).join('');
      await mkdir(gitDir, { recursive: true });
      await writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
      await writeFile(
        path.join(gitDir, 'packed-refs'),
        mode === 'early-match'
          ? `${commit} refs/heads/main\n${otherRefs}`
          : `${otherRefs}${mode === 'end-match' ? `${commit} refs/heads/main` : ''}`,
      );

      // A native double close can terminate the process; isolate it from the test runner.
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [
          '-e',
          `
            const { Worker } = require('node:worker_threads');
            const warnings = [];
            let heads;
            let abortedDuringRead;
            let interruptedBeforeStream;
            let openHandles;
            const worker = new Worker(process.argv[1], {
              workerData: JSON.parse(process.argv[2]),
              execArgv: [],
            });
            worker.on('message', message => {
              if (message.warning) warnings.push(message.warning);
              if (message.heads) {
                heads = message.heads;
                abortedDuringRead = message.abortedDuringRead;
                interruptedBeforeStream = message.interruptedBeforeStream;
                openHandles = message.openHandles;
              }
            });
            worker.on('error', error => { console.error(error); process.exitCode = 1; });
            worker.on('exit', code => {
              process.stdout.write(JSON.stringify({ code, heads, warnings, abortedDuringRead, interruptedBeforeStream, openHandles }));
              process.exitCode = code;
            });
          `,
          entry,
          JSON.stringify({
            worktreeRoot,
            gitDir,
            commonDir: gitDir,
            isWorktree: false,
            mode,
          }),
        ],
        { timeout: 10_000 },
      );
      const head =
        mode === 'timeout'
          ? { error: 'Git metadata probe exceeded 1000ms' }
          : mode === 'abort' || mode === 'preabort'
            ? { error: 'packed-refs cancelled' }
            : {
                ref: 'refs/heads/main',
                branch: 'main',
                ...(mode === 'missing-ref' ? {} : { commit }),
              };
      expect(JSON.parse(stdout)).toEqual({
        code: 0,
        heads: ['preabort', 'timeout'].includes(mode) ? [head] : [head, head],
        warnings: [],
        abortedDuringRead: mode === 'abort',
        interruptedBeforeStream: ['preabort', 'timeout'].includes(mode),
        openHandles: 0,
      });
      expect(stderr).not.toContain('closed but not opened in unmanaged mode');
    },
  );
});
