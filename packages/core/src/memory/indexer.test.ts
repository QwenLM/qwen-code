/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAutoMemoryIndexPath, getAutoMemoryTopicPath } from './paths.js';
import {
  buildAutoMemoryTopicHooks,
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
    await ensureAutoMemoryScaffold(projectRoot, new Date('2026-04-01T00:00:00.000Z'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  it('builds short hooks from unique topic bullets', () => {
    expect(
      buildAutoMemoryTopicHooks([
        '# User Memory',
        '',
        '- User prefers terse responses.',
        '- User prefers terse responses.',
        '- User likes dark mode.',
        '- User uses pnpm.',
        '- User writes tests first.',
      ].join('\n')),
    ).toEqual([
      'User prefers terse responses.',
      'User likes dark mode.',
      'User uses pnpm.',
    ]);
  });

  it('formats a compact managed index view', () => {
    const content = buildManagedAutoMemoryIndex([
      {
        type: 'user',
        filePath: 'user.md',
        title: 'User Memory',
        description: 'User profile',
        body: '# User Memory\n\n- User prefers terse responses.',
      },
    ]);

    expect(content).toContain('Durable entries: 1');
    expect(content).toContain('[User Memory](user.md)');
    expect(content).toContain('User prefers terse responses.');
  });

  it('rewrites MEMORY.md from topic file contents', async () => {
    await fs.writeFile(
      getAutoMemoryTopicPath(projectRoot, 'project'),
      [
        '---',
        'type: project',
        'title: Project Memory',
        'description: Project facts',
        '---',
        '',
        '# Project Memory',
        '',
        '- The repo uses pnpm workspaces.',
        '- CI runs vitest and typecheck.',
      ].join('\n'),
      'utf-8',
    );

    await rebuildManagedAutoMemoryIndex(projectRoot);

    const index = await fs.readFile(getAutoMemoryIndexPath(projectRoot), 'utf-8');
    expect(index).toContain('[Project Memory](project.md)');
    expect(index).toContain('The repo uses pnpm workspaces.');
    expect(index).toContain('CI runs vitest and typecheck.');
  });
});
