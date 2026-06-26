/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOOP_TASK_FILE_MAX_BYTES,
  readLoopTaskFile,
} from './loop-task-file.js';

// Make only readFile controllable; every other fs call stays real so the
// temp-dir fixtures keep working. The default impl calls through to actual.
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

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
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const writeProject = (content: string) =>
    fs
      .mkdir(path.join(projectRoot, '.qwen'), { recursive: true })
      .then(() =>
        fs.writeFile(path.join(projectRoot, '.qwen', 'loop.md'), content),
      );
  const writeHome = (content: string) =>
    fs
      .mkdir(path.join(homeDir, '.qwen'), { recursive: true })
      .then(() =>
        fs.writeFile(path.join(homeDir, '.qwen', 'loop.md'), content),
      );

  it('reads the project loop task file first', async () => {
    await writeProject('project tasks');
    await writeHome('user tasks');

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result).toEqual({
      status: 'found',
      path: path.join(projectRoot, '.qwen', 'loop.md'),
      content: 'project tasks',
      truncated: false,
    });
  });

  it('falls back to the user loop task file', async () => {
    await writeHome('user tasks');

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
    const outside = path.join(tempDir, 'secret.txt');
    await fs.writeFile(outside, 'secret tasks');
    await fs.symlink(outside, path.join(projectRoot, '.qwen', 'loop.md'));
    await writeHome('user tasks');

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      content: 'user tasks',
      truncated: false,
    });
  });

  it('refuses a project loop.md whose .qwen ancestor symlinks outside the workspace', async () => {
    // `.qwen -> <outside>` makes a final-component lstat pass while the file
    // resolves outside the project; realpath must catch the ancestor symlink.
    const outside = path.join(tempDir, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'loop.md'), 'escaped tasks');
    await fs.symlink(outside, path.join(projectRoot, '.qwen'));
    await writeHome('user tasks');

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      content: 'user tasks',
      truncated: false,
    });
  });

  it('skips a non-directory component at .qwen (ENOTDIR) and falls through', async () => {
    // A regular file where the `.qwen` dir should be → reading .qwen/loop.md
    // raises ENOTDIR; skip to home rather than throwing.
    await fs.writeFile(path.join(projectRoot, '.qwen'), 'not a dir');
    await writeHome('user tasks');

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      content: 'user tasks',
      truncated: false,
    });
  });

  it('skips a directory at the loop.md path and falls through', async () => {
    // A directory at the project path yields EISDIR on read — skip it, not throw.
    await fs.mkdir(path.join(projectRoot, '.qwen', 'loop.md'), {
      recursive: true,
    });
    await writeHome('user tasks');

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      content: 'user tasks',
      truncated: false,
    });
  });

  it('rethrows non-whitelisted fs errors (e.g. EACCES)', async () => {
    // Only ENOENT/EISDIR/ENOTDIR fall through to the next candidate; a real
    // error such as a permission denial must surface, not be swallowed.
    await writeProject('project tasks');
    const eacces = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    });
    vi.mocked(fs.readFile).mockRejectedValueOnce(eacces);

    await expect(readLoopTaskFile({ projectRoot, homeDir })).rejects.toThrow(
      /EACCES/,
    );
  });

  it('skips an empty or whitespace-only file and falls through', async () => {
    await writeProject('   \n\t  \n');
    await writeHome('user tasks');

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      content: 'user tasks',
      truncated: false,
    });
  });

  it('returns missing when every candidate is empty', async () => {
    await writeProject('');
    await writeHome('\n  \n');

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result).toEqual({
      status: 'missing',
      checkedPaths: [
        path.join(projectRoot, '.qwen', 'loop.md'),
        path.join(homeDir, '.qwen', 'loop.md'),
      ],
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

  it('byte-caps task files above the cap and flags them truncated', async () => {
    await writeProject('x'.repeat(LOOP_TASK_FILE_MAX_BYTES + 5));

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(Buffer.byteLength(result.content, 'utf8')).toBe(
        LOOP_TASK_FILE_MAX_BYTES,
      );
      expect(result.truncated).toBe(true);
    }
  });

  it('does not truncate task files at exactly the byte cap', async () => {
    await writeProject('x'.repeat(LOOP_TASK_FILE_MAX_BYTES));

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(Buffer.byteLength(result.content, 'utf8')).toBe(
        LOOP_TASK_FILE_MAX_BYTES,
      );
      expect(result.truncated).toBe(false);
    }
  });

  it('truncates on a UTF-8 boundary without exceeding the cap or inserting a replacement char', async () => {
    // 3-byte chars make the raw byte cap land mid-character.
    await writeProject('一'.repeat(LOOP_TASK_FILE_MAX_BYTES));

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
});
