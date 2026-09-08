/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listTrustedMemoryMarkdownFiles,
  resolveTrustedMemoryFile,
  resolveTrustedMemoryRoot,
} from './trusted-memory-filesystem.js';

describe('trusted memory filesystem', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trusted-memory-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('reads a shared project store through a sibling project alias', async () => {
    const projectsRoot = path.join(tempDir, 'projects');
    const canonicalProject = path.join(projectsRoot, 'canonical');
    const memoryRoot = path.join(canonicalProject, 'memory');
    const alias = path.join(projectsRoot, 'alias');
    await fs.mkdir(path.join(memoryRoot, 'reference'), { recursive: true });
    await fs.writeFile(
      path.join(memoryRoot, 'reference', 'note.md'),
      'shared memory',
      'utf-8',
    );
    await fs.symlink(
      canonicalProject,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const aliasedMemoryRoot = path.join(alias, 'memory');

    await expect(
      resolveTrustedMemoryRoot(aliasedMemoryRoot, tempDir),
    ).resolves.toBe(await fs.realpath(memoryRoot));
    await expect(
      listTrustedMemoryMarkdownFiles(aliasedMemoryRoot, tempDir, 'MEMORY.md'),
    ).resolves.toEqual([
      {
        relativePath: 'reference/note.md',
        resolvedPath: await fs.realpath(
          path.join(memoryRoot, 'reference', 'note.md'),
        ),
      },
    ]);
  });

  it('rejects a project alias that escapes the shared projects directory', async () => {
    const projectsRoot = path.join(tempDir, 'projects');
    const outsideProject = path.join(tempDir, 'outside');
    const alias = path.join(projectsRoot, 'alias');
    await fs.mkdir(path.join(outsideProject, 'memory'), { recursive: true });
    await fs.mkdir(projectsRoot, { recursive: true });
    await fs.symlink(
      outsideProject,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(
      resolveTrustedMemoryRoot(path.join(alias, 'memory'), tempDir),
    ).rejects.toThrow('Memory root resolves outside its trusted boundary');
  });

  it('rejects a shared projects directory that resolves outside the anchor', async () => {
    const outsideProjects = await fs.mkdtemp(
      path.join(os.tmpdir(), 'outside-projects-'),
    );
    try {
      const canonicalProject = path.join(outsideProjects, 'canonical');
      await fs.mkdir(path.join(canonicalProject, 'memory'), {
        recursive: true,
      });
      await fs.symlink(
        outsideProjects,
        path.join(tempDir, 'projects'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      await expect(
        resolveTrustedMemoryRoot(
          path.join(tempDir, 'projects', 'canonical', 'memory'),
          tempDir,
        ),
      ).rejects.toThrow('Memory root resolves outside its trusted boundary');
    } finally {
      await fs.rm(outsideProjects, { recursive: true, force: true });
    }
  });

  it('accepts a shared projects directory relocated within the anchor', async () => {
    const sharedProjects = path.join(tempDir, 'shared-projects');
    const memoryRoot = path.join(sharedProjects, 'canonical', 'memory');
    await fs.mkdir(memoryRoot, { recursive: true });
    await fs.symlink(
      sharedProjects,
      path.join(tempDir, 'projects'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(
      resolveTrustedMemoryRoot(
        path.join(tempDir, 'projects', 'canonical', 'memory'),
        tempDir,
      ),
    ).resolves.toBe(await fs.realpath(memoryRoot));
  });

  it.runIf(process.platform !== 'win32')(
    'round-trips a POSIX filename containing a backslash',
    async () => {
      const memoryRoot = path.join(tempDir, 'memory');
      const filename = 'a\\b.md';
      await fs.mkdir(memoryRoot);
      await fs.writeFile(path.join(memoryRoot, filename), 'memory', 'utf-8');

      const [listed] = await listTrustedMemoryMarkdownFiles(
        memoryRoot,
        tempDir,
        'MEMORY.md',
      );

      expect(listed?.relativePath).toBe(filename);
      await expect(
        resolveTrustedMemoryFile(memoryRoot, tempDir, listed!.relativePath),
      ).resolves.toBe(listed!.resolvedPath);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'skips an unreadable child directory during traversal',
    async () => {
      const memoryRoot = path.join(tempDir, 'memory');
      const unreadable = path.join(memoryRoot, 'unreadable');
      await fs.mkdir(unreadable, { recursive: true });
      await fs.writeFile(path.join(memoryRoot, 'good.md'), 'good', 'utf-8');
      await fs.chmod(unreadable, 0);

      try {
        await expect(
          listTrustedMemoryMarkdownFiles(memoryRoot, tempDir, 'MEMORY.md'),
        ).resolves.toEqual([
          {
            relativePath: 'good.md',
            resolvedPath: await fs.realpath(path.join(memoryRoot, 'good.md')),
          },
        ]);
      } finally {
        await fs.chmod(unreadable, 0o700);
      }
    },
  );
});
