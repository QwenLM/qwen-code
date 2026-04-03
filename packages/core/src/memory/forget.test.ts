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
  forgetManagedAutoMemoryEntries,
  forgetManagedAutoMemoryMatches,
  findManagedAutoMemoryForgetCandidates,
  selectManagedAutoMemoryForgetCandidates,
} from './forget.js';
import { getAutoMemoryIndexPath, getAutoMemoryTopicPath } from './paths.js';
import { ensureAutoMemoryScaffold } from './store.js';

describe('managed auto-memory forget', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-memory-forget-'));
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

  it('finds matching forget candidates across topics', async () => {
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
        '  - How to apply: Keep the first paragraph short.',
      ].join('\n'),
      'utf-8',
    );

    const matches = await findManagedAutoMemoryForgetCandidates(projectRoot, 'first paragraph short');
    expect(matches).toEqual([
      {
        topic: 'user',
        summary: 'User prefers terse responses.',
      },
    ]);
  });

  it('removes matching topic entries and rewrites the index', async () => {
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
        '- User likes dark mode.',
      ].join('\n'),
      'utf-8',
    );

    const result = await forgetManagedAutoMemoryEntries(projectRoot, 'terse');
    const topicContent = await fs.readFile(getAutoMemoryTopicPath(projectRoot, 'user'), 'utf-8');
    const indexContent = await fs.readFile(getAutoMemoryIndexPath(projectRoot), 'utf-8');

    expect(result.removedEntries).toEqual([
      {
        topic: 'user',
        summary: 'User prefers terse responses.',
      },
    ]);
    expect(topicContent).not.toContain('terse responses');
    expect(topicContent).toContain('User likes dark mode.');
    expect(indexContent).not.toContain('terse responses');
    expect(indexContent).toContain('User likes dark mode.');
  });

  it('restores the empty placeholder when all matching entries are removed', async () => {
    await fs.writeFile(
      getAutoMemoryTopicPath(projectRoot, 'feedback'),
      [
        '---',
        'type: feedback',
        'title: Feedback Memory',
        'description: Guidance',
        '---',
        '',
        '# Feedback Memory',
        '',
        '- Always answer tersely.',
      ].join('\n'),
      'utf-8',
    );

    await forgetManagedAutoMemoryEntries(projectRoot, 'tersely');
    const content = await fs.readFile(getAutoMemoryTopicPath(projectRoot, 'feedback'), 'utf-8');

    expect(content).toContain('_No entries yet._');
  });

  it('supports explicit candidate deletion after preview selection', async () => {
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
        '- User likes dark mode.',
      ].join('\n'),
      'utf-8',
    );

    const selection = await selectManagedAutoMemoryForgetCandidates(
      projectRoot,
      'dark mode',
    );
    const result = await forgetManagedAutoMemoryMatches(
      projectRoot,
      selection.matches,
    );
    const content = await fs.readFile(
      getAutoMemoryTopicPath(projectRoot, 'user'),
      'utf-8',
    );

    expect(selection.matches).toEqual([
      {
        topic: 'user',
        summary: 'User likes dark mode.',
      },
    ]);
    expect(result.removedEntries).toEqual(selection.matches);
    expect(content).not.toContain('dark mode');
    expect(content).toContain('terse responses');
  });
});
