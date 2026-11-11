/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { createAttachmentContext } from './get-attachments.js';
import { restoreAttachment } from './transcript-conversion.js';
import { restoreAttachmentTranscriptState } from './transcript-state.js';
import { DateChangeAttachment } from './models/system-attachments.js';
import { getLazyMcpReminderAttachments } from './generators/mcp-lazy-generator.js';
import type { Message } from '../protocol/transcript/message.js';
import { sha1 } from '../utils/paths.js';

describe('attachment context restoration', () => {
  const cwd = path.resolve('workspace');

  it.each([
    { type: 'file', content: 'text', want: 'text' },
    { type: 'already_read_file', content: 'excerpt', want: 'excerpt' },
    { type: 'edited_text_file', content: 'edited', want: 'edited' },
    { type: 'edited_image_file', content: 'changed', want: 'changed' },
    { type: 'image_file', content: 'image bytes', want: '' },
  ])(
    'restores $type file state independently of transcript replay',
    (fixture) => {
      const ctx = createAttachmentContext(cwd);
      const attachment = restoreAttachment({
        type: fixture.type,
        filename: 'a.txt',
        content: fixture.content,
        offset: 2,
      })!;

      attachment.restoreAttachmentContext(ctx);

      expect(ctx.readFileState.get(path.join(cwd, 'a.txt'))).toMatchObject({
        content: fixture.want,
        timestamp: 0,
        offset: 2,
        isPartialView: true,
      });
      expect(ctx.fileReadState.size).toBe(0);
    },
  );

  it('keeps an existing file baseline when restoring an already-read notice', () => {
    const ctx = createAttachmentContext(cwd);
    ctx.readFileState.set(path.join(cwd, 'a'), {
      content: 'current',
      timestamp: 20,
      offset: undefined,
      limit: undefined,
    });
    restoreAttachment({
      type: 'already_read_file',
      filename: 'a',
      content: 'old',
      mtime: 1,
    })!.restoreAttachmentContext(ctx, cwd);
    expect(ctx.readFileState.get(path.join(cwd, 'a'))).toEqual({
      content: 'current',
      timestamp: 20,
      offset: undefined,
      limit: undefined,
    });
  });

  it('restores scoped skill deltas and removes an empty initial listing', () => {
    const ctx = createAttachmentContext(cwd, 'worker');
    ctx.sentSkillNames.set('other', new Set(['keep']));
    for (const payload of [
      { names: ['old'], isInitial: true },
      { names: ['new'], isInitial: false },
    ]) {
      restoreAttachment({
        type: 'skill_listing',
        ...payload,
      })!.restoreAttachmentContext(ctx, cwd);
    }
    expect([...ctx.sentSkillNames.get('worker')!]).toEqual(['old', 'new']);
    restoreAttachment({
      type: 'skill_listing',
      names: [],
      isInitial: true,
    })!.restoreAttachmentContext(ctx, cwd);
    expect(ctx.sentSkillNames.has('worker')).toBe(false);
    expect([...ctx.sentSkillNames.get('other')!]).toEqual(['keep']);
  });

  it('defaults the skill scope to main and tolerates legacy missing names', () => {
    const ctx = createAttachmentContext(cwd);
    restoreAttachment({
      type: 'skill_listing',
      names: ['review'],
    })!.restoreAttachmentContext(ctx, cwd);
    restoreAttachment({ type: 'skill_listing' })!.restoreAttachmentContext(
      ctx,
      cwd,
    );
    expect([...ctx.sentSkillNames.get('main')!]).toEqual(['review']);
  });

  it.each(['plain data', 'instances'] as const)(
    'restores lazy MCP full/delta baselines from %s without repeating the catalog',
    (form) => {
      const ctx = createAttachmentContext(cwd, 'worker');
      const payloads = [
        {
          type: 'mcp_lazy_tools_delta',
          content: 'stale catalog',
          isInitial: true,
          addedNames: ['mcp__old__read'],
          removedNames: [],
        },
        {
          type: 'mcp_lazy_tools_delta',
          content: 'current catalog',
          isInitial: true,
          addedNames: ['mcp__repo__read', 'mcp__repo__write'],
          removedNames: [],
        },
        {
          type: 'mcp_lazy_tools_delta',
          content: 'current delta',
          isInitial: false,
          addedNames: ['mcp__repo__search'],
          removedNames: ['mcp__repo__write'],
        },
        // Old server-only reminders cannot overwrite a newer tool baseline.
        { type: 'critical_system_reminder', serverNames: ['old'] },
      ];
      const messages = payloads.map((payload) => ({
        type: 'attachment',
        attachment:
          form === 'plain data' ? payload : restoreAttachment(payload),
      })) as unknown as Message[];

      restoreAttachmentTranscriptState(ctx, messages);

      expect([...ctx.announcedLazyMcpTools].sort()).toEqual([
        'mcp__repo__read',
        'mcp__repo__search',
      ]);
      const external = {
        mcpClientManager: {
          getConnectedServerInstructions: () => [],
          getLazyMcpServerSnapshot: () => [
            {
              serverName: 'repo',
              toolNames: ['mcp__repo__read', 'mcp__repo__search'],
            },
          ],
        },
      };
      expect(getLazyMcpReminderAttachments(ctx, external)).toEqual([]);

      // Rewind to history containing only an old reminder: send one full catalog.
      restoreAttachmentTranscriptState(ctx, messages.slice(-1));
      expect(getLazyMcpReminderAttachments(ctx, external)[0].isInitial).toBe(
        true,
      );
      expect(getLazyMcpReminderAttachments(ctx, external)).toEqual([]);
    },
  );

  it('restores lazy MCP deltas through the attachment instance itself', () => {
    const ctx = createAttachmentContext(cwd);
    ctx.announcedLazyMcpTools.add('mcp__stale__read');
    restoreAttachment({
      type: 'mcp_lazy_tools_delta',
      isInitial: true,
      addedNames: ['mcp__repo__read', null],
      removedNames: null,
    })!.restoreAttachmentContext(ctx);
    restoreAttachment({
      type: 'mcp_lazy_tools_delta',
      addedNames: ['mcp__repo__search', 42],
      removedNames: ['mcp__repo__read'],
    })!.restoreAttachmentContext(ctx);
    expect([...ctx.announcedLazyMcpTools]).toEqual(['mcp__repo__search']);
  });

  it('inherits a no-op for attachments without restorable context', () => {
    const ctx = createAttachmentContext(cwd);
    restoreAttachment({
      type: 'current_session_memory',
      snapshot: 'summary',
    })!.restoreAttachmentContext(ctx, cwd);
    expect(ctx.readFileState.size).toBe(0);
    expect(ctx.sentSkillNames.size).toBe(0);
  });

  it.each(['plain data', 'instances'] as const)(
    'replays %s with historical cwd and preserves tool-result ordering',
    (form) => {
      const ctx = createAttachmentContext(cwd);
      const historicalCwd = path.join(cwd, 'previous');
      const filename = path.join(historicalCwd, 'a');
      const data = {
        type: 'file',
        filename: 'a',
        content: 'attachment',
        mtime: 1,
      };
      const attachment =
        form === 'plain data' ? data : restoreAttachment(data)!;
      const messages = [
        { type: 'attachment', cwd: historicalCwd, attachment },
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'write',
                name: 'Write',
                input: { file_path: filename, content: 'written' },
              },
            ],
          },
        },
        {
          type: 'user',
          timestamp: '2026-10-16T00:00:00Z',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'write', content: 'ok' },
            ],
          },
        },
      ] as unknown as Message[];

      restoreAttachmentTranscriptState(ctx, messages);

      expect(ctx.readFileState.get(filename)?.content).toBe('attachment');
      expect(ctx.fileReadState.get(filename)?.content).toBe('written');
      expect(ctx.readFileState.has(path.join(cwd, 'a'))).toBe(false);
    },
  );

  it('keeps legacy validation and ordered deltas when replaying plain data', () => {
    const ctx = createAttachmentContext(cwd);
    const payloads = [
      {
        type: 'mcp_instructions_delta',
        addedNames: ['repo', 42, 'docs'],
        removedNames: null,
      },
      { type: 'mcp_instructions_delta', removedNames: ['docs'] },
      { type: 'agent_listing_delta', addedTypes: ['old'] },
      {
        type: 'agent_listing_delta',
        isInitial: true,
        addedTypes: ['current', null],
      },
      { type: 'critical_system_reminder', serverNames: ['old'] },
      { type: 'critical_system_reminder', serverNames: [123, 'repo'] },
      { type: 'critical_system_reminder' },
      {
        type: 'relevant_memories',
        files: [null, 42, {}, { filePath: 3 }, { filePath: 'AGENTS.md' }],
      },
      { type: 'date_change', newDate: '2026-10-16' },
      { type: 'date_change', newDate: 42 },
      { type: 'team_context', agents: [] },
      { type: 'team_context', agents: null },
      { type: 'hook_output', hookEventName: 'SessionStart', output: 'ready' },
      { type: 'hook_success', hookEvent: 'session_start', content: 'ready' },
      { type: 'hook_success', hookEvent: 'PostToolUse', content: 'ignored' },
      { type: 'hook_success', hookEvent: 'SessionStart', content: '  ' },
      { type: 'unknown_plugin_attachment', newDate: 'ignored' },
      null,
    ];
    restoreAttachmentTranscriptState(
      ctx,
      payloads.map((attachment) => ({
        type: 'attachment',
        attachment,
      })) as unknown as Message[],
    );
    expect([...ctx.announcedMcpInstructionServers]).toEqual(['repo']);
    expect([...ctx.announcedAgentTypes]).toEqual(['current']);
    expect([...ctx.announcedLazyMcpTools]).toEqual([]);
    expect([...ctx.loadedNestedMemoryPaths]).toEqual(['AGENTS.md']);
    expect(ctx.lastDateSeen).toBe('2026-10-16');
    expect(ctx.lastSubagentHash).toBe(sha1('[]'));
    expect([...ctx.seenSessionStartHookOutputs]).toEqual([sha1('ready')]);
  });

  it('resets replayed state while preserving the existing attachment cache and pending hook queue', () => {
    const ctx = createAttachmentContext(cwd);
    const file = path.join(cwd, 'cached');
    const state = {
      content: 'cached',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    };
    ctx.fileReadState.set(file, state);
    ctx.readFileState.set(file, state);
    ctx.sentSkillNames.set('main', new Set(['old']));
    ctx.sentSkillListingFingerprints = new Map([['main', 'keep']]);
    ctx.announcedMcpInstructionServers.add('old');
    ctx.announcedAgentTypes.add('old');
    ctx.announcedAgentDescriptions?.set('old', 'description');
    ctx.announcedLazyMcpTools.add('mcp__old__read');
    ctx.loadedNestedMemoryPaths.add('old');
    ctx.seenSessionStartHookOutputs.add('old');
    ctx.lastDateSeen = 'old';
    ctx.lastSubagentHash = 'old';
    ctx.postCompactCandidates = [];
    const pending = ctx.pendingHookOutputs;

    restoreAttachmentTranscriptState(ctx, []);

    expect(ctx.fileReadState.size).toBe(0);
    expect(ctx.readFileState.get(file)?.content).toBe('cached');
    expect(ctx.sentSkillNames.size).toBe(0);
    expect(ctx.sentSkillListingFingerprints.get('main')).toBe('keep');
    expect(ctx.announcedMcpInstructionServers.size).toBe(0);
    expect(ctx.announcedAgentTypes.size).toBe(0);
    expect(ctx.announcedAgentDescriptions?.size).toBe(0);
    expect(ctx.announcedLazyMcpTools.size).toBe(0);
    expect(ctx.loadedNestedMemoryPaths.size).toBe(0);
    expect(ctx.seenSessionStartHookOutputs.size).toBe(0);
    expect(ctx.lastDateSeen).toBeUndefined();
    expect(ctx.lastSubagentHash).toBeUndefined();
    expect(ctx.postCompactCandidates).toBeNull();
    expect(ctx.pendingHookOutputs).toBe(pending);
  });

  it('replays the behavior of an existing attachment instance', () => {
    class CustomDateAttachment extends DateChangeAttachment {
      override restoreAttachmentContext(
        ctx: ReturnType<typeof createAttachmentContext>,
      ): void {
        ctx.lastDateSeen = `restored:${this.newDate}`;
      }
    }
    const attachment = new CustomDateAttachment({
      type: 'date_change',
      newDate: '2026-10-16',
    });
    const ctx = createAttachmentContext(cwd);
    restoreAttachmentTranscriptState(ctx, [
      { type: 'attachment', attachment },
    ] as unknown as Message[]);
    expect(ctx.lastDateSeen).toBe('restored:2026-10-16');
  });

  it('does not persist behavior or let historical data replace it', () => {
    const attachment = restoreAttachment({
      type: 'date_change',
      newDate: '2026-10-16',
      restoreAttachmentContext: 'untrusted persisted field',
    })!;
    const ctx = createAttachmentContext(cwd);
    attachment.restoreAttachmentContext(ctx, cwd);
    expect(ctx.lastDateSeen).toBe('2026-10-16');
    expect(attachment.toTranscript()).toEqual({
      type: 'date_change',
      newDate: '2026-10-16',
    });
    expect(JSON.parse(JSON.stringify(attachment))).toEqual({
      type: 'date_change',
      newDate: '2026-10-16',
    });
  });
});
