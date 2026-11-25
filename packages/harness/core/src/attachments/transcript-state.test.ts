/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { InvokedSkillsAttachment } from './models/skill-attachments.js';
import { SkillListingAttachment } from './models/skill-attachments.js';
import { FileAttachment } from './models/file-attachments.js';
import {
  McpInstructionsDeltaAttachment,
  McpLazyToolsDeltaAttachment,
} from './models/mcp-attachments.js';
import { AgentListingDeltaAttachment } from './models/agent-attachments.js';
import { CriticalSystemReminderAttachment } from './models/system-attachments.js';
import { RelevantMemoriesAttachment } from './models/memory-attachments.js';
import { CurrentSessionMemoryAttachment } from './models/memory-attachments.js';
import { DateChangeAttachment } from './models/system-attachments.js';
import { TeamContextAttachment } from './models/agent-attachments.js';
import { HookOutputAttachment } from './models/hook-attachments.js';
import { AlreadyReadFileAttachment } from './models/file-attachments.js';
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HookEventName } from '../hooks/types.js';
import type { Message } from '../protocol/transcript/message.js';
import { sha1 } from '../utils/paths.js';
import { createAttachmentMessage } from './factory.js';
import { createAttachmentContext } from './get-attachments.js';
import { getChangedFiles } from './generators/file-generators.js';
import {
  readFileStateFromResult,
  restoreAttachmentTranscriptState,
  restoreInvokedSkillsFromTranscript,
  sessionStartHookOutputFingerprint,
  snapshotAttachmentDeltaState,
} from './transcript-state.js';
import { isFullFileRead } from '../utils/fileStateCache.js';

describe('Invoked Skill restoration', () => {
  it('replaces active state with Skill bodies persisted by compaction', () => {
    const skillManager = {
      activateSkill: vi.fn(),
      clearInvokedSkillsForAgent: vi.fn(),
    };
    const messages = [
      createAttachmentMessage(
        new InvokedSkillsAttachment({
          type: 'invoked_skills',
          skills: [
            {
              name: 'review',
              path: '/skills/review/SKILL.md',
              content: 'Rendered review body',
            },
            {
              name: 'explain',
              path: '/skills/explain/SKILL.md',
              content: 'Rendered explain body',
            },
          ],
        }),
      ),
      createAttachmentMessage(
        new SkillListingAttachment({
          type: 'skill_listing',
          content: '- review: Review changes',
          names: ['review'],
          skillCount: 1,
          isInitial: true,
        }),
      ),
    ];

    restoreInvokedSkillsFromTranscript(
      skillManager,
      messages as unknown as Message[],
      'main',
    );

    expect(skillManager.clearInvokedSkillsForAgent).toHaveBeenCalledWith(
      'main',
    );
    expect(skillManager.activateSkill).toHaveBeenNthCalledWith(
      1,
      'review',
      'Rendered review body',
      'main',
    );
    expect(skillManager.activateSkill).toHaveBeenNthCalledWith(
      2,
      'explain',
      'Rendered explain body',
      'main',
    );
  });
});

