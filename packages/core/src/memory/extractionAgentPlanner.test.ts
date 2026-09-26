/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { runAutoMemoryExtractionByAgent } from './extractionAgentPlanner.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';
import {
  AUTO_MEMORY_PINNED_DIRNAME,
  getAutoMemoryRoot,
  getUserAutoMemoryRoot,
} from './paths.js';
import { runForkedAgent, getCacheSafeParams } from '../agents/forkedAgent.js';
import { ToolNames } from '../tools/tool-names.js';

vi.mock('./scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scan.js')>();
  return {
    ...actual,
    scanAutoMemoryTopicDocuments: vi.fn(),
    // Explicit mock so the production scan does not silently fall through
    // to the real filesystem (it would only "work" because /tmp/user-memory
    // doesn't exist and listMarkdownFiles swallows ENOENT). Each test that
    // cares about user docs sets a mockReturnValue.
    scanUserAutoMemoryTopicDocuments: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('./paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./paths.js')>();
  return {
    ...actual,
    getAutoMemoryRoot: vi.fn().mockReturnValue('/tmp/auto-memory'),
    getUserAutoMemoryRoot: vi.fn().mockReturnValue('/tmp/user-memory'),
  };
});

vi.mock('../agents/forkedAgent.js', () => ({
  runForkedAgent: vi.fn(),
  getCacheSafeParams: vi.fn(),
}));

