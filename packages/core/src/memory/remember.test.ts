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
import type { ForkedAgentResult } from '../utils/forkedAgent.js';
import { runForkedAgent } from '../utils/forkedAgent.js';
import {
  buildBareRememberPrompt,
  buildManagedRememberPrompt,
  runManagedRememberByAgent,
} from './remember.js';
import {
  clearAutoMemoryRootCache,
  getAutoMemoryRoot,
  getUserAutoMemoryRoot,
} from './paths.js';
import {
  rebuildManagedAutoMemoryIndex,
  rebuildUserAutoMemoryIndex,
} from './indexer.js';

vi.mock('../utils/forkedAgent.js', () => ({
  runForkedAgent: vi.fn(),
}));

vi.mock('./indexer.js', () => ({
  rebuildManagedAutoMemoryIndex: vi.fn(),
  rebuildUserAutoMemoryIndex: vi.fn(),
}));

function createConfig(projectRoot: string, managed = true): Config {
  return {
    isManagedMemoryAvailable: vi.fn().mockReturnValue(managed),
    getProjectRoot: vi.fn().mockReturnValue(projectRoot),
    getUserMemory: vi.fn().mockReturnValue('QWEN/AGENTS guidance'),
  } as unknown as Config;
}

describe('remember memory helper', () => {
  const originalMemoryBase = process.env['QWEN_CODE_MEMORY_BASE_DIR'];
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remember-helper-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = path.join(tempDir, 'memory');
    clearAutoMemoryRootCache();
    vi.mocked(runForkedAgent).mockReset();
    vi.mocked(rebuildManagedAutoMemoryIndex).mockReset();
    vi.mocked(rebuildUserAutoMemoryIndex).mockReset();
    vi.mocked(rebuildManagedAutoMemoryIndex).mockResolvedValue('');
    vi.mocked(rebuildUserAutoMemoryIndex).mockResolvedValue('');
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

  it('builds the same managed and bare prompts used by /remember', () => {
    const managed = buildManagedRememberPrompt(
      '  prefers focused tests  ',
      projectRoot,
    );

    expect(managed).toContain(
      'Please save the following to your memory system.',
    );
    expect(managed).toContain('USER memory at');
    expect(managed).toContain('PROJECT memory at');
    expect(managed).toContain(getAutoMemoryRoot(projectRoot));
    expect(managed).toContain('prefers focused tests');
    expect(managed).not.toContain('<user-content>');
    expect(managed).not.toContain('</user-content>');
    expect(managed).not.toContain('  prefers focused tests  ');

    const wrapped = buildManagedRememberPrompt(
      '  hidden context  ',
      projectRoot,
      { wrapUserContent: true },
    );
    expect(wrapped).toContain(
      '<user-content>\nhidden context\n</user-content>',
    );

    const bare = buildBareRememberPrompt('  appends to qwen  ');
    expect(bare).toBe(
      'Please save the following fact to memory (e.g. append to QWEN.md in the project root):\n\nappends to qwen',
    );
  });

  it('runs clean context with managed-memory tools only', async () => {
    const touched = path.join(getAutoMemoryRoot(projectRoot), 'project.md');
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Saved project memory.',
      filesTouched: [touched],
    } satisfies ForkedAgentResult);

    const result = await runManagedRememberByAgent({
      config: createConfig(projectRoot),
      projectRoot,
      content: 'Remember the project uses vitest.',
      contextMode: 'clean',
    });

    expect(result).toEqual({
      summary: 'Saved project memory.',
      filesTouched: [touched],
      touchedScopes: ['project'],
    });
    expect(runForkedAgent).toHaveBeenCalledTimes(1);
    const params = vi.mocked(runForkedAgent).mock.calls[0]?.[0] as {
      config: Config;
      extraHistory?: unknown[];
      systemPrompt: string;
      taskPrompt: string;
      tools: string[];
    };
    expect(params.extraHistory).toEqual([]);
    expect(params.tools).toEqual([
      'read_file',
      'grep_search',
      'list_directory',
      'write_file',
      'edit',
    ]);
    expect(params.config.getUserMemory()).toBe('');
    const pm = params.config.getPermissionManager() as PermissionManager;
    await expect(
      pm.evaluate({
        toolName: 'grep_search',
        filePath: getAutoMemoryRoot(projectRoot),
      }),
    ).resolves.toBe('allow');
    await expect(
      pm.evaluate({
        toolName: 'list_directory',
        filePath: getUserAutoMemoryRoot(),
      }),
    ).resolves.toBe('allow');
    await expect(
      pm.evaluate({
        toolName: 'grep_search',
        filePath: path.join(projectRoot, 'src'),
      }),
    ).resolves.toBe('deny');
    expect(params.systemPrompt).toContain('managed auto-memory system only');
    expect(params.taskPrompt).toContain('Remember the project uses vitest.');
    expect(params.taskPrompt).toContain('<user-content>');
    expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledWith(projectRoot);
  });

  it('classifies only successful memory writes', async () => {
    const projectFile = path.join(getAutoMemoryRoot(projectRoot), 'project.md');
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Saved project memory.',
      filesTouched: [path.join(projectRoot, 'README.md'), projectFile],
      filesWritten: [projectFile],
    } satisfies ForkedAgentResult);

    const result = await runManagedRememberByAgent({
      config: createConfig(projectRoot),
      projectRoot,
      content: 'Remember write-only paths.',
      contextMode: 'workspace',
    });

    expect(result).toEqual({
      summary: 'Saved project memory.',
      filesTouched: [projectFile],
      touchedScopes: ['project'],
    });
    expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledWith(projectRoot);
  });

  it('disables chat recording for hidden remember agents', async () => {
    const touched = path.join(getAutoMemoryRoot(projectRoot), 'project.md');
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [touched],
    } satisfies ForkedAgentResult);

    await runManagedRememberByAgent({
      config: createConfig(projectRoot),
      projectRoot,
      content: 'Remember without creating a visible session.',
      contextMode: 'workspace',
    });

    const params = vi.mocked(runForkedAgent).mock.calls[0]?.[0] as {
      config: Config;
    };
    expect(params.config.getChatRecordingService()).toBeUndefined();
    expect(params.config.getTranscriptPath()).toBe('');
  });

  it('rebuilds touched project indexes and best-effort user indexes', async () => {
    const projectFile = path.join(getAutoMemoryRoot(projectRoot), 'project.md');
    const userFile = path.join(getUserAutoMemoryRoot(), 'user.md');
    vi.mocked(rebuildUserAutoMemoryIndex).mockRejectedValue(
      new Error('user index unavailable'),
    );
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [userFile, projectFile],
    } satisfies ForkedAgentResult);

    const result = await runManagedRememberByAgent({
      config: createConfig(projectRoot),
      projectRoot,
      content: 'Remember both scopes.',
      contextMode: 'workspace',
    });

    expect(result.touchedScopes).toEqual(['project', 'user']);
    expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledWith(projectRoot);
    expect(rebuildUserAutoMemoryIndex).toHaveBeenCalledTimes(1);
  });

  it('classifies symlinked project memory paths by realpath', async () => {
    const projectMemoryRoot = getAutoMemoryRoot(projectRoot);
    await fs.mkdir(projectMemoryRoot, { recursive: true });
    const linkedMemoryRoot = path.join(tempDir, 'linked-project-memory');
    await fs.symlink(projectMemoryRoot, linkedMemoryRoot, 'dir');
    const touched = path.join(linkedMemoryRoot, 'project.md');
    await fs.writeFile(touched, 'memory');
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [touched],
    } satisfies ForkedAgentResult);

    const result = await runManagedRememberByAgent({
      config: createConfig(projectRoot),
      projectRoot,
      content: 'Remember symlinked memory.',
      contextMode: 'workspace',
    });

    expect(result.touchedScopes).toEqual(['project']);
    expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledWith(projectRoot);
  });

  it('rejects when managed memory is unavailable', async () => {
    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot, false),
        projectRoot,
        content: 'Remember me.',
        contextMode: 'workspace',
      }),
    ).rejects.toMatchObject({ code: 'managed_memory_unavailable' });
    expect(runForkedAgent).not.toHaveBeenCalled();
  });

  it('fails if the hidden agent touches a non-memory path', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [path.join(projectRoot, 'README.md')],
    } satisfies ForkedAgentResult);

    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Remember me.',
        contextMode: 'workspace',
      }),
    ).rejects.toMatchObject({ code: 'remember_path_escape' });
    expect(rebuildManagedAutoMemoryIndex).not.toHaveBeenCalled();
  });

  it('propagates failed and cancelled agent termination reasons', async () => {
    vi.mocked(runForkedAgent).mockResolvedValueOnce({
      status: 'failed',
      terminateReason: 'max turns exceeded',
      filesTouched: [],
    } satisfies ForkedAgentResult);

    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Remember me.',
        contextMode: 'workspace',
      }),
    ).rejects.toThrow('max turns exceeded');

    vi.mocked(runForkedAgent).mockResolvedValueOnce({
      status: 'cancelled',
      terminateReason: 'aborted',
      filesTouched: [],
    } satisfies ForkedAgentResult);

    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Remember me.',
        contextMode: 'workspace',
      }),
    ).rejects.toThrow('aborted');
  });
});
