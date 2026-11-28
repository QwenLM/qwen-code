/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { build } from 'esbuild';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';

// Use a real child process and Worker stdin. Only redirect the Windows command
// to a controlled Node program, so the same lifecycle test runs on every OS.
describe('Windows executable probe lifecycle', () => {
  it.each([
    'success',
    'sync-blocked',
    'slow-success',
    'timeout',
    'missing',
    'abort',
    'stdin',
    'unread-stdin',
    'after-eof',
    'eof-before-probe',
    'abort-after-eof',
    'buffered-eof-before-probe',
  ] as const)(
    'reaps the probe and exits the Worker after %s',
    async (mode) => {
      const dir = await mkdtemp(path.join(tmpdir(), 'test-executable-probe-'));
      const entry = path.join(dir, 'worker.mjs');
      const probe = path.join(dir, 'probe.mjs');
      const pidFile = path.join(dir, 'pid');
      let worker: Worker | undefined;
      let pid: number | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await writeFile(
          probe,
          `
          import {writeFileSync} from 'node:fs';
          writeFileSync(process.env.PROBE_PID_FILE, String(process.pid));
          if (['success', 'after-eof', 'eof-before-probe'].includes(process.env.PROBE_MODE)) {
            process.stdout.write('probe-result\\r\\n');
          } else if (process.env.PROBE_MODE === 'buffered-eof-before-probe') {
            setTimeout(() => process.stdout.write('probe-result\\r\\n'), 300);
          } else if (process.env.PROBE_MODE === 'missing') {
            process.exit(1);
          } else if (process.env.PROBE_MODE === 'slow-success') {
            setTimeout(() => process.stdout.write('probe-result\\r\\n'), 5300);
          } else if (process.env.PROBE_MODE === 'sync-blocked') {
            setTimeout(() => {}, 5000);
          } else {
            setInterval(() => {}, 1000);
          }
        `,
        );
        await build({
          stdin: {
            contents: `
              import {parentPort, workerData} from 'node:worker_threads';
              import {createInterface} from 'node:readline';
              import {runWindowsExecutableProbe} from ${JSON.stringify(fileURLToPath(new URL('./windowsExecutableProbe.ts', import.meta.url)))};
              const reader = process.env.UNREAD_STDIN === '1' || workerData.mode === 'buffered-eof-before-probe' ? undefined : createInterface({input: process.stdin});
              let bufferedInput;
              let producerEnded;
              if (workerData.mode === 'buffered-eof-before-probe') {
                producerEnded = new Promise(resolve => {
                  const push = process.stdin.push;
                  process.stdin.push = function(chunk, encoding) {
                    const result = push.call(this, chunk, encoding);
                    if (chunk === null) {this.push = push; resolve();}
                    return result;
                  };
                });
                process.stdin.read(0);
              }
              const ended = new Promise(resolve => process.stdin.once('end', resolve));
              const controller = new AbortController();
              parentPort.on('message', () => controller.abort());
              (async () => {
                if (workerData.mode === 'after-eof') {
                  await runWindowsExecutableProbe('git', controller.signal);
                  parentPort.postMessage({readyForEOF: true});
                  await ended;
                }
                if (workerData.mode === 'eof-before-probe' || workerData.mode === 'abort-after-eof') await ended;
                if (workerData.mode === 'buffered-eof-before-probe') {
                  await producerEnded;
                  const probe = runWindowsExecutableProbe('git', controller.signal);
                  bufferedInput = process.stdin.read()?.toString();
                  process.stdin.resume();
                  return probe;
                }
                return runWindowsExecutableProbe('git', controller.signal);
              })().then(
                value => parentPort.postMessage({value, ...(bufferedInput === undefined ? {} : {input: bufferedInput})}),
                error => parentPort.postMessage({error: error.name, ...(workerData.mode === 'timeout' ? {message: error.message} : {}), ...(process.env.UNREAD_STDIN === '1' ? {input: process.stdin.read()?.toString()} : {})}),
              ).finally(() => {
                reader?.close();
                process.stdin.resume();
                parentPort.removeAllListeners('message');
                parentPort.close();
              });
            `,
            resolveDir: dir,
          },
          bundle: true,
          platform: 'node',
          format: 'esm',
          outfile: entry,
          plugins: [
            {
              name: 'controlled-probe-command',
              setup(api) {
                api.onResolve({ filter: /^node:child_process$/ }, () => ({
                  path: 'child',
                  namespace: 'probe',
                }));
                api.onLoad({ filter: /.*/, namespace: 'probe' }, () => ({
                  contents: `
                  import {execFile as nativeExecFile, execFileSync} from 'child_process';
                  import {workerData} from 'node:worker_threads';
                  export function execFile(_file, args, options, callback) {
                    if (workerData.mode === 'sync-blocked') execFileSync(workerData.runtime, [workerData.probe], {env: {...process.env, PROBE_PID_FILE: workerData.pidFile, PROBE_MODE: workerData.mode}});
                    return nativeExecFile(workerData.runtime, [workerData.probe, ...args], {
                      ...options,
                      env: {...process.env, PROBE_PID_FILE: workerData.pidFile, PROBE_MODE: workerData.mode},
                    }, callback);
                  }
                `,
                }));
              },
            },
          ],
        });
        worker = new Worker(entry, {
          stdin: true,
          workerData: { runtime: process.execPath, probe, pidFile, mode },
          env: {
            ...process.env,
            UNREAD_STDIN: mode === 'unread-stdin' ? '1' : '0',
          },
        });
        const result = new Promise<{ value?: string; error?: string }>(
          (resolve, reject) => {
            worker!.on('message', (message) => {
              if (message.readyForEOF) worker!.stdin!.end();
              else resolve(message);
            });
            worker!.once('error', reject);
          },
        );
        void result.catch(() => {});
        const exited = new Promise<number>((resolve) =>
          worker!.once('exit', resolve),
        );
        if (mode === 'eof-before-probe' || mode === 'abort-after-eof')
          worker.stdin!.end();
        if (mode === 'buffered-eof-before-probe') worker.stdin!.end('initialize-frame\n');
        if (mode !== 'eof-before-probe' && mode !== 'buffered-eof-before-probe')
          await vi.waitFor(
            async () => {
              pid = Number(await readFile(pidFile, 'utf8'));
              expect(pid).toBeGreaterThan(0);
            },
            { timeout: 5000 },
          );
        if (mode === 'sync-blocked') {
          pid = undefined; // Exercise cleanup's PID-file fallback.
          return;
        }
        if (mode === 'abort' || mode === 'abort-after-eof')
          worker.postMessage('abort');
        if (mode === 'stdin' || mode === 'unread-stdin') {
          worker.stdin!.end('initialize-frame\n');
        }
        const outcome = await Promise.race([
          result,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error('probe did not settle')),
              mode === 'timeout'
                ? 40_000
                : mode === 'unread-stdin' ? 1000 : 10_000,
            );
          }),
        ]);
        if (
          mode === 'abort' ||
          mode === 'abort-after-eof' ||
          mode === 'stdin' ||
          mode === 'unread-stdin'
        ) {
          expect(outcome).toEqual({
            error: 'AbortError',
            ...(mode === 'unread-stdin' ? { input: 'initialize-frame\n' } : {}),
          });
        } else if (mode === 'timeout') {
          expect(outcome).toEqual({
            error: 'TimeoutError',
            message: expect.stringContaining('where.exe git timed out'),
          });
          // Verify reaping before EOF or any test cleanup can cancel the probe.
          expect(() => process.kill(pid!, 0)).toThrow();
        } else {
          expect(outcome).toEqual({
            value: mode === 'missing' ? '' : 'probe-result',
            ...(mode === 'buffered-eof-before-probe' ? {input: 'initialize-frame\n'} : {}),
          });
        }
        worker.stdin!.end();
        expect(
          await Promise.race([
            exited,
            new Promise<never>((_, reject) => {
              clearTimeout(deadline);
              deadline = setTimeout(
                () => reject(new Error('Worker did not exit')),
                2000,
              );
            }),
          ]),
        ).toBe(0);
        pid = Number(await readFile(pidFile, 'utf8'));
        expect(() => process.kill(pid!, 0)).toThrow();
      } finally {
        clearTimeout(deadline);
        const cleanupStarted = Date.now();
        // A native-blocked Worker cannot terminate until its child exits.
        const pids = new Set([pid]);
        try {
          pids.add(Number(await readFile(pidFile, 'utf8')));
        } catch {
          /* child may not have started */
        }
        for (const pid of pids) {
          if (!pid || !Number.isInteger(pid) || pid <= 0) continue;
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already reaped */
          }
        }
        await worker?.terminate();
        await rm(dir, { recursive: true, force: true });
        if (mode === 'sync-blocked') {
          expect(Date.now() - cleanupStarted).toBeLessThan(2000);
        }
      }
    },
  );
});
