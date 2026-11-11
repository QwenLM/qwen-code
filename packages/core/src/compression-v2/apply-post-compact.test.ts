/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SkillListingAttachment } from '../attachments/models/skill-attachments.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { AttachmentToolUseContext } from '../attachments/types.js';
import type { Message } from '../protocol/transcript/message.js';
import { createUserMessage } from '../protocol/transcript/conversions.js';
import { createAttachmentMessage } from '../attachments/factory.js';
import {
  HookOutputAttachment,
  HookSuccessAttachment,
} from '../attachments/models/hook-attachments.js';
import { HookEventName } from '../hooks/types.js';
import { createCompactBoundaryMessage } from './boundary.js';
import { applyPostCompact } from './apply-post-compact.js';
import { finalizePostCompact } from './post-compact-finalize.js';

vi.mock('./post-compact-finalize.js', () => ({
  finalizePostCompact: vi.fn(async () => ({
    attachmentMessages: [],
    hasPendingToolTail: false,
  })),
}));

const mockedFinalizePostCompact = vi.mocked(finalizePostCompact);

describe('applyPostCompact', () => {
  beforeEach(() => {
    mockedFinalizePostCompact.mockResolvedValue({
      attachmentMessages: [],
      hasPendingToolTail: false,
    });
  });

  it('persists compact boundary against the pre-compact transcript parent', async () => {
    const boundary = createCompactBoundaryMessage({
      trigger: 'manual',
      preTokens: 100,
      postTokens: 20,
      messagesSummarized: 2,
    });
    const summary = createUserMessage('Summary: compacted history', {
      isCompactSummary: true,
    });
    const newHistory: Message[] = [boundary, summary];
    let parentUuid: string | null = 'previous-assistant';
    const recordMessages = vi.fn(async () => summary.uuid);

    await applyPostCompact([], newHistory, {
      replaceMessages: vi.fn(),
      pushAttachments: vi.fn(),
      transcriptParentUuid: () => parentUuid,
      setTranscriptParentUuid: (uuid) => {
        parentUuid = uuid;
      },
      transcriptWriter: {
        recordMessages,
      } as never,
      attachmentCtx: { cwd: '/workspace/project' } as AttachmentToolUseContext,
      config: {} as Config,
    });

    expect(recordMessages).toHaveBeenCalledWith(
      [boundary, summary],
      'previous-assistant',
    );
    expect(parentUuid).toBe(summary.uuid);
  });

  it.each([
    'empty',
    'recovery',
    'deferred',
    'finalize-failure',
    'write-failure',
  ])(
    'includes only this compaction\'s SessionStart outputs in the boundary write when recovery is %s',
    async (state) => {
      const boundary = createCompactBoundaryMessage({
        trigger: 'manual',
        preTokens: 100,
        postTokens: 20,
        messagesSummarized: 2,
      });
      const summary = createUserMessage('Summary: compacted history', {
        isCompactSummary: true,
      });
      const retainedHook = createAttachmentMessage(
        new HookOutputAttachment({
          type: 'hook_output',
          hookEventName: HookEventName.SessionStart,
          output: 'previous hook context',
        }),
      );
      const context = createAttachmentMessage(
        new HookOutputAttachment({
          type: 'hook_output',
          hookEventName: HookEventName.SessionStart,
          output: 'new compact hook context',
        }),
      );
      const stdout = createAttachmentMessage(
        new HookSuccessAttachment({
          type: 'hook_success',
          hookEvent: HookEventName.SessionStart,
          hookName: 'SessionStart:compact',
          toolUseID: '',
          content: 'new compact hook stdout',
        }),
      );
      const recovery = createAttachmentMessage(
        new SkillListingAttachment({
          type: 'skill_listing',
          content: '- inspect: Inspect a repository',
          names: ['inspect'],
          skillCount: 1,
          isInitial: true,
        }),
      );
      if (state === 'finalize-failure') {
        mockedFinalizePostCompact.mockRejectedValueOnce(
          new Error('restore failed'),
        );
      } else {
        mockedFinalizePostCompact.mockResolvedValueOnce({
          attachmentMessages: state === 'empty' ? [] : [recovery],
          hasPendingToolTail: state === 'deferred',
        });
      }
      let parentUuid: string | null = retainedHook.uuid;
      const recordMessages = vi.fn(
        async (messages: readonly Message[]) => messages.at(-1)?.uuid ?? null,
      );
      // `retainedHook` was written by an earlier compaction: partial compaction
      // keeps it verbatim in newHistory, so it must not be appended again.
      const hasMessageUuid = (uuid: string) => uuid === retainedHook.uuid;
      if (state === 'write-failure') {
        recordMessages.mockRejectedValueOnce(new Error('disk full'));
      }
      const newHistory = [boundary, summary, retainedHook, context, stdout];
      const replaceMessages = vi.fn();
      const pushAttachments = vi.fn();
      const attachmentCtx = {
        cwd: '/workspace/project',
        pendingPostCompactDeltaAttachments: null,
      } as AttachmentToolUseContext;

      const result = await applyPostCompact([retainedHook], newHistory, {
        replaceMessages,
        pushAttachments,
        transcriptParentUuid: () => parentUuid,
        setTranscriptParentUuid: (uuid) => {
          parentUuid = uuid;
        },
        transcriptWriter: { recordMessages, hasMessageUuid } as never,
        attachmentCtx,
        config: {} as Config,
      });

      expect(recordMessages.mock.calls[0]?.[0]).not.toContain(retainedHook);
      expect(recordMessages).toHaveBeenNthCalledWith(
        1,
        [boundary, summary, context, stdout],
        retainedHook.uuid,
      );
      expect(recordMessages).toHaveBeenCalledTimes(
        state === 'recovery' ? 2 : 1,
      );
      expect(replaceMessages).toHaveBeenCalledWith(newHistory);
      if (state === 'recovery') {
        expect(recordMessages).toHaveBeenNthCalledWith(
          2,
          [recovery],
          stdout.uuid,
        );
      }
      const appended = state === 'recovery' || state === 'write-failure';
      expect(result).toEqual(appended ? [...newHistory, recovery] : newHistory);
      let expectedParent = stdout.uuid;
      if (state === 'write-failure') expectedParent = retainedHook.uuid;
      if (state === 'recovery') expectedParent = recovery.uuid;
      expect(parentUuid).toBe(expectedParent);
      if (state === 'deferred') {
        expect(attachmentCtx.pendingPostCompactDeltaAttachments).toEqual([
          recovery.attachment,
        ]);
        expect(pushAttachments).not.toHaveBeenCalled();
      }
    },
  );

  it("persists new SessionStart outputs when a 'from' partial compaction hides the boundary", async () => {
    const keptUser = createUserMessage('Oldest question');
    const boundary = createCompactBoundaryMessage({
      trigger: 'manual',
      preTokens: 100,
      postTokens: 20,
      messagesSummarized: 1,
    });
    const summary = createUserMessage('Summary: newest half', {
      isCompactSummary: true,
    });
    const context = createAttachmentMessage(
      new HookOutputAttachment({
        type: 'hook_output',
        hookEventName: HookEventName.SessionStart,
        output: 'from hook context',
      }),
    );
    // `from` renders [...toKeep, boundary, summary]; hooks are appended last.
    const newHistory: Message[] = [keptUser, boundary, summary, context];
    let parentUuid: string | null = 'pre-compact-leaf';
    const recordMessages = vi.fn(
      async (messages: readonly Message[]) => messages.at(-1)?.uuid ?? null,
    );

    const result = await applyPostCompact([keptUser, summary], newHistory, {
      replaceMessages: vi.fn(),
      pushAttachments: vi.fn(),
      transcriptParentUuid: () => parentUuid,
      setTranscriptParentUuid: (uuid) => {
        parentUuid = uuid;
      },
      transcriptWriter: {
        recordMessages,
        hasMessageUuid: () => false,
      } as never,
      attachmentCtx: { cwd: '/workspace/project' } as AttachmentToolUseContext,
      config: {} as Config,
    });

    expect(recordMessages).toHaveBeenCalledWith([context], 'pre-compact-leaf');
    expect(parentUuid).toBe(context.uuid);
    expect(result).toEqual(newHistory);
  });

  it('persists recovery attachments after the compact summary', async () => {
    const boundary = createCompactBoundaryMessage({
      trigger: 'manual',
      preTokens: 100,
      postTokens: 20,
      messagesSummarized: 2,
    });
    const summary = createUserMessage('Summary: compacted history', {
      isCompactSummary: true,
    });
    const skillListing = createAttachmentMessage(
      new SkillListingAttachment({
        type: 'skill_listing',
        content: '- inspect: Inspect a repository',
        names: ['inspect'],
        skillCount: 1,
        isInitial: true,
      }),
    );
    mockedFinalizePostCompact.mockResolvedValueOnce({
      attachmentMessages: [skillListing],
      hasPendingToolTail: false,
    });
    let parentUuid: string | null = 'previous-assistant';
    const recordMessages = vi
      .fn()
      .mockResolvedValueOnce(summary.uuid)
      .mockResolvedValueOnce(skillListing.uuid);
    const pushAttachments = vi.fn();

    const result = await applyPostCompact([], [boundary, summary], {
      replaceMessages: vi.fn(),
      pushAttachments,
      transcriptParentUuid: () => parentUuid,
      setTranscriptParentUuid: (uuid) => {
        parentUuid = uuid;
      },
      transcriptWriter: { recordMessages } as never,
      attachmentCtx: { cwd: '/workspace/project' } as AttachmentToolUseContext,
      config: {} as Config,
    });

    expect(recordMessages).toHaveBeenNthCalledWith(
      2,
      [skillListing],
      summary.uuid,
    );
    expect(pushAttachments).toHaveBeenCalledWith([skillListing]);
    expect(result).toEqual([boundary, summary, skillListing]);
    expect(parentUuid).toBe(skillListing.uuid);
  });

  it('keeps recovery attachments in runtime when their transcript write fails', async () => {
    const boundary = createCompactBoundaryMessage({
      trigger: 'manual',
      preTokens: 100,
      postTokens: 20,
      messagesSummarized: 2,
    });
    const summary = createUserMessage('Summary: compacted history', {
      isCompactSummary: true,
    });
    const skillListing = createAttachmentMessage(
      new SkillListingAttachment({
        type: 'skill_listing',
        content: '- inspect: Inspect a repository',
        names: ['inspect'],
        skillCount: 1,
        isInitial: true,
      }),
    );
    mockedFinalizePostCompact.mockResolvedValueOnce({
      attachmentMessages: [skillListing],
      hasPendingToolTail: false,
    });
    let parentUuid: string | null = 'previous-assistant';
    const recordMessages = vi
      .fn()
      .mockResolvedValueOnce(summary.uuid)
      .mockRejectedValueOnce(new Error('disk full'));
    const pushAttachments = vi.fn();

    const result = await applyPostCompact([], [boundary, summary], {
      replaceMessages: vi.fn(),
      pushAttachments,
      transcriptParentUuid: () => parentUuid,
      setTranscriptParentUuid: (uuid) => {
        parentUuid = uuid;
      },
      transcriptWriter: { recordMessages } as never,
      attachmentCtx: { cwd: '/workspace/project' } as AttachmentToolUseContext,
      config: {} as Config,
    });

    expect(recordMessages).toHaveBeenCalledTimes(2);
    expect(pushAttachments).toHaveBeenCalledWith([skillListing]);
    expect(result).toEqual([boundary, summary, skillListing]);
    expect(parentUuid).toBe(summary.uuid);
  });

  it('does not persist recovery attachments on the old branch when the compact boundary write fails', async () => {
    const boundary = createCompactBoundaryMessage({
      trigger: 'manual',
      preTokens: 100,
      postTokens: 20,
      messagesSummarized: 2,
    });
    const summary = createUserMessage('Summary: compacted history', {
      isCompactSummary: true,
    });
    const skillListing = createAttachmentMessage(
      new SkillListingAttachment({
        type: 'skill_listing',
        content: '- inspect: Inspect a repository',
        names: ['inspect'],
        skillCount: 1,
        isInitial: true,
      }),
    );
    mockedFinalizePostCompact.mockResolvedValueOnce({
      attachmentMessages: [skillListing],
      hasPendingToolTail: false,
    });
    let parentUuid: string | null = 'previous-assistant';
    const recordMessages = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'));
    const pushAttachments = vi.fn();

    const result = await applyPostCompact([], [boundary, summary], {
      replaceMessages: vi.fn(),
      pushAttachments,
      transcriptParentUuid: () => parentUuid,
      setTranscriptParentUuid: (uuid) => {
        parentUuid = uuid;
      },
      transcriptWriter: { recordMessages } as never,
      attachmentCtx: { cwd: '/workspace/project' } as AttachmentToolUseContext,
      config: {} as Config,
    });

    expect(recordMessages).toHaveBeenCalledTimes(1);
    expect(pushAttachments).toHaveBeenCalledWith([skillListing]);
    expect(result).toEqual([boundary, summary, skillListing]);
    expect(parentUuid).toBe('previous-assistant');
  });

  it('persists deferred recovery state without inserting an attachment before a pending tool result', async () => {
    const boundary = createCompactBoundaryMessage({
      trigger: 'auto',
      preTokens: 100,
      postTokens: 20,
      messagesSummarized: 2,
    });
    const summary = createUserMessage('Summary: compacted history', {
      isCompactSummary: true,
    });
    const skillListing = createAttachmentMessage(
      new SkillListingAttachment({
        type: 'skill_listing',
        content: '- inspect: Inspect a repository',
        names: ['inspect'],
        skillCount: 1,
        isInitial: true,
      }),
    );
    mockedFinalizePostCompact.mockResolvedValueOnce({
      attachmentMessages: [skillListing],
      hasPendingToolTail: true,
    });
    let parentUuid: string | null = 'previous-assistant';
    const recordMessages = vi.fn().mockResolvedValueOnce(summary.uuid);
    const attachmentCtx = {
      cwd: '/workspace/project',
      pendingPostCompactDeltaAttachments: null,
      postCompactCandidates: null,
      postCompactPlanAttachment: null,
    } as AttachmentToolUseContext;

    const result = await applyPostCompact([], [boundary, summary], {
      replaceMessages: vi.fn(),
      pushAttachments: vi.fn(),
      transcriptParentUuid: () => parentUuid,
      setTranscriptParentUuid: (uuid) => {
        parentUuid = uuid;
      },
      transcriptWriter: { recordMessages } as never,
      attachmentCtx,
      config: {} as Config,
    });

    expect(recordMessages).toHaveBeenCalledTimes(1);
    expect(result).toEqual([boundary, summary]);
    expect(attachmentCtx.pendingPostCompactDeltaAttachments).toEqual([
      skillListing.attachment,
    ]);
    expect(parentUuid).toBe(summary.uuid);
  });
});