describe('Read result range restoration', () => {
  it.each([
    { replacement: '/unrelated.txt' },
    { replacement: ['/unrelated.txt'] },
    { replacement: ['/unrelated.txt', null, null] },
    { replacement: 42 },
  ])(
    'keeps separate partial baselines for malformed replacement metadata: $replacement',
    ({ replacement }) => {
      const ctx = createAttachmentContext('/cwd');
      const calls = ['a', 'b'].map((id) => ({
        type: 'tool_use',
        id,
        name: 'Read',
        input: { file_path: id + '.txt' },
      }));
      restoreAttachmentTranscriptState(ctx, [
        { type: 'assistant', message: { content: calls } },
        {
          type: 'user',
          timestamp: '2026-01-01T00:00:00.000Z',
          readOutputReplacement: replacement,
          message: {
            role: 'user',
            content: calls.map((call) => ({
              type: 'tool_result',
              tool_use_id: call.id,
              content: '1\tvisible',
            })),
          },
          toolUseResult: calls.map((call) => ({
            file: { filePath: call.input.file_path, content: 'visible' },
          })),
        },
      ] as unknown as Message[]);
      expect(ctx.fileReadState.has('/unrelated.txt')).toBe(false);
      for (const id of ['a', 'b']) {
        expect(ctx.fileReadState.get(`/cwd/${id}.txt`)).toMatchObject({
          isPartialView: true,
          contentNotInModelContext: true,
        });
      }
    },
  );

  it('pairs replacement metadata with the corresponding result and lets a later full Read replace it', () => {
    const ctx = createAttachmentContext('/cwd');
    const timestamp = '2026-01-01T00:00:00.000Z';
    const calls = ['a', 'b'].map((id) => ({
      type: 'tool_use',
      id,
      name: 'Read',
      input: { file_path: id + '.txt' },
    }));
    const history = [
      { type: 'assistant', timestamp, message: { content: calls } },
      {
        type: 'user',
        timestamp,
        readOutputReplacement: [null, '/actual.txt'],
        message: {
          role: 'user',
          content: calls.map((call) => ({
            type: 'tool_result',
            tool_use_id: call.id,
            content: '1\tvisible',
          })),
        },
        toolUseResult: [
          { file: { filePath: 'a.txt', content: 'visible' } },
          '1\tvisible',
        ],
      },
    ] as unknown as Message[];
    restoreAttachmentTranscriptState(ctx, history);
    expect(isFullFileRead(ctx.fileReadState.get('/cwd/a.txt')!)).toBe(true);
    expect(ctx.fileReadState.has('/cwd/b.txt')).toBe(false);
    expect(ctx.fileReadState.get('/actual.txt')).toMatchObject({
      isPartialView: true,
      contentNotInModelContext: true,
    });
    restoreAttachmentTranscriptState(ctx, [
      ...history,
      {
        type: 'assistant',
        timestamp,
        message: {
          content: [
            { ...calls[0], id: 'full', input: { file_path: '/actual.txt' } },
          ],
        },
      },
      {
        type: 'user',
        timestamp,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'full', content: '1\tvisible' },
          ],
        },
        toolUseResult: {
          file: { filePath: '/actual.txt', content: 'visible' },
        },
      },
    ] as Message[]);
    expect(isFullFileRead(ctx.fileReadState.get('/actual.txt')!)).toBe(true);
  });

  it.each([
    {},
    { cells: null },
    { cells: [{}] },
    {
      cells: [{ cell_id: 'a', cellType: 'code', source: 'x', outputs: [null] }],
    },
  ])('ignores malformed Notebook Read payloads: %j', (file) => {
    expect(
      readFileStateFromResult({}, { type: 'notebook', file }, 'text', 1),
    ).toBeUndefined();
  });

  it.each([
    {
      name: 'hook narrows limit',
      input: {},
      start: 1,
      count: 1,
      total: 3,
      offset: 1,
      limit: 1,
      full: false,
    },
    {
      name: 'hook moves offset',
      input: {},
      start: 2,
      count: 2,
      total: 3,
      offset: 2,
      limit: 2,
      full: false,
    },
    {
      name: 'hook expands to full Read',
      input: { offset: 2, limit: 1 },
      start: 1,
      count: 3,
      total: 3,
      offset: 1,
      limit: undefined,
      full: true,
    },
    {
      name: 'ordinary full Read',
      input: {},
      start: 1,
      count: 3,
      total: 3,
      offset: 1,
      limit: undefined,
      full: true,
    },
    {
      name: 'ordinary exact limit',
      input: { limit: 3 },
      start: 1,
      count: 3,
      total: 3,
      offset: 1,
      limit: 3,
      full: false,
    },
    {
      name: 'ordinary limit beyond EOF',
      input: { limit: 4 },
      start: 1,
      count: 3,
      total: 3,
      offset: 1,
      limit: 4,
      full: true,
    },
    {
      name: 'zero-based first line',
      input: { offset: 0 },
      start: 0,
      count: 3,
      total: 3,
      offset: 0,
      limit: undefined,
      full: true,
    },
  ])('$name', ({ input, start, count, total, offset, limit, full }) => {
    const lines = Array.from({ length: count }, (_, i) => `line ${i}`);
    const state = readFileStateFromResult(
      input,
      {
        file: {
          content: lines.join('\n'),
          startLine: start,
          numLines: count,
          totalLines: total,
        },
      },
      lines.map((line, i) => `${start + i}\t${line}`).join('\n'),
      1,
    )!;
    expect(state).toMatchObject({ offset, limit, isPartialView: false });
    expect(isFullFileRead(state)).toBe(full);
  });

  it.each([
    { startLine: 1 },
    { startLine: 1, numLines: 1, totalLines: '2' },
    { startLine: 1, numLines: 3, totalLines: 2 },
    { startLine: -1, numLines: 1, totalLines: 2 },
  ])('retains a partial baseline for malformed metadata %j', (range) => {
    const state = readFileStateFromResult(
      {},
      { file: { content: 'first', ...range } },
      '1\tfirst',
      1,
    )!;
    expect(state).toBeDefined();
    expect(isFullFileRead(state)).toBe(false);
  });
});

