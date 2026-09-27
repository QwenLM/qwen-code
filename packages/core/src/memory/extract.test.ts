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
import { getAutoMemoryExtractCursorPath } from './paths.js';
import { runAutoMemoryExtract } from './extract.js';
import { runAutoMemoryExtractionByAgent } from './extractionAgentPlanner.js';
import { ensureAutoMemoryScaffold } from './store.js';
import { getCacheSafeParamsSessionId } from '../agents/forkedAgent.js';

vi.mock('./extractionAgentPlanner.js', () => ({
  runAutoMemoryExtractionByAgent: vi.fn(),
}));
vi.mock('../agents/forkedAgent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agents/forkedAgent.js')>()),
  getCacheSafeParamsSessionId: vi.fn(),
}));
vi.mock('./store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store.js')>()),
  ensureUserAutoMemoryScaffold: vi.fn().mockResolvedValue(undefined),
}));

describe('auto-memory extraction session isolation', () => {
  let temp: string;
  const config = {
    getSessionId: () => 'session-1',
    getModel: () => 'qwen3-coder-plus',
  } as unknown as Config;

  beforeEach(async () => {
    vi.clearAllMocks();
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-session-'));
  });
  afterEach(async () => {
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 });
  });

  it.each(['before scaffold', 'after scaffold'] as const)(
    'rejects session drift %s without agent or cursor writes',
    async (stage) => {
      const projectRoot = path.join(temp, 'project');
      let cursorBefore: string | undefined;
      if (stage === 'after scaffold') {
        await fs.mkdir(projectRoot);
        await ensureAutoMemoryScaffold(projectRoot);
        cursorBefore = await fs.readFile(
          getAutoMemoryExtractCursorPath(projectRoot),
          'utf8',
        );
        vi.mocked(getCacheSafeParamsSessionId)
          .mockReturnValueOnce('session-1')
          .mockReturnValueOnce('session-2');
      } else {
        vi.mocked(getCacheSafeParamsSessionId).mockReturnValue('session-2');
      }
      const result = await runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config,
        history: [{ role: 'user', parts: [{ text: 'Remember this.' }] }],
      });
      expect(result.skippedReason).toBe('session_mismatch');
      expect(result.cursor.processedOffset).toBeUndefined();
      expect(runAutoMemoryExtractionByAgent).not.toHaveBeenCalled();
      if (cursorBefore !== undefined) {
        expect(
          await fs.readFile(
            getAutoMemoryExtractCursorPath(projectRoot),
            'utf8',
          ),
        ).toBe(cursorBefore);
      } else {
        await expect(fs.stat(projectRoot)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
    },
  );
});
