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
import { Storage } from '../config/storage.js';
import type { ForkedAgentResult } from '../utils/forkedAgent.js';
import { runForkedAgent } from '../utils/forkedAgent.js';
import { escapeShellArg, getShellConfiguration } from '../utils/shell-utils.js';
import {
  buildConsolidationTaskPrompt,
  getTranscriptDir,
  planManagedAutoMemoryDreamByAgent,
} from './dreamAgentPlanner.js';
import { ensureAutoMemoryScaffold } from './store.js';

vi.mock('../utils/forkedAgent.js', () => ({
  runForkedAgent: vi.fn(),
}));

describe('dreamAgentPlanner', () => {
  let tempDir: string;
  let projectRoot: string;
  let config: Config;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'auto-memory-dream-agent-'),
    );
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(projectRoot);
    config = {
      getSessionId: vi.fn().mockReturnValue('session-1'),
      getModel: vi.fn().mockReturnValue('qwen-test'),
      getApprovalMode: vi.fn(),
    } as unknown as Config;
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  it('returns project-scoped session transcript directory', () => {
    const runtimeDir = path.join(tempDir, 'runtime');
    Storage.setRuntimeBaseDir(runtimeDir);

    expect(getTranscriptDir(projectRoot)).toBe(
      path.join(new Storage(projectRoot).getProjectDir(), 'chats'),
    );
    expect(getTranscriptDir(projectRoot)).toContain(
      path.join(runtimeDir, 'projects'),
    );
    expect(getTranscriptDir(projectRoot)).not.toContain(
      `${path.sep}.qwen${path.sep}tmp${path.sep}`,
    );
  });

  it('shell-quotes the transcript directory in the grep example', () => {
    const transcriptDir = path.join(
      tempDir,
      'runtime dir; touch BAD',
      'projects',
      '-tmp-project',
      'chats',
    );
    const quotedTranscriptDir = escapeShellArg(
      `${transcriptDir}${path.sep}`,
      getShellConfiguration().shell,
    );
    const prompt = buildConsolidationTaskPrompt(
      path.join(tempDir, 'memory'),
      transcriptDir,
    );

    expect(prompt).toContain(
      `grep -rn "<narrow term>" ${quotedTranscriptDir} --include="*.jsonl" | tail -50`,
    );
    expect(prompt).not.toContain(
      `grep -rn "<narrow term>" ${transcriptDir}${path.sep} --include="*.jsonl" | tail -50`,
    );
  });

  it('returns the forked agent result', async () => {
    const mockResult: ForkedAgentResult = {
      status: 'completed',
      finalText: 'Merged 2 duplicate Vim entries into prefers-vim.md.',
      filesTouched: [
        path.join(projectRoot, '.qwen', 'memory', 'user', 'prefers-vim.md'),
      ],
    };

    vi.mocked(runForkedAgent).mockResolvedValue(mockResult);

    const result = await planManagedAutoMemoryDreamByAgent(config, projectRoot);

    expect(result).toBe(mockResult);
    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTurns: 8,
        maxTimeMinutes: 5,
        tools: [
          'read_file',
          'grep_search',
          'glob',
          'list_directory',
          'run_shell_command',
          'write_file',
          'edit',
        ],
      }),
    );
  });

  it('throws when the agent fails', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'failed',
      terminateReason: 'Model timed out',
      filesTouched: [],
    } satisfies ForkedAgentResult);

    await expect(
      planManagedAutoMemoryDreamByAgent(config, projectRoot),
    ).rejects.toThrow('Model timed out');
  });

  it('returns cancelled result without throwing', async () => {
    const mockResult: ForkedAgentResult = {
      status: 'cancelled',
      filesTouched: [],
    };

    vi.mocked(runForkedAgent).mockResolvedValue(mockResult);

    const result = await planManagedAutoMemoryDreamByAgent(config, projectRoot);
    expect(result.status).toBe('cancelled');
    expect(result.filesTouched).toHaveLength(0);
  });
});
