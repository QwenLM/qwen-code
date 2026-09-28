/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { runAutoMemoryExtractionByAgent } from './extractionAgentPlanner.js';
import { scanAutoMemoryTopicDocuments } from './structured-scan.js';
import {
  AUTO_MEMORY_PINNED_DIRNAME,
  getAutoMemoryRoot,
  getUserAutoMemoryRoot,
} from './paths.js';
import { runForkedAgent, getCacheSafeParams } from '../agents/forkedAgent.js';
import { ToolNames } from '../tools/tool-names.js';
import { formatDateForContext } from '../core/environmentContext.js';
import { AUTO_MEMORY_TREE_CATEGORIES } from './types.js';

vi.mock('./structured-scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./structured-scan.js')>();
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
    getAutoMemoryPrompt: vi.fn().mockReturnValue('session routing contract'),
  } as unknown as Config;

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
        scope: 'project',
        type: 'user',
        filePath: '/tmp/auto-memory/user/prefs.md',
        relativePath: 'user/prefs.md',
        filename: 'prefs.md',
        title: 'User Memory',
        description: 'User preferences',
        category: 'uncategorized',
        keywords: [],
        usageScenarios: [],
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
        systemPrompt: expect.stringMatching(
          /category[\s\S]*usage_scenarios[\s\S]*discriminative retrieval terms or short phrases/,
        ),
        tools: ['read_file', 'grep_search', 'glob', 'write_file', 'edit'],
        maxTurns: 5,
        maxTimeMinutes: 2,
      }),
    );
    const systemPrompt =
      vi.mocked(runForkedAgent).mock.calls[0]?.[0].systemPrompt;
    for (const category of AUTO_MEMORY_TREE_CATEGORIES) {
      expect(systemPrompt).toContain(category);
    }
    expect(systemPrompt).toContain('at most 64 characters');
  });

  it('strips runtime reminders and hidden reasoning from inherited history', async () => {
    vi.mocked(getCacheSafeParams).mockReturnValue({
      generationConfig: {},
      history: [
        {
          role: 'user',
          parts: [
            {
              text: '<system-reminder>skill catalog</system-reminder>\n\nRemember that I prefer concise replies.',
            },
          ],
        },
        {
          role: 'model',
          parts: [
            { thought: true, text: 'hidden reasoning' },
            { functionCall: { name: 'read_file', args: { path: '/tmp/a' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'read_file',
                response: { output: 'large tool result' },
              },
            },
          ],
        },
        { role: 'model', parts: [{ text: 'Understood.' }] },
      ],
      model: 'qwen3-coder-plus',
      version: 1,
    });
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [],
      filesWritten: [],
    });

    await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

    expect(vi.mocked(runForkedAgent).mock.calls[0]?.[0].extraHistory).toEqual([
      {
        role: 'user',
        parts: [{ text: 'Remember that I prefer concise replies.' }],
      },
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'read_file', args: { path: '/tmp/a' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read_file',
              response: { output: 'large tool result' },
            },
          },
        ],
      },
      { role: 'model', parts: [{ text: 'Understood.' }] },
    ]);
  });

  it('drops a reminder-only message instead of inheriting it with empty parts', async () => {
    // A reminder-only `Content` is the common structural shape — the startup
    // skill-catalog prelude and mid-history MCP added-tool announcements are
    // emitted as their own part — and dropping those whole messages is where
    // this PR's token saving comes from. `parts.length > 0 ? … : []` is the
    // branch doing it: keeping the message would hand the forked agent a
    // `Content` with `parts: []` and put the reminder tokens right back.
    vi.mocked(getCacheSafeParams).mockReturnValue({
      generationConfig: {},
      history: [
        {
          role: 'user',
          parts: [
            {
              text: '<system-reminder>\n<available_skills>\n<skill>\n<name>pdf</name>\n<description>Work with PDF files.</description>\n</skill>\n</available_skills>\n</system-reminder>',
            },
          ],
        },
        { role: 'user', parts: [{ text: 'Remember that I prefer tabs.' }] },
        {
          role: 'model',
          parts: [
            { text: '<system-reminder>Context refreshed.</system-reminder>' },
          ],
        },
      ],
      model: 'qwen3-coder-plus',
      version: 1,
    });
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [],
      filesWritten: [],
    });

    await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

    // Both reminder-only messages are gone entirely — no empty-`parts` entry
    // survives — the real turn is kept, and the resulting `user` tail is closed
    // with a model ack so `extraHistory` stays non-empty and alternates.
    expect(vi.mocked(runForkedAgent).mock.calls[0]?.[0].extraHistory).toEqual([
      { role: 'user', parts: [{ text: 'Remember that I prefer tabs.' }] },
      { role: 'model', parts: [{ text: 'Acknowledged.' }] },
    ]);
  });

  it('inherits no history when every message sanitizes away', async () => {
    vi.mocked(getCacheSafeParams).mockReturnValue({
      generationConfig: {},
      history: [
        {
          role: 'user',
          parts: [{ text: '<system-reminder>skill catalog</system-reminder>' }],
        },
      ],
      model: 'qwen3-coder-plus',
      version: 1,
    });
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [],
      filesWritten: [],
    });

    await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

    // The `sanitized.length === 0` guard returns `[]` instead of falling
    // through to the tail handling, which would read `sanitized[-1]`. An empty
    // `extraHistory` makes forkedAgent skip `initialMessages`, so the child
    // rebuilds its own env prelude — deliberate, and now pinned.
    expect(vi.mocked(runForkedAgent).mock.calls[0]?.[0].extraHistory).toEqual(
      [],
    );
  });

  it('keeps the triggering turn when sanitization empties the trailing model message', async () => {
    vi.mocked(getCacheSafeParams).mockReturnValue({
      generationConfig: {},
      history: [
        { role: 'user', parts: [{ text: 'Remember I prefer tabs.' }] },
        { role: 'model', parts: [{ thought: true, text: 'reasoning' }] },
      ],
      model: 'qwen3-coder-plus',
      version: 1,
    });
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [],
      filesWritten: [],
    });

    await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

    // The thought-only model message sanitizes away, leaving a `user` tail.
    // Dropping it would hand the extractor an empty history (forkedAgent
    // turns `[]` into `initialMessages: undefined`), so the turn that
    // triggered extraction is kept and closed with a model ack instead.
    expect(vi.mocked(runForkedAgent).mock.calls[0]?.[0].extraHistory).toEqual([
      { role: 'user', parts: [{ text: 'Remember I prefer tabs.' }] },
      { role: 'model', parts: [{ text: 'Acknowledged.' }] },
    ]);
  });

  it('never leaves an unanswered functionCall at the tail of the inherited history', async () => {
    vi.mocked(getCacheSafeParams).mockReturnValue({
      generationConfig: {},
      history: [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'read_file',
                args: { path: '/tmp/a' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'read_file',
                response: { output: 'real tool result' },
              },
            },
          ],
        },
        { role: 'model', parts: [{ thought: true, text: 'reasoning' }] },
      ],
      model: 'qwen3-coder-plus',
      version: 1,
    });
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [],
      filesWritten: [],
    });

    await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

    // A one-shot trailing trim would delete the real `functionResponse` and
    // leave `functionCall` open at the tail, which the client then closes by
    // synthesizing an *error* response — telling the extractor its parent's
    // successful call failed.
    expect(vi.mocked(runForkedAgent).mock.calls[0]?.[0].extraHistory).toEqual([
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call-1',
              name: 'read_file',
              args: { path: '/tmp/a' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-1',
              name: 'read_file',
              response: { output: 'real tool result' },
            },
          },
        ],
      },
      { role: 'model', parts: [{ text: 'Acknowledged.' }] },
    ]);
  });

  it("states today's date in the task prompt", async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [],
    });

    await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

    // The inherited history is scrubbed of `<system-reminder>` blocks, and
    // those are the only carrier of the date; passing extraHistory also
    // suppresses the fork's env bootstrap. Without this line the prompt's
    // "convert relative dates to absolute dates" rule is unanswerable.
    const call = vi.mocked(runForkedAgent).mock.calls[0]?.[0];
    expect(call?.taskPrompt).toContain(`Today's date is`);
    expect(call?.taskPrompt).toContain(formatDateForContext());
  });

  it('does not inherit the session auto-memory routing contract', async () => {
    // The session contract routes body access through search_memory /
    // manage_memory — tools this agent does not have — and forbids the
    // direct file tools it does have. The extraction prompt already embeds
    // the frontmatter reference, so blanking the inherited section loses
    // nothing.
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [],
      filesWritten: [],
    });

    await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

    const call = vi.mocked(runForkedAgent).mock.calls[0]?.[0];
    expect(call?.config.getAutoMemoryPrompt()).toBe('');
    expect(call?.systemPrompt).toContain('Memory file format reference:');
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

  it('uses a scoped config that denies shell and outside writes', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [],
    });

    await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

    const call = vi.mocked(runForkedAgent).mock.calls[0]?.[0];
    const permissionManager = call?.config.getPermissionManager?.();
    expect(permissionManager).toBeDefined();
    expect(await permissionManager!.isToolEnabled(ToolNames.SHELL)).toBe(false);
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

  it('confines the extraction agent reads to the managed memory roots', async () => {
    // The inherited history is untrusted free text, and this agent runs under
    // YOLO, so the task prompt's "do not inspect unrelated files" cannot be the
    // only thing standing between a prompt-injected instruction and
    // read_file/grep_search over the whole filesystem. Both sibling memory
    // agents pass restrictReadsToMemoryPaths for the same read-only-memory job.
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [],
    });

    await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

    const call = vi.mocked(runForkedAgent).mock.calls[0]?.[0];
    const permissionManager = call?.config.getPermissionManager?.();
    expect(permissionManager).toBeDefined();
    expect(
      permissionManager!.findMatchingDenyRule({
        toolName: ToolNames.READ_FILE,
        filePath: '/home/dev/.ssh/id_rsa',
      }),
    ).toBe(
      'ManagedAutoMemory(read_file: only within /tmp/user-memory or /tmp/auto-memory)',
    );
    await expect(
      permissionManager!.evaluate({
        toolName: ToolNames.READ_FILE,
        filePath: '/home/dev/.ssh/id_rsa',
      }),
    ).resolves.toBe('deny');
    await expect(
      permissionManager!.evaluate({
        toolName: ToolNames.GREP,
        filePath: '/home/dev/.ssh',
      }),
    ).resolves.toBe('deny');
    // Reads inside either managed root stay allowed — that is the agent's job,
    // including the docs past the prompt's summary cap.
    await expect(
      permissionManager!.evaluate({
        toolName: ToolNames.READ_FILE,
        filePath: '/tmp/auto-memory/user/prefs.md',
      }),
    ).resolves.toBe('allow');
    await expect(
      permissionManager!.evaluate({
        toolName: ToolNames.READ_FILE,
        filePath: '/tmp/user-memory/feedback/terse.md',
      }),
    ).resolves.toBe('allow');
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

  it('does not advertise unregistered tools to the extraction agent', async () => {
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
    // Same for shell: it is no longer in this agent's `tools` list and the
    // scoped config denies it, so advertising it would burn one of the 5
    // turns on a call that cannot execute. The sibling dream agent does keep
    // shell (dreamAgentPlanner passes allowShell), so this stays per-agent.
    expect(call?.taskPrompt).not.toContain('run_shell_command');
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

  it('includes the existing keyword vocabulary in the agent task prompt', async () => {
    // The reuse-canonical-terms instruction is meaningless unless the
    // vocabulary snapshot actually reaches the task prompt.
    vi.mocked(scanAutoMemoryTopicDocuments).mockResolvedValue([
      {
        scope: 'project',
        type: 'project',
        filePath: '/tmp/auto-memory/project/conventions.md',
        relativePath: 'project/conventions.md',
        filename: 'conventions.md',
        title: 'Project conventions',
        description: 'Project conventions memory',
        category: 'project_introduction',
        keywords: ['terse responses', 'memory migration'],
        usageScenarios: [],
        body: 'Prefer terse responses.',
        mtimeMs: 1,
      },
    ]);
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [],
      filesWritten: [],
    });

    await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

    const taskPrompt = vi.mocked(runForkedAgent).mock.calls[0]?.[0].taskPrompt;
    expect(taskPrompt).toContain('## Existing keyword vocabulary');
    expect(taskPrompt).toContain('terse responses');
  });
});
