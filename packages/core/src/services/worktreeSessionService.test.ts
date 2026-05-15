/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readWorktreeSession,
  writeWorktreeSession,
  clearWorktreeSession,
  type WorktreeSession,
} from './worktreeSessionService.js';

const sample: WorktreeSession = {
  slug: 'my-feature',
  worktreePath: '/repo/.qwen/worktrees/my-feature',
  worktreeBranch: 'worktree-my-feature',
  originalCwd: '/repo',
  originalBranch: 'main',
  originalHeadCommit: 'abc1234',
};

let tmpDir: string;
let filePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-session-test-'));
  filePath = path.join(tmpDir, 'test.worktree.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('readWorktreeSession', () => {
  it('returns null when file does not exist', async () => {
    expect(await readWorktreeSession(filePath)).toBeNull();
  });

  it('reads back what was written', async () => {
    await fs.writeFile(filePath, JSON.stringify(sample), 'utf-8');
    expect(await readWorktreeSession(filePath)).toEqual(sample);
  });

  it('rethrows non-ENOENT errors (e.g. malformed JSON)', async () => {
    await fs.writeFile(filePath, 'not valid json {', 'utf-8');
    await expect(readWorktreeSession(filePath)).rejects.toThrow();
  });
});

describe('writeWorktreeSession', () => {
  it('writes a readable JSON file', async () => {
    await writeWorktreeSession(filePath, sample);
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual(sample);
  });

  it('overwrites existing file', async () => {
    await writeWorktreeSession(filePath, sample);
    const updated = { ...sample, slug: 'updated' };
    await writeWorktreeSession(filePath, updated);
    expect(await readWorktreeSession(filePath)).toEqual(updated);
  });

  it('creates parent directory if missing', async () => {
    const nestedPath = path.join(tmpDir, 'nested', 'deep', 'session.json');
    await writeWorktreeSession(nestedPath, sample);
    expect(await readWorktreeSession(nestedPath)).toEqual(sample);
  });
});

describe('clearWorktreeSession', () => {
  it('deletes the file', async () => {
    await writeWorktreeSession(filePath, sample);
    await clearWorktreeSession(filePath);
    expect(await readWorktreeSession(filePath)).toBeNull();
  });

  it('is a no-op when file does not exist', async () => {
    await expect(clearWorktreeSession(filePath)).resolves.not.toThrow();
  });
});
