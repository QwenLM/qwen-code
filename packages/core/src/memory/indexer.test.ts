/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAutoMemoryFilePath, getAutoMemoryIndexPath } from './paths.js';
import {
  buildManagedAutoMemoryIndex,
  rebuildManagedAutoMemoryIndex,
} from './indexer.js';
import { ensureAutoMemoryScaffold } from './store.js';

describe('managed auto-memory indexer', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-memory-indexer-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(
      projectRoot,
      new Date('2026-04-01T00:00:00.000Z'),
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  it('formats a compact file-based MEMORY.md index view', () => {
    const content = buildManagedAutoMemoryIndex([
      {
        type: 'user',
        filePath: '/tmp/user/terse.md',
        relativePath: 'user/terse.md',
        filename: 'terse.md',
        title: 'User Memory',
        description: 'User profile',
        body: 'User prefers terse responses.',
        mtimeMs: 0,
      },
    ]);

    expect(content).toBe('- [User Memory](user/terse.md) — User profile');
  });

  it('rewrites MEMORY.md from topic file contents', async () => {
    const projectFile = getAutoMemoryFilePath(
      projectRoot,
      path.join('project', 'repo-workspaces.md'),
    );
    await fs.mkdir(path.dirname(projectFile), { recursive: true });
    await fs.writeFile(
      projectFile,
      [
        '---',
        'type: project',
        'name: Project Memory',
        'description: The repo uses pnpm workspaces.',
        '---',
        '',
        'The repo uses pnpm workspaces.',
      ].join('\n'),
      'utf-8',
    );

    await rebuildManagedAutoMemoryIndex(projectRoot);

    const index = await fs.readFile(
      getAutoMemoryIndexPath(projectRoot),
      'utf-8',
    );
    expect(index).toContain('[Project Memory](project/repo-workspaces.md)');
    expect(index).toContain('The repo uses pnpm workspaces.');
  });
});
