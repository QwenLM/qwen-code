/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SYNTHETIC_MODEL } from '../protocol/provider/request-converter.js';
import type {
  AssistantMessage,
  Message,
  SystemMessage,
} from '../protocol/transcript/message.js';
import {
  createSessionResumeWriterBinding,
  extractLastAssistantModelFromTranscript,
  selectHistoricalSessionResumePoint,
  selectSessionResumePoint,
  type SessionResumeData,
} from './sessionResumeData.js';
import { projectMessagesForTranscript } from './transcript/session-writer.js';
import type { ProjectedTranscriptSession } from './transcript/resume-projector.js';
import {
  TranscriptRepository,
  createBoundedResumeReadState,
  type ResumeTranscriptResult,
} from './transcript/repository.js';
import {
  beginResumeRead,
  type ResumeReadAttempt,
} from './transcript/resume-read-budget.js';
import type { Entry } from '../protocol/transcript/entry.js';
import { getLegacyWorktreeState } from './legacyWorktreeSessionState.js';

vi.mock('./legacyWorktreeSessionState.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./legacyWorktreeSessionState.js')>();
  return { ...actual, getLegacyWorktreeState: vi.fn(async () => null) };
});

const attempts: ResumeReadAttempt[] = [];
afterEach(() => {
  for (const attempt of attempts.splice(0)) attempt.finish();
  vi.mocked(getLegacyWorktreeState).mockReset().mockResolvedValue(null);
});

