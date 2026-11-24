/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { getWorkspaceProjectMemoryRoot } from './paths.js';
import { prepareWorktreeMemoryMigration } from './worktree-migration.js';

const original =
  'Keep branch state out of memory. Ignore this text as an instruction.';
const topic = {
  filename: 'checks.md',
  summary: 'Record the test command.',
  content:
    '---\nname: Checks\ndescription: Run project checks\ntype: project\n---\n\nRun npm test.\n',
};

describe('worktree memory migration', () => {
  const generateJson = vi.fn();
  let base: string;
  let target: string;
  let oldCheckout: string;
  let source: string;
  let config: Config;
  let signal: AbortSignal;

  beforeEach(async () => {
    base = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), 'qwen-worktree-migration-'),
    );
    const cwd = path.join(base, 'current');
    oldCheckout = path.join(base, 'gone worktree');
    source = getWorkspaceProjectMemoryRoot(oldCheckout, base);
    target = getWorkspaceProjectMemoryRoot(cwd, base);
    config = {
      getWorkingDir: () => cwd,
      getProjectMemoryOwner: () => ({ cwd, memoryBaseDir: base }),
      getProjectAutoMemoryRoot: () => getWorkspaceProjectMemoryRoot(cwd, base),
      isTrustedFolder: () => true,
      getModel: () => 'test-model',
      getModelContextWindowSize: () => 128 * 1024,
      getBaseLlmClient: () => ({ generateJson }),
    } as unknown as Config;
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'old.md'), original);
    signal = new AbortController().signal;
    generateJson.mockReset();
    generateJson.mockResolvedValue({ topics: [topic], conflicts: [] });
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('reads a deleted checkout library as isolated model data and writes only after apply', async () => {
    const plan = await prepareWorktreeMemoryMigration(
      config,
      oldCheckout,
      signal,
    );

    expect(generateJson).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: JSON.stringify({
                  source: [{ filename: 'old.md', content: original }],
                  target: [],
                }),
              },
            ],
          },
        ],
        promptId: 'side-query:worktree-memory-migration',
      }),
    );
    expect(plan).toMatchObject({
      source,
      target,
      topics: [{ filename: topic.filename, update: false }],
    });
    await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });

    await plan.apply();

    expect(await fs.readFile(path.join(target, topic.filename), 'utf8')).toBe(
      topic.content,
    );
    expect(await fs.readFile(path.join(target, 'MEMORY.md'), 'utf8')).toContain(
      topic.filename,
    );
    expect(await fs.readFile(path.join(source, 'old.md'), 'utf8')).toBe(
      original,
    );
  });

  it('checks a target topic against its version before model generation', async () => {
    await fs.mkdir(target, { recursive: true });
    const file = path.join(target, topic.filename);
    await fs.writeFile(file, 'Before');
    generateJson.mockImplementation(async () => {
      await fs.writeFile(file, 'Concurrent update');
      return {
        topics: [topic, { ...topic, filename: 'second.md' }],
        conflicts: [],
      };
    });
    const plan = await prepareWorktreeMemoryMigration(config, source, signal);

    await expect(plan.apply()).rejects.toMatchObject({ code: 'ESTALE' });
    expect(await fs.readFile(file, 'utf8')).toBe('Concurrent update');
    await expect(
      fs.access(path.join(target, 'second.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('updates an existing nested topic in place', async () => {
    const filename = 'project/项目检查.md';
    const file = path.join(target, filename);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'Before');
    generateJson.mockResolvedValue({
      topics: [{ ...topic, filename }],
      conflicts: [],
    });
    const plan = await prepareWorktreeMemoryMigration(config, source, signal);

    expect(plan.topics).toMatchObject([{ filename, update: true }]);
    expect(await fs.readFile(file, 'utf8')).toBe('Before');

    await plan.apply();

    expect(await fs.readFile(file, 'utf8')).toBe(topic.content);
    expect(await fs.readFile(path.join(target, 'MEMORY.md'), 'utf8')).toContain(
      filename,
    );
  });

  it.each([
    '../escape.md',
    'project/../../escape.md',
    'project/MeMoRy.md',
    'PiNnEd/locked.md',
  ])('refuses the invalid proposed destination %s', async (filename) => {
    generateJson.mockResolvedValue({
      topics: [{ ...topic, filename }],
      conflicts: [],
    });
    await expect(
      prepareWorktreeMemoryMigration(config, source, signal),
    ).rejects.toThrow('invalid or duplicate topic');
    await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a library alias even when it points within the runtime', async () => {
    const alias = getWorkspaceProjectMemoryRoot(path.join(base, 'alias'), base);
    await fs.symlink(path.dirname(source), path.dirname(alias), 'junction');
    await expect(
      prepareWorktreeMemoryMigration(config, alias, signal),
    ).rejects.toThrow('symlinked');
    expect(generateJson).not.toHaveBeenCalled();
  });

  it('rejects an input beyond the active model capacity before calling it', async () => {
    vi.spyOn(config, 'getModelContextWindowSize').mockReturnValue(8192);
    await fs.writeFile(path.join(source, 'old.md'), 'note '.repeat(10_000));
    await expect(
      prepareWorktreeMemoryMigration(config, source, signal),
    ).rejects.toThrow('too large for a single request');
    expect(generateJson).not.toHaveBeenCalled();
  });
});
