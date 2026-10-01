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

  type Scope = 'project' | 'user';
  type ForkParams = {
    config: Config;
    extraHistory?: unknown[];
    preserveEmptyExtraHistory?: boolean;
    suppressChatRecording?: boolean;
    systemPrompt: string;
    taskPrompt: string;
    tools: string[];
    completeAfterFirstSuccessfulWrite?: (filePath: string) => boolean;
  };
  const projMem = (...parts: string[]) =>
    path.join(getAutoMemoryRoot(projectRoot), ...parts);
  const userMem = (...parts: string[]) =>
    path.join(getUserAutoMemoryRoot(), ...parts);
  const forkParams = () =>
    vi.mocked(runForkedAgent).mock.calls[0]?.[0] as ForkParams;
  // Resolves the forked agent as a completed run that wrote `files`.
  const agentWrites = (files: string[], finalText?: string) =>
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      ...(finalText !== undefined && { finalText }),
      filesTouched: files,
      filesWritten: files,
    });
  // Resolves the next forked-agent call as a failed/cancelled run; without
  // `files` the result reports no touched paths and omits filesWritten.
  const agentEnds = (
    status: 'failed' | 'cancelled',
    terminateReason: string,
    files?: string[],
  ) =>
    vi.mocked(runForkedAgent).mockResolvedValueOnce({
      status,
      terminateReason,
      filesTouched: files ?? [],
      ...(files && { filesWritten: files }),
    });
  const run = (
    content: string,
    scope?: Scope,
    { clean = false, config = createConfig(projectRoot) } = {},
  ) =>
    runManagedRememberByAgent({
      config,
      projectRoot,
      content,
      contextMode: clean ? 'clean' : 'workspace',
      ...(scope && { scope }),
    });
  const TARGET_CONTENT = {
    project: 'Keep this in the working directory.',
    user: 'Use this preference everywhere.',
  };
  const runTargeted = (scope: Scope) => run(TARGET_CONTENT[scope], scope);
  const rejectsCode = (promise: Promise<unknown>, code: string) =>
    expect(promise).rejects.toMatchObject({ code });
  const expectDecision = (
    toolName: string,
    filePath: string,
    decision: string,
  ) =>
    expect(
      (
        forkParams().config.getPermissionManager() as PermissionManager
      ).evaluate({ toolName, filePath }),
    ).resolves.toBe(decision);
  // `true`: managed rebuilt for projectRoot / user rebuilt once; `false`: not
  // rebuilt; user `undefined`: unchecked.
  const expectRebuilt = (managed: boolean, user?: boolean) => {
    if (managed) {
      expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledWith(projectRoot);
    } else {
      expect(rebuildManagedAutoMemoryIndex).not.toHaveBeenCalled();
    }
    if (user) {
      expect(rebuildUserAutoMemoryIndex).toHaveBeenCalledTimes(1);
    } else if (user === false) {
      expect(rebuildUserAutoMemoryIndex).not.toHaveBeenCalled();
    }
  };

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
    const touched = projMem('project.md');
    agentWrites([touched], 'Saved project memory.');

    const result = await run('Remember the project uses vitest.', undefined, {
      clean: true,
    });

    expect(result).toEqual({
      summary: 'Memory update completed.',
      filesTouched: [touched],
      touchedScopes: ['project'],
    });
    expect(runForkedAgent).toHaveBeenCalledTimes(1);
    const params = forkParams();
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
    const completes = params.completeAfterFirstSuccessfulWrite;
    expect(completes?.(projMem('MEMORY.md'))).toBe(false);
    expect(completes?.(projMem('feedback', 'saved.md'))).toBe(true);
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
    await expectDecision(
      'grep_search',
      getAutoMemoryRoot(projectRoot),
      'allow',
    );
    await expectDecision('list_directory', getUserAutoMemoryRoot(), 'allow');
    await expectDecision('grep_search', path.join(projectRoot, 'src'), 'deny');
    expect(params.systemPrompt).toContain('managed auto-memory system only');
    expect(params.taskPrompt).toContain('Remember the project uses vitest.');
    expect(params.taskPrompt).toContain('<user-content>');
    expectRebuilt(true);
  });

  it('enforces an explicit project target at the permission boundary', async () => {
    const projectFile = projMem('feedback', 'focused-tests.md');
    agentWrites([projectFile], 'Saved project memory.');

    const result = await run(
      'Prefer focused tests in this working directory.',
      'project',
    );

    expect(result.touchedScopes).toEqual(['project']);
    const { taskPrompt } = forkParams();
    expect(taskPrompt).toContain('PROJECT memory at');
    expect(taskPrompt).toContain('explicit project target');
    await expectDecision(ToolNames.WRITE_FILE, projectFile, 'allow');
    const wrong = userMem('feedback', 'wrong.md');
    await expectDecision(ToolNames.WRITE_FILE, wrong, 'deny');
    await expectDecision(ToolNames.READ_FILE, getUserAutoMemoryRoot(), 'deny');
    await rejectsCode(fs.stat(getUserAutoMemoryRoot()), 'ENOENT');
  });

  it('rejects a project-targeted result that reports a user-memory write', async () => {
    agentWrites([userMem('feedback', 'wrong-scope.md')], 'Saved.');
    await rejectsCode(runTargeted('project'), 'remember_scope_mismatch');
    // A mismatch aborts the update but still repairs any hand-written index.
    expectRebuilt(false, true);
  });

  it('enforces an explicit user target at the permission boundary', async () => {
    const userFile = userMem('feedback', 'shared-preference.md');
    agentWrites([userFile], 'Saved user memory.');

    const result = await run(
      'Across all working directories, prefer concise answers.',
      'user',
    );

    expect(result.touchedScopes).toEqual(['user']);
    const { taskPrompt } = forkParams();
    expect(taskPrompt).toContain('USER memory at');
    expect(taskPrompt).toContain('explicit user target');
    await expectDecision(ToolNames.WRITE_FILE, userFile, 'allow');
    const wrong = projMem('feedback', 'wrong.md');
    await expectDecision(ToolNames.WRITE_FILE, wrong, 'deny');
    await rejectsCode(fs.stat(getAutoMemoryRoot(projectRoot)), 'ENOENT');
    expectRebuilt(false, true);
  });

  it('rejects a user-targeted result that reports a project-memory write', async () => {
    agentWrites([projMem('feedback', 'wrong-scope.md')], 'Saved.');
    await rejectsCode(runTargeted('user'), 'remember_scope_mismatch');
    expectRebuilt(true, false);
  });

  it('hides the project tier from the system prompt of an explicit user-targeted remember', async () => {
    agentWrites(
      [userMem('feedback', 'shared-preference.md')],
      'Saved user memory.',
    );

    await run(
      'Across all working directories, prefer concise answers.',
      'user',
    );

    const { systemPrompt } = forkParams();
    // The permission boundary denies project writes on this run; advertising
    // the project directory burns turns on denied writes and can surface as
    // remember_no_update.
    expect(systemPrompt).toContain(
      `You have a persistent, file-based memory system at \`${getUserAutoMemoryRoot()}\``,
    );
    expect(systemPrompt).not.toContain(getAutoMemoryRoot(projectRoot));
    expect(systemPrompt).not.toContain('PROJECT memory');
    expect(systemPrompt).not.toContain('decide which directory it belongs in');
  });

  it('rejects a project-targeted result that mixes project and user writes', async () => {
    agentWrites(
      [
        projMem('feedback', 'in-scope.md'),
        userMem('feedback', 'out-of-scope.md'),
      ],
      'Saved.',
    );
    await rejectsCode(runTargeted('project'), 'remember_scope_mismatch');
    expectRebuilt(true, true);
  });

  it('rejects a user-targeted result that mixes user and project writes', async () => {
    agentWrites(
      [
        userMem('feedback', 'in-scope.md'),
        projMem('feedback', 'out-of-scope.md'),
      ],
      'Saved.',
    );
    await rejectsCode(runTargeted('user'), 'remember_scope_mismatch');
    expectRebuilt(true, true);
  });

  it('fails an explicit user target when its index cannot be rebuilt', async () => {
    agentWrites([userMem('feedback', 'shared-preference.md')], 'Saved.');
    vi.mocked(rebuildUserAutoMemoryIndex).mockRejectedValue(
      new Error('index unavailable'),
    );

    await expect(runTargeted('user')).rejects.toThrow('index unavailable');
  });

  it('fails when an explicit remember request completes without writing memory', async () => {
    agentWrites([], 'Done.');
    await rejectsCode(run('Remember this.', 'project'), 'remember_no_update');
    expectRebuilt(false, false);
  });

  it('does not treat an index-only write as a completed memory update', async () => {
    agentWrites([projMem('MEMORY.md')]);
    await rejectsCode(run('Remember this.', 'project'), 'remember_no_update');
    // The hand-written index must still be rebuilt from the entry files before
    // the throw: MEMORY.md loads verbatim into every future session, so an
    // unrepaired agent write is a persistent instruction channel.
    expectRebuilt(true, false);
  });

  it('fails an unscoped remember that completes without writing memory', async () => {
    agentWrites([], 'Done.');
    // The scoped twin above pins `scope: 'project'`. Automatic scope selection
    // reaches the same guard down a different branch (`params.scope` is
    // undefined, nothing narrows the run), and the code is what /remember and
    // the ACP lanes branch on, in both directions.
    await rejectsCode(run('Remember this.'), 'remember_no_update');
    expectRebuilt(false, false);
  });

  it('keeps the no-update code when the index repair also fails', async () => {
    agentWrites([projMem('MEMORY.md')]);
    vi.mocked(rebuildManagedAutoMemoryIndex).mockRejectedValue(
      new Error('index unavailable'),
    );

    // The repair is best-effort here: the guard already decided the run wrote
    // nothing, and a rebuild rejection surfacing in place of the coded error
    // would leave callers unable to tell the guard fired.
    await rejectsCode(run('Remember this.', 'project'), 'remember_no_update');
    expectRebuilt(true);
  });

  it('keeps the scope-mismatch code when the index repair also fails', async () => {
    agentWrites([projMem('feedback', 'out-of-scope.md')], 'Saved.');
    vi.mocked(rebuildManagedAutoMemoryIndex).mockRejectedValue(
      new Error('index unavailable'),
    );

    // Same contract as the no-update twin above: the boundary crossing is
    // the fact worth surfacing, and the repair may not displace it.
    await rejectsCode(runTargeted('user'), 'remember_scope_mismatch');
    expectRebuilt(true);
  });

  it('fails an explicit project target when its index cannot be rebuilt', async () => {
    agentWrites([projMem('feedback', 'in-scope.md')], 'Saved.');
    vi.mocked(rebuildManagedAutoMemoryIndex).mockRejectedValue(
      new Error('project index unavailable'),
    );

    // The other direction from 'rebuilds touched project indexes and
    // best-effort user indexes': under automatic scope selection the user
    // store is deliberately swallowed, the project store never is. On a
    // successful write the rejection is the only signal; resolving here would
    // report an update whose index is stale.
    await expect(runTargeted('project')).rejects.toThrow(
      'project index unavailable',
    );
  });

  it('repairs a hand-written index even when the run fails or is cancelled', async () => {
    const indexFile = projMem('MEMORY.md');
    agentEnds('failed', 'max turns exceeded', [indexFile]);

    await expect(run('Remember this.', 'project')).rejects.toThrow(
      'max turns exceeded',
    );
    // A failed run that hand-wrote the index must still rebuild it before
    // surfacing the termination reason: MEMORY.md loads verbatim into every
    // future session, so the agent's write may not outlive the run.
    expectRebuilt(true, false);

    vi.mocked(rebuildManagedAutoMemoryIndex).mockClear();
    agentEnds('cancelled', 'aborted', [indexFile]);

    await expect(run('Remember this.', 'project')).rejects.toThrow('aborted');
    expectRebuilt(true);
  });

  it('rebuilds writable stores when the forked agent rejects mid-run', async () => {
    // A rejection after a write (timeout abort mid model stream, any mid-run
    // throw) escapes the per-status rebuild: MEMORY.md loads verbatim into
    // every future session, so every writable store is repaired first.
    vi.mocked(runForkedAgent).mockRejectedValue(new Error('boom'));

    await expect(run('Remember this.')).rejects.toThrow('boom');
    expectRebuilt(true, true);
  });

  it('rebuilds only the writable scope on rejection for scoped remembers', async () => {
    vi.mocked(runForkedAgent).mockRejectedValue(new Error('boom'));

    await expect(run('Remember this.', 'project')).rejects.toThrow('boom');
    expectRebuilt(true, false);

    vi.mocked(rebuildManagedAutoMemoryIndex).mockClear();
    await expect(run('Remember this.', 'user')).rejects.toThrow('boom');
    expectRebuilt(false, true);
  });

  it('rebuilds a store whose only write was a hand-written MEMORY.md', async () => {
    const projectEntry = projMem('feedback', 'real-entry.md');
    agentWrites([projectEntry, userMem('MEMORY.md')], 'Saved.');

    const result = await run('Remember this.');

    expect(result.filesTouched).toEqual([projectEntry]);
    expect(result.touchedScopes).toEqual(['project']);
    expectRebuilt(true, true);
  });

  it('threads the configured memory agent timeout into the forked agent', async () => {
    agentWrites([projMem('feedback', 'saved.md')], '');
    const config = createConfig(projectRoot);
    vi.mocked(config.getMemoryAgentTimeoutMinutes).mockReturnValue(30);

    await run('Remember this.', undefined, { config });

    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ maxTimeMinutes: 30 }),
    );
    // Non-clean mode still suppresses the duplicate auto-memory append while
    // keeping the session's context files (QWEN.md/AGENTS.md) intact.
    const forked = forkParams().config;
    expect(forked.getAutoMemoryPrompt()).toBe('');
    expect(forked.getUserMemory()).toBe('QWEN/AGENTS guidance');
  });

  it.each([
    [
      'keeps the built-in 5-minute default when no timeout is configured',
      undefined,
      { maxTimeMinutes: 5 },
    ],
    [
      'threads the configured memory agent turn limit into the forked agent',
      25,
      { maxTurns: 25 },
    ],
    [
      'passes the zero turn-limit sentinel through to the forked agent',
      0,
      { maxTurns: 0 },
    ],
  ])('%s', async (_title, maxTurns, expected) => {
    agentWrites([projMem('feedback', 'saved.md')], '');
    const config = createConfig(projectRoot);
    vi.mocked(config.getMemoryAgentMaxTurns).mockReturnValue(maxTurns);

    await run('Remember this.', undefined, { config });

    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining(expected),
    );
  });

  it('lets managed-memory writes bypass base ask rules', async () => {
    const touched = userMem('user.md');
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
    agentWrites([touched], 'Saved user memory.');

    await run('Remember the user prefers quiet output.', undefined, {
      clean: true,
      config: createConfig(projectRoot, true, {
        getPermissionManager: () => basePm as PermissionManager,
      }),
    });

    await expectDecision(ToolNames.WRITE_FILE, touched, 'allow');
    const readme = path.join(projectRoot, 'README.md');
    await expectDecision(ToolNames.WRITE_FILE, readme, 'deny');
  });

  it('classifies only successful memory writes', async () => {
    const projectFile = projMem('project.md');
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Saved project memory.',
      filesTouched: [path.join(projectRoot, 'README.md'), projectFile],
      filesWritten: [projectFile],
    } satisfies ForkedAgentResult);

    const result = await run('Remember write-only paths.');

    expect(result).toEqual({
      summary: 'Memory update completed.',
      filesTouched: [projectFile],
      touchedScopes: ['project'],
    });
    const params = forkParams();
    expect(params.extraHistory).toBeUndefined();
    expect(params.preserveEmptyExtraHistory).toBe(false);
    expectRebuilt(true);
  });

  it('disables chat recording for hidden remember agents', async () => {
    agentWrites([projMem('project.md')]);

    await run('Remember without creating a visible session.');

    const params = forkParams();
    expect(params.config.getChatRecordingService()).toBeUndefined();
    expect(params.config.getTranscriptPath()).toBe('');
    expect(params.suppressChatRecording).toBe(true);
  });

  it('records a user mutation before a best-effort user index rebuild', async () => {
    vi.mocked(rebuildUserAutoMemoryIndex).mockRejectedValue(
      new Error('user index unavailable'),
    );
    agentWrites([userMem('user.md'), projMem('project.md')]);

    const result = await run('Remember both scopes.');

    expect(result.touchedScopes).toEqual(['project', 'user']);
    expectRebuilt(true, true);
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
    agentWrites([touched]);

    const result = await run('Remember symlinked memory.');

    expect(result.touchedScopes).toEqual(['project']);
    expectRebuilt(true);
  });

  it('denies writes to pinned records the remember rules could steer onto', async () => {
    // `pinned/` is read-only for the extraction and dream planners (both pass
    // protectPinnedMemory). Remember steers the agent to update a conflicting
    // entry and MEMORY.md indexes pinned records like any other, so without
    // the flag a curated record is writable and
    // completeAfterFirstSuccessfulWrite would report success over it.
    const touched = projMem('note.md');
    agentWrites([touched]);

    await run('Remember me.');

    const pinnedFile = projMem('pinned', 'conventions.md');
    for (const toolName of [ToolNames.WRITE_FILE, ToolNames.EDIT]) {
      await expectDecision(toolName, pinnedFile, 'deny');
    }
    // An ordinary entry beside it stays writable.
    await expectDecision(ToolNames.WRITE_FILE, touched, 'allow');
    expect(forkParams().systemPrompt).toContain('pinned/');
  });

  it('rebuilds the classifiable stores before surfacing a mixed path escape', async () => {
    // A completed run reporting MEMORY.md alongside a non-memory path used to
    // rethrow before any rebuild, leaving the hand-written index on disk to
    // load verbatim into every future session.
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [projMem('MEMORY.md')],
      filesWritten: [projMem('MEMORY.md'), path.join(tempDir, 'outside.md')],
    } satisfies ForkedAgentResult);

    await rejectsCode(run('Remember me.'), 'remember_path_escape');
    expectRebuilt(true);
  });

  it('repairs the classifiable subset when a failed run also escapes', async () => {
    // One unclassifiable path used to void the repair of every classifiable
    // one reported with it: the audit returned [] wholesale.
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'failed',
      terminateReason: 'max turns exceeded',
      filesTouched: [projMem('MEMORY.md')],
      filesWritten: [projMem('MEMORY.md'), path.join(tempDir, 'outside.md')],
    } satisfies ForkedAgentResult);

    await expect(run('Remember me.')).rejects.toThrow('max turns exceeded');
    expectRebuilt(true);
  });

  it('rejects when managed memory is unavailable', async () => {
    await rejectsCode(
      run('Remember me.', undefined, {
        config: createConfig(projectRoot, false),
      }),
      'managed_memory_unavailable',
    );
    expect(runForkedAgent).not.toHaveBeenCalled();
  });

  it('fails if the hidden agent touches a non-memory path', async () => {
    agentWrites([path.join(projectRoot, 'README.md')]);
    await rejectsCode(run('Remember me.'), 'remember_path_escape');
    expectRebuilt(false);
  });

  it('propagates failed termination reasons before auditing written paths', async () => {
    agentEnds('failed', 'max turns exceeded', [
      path.join(projectRoot, 'README.md'),
    ]);
    await expect(run('Remember me.')).rejects.toThrow('max turns exceeded');
    expectRebuilt(false);
  });

  it('propagates failed and cancelled agent termination reasons', async () => {
    agentEnds('failed', 'max turns exceeded');
    await expect(run('Remember me.')).rejects.toThrow('max turns exceeded');

    agentEnds('cancelled', 'aborted');
    await expect(run('Remember me.')).rejects.toThrow('aborted');
  });

  it('remember agent always receives the full protocol even when all indexes are empty', async () => {
    agentWrites([projMem('user.md')], 'Saved.');

    await run('Remember this fact.', undefined, { clean: true });

    const { systemPrompt } = forkParams();
    // Full-protocol markers must be present (forceFullProtocol: true)
    expect(systemPrompt).toContain('category:');
    expect(systemPrompt).toContain('keywords:');
    expect(systemPrompt).toContain('usage_scenarios:');
    expect(systemPrompt).toContain('## Existing keyword vocabulary');
    expect(systemPrompt).toContain('## Types of memory');
    expect(systemPrompt).toContain('## What NOT to save in memory');
    expect(systemPrompt).toContain('## When to access memories');
    expect(systemPrompt).toContain('## Before recommending from memory');
    expect(systemPrompt).toContain('category:');
    expect(systemPrompt).toContain('keywords:');
    expect(systemPrompt).toContain('usage_scenarios:');
    // Condensed-only markers must NOT appear
    expect(systemPrompt).not.toContain('## Memory types');
    expect(systemPrompt).not.toContain('## Do not save');
  });
});