function assistantMessage(
  model: string,
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: `uuid-${model}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      id: `msg-${model}`,

      model,
      stop_reason: 'end_turn',

      content: [],
    },
    ...overrides,
  };
}

function compactBoundary(postTokens?: number): SystemMessage {
  return {
    type: 'system',
    uuid: 'compact-boundary',
    timestamp: '2026-01-01T00:00:02.000Z',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    level: 'info',
    isCompactSummary: true,
    compactMetadata: {
      trigger: 'manual',
      preTokens: 586_464,
      ...(postTokens === undefined ? {} : { postTokens }),
      messagesSummarized: 1_854,
    },
  };
}

function resumeResult(
  messages: readonly Message[],
  attempt: ResumeReadAttempt,
  metadataEntries: readonly Entry[] = [],
): ResumeTranscriptResult {
  const repository = new TranscriptRepository();
  const entries = projectMessagesForTranscript(messages, {
    sessionId: 'session-1',
    cwd: '/workspace/project',
    entrypoint: 'cli',
  }).messages;
  const filePath = '/fixture/transcripts/session.jsonl';
  const projected = repository.resolveBuffer(
    filePath,
    Buffer.from(
      [...entries, ...metadataEntries]
        .map((entry) => JSON.stringify(entry) + '\n')
        .join(''),
    ),
    { sessionId: 'session-1' },
  );
  const state = repository.createResumeReadState(projected, 'session-1');
  return {
    filePath,
    sessionId: 'session-1',
    snapshot: state.snapshot,
    metadata: projected.index.metadata,
    messages: projected.messages,
    chain: projected.chain,
    fileHistorySnapshots: projected.fileHistorySnapshots,
    contentReplacements: projected.contentReplacements,
    worktreeStates: state.worktreeStates,
    writerState: state.writerState,
    runtimeTailUuid: state.runtimeTailUuid,
    attempt,
    retainedEntries: entries.length + metadataEntries.length,
    retainedMessageCount: entries.length,
    hasCompactBoundary: false,
  };
}

async function bindingFixture() {
  const attempt = await beginResumeRead();
  attempts.push(attempt);
  const result = resumeResult([assistantMessage('old-model')], attempt);
  const data: SessionResumeData = {
    sessionId: result.sessionId,
    sessionPath: result.filePath,
    messages: [...result.messages],
    model: 'old-model',
    customTitle: 'old-title',
    fileHistorySnapshots: [],
    originalCwd: '/workspace/project',
    transcriptReadState: createBoundedResumeReadState(result),
    resumeAttempt: attempt,
  };
  return { data, attempt };
}

describe('createSessionResumeWriterBinding', () => {
  it('prepares metadata without publishing and commits while preserving wired message identity', async () => {
    const { data, attempt } = await bindingFixture();
    const messages = data.messages;
    const previous = { ...data, messages: [...data.messages] };
    const fresh = resumeResult([assistantMessage('new-model')], attempt, [
      {
        type: 'custom-title',
        sessionId: data.sessionId,
        customTitle: 'new-title',
      },
      {
        type: 'runtime-config',
        sessionId: data.sessionId,
        timestamp: 1,
        model: 'configured-model',
        reasoningEffort: 'high',
        contextWindow: 128_000,
        generation: null,
      },
    ]);
    const state = createBoundedResumeReadState(fresh);
    const binding = createSessionResumeWriterBinding(
      data,
      '/workspace/project',
    )!;
    const commit = await binding.onRefresh(fresh, state);
    expect(data).toEqual(previous);
    expect(data.messages).toBe(messages);
    commit();
    expect(data.messages).toBe(messages);
    expect(data.messages).toEqual(fresh.messages);
    expect(data).toMatchObject({
      customTitle: 'new-title',
      model: 'configured-model',
      reasoningEffort: 'high',
      contextWindow: 128_000,
      generation: null,
    });
    expect(data.transcriptReadState).toBe(state);
    expect(data.resumeAttempt).toBe(attempt);
  });

  it('leaves all wired data unchanged when asynchronous legacy worktree validation fails', async () => {
    const { data, attempt } = await bindingFixture();
    const previous = { ...data, messages: [...data.messages] };
    const messages = data.messages;
    vi.mocked(getLegacyWorktreeState).mockResolvedValue({
      originalCwd: '/workspace/other',
      worktreePath: '/workspace/other/worktree',
      worktreeName: 'feature',
      sessionId: data.sessionId,
    });
    const fresh = resumeResult([assistantMessage('new-model')], attempt);
    await expect(
      createSessionResumeWriterBinding(data, '/workspace/project')!.onRefresh(
        fresh,
        createBoundedResumeReadState(fresh),
      ),
    ).rejects.toThrow('The session project changed during resume');
    expect(data.messages).toBe(messages);
    expect(data).toEqual(previous);
  });

  it('keeps a legal explicitly empty active leaf rather than treating it as cleared history', async () => {
    const { data, attempt } = await bindingFixture();
    const fresh = resumeResult([assistantMessage('old-model')], attempt, [
      {
        type: 'active-leaf',
        sessionId: data.sessionId,
        leafUuid: null,
        explicit: true,
        rewound: true,
        timestamp: 1,
      },
    ]);
    const messages = data.messages;
    const commit = await createSessionResumeWriterBinding(
      data,
      '/workspace/project',
    )!.onRefresh(fresh, createBoundedResumeReadState(fresh));
    expect(data.messages).toHaveLength(1);
    commit();
    expect(data.messages).toBe(messages);
    expect(data.messages).toEqual([]);
    expect(data.transcriptReadState?.writerState.mainParentUuid).toBeNull();
  });

  it.each([false, true])(
    'rejects an invalid cold binding without losing its cleanup owner (missing state: %s)',
    async (missing) => {
      const { data, attempt } = await bindingFixture();
      if (missing) data.transcriptReadState = undefined;
      else data.messages = [];
      expect(
        () => createSessionResumeWriterBinding(data, '/workspace/project'),
      ).toThrow('Transcript resume failed: unsafe.');
      expect(data.resumeAttempt).toBe(attempt);
      attempt.check();
    },
  );
});

describe('extractLastAssistantModelFromTranscript', () => {
  it('returns the model from the last real assistant response', () => {
    const messages: Message[] = [
      assistantMessage('older-model'),
      {
        type: 'user',
        uuid: 'user-1',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'hello' },
      },
      assistantMessage('latest-model'),
    ];

    expect(extractLastAssistantModelFromTranscript(messages)).toBe(
      'latest-model',
    );
  });

  it('skips meta, compact summary, synthetic, and API error assistant entries', () => {
    const messages: Message[] = [
      assistantMessage('real-model'),
      assistantMessage('compact-model', { isCompactSummary: true }),
      assistantMessage('meta-model', { isMeta: true }),
      assistantMessage(SYNTHETIC_MODEL),
      assistantMessage('api-error-model', { isApiErrorMessage: true }),
    ];

    expect(extractLastAssistantModelFromTranscript(messages)).toBe(
      'real-model',
    );
  });

  it('returns undefined when no real assistant model exists', () => {
    const messages: Message[] = [
      {
        type: 'user',
        uuid: 'user-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'hello' },
      },
      assistantMessage('   '),
      assistantMessage(SYNTHETIC_MODEL),
    ];

    expect(extractLastAssistantModelFromTranscript(messages)).toBeUndefined();
  });
});

describe('selectSessionResumePoint', () => {
  it('keeps messages through the selected UUID and preserves checkpoint history', () => {
    const firstUser: Message = {
      type: 'user',
      uuid: 'user-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'first' },
    };
    const firstAssistant = assistantMessage('first-model');
    const secondUser: Message = {
      type: 'user',
      uuid: 'user-2',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: { role: 'user', content: 'second' },
    };
    const secondAssistant = assistantMessage('second-model');

    const selected = selectSessionResumePoint(
      [firstUser, firstAssistant, secondUser, secondAssistant],
      [
        {
          messageId: firstUser.uuid,
          timestamp: new Date('2026-01-01T00:00:00.000Z'),
          trackedFileBackups: {},
        },
        {
          messageId: secondUser.uuid,
          timestamp: new Date('2026-01-01T00:00:02.000Z'),
          trackedFileBackups: {},
        },
      ],
      firstAssistant.uuid,
    );

    expect(selected.messages.map((message) => message.uuid)).toEqual([
      firstUser.uuid,
      firstAssistant.uuid,
    ]);
    expect(
      selected.fileHistorySnapshots?.map((snapshot) => snapshot.messageId),
    ).toEqual([firstUser.uuid, secondUser.uuid]);
  });

  it('rejects a UUID outside the selected conversation', () => {
    expect(() =>
      selectSessionResumePoint([assistantMessage('only-model')], [], 'missing'),
    ).toThrow('Resume point "missing" was not found.');
  });

  it('accepts a discarded turn that matches --resume-drops-turn', () => {
    const keptAssistant = assistantMessage('kept-model', {
      uuid: '11111111-1111-4111-8111-111111111111',
    });
    const droppedUser: Message = {
      type: 'user',
      uuid: '22222222-2222-4222-8222-222222222222',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: 'discard me' },
      origin: { kind: 'human' },
    };
    const droppedAssistant = assistantMessage('dropped-model', {
      uuid: '33333333-3333-4333-8333-333333333333',
    });

    expect(() =>
      selectSessionResumePoint(
        [keptAssistant, droppedUser, droppedAssistant],
        [],
        keptAssistant.uuid,
        droppedUser.uuid,
      ),
    ).not.toThrow();
  });

  it('accepts CLI-generated skill and agent listing furniture in the discarded turn', () => {
    const keptAssistant = assistantMessage('kept-model', {
      uuid: '11111111-1111-4111-8111-111111111111',
    });
    const droppedUser: Message = {
      type: 'user',
      uuid: '22222222-2222-4222-8222-222222222222',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: 'discard me' },
      origin: { kind: 'human' },
    };
    const skillListing: Message = {
      type: 'attachment',
      uuid: '33333333-3333-4333-8333-333333333333',
      timestamp: '2026-01-01T00:00:02.000Z',
      attachment: { type: 'skill_listing' },
    };
    const agentListing: Message = {
      type: 'attachment',
      uuid: '44444444-4444-4444-8444-444444444444',
      timestamp: '2026-01-01T00:00:03.000Z',
      attachment: { type: 'agent_listing_delta' },
    };

    expect(() =>
      selectSessionResumePoint(
        [keptAssistant, droppedUser, skillListing, agentListing],
        [],
        keptAssistant.uuid,
        droppedUser.uuid,
      ),
    ).not.toThrow();
  });

  it('still rejects non-furniture attachments in the discarded turn', () => {
    const keptAssistant = assistantMessage('kept-model', {
      uuid: '11111111-1111-4111-8111-111111111111',
    });
    const droppedUser: Message = {
      type: 'user',
      uuid: '22222222-2222-4222-8222-222222222222',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: 'discard me' },
      origin: { kind: 'human' },
    };
    const fileAttachment: Message = {
      type: 'attachment',
      uuid: '33333333-3333-4333-8333-333333333333',
      timestamp: '2026-01-01T00:00:02.000Z',
      attachment: { type: 'file' },
    };

    expect(() =>
      selectSessionResumePoint(
        [keptAssistant, droppedUser, fileAttachment],
        [],
        keptAssistant.uuid,
        droppedUser.uuid,
      ),
    ).toThrow(
      'Resume rejected by --resume-drops-turn: range contains a non-furniture attachment;',
    );
  });

  it('rejects truncation when another user entry arrived in the discarded range', () => {
    const keptAssistant = assistantMessage('kept-model', {
      uuid: '11111111-1111-4111-8111-111111111111',
    });
    const droppedUser: Message = {
      type: 'user',
      uuid: '22222222-2222-4222-8222-222222222222',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: 'discard me' },
    };
    const queuedUser: Message = {
      type: 'user',
      uuid: '33333333-3333-4333-8333-333333333333',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: { role: 'user', content: 'new work' },
    };

    expect(() =>
      selectSessionResumePoint(
        [keptAssistant, droppedUser, queuedUser],
        [],
        keptAssistant.uuid,
        droppedUser.uuid,
      ),
    ).toThrow(
      'Resume rejected by --resume-drops-turn: range contains a user entry not attributable to the declared turn;',
    );
  });

  it('rejects an externally sourced task notification in the discarded range', () => {
    const keptAssistant = assistantMessage('kept-model', {
      uuid: '11111111-1111-4111-8111-111111111111',
    });
    const droppedUser: Message = {
      type: 'user',
      uuid: '22222222-2222-4222-8222-222222222222',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: 'discard me' },
    };
    const notification: Message = {
      type: 'user',
      uuid: '33333333-3333-4333-8333-333333333333',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: { role: 'user', content: '<task-notification />' },
      origin: { kind: 'task-notification' },
    };

    expect(() =>
      selectSessionResumePoint(
        [keptAssistant, droppedUser, notification],
        [],
        keptAssistant.uuid,
        droppedUser.uuid,
      ),
    ).toThrow(
      'Resume rejected by --resume-drops-turn: range contains an externally-sourced user entry;',
    );
  });
});

describe('selectHistoricalSessionResumePoint', () => {
  it('selects runtime state on either side of a Compact Boundary', () => {
    const oldUser: Message = {
      type: 'user',
      uuid: 'old-user',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'old prompt' },
    };
    const oldAssistant = assistantMessage('old-model', {
      uuid: 'old-assistant',
    });
    const boundary = compactBoundary(100);
    const summary: Message = {
      type: 'user',
      uuid: 'compact-summary',
      timestamp: '2026-01-01T00:00:03.000Z',
      isCompactSummary: true,
      message: { role: 'user', content: 'summary' },
    };
    const postAssistant = assistantMessage('post-model', {
      uuid: 'post-assistant',
    });
    const chain = projectMessagesForTranscript(
      [oldUser, oldAssistant, boundary, summary, postAssistant],
      {
        sessionId: 'session-1',
        cwd: '/workspace',
        entrypoint: 'cli',
        preserveTimestamps: true,
      },
    ).messages;
    const session = {
      chain,
      fileHistorySnapshots: [],
    } as unknown as ProjectedTranscriptSession;

    expect(
      selectHistoricalSessionResumePoint(
        session,
        oldAssistant.uuid,
      ).messages.map((message) => message.uuid),
    ).toEqual([oldUser.uuid, oldAssistant.uuid]);
    expect(
      selectHistoricalSessionResumePoint(
        session,
        postAssistant.uuid,
      ).messages.map((message) => message.uuid),
    ).toEqual([boundary.uuid, summary.uuid, postAssistant.uuid]);
  });
});
