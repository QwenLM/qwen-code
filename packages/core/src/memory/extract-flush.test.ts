/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { MemoryManager } from './manager.js';
import { runAutoMemoryExtractionByAgent } from './extractionAgentPlanner.js';
import { getAutoMemoryExtractCursorPath } from './paths.js';

vi.mock('./extractionAgentPlanner.js', () => ({
  runAutoMemoryExtractionByAgent: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

it('retains unconsumed replay debt even when the persisted cursor is ahead', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-flush-'));
  vi.stubEnv('QWEN_HOME', path.join(tempDir, 'home'));
  vi.stubEnv('QWEN_CODE_MEMORY_EXTRACT_NOOP_SKIP_TURNS', '1');
  const projectRoot = path.join(tempDir, 'project');
  await fs.mkdir(projectRoot);
  const manager = new MemoryManager();
  const config = {
    getSessionId: () => 'session-1',
    getProjectRoot: () => projectRoot,
  } as Config;
  const agent = vi.mocked(runAutoMemoryExtractionByAgent);
  agent.mockResolvedValue({
    touchedTopics: [],
    touchedProjectScope: false,
    touchedUserScope: false,
    hasToolActivity: true,
    extractorEngaged: true,
    systemMessage: undefined,
  });
  const first: Content[] = [
    { role: 'user', parts: [{ text: 'Hello' }] },
    { role: 'model', parts: [{ text: 'Hello' }] },
  ];
  const owed: Content[] = [
    {
      role: 'user',
      parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }],
    },
    { role: 'model', parts: [{ text: 'Image received' }] },
  ];
  const parked = [...first, ...owed];
  const schedule = (history: Content[]) =>
    manager.scheduleExtract({
      projectRoot,
      sessionId: 'session-1',
      history,
      config,
      belowCompactionWarn: true,
    });
  const offset = async () =>
    (
      JSON.parse(
        await fs.readFile(getAutoMemoryExtractCursorPath(projectRoot), 'utf8'),
      ) as { processedOffset: number }
    ).processedOffset;

  try {
    await schedule(first);
    expect((await schedule(parked)).skippedReason).toBe('cadence');
    await schedule([...parked, ...owed]);
    expect(agent).toHaveBeenCalledTimes(1);
    expect(await offset()).toBe(6);

    agent.mockResolvedValueOnce({
      touchedTopics: [],
      touchedProjectScope: false,
      touchedUserScope: false,
      hasToolActivity: false,
      extractorEngaged: false,
      systemMessage: undefined,
    });
    const flushed = await manager.flushPendingExtract('session-1', 5_000);
    expect(await offset()).toBe(6);
    expect(agent).toHaveBeenCalledTimes(2);
    expect(agent.mock.calls[1][2]).toEqual(owed);
    expect(flushed).toBe(false);

    expect(await manager.flushPendingExtract('session-1', 5_000)).toBe(true);
    expect(agent).toHaveBeenCalledTimes(3);
    expect(agent.mock.calls[2][2]).toEqual(owed);
    expect(await offset()).toBe(6);
    expect(await manager.flushPendingExtract('session-1', 5_000)).toBe(true);
    expect(agent).toHaveBeenCalledTimes(3);
  } finally {
    await manager.drain();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