describe('restoreAttachmentTranscriptState', () => {
  it('restores a ranged file attachment as a partial read in both caches', () => {
    const ctx = createAttachmentContext('/cwd');
    restoreAttachmentTranscriptState(ctx, [
      createAttachmentMessage(
        new FileAttachment({
          type: 'file',
          filename: '/cwd/a.ts',
          displayPath: 'a.ts',
          content: 'line two',
          mtime: 123,
          offset: 2,
          limit: 1,
        }),
      ),
    ] as unknown as Message[]);
    for (const cache of [ctx.readFileState, ctx.fileReadState]) {
      const state = cache.get('/cwd/a.ts')!;
      expect(state).toMatchObject({
        content: 'line two',
        offset: 2,
        limit: 1,
        isPartialView: true,
      });
      expect(isFullFileRead(state)).toBe(false);
    }
  });

  it('rebuilds delta generators from ordered persisted attachments', () => {
    const messages = [
      createAttachmentMessage(
        new SkillListingAttachment({
          type: 'skill_listing',
          content: 'initial skills',
          names: ['inspect', 'review'],
          skillCount: 2,
          isInitial: true,
        }),
      ),
      createAttachmentMessage(
        new SkillListingAttachment({
          type: 'skill_listing',
          content: 'new skill',
          names: ['ship'],
          skillCount: 1,
          isInitial: false,
        }),
      ),
      createAttachmentMessage(
        new McpInstructionsDeltaAttachment({
          type: 'mcp_instructions_delta',
          addedNames: ['repo', 'docs'],
          addedBlocks: ['repo instructions', 'docs instructions'],
          removedNames: [],
        }),
      ),
      createAttachmentMessage(
        new McpInstructionsDeltaAttachment({
          type: 'mcp_instructions_delta',
          addedNames: [],
          addedBlocks: [],
          removedNames: ['docs'],
        }),
      ),
      createAttachmentMessage(
        new AgentListingDeltaAttachment({
          type: 'agent_listing_delta',
          addedTypes: ['Explore', 'Plan'],
          addedLines: ['Explore', 'Plan'],
          removedTypes: [],
          isInitial: true,
          showConcurrencyNote: true,
        }),
      ),
      createAttachmentMessage(
        new CriticalSystemReminderAttachment({
          type: 'critical_system_reminder',
          content: 'legacy lazy MCP catalog',
        }),
      ),
      createAttachmentMessage(
        new McpLazyToolsDeltaAttachment({
          type: 'mcp_lazy_tools_delta',
          content: 'stale catalog',
          isInitial: true,
          addedNames: ['mcp__old__read'],
          removedNames: [],
        }),
      ),
      createAttachmentMessage(
        new McpLazyToolsDeltaAttachment({
          type: 'mcp_lazy_tools_delta',
          content: 'lazy MCP catalog',
          isInitial: true,
          addedNames: ['mcp__repo__read', 'mcp__repo__write'],
          removedNames: [],
        }),
      ),
      createAttachmentMessage(
        new McpLazyToolsDeltaAttachment({
          type: 'mcp_lazy_tools_delta',
          content: 'lazy MCP delta',
          isInitial: false,
          addedNames: ['mcp__repo__search'],
          removedNames: ['mcp__repo__write'],
        }),
      ),
      createAttachmentMessage(
        new RelevantMemoriesAttachment({
          type: 'relevant_memories',
          files: [
            {
              filePath: '/workspace/AGENTS.md',
              content: 'instructions',
              memoryType: 'project',
            },
          ],
        }),
      ),
      createAttachmentMessage(
        new CurrentSessionMemoryAttachment({
          type: 'current_session_memory',
          snapshot: 'session summary',
        }),
      ),
      createAttachmentMessage(
        new DateChangeAttachment({
          type: 'date_change',
          newDate: '2026-09-15',
        }),
      ),
      createAttachmentMessage(
        new TeamContextAttachment({
          type: 'team_context',
          agents: [
            {
              agentName: 'worker',
              state: 'running',
              recentActivity: [],
            },
          ],
        }),
      ),
      createAttachmentMessage(
        new HookOutputAttachment({
          type: 'hook_output',
          hookEventName: HookEventName.SessionStart,
          output: 'workspace ready',
        }),
      ),
    ] as unknown as Message[];
    const ctx = createAttachmentContext('/workspace', 'fork-session');

    restoreAttachmentTranscriptState(ctx, messages);

    expect([...ctx.sentSkillNames.get('fork-session')!]).toEqual([
      'inspect',
      'review',
      'ship',
    ]);
    expect([...ctx.announcedMcpInstructionServers]).toEqual(['repo']);
    expect([...ctx.announcedLazyMcpTools].sort()).toEqual([
      'mcp__repo__read',
      'mcp__repo__search',
    ]);
    expect([...ctx.announcedAgentTypes]).toEqual(['Explore', 'Plan']);
    expect(ctx.loadedNestedMemoryPaths).toContain('/workspace/AGENTS.md');
    expect(ctx.lastDateSeen).toBe('2026-09-15');
    expect(ctx.lastSubagentHash).toBe(
      sha1(
        JSON.stringify([
          {
            agentName: 'worker',
            state: 'running',
            recentActivity: [],
          },
        ]),
      ),
    );
    expect(ctx.seenSessionStartHookOutputs).toContain(
      sessionStartHookOutputFingerprint('workspace ready'),
    );
  });

  it('replaces restored skill state at a later full listing', () => {
    const messages = [
      createAttachmentMessage(
        new SkillListingAttachment({
          type: 'skill_listing',
          content: 'old skills',
          names: ['old'],
          skillCount: 1,
          isInitial: true,
        }),
      ),
      createAttachmentMessage(
        new SkillListingAttachment({
          type: 'skill_listing',
          content: 'current skills',
          names: ['current'],
          skillCount: 1,
          isInitial: true,
        }),
      ),
    ] as unknown as Message[];
    const ctx = createAttachmentContext('/workspace', 'session');

    restoreAttachmentTranscriptState(ctx, messages);

    expect([...ctx.sentSkillNames.get('session')!]).toEqual(['current']);
  });

  it('rebuilds file state so edits after resume are detected', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-resume-'));
    const filename = path.join(dir, 'example.txt');
    try {
      await fs.writeFile(filename, 'changed after resume');
      const messages = [
        createAttachmentMessage(
          new FileAttachment({
            type: 'file',
            filename,
            content: 'content stored in transcript',
            displayPath: 'example.txt',
            mtime: 1,
          }),
        ),
      ] as unknown as Message[];
      const ctx = createAttachmentContext(dir, 'session');

      restoreAttachmentTranscriptState(ctx, messages);
      const changes = await getChangedFiles(ctx);

      expect(ctx.readFileState.get(filename)?.content).toBe(
        'changed after resume',
      );
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        type: 'edited_text_file',
        filename,
        content: 'changed after resume',
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['full', 'partial', 'orphan'] as const)(
    'does not upgrade or overwrite a %s baseline from an already-read notice',
    (kind) => {
      const original = createAttachmentMessage(
        new FileAttachment({
          type: 'file',
          filename: '/workspace/file.txt',
          displayPath: 'file.txt',
          content: 'observed',
          mtime: 10,
          truncated: kind === 'partial',
        }),
      );
      const notice = createAttachmentMessage(
        new AlreadyReadFileAttachment({
          type: 'already_read_file',
          filename: '/workspace/file.txt',
          displayPath: 'file.txt',
          content: 'old excerpt',
          mtime: 1,
        }),
      );
      const ctx = createAttachmentContext('/workspace');
      restoreAttachmentTranscriptState(
        ctx,
        (kind === 'orphan'
          ? [notice]
          : [original, notice]) as unknown as Message[],
      );
      for (const cache of [ctx.readFileState, ctx.fileReadState]) {
        expect(cache.get('/workspace/file.txt')).toMatchObject({
          content: kind === 'orphan' ? 'old excerpt' : 'observed',
          timestamp: kind === 'orphan' ? 1 : 10,
          isPartialView: kind !== 'full',
        });
      }
    },
  );

  it('ignores malformed attachment payloads from an existing transcript', () => {
    const malformed = {
      type: 'attachment',
      uuid: 'malformed-attachment',
      timestamp: new Date().toISOString(),
      attachment: null,
    } as unknown as Message;
    const ctx = createAttachmentContext('/workspace', 'session');

    expect(() =>
      restoreAttachmentTranscriptState(ctx, [malformed]),
    ).not.toThrow();
    expect(ctx.readFileState.size).toBe(0);
  });

  it('normalizes random hook spill paths before fingerprinting', () => {
    const first = sessionStartHookOutputFingerprint(
      'same output\nFull output saved to: /tmp/test-hook-output/first.txt]',
    );
    const second = sessionStartHookOutputFingerprint(
      'same output\nFull output saved to: /tmp/test-hook-output/second.txt]',
    );

    expect(first).toBe(second);
  });
});

describe('snapshotAttachmentDeltaState', () => {
  it('restores every delta baseline, including in-place mutations', () => {
    const ctx = createAttachmentContext('/workspace', 'session');
    ctx.announcedLazyMcpTools.add('mcp__files__read');
    ctx.announcedMcpInstructionServers.add('files');
    ctx.announcedAgentTypes.add('explore');
    ctx.announcedAgentDescriptions = new Map([['explore', 'old']]);
    ctx.sentSkillNames.set('main', new Set(['skill-a']));
    ctx.sentSkillListingFingerprints = new Map([['main', 'fp-a']]);
    const queued = new DateChangeAttachment({
      type: 'date_change',
      newDate: '2026-10-17',
    });
    ctx.pendingPostCompactDeltaAttachments = [queued];

    const restore = snapshotAttachmentDeltaState(ctx);

    ctx.announcedLazyMcpTools.add('mcp__files__write');
    ctx.announcedMcpInstructionServers.clear();
    ctx.announcedAgentTypes.add('plan');
    ctx.announcedAgentDescriptions.set('explore', 'new');
    ctx.sentSkillNames.get('main')?.add('skill-b');
    ctx.sentSkillNames.set('sub', new Set(['skill-c']));
    ctx.sentSkillListingFingerprints.set('main', 'fp-b');
    ctx.pendingPostCompactDeltaAttachments = null;

    restore();

    expect([...ctx.announcedLazyMcpTools]).toEqual(['mcp__files__read']);
    expect([...ctx.announcedMcpInstructionServers]).toEqual(['files']);
    expect([...ctx.announcedAgentTypes]).toEqual(['explore']);
    expect([...ctx.announcedAgentDescriptions]).toEqual([['explore', 'old']]);
    expect([...ctx.sentSkillNames]).toEqual([['main', new Set(['skill-a'])]]);
    expect(ctx.pendingPostCompactDeltaAttachments).toEqual([queued]);
    expect([...ctx.sentSkillListingFingerprints]).toEqual([['main', 'fp-a']]);
  });

  it('keeps an empty deferred queue empty', () => {
    const ctx = createAttachmentContext('/workspace', 'session');
    ctx.pendingPostCompactDeltaAttachments = null;
    const restore = snapshotAttachmentDeltaState(ctx);
    ctx.pendingPostCompactDeltaAttachments = [];
    restore();
    expect(ctx.pendingPostCompactDeltaAttachments).toBeNull();
  });
});

describe('tool file baseline history', () => {
  const call = (
    id: string,
    name = 'Read',
    input: Record<string, unknown> = { file_path: 'file.txt' },
  ): Message =>
    ({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name, input }] },
    }) as unknown as Message;
  const result = (
    id: string,
    content: string,
    body: string,
    timestamp = '2026-09-09T00:00:00.000Z',
  ): Message =>
    ({
      type: 'user',
      timestamp,
      message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
      toolUseResult: { file: { content: body } },
    }) as unknown as Message;
  it('restores successful tools and attachments in transcript order, not mixed timestamps', () => {
    const ctx = createAttachmentContext('/workspace', 'session');
    restoreAttachmentTranscriptState(ctx, [
      call('r'),
      result('r', '1\tfirst', 'first'),
      createAttachmentMessage(
        new FileAttachment({
          type: 'file',
          filename: '/workspace/file.txt',
          content: 'later',
          displayPath: 'file.txt',
          mtime: 1,
        }) as never,
      ) as unknown as Message,
    ]);
    expect(ctx.fileReadState.get('/workspace/file.txt')?.content).toBe('later');
  });
  it('preserves spaces and refuses to claim replaced/truncated Read output as complete', () => {
    const ctx = createAttachmentContext('/workspace', 'session');
    restoreAttachmentTranscriptState(ctx, [
      call('r'),
      result('r', 'hook replaced output', '  original  '),
    ]);
    expect(ctx.fileReadState.get('/workspace/file.txt')).toMatchObject({
      content: '  original  ',
      isPartialView: true,
      contentNotInModelContext: true,
    });
    restoreAttachmentTranscriptState(ctx, [
      call('r'),
      result('r', '1\t  original  ', '  original  '),
    ]);
    expect(ctx.fileReadState.get('/workspace/file.txt')).toMatchObject({
      content: '  original  ',
      isPartialView: false,
    });
  });
  it('skips failures and illegal timestamps instead of fabricating a read', () => {
    const ctx = createAttachmentContext('/workspace', 'session');
    const failure = result('r', 'error', 'not read');
    const failedUser = failure as Extract<Message, { type: 'user' }>;
    const failedBlock = Array.isArray(failedUser.message.content)
      ? failedUser.message.content[0]
      : undefined;
    if (failedBlock?.type === 'tool_result') failedBlock.is_error = true;
    restoreAttachmentTranscriptState(ctx, [
      call('r'),
      failure,
      call('bad'),
      result('bad', '1\tbad', 'bad', 'invalid'),
    ]);
    expect(ctx.fileReadState.size).toBe(0);
  });
  it('restores legacy numbered results without trimming file whitespace', () => {
    const ctx = createAttachmentContext('/workspace', 'session');
    const legacy = result('r', '1\t  a\n2\tb  ', 'unused');
    delete (legacy as Extract<Message, { type: 'user' }>).toolUseResult;
    restoreAttachmentTranscriptState(ctx, [call('r'), legacy]);
    expect(ctx.fileReadState.get('/workspace/file.txt')?.content).toBe(
      '  a\nb  ',
    );
  });
  it('pairs multiple structured Read results by position', () => {
    const ctx = createAttachmentContext('/workspace', 'session');
    const first = result('a', '1\ta', 'a');
    const user = first as Extract<Message, { type: 'user' }>;
    user.message.content = [
      { type: 'tool_result', tool_use_id: 'a', content: '1\ta' },
      { type: 'tool_result', tool_use_id: 'b', content: '1\tb' },
    ];
    user.toolUseResult = [
      { file: { content: 'a' } },
      { file: { content: 'b' } },
    ];
    restoreAttachmentTranscriptState(ctx, [
      call('a', 'Read', { file_path: 'a' }),
      call('b', 'Read', { file_path: 'b' }),
      first,
    ]);
    expect(ctx.fileReadState.get('/workspace/a')?.content).toBe('a');
    expect(ctx.fileReadState.get('/workspace/b')?.content).toBe('b');
  });
  it('resolves relative Read results using historical cwd, including hook targets', () => {
    const ctx = createAttachmentContext('/new', 'session');
    const request = call('r', 'Read', { file_path: '/old/requested.txt' });
    request.cwd = '/old';
    const response = result('r', '1\tactual', 'actual') as Extract<
      Message,
      { type: 'user' }
    >;
    response.cwd = '/old';
    response.toolUseResult = {
      file: { filePath: 'actual.txt', content: 'actual' },
    };
    restoreAttachmentTranscriptState(ctx, [request, response]);
    expect(ctx.fileReadState.get('/old/actual.txt')?.content).toBe('actual');
    expect(ctx.fileReadState.has('/new/actual.txt')).toBe(false);
    expect(ctx.fileReadState.has('/old/requested.txt')).toBe(false);
  });
  it('restores the actual Write target and body after an input hook rewrites them', () => {
    const ctx = createAttachmentContext('/workspace', 'session');
    const writeCall = call('w', 'Write', {
      file_path: 'original',
      content: 'model text',
    });
    const output = result('w', 'written', 'unused') as Extract<
      Message,
      { type: 'user' }
    >;
    output.toolUseResult = {
      filePath: '/workspace/actual',
      content: 'hook text',
    };
    restoreAttachmentTranscriptState(ctx, [writeCall, output]);
    expect(ctx.fileReadState.has('/workspace/original')).toBe(false);
    expect(ctx.fileReadState.get('/workspace/actual')).toMatchObject({
      content: 'hook text',
      contentNotInModelContext: true,
    });
  });
});
