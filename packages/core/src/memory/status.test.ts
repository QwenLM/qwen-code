/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getManagedAutoMemoryDreamTaskRegistry } from './dreamScheduler.js';
import { getManagedAutoMemoryStatus } from './status.js';
import { getAutoMemoryTopicPath } from './paths.js';
import { ensureAutoMemoryScaffold } from './store.js';
import { markExtractRunning, resetAutoMemoryStateForTests } from './state.js';

describe('managed auto-memory status', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-memory-status-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(projectRoot, new Date('2026-04-01T00:00:00.000Z'));
  });

  afterEach(async () => {
    resetAutoMemoryStateForTests();
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  it('aggregates cursor, topics, extraction state, and dream tasks', async () => {
    await fs.writeFile(
      getAutoMemoryTopicPath(projectRoot, 'user'),
      [
        '---',
        'type: user',
        'title: User Memory',
        'description: User profile',
        '---',
        '',
        '# User Memory',
        '',
        '- User prefers terse responses.',
      ].join('\n'),
      'utf-8',
    );

    markExtractRunning(projectRoot);
    getManagedAutoMemoryDreamTaskRegistry().register({
      taskType: 'managed-auto-memory-dream',
      title: 'Managed auto-memory dream',
      projectRoot,
    });

    const status = await getManagedAutoMemoryStatus(projectRoot);

    expect(status.extractionRunning).toBe(true);
    expect(status.topics.find((topic) => topic.topic === 'user')).toEqual(
      expect.objectContaining({
        entryCount: 1,
        hooks: ['User prefers terse responses.'],
      }),
    );
    expect(status.dreamTasks).toHaveLength(1);
    expect(status.indexContent).toContain('# Managed Auto-Memory Index');
  });
});
