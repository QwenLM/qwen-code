/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  collectPreservedReadFilePathsFromHistory,
  collectRecentReadFileCandidates,
  finalizePostCompact,
} from './post-compact-finalize.js';
import { READ_FILE_TOOL_NAME } from '../tools/tool-names.js';
import type {
  AssistantMessage,
  Message,
  UserMessage,
  ToolResultBlockParam,
} from '../protocol/transcript/message.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import { createAttachmentContext } from '../attachments/get-attachments.js';
import type { Config } from '../config/config.js';
import { emptySnapshotSource } from '../test-utils/listed-model.js';

// ---------------------------------------------------------------------------
// CTX64: Post-compact file restoration candidate collection
//
// Applied synchronously at compaction time by post-compact-finalize.ts. The
// helpers consume runtime `Message[]` (Anthropic-shaped) — assistant
// tool_use blocks paired with user tool_result blocks, matched by id.
// ---------------------------------------------------------------------------

let uuidCounter = 0;
function nextUuid(): string {
  uuidCounter += 1;
  return `uuid-${uuidCounter}`;
}

function assistantToolUse(
  id: string,
  input: Record<string, unknown>,
  toolName: string = READ_FILE_TOOL_NAME,
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: nextUuid(),
    timestamp: '2026-04-20T00:00:00.000Z',
    message: {
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      id: 'msg_test',

      model: 'claude-test',
      stop_reason: 'tool_use',

      usage: cloneUsage(),
      content: [{ type: 'tool_use', id, name: toolName, input }],
    },
  };
}

function userToolResult(
  toolUseId: string,
  content: ToolResultBlockParam['content'],
): UserMessage {
  return {
    type: 'user',
    uuid: nextUuid(),
    timestamp: '2026-04-20T00:00:00.000Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          is_error: false,
        },
      ],
    },
  };
}

function userText(text: string): UserMessage {
  return {
    type: 'user',
    uuid: nextUuid(),
    timestamp: '2026-04-20T00:00:00.000Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  };
}

function assistantText(text: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid: nextUuid(),
    timestamp: '2026-04-20T00:00:00.000Z',
    message: {
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      id: 'msg_test',

      model: 'claude-test',
      stop_reason: 'end_turn',

      usage: cloneUsage(),
      content: [{ type: 'text', text }],
    },
  };
}

