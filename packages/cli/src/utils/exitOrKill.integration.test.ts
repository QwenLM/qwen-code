/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('exitOrKill runtime isolation', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'worker-exit-'));
  const runtime = path.join(dir, 'exit.cjs');

  beforeAll(() => {
    buildSync({
      stdin: {
        contents: `
          import { exitOrKill as exit } from './exitOrKill.js';
          import { redactSecrets } from '../../../core/src/utils/diagnosticRedaction.js';
          export { onExit } from 'signal-exit';
          export const exitOrKill = (code, getPath) => exit(code, getPath, redactSecrets);
        `,
        resolveDir: fileURLToPath(new URL('.', import.meta.url)),
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: runtime,
    });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function runWorker(setup: string, log: string, readLog = true) {
    const worker = `
      const { exitOrKill, onExit } = require(${JSON.stringify(runtime)});
      ${setup}
      setInterval(() => {}, 1000);
      exitOrKill(7, () => ${JSON.stringify(log)});
    `;
    const electron = process.env['CLI_TEST_ELECTRON_PATH'];
    const host = `
      const { Worker } = require('node:worker_threads');
      const app = ${electron ? "require('electron').app" : 'null'};
      if (app) app.setPath('userData', ${JSON.stringify(path.join(dir, 'electron-data'))});
      const worker = new Worker(${JSON.stringify(worker)}, { eval: true, stderr: true });
      worker.stderr.on('data', data => console.log('worker stderr:' + data));
      const timer = setTimeout(() => { console.log('worker timed out'); worker.terminate(); }, 3000);
      worker.on('error', error => console.log('worker error:' + error));
      worker.on('exit', code => {
        clearTimeout(timer);
        console.log('host survived:' + code);
        if (app) app.exit(0);
      });
    `;
    const hostPath = path.join(dir, 'host.cjs');
    writeFileSync(hostPath, host);
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
    delete env['ELECTRON_RUN_AS_NODE'];
    const result = spawnSync(electron || process.execPath, [hostPath], {
      encoding: 'utf8',
      timeout: 15000,
      env,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('host survived:7');
    // Electron's native helper processes may emit startup/shutdown messages.
    // Worker errors and stderr are captured separately above and fail stdout.
    if (!electron) expect(result.stderr).toBe('');
    if (!readLog) return [];
    return readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  }

  it('exits after ordinary and signal-exit callbacks both throw and records both failures', () => {
    const records = runWorker(
      `
      onExit(function signalCleanup() { throw new Error('second failure'); });
      process.on('exit', function ordinaryCleanup() { throw new Error('first failure'); });
    `,
      path.join(dir, 'double.log'),
    );
    expect(records).toHaveLength(2);
    expect(records[0].errorStack).toContain('ordinaryCleanup');
    expect(records[1]).toMatchObject({
      attempt: 2,
      action: 'unload_exit_hooks_and_retry_worker_exit',
    });
    expect(records[1].errorStack).toContain('signalCleanup');
  });

  it('retains base diagnostics and readable fields when error getters throw', () => {
    const records = runWorker(
      `
      onExit(() => {
        const error = Object.assign(new Error('second failure'), { code: 'EIO' });
        Object.defineProperty(error, 'stack', { get() { throw new Error('bad stack'); } });
        throw error;
      });
      process.on('exit', function getterCleanup() {
        const error = new Error('first failure');
        // Materialize the lazy stack before installing a throwing name getter.
        Object.defineProperty(error, 'stack', { value: error.stack });
        for (const field of ['name', 'code']) {
          Object.defineProperty(error, field, { get() { throw new Error('bad field'); } });
        }
        throw error;
      });
    `,
      path.join(dir, 'getters.log'),
    );
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record).toMatchObject({
        event: 'process_exit_failed',
        exitCode: 7,
        isMainThread: false,
      });
      expect(record.pid).toBeGreaterThan(0);
    }
    expect(records[0].unreadableErrorFields).toEqual(['name', 'code']);
    expect(records[0].errorStack).toContain('getterCleanup');
    expect(records[1]).toMatchObject({
      unreadableErrorFields: ['stack'],
      errorName: 'Error',
      errorCode: 'EIO',
    });
  });

  it('redacts and bounds error fields while preserving callsites after a long message', () => {
    const records = runWorker(
      String.raw`
      process.on('exit', function secretCleanup() {
        const error = new Error('x'.repeat(5000) + ' password=message-secret');
        error.name = 'Bearer name-secret';
        error.code = 'token=code-secret';
        error.stack += '\n    at injected (fixture.js?token=stack-secret:1:1)\n    at ' + 'x'.repeat(5000);
        throw error;
      });
    `,
      path.join(dir, 'redacted.log'),
    );
    const serialized = JSON.stringify(records);
    for (const secret of [
      'message-secret',
      'name-secret',
      'code-secret',
      'stack-secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(records[0].errorStack).toContain('secretCleanup');
    expect(records[0].errorStack).toContain('injected');
    expect(records[0].errorStack.length).toBeLessThanOrEqual(2000);
    expect(records[0].errorName).toContain('REDACTED');
    expect(records[0].errorCode).toContain('REDACTED');
  });

  it('keeps the main-thread kill fallback and writes diagnostics before it', () => {
    const log = path.join(dir, 'main-exit.log');
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
      const { exitOrKill } = require(${JSON.stringify(runtime)});
      process.exit = () => { throw Object.assign(new Error('TTY closed'), { code: 'EIO' }); };
      // Observe the destructive fallback in this disposable child. Exit normally
      // after checking the signal so this assertion also works on Windows.
      process.kill = (pid, signal) => {
        if (pid !== process.pid || signal !== 'SIGKILL') throw new Error('wrong kill target');
        console.log('main kill fallback');
      };
      exitOrKill(7, () => ${JSON.stringify(log)});
    `,
      ],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, NODE_ENV: 'production' },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('main kill fallback');
    expect(JSON.parse(readFileSync(log, 'utf8'))).toMatchObject({
      isMainThread: true,
      threadId: 0,
      action: 'kill_process',
      exitCode: 7,
      errorCode: 'EIO',
    });
  });

  it.each([false, true])(
    'preserves the host and exit code after an exit callback throws (log failure: %s)',
    (logFails) => {
      const log = logFails ? dir : path.join(dir, 'logs/exit.log');
      const records = runWorker(
        "process.once('exit', () => { throw new Error('exit callback failed'); });",
        log,
        !logFails,
      );
      if (!logFails) {
        expect(records[0]).toMatchObject({
          event: 'process_exit_failed',
          isMainThread: false,
          exitCode: 7,
          action: 'retry_worker_exit',
          errorName: 'Error',
        });
        expect(records[0].threadId).toBeGreaterThan(0);
        expect(records[0].pid).toBeGreaterThan(0);
      }
    },
  );
});
