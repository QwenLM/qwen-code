/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAutoMemoryTopicPath } from './paths.js';
import { runManagedAutoMemoryDream } from './dream.js';
import { ensureAutoMemoryScaffold } from './store.js';

describe('managed auto-memory dream', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-memory-dream-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(projectRoot);
  });

  afterEach(async () => {
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  it('deduplicates repeated bullet entries in topic files', async () => {
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
        '- User prefers terse responses.',
        '- User likes dark mode.',
      ].join('\n'),
      'utf-8',
    );

    const result = await runManagedAutoMemoryDream(projectRoot);
    const content = await fs.readFile(
      getAutoMemoryTopicPath(projectRoot, 'user'),
      'utf-8',
    );

    expect(result.touchedTopics).toContain('user');
    expect(result.dedupedEntries).toBe(1);
    expect(content.match(/User prefers terse responses\./g)).toHaveLength(1);
  });

  it('restores the empty placeholder when no bullet entries remain', async () => {
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
      ].join('\n'),
      'utf-8',
    );

    await runManagedAutoMemoryDream(projectRoot);
    const content = await fs.readFile(
      getAutoMemoryTopicPath(projectRoot, 'project'),
      'utf-8',
    );

    expect(content).toContain('_No entries yet._');
  });
});