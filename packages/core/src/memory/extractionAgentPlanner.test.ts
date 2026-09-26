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
const mockIsBashSearchAvailable = vi.hoisted(() => vi.fn());
vi.mock('../utils/bash-search-tools.js', () => ({
  isBashSearchAvailable: mockIsBashSearchAvailable,
}));

describe('runAutoMemoryExtractionByAgent', () => {
  const mockConfig = {
    getSessionId: vi.fn().mockReturnValue('session-1'),
    getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
    getApprovalMode: vi.fn(),
    getMemoryAgentTimeoutMinutes: vi.fn().mockReturnValue(undefined),
    getMemoryAgentMaxTurns: vi.fn().mockReturnValue(undefined),
  } as unknown as Config;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBashSearchAvailable.mockReturnValue(false);
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
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: ['/tmp/auto-memory/user/prefs.md'],
      filesWritten: ['/tmp/auto-memory/user/prefs.md'],
    });

    const result = await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

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

  it('uses only Shell for search when Bash search is available', async () => {
    mockIsBashSearchAvailable.mockReturnValue(true);
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [],
      filesWritten: [],
    });

    await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ['read_file', 'run_shell_command', 'write_file', 'edit'],
        taskPrompt: expect.stringContaining(
          '`run_shell_command` with `rg` / `rg --files`',
        ),
      }),
    );
  });

  it('threads the configured memory agent timeout into the forked agent', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [],
      filesWritten: [],
    });
    vi.mocked(mockConfig.getMemoryAgentTimeoutMinutes).mockReturnValueOnce(30);

    await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ maxTimeMinutes: 30 }),
    );
  });

  it('passes 0 through to disable the time limit', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [],
      filesWritten: [],
    });
    vi.mocked(mockConfig.getMemoryAgentTimeoutMinutes).mockReturnValueOnce(0);

    await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ maxTimeMinutes: 0 }),
    );
  });

  it('threads the configured memory agent turn limit into the forked agent', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [],
      filesWritten: [],
    });
    vi.mocked(mockConfig.getMemoryAgentMaxTurns).mockReturnValueOnce(25);

    await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ maxTurns: 25 }),
    );
  });

  it('passes the zero turn-limit sentinel through to the forked agent', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [],
      filesWritten: [],
    });
    vi.mocked(mockConfig.getMemoryAgentMaxTurns).mockReturnValueOnce(0);

    await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ maxTurns: 0 }),
    );
  });

  it('returns empty touchedTopics when agent touches no files', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [],
      filesWritten: [],
    });

    const result = await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');
    expect(result).toEqual({
      touchedTopics: [],
      touchedProjectScope: false,
      touchedUserScope: false,
      hasToolActivity: false,
      systemMessage: undefined,
    });
  });

  it('uses a scoped config that allows shell and denies outside writes', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [],
    });

    await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

    const call = vi.mocked(runForkedAgent).mock.calls[0]?.[0];
    const permissionManager = call?.config.getPermissionManager?.();
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
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [],
    });

    await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

    const call = vi.mocked(runForkedAgent).mock.calls[0]?.[0];
    const permissionManager = call?.config.getPermissionManager?.();
    expect(permissionManager).toBeDefined();
    await expect(
      permissionManager!.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: `/tmp/auto-memory/${AUTO_MEMORY_PINNED_DIRNAME}/architecture.md`,
      }),
    ).resolves.toBe('deny');
    await expect(
      permissionManager!.evaluate({
        toolName: ToolNames.EDIT,
        filePath: `/tmp/auto-memory/${AUTO_MEMORY_PINNED_DIRNAME}/architecture.md`,
      }),
    ).resolves.toBe('deny');
    await expect(
      permissionManager!.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: `/tmp/user-memory/${AUTO_MEMORY_PINNED_DIRNAME}/preferences.md`,
      }),
    ).resolves.toBe('deny');
    await expect(
      permissionManager!.evaluate({
        toolName: ToolNames.EDIT,
        filePath: `/tmp/user-memory/${AUTO_MEMORY_PINNED_DIRNAME}/preferences.md`,
      }),
    ).resolves.toBe('deny');
    await expect(
      permissionManager!.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: '/tmp/auto-memory/project/ordinary.md',
      }),
    ).resolves.toBe('allow');
    await expect(
      permissionManager!.evaluate({
        toolName: ToolNames.EDIT,
        filePath: '/tmp/user-memory/user/ordinary.md',
      }),
    ).resolves.toBe('allow');
    await expect(
      permissionManager!.evaluate({
        toolName: ToolNames.WRITE_FILE,
        filePath: `/tmp/auto-memory/project/${AUTO_MEMORY_PINNED_DIRNAME}/notes.md`,
      }),
    ).resolves.toBe('allow');
    await expect(
      permissionManager!.evaluate({
        toolName: ToolNames.EDIT,
        filePath: `/tmp/auto-memory/${AUTO_MEMORY_PINNED_DIRNAME}-notes/notes.md`,
      }),
    ).resolves.toBe('allow');
  });

  it('instructs the extraction agent to preserve pinned memory', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [],
    });

    await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

    const call = vi.mocked(runForkedAgent).mock.calls[0]?.[0];
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
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [],
    });

    await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

    const call = vi.mocked(runForkedAgent).mock.calls[0]?.[0];
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
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [
        '/tmp/auto-memory/project/arch.md',
        '/tmp/auto-memory/reference/api.md',
        '/tmp/some/other/file.ts',
      ],
      filesWritten: [
        '/tmp/auto-memory/project/arch.md',
        '/tmp/auto-memory/reference/api.md',
        '/tmp/some/other/file.ts',
      ],
    });

    const result = await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');
    expect(result.touchedTopics).toEqual(
      expect.arrayContaining(['project', 'reference']),
    );
    expect(result.touchedTopics).not.toContain('user');
    expect(result.touchedProjectScope).toBe(true);
    expect(result.touchedUserScope).toBe(false);
  });

  it('attributes user-rooted writes to the user scope (not project)', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [
        '/tmp/user-memory/user/role.md',
        '/tmp/user-memory/feedback/terse.md',
      ],
      filesWritten: [
        '/tmp/user-memory/user/role.md',
        '/tmp/user-memory/feedback/terse.md',
      ],
    });

    const result = await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');
    expect(result.touchedTopics).toEqual(
      expect.arrayContaining(['user', 'feedback']),
    );
    expect(result.touchedUserScope).toBe(true);
    expect(result.touchedProjectScope).toBe(false);
  });

  it('classifies file paths when the root is backslash-native (Windows) but agent reports forward slashes', async () => {
    // On Windows the roots returned by getAutoMemoryRoot/getUserAutoMemoryRoot
    // are backslash-separated (`C:\Users\foo\...\memory`). The model's tool
    // calls (and the writes the agent reports as `filesTouched`) commonly
    // come back forward-slash-normalized. The classification must succeed in
    // that case — otherwise user-scope writes silently fail to rebuild the
    // index on Windows.
    //
    // sticky mockReturnValue (not Once) — the production code calls each
    // helper twice per extraction (prompt builder + touched-topics
    // classifier) so a Once-mock only covers the first call. Restored
    // below to keep subsequent tests on the suite's POSIX defaults.
    vi.mocked(getAutoMemoryRoot).mockReturnValue(
      'C:\\Users\\foo\\.qwen\\projects\\proj\\memory',
    );
    vi.mocked(getUserAutoMemoryRoot).mockReturnValue(
      'C:\\Users\\foo\\.qwen\\memories',
    );
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [
        'C:/Users/foo/.qwen/projects/proj/memory/project/release.md',
        'C:/Users/foo/.qwen/memories/user/role.md',
      ],
      filesWritten: [
        'C:/Users/foo/.qwen/projects/proj/memory/project/release.md',
        'C:/Users/foo/.qwen/memories/user/role.md',
      ],
    });

    try {
      const result = await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');
      expect(result.touchedTopics).toEqual(
        expect.arrayContaining(['project', 'user']),
      );
      expect(result.touchedProjectScope).toBe(true);
      expect(result.touchedUserScope).toBe(true);
    } finally {
      vi.mocked(getAutoMemoryRoot).mockReturnValue('/tmp/auto-memory');
      vi.mocked(getUserAutoMemoryRoot).mockReturnValue('/tmp/user-memory');
    }
  });

  it('classifies file paths regardless of which separator the agent reported', async () => {
    // Roots come back from the mocked getAutoMemoryRoot/getUserAutoMemoryRoot
    // as POSIX paths (`/tmp/...`). The agent's filesTouched may use either
    // separator on Windows hosts — the check must accept both.
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [
        '/tmp/auto-memory\\project\\arch.md',
        '/tmp/user-memory\\user\\role.md',
      ],
      filesWritten: [
        '/tmp/auto-memory\\project\\arch.md',
        '/tmp/user-memory\\user\\role.md',
      ],
    });

    const result = await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');
    expect(result.touchedTopics).toEqual(
      expect.arrayContaining(['project', 'user']),
    );
    expect(result.touchedProjectScope).toBe(true);
    expect(result.touchedUserScope).toBe(true);
  });

  it('rejects sibling directories that share a root prefix (no startsWith collision)', async () => {
    // getAutoMemoryRoot mocked → /tmp/auto-memory.
    // A path inside /tmp/auto-memory-other/ shares the string prefix but is
    // a different directory entirely; the trailing-separator guard must keep
    // it out of both scopes.
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [
        '/tmp/auto-memory-other/user/x.md',
        '/tmp/user-memory-backup/user/y.md',
      ],
    });

    const result = await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');
    expect(result.touchedTopics).toEqual([]);
    expect(result.touchedProjectScope).toBe(false);
    expect(result.touchedUserScope).toBe(false);
  });

  it('reports both scopes when the agent writes to both roots in one run', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [
        '/tmp/user-memory/user/role.md',
        '/tmp/auto-memory/project/release.md',
      ],
      filesWritten: [
        '/tmp/user-memory/user/role.md',
        '/tmp/auto-memory/project/release.md',
      ],
    });

    const result = await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');
    expect(result.touchedTopics).toEqual(
      expect.arrayContaining(['user', 'project']),
    );
    expect(result.touchedProjectScope).toBe(true);
    expect(result.touchedUserScope).toBe(true);
  });
});
