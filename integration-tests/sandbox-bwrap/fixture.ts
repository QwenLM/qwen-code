/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { expect } from 'vitest';

export const repoRoot = resolve(import.meta.dirname, '../..');
export const bundle = join(repoRoot, 'dist/cli.js');
export const fixtures = join(import.meta.dirname, 'fixtures');

export interface Result {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: Error;
}

export function isRunning(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2)[0]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export class Fixture {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-bwrap-')));
  readonly workspace = join(this.root, 'workspace');
  readonly env: NodeJS.ProcessEnv;
  private processes: Array<{ child: ChildProcess; done: Promise<Result> }> = [];
  private pidFiles: string[] = [];

  constructor() {
    for (const dir of [
      'workspace',
      'home',
      'tmp',
      'cache',
      'state',
      'runtime',
    ]) {
      mkdirSync(join(this.root, dir));
    }
    this.env = {
      PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
      HOME: join(this.root, 'home'),
      TMPDIR: join(this.root, 'tmp'),
      XDG_CACHE_HOME: join(this.root, 'cache'),
      QWEN_HOME: join(this.root, 'state'),
      QWEN_RUNTIME_DIR: join(this.root, 'runtime'),
      QWEN_SANDBOX: 'bwrap',
      QWEN_SANDBOX_NET: 'open',
      QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      LC_ALL: 'C',
      NO_PROXY: '127.0.0.1,localhost',
    };
  }

  start(
    argv: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; direct?: boolean } = {},
  ) {
    let stdout = '';
    let stderr = '';
    let error: Error | undefined;
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const child = spawn(
      process.execPath,
      options.direct ? argv : [bundle, '--bare', ...argv],
      {
        cwd: options.cwd ?? this.workspace,
        env: { ...this.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    child.on('error', (cause) => {
      error = cause;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    }, 30_000);
    const done = new Promise<Result>((resolveResult) => {
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        clearTimeout(forceTimer);
        resolveResult({ code, signal, stdout, stderr, timedOut, error });
      });
    });
    const running = { child, done };
    this.processes.push(running);
    return running;
  }

  async run(argv: string[], options: Parameters<Fixture['start']>[1] = {}) {
    const result = await this.start(argv, options).done;
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.timedOut, result.stderr).toBe(false);
    return result;
  }

  pidFile(name: string) {
    const file = join(this.workspace, `${name}.json`);
    this.pidFiles.push(file);
    return file;
  }

  async readPid(file: string): Promise<number> {
    await expect
      .poll(
        () => {
          try {
            return JSON.parse(readFileSync(file, 'utf8')).pid as number;
          } catch {
            return undefined;
          }
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(1);
    return JSON.parse(readFileSync(file, 'utf8')).pid as number;
  }

  async cleanup() {
    const errors: unknown[] = [];
    for (const { child } of this.processes) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM');
    }
    for (const file of this.pidFiles) {
      try {
        const { pid } = JSON.parse(readFileSync(file, 'utf8')) as {
          pid: number;
        };
        if (isRunning(pid)) process.kill(pid, 'SIGKILL');
      } catch (error) {
        if (
          !(error instanceof SyntaxError) &&
          !['ENOENT', 'ESRCH'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          errors.push(error);
      }
    }
    try {
      await Promise.all(this.processes.map(({ done }) => done));
    } finally {
      rmSync(this.root, { recursive: true, force: true });
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        'Could not clean up bwrap fixture processes',
      );
  }
}
