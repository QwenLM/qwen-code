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
import {
  planAutoMemoryExtractionPatchesByAgent,
  runAutoMemoryExtractionByAgent,
} from './extractionAgentPlanner.js';
import { runAutoMemoryExtract } from './extract.js';
import { getAutoMemoryRoot } from './paths.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';
import { ensureAutoMemoryScaffold } from './store.js';
import { resetAutoMemoryStateForTests } from './state.js';

vi.mock('./extractionAgentPlanner.js', () => ({
  planAutoMemoryExtractionPatchesByAgent: vi.fn(),
  runAutoMemoryExtractionByAgent: vi.fn(),
}));

describe('auto-memory extraction with agent planner', () => {
  let tempDir: string;
  let projectRoot: string;
  const mockConfig = {} as Config;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-memory-extract-agent-'));
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

  it('uses the forked-agent execution path when config is provided', async () => {
    vi.mocked(runAutoMemoryExtractionByAgent).mockImplementation(async () => {
      const memoryRoot = getAutoMemoryRoot(projectRoot);
      const userPath = path.join(memoryRoot, 'user', 'terse-responses.md');
      await fs.mkdir(path.dirname(userPath), { recursive: true });
      await fs.writeFile(
        userPath,
        [
          '---',
          'name: Terse responses',
          'description: User prefers terse responses.',
          'type: user',
          '---',
          '',
          '- User prefers terse responses.',
          '',
        ].join('\n'),
        'utf-8',
      );

      return {
        patches: [
          {
            topic: 'user',
            summary: 'User prefers terse responses.',
            sourceOffset: 0,
          },
        ],
        touchedTopics: ['user'],
        systemMessage: 'Managed auto-memory updated: user.md',
      };
    });

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
    expect(runAutoMemoryExtractionByAgent).toHaveBeenCalledWith(
      mockConfig,
      projectRoot,
      expect.any(Array),
    );
    expect(planAutoMemoryExtractionPatchesByAgent).not.toHaveBeenCalled();

    const docs = await scanAutoMemoryTopicDocuments(projectRoot);
    expect(docs.find((doc) => doc.type === 'user')?.body).toContain(
      'User prefers terse responses.',
    );
  });
});
