/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { getAutoMemoryIndexPath, getAutoMemoryTopicPath } from './paths.js';
import { runManagedAutoMemoryDream } from './dream.js';
import { ensureAutoMemoryScaffold } from './store.js';

vi.mock('./dreamAgentPlanner.js', () => ({
  planManagedAutoMemoryDreamByAgent: vi.fn(),
}));

import { planManagedAutoMemoryDreamByAgent } from './dreamAgentPlanner.js';

describe('managed auto-memory dream', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-memory-dream-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(projectRoot);
    vi.mocked(planManagedAutoMemoryDreamByAgent).mockReset();
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
    const index = await fs.readFile(getAutoMemoryIndexPath(projectRoot), 'utf-8');

    expect(result.touchedTopics).toContain('user');
    expect(result.dedupedEntries).toBe(1);
    expect(content.match(/User prefers terse responses\./g)).toHaveLength(1);
    expect(index.match(/User prefers terse responses\./g)).toHaveLength(1);
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

  it('prefers agent rewrites when config is provided', async () => {
    vi.mocked(planManagedAutoMemoryDreamByAgent).mockResolvedValue([
      {
        topic: 'user',
        body: '# User Memory\n\n- User prefers terse responses.',
      },
    ]);

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
      ].join('\n'),
      'utf-8',
    );

    const result = await runManagedAutoMemoryDream(
      projectRoot,
      new Date('2026-04-02T00:00:00.000Z'),
      {
        getSessionId: vi.fn(),
        getModel: vi.fn(),
      } as unknown as Config,
    );
    const content = await fs.readFile(
      getAutoMemoryTopicPath(projectRoot, 'user'),
      'utf-8',
    );

    expect(result.touchedTopics).toEqual(['user']);
    expect(result.dedupedEntries).toBe(1);
    expect(content.match(/User prefers terse responses\./g)).toHaveLength(1);
  });

  it('falls back to mechanical dream when the agent planner fails', async () => {
    vi.mocked(planManagedAutoMemoryDreamByAgent).mockRejectedValue(
      new Error('agent failed'),
    );

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
      ].join('\n'),
      'utf-8',
    );

    const result = await runManagedAutoMemoryDream(
      projectRoot,
      new Date('2026-04-02T00:00:00.000Z'),
      {
        getSessionId: vi.fn(),
        getModel: vi.fn(),
      } as unknown as Config,
    );

    expect(result.touchedTopics).toContain('user');
    expect(result.dedupedEntries).toBe(1);
  });
});