describe('finalizePostCompact attachment state', () => {
  it.each(['available', 'no-tool', 'empty'] as const)(
    'uses interactive discovery after resetting only the compacted scope: %s',
    async (state) => {
      const ctx = createAttachmentContext('/tmp/proj');
      ctx.sentSkillNames.set('main', new Set(['example:inspect']));
      ctx.sentSkillNames.set('child', new Set(['child-skill']));
      const skill = {
        name: 'example:inspect',
        description: 'x'.repeat(400),
        source: 'plugin',
        location: '/tmp/skills/inspect',
        body: '',
      };
      const config = {
        isWorkflowsEnabled: () => true,
        getModel: () => 'claude-sonnet-4-6',
        getEffectiveContextWindow: () => 200_000,
        getApprovedPlanPath: () => null,
        isPlanMode: () => false,
        getSkillManager: () => ({
          getActiveSkillsWithTimestamp: () => [],
          getModelVisibleSkills: () => (state === 'empty' ? [] : [skill]),
          isAdminEnabled: () => true,
          getSkillVisibilityOverride: () => 'on',
          getUsageScore: () => 0,
        }),
        getToolRegistry: () => ({ hasToolEnabled: () => state !== 'no-tool' }),
        getModelProviderManager: emptySnapshotSource.getModelProviderManager,
        getSkillListingMaxDescChars: () => 400,
        getSkillListingBudgetFraction: () => undefined,
        getSkillVisibilityOverrides: () => ({ [skill.name]: 'name-only' }),
      } as unknown as Config;
      const result = await finalizePostCompact({
        workingHistory: [userText('before compact')],
        newHistory: [userText('compacted summary')],
        targetDir: '/tmp/proj',
        ctx,
        config,
      });
      const listings = result.attachmentMessages.filter(
        (message) => message.attachment.type === 'skill_listing',
      );
      expect(listings).toEqual(
        state === 'available'
          ? [
              expect.objectContaining({
                attachment: expect.objectContaining({
                  content: `- ${skill.name}: ${skill.description}`,
                  names: [skill.name],
                  isInitial: true,
                }),
              }),
            ]
          : [],
      );
      expect([...(ctx.sentSkillNames.get('main') ?? [])]).toEqual(
        state === 'available' ? [skill.name] : [],
      );
      expect([...ctx.sentSkillNames.get('child')!]).toEqual(['child-skill']);
    },
  );

  it('re-emits the complete model-visible skill listing after compaction', async () => {
    const ctx = createAttachmentContext('/tmp/proj', 'session');
    ctx.sentSkillNames.set('session', new Set(['inspect']));
    const skill = {
      name: 'inspect',
      description: 'Inspect a repository',
      location: '/tmp/skills/inspect',
      body: 'Inspect carefully.',
    };
    const config = {
      isWorkflowsEnabled: () => false,
      getModel: () => 'test-model',
      getApprovedPlanPath: () => null,
      isPlanMode: () => false,
      getToolRegistry: () => ({ hasToolEnabled: () => true }),
      getSkillManager: () => ({
        getActiveSkillsWithTimestamp: () => [],
        getModelVisibleSkills: () => [skill],
        getRenderedBody: () => skill.body,
        isAdminEnabled: () => true,
        getUsageScore: () => 0,
        getSkillVisibilityOverride: () => undefined,
      }),
      getModelProviderManager: emptySnapshotSource.getModelProviderManager,
      getSkillListingMaxDescChars: () => 160,
      getSkillListingBudgetFraction: () => 0.05,
      getSkillVisibilityOverrides: () => ({}),
    } as unknown as Config;

    const result = await finalizePostCompact({
      workingHistory: [userText('before compact')],
      newHistory: [userText('compacted summary')],
      targetDir: '/tmp/proj',
      ctx,
      config,
    });

    expect(
      result.attachmentMessages.find(
        (message) => message.attachment.type === 'skill_listing',
      )?.attachment,
    ).toMatchObject({
      type: 'skill_listing',
      names: ['inspect'],
      isInitial: true,
    });
  });
});

