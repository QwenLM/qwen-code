/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { LlmChat } from './llm-chat.js';
import { CompressionStatus } from './turn.js';
import { ChatCompressionService } from '../services/chatCompressionService.js';
import { SessionNotesService } from '../services/session-notes-service.js';
import type { ChatRecordingService } from '../services/chatRecordingService.js';
import { SESSION_CONTEXT_TOOL_NAMES } from '../services/session-notes-state.js';
import * as sideQuery from '../utils/sideQuery.js';

vi.mock('../telemetry/loggers.js');

describe('notes compaction commit boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  function fixture() {
    const revision = {
      version: 1 as const,
      revision: 'note',
      windowId: 'window',
      sourceLeafUuid: 'source',
      text: '# Goal\nKeep <analysis>literal notes</analysis>. Next: inspect the output.',
    };
    const state = {
      windowId: 'later-window',
      sourceLeafUuid: 'later-source',
      notes: revision,
      latestUser: {
        uuid: 'request',
        text: 'Preserve the exact user constraint.',
      },
    };
    const pre = vi.fn().mockResolvedValue({
      getAdditionalContext: () => 'Preserve the hook context.',
    });
    const post = vi.fn().mockResolvedValue(undefined);
    const recorder = {
      getSessionId: () => 'session',
      assertNotesWriterReady: vi.fn(),
      getSessionNotesState: () => structuredClone(state),
      refreshSessionNotesState: vi.fn(),
      recordChatCompressionStrict: vi.fn().mockResolvedValue('next-window'),
      recordChatCompression: vi.fn(),
    } as unknown as ChatRecordingService;
    const config = {
      getSessionId: () => 'session',
      getContentGeneratorConfig: () => ({
        model: 'test',
        contextWindowSize: 128000,
      }),
      getModel: () => 'test',
      getChatCompression: () => ({
        strategy: 'notes',
        maxRecentFilesToRetain: 0,
        maxRecentImagesToRetain: 0,
      }),
      getAutoCompactThreshold: () => undefined,
      getToolRegistry: () => ({
        getTool: vi.fn(),
        getFunctionDeclarations: () =>
          SESSION_CONTEXT_TOOL_NAMES.map((name) => ({ name })),
      }),
      getHookSystem: () => ({
        firePreCompactEvent: pre,
        firePostCompactEvent: post,
      }),
      getApprovalMode: () => 'default',
      getTargetDir: () => '/tmp/notes-compaction-unit',
      getFileReadCache: () => ({ clear: vi.fn() }),
      getDebugLogger: () => ({ warn: vi.fn(), debug: vi.fn() }),
    } as unknown as Config;
    const original: Content[] = [
      { role: 'user', parts: [{ text: 'past evidence '.repeat(5000) }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'reset',
              name: 'new_context',
              args: { notes_revision: revision.revision },
            },
          },
        ],
      },
    ];
    const chat = new LlmChat(config, {}, original, recorder);
    chat.setLastPromptTokenCount(22000, false);
    vi.spyOn(
      SessionNotesService.prototype,
      'getNotesForHandoff',
    ).mockResolvedValue({
      notes: revision,
      latestUser: state.latestUser,
    });
    return { chat, config, recorder, original, pre, post, revision };
  }

  it('uses literal notes with hooks and paired pending input, with no summarization call', async () => {
    const { chat, recorder, pre, post } = fixture();
    const summary = vi.spyOn(sideQuery, 'runSideQuery');
    const pending: Content = {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'reset',
            name: 'new_context',
            response: { status: 'pending' },
          },
        },
      ],
    };
    const included = vi.fn();
    const result = await chat.tryCompress('prompt', true, undefined, {
      notesRevision: 'note',
      pendingUserMessage: pending,
      onPendingMessageIncluded: included,
      trigger: 'auto',
    });
    expect(result).toMatchObject({
      strategy: 'notes',
      compressionStatus: CompressionStatus.COMPRESSED,
    });
    expect(summary).not.toHaveBeenCalled();
    expect(pre).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    const history = JSON.stringify(chat.getHistory());
    expect(history).toContain('<analysis>literal notes</analysis>');
    expect(history).toContain('Preserve the exact user constraint.');
    expect(history).toContain('Preserve the hook context.');
    expect(history).toContain(
      'written in window window, covers through source',
    );
    expect(history).toContain('These notes may predate later work.');
    expect(history).not.toContain('past evidence');
    expect(chat.getHistory().at(-1)).toEqual(pending);
    expect(history.match(/"functionResponse"/gu)).toHaveLength(1);
    expect(included).toHaveBeenCalledOnce();
    expect(
      SessionNotesService.prototype.getNotesForHandoff,
    ).toHaveBeenCalledWith(pending);
    const committed = vi.mocked(recorder.recordChatCompressionStrict).mock
      .calls[0][0];
    expect(committed.compressedHistory).toEqual(chat.getHistory());
    expect(recorder.recordChatCompression).not.toHaveBeenCalled();
  });

  it('does not install history or fire PostCompact until its exact checkpoint is durable', async () => {
    const { chat, recorder, original, post } = fixture();
    let accept!: (id: string) => void;
    vi.mocked(recorder.recordChatCompressionStrict).mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    const transition = chat.tryCompress('prompt', true);
    await vi.waitFor(() =>
      expect(recorder.recordChatCompressionStrict).toHaveBeenCalledOnce(),
    );
    expect(chat.getHistory()).toEqual(original);
    expect(post).not.toHaveBeenCalled();
    accept('committed-window');
    expect((await transition).strategy).toBe('notes');
    expect(chat.getHistory()).not.toEqual(original);
    expect(post).toHaveBeenCalledOnce();
  });

  it('preserves history on write failure and on a stale explicit revision', async () => {
    const { chat, recorder, original, post } = fixture();
    vi.mocked(recorder.recordChatCompressionStrict).mockRejectedValueOnce(
      new Error('writer lost'),
    );
    await expect(chat.tryCompress('prompt', true)).rejects.toThrow(
      'writer lost',
    );
    expect(chat.getHistory()).toEqual(original);
    expect(post).not.toHaveBeenCalled();
    await expect(
      chat.tryCompress('prompt', true, undefined, { notesRevision: 'old' }),
    ).rejects.toThrow('unavailable');
    expect(chat.getHistory()).toEqual(original);
  });

  it('uses the same durable boundary when missing notes or custom instructions select summary', async () => {
    const { chat, recorder } = fixture();
    const compression = vi
      .spyOn(ChatCompressionService.prototype, 'compress')
      .mockResolvedValue({
        newHistory: [{ role: 'user', parts: [{ text: 'summary' }] }],
        postCompactSummary: 'summary',
        info: {
          originalTokenCount: 22000,
          newTokenCount: 100,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      });
    const result = await chat.tryCompress('prompt', true, undefined, {
      customInstructions: 'Keep the error details.',
    });
    expect(compression.mock.calls[0][1]).toMatchObject({
      customInstructions: 'Keep the error details.',
      notesHandoff: undefined,
      deferPostCompactEvent: true,
    });
    expect(result.strategy).toBe('summary');
    expect(recorder.recordChatCompressionStrict).toHaveBeenCalledOnce();
  });
});
