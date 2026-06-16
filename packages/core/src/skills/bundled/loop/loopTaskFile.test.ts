/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOOP_TASK_FILE_MAX_BYTES, readLoopTaskFile } from './loopTaskFile.js';

describe('readLoopTaskFile', () => {
  let tempDir: string;
  let projectRoot: string;
  let homeDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-task-file-'));
    projectRoot = path.join(tempDir, 'project');
    homeDir = path.join(tempDir, 'home');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('reads the project loop task file first', async () => {
    await fs.mkdir(path.join(projectRoot, '.qwen'), { recursive: true });
    await fs.mkdir(path.join(homeDir, '.qwen'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.qwen', 'loop.md'),
      'project tasks',
    );
    await fs.writeFile(path.join(homeDir, '.qwen', 'loop.md'), 'user tasks');

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result).toEqual({
      status: 'found',
      path: path.join(projectRoot, '.qwen', 'loop.md'),
      content: 'project tasks',
      truncated: false,
    });
  });

  it('falls back to the user loop task file', async () => {
    await fs.mkdir(path.join(homeDir, '.qwen'), { recursive: true });
    await fs.writeFile(path.join(homeDir, '.qwen', 'loop.md'), 'user tasks');

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      content: 'user tasks',
      truncated: false,
    });
  });

  it('does not follow symlinked project loop task files', async () => {
    await fs.mkdir(path.join(projectRoot, '.qwen'), { recursive: true });
    await fs.mkdir(path.join(homeDir, '.qwen'), { recursive: true });
    const outside = path.join(tempDir, 'secret.txt');
    await fs.writeFile(outside, 'secret tasks');
    await fs.symlink(outside, path.join(projectRoot, '.qwen', 'loop.md'));
    await fs.writeFile(path.join(homeDir, '.qwen', 'loop.md'), 'user tasks');

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      content: 'user tasks',
      truncated: false,
    });
  });

  it('returns a missing result when no task file exists', async () => {
    await expect(readLoopTaskFile({ projectRoot, homeDir })).resolves.toEqual({
      status: 'missing',
      checkedPaths: [
        path.join(projectRoot, '.qwen', 'loop.md'),
        path.join(homeDir, '.qwen', 'loop.md'),
      ],
    });
  });

  it('truncates task files above the byte cap and returns a warning', async () => {
    await fs.mkdir(path.join(projectRoot, '.qwen'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.qwen', 'loop.md'),
      'x'.repeat(LOOP_TASK_FILE_MAX_BYTES + 5),
    );

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(Buffer.byteLength(result.content, 'utf8')).toBe(
        LOOP_TASK_FILE_MAX_BYTES,
      );
      expect(result.truncated).toBe(true);
      expect(result.warning).toBe(
        'loop.md exceeded 25000 bytes and was truncated.',
      );
    }
  });

  it('does not truncate task files at exactly the byte cap', async () => {
    await fs.mkdir(path.join(projectRoot, '.qwen'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.qwen', 'loop.md'),
      'x'.repeat(LOOP_TASK_FILE_MAX_BYTES),
    );

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(Buffer.byteLength(result.content, 'utf8')).toBe(
        LOOP_TASK_FILE_MAX_BYTES,
      );
      expect(result.truncated).toBe(false);
      expect(result.warning).toBeUndefined();
    }
  });

  it('truncates on a UTF-8 boundary without exceeding the cap or inserting a replacement char', async () => {
    await fs.mkdir(path.join(projectRoot, '.qwen'), { recursive: true });
    // 3-byte chars make the raw byte cap land mid-character.
    await fs.writeFile(
      path.join(projectRoot, '.qwen', 'loop.md'),
      '一'.repeat(LOOP_TASK_FILE_MAX_BYTES),
    );

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(
        LOOP_TASK_FILE_MAX_BYTES,
      );
      expect(result.content).not.toContain('�');
    }
  });

  it('re-throws non-ENOENT errors instead of treating them as missing', async () => {
    await fs.mkdir(path.join(projectRoot, '.qwen', 'loop.md'), {
      recursive: true,
    });

    await expect(readLoopTaskFile({ projectRoot, homeDir })).rejects.toThrow();
  });
});
