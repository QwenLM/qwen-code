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
import type { PermissionManager } from '../permissions/permission-manager.js';
import { ToolNames } from '../tools/tool-names.js';
import { runForkedAgent } from '../agents/forkedAgent.js';
import {
  clearAutoMemoryRootCache,
  getAutoMemoryRoot,
  getUserAutoMemoryRoot,
} from './paths.js';
import {
  buildUserConsolidationTaskPrompt,
  planUserAutoMemoryDreamByAgent,
} from './user-dream-agent-planner.js';
import { AUTO_MEMORY_TREE_CATEGORIES } from './types.js';

vi.mock('../agents/forkedAgent.js', () => ({ runForkedAgent: vi.fn() }));

describe('User Dream agent planner', () => {
  const originalMemoryBase = process.env['QWEN_CODE_MEMORY_BASE_DIR'];
  let tempDir: string;
  let projectRoot: string;
  let config: Config;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'user-dream-agent-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = path.join(tempDir, 'memory');
    clearAutoMemoryRootCache();
    await fs.mkdir(getUserAutoMemoryRoot(), { recursive: true });
    config = {
      getModel: vi.fn().mockReturnValue('qwen-test'),
      getApprovalMode: vi.fn(),
      getMemoryAgentTimeoutMinutes: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;
    vi.mocked(runForkedAgent).mockReset();
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [],
    });
  });

  afterEach(async () => {
    if (originalMemoryBase === undefined) {
      delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
    } else {
      process.env['QWEN_CODE_MEMORY_BASE_DIR'] = originalMemoryBase;
    }
    clearAutoMemoryRootCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('does not include project transcripts in its task', () => {
    const prompt = buildUserConsolidationTaskPrompt(getUserAutoMemoryRoot());
    expect(prompt).toContain('Do not read any project memory');
    expect(prompt).toContain('description`, `category`, `usage_scenarios`');
    expect(prompt).toContain('2-6 discriminative retrieval terms');
    expect(prompt).toContain('discriminative retrieval terms or short phrases');
    expect(prompt).toContain('domain-qualified phrases');
    for (const category of AUTO_MEMORY_TREE_CATEGORIES) {
      expect(prompt).toContain(category);
    }
    expect(prompt).not.toContain('Session transcripts:');
  });

  it('allows only User Memory reads and writes', async () => {
    await planUserAutoMemoryDreamByAgent(config, projectRoot);
    const call = vi.mocked(runForkedAgent).mock.calls[0]?.[0] as {
      config: Config;
      tools: string[];
    };
    const permissions =
      call.config.getPermissionManager?.() as PermissionManager;
    const userFile = path.join(getUserAutoMemoryRoot(), 'user', 'role.md');
    const pinnedFile = path.join(
      getUserAutoMemoryRoot(),
      'pinned',
      'preferences.md',
    );
    const projectFile = path.join(
      getAutoMemoryRoot(projectRoot),
      'project',
      'roadmap.md',
    );

    expect(call.tools).not.toContain(ToolNames.SHELL);
    expect(call.tools).not.toContain(ToolNames.GLOB);
    await expect(
      permissions.evaluate({
        toolName: ToolNames.READ_FILE,
        filePath: userFile,
      }),
    ).resolves.toBe('allow');
    await expect(
      permissions.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: userFile,
      }),
    ).resolves.toBe('allow');
    await expect(
      permissions.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: pinnedFile,
      }),
    ).resolves.toBe('deny');
    await expect(
      permissions.evaluate({
        toolName: ToolNames.EDIT,
        filePath: pinnedFile,
      }),
    ).resolves.toBe('deny');
    await expect(
      permissions.evaluate({
        toolName: ToolNames.READ_FILE,
        filePath: projectFile,
      }),
    ).resolves.toBe('deny');
    await expect(
      permissions.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: projectFile,
      }),
    ).resolves.toBe('deny');
  });
});
