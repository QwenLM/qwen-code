/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { applyPostCompact } from './apply-post-compact.js';
import { createAttachmentContext } from '../attachments/get-attachments.js';
import { restoreAttachmentTranscriptState } from '../attachments/transcript-state.js';
import { drainPostCompactRestoreAttachments } from '../attachments/generators/restore-generators.js';
import { createAttachmentMessage } from '../attachments/factory.js';
import { isFullFileRead } from '../utils/fileStateCache.js';
import type { Config } from '../config/config.js';
import type { Message } from '../protocol/transcript/message.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const config = {
  getApprovedPlanPath: () => null,
  isPlanMode: () => false,
} as unknown as Config;
function history(
  content = 'first\nsecond',
  offset = 1,
  limit?: number,
): Message[] {
  return [
    {
      type: 'assistant',
      uuid: 'call',
      timestamp,
      cwd: '/old',
      message: {
        blocks: [
          {
            type: 'tool_use',
            id: 'r',
            name: 'Read',
            input: { file_path: 'file.txt', offset, limit },
          },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'result',
      timestamp,
      cwd: '/old',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'r',
            content: content
              .split('\n')
              .map((line, i) => `${offset + i}\t${line}`)
              .join('\n'),
          },
        ],
      },
      toolUseResult: { file: { filePath: 'file.txt', content } },
    },
  ] as Message[];
}
const summary = {
  type: 'user',
  uuid: 'summary',
  timestamp,
  message: { role: 'user', content: [{ type: 'text', text: 'Summary' }] },
} as Message;

