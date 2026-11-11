/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { open, symlink, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  _resetTaskOutputDirForTest,
  initTaskOutputAsSymlink,
  setTaskOutputDir,
} from './diskOutput.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    symlink: vi.fn(actual.symlink),
    unlink: vi.fn(actual.unlink),
  };
});

vi.mock('../runLogger.js', () => ({ runLogger: { warn: vi.fn() } }));

describe('task output symlink fallback', () => {
  let tmpDir: string;
  let outputPath: string;
  let targetPath: string;
  const permissionError = () =>
    Object.assign(new Error('symlink not permitted'), { code: 'EPERM' });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-symlink-test-'));
    outputPath = path.join(tmpDir, 'task.output');
    targetPath = path.join(tmpDir, 'missing', 'transcript.jsonl');
    setTaskOutputDir(tmpDir);
    vi.mocked(open).mockReset().mockImplementation(fs.promises.open);
    vi.mocked(unlink).mockReset().mockImplementation(fs.promises.unlink);
    vi.mocked(symlink).mockReset().mockRejectedValue(permissionError());
  });

  afterEach(() => {
    _resetTaskOutputDirForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function expectPlainOutput() {
    await expect(initTaskOutputAsSymlink('task', targetPath)).resolves.toBe(
      outputPath,
    );
    expect(fs.lstatSync(outputPath).isFile()).toBe(true);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('');
  }

  it('falls back when symlink is denied without leaving a path', async () => {
    await expectPlainOutput();
  });

  it('removes the path left by the second failed symlink attempt', async () => {
    // A regular-file residue also exercises cleanup on Windows without needing
    // permission to create a real symlink in the test process.
    vi.mocked(symlink).mockImplementation(async () => {
      fs.writeFileSync(outputPath, 'failed symlink residue', { flag: 'wx' });
      throw permissionError();
    });

    await expectPlainOutput();
    expect(symlink).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform === 'win32')(
    'replaces a dangling symlink left by a rejected symlink operation',
    async () => {
      vi.mocked(symlink).mockImplementation(async () => {
        await fs.promises.symlink(targetPath, outputPath);
        throw permissionError();
      });

      await expectPlainOutput();
      expect(fs.existsSync(targetPath)).toBe(false);
    },
  );

  it('keeps the captured output path when the configured directory changes', async () => {
    vi.mocked(symlink).mockImplementation(async () => {
      fs.writeFileSync(outputPath, 'residue', { flag: 'wx' });
      setTaskOutputDir(path.join(tmpDir, 'later-session'));
      throw permissionError();
    });

    await expectPlainOutput();
    expect(fs.existsSync(path.join(tmpDir, 'later-session'))).toBe(false);
  });

  it('propagates cleanup errors without trying to open the leftover path', async () => {
    const cleanupError = Object.assign(new Error('cannot remove residue'), {
      code: 'EACCES',
    });
    vi.mocked(symlink).mockImplementation(async () => {
      fs.writeFileSync(outputPath, 'residue', { flag: 'wx' });
      throw permissionError();
    });
    vi.mocked(unlink)
      .mockImplementationOnce(fs.promises.unlink)
      .mockRejectedValueOnce(cleanupError);

    await expect(initTaskOutputAsSymlink('task', targetPath)).rejects.toBe(
      cleanupError,
    );
    expect(open).not.toHaveBeenCalled();
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('residue');
  });

  it('does not overwrite a file that appears after fallback cleanup', async () => {
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      fs.writeFileSync(outputPath, 'concurrent file', { flag: 'wx' });
      return fs.promises.open(...args);
    });

    await expect(initTaskOutputAsSymlink('task', targetPath)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('concurrent file');
  });
});
