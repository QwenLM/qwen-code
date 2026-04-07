/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runManagedAutoMemoryDream } from './dream.js';
import {
  drainManagedAutoMemoryExtractTasks,
  resetManagedAutoMemoryExtractRuntimeForTests,
  scheduleManagedAutoMemoryExtract,
} from './extractScheduler.js';
import { applyExtractedMemoryPatches } from './extract.js';
import { rebuildManagedAutoMemoryIndex } from './indexer.js';
import { getAutoMemoryFilePath, getAutoMemoryIndexPath } from './paths.js';
import { resolveRelevantAutoMemoryPromptForQuery } from './recall.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';
import { ensureAutoMemoryScaffold } from './store.js';
import { resetAutoMemoryStateForTests } from './state.js';

describe('managed auto-memory lifecycle integration', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-lifecycle-int-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(projectRoot, new Date('2026-04-01T00:00:00.000Z'));
  });

  afterEach(async () => {
    resetAutoMemoryStateForTests();
    resetManagedAutoMemoryExtractRuntimeForTests();
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  it('supports a Claude-style durable memory lifecycle across extraction, recall, and dream', async () => {
    const firstExtraction = scheduleManagedAutoMemoryExtract({
      projectRoot,
      sessionId: 'session-1',
      history: [{ role: 'user', parts: [{ text: 'I prefer terse responses.' }] }],
    });

    const queuedExtraction = await scheduleManagedAutoMemoryExtract({
      projectRoot,
      sessionId: 'session-1',
      history: [
        { role: 'user', parts: [{ text: 'I prefer terse responses.' }] },
        { role: 'model', parts: [{ text: 'Understood.' }] },
        {
          role: 'user',
          parts: [
            {
              text: 'The latency dashboard is https://grafana.example/d/api-latency',
            },
          ],
        },
      ],
    });

    expect(queuedExtraction.skippedReason).toBe('queued');

    const firstResult = await firstExtraction;
    expect(firstResult.touchedTopics).toEqual(['user']);

    const drained = await drainManagedAutoMemoryExtractTasks({ timeoutMs: 1_000 });
    expect(drained).toBe(true);

    await applyExtractedMemoryPatches(projectRoot, [
      {
        topic: 'project',
        summary: 'The latency dashboard is https://grafana.example/d/api-latency',
        sourceOffset: 100,
      },
      {
        topic: 'project',
        summary: 'This is temporary for this task.',
        sourceOffset: 101,
      },
    ]);

    const duplicateUserPath = getAutoMemoryFilePath(
      projectRoot,
      path.join('user', 'terse-duplicate.md'),
    );
    await fs.mkdir(path.dirname(duplicateUserPath), { recursive: true });
    await fs.writeFile(
      duplicateUserPath,
      [
        '---',
        'type: user',
        'name: User Memory Duplicate',
        'description: Duplicate terse preference',
        '---',
        '',
        'I prefer terse responses.',
        '',
        'Why: User repeatedly asks for concise replies.',
      ].join('\n'),
      'utf-8',
    );
    await rebuildManagedAutoMemoryIndex(projectRoot);

    const dreamResult = await runManagedAutoMemoryDream(
      projectRoot,
      new Date('2026-04-01T03:00:00.000Z'),
    );
    expect(dreamResult.touchedTopics).toContain('user');
    expect(dreamResult.dedupedEntries).toBeGreaterThan(0);

    const indexContent = await fs.readFile(
      getAutoMemoryIndexPath(projectRoot),
      'utf-8',
    );
    const docs = await scanAutoMemoryTopicDocuments(projectRoot);
    const userDoc = docs.find((doc) => doc.type === 'user');
    const projectDoc = docs.find((doc) => doc.type === 'project');
    const referenceDoc = docs.find((doc) => doc.type === 'reference');

    expect(userDoc?.body).toContain('I prefer terse responses.');
    expect(userDoc?.body).toContain('Why: User repeatedly asks for concise replies.');
    expect(referenceDoc?.body).toContain('grafana.example/d/api-latency');
    expect(projectDoc?.body).toContain('This is temporary for this task.');
    expect(indexContent).toContain('user/');

    const recall = await resolveRelevantAutoMemoryPromptForQuery(
      projectRoot,
      'Check the latency dashboard and use a terse answer.',
    );
    expect(recall.strategy).toBe('heuristic');
    expect(recall.prompt).toContain('## Relevant memory');
    expect(recall.prompt).toContain('user/');
    expect(recall.prompt).toContain('reference/');
  });
});