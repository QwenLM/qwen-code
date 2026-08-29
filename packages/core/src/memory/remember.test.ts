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
import type { ForkedAgentResult } from '../agents/forkedAgent.js';
import { runForkedAgent } from '../agents/forkedAgent.js';
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

vi.mock('../agents/forkedAgent.js', () => ({
  runForkedAgent: vi.fn(),
}));

vi.mock('./indexer.js', () => ({
  rebuildManagedAutoMemoryIndex: vi.fn(),
  rebuildUserAutoMemoryIndex: vi.fn(),
}));

const recordUserMutation = vi.fn();

function createConfig(
  projectRoot: string,
  managed = true,
  overrides: Partial<Config> = {},
): Config {
  return {
    isManagedMemoryAvailable: vi.fn().mockReturnValue(managed),
    getProjectRoot: vi.fn().mockReturnValue(projectRoot),
    getUserMemory: vi.fn().mockReturnValue('QWEN/AGENTS guidance'),
    getMemoryAgentTimeoutMinutes: vi.fn().mockReturnValue(undefined),
    getMemoryAgentMaxTurns: vi.fn().mockReturnValue(undefined),
    getMemoryManager: vi.fn().mockReturnValue({ recordUserMutation }),
    ...overrides,
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
    recordUserMutation.mockReset();
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
      filesWritten: [touched],
    } satisfies ForkedAgentResult);

    const result = await runManagedRememberByAgent({
      config: createConfig(projectRoot),
      projectRoot,
      content: 'Remember the project uses vitest.',
      contextMode: 'clean',
    });

    expect(result).toEqual({
      summary: 'Memory update completed.',
      filesTouched: [touched],
      touchedScopes: ['project'],
    });
    expect(runForkedAgent).toHaveBeenCalledTimes(1);
    const params = vi.mocked(runForkedAgent).mock.calls[0]?.[0] as {
      config: Config;
      extraHistory?: unknown[];
      preserveEmptyExtraHistory?: boolean;
      systemPrompt: string;
      taskPrompt: string;
      tools: string[];
      completeAfterFirstSuccessfulWrite?: (filePath: string) => boolean;
    };
    expect(params.extraHistory).toEqual([]);
    expect(params.preserveEmptyExtraHistory).toBe(true);
    expect(params.systemPrompt).toContain('This is an explicit add request.');
    expect(params.systemPrompt).toContain('Do not create or edit MEMORY.md.');
    // An exact-duplicate exception would steer the agent into a zero-write
    // completion that the remember_no_update check then fails on every retry.
    expect(params.systemPrompt).not.toContain('exact duplicate');
    expect(params.systemPrompt).toContain(
      'If the content duplicates an existing entry, update that entry',
    );
    // MEMORY.md writes are not memory updates, so they must not trigger
    // early completion; entry writes must.
    expect(
      params.completeAfterFirstSuccessfulWrite?.(
        path.join(getAutoMemoryRoot(projectRoot), 'MEMORY.md'),
      ),
    ).toBe(false);
    expect(
      params.completeAfterFirstSuccessfulWrite?.(
        path.join(getAutoMemoryRoot(projectRoot), 'feedback', 'saved.md'),
      ),
    ).toBe(true);
    expect(params.tools).toEqual([
      'read_file',
      'grep_search',
      'write_file',
      'edit',
    ]);
    expect(params.config.getUserMemory()).toBe('');
    expect(recordUserMutation).not.toHaveBeenCalled();
    // The remember system prompt already embeds the full auto-memory section;
    // the forked-agent config must report an empty auto-memory prompt so
    // AgentCore does not append it a second time (duplication / blank-slate
    // leak). See buildChatSystemPrompt in agent-core.ts.
    expect(params.config.getAutoMemoryPrompt()).toBe('');
    expect(params.config.getDisableAllHooks()).toBe(true);
    expect(params.config.getHookSystem()).toBeUndefined();
    expect(params.config.getMessageBus()).toBeUndefined();
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

  it('enforces an explicit project target at the permission boundary', async () => {
    const projectFile = path.join(
      getAutoMemoryRoot(projectRoot),
      'feedback',
      'focused-tests.md',
    );
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Saved project memory.',
      filesTouched: [projectFile],
      filesWritten: [projectFile],
    } satisfies ForkedAgentResult);

    const result = await runManagedRememberByAgent({
      config: createConfig(projectRoot),
      projectRoot,
      content: 'Prefer focused tests in this working directory.',
      contextMode: 'workspace',
      scope: 'project',
    });

    expect(result.touchedScopes).toEqual(['project']);
    const params = vi.mocked(runForkedAgent).mock.calls[0]?.[0] as {
      config: Config;
      taskPrompt: string;
    };
    expect(params.taskPrompt).toContain('PROJECT memory at');
    expect(params.taskPrompt).toContain('explicit project target');
    const pm = params.config.getPermissionManager() as PermissionManager;
    await expect(
      pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: projectFile,
      }),
    ).resolves.toBe('allow');
    await expect(
      pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: path.join(getUserAutoMemoryRoot(), 'feedback', 'wrong.md'),
      }),
    ).resolves.toBe('deny');
    await expect(
      pm.evaluate({
        toolName: ToolNames.READ_FILE,
        filePath: getUserAutoMemoryRoot(),
      }),
    ).resolves.toBe('deny');
    await expect(fs.stat(getUserAutoMemoryRoot())).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a project-targeted result that reports a user-memory write', async () => {
    const userFile = path.join(
      getUserAutoMemoryRoot(),
      'feedback',
      'wrong-scope.md',
    );
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Saved.',
      filesTouched: [userFile],
      filesWritten: [userFile],
    } satisfies ForkedAgentResult);

    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Keep this in the working directory.',
        contextMode: 'workspace',
        scope: 'project',
      }),
    ).rejects.toMatchObject({ code: 'remember_scope_mismatch' });
    // A mismatch aborts the update but still repairs any hand-written index.
    expect(rebuildUserAutoMemoryIndex).toHaveBeenCalledTimes(1);
    expect(rebuildManagedAutoMemoryIndex).not.toHaveBeenCalled();
  });

  it('enforces an explicit user target at the permission boundary', async () => {
    const userFile = path.join(
      getUserAutoMemoryRoot(),
      'feedback',
      'shared-preference.md',
    );
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Saved user memory.',
      filesTouched: [userFile],
      filesWritten: [userFile],
    } satisfies ForkedAgentResult);

    const result = await runManagedRememberByAgent({
      config: createConfig(projectRoot),
      projectRoot,
      content: 'Across all working directories, prefer concise answers.',
      contextMode: 'workspace',
      scope: 'user',
    });

    expect(result.touchedScopes).toEqual(['user']);
    const params = vi.mocked(runForkedAgent).mock.calls[0]?.[0] as {
      config: Config;
      taskPrompt: string;
    };
    expect(params.taskPrompt).toContain('USER memory at');
    expect(params.taskPrompt).toContain('explicit user target');
    const pm = params.config.getPermissionManager() as PermissionManager;
    await expect(
      pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: userFile,
      }),
    ).resolves.toBe('allow');
    await expect(
      pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: path.join(
          getAutoMemoryRoot(projectRoot),
          'feedback',
          'wrong.md',
        ),
      }),
    ).resolves.toBe('deny');
    await expect(fs.stat(getAutoMemoryRoot(projectRoot))).rejects.toMatchObject(
      {
        code: 'ENOENT',
      },
    );
    expect(rebuildUserAutoMemoryIndex).toHaveBeenCalledTimes(1);
    expect(rebuildManagedAutoMemoryIndex).not.toHaveBeenCalled();
  });

  it('rejects a user-targeted result that reports a project-memory write', async () => {
    const projectFile = path.join(
      getAutoMemoryRoot(projectRoot),
      'feedback',
      'wrong-scope.md',
    );
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Saved.',
      filesTouched: [projectFile],
      filesWritten: [projectFile],
    } satisfies ForkedAgentResult);

    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Use this preference everywhere.',
        contextMode: 'workspace',
        scope: 'user',
      }),
    ).rejects.toMatchObject({ code: 'remember_scope_mismatch' });
    expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledWith(projectRoot);
    expect(rebuildUserAutoMemoryIndex).not.toHaveBeenCalled();
  });

  it('hides the project tier from the system prompt of an explicit user-targeted remember', async () => {
    const userFile = path.join(
      getUserAutoMemoryRoot(),
      'feedback',
      'shared-preference.md',
    );
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Saved user memory.',
      filesTouched: [userFile],
      filesWritten: [userFile],
    } satisfies ForkedAgentResult);

    await runManagedRememberByAgent({
      config: createConfig(projectRoot),
      projectRoot,
      content: 'Across all working directories, prefer concise answers.',
      contextMode: 'workspace',
      scope: 'user',
    });

    const params = vi.mocked(runForkedAgent).mock.calls[0]?.[0] as {
      systemPrompt: string;
    };
    // The permission boundary denies project writes on this run, so the
    // system prompt must not advertise the project directory: advertising it
    // burns turns on denied writes and can surface as remember_no_update.
    expect(params.systemPrompt).toContain(
      `You have a persistent, file-based memory system at \`${getUserAutoMemoryRoot()}\``,
    );
    expect(params.systemPrompt).not.toContain(getAutoMemoryRoot(projectRoot));
    expect(params.systemPrompt).not.toContain('PROJECT memory');
    expect(params.systemPrompt).not.toContain(
      'decide which directory it belongs in',
    );
  });

  it('rejects a project-targeted result that mixes project and user writes', async () => {
    const projectFile = path.join(
      getAutoMemoryRoot(projectRoot),
      'feedback',
      'in-scope.md',
    );
    const userFile = path.join(
      getUserAutoMemoryRoot(),
      'feedback',
      'out-of-scope.md',
    );
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Saved.',
      filesTouched: [projectFile, userFile],
      filesWritten: [projectFile, userFile],
    } satisfies ForkedAgentResult);

    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Keep this in the working directory.',
        contextMode: 'workspace',
        scope: 'project',
      }),
    ).rejects.toMatchObject({ code: 'remember_scope_mismatch' });
    expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledWith(projectRoot);
    expect(rebuildUserAutoMemoryIndex).toHaveBeenCalledTimes(1);
  });

  it('rejects a user-targeted result that mixes user and project writes', async () => {
    const userFile = path.join(
      getUserAutoMemoryRoot(),
      'feedback',
      'in-scope.md',
    );
    const projectFile = path.join(
      getAutoMemoryRoot(projectRoot),
      'feedback',
      'out-of-scope.md',
    );
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Saved.',
      filesTouched: [userFile, projectFile],
      filesWritten: [userFile, projectFile],
    } satisfies ForkedAgentResult);

    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Use this preference everywhere.',
        contextMode: 'workspace',
        scope: 'user',
      }),
    ).rejects.toMatchObject({ code: 'remember_scope_mismatch' });
    expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledWith(projectRoot);
    expect(rebuildUserAutoMemoryIndex).toHaveBeenCalledTimes(1);
  });

  it('fails an explicit user target when its index cannot be rebuilt', async () => {
    const userFile = path.join(
      getUserAutoMemoryRoot(),
      'feedback',
      'shared-preference.md',
    );
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Saved.',
      filesTouched: [userFile],
      filesWritten: [userFile],
    } satisfies ForkedAgentResult);
    vi.mocked(rebuildUserAutoMemoryIndex).mockRejectedValue(
      new Error('index unavailable'),
    );

    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Use this preference everywhere.',
        contextMode: 'workspace',
        scope: 'user',
      }),
    ).rejects.toThrow('index unavailable');
  });

  it('fails when an explicit remember request completes without writing memory', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Done.',
      filesTouched: [],
      filesWritten: [],
    } satisfies ForkedAgentResult);

    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Remember this.',
        contextMode: 'workspace',
        scope: 'project',
      }),
    ).rejects.toMatchObject({ code: 'remember_no_update' });
    expect(rebuildManagedAutoMemoryIndex).not.toHaveBeenCalled();
    expect(rebuildUserAutoMemoryIndex).not.toHaveBeenCalled();
  });

  it('does not treat an index-only write as a completed memory update', async () => {
    const indexFile = path.join(getAutoMemoryRoot(projectRoot), 'MEMORY.md');
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [indexFile],
      filesWritten: [indexFile],
    } satisfies ForkedAgentResult);

    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Remember this.',
        contextMode: 'workspace',
        scope: 'project',
      }),
    ).rejects.toMatchObject({ code: 'remember_no_update' });
    // The hand-written index must still be rebuilt from the entry files
    // before the throw: MEMORY.md loads verbatim into every future session,
    // so leaving the agent's write unrepaired is a persistent instruction
    // channel.
    expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledWith(projectRoot);
    expect(rebuildUserAutoMemoryIndex).not.toHaveBeenCalled();
  });

  it('fails an unscoped remember that completes without writing memory', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Done.',
      filesTouched: [],
      filesWritten: [],
    } satisfies ForkedAgentResult);

    // The scoped twin above pins `scope: 'project'`. Automatic scope
    // selection reaches the same guard down a different branch — `params.scope`
    // is undefined, so nothing narrows the run — and the code is what the
    // /remember command and the ACP lanes branch on, in both directions.
    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Remember this.',
        contextMode: 'workspace',
      }),
    ).rejects.toMatchObject({ code: 'remember_no_update' });
    expect(rebuildManagedAutoMemoryIndex).not.toHaveBeenCalled();
    expect(rebuildUserAutoMemoryIndex).not.toHaveBeenCalled();
  });

  it('keeps the no-update code when the index repair also fails', async () => {
    const indexFile = path.join(getAutoMemoryRoot(projectRoot), 'MEMORY.md');
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [indexFile],
      filesWritten: [indexFile],
    } satisfies ForkedAgentResult);
    vi.mocked(rebuildManagedAutoMemoryIndex).mockRejectedValue(
      new Error('index unavailable'),
    );

    // The repair is best-effort on this path: the guard already decided the
    // run wrote nothing, and letting a rebuild rejection surface in place of
    // the coded error would leave callers unable to tell the guard fired.
    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Remember this.',
        contextMode: 'workspace',
        scope: 'project',
      }),
    ).rejects.toMatchObject({ code: 'remember_no_update' });
    expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledWith(projectRoot);
  });

  it('keeps the scope-mismatch code when the index repair also fails', async () => {
    const projectFile = path.join(
      getAutoMemoryRoot(projectRoot),
      'feedback',
      'out-of-scope.md',
    );
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Saved.',
      filesTouched: [projectFile],
      filesWritten: [projectFile],
    } satisfies ForkedAgentResult);
    vi.mocked(rebuildManagedAutoMemoryIndex).mockRejectedValue(
      new Error('index unavailable'),
    );

    // Same contract as the no-update twin above: the boundary crossing is
    // the fact worth surfacing, and the repair may not displace it.
    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Use this preference everywhere.',
        contextMode: 'workspace',
        scope: 'user',
      }),
    ).rejects.toMatchObject({ code: 'remember_scope_mismatch' });
    expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledWith(projectRoot);
  });

  it('fails an explicit project target when its index cannot be rebuilt', async () => {
    const projectFile = path.join(
      getAutoMemoryRoot(projectRoot),
      'feedback',
      'in-scope.md',
    );
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Saved.',
      filesTouched: [projectFile],
      filesWritten: [projectFile],
    } satisfies ForkedAgentResult);
    vi.mocked(rebuildManagedAutoMemoryIndex).mockRejectedValue(
      new Error('project index unavailable'),
    );

    // The other direction from 'rebuilds touched project indexes and
    // best-effort user indexes': the user store is deliberately swallowed
    // under automatic scope selection, the project store never is. On a
    // successful write the rebuild rejection is the only signal there is —
    // a resolved call here would report a memory update whose index is stale.
    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Keep this in the working directory.',
        contextMode: 'workspace',
        scope: 'project',
      }),
    ).rejects.toThrow('project index unavailable');
  });

  it('repairs a hand-written index even when the run fails or is cancelled', async () => {
    const indexFile = path.join(getAutoMemoryRoot(projectRoot), 'MEMORY.md');
    vi.mocked(runForkedAgent).mockResolvedValueOnce({
      status: 'failed',
      terminateReason: 'max turns exceeded',
      filesTouched: [indexFile],
      filesWritten: [indexFile],
    } satisfies ForkedAgentResult);

    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Remember this.',
        contextMode: 'workspace',
        scope: 'project',
      }),
    ).rejects.toThrow('max turns exceeded');
    // A failed run that hand-wrote the index must still rebuild it before
    // surfacing the termination reason: MEMORY.md loads verbatim into every
    // future session, so the agent's write may not outlive the run.
    expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledWith(projectRoot);
    expect(rebuildUserAutoMemoryIndex).not.toHaveBeenCalled();

    vi.mocked(rebuildManagedAutoMemoryIndex).mockClear();
    vi.mocked(runForkedAgent).mockResolvedValueOnce({
      status: 'cancelled',
      terminateReason: 'aborted',
      filesTouched: [indexFile],
      filesWritten: [indexFile],
    } satisfies ForkedAgentResult);

    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Remember this.',
        contextMode: 'workspace',
        scope: 'project',
      }),
    ).rejects.toThrow('aborted');
    expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledWith(projectRoot);
  });

  it('rebuilds writable stores when the forked agent rejects mid-run', async () => {
    // A rejection after a write (timeout abort mid model stream, any
    // mid-run throw) escapes the per-status rebuild below: MEMORY.md loads
    // verbatim into every future session, so every store the agent could
    // write to must be repaired before the error surfaces.
    vi.mocked(runForkedAgent).mockRejectedValue(new Error('boom'));

    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Remember this.',
        contextMode: 'workspace',
      }),
    ).rejects.toThrow('boom');
    expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledWith(projectRoot);
    expect(rebuildUserAutoMemoryIndex).toHaveBeenCalledTimes(1);
  });

  it('rebuilds only the writable scope on rejection for scoped remembers', async () => {
    vi.mocked(runForkedAgent).mockRejectedValue(new Error('boom'));

    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Remember this.',
        contextMode: 'workspace',
        scope: 'project',
      }),
    ).rejects.toThrow('boom');
    expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledWith(projectRoot);
    expect(rebuildUserAutoMemoryIndex).not.toHaveBeenCalled();

    vi.mocked(rebuildManagedAutoMemoryIndex).mockClear();
    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Remember this.',
        contextMode: 'workspace',
        scope: 'user',
      }),
    ).rejects.toThrow('boom');
    expect(rebuildManagedAutoMemoryIndex).not.toHaveBeenCalled();
    expect(rebuildUserAutoMemoryIndex).toHaveBeenCalledTimes(1);
  });

  it('rebuilds a store whose only write was a hand-written MEMORY.md', async () => {
    const projectEntry = path.join(
      getAutoMemoryRoot(projectRoot),
      'feedback',
      'real-entry.md',
    );
    const userIndex = path.join(getUserAutoMemoryRoot(), 'MEMORY.md');
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Saved.',
      filesTouched: [projectEntry, userIndex],
      filesWritten: [projectEntry, userIndex],
    } satisfies ForkedAgentResult);

    const result = await runManagedRememberByAgent({
      config: createConfig(projectRoot),
      projectRoot,
      content: 'Remember this.',
      contextMode: 'workspace',
    });

    expect(result.filesTouched).toEqual([projectEntry]);
    expect(result.touchedScopes).toEqual(['project']);
    expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledWith(projectRoot);
    expect(rebuildUserAutoMemoryIndex).toHaveBeenCalledTimes(1);
  });

  it('threads the configured memory agent timeout into the forked agent', async () => {
    const memoryFile = path.join(
      getAutoMemoryRoot(projectRoot),
      'feedback',
      'saved.md',
    );
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [memoryFile],
      filesWritten: [memoryFile],
    } satisfies ForkedAgentResult);
    const config = createConfig(projectRoot);
    vi.mocked(config.getMemoryAgentTimeoutMinutes).mockReturnValue(30);

    await runManagedRememberByAgent({
      config,
      projectRoot,
      content: 'Remember this.',
      contextMode: 'workspace',
    });

    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ maxTimeMinutes: 30 }),
    );
    // Non-clean mode still suppresses the duplicate auto-memory append while
    // keeping the session's context files (QWEN.md/AGENTS.md) intact.
    const params = vi.mocked(runForkedAgent).mock.calls[0]?.[0] as {
      config: Config;
    };
    expect(params.config.getAutoMemoryPrompt()).toBe('');
    expect(params.config.getUserMemory()).toBe('QWEN/AGENTS guidance');
  });

  it('keeps the built-in 5-minute default when no timeout is configured', async () => {
    const memoryFile = path.join(
      getAutoMemoryRoot(projectRoot),
      'feedback',
      'saved.md',
    );
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [memoryFile],
      filesWritten: [memoryFile],
    } satisfies ForkedAgentResult);

    await runManagedRememberByAgent({
      config: createConfig(projectRoot),
      projectRoot,
      content: 'Remember this.',
      contextMode: 'workspace',
    });

    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ maxTimeMinutes: 5 }),
    );
  });

  it('threads the configured memory agent turn limit into the forked agent', async () => {
    const memoryFile = path.join(
      getAutoMemoryRoot(projectRoot),
      'feedback',
      'saved.md',
    );
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [memoryFile],
      filesWritten: [memoryFile],
    } satisfies ForkedAgentResult);
    const config = createConfig(projectRoot);
    vi.mocked(config.getMemoryAgentMaxTurns).mockReturnValue(25);

    await runManagedRememberByAgent({
      config,
      projectRoot,
      content: 'Remember this.',
      contextMode: 'workspace',
    });

    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ maxTurns: 25 }),
    );
  });

  it('passes the zero turn-limit sentinel through to the forked agent', async () => {
    const memoryFile = path.join(
      getAutoMemoryRoot(projectRoot),
      'feedback',
      'saved.md',
    );
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [memoryFile],
      filesWritten: [memoryFile],
    } satisfies ForkedAgentResult);
    const config = createConfig(projectRoot);
    vi.mocked(config.getMemoryAgentMaxTurns).mockReturnValue(0);

    await runManagedRememberByAgent({
      config,
      projectRoot,
      content: 'Remember this.',
      contextMode: 'workspace',
    });

    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ maxTurns: 0 }),
    );
  });

  it('lets managed-memory writes bypass base ask rules', async () => {
    const touched = path.join(getUserAutoMemoryRoot(), 'user.md');
    const basePm: Pick<
      PermissionManager,
      | 'evaluate'
      | 'findMatchingDenyRule'
      | 'hasMatchingAskRule'
      | 'hasRelevantRules'
      | 'isToolEnabled'
    > = {
      hasRelevantRules: vi.fn().mockReturnValue(true),
      hasMatchingAskRule: vi.fn().mockReturnValue(true),
      findMatchingDenyRule: vi.fn().mockReturnValue(undefined),
      evaluate: vi.fn().mockResolvedValue('ask'),
      isToolEnabled: vi.fn().mockResolvedValue(true),
    };
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Saved user memory.',
      filesTouched: [touched],
      filesWritten: [touched],
    } satisfies ForkedAgentResult);

    await runManagedRememberByAgent({
      config: createConfig(projectRoot, true, {
        getPermissionManager: () => basePm as PermissionManager,
      }),
      projectRoot,
      content: 'Remember the user prefers quiet output.',
      contextMode: 'clean',
    });

    const params = vi.mocked(runForkedAgent).mock.calls[0]?.[0] as {
      config: Config;
    };
    const pm = params.config.getPermissionManager() as PermissionManager;
    await expect(
      pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: touched,
      }),
    ).resolves.toBe('allow');
    await expect(
      pm.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: path.join(projectRoot, 'README.md'),
      }),
    ).resolves.toBe('deny');
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
      summary: 'Memory update completed.',
      filesTouched: [projectFile],
      touchedScopes: ['project'],
    });
    const params = vi.mocked(runForkedAgent).mock.calls[0]?.[0] as {
      extraHistory?: unknown[];
      preserveEmptyExtraHistory?: boolean;
    };
    expect(params.extraHistory).toBeUndefined();
    expect(params.preserveEmptyExtraHistory).toBe(false);
    expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledWith(projectRoot);
  });

  it('disables chat recording for hidden remember agents', async () => {
    const touched = path.join(getAutoMemoryRoot(projectRoot), 'project.md');
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [touched],
      filesWritten: [touched],
    } satisfies ForkedAgentResult);

    await runManagedRememberByAgent({
      config: createConfig(projectRoot),
      projectRoot,
      content: 'Remember without creating a visible session.',
      contextMode: 'workspace',
    });

    const params = vi.mocked(runForkedAgent).mock.calls[0]?.[0] as {
      config: Config;
      suppressChatRecording?: boolean;
    };
    expect(params.config.getChatRecordingService()).toBeUndefined();
    expect(params.config.getTranscriptPath()).toBe('');
    expect(params.suppressChatRecording).toBe(true);
  });

  it('records a user mutation before a best-effort user index rebuild', async () => {
    const projectFile = path.join(getAutoMemoryRoot(projectRoot), 'project.md');
    const userFile = path.join(getUserAutoMemoryRoot(), 'user.md');
    vi.mocked(rebuildUserAutoMemoryIndex).mockRejectedValue(
      new Error('user index unavailable'),
    );
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [userFile, projectFile],
      filesWritten: [userFile, projectFile],
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
    expect(recordUserMutation).toHaveBeenCalledWith(
      projectRoot,
      expect.any(Object),
    );
    expect(recordUserMutation.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(rebuildUserAutoMemoryIndex).mock.invocationCallOrder[0]!,
    );
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
      filesWritten: [touched],
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

  it('denies writes to pinned records the remember rules could steer onto', async () => {
    // `pinned/` is declared read-only by the extraction and dream planners,
    // which both pass protectPinnedMemory. Remember steers the agent to
    // update a conflicting entry and MEMORY.md indexes pinned records like
    // any other, so without the same flag a curated record is writable and
    // completeAfterFirstSuccessfulWrite would report success over it.
    const touched = path.join(getAutoMemoryRoot(projectRoot), 'note.md');
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [touched],
      filesWritten: [touched],
    } satisfies ForkedAgentResult);

    await runManagedRememberByAgent({
      config: createConfig(projectRoot),
      projectRoot,
      content: 'Remember me.',
      contextMode: 'workspace',
    });

    const params = vi.mocked(runForkedAgent).mock.calls[0]?.[0] as {
      config: Config;
      systemPrompt: string;
    };
    const pm = params.config.getPermissionManager() as PermissionManager;
    const pinnedFile = path.join(
      getAutoMemoryRoot(projectRoot),
      'pinned',
      'conventions.md',
    );
    for (const toolName of [ToolNames.WRITE_FILE, ToolNames.EDIT]) {
      await expect(
        pm.evaluate({ toolName, filePath: pinnedFile }),
      ).resolves.toBe('deny');
    }
    // An ordinary entry beside it stays writable.
    await expect(
      pm.evaluate({ toolName: ToolNames.WRITE_FILE, filePath: touched }),
    ).resolves.toBe('allow');
    expect(params.systemPrompt).toContain('pinned/');
  });

  it('rebuilds the classifiable stores before surfacing a mixed path escape', async () => {
    // A completed run reporting MEMORY.md alongside a non-memory path used
    // to rethrow before any rebuild, leaving the agent's hand-written index
    // on disk to load verbatim into every future session.
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [path.join(getAutoMemoryRoot(projectRoot), 'MEMORY.md')],
      filesWritten: [
        path.join(getAutoMemoryRoot(projectRoot), 'MEMORY.md'),
        path.join(tempDir, 'outside.md'),
      ],
    } satisfies ForkedAgentResult);

    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Remember me.',
        contextMode: 'workspace',
      }),
    ).rejects.toMatchObject({ code: 'remember_path_escape' });
    expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledWith(projectRoot);
  });

  it('repairs the classifiable subset when a failed run also escapes', async () => {
    // One unclassifiable path used to void the repair of every classifiable
    // one reported with it: the audit returned [] wholesale.
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'failed',
      terminateReason: 'max turns exceeded',
      filesTouched: [path.join(getAutoMemoryRoot(projectRoot), 'MEMORY.md')],
      filesWritten: [
        path.join(getAutoMemoryRoot(projectRoot), 'MEMORY.md'),
        path.join(tempDir, 'outside.md'),
      ],
    } satisfies ForkedAgentResult);

    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Remember me.',
        contextMode: 'workspace',
      }),
    ).rejects.toThrow('max turns exceeded');
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
      filesWritten: [path.join(projectRoot, 'README.md')],
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

  it('propagates failed termination reasons before auditing written paths', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'failed',
      terminateReason: 'max turns exceeded',
      filesTouched: [path.join(projectRoot, 'README.md')],
      filesWritten: [path.join(projectRoot, 'README.md')],
    } satisfies ForkedAgentResult);

    await expect(
      runManagedRememberByAgent({
        config: createConfig(projectRoot),
        projectRoot,
        content: 'Remember me.',
        contextMode: 'workspace',
      }),
    ).rejects.toThrow('max turns exceeded');
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

  it('remember agent always receives the full protocol even when all indexes are empty', async () => {
    const touched = path.join(getAutoMemoryRoot(projectRoot), 'user.md');
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Saved.',
      filesTouched: [touched],
      filesWritten: [touched],
    } satisfies ForkedAgentResult);

    await runManagedRememberByAgent({
      config: createConfig(projectRoot),
      projectRoot,
      content: 'Remember this fact.',
      contextMode: 'clean',
    });

    const params = vi.mocked(runForkedAgent).mock.calls[0]?.[0] as {
      systemPrompt: string;
    };
    // Full-protocol markers must be present (forceFullProtocol: true)
    expect(params.systemPrompt).toContain('## Types of memory');
    expect(params.systemPrompt).toContain('## What NOT to save in memory');
    expect(params.systemPrompt).toContain('## When to access memories');
    expect(params.systemPrompt).toContain('## Before recommending from memory');
    expect(params.systemPrompt).toContain('category:');
    expect(params.systemPrompt).toContain('keywords:');
    expect(params.systemPrompt).toContain('usage_scenarios:');
    // Condensed-only markers must NOT appear
    expect(params.systemPrompt).not.toContain('## Memory types');
    expect(params.systemPrompt).not.toContain('## Do not save');
  });
});
