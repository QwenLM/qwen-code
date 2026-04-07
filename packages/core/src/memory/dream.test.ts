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
import { getAutoMemoryFilePath, getAutoMemoryIndexPath } from './paths.js';
import { runManagedAutoMemoryDream } from './dream.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';
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
    const firstPath = getAutoMemoryFilePath(projectRoot, path.join('user', 'terse.md'));
    const duplicatePath = getAutoMemoryFilePath(projectRoot, path.join('user', 'terse-duplicate.md'));
    await fs.mkdir(path.dirname(firstPath), { recursive: true });
    await fs.writeFile(
      firstPath,
      [
        '---',
        'type: user',
        'name: User Memory',
        'description: User profile',
        '---',
        '',
        'User prefers terse responses.',
      ].join('\n'),
      'utf-8',
    );
    await fs.writeFile(
      duplicatePath,
      [
        '---',
        'type: user',
        'name: User Memory Duplicate',
        'description: Duplicate terse preference',
        '---',
        '',
        'User prefers terse responses.',
      ].join('\n'),
      'utf-8',
    );

    const result = await runManagedAutoMemoryDream(projectRoot);
    const index = await fs.readFile(getAutoMemoryIndexPath(projectRoot), 'utf-8');
    const docs = await scanAutoMemoryTopicDocuments(projectRoot);
    const userDocs = docs.filter((doc) => doc.type === 'user');

    expect(result.touchedTopics).toContain('user');
    expect(result.dedupedEntries).toBe(1);
    expect(userDocs).toHaveLength(1);
    expect(userDocs[0]?.body).toContain('User prefers terse responses.');
    expect(index).toContain('(user/');
  });

  it('preserves Claude-style why/apply metadata when deduplicating entries', async () => {
    const firstPath = getAutoMemoryFilePath(projectRoot, path.join('user', 'terse.md'));
    const duplicatePath = getAutoMemoryFilePath(projectRoot, path.join('user', 'terse-context.md'));
    await fs.mkdir(path.dirname(firstPath), { recursive: true });
    await fs.writeFile(
      firstPath,
      [
        '---',
        'type: user',
        'name: User Memory',
        'description: User profile',
        '---',
        '',
        'User prefers terse responses.',
        '',
        'Why: They repeatedly ask for concise replies.',
      ].join('\n'),
      'utf-8',
    );
    await fs.writeFile(
      duplicatePath,
      [
        '---',
        'type: user',
        'name: User Memory Context',
        'description: Duplicate terse preference with apply guidance',
        '---',
        '',
        'User prefers terse responses.',
        '',
        'How to apply: Lead with a short answer before details.',
      ].join('\n'),
      'utf-8',
    );

    await runManagedAutoMemoryDream(projectRoot);

    const docs = await scanAutoMemoryTopicDocuments(projectRoot);
    const content = docs.find((doc) => doc.type === 'user')?.body ?? '';

    expect(content.match(/User prefers terse responses\./g)).toHaveLength(1);
    expect(content).toContain('Why: They repeatedly ask for concise replies.');
    expect(content).toContain('How to apply: Lead with a short answer before details.');
  });

  it('leaves empty placeholder documents unchanged', async () => {
    const projectPath = getAutoMemoryFilePath(projectRoot, path.join('project', 'empty.md'));
    await fs.mkdir(path.dirname(projectPath), { recursive: true });
    await fs.writeFile(
      projectPath,
      [
        '---',
        'type: project',
        'name: Project Memory',
        'description: Project facts',
        '---',
        '',
        '_No entries yet._',
      ].join('\n'),
      'utf-8',
    );

    await runManagedAutoMemoryDream(projectRoot);
    const content = await fs.readFile(projectPath, 'utf-8');

    expect(content).toContain('_No entries yet._');
  });

  it('falls back to mechanical dedupe when config is provided', async () => {
    const firstPath = getAutoMemoryFilePath(projectRoot, path.join('user', 'terse.md'));
    const duplicatePath = getAutoMemoryFilePath(projectRoot, path.join('user', 'terse-again.md'));
    await fs.mkdir(path.dirname(firstPath), { recursive: true });

    await fs.writeFile(
      firstPath,
      [
        '---',
        'type: user',
        'name: User Memory',
        'description: User profile',
        '---',
        '',
        'User prefers terse responses.',
      ].join('\n'),
      'utf-8',
    );
    await fs.writeFile(
      duplicatePath,
      [
        '---',
        'type: user',
        'name: User Memory Duplicate',
        'description: Duplicate terse preference',
        '---',
        '',
        'User prefers terse responses.',
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
    const docs = await scanAutoMemoryTopicDocuments(projectRoot);

    expect(result.touchedTopics).toContain('user');
    expect(result.dedupedEntries).toBe(1);
    expect(docs.filter((doc) => doc.type === 'user')).toHaveLength(1);
  });

  it('falls back to mechanical dream when the agent planner fails', async () => {
    vi.mocked(planManagedAutoMemoryDreamByAgent).mockRejectedValue(
      new Error('agent failed'),
    );

    const firstPath = getAutoMemoryFilePath(projectRoot, path.join('user', 'terse.md'));
    const duplicatePath = getAutoMemoryFilePath(projectRoot, path.join('user', 'terse-failover.md'));
    await fs.mkdir(path.dirname(firstPath), { recursive: true });

    await fs.writeFile(
      firstPath,
      [
        '---',
        'type: user',
        'name: User Memory',
        'description: User profile',
        '---',
        '',
        'User prefers terse responses.',
      ].join('\n'),
      'utf-8',
    );
    await fs.writeFile(
      duplicatePath,
      [
        '---',
        'type: user',
        'name: User Memory Duplicate',
        'description: Duplicate terse preference',
        '---',
        '',
        'User prefers terse responses.',
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