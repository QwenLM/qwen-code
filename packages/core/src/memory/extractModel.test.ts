/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { planAutoMemoryExtractionPatchesByAgent } from './extractionAgentPlanner.js';
import { planAutoMemoryExtractionPatchesByModel } from './extractionPlanner.js';
import { runAutoMemoryExtract } from './extract.js';
import { getAutoMemoryTopicPath } from './paths.js';
import { ensureAutoMemoryScaffold } from './store.js';
import { resetAutoMemoryStateForTests } from './state.js';

vi.mock('./extractionAgentPlanner.js', () => ({
  planAutoMemoryExtractionPatchesByAgent: vi.fn(),
}));

vi.mock('./extractionPlanner.js', () => ({
  planAutoMemoryExtractionPatchesByModel: vi.fn(),
}));

describe('auto-memory extraction with model planner', () => {
  let tempDir: string;
  let projectRoot: string;
  const mockConfig = {} as Config;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-memory-extract-model-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(projectRoot);
    vi.clearAllMocks();
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

  it('applies model-planned extraction patches when config is provided', async () => {
    vi.mocked(planAutoMemoryExtractionPatchesByAgent).mockRejectedValue(
      new Error('agent planner failed'),
    );
    vi.mocked(planAutoMemoryExtractionPatchesByModel).mockResolvedValue([
      {
        topic: 'reference',
        summary: 'Latency dashboard: https://grafana.internal/d/api-latency',
        sourceOffset: 0,
      },
    ]);

    const result = await runAutoMemoryExtract({
      projectRoot,
      sessionId: 'session-1',
      config: mockConfig,
      history: [
        {
          role: 'user',
          parts: [{ text: 'The latency dashboard is https://grafana.internal/d/api-latency' }],
        },
      ],
    });

    expect(result.touchedTopics).toEqual(['reference']);
    expect(planAutoMemoryExtractionPatchesByModel).toHaveBeenCalledWith(
      mockConfig,
      projectRoot,
      expect.any(Array),
    );

    const referenceTopic = await fs.readFile(
      getAutoMemoryTopicPath(projectRoot, 'reference'),
      'utf-8',
    );
    expect(referenceTopic).toContain('Latency dashboard: https://grafana.internal/d/api-latency');
  });

  it('falls back to heuristic extraction when the model planner fails', async () => {
    vi.mocked(planAutoMemoryExtractionPatchesByAgent).mockRejectedValue(
      new Error('agent planner failed'),
    );
    vi.mocked(planAutoMemoryExtractionPatchesByModel).mockRejectedValue(
      new Error('planner failed'),
    );

    const result = await runAutoMemoryExtract({
      projectRoot,
      sessionId: 'session-1',
      config: mockConfig,
      history: [
        {
          role: 'user',
          parts: [{ text: 'I prefer terse responses.' }],
        },
      ],
    });

    expect(result.touchedTopics).toEqual(['user']);
    const userTopic = await fs.readFile(
      getAutoMemoryTopicPath(projectRoot, 'user'),
      'utf-8',
    );
    expect(userTopic).toContain('- I prefer terse responses.');
  });
});