describe('runAutoMemoryExtractionByAgent', () => {
  const mockConfig = {
    getSessionId: vi.fn().mockReturnValue('session-1'),
    getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
    getApprovalMode: vi.fn(),
    getMemoryAgentTimeoutMinutes: vi.fn().mockReturnValue(undefined),
    getMemoryAgentMaxTurns: vi.fn().mockReturnValue(undefined),
  } as unknown as Config;

  // Runs extraction after a completed forked run that touched `files`; the run
  // also reports them as `filesWritten` unless `written` is false.
  function extract(files: string[], { written = true } = {}) {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: files,
      ...(written ? { filesWritten: files } : {}),
    });
    return runAutoMemoryExtractionByAgent(mockConfig, '/tmp');
  }

  const forkedCall = () => vi.mocked(runForkedAgent).mock.calls[0]?.[0];

  function expectScopes(
    result: Awaited<ReturnType<typeof runAutoMemoryExtractionByAgent>>,
    topics: string[],
    scopes: { project: boolean; user: boolean },
  ) {
    expect(result.touchedTopics).toEqual(expect.arrayContaining(topics));
    expect(result.touchedProjectScope).toBe(scopes.project);
    expect(result.touchedUserScope).toBe(scopes.user);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCacheSafeParams).mockReturnValue({
      generationConfig: {},
      history: [
        { role: 'user', parts: [{ text: 'I prefer terse responses.' }] },
        { role: 'model', parts: [{ text: 'Understood.' }] },
      ],
      model: 'qwen3-coder-plus',
      version: 1,
    });
    vi.mocked(scanAutoMemoryTopicDocuments).mockResolvedValue([
      {
        type: 'user',
        filePath: '/tmp/auto-memory/user/prefs.md',
        relativePath: 'user/prefs.md',
        filename: 'prefs.md',
        title: 'User Memory',
        description: 'User preferences',
        body: '- Existing terse preference.',
        mtimeMs: 1,
      },
    ]);
  });

  it('derives touchedTopics from filesTouched and returns systemMessage', async () => {
    const result = await extract(['/tmp/auto-memory/user/prefs.md']);

    expect(result).toEqual({
      touchedTopics: ['user'],
      touchedProjectScope: true,
      touchedUserScope: false,
      hasToolActivity: true,
      systemMessage: 'Managed auto-memory updated: user.md',
    });
    expect(getCacheSafeParams).toHaveBeenCalledWith('session-1');
    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [
          'read_file',
          'grep_search',
          'glob',
          'run_shell_command',
          'write_file',
          'edit',
        ],
        maxTurns: 5,
        maxTimeMinutes: 2,
      }),
    );
  });

  it.each([
    [
      'threads the configured memory agent timeout into the forked agent',
      'getMemoryAgentTimeoutMinutes',
      'maxTimeMinutes',
      30,
    ],
    [
      'passes 0 through to disable the time limit',
      'getMemoryAgentTimeoutMinutes',
      'maxTimeMinutes',
      0,
    ],
    [
      'threads the configured memory agent turn limit into the forked agent',
      'getMemoryAgentMaxTurns',
      'maxTurns',
      25,
    ],
    [
      'passes the zero turn-limit sentinel through to the forked agent',
      'getMemoryAgentMaxTurns',
      'maxTurns',
      0,
    ],
  ] as const)('%s', async (_title, getter, param, value) => {
    vi.mocked(mockConfig[getter]).mockReturnValueOnce(value);

    await extract([]);

    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ [param]: value }),
    );
  });

  it('returns empty touchedTopics when agent touches no files', async () => {
    const result = await extract([]);
    expect(result).toEqual({
      touchedTopics: [],
      touchedProjectScope: false,
      touchedUserScope: false,
      hasToolActivity: false,
      systemMessage: undefined,
    });
  });

  it('uses a scoped config that allows shell and denies outside writes', async () => {
    await extract([], { written: false });

    const permissionManager = forkedCall()?.config.getPermissionManager?.();
    expect(permissionManager).toBeDefined();
    expect(await permissionManager!.isToolEnabled(ToolNames.SHELL)).toBe(true);
    expect(
      permissionManager!.findMatchingDenyRule({
        toolName: ToolNames.WRITE_FILE,
        filePath: '/tmp/outside.md',
      }),
    ).toBe(
      'ManagedAutoMemory(write_file: only within /tmp/user-memory or /tmp/auto-memory)',
    );
    expect(
      await permissionManager!.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: '/tmp/outside.md',
      }),
    ).toBe('deny');
  });

  it('protects pinned memory in both managed-memory scopes', async () => {
    await extract([], { written: false });

    const permissionManager = forkedCall()?.config.getPermissionManager?.();
    expect(permissionManager).toBeDefined();
    const pinned = AUTO_MEMORY_PINNED_DIRNAME;
    const { WRITE_FILE, EDIT } = ToolNames;
    for (const [toolName, filePath, decision] of [
      [WRITE_FILE, `/tmp/auto-memory/${pinned}/architecture.md`, 'deny'],
      [EDIT, `/tmp/auto-memory/${pinned}/architecture.md`, 'deny'],
      [WRITE_FILE, `/tmp/user-memory/${pinned}/preferences.md`, 'deny'],
      [EDIT, `/tmp/user-memory/${pinned}/preferences.md`, 'deny'],
      [WRITE_FILE, '/tmp/auto-memory/project/ordinary.md', 'allow'],
      [EDIT, '/tmp/user-memory/user/ordinary.md', 'allow'],
      [WRITE_FILE, `/tmp/auto-memory/project/${pinned}/notes.md`, 'allow'],
      [EDIT, `/tmp/auto-memory/${pinned}-notes/notes.md`, 'allow'],
    ] as const) {
      await expect(
        permissionManager!.evaluate({ toolName, filePath }),
      ).resolves.toBe(decision);
    }
  });

  it('instructs the extraction agent to preserve pinned memory', async () => {
    await extract([], { written: false });

    const call = forkedCall();
    expect(call?.taskPrompt).toContain(
      `top-level \`${AUTO_MEMORY_PINNED_DIRNAME}/\` directory`,
    );
    expect(call?.taskPrompt).toContain(
      'You may read them to avoid duplicates, but never modify, overwrite, rename, merge into, or delete',
    );
    expect(call?.taskPrompt).toContain(
      'Prefer updating an existing writable memory file',
    );
    expect(call?.taskPrompt).toContain(
      'do not intentionally remove their valid entries from `MEMORY.md`',
    );
  });

  it('does not advertise the opt-in list_directory tool to the extraction agent', async () => {
    await extract([], { written: false });

    const call = forkedCall();
    expect(call?.taskPrompt).toContain('Available tools in this run');
    // list_directory is disabled by default, so the prompt must not steer this
    // turn-budgeted background agent toward an unregistered tool.
    expect(call?.taskPrompt).not.toContain('list_directory');
  });

  it('throws when getCacheSafeParams returns null', async () => {
    vi.mocked(getCacheSafeParams).mockReturnValue(null);
    await expect(
      runAutoMemoryExtractionByAgent(mockConfig, '/tmp'),
    ).rejects.toThrow('no cache-safe params');
  });

  it('throws when the agent fails to complete', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'failed',
      terminateReason: 'timeout',
      filesTouched: [],
    });

    await expect(
      runAutoMemoryExtractionByAgent(mockConfig, '/tmp/project'),
    ).rejects.toThrow('timeout');
  });

  it('ignores non-memory file paths in filesTouched', async () => {
    const result = await extract([
      '/tmp/auto-memory/project/arch.md',
      '/tmp/auto-memory/reference/api.md',
      '/tmp/some/other/file.ts',
    ]);
    expectScopes(result, ['project', 'reference'], {
      project: true,
      user: false,
    });
    expect(result.touchedTopics).not.toContain('user');
  });

  it('attributes user-rooted writes to the user scope (not project)', async () => {
    const result = await extract([
      '/tmp/user-memory/user/role.md',
      '/tmp/user-memory/feedback/terse.md',
    ]);
    expectScopes(result, ['user', 'feedback'], { project: false, user: true });
  });

  it('classifies file paths when the root is backslash-native (Windows) but agent reports forward slashes', async () => {
    // Windows roots are backslash-separated (`C:\Users\foo\...\memory`) while
    // the agent's reported `filesTouched` commonly come back forward-slashed;
    // classification must still succeed, or user-scope writes silently fail
    // to rebuild the index on Windows.
    // Sticky mockReturnValue (not Once): production calls each helper twice
    // per extraction (prompt builder + touched-topics classifier). Restored
    // below to keep later tests on the suite's POSIX defaults.
    vi.mocked(getAutoMemoryRoot).mockReturnValue(
      'C:\\Users\\foo\\.qwen\\projects\\proj\\memory',
    );
    vi.mocked(getUserAutoMemoryRoot).mockReturnValue(
      'C:\\Users\\foo\\.qwen\\memories',
    );

    try {
      const result = await extract([
        'C:/Users/foo/.qwen/projects/proj/memory/project/release.md',
        'C:/Users/foo/.qwen/memories/user/role.md',
      ]);
      expectScopes(result, ['project', 'user'], { project: true, user: true });
    } finally {
      vi.mocked(getAutoMemoryRoot).mockReturnValue('/tmp/auto-memory');
      vi.mocked(getUserAutoMemoryRoot).mockReturnValue('/tmp/user-memory');
    }
  });

  it('classifies file paths regardless of which separator the agent reported', async () => {
    // Mocked roots are POSIX (`/tmp/...`); on Windows hosts the agent's
    // filesTouched may use either separator, and the check must accept both.
    const result = await extract([
      '/tmp/auto-memory\\project\\arch.md',
      '/tmp/user-memory\\user\\role.md',
    ]);
    expectScopes(result, ['project', 'user'], { project: true, user: true });
  });

  it('rejects sibling directories that share a root prefix (no startsWith collision)', async () => {
    // /tmp/auto-memory-other/ shares the mocked root's string prefix but is a
    // different directory; the trailing-separator guard must keep it out of
    // both scopes.
    const result = await extract(
      ['/tmp/auto-memory-other/user/x.md', '/tmp/user-memory-backup/user/y.md'],
      { written: false },
    );
    expect(result.touchedTopics).toEqual([]);
    expect(result.touchedProjectScope).toBe(false);
    expect(result.touchedUserScope).toBe(false);
  });

  it('reports both scopes when the agent writes to both roots in one run', async () => {
    const result = await extract([
      '/tmp/user-memory/user/role.md',
      '/tmp/auto-memory/project/release.md',
    ]);
    expectScopes(result, ['user', 'project'], { project: true, user: true });
  });
});