describe('post-compact read baselines', () => {
  it.each([false, true])(
    'keeps malformed multi-result replacement metadata partial after compact/resume (deferred=%s)',
    async (deferred) => {
      const prior = history('visible');
      const assistant = prior[0] as Extract<Message, { type: 'assistant' }>;
      const result = prior[1] as Extract<Message, { type: 'user' }>;
      assistant.message = {
        ...assistant.message,
        content: ['a', 'b'].map((id) => ({
          type: 'tool_use',
          id,
          name: 'Read',
          input: { file_path: `${id}.txt` },
        })),
      };
      result.message.content = ['a', 'b'].map((id) => ({
        type: 'tool_result',
        tool_use_id: id,
        content: '1\tvisible',
      }));
      result.toolUseResult = ['a', 'b'].map((id) => ({
        file: { filePath: `${id}.txt`, content: 'visible' },
      }));
      result.readOutputReplacement = '/unrelated.txt';
      const ctx = createAttachmentContext('/old');
      let updated = await applyPostCompact(
        prior,
        deferred ? [summary, prior[0]] : [summary],
        {
          config,
          attachmentCtx: ctx,
          replaceMessages: vi.fn(),
          pushAttachments: vi.fn(),
          transcriptParentUuid: () => null,
          setTranscriptParentUuid: vi.fn(),
        },
      );
      if (deferred) {
        expect(ctx.fileReadState.size).toBe(0);
        updated = [
          ...updated,
          ...drainPostCompactRestoreAttachments(ctx).map(
            createAttachmentMessage,
          ),
        ] as Message[];
      }
      const resumed = createAttachmentContext('/new');
      restoreAttachmentTranscriptState(
        resumed,
        JSON.parse(JSON.stringify(updated)) as Message[],
      );
      for (const owner of [ctx, resumed]) {
        expect(owner.fileReadState.has('/unrelated.txt')).toBe(false);
        for (const id of ['a', 'b']) {
          expect(owner.fileReadState.get(`/old/${id}.txt`)).toMatchObject({
            isPartialView: true,
            contentNotInModelContext: true,
          });
        }
      }
    },
  );

  it.each([false, true])(
    'keeps replaced Read partial through compact and resume (deferred=%s)',
    async (deferred) => {
      const prior = history('visible');
      const result = prior[1] as Extract<Message, { type: 'user' }>;
      result.toolUseResult = '1\tvisible';
      result.readOutputReplacement = '/old/actual.txt';
      const ctx = createAttachmentContext('/old');
      let updated = await applyPostCompact(
        prior,
        deferred ? [summary, prior[0]] : [summary],
        {
          config,
          attachmentCtx: ctx,
          replaceMessages: vi.fn(),
          pushAttachments: vi.fn(),
          transcriptParentUuid: () => null,
          setTranscriptParentUuid: vi.fn(),
        },
      );
      if (deferred) {
        expect(ctx.fileReadState.size).toBe(0);
        updated = [
          ...updated,
          ...drainPostCompactRestoreAttachments(ctx).map(
            createAttachmentMessage,
          ),
        ] as Message[];
      }
      expect(ctx.fileReadState.has('/old/file.txt')).toBe(false);
      expect(ctx.fileReadState.get('/old/actual.txt')).toMatchObject({
        isPartialView: true,
        contentNotInModelContext: true,
      });
      const resumed = createAttachmentContext('/new');
      restoreAttachmentTranscriptState(
        resumed,
        JSON.parse(JSON.stringify(updated)) as Message[],
      );
      expect(resumed.fileReadState.get('/old/actual.txt')).toEqual(
        ctx.fileReadState.get('/old/actual.txt'),
      );
      expect(
        isFullFileRead(resumed.fileReadState.get('/old/actual.txt')!),
      ).toBe(false);
    },
  );

  it.each([false, true])(
    'restores the executed hook range (deferred=%s)',
    async (deferred) => {
      const prior = history('first');
      (prior[1] as Extract<Message, { type: 'user' }>).toolUseResult = {
        file: {
          filePath: 'file.txt',
          content: 'first',
          startLine: 1,
          numLines: 1,
          totalLines: 2,
        },
      };
      const ctx = createAttachmentContext('/old');
      const next = deferred ? [summary, history()[0]] : [summary];
      let updated = await applyPostCompact(prior, next, {
        config,
        attachmentCtx: ctx,
        replaceMessages: vi.fn(),
        pushAttachments: vi.fn(),
        transcriptParentUuid: () => null,
        setTranscriptParentUuid: vi.fn(),
      });
      if (deferred) {
        expect(ctx.fileReadState.size).toBe(0);
        updated = [
          ...updated,
          ...drainPostCompactRestoreAttachments(ctx).map(
            createAttachmentMessage,
          ),
        ] as Message[];
      }
      expect(ctx.fileReadState.get('/old/file.txt')).toMatchObject({
        offset: 1,
        limit: 1,
      });
      expect(isFullFileRead(ctx.fileReadState.get('/old/file.txt')!)).toBe(
        false,
      );
      const resumed = createAttachmentContext('/old');
      restoreAttachmentTranscriptState(resumed, updated);
      expect(resumed.fileReadState.get('/old/file.txt')).toEqual(
        ctx.fileReadState.get('/old/file.txt'),
      );
    },
  );

  it.each([false, true])(
    'registers only after actual injection, and survives resume (deferred=%s)',
    async (deferred) => {
      const ctx = createAttachmentContext('/new', 'session');
      const prior = history();
      restoreAttachmentTranscriptState(ctx, prior);
      const next = deferred ? [summary, history()[0]] : [summary];
      const updated = await applyPostCompact(prior, next, {
        config,
        attachmentCtx: ctx,
        replaceMessages: vi.fn(),
        pushAttachments: vi.fn(),
        transcriptParentUuid: () => null,
        setTranscriptParentUuid: vi.fn(),
      });
      let retained = [...updated];
      if (deferred) {
        expect(ctx.fileReadState.size).toBe(0);
        const drained = drainPostCompactRestoreAttachments(ctx);
        expect(drained).toHaveLength(1);
        retained = [
          ...retained,
          ...drained.map(createAttachmentMessage),
        ] as Message[];
        expect(drainPostCompactRestoreAttachments(ctx)).toEqual([]);
      }
      const state = ctx.fileReadState.get('/old/file.txt')!;
      expect(state.content).toBe('first\nsecond');
      expect(state.timestamp).toBe(Date.parse(timestamp));
      expect(isFullFileRead(state)).toBe(true);
      const resumed = createAttachmentContext('/another', 'resumed');
      restoreAttachmentTranscriptState(resumed, retained);
      expect(resumed.fileReadState.get('/old/file.txt')).toEqual(state);
    },
  );

  it.each(['range', 'truncated'] as const)(
    'never upgrades %s contents to a full read',
    async (kind) => {
      const ctx = createAttachmentContext('/old', 'session');
      const prior =
        kind === 'range' ? history('second', 2, 1) : history('x'.repeat(60000));
      const updated = await applyPostCompact(prior, [summary], {
        config,
        attachmentCtx: ctx,
        replaceMessages: vi.fn(),
        pushAttachments: vi.fn(),
        transcriptParentUuid: () => null,
        setTranscriptParentUuid: vi.fn(),
      });
      expect(ctx.fileReadState.has('/old/file.txt')).toBe(true);
      expect(isFullFileRead(ctx.fileReadState.get('/old/file.txt')!)).toBe(
        false,
      );
      const resumed = createAttachmentContext('/old');
      restoreAttachmentTranscriptState(resumed, updated);
      expect(isFullFileRead(resumed.fileReadState.get('/old/file.txt')!)).toBe(
        false,
      );
    },
  );
});
