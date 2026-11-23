/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getSandboxFileVersion } from '../sandbox/file-version.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import {
  getAutoMemoryExtractCursorPath,
  getAutoMemoryMetadataPath,
  getAutoMemoryRoot,
} from './paths.js';
import {
  assertProjectMemoryCommit,
  readProjectMemoryCursor,
  updateProjectMemoryMetadata,
  withProjectMemoryCommit,
} from './project-commit.js';
import {
  commitProjectMemoryWrite,
  projectMemoryIndexWriteError,
} from './project-write.js';
import { ensureAutoMemoryScaffold, readAutoMemoryIndex } from './store.js';

let fixture: string;
let project: string;
let memory: string;

beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'project-memory-commit-'));
  project = path.join(fixture, 'repo');
  vi.stubEnv('QWEN_CODE_MEMORY_BASE_DIR', path.join(fixture, 'runtime'));
  await fs.mkdir(project);
  await ensureAutoMemoryScaffold(project, new Date(0));
  memory = getAutoMemoryRoot(project);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(fixture, { recursive: true, force: true });
});

const topic = (name: string) =>
  `---\ntype: project\nname: ${name}\n---\n${name}\n`;

it('publishes both topic writes into a shared index', async () => {
  await Promise.all(
    ['first', 'second'].map((name) => {
      const file = path.join(memory, `${name}.md`);
      return commitProjectMemoryWrite(memory, file, null, () =>
        atomicWriteFile(file, topic(name)),
      );
    }),
  );
  const index = await readAutoMemoryIndex(project);
  expect(index).toContain('[first](first.md)');
  expect(index).toContain('[second](second.md)');
});

it.each([false, true])(
  'rejects a second writer holding the same snapshot (exists: %s)',
  async (exists) => {
    const file = path.join(memory, 'same.md');
    if (exists) await fs.writeFile(file, topic('original'));
    const version = getSandboxFileVersion(file);
    const earlier = commitProjectMemoryWrite(memory, file, version, () =>
      atomicWriteFile(file, topic('first')),
    );
    const later = commitProjectMemoryWrite(memory, file, version, () =>
      atomicWriteFile(file, topic('second')),
    );
    const results = await Promise.allSettled([earlier, later]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const conflict = results.find((result) => result.status === 'rejected');
    expect(conflict).toMatchObject({ reason: { code: 'ESTALE' } });
    const saved = await fs.readFile(file, 'utf-8');
    expect(saved).toBe(
      results[0].status === 'fulfilled' ? topic('first') : topic('second'),
    );
  },
);

it('refuses to overwrite the generated index', async () => {
  const file = path.join(memory, 'MEMORY.md');
  const write = vi.fn();
  expect(projectMemoryIndexWriteError(project, file)).toContain('topic file');
  await expect(
    commitProjectMemoryWrite(memory, file, getSandboxFileVersion(file), write),
  ).rejects.toThrow('generated automatically');
  expect(write).not.toHaveBeenCalled();
});

it('merges independent metadata updates without rewinding updatedAt', async () => {
  const older = new Date('2026-11-18T00:00:00.000Z');
  const newer = new Date('2026-11-23T00:00:00.000Z');
  await Promise.all([
    updateProjectMemoryMetadata(project, newer, (meta) => {
      meta.lastExtractionSessionId = 'extract';
    }),
    updateProjectMemoryMetadata(project, older, (meta) => {
      meta.lastDreamSessionId = 'dream';
    }),
  ]);
  expect(
    JSON.parse(await fs.readFile(getAutoMemoryMetadataPath(project), 'utf-8')),
  ).toMatchObject({
    lastExtractionSessionId: 'extract',
    lastDreamSessionId: 'dream',
    updatedAt: newer.toISOString(),
  });
});

it('refuses publication after a different holder replaces the commit lock', async () => {
  const lock = path.join(path.dirname(memory), '.memory-commit.lock');
  const topicPath = path.join(memory, 'fenced.md');
  await expect(
    withProjectMemoryCommit(memory, async () => {
      await fs.rename(lock, path.join(fixture, 'former-lock'));
      await fs.mkdir(lock);
      await atomicWriteFile(topicPath, topic('must not publish'), {
        assertCanCommit: assertProjectMemoryCommit,
      });
    }),
  ).rejects.toThrow('commit lock changed before publication');
  await expect(fs.stat(topicPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await fs.stat(lock)).isDirectory()).toBe(true);
});

it.skipIf(process.platform === 'win32')(
  'rejects symlinked state files and managed ancestors',
  async () => {
    const outside = path.join(fixture, 'outside');
    await fs.mkdir(outside);
    const cursorPath = getAutoMemoryExtractCursorPath(project);
    const outsideCursor = path.join(outside, 'cursor.json');
    await fs.writeFile(outsideCursor, '{}');
    await fs.rm(cursorPath);
    await fs.symlink(outsideCursor, cursorPath);
    await expect(readProjectMemoryCursor(memory)).rejects.toThrow(
      'requires a regular file',
    );

    const parent = path.dirname(memory);
    await fs.rm(parent, { recursive: true });
    await fs.symlink(outside, parent);
    const mutate = vi.fn();
    await expect(withProjectMemoryCommit(memory, mutate)).rejects.toThrow(
      'requires a real directory',
    );
    expect(mutate).not.toHaveBeenCalled();
  },
);