describe('collectRecentReadFileCandidates [CTX64]', () => {
  it('returns empty array for empty history', () => {
    const result = collectRecentReadFileCandidates([], '/tmp/proj', new Set());
    expect(result).toEqual([]);
  });

  it('returns empty when no read_file tool_use exists', () => {
    const history: Message[] = [userText('hello'), assistantText('hi there')];
    expect(
      collectRecentReadFileCandidates(history, '/tmp/proj', new Set()),
    ).toEqual([]);
  });

  it('returns a single candidate for one matched tool_use + tool_result pair', () => {
    const history: Message[] = [
      assistantToolUse('r1', { file_path: 'src/alpha.ts' }),
      userToolResult('r1', 'alpha content'),
    ];
    const result = collectRecentReadFileCandidates(
      history,
      '/tmp/proj',
      new Set(),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      filePath: '/tmp/proj/src/alpha.ts',
      content: 'alpha content',
      truncated: false,
    });
  });

  it('resolves relative file_path against targetDir', () => {
    const history: Message[] = [
      assistantToolUse('r1', { file_path: './src/rel.ts' }),
      userToolResult('r1', 'rel content'),
    ];
    const [candidate] = collectRecentReadFileCandidates(
      history,
      '/tmp/proj',
      new Set(),
    );
    expect(candidate.filePath).toBe('/tmp/proj/src/rel.ts');
  });

  it('accepts input.path as an alias for file_path', () => {
    const history: Message[] = [
      assistantToolUse('r1', { path: 'src/alias.ts' }),
      userToolResult('r1', 'alias content'),
    ];
    const [candidate] = collectRecentReadFileCandidates(
      history,
      '/tmp/proj',
      new Set(),
    );
    expect(candidate.filePath).toBe('/tmp/proj/src/alias.ts');
  });

  it('ignores read_file calls with no path input', () => {
    const history: Message[] = [
      assistantToolUse('r1', {}),
      userToolResult('r1', 'should not appear'),
    ];
    expect(
      collectRecentReadFileCandidates(history, '/tmp/proj', new Set()),
    ).toEqual([]);
  });

  it('sorts candidates most-recent-first across multiple files', () => {
    const history: Message[] = [
      assistantToolUse('r1', { file_path: 'src/a.ts' }),
      userToolResult('r1', 'A'),
      assistantToolUse('r2', { file_path: 'src/b.ts' }),
      userToolResult('r2', 'B'),
      assistantToolUse('r3', { file_path: 'src/c.ts' }),
      userToolResult('r3', 'C'),
    ];
    const result = collectRecentReadFileCandidates(
      history,
      '/tmp/proj',
      new Set(),
    );
    expect(result.map((c) => c.filePath)).toEqual([
      '/tmp/proj/src/c.ts',
      '/tmp/proj/src/b.ts',
      '/tmp/proj/src/a.ts',
    ]);
  });

  it('deduplicates by path, keeping the most recent read', () => {
    const history: Message[] = [
      assistantToolUse('r1', { file_path: 'src/dup.ts' }),
      userToolResult('r1', 'OLD'),
      assistantToolUse('r2', { file_path: 'src/other.ts' }),
      userToolResult('r2', 'other'),
      assistantToolUse('r3', { file_path: 'src/dup.ts' }),
      userToolResult('r3', 'NEW'),
    ];
    const result = collectRecentReadFileCandidates(
      history,
      '/tmp/proj',
      new Set(),
    );
    expect(result.map((c) => c.filePath)).toEqual([
      '/tmp/proj/src/dup.ts',
      '/tmp/proj/src/other.ts',
    ]);
    expect(result[0].content).toBe('NEW');
  });

  it('caps returned candidates at POST_COMPACT_MAX_FILES_TO_RESTORE (5)', () => {
    const history: Message[] = [];
    for (let i = 0; i < 8; i++) {
      history.push(assistantToolUse(`r${i}`, { file_path: `src/f${i}.ts` }));
      history.push(userToolResult(`r${i}`, `content-${i}`));
    }
    const result = collectRecentReadFileCandidates(
      history,
      '/tmp/proj',
      new Set(),
    );
    expect(result).toHaveLength(5);
    expect(result.map((c) => c.filePath)).toEqual([
      '/tmp/proj/src/f7.ts',
      '/tmp/proj/src/f6.ts',
      '/tmp/proj/src/f5.ts',
      '/tmp/proj/src/f4.ts',
      '/tmp/proj/src/f3.ts',
    ]);
  });

  it('skips candidates already in skippedPaths (already preserved in the new tail)', () => {
    const history: Message[] = [
      assistantToolUse('r1', { file_path: 'src/a.ts' }),
      userToolResult('r1', 'A'),
      assistantToolUse('r2', { file_path: 'src/b.ts' }),
      userToolResult('r2', 'B'),
    ];
    const skipped = new Set(['/tmp/proj/src/a.ts']);
    const result = collectRecentReadFileCandidates(
      history,
      '/tmp/proj',
      skipped,
    );
    expect(result.map((c) => c.filePath)).toEqual(['/tmp/proj/src/b.ts']);
  });

  it('truncates file content that exceeds the per-file token budget', () => {
    const hugeContent = 'x'.repeat(100_000);
    const history: Message[] = [
      assistantToolUse('r1', { file_path: 'src/big.ts' }),
      userToolResult('r1', hugeContent),
    ];
    const [candidate] = collectRecentReadFileCandidates(
      history,
      '/tmp/proj',
      new Set(),
    );
    expect(candidate.truncated).toBe(true);
    expect(
      candidate.content.endsWith('[Truncated for post-compact restore]'),
    ).toBe(true);
    expect(candidate.content.length).toBeLessThan(hugeContent.length);
  });

  it('matches response to call by tool_use_id (interleaved pairs)', () => {
    const history: Message[] = [
      assistantToolUse('r1', { file_path: 'src/a.ts' }),
      assistantToolUse('r2', { file_path: 'src/b.ts' }),
      userToolResult('r2', 'B'),
      userToolResult('r1', 'A'),
    ];
    const result = collectRecentReadFileCandidates(
      history,
      '/tmp/proj',
      new Set(),
    );
    const byPath = new Map(result.map((c) => [c.filePath, c.content]));
    expect(byPath.get('/tmp/proj/src/a.ts')).toBe('A');
    expect(byPath.get('/tmp/proj/src/b.ts')).toBe('B');
  });

  it('falls back to FIFO matching when blocks lack tool_use_id', () => {
    const history: Message[] = [
      assistantToolUse('', { file_path: 'src/a.ts' }),
      userToolResult('', 'A'),
      assistantToolUse('', { file_path: 'src/b.ts' }),
      userToolResult('', 'B'),
    ];
    const result = collectRecentReadFileCandidates(
      history,
      '/tmp/proj',
      new Set(),
    );
    const byPath = new Map(result.map((c) => [c.filePath, c.content]));
    expect(byPath.get('/tmp/proj/src/a.ts')).toBe('A');
    expect(byPath.get('/tmp/proj/src/b.ts')).toBe('B');
  });

  it('ignores non-read_file tool_use blocks', () => {
    const history: Message[] = [
      assistantToolUse('r1', { file_path: 'src/a.ts' }, 'some_other_tool'),
      userToolResult('r1', 'ignored'),
    ];
    expect(
      collectRecentReadFileCandidates(history, '/tmp/proj', new Set()),
    ).toEqual([]);
  });

  it('joins text parts when tool_result.content is an array', () => {
    const history: Message[] = [
      assistantToolUse('r1', { file_path: 'src/a.ts' }),
      userToolResult('r1', [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ]),
    ];
    const [candidate] = collectRecentReadFileCandidates(
      history,
      '/tmp/proj',
      new Set(),
    );
    expect(candidate.content).toBe('line one\nline two');
  });

  it('skips image parts within tool_result content arrays', () => {
    const history: Message[] = [
      assistantToolUse('r1', { file_path: 'src/a.ts' }),
      userToolResult('r1', [
        { type: 'text', text: 'visible' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'xxx' },
        },
      ]),
    ];
    const [candidate] = collectRecentReadFileCandidates(
      history,
      '/tmp/proj',
      new Set(),
    );
    expect(candidate.content).toBe('visible');
  });
});

