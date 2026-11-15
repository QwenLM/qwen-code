/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createExecFileMockModule,
  recordedExecFileCalls,
} from './exec-file-recorder.js';

describe('execFile recorder', () => {
  beforeEach(() => {
    recordedExecFileCalls.length = 0;
  });

  it('records callback calls with options while preserving stdout and stderr', async () => {
    const childProcess = await createExecFileMockModule();
    const args = [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err")',
    ];
    const options = { windowsHide: true };
    const result = await new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject) => {
        childProcess.execFile(
          process.execPath,
          args,
          options,
          (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve({ stdout, stderr });
          },
        );
      },
    );
    expect(result).toEqual({ stdout: 'out', stderr: 'err' });
    expect(recordedExecFileCalls).toEqual([
      { file: process.execPath, args, options },
    ]);
  });

  it('records callback calls without options', async () => {
    const childProcess = await createExecFileMockModule();
    const args = ['-e', 'process.stdout.write("out")'];
    const stdout = await new Promise<string>((resolve, reject) => {
      childProcess.execFile(process.execPath, args, (error, output) => {
        if (error) reject(error);
        else resolve(output);
      });
    });
    expect(stdout).toBe('out');
    expect(recordedExecFileCalls).toEqual([
      { file: process.execPath, args, options: {} },
    ]);
  });

  it('preserves the custom promisified stdout and stderr shape', async () => {
    const childProcess = await createExecFileMockModule();
    const args = [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err")',
    ];
    const options = { windowsHide: true };
    expect(
      await promisify(childProcess.execFile)(process.execPath, args, options),
    ).toEqual({
      stdout: 'out',
      stderr: 'err',
    });
    expect(recordedExecFileCalls).toEqual([
      { file: process.execPath, args, options },
    ]);
  });

  it('preserves rejection output and exit codes on the custom promisified path', async () => {
    const childProcess = await createExecFileMockModule();
    const args = [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(7)',
    ];
    await expect(
      promisify(childProcess.execFile)(process.execPath, args),
    ).rejects.toMatchObject({ code: 7, stdout: 'out', stderr: 'err' });
    expect(recordedExecFileCalls).toEqual([
      { file: process.execPath, args, options: {} },
    ]);
  });

  it('leaves synchronous execution untouched and exposes the same default wrapper', async () => {
    const actual =
      await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
    const childProcess = await createExecFileMockModule();
    expect(childProcess.execFileSync).toBe(actual.execFileSync);
    expect(childProcess.default.execFile).toBe(childProcess.execFile);
    expect(
      childProcess.execFileSync(
        process.execPath,
        ['-e', 'process.stdout.write("sync")'],
        { encoding: 'utf8' },
      ),
    ).toBe('sync');
    expect(recordedExecFileCalls).toEqual([]);
  });
});
