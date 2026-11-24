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
import * as noFollowOpen from '../utils/no-follow-open.js';
import {
  getAutoMemoryExtractCursorPath,
  getAutoMemoryMetadataPath,
  getAutoMemoryRoot,
} from './paths.js';
import {
  markProjectMemoryIndexPendingLocked,
  readProjectMemoryCursor,
  updateProjectMemoryMetadata,
  withProjectMemoryCommit,
} from './project-commit.js';
import {
  commitProjectMemoryWrite,
  commitProjectMemoryWrites,
  projectMemoryIndexWriteError,
} from './project-write.js';
import { MAX_INDEX_CHARS, MAX_INDEX_LINES } from './index-budget.js';
import { ensureAutoMemoryScaffold, readAutoMemoryIndex } from './store.js';

let fixture: string;
let project: string;
let memory: string;

beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'project-memory-commit-'));
  project = path.join(fixture, 'repo');
  vi.stubEnv('QWEN_CODE_MEMORY_LOCAL', undefined);
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
      return commitProjectMemoryWrite(memory, file, null, topic(name));
    }),
  );
  const index = await readAutoMemoryIndex(project);
  expect(index).toContain('[first](first.md)');
  expect(index).toContain('[second](second.md)');
});

it('commits project topics and their index in the current checkout in local mode', async () => {
  vi.stubEnv('QWEN_CODE_MEMORY_LOCAL', '1');
  const root = getAutoMemoryRoot(project);
  const file = path.join(root, 'local.md');
  await commitProjectMemoryWrites(root, [
    { path: file, expected: null, content: topic('local') },
  ]);
  expect(root).toBe(path.join(project, '.qwen', 'memory'));
  expect(await readAutoMemoryIndex(project)).toContain('[local](local.md)');
});

it('writes scaffold state to the explicit owner instead of the active checkout', async () => {
  const selected = path.join(fixture, 'selected');
  const checkout = path.join(fixture, 'checkout');
  await ensureAutoMemoryScaffold(checkout, undefined, {
    cwd: selected,
    memoryBaseDir: path.join(fixture, 'runtime'),
  });
  expect(
    await readProjectMemoryCursor(getAutoMemoryRoot(selected)),
  ).toBeDefined();
  expect(
    await readProjectMemoryCursor(getAutoMemoryRoot(checkout)),
  ).toBeUndefined();
});

it.skipIf(process.platform === 'win32')(
  'supports a runtime base alias and rejects a symlinked project index',
  async () => {
    const alias = path.join(fixture, 'runtime-alias');
    await fs.symlink(path.join(fixture, 'runtime'), alias, 'dir');
    vi.stubEnv('QWEN_CODE_MEMORY_BASE_DIR', alias);
    expect(await readAutoMemoryIndex(project)).toBe('');
    const target = path.join(fixture, 'other-index.md');
    await fs.writeFile(target, 'Outside project memory');
    const index = path.join(memory, 'MEMORY.md');
    await fs.unlink(index);
    await fs.symlink(target, index);
    await expect(readAutoMemoryIndex(project)).rejects.toMatchObject({
      code: 'ELOOP',
    });
  },
);

it.each([false, true])(
  'rejects a second writer holding the same snapshot (exists: %s)',
  async (exists) => {
    const file = path.join(memory, 'same.md');
    if (exists) await fs.writeFile(file, topic('original'));
    const version = getSandboxFileVersion(file);
    const earlier = commitProjectMemoryWrite(
      memory,
      file,
      version,
      topic('first'),
    );
    const later = commitProjectMemoryWrite(
      memory,
      file,
      version,
      topic('second'),
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
  expect(projectMemoryIndexWriteError(memory, file)).toContain('topic file');
  await expect(
    commitProjectMemoryWrite(
      memory,
      file,
      getSandboxFileVersion(file),
      'unapproved',
    ),
  ).rejects.toThrow('generated automatically');
  expect(await fs.readFile(file, 'utf-8')).toBe('');
});

it('repairs a topic write when the generated index could not be published', async () => {
  const file = path.join(memory, 'interrupted.md');
  const index = path.join(memory, 'MEMORY.md');
  await fs.unlink(index);
  await fs.mkdir(index);
  await commitProjectMemoryWrite(memory, file, null, topic('interrupted'));
  expect(await fs.readFile(file, 'utf-8')).toBe(topic('interrupted'));
  expect(await readProjectMemoryCursor(memory)).toMatchObject({
    projectIndexRebuildPending: true,
  });

  await fs.rmdir(index);
  expect(await readAutoMemoryIndex(project)).toContain(
    '[interrupted](interrupted.md)',
  );
  expect(await readProjectMemoryCursor(memory)).not.toHaveProperty(
    'projectIndexRebuildPending',
  );
});

it.each([false, true])(
  'bounds index recovery when the store becomes dirty during read (repeat: %s)',
  async (repeat) => {
    const open = noFollowOpen.openNoFollow;
    let writes = 0;
    const spy = vi
      .spyOn(noFollowOpen, 'openNoFollow')
      .mockImplementation(async (file, options) => {
        const handle = await open(file, options);
        if (writes < (repeat ? 2 : 1) && path.basename(file) === 'MEMORY.md') {
          writes++;
          await withProjectMemoryCommit(memory, async () => {
            await markProjectMemoryIndexPendingLocked(memory);
            await fs.writeFile(
              path.join(memory, `raced-${writes}.md`),
              topic('raced'),
            );
          });
        }
        return handle;
      });
    try {
      const result = await readAutoMemoryIndex(project);
      const pending = (await readProjectMemoryCursor(memory))
        ?.projectIndexRebuildPending;
      if (repeat) {
        expect(result).toBeNull();
        expect(pending).toBe(true);
      } else {
        expect(result).toContain('[raced](raced-1.md)');
        expect(pending).toBeUndefined();
      }
    } finally {
      spy.mockRestore();
    }
  },
);

it('validates the entire approved batch before publishing any topic', async () => {
  const existing = path.join(memory, 'existing.md');
  const addition = path.join(memory, 'addition.md');
  await fs.writeFile(existing, topic('before'));
  const version = getSandboxFileVersion(existing);
  await atomicWriteFile(existing, topic('concurrent edit'));
  await expect(
    commitProjectMemoryWrites(memory, [
      { path: addition, expected: null, content: topic('addition') },
      { path: existing, expected: version, content: topic('approved update') },
    ]),
  ).rejects.toMatchObject({ code: 'ESTALE' });
  await expect(fs.stat(addition)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(existing, 'utf-8')).toBe(topic('concurrent edit'));
  expect(await readProjectMemoryCursor(memory)).not.toHaveProperty(
    'projectIndexRebuildPending',
  );
});

it('includes the notices in the generated project index budget', async () => {
  await commitProjectMemoryWrites(
    memory,
    Array.from({ length: 205 }, (_, number) => ({
      path: path.join(memory, `topic-${number}.md`),
      expected: null,
      content: topic(`Topic ${number}`),
    })),
  );
  const index = (await readAutoMemoryIndex(project))!;
  expect(index).toContain('WARNING: MEMORY.md');
  expect(index.split('\n').length).toBeLessThanOrEqual(MAX_INDEX_LINES);
  expect(index.length).toBeLessThanOrEqual(MAX_INDEX_CHARS);
  expect(
    (await fs.readdir(memory)).filter((name) => name !== 'MEMORY.md'),
  ).toHaveLength(205);
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