describe('collectPreservedReadFilePathsFromHistory [CTX64]', () => {
  it('returns an empty set for empty history', () => {
    expect(collectPreservedReadFilePathsFromHistory([], '/tmp/proj')).toEqual(
      new Set(),
    );
  });

  it('collects read_file paths from tool_use + tool_result pairs', () => {
    const history: Message[] = [
      assistantToolUse('r1', { file_path: 'src/preserved.ts' }),
      userToolResult('r1', 'content'),
    ];
    const result = collectPreservedReadFilePathsFromHistory(
      history,
      '/tmp/proj',
    );
    expect(result).toEqual(new Set(['/tmp/proj/src/preserved.ts']));
  });

  it('collects paths from <restored_files> text lines ("Path: xxx")', () => {
    const history: Message[] = [
      userText(
        '<restored_files>\nPath: /tmp/proj/src/from-restored.ts\nContent: snip\n</restored_files>',
      ),
    ];
    const result = collectPreservedReadFilePathsFromHistory(
      history,
      '/tmp/proj',
    );
    expect(result).toEqual(new Set(['/tmp/proj/src/from-restored.ts']));
  });

  it('unions paths from both tool pairs and restored text markers', () => {
    const history: Message[] = [
      assistantToolUse('r1', { file_path: 'src/from-tool.ts' }),
      userToolResult('r1', 'x'),
      userText('Path: /tmp/proj/src/from-text.ts'),
    ];
    const result = collectPreservedReadFilePathsFromHistory(
      history,
      '/tmp/proj',
    );
    expect(result).toEqual(
      new Set(['/tmp/proj/src/from-tool.ts', '/tmp/proj/src/from-text.ts']),
    );
  });

  it('ignores malformed content (missing message, non-record entries)', () => {
    const history = [
      null,
      {},
      { type: 'user' },
      { type: 'user', message: null },
      { type: 'user', message: { role: 'user', content: null } },
    ];
    expect(
      collectPreservedReadFilePathsFromHistory(
        history as unknown as Message[],
        '/tmp/proj',
      ),
    ).toEqual(new Set());
  });
});
