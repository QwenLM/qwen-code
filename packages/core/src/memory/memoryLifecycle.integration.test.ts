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
import {
  forgetManagedAutoMemoryMatches,
  selectManagedAutoMemoryForgetCandidates,
} from './forget.js';
import { reviewManagedAutoMemoryGovernance } from './governance.js';
import { rebuildManagedAutoMemoryIndex } from './indexer.js';
import { getAutoMemoryIndexPath, getAutoMemoryTopicPath } from './paths.js';
import { resolveRelevantAutoMemoryPromptForQuery } from './recall.js';
import { getManagedAutoMemoryStatus } from './status.js';
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

  it('supports a Claude-style durable memory lifecycle across extraction, recall, dream, governance, and forget', async () => {
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

    const userPath = getAutoMemoryTopicPath(projectRoot, 'user');
    const duplicatedUserContent = `${(
      await fs.readFile(userPath, 'utf-8')
    ).trimEnd()}\n- I prefer terse responses.\n  - Why: User repeatedly asks for concise replies.\n`;
    await fs.writeFile(userPath, duplicatedUserContent, 'utf-8');
    await rebuildManagedAutoMemoryIndex(projectRoot);

    const dreamResult = await runManagedAutoMemoryDream(
      projectRoot,
      new Date('2026-04-01T03:00:00.000Z'),
    );
    expect(dreamResult.touchedTopics).toContain('user');
    expect(dreamResult.dedupedEntries).toBeGreaterThan(0);

    const userContent = await fs.readFile(userPath, 'utf-8');
    const projectContent = await fs.readFile(
      getAutoMemoryTopicPath(projectRoot, 'project'),
      'utf-8',
    );
    const referenceContent = await fs.readFile(
      getAutoMemoryTopicPath(projectRoot, 'reference'),
      'utf-8',
    );
    const indexContent = await fs.readFile(
      getAutoMemoryIndexPath(projectRoot),
      'utf-8',
    );

    expect(userContent.match(/I prefer terse responses\./g)).toHaveLength(1);
    expect(userContent).toContain('  - Why: User repeatedly asks for concise replies.');
    expect(referenceContent).toContain('grafana.example/d/api-latency');
    expect(projectContent).toContain('This is temporary for this task.');
    expect(indexContent).toContain('I prefer terse responses.');

    const recall = await resolveRelevantAutoMemoryPromptForQuery(
      projectRoot,
      'Check the latency dashboard and use a terse answer.',
    );
    expect(recall.strategy).toBe('heuristic');
    expect(recall.prompt).toContain('## Relevant Managed Auto-Memory');
    expect(recall.prompt).toContain('user.md');
    expect(recall.prompt).toContain('reference.md');

    const review = await reviewManagedAutoMemoryGovernance(projectRoot);
    const suggestionTypes = new Set(review.suggestions.map((item) => item.type));
    expect(review.strategy).toBe('heuristic');
    expect(suggestionTypes).toContain('duplicate');
    expect(suggestionTypes).toContain('migrate');
    expect(suggestionTypes).toContain('forget');
    expect(suggestionTypes).toContain('promote');

    const forgetSelection = await selectManagedAutoMemoryForgetCandidates(
      projectRoot,
      'temporary for this task',
    );
    expect(forgetSelection.strategy).toBe('heuristic');
    expect(forgetSelection.matches).toEqual([
      {
        topic: 'project',
        summary: 'This is temporary for this task.',
      },
    ]);

    const forgetResult = await forgetManagedAutoMemoryMatches(
      projectRoot,
      forgetSelection.matches,
      new Date('2026-04-01T04:00:00.000Z'),
    );
    const projectContentAfterForget = await fs.readFile(
      getAutoMemoryTopicPath(projectRoot, 'project'),
      'utf-8',
    );
    const indexAfterForget = await fs.readFile(
      getAutoMemoryIndexPath(projectRoot),
      'utf-8',
    );
    const status = await getManagedAutoMemoryStatus(projectRoot);

    expect(forgetResult.removedEntries).toEqual(forgetSelection.matches);
    expect(projectContentAfterForget).not.toContain('temporary for this task');
    expect(indexAfterForget).not.toContain('temporary for this task');
    expect(status.extractionTasks.length).toBeGreaterThan(0);
    expect(status.topics.find((topic) => topic.topic === 'user')).toEqual(
      expect.objectContaining({ entryCount: 1 }),
    );
  });
});