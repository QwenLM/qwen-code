/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createTranscriptReplayMachine,
  createTranscriptToolCallResultUpdate,
  MISSING_TRANSCRIPT_TOOL_RESULT_MESSAGE,
  type TranscriptReplayStateV1,
} from './transcript-replay.js';
import type { TranscriptRecordInput } from '@qwen-code/qwen-code-core/transcriptRecords';
import type {
  GoalRecord,
  GoalStateCause,
} from '@qwen-code/qwen-code-core/goalWire';

const GOAL: GoalRecord = {
  goalId: 'goal-1',
  revision: 3,
  objective: 'ship it',
  status: 'active',
  evidenceCursor: { recordId: 'record-0' },
  turnCount: 4,
  activeTimeMs: 2000,
  tokensUsed: 0,
  createdAt: 100,
  updatedAt: 200,
  lastReason: 'continuing',
};

function record(
  uuid: string,
  type: TranscriptRecordInput['type'],
  overrides: Partial<TranscriptRecordInput> = {},
): TranscriptRecordInput {
  return {
    uuid,
    parentUuid: null,
    sessionId: 'session-1',
    timestamp: '2026-07-14T00:00:00.000Z',
    type,
    ...overrides,
  };
}

function updates(
  machine: ReturnType<typeof createTranscriptReplayMachine>,
  item: TranscriptRecordInput,
) {
  return [...machine.project(item)].map((emission) => emission.update);
}

function goalStateRecord(
  uuid: string,
  cause: GoalStateCause,
  goal: GoalRecord | null,
): TranscriptRecordInput {
  return record(uuid, 'system', {
    subtype: 'goal_state',
    systemPayload: {
      v: 2,
      cause,
      snapshot: { v: 2, activity: 'idle', goal },
    },
  });
}

function goalCardRecord(
  uuid: string,
  ...items: ReadonlyArray<Record<string, unknown>>
): TranscriptRecordInput {
  return record(uuid, 'system', {
    subtype: 'slash_command',
    systemPayload: { phase: 'result', outputHistoryItems: items },
  });
}

describe('createTranscriptReplayMachine', () => {
  it('stamps stable segment identity across replayed text parts', () => {
    const projected = updates(
      createTranscriptReplayMachine(),
      record('assistant-1', 'assistant', {
        message: {
          role: 'model',
          parts: [
            { text: 'first' },
            { text: 'second' },
            { text: 'thinking', thought: true },
          ],
        },
      }),
    );
    const segmentIds = projected.map(
      (update) =>
        (
          update._meta as
            | { qwenTranscript?: { segmentId?: string } }
            | undefined
        )?.qwenTranscript?.segmentId,
    );

    expect(segmentIds).toEqual([
      'assistant-1:0',
      'assistant-1:0',
      'assistant-1:2',
    ]);
  });

  it('keeps raw function responses out of the safe result preview', () => {
    const update = createTranscriptToolCallResultUpdate({
      toolName: 'read',
      callId: 'read-1',
      success: true,
      contentPrefix: [
        {
          type: 'content',
          content: { type: 'text', text: 'Visible prefix' },
        },
      ],
      message: [{ text: 'Visible result' }],
    });

    expect(update._meta).toMatchObject({
      qwenTranscript: {
        resultPreviewText: 'Visible prefix',
      },
    });
    expect(JSON.stringify(update._meta)).not.toContain('Visible result');
  });

  it('does not replay internal Goal runtime prompts as user messages', () => {
    expect(
      updates(
        createTranscriptReplayMachine(),
        record('goal-runtime', 'user', {
          subtype: 'goal_runtime',
          message: { role: 'user', parts: [{ text: 'Continue working.' }] },
        }),
      ),
    ).toEqual([]);
  });

  it('replays user-initiated Goal controls as user messages', () => {
    const projected = updates(
      createTranscriptReplayMachine(),
      goalStateRecord('goal-create', 'create', GOAL),
    );

    expect(projected[0]).toMatchObject({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: `/goal ${GOAL.objective}` },
      _meta: {
        source: 'goal_control',
        'qwen.session.recordId': 'goal-create',
      },
    });
  });

  it('projects goal_state through v2-first metadata', () => {
    const projected = updates(
      createTranscriptReplayMachine(),
      goalStateRecord('goal-create', 'create', GOAL),
    );

    expect(projected).toHaveLength(2);
    expect(projected[1]?._meta).toMatchObject({
      goalState: { v: 2, goal: GOAL, activity: 'idle' },
      goalStatus: { kind: 'set', condition: GOAL.objective },
      'qwen.session.recordId': 'goal-create',
    });
  });

  it('tracks Goal state across replay pages', () => {
    const first = createTranscriptReplayMachine();
    updates(first, goalStateRecord('goal-create', 'create', GOAL));
    const second = createTranscriptReplayMachine({
      initialState: first.snapshot(),
    });

    const projected = updates(
      second,
      goalStateRecord('goal-clear', 'clear', null),
    );

    expect(projected[1]?._meta).toMatchObject({
      goalState: { v: 2, goal: null, activity: 'idle' },
      goalStatus: { kind: 'cleared', condition: GOAL.objective },
      'qwen.session.recordId': 'goal-clear',
    });
  });

  it('replays a legacy paused goal card instead of leaving the set card newest', () => {
    const machine = createTranscriptReplayMachine();
    expect(
      updates(
        machine,
        goalCardRecord('goal-set', {
          type: 'goal_status',
          kind: 'set',
          condition: GOAL.objective,
        }),
      ),
    ).toHaveLength(1);

    const projected = updates(
      machine,
      goalCardRecord('goal-paused', {
        type: 'goal_status',
        kind: 'paused',
        condition: GOAL.objective,
        iterations: 4,
        lastReason: 'paused by the user',
      }),
    );

    expect(projected).toHaveLength(1);
    expect(projected[0]?._meta).toMatchObject({
      goalStatus: {
        kind: 'paused',
        condition: GOAL.objective,
        iterations: 4,
        lastReason: 'paused by the user',
      },
    });
  });

  it('emits legacy goalTerminal metadata for a terminal goal_state', () => {
    const projected = updates(
      createTranscriptReplayMachine(),
      goalStateRecord('goal-complete', 'complete', {
        ...GOAL,
        status: 'complete',
      }),
    );

    expect(projected[0]?._meta).toMatchObject({
      goalStatus: { kind: 'achieved', condition: GOAL.objective },
      goalTerminal: {
        kind: 'achieved',
        condition: GOAL.objective,
        iterations: GOAL.turnCount,
        durationMs: GOAL.activeTimeMs,
      },
    });
  });

  it('skips checkpoint bookkeeping goal_state records during replay', () => {
    const machine = createTranscriptReplayMachine();

    expect(
      updates(machine, goalStateRecord('goal-create', 'create', GOAL)),
    ).toHaveLength(2);

    const turned: GoalRecord = {
      ...GOAL,
      turnCount: GOAL.turnCount + 1,
      activeTimeMs: 2100,
      tokensUsed: 0,
      updatedAt: 300,
    };
    expect(
      updates(machine, goalStateRecord('goal-turn', 'turn_finished', turned)),
    ).toHaveLength(1);

    const checkpointed: GoalRecord = {
      ...turned,
      evidenceCursor: { recordId: 'checkpoint-1' },
      evidenceCheckpoint: {
        checkpointId: 'checkpoint-1',
        createdAt: 350,
        claims: [
          {
            id: 'checkpoint-1:1',
            proofKind: 'delivered_output',
            claim: 'The result was delivered.',
            sourceRefs: ['assistant-1'],
          },
        ],
      },
      activeTimeMs: 2500,
      tokensUsed: 0,
      updatedAt: 400,
    };
    expect(
      updates(
        machine,
        goalStateRecord('goal-checkpoint', 'checkpoint', checkpointed),
      ),
    ).toEqual([]);

    const rejected: GoalRecord = {
      ...checkpointed,
      lastReason: 'More work remains',
    };
    expect(
      updates(
        machine,
        goalStateRecord('goal-reject', 'verifier_reject', rejected),
      ),
    ).toHaveLength(1);

    const recommitted: GoalRecord = {
      ...rejected,
      activeTimeMs: 2900,
      tokensUsed: 0,
      updatedAt: 500,
    };
    expect(
      updates(
        machine,
        goalStateRecord(
          'goal-reject-checkpoint',
          'verifier_reject',
          recommitted,
        ),
      ),
    ).toEqual([]);

    expect(machine.snapshot().goalState?.goal).toEqual(recommitted);
  });

  it('persists goalCause so bookkeeping suppression survives a page boundary', () => {
    const first = createTranscriptReplayMachine();
    updates(first, goalStateRecord('goal-create', 'create', GOAL));
    const turned: GoalRecord = {
      ...GOAL,
      turnCount: GOAL.turnCount + 1,
      activeTimeMs: 2100,
      tokensUsed: 0,
      updatedAt: 300,
    };
    updates(first, goalStateRecord('goal-turn', 'turn_finished', turned));
    const rejected: GoalRecord = {
      ...turned,
      lastReason: 'More work remains',
      activeTimeMs: 2200,
      tokensUsed: 0,
      updatedAt: 310,
    };
    expect(
      updates(
        first,
        goalStateRecord('goal-reject', 'verifier_reject', rejected),
      ),
    ).toHaveLength(1);

    const state = first.snapshot();
    expect(state.goalCause).toBe('verifier_reject');

    // A page boundary falls between the genuine rejection and the
    // shape-equal bookkeeping re-commit; the second machine must still
    // recognize the re-commit as bookkeeping.
    const second = createTranscriptReplayMachine({ initialState: state });
    const recommitted: GoalRecord = {
      ...rejected,
      activeTimeMs: 2300,
      tokensUsed: 0,
      updatedAt: 320,
    };
    expect(
      updates(
        second,
        goalStateRecord(
          'goal-reject-checkpoint',
          'verifier_reject',
          recommitted,
        ),
      ),
    ).toEqual([]);
    expect(second.snapshot().goalState?.goal).toEqual(recommitted);
  });

  it('emits a repeated verifier rejection that follows an empty turn', () => {
    const machine = createTranscriptReplayMachine();

    expect(
      updates(machine, goalStateRecord('goal-create', 'create', GOAL)),
    ).toHaveLength(2);

    const turnedOnce: GoalRecord = {
      ...GOAL,
      turnCount: GOAL.turnCount + 1,
      activeTimeMs: 2100,
      tokensUsed: 0,
      updatedAt: 300,
    };
    expect(
      updates(
        machine,
        goalStateRecord('goal-turn-1', 'turn_finished', turnedOnce),
      ),
    ).toHaveLength(1);

    const rejectedOnce: GoalRecord = {
      ...turnedOnce,
      lastReason: 'More work remains',
      activeTimeMs: 2200,
      tokensUsed: 0,
      updatedAt: 310,
    };
    expect(
      updates(
        machine,
        goalStateRecord('goal-reject-1', 'verifier_reject', rejectedOnce),
      ),
    ).toHaveLength(1);

    const turnedTwice: GoalRecord = {
      ...rejectedOnce,
      turnCount: GOAL.turnCount + 2,
      activeTimeMs: 2300,
      tokensUsed: 0,
      updatedAt: 320,
    };
    expect(
      updates(
        machine,
        goalStateRecord('goal-turn-2', 'turn_finished', turnedTwice),
      ),
    ).toHaveLength(1);

    // Shape-equal to the preceding turn_finished record, but its cause is a
    // genuine rejection, not checkpoint bookkeeping — it must stay visible.
    const rejectedTwice: GoalRecord = {
      ...turnedTwice,
      activeTimeMs: 2400,
      tokensUsed: 0,
      updatedAt: 330,
    };
    expect(
      updates(
        machine,
        goalStateRecord('goal-reject-2', 'verifier_reject', rejectedTwice),
      ),
    ).toHaveLength(1);

    const recommitted: GoalRecord = {
      ...rejectedTwice,
      activeTimeMs: 2500,
      tokensUsed: 0,
      updatedAt: 340,
    };
    expect(
      updates(
        machine,
        goalStateRecord(
          'goal-reject-2-checkpoint',
          'verifier_reject',
          recommitted,
        ),
      ),
    ).toEqual([]);

    expect(machine.snapshot().goalState?.goal).toEqual(recommitted);
  });

  it('reports and skips a malformed goal_state record', () => {
    const onDiagnostic = vi.fn();
    const machine = createTranscriptReplayMachine({ onDiagnostic });
    const malformed = record('goal-malformed', 'system', {
      subtype: 'goal_state',
      systemPayload: {
        v: 2,
        cause: 'create',
        snapshot: { v: 2, activity: 'running', goal: GOAL },
      },
    });

    expect(updates(machine, malformed)).toEqual([]);
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'malformed_goal_state',
        recordId: 'goal-malformed',
        path: 'systemPayload',
      }),
    );
  });

  it('preserves task notification metadata during replay', () => {
    const machine = createTranscriptReplayMachine();
    const projected = updates(
      machine,
      record('notification-1', 'user', {
        subtype: 'notification',
        message: {
          role: 'user',
          parts: [{ text: '<task-notification />' }],
        },
        systemPayload: {
          displayText: 'Background agent completed.',
          backgroundTask: {
            taskId: 'task-1',
            status: 'completed',
            kind: 'agent',
          },
        },
      }),
    );

    expect(projected).toMatchObject([
      {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Background agent completed.' },
        _meta: {
          source: 'background_notification',
          qwenDiscreteMessage: true,
          backgroundTask: {
            taskId: 'task-1',
            status: 'completed',
            kind: 'agent',
          },
          qwenTranscript: { sourceRecordIds: ['notification-1'] },
        },
      },
    ]);
  });

  it('preserves cron display text and source metadata during replay', () => {
    const projected = updates(
      createTranscriptReplayMachine(),
      record('cron-1', 'user', {
        subtype: 'cron',
        message: {
          role: 'user',
          parts: [{ text: 'cron model text' }],
        },
        systemPayload: { displayText: 'Cron job fired' },
      }),
    );

    expect(projected).toMatchObject([
      {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Cron job fired' },
        _meta: {
          source: 'cron',
          qwenTranscript: { sourceRecordIds: ['cron-1'] },
        },
      },
    ]);
  });

  it('uses clean user display metadata while preserving image parts', () => {
    const machine = createTranscriptReplayMachine();
    const projected = updates(
      machine,
      record('user-1', 'user', {
        message: {
          role: 'user',
          parts: [
            {
              inlineData: {
                data: 'image-data',
                mimeType: 'image/png',
              },
            },
            { text: 'expanded model prompt' },
            {
              text: [
                '<qwen:user-prompt-submit-context>',
                'hook-only context',
                '</qwen:user-prompt-submit-context>',
              ].join('\n'),
            },
          ],
        },
        systemPayload: {
          displayText: 'raw @file prompt',
          hookContext: 'hook-only context',
        },
      }),
    );

    expect(projected).toMatchObject([
      {
        sessionUpdate: 'user_message_chunk',
        content: {
          type: 'image',
          data: 'image-data',
          mimeType: 'image/png',
        },
      },
      {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'raw @file prompt' },
      },
    ]);
  });

  it('strips only a complete final tag-only context part', () => {
    const projected = updates(
      createTranscriptReplayMachine(),
      record('user-1', 'user', {
        message: {
          role: 'user',
          parts: [
            { text: 'user prompt' },
            {
              text: [
                '<qwen:user-prompt-submit-context>',
                'hook-only context',
                '</qwen:user-prompt-submit-context>',
              ].join('\n'),
            },
          ],
        },
      }),
    );

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      content: { type: 'text', text: 'user prompt' },
    });
  });

  it('preserves legacy bare hook context without a reliable boundary', () => {
    const projected = updates(
      createTranscriptReplayMachine(),
      record('user-1', 'user', {
        message: {
          role: 'user',
          parts: [
            { text: 'user prompt' },
            { text: 'legacy bare hook context' },
          ],
        },
      }),
    );

    expect(projected).toMatchObject([
      { content: { type: 'text', text: 'user prompt' } },
      { content: { type: 'text', text: 'legacy bare hook context' } },
    ]);
  });

  it('preserves Live dialogue boundaries and source during replay', () => {
    const machine = createTranscriptReplayMachine();
    const projected = updates(
      machine,
      record('realtime-1', 'assistant', {
        subtype: 'realtime_message',
        message: {
          role: 'model',
          parts: [{ text: 'Realtime answer' }],
        },
      }),
    );

    expect(projected).toMatchObject([
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Realtime answer' },
        _meta: {
          source: 'realtime_voice',
          qwenDiscreteMessage: true,
          qwenTranscript: { sourceRecordIds: ['realtime-1'] },
        },
      },
    ]);
  });

  describe('UserPromptSubmit hook context provenance', () => {
    const tagged =
      '<qwen:user-prompt-submit-context>\ninjected hook context\n</qwen:user-prompt-submit-context>';

    it('replays daemon attachment references without embedding base64', () => {
      const projected = updates(
        createTranscriptReplayMachine(),
        record('user-media-ref', 'user', {
          message: { role: 'user', parts: [{ text: 'describe this' }] },
          systemPayload: {
            displayText: 'describe this',
            hookContext: '',
            attachmentReferences: [
              {
                type: 'image',
                attachmentId: 'media-1',
                mimeType: 'image/png',
                size: 3,
              },
            ],
          },
        }),
      );

      expect(projected).toMatchObject([
        {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'describe this' },
        },
        {
          sessionUpdate: 'user_message_chunk',
          content: {
            type: 'image',
            attachmentId: 'media-1',
            mimeType: 'image/png',
            size: 3,
          },
        },
      ]);
    });

    it('replays file attachment references for hydration and preview', () => {
      const projected = updates(
        createTranscriptReplayMachine(),
        record('user-file-ref', 'user', {
          message: {
            role: 'user',
            parts: [{ text: 'check\n\n@attachment:///notes.json' }],
          },
          systemPayload: {
            displayText: 'check\n\n@attachment:///notes.json',
            hookContext: '',
            attachmentReferences: [
              {
                type: 'resource',
                attachmentId: 'notes.json',
                mimeType: 'application/json',
                size: 6,
              },
            ],
          },
        }),
      );

      expect(projected).toMatchObject([
        {
          sessionUpdate: 'user_message_chunk',
          content: {
            type: 'text',
            text: 'check',
          },
        },
        {
          sessionUpdate: 'user_message_chunk',
          content: {
            type: 'resource',
            attachmentId: 'notes.json',
            mimeType: 'application/json',
            size: 6,
          },
        },
      ]);
    });

    it('replaces text parts with displayText while preserving image parts', () => {
      // displayText must replace all model-facing text while the image part
      // survives (the previous early-return path dropped it).
      const projected = updates(
        createTranscriptReplayMachine(),
        record('user-1', 'user', {
          message: {
            role: 'user',
            parts: [
              {
                inlineData: {
                  data: 'abc123',
                  mimeType: 'image/png',
                },
              },
              { text: 'my prompt' },
              { text: 'expanded extra' },
              { text: tagged },
            ],
          },
          systemPayload: {
            displayText: 'my prompt',
            hookContext: 'injected hook context',
          },
        }),
      );

      expect(projected).toMatchObject([
        {
          sessionUpdate: 'user_message_chunk',
          content: {
            type: 'image',
            data: 'abc123',
            mimeType: 'image/png',
          },
        },
        {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'my prompt' },
        },
      ]);
      expect(projected).toHaveLength(2);
    });

    it('appends displayText after an image-only record', () => {
      // With no text part to replace, displayText is appended after the image.
      const projected = updates(
        createTranscriptReplayMachine(),
        record('user-img-only', 'user', {
          message: {
            role: 'user',
            parts: [
              {
                inlineData: {
                  data: 'abc',
                  mimeType: 'image/png',
                },
              },
            ],
          },
          systemPayload: {
            displayText: 'my image prompt',
            hookContext: 'injected hook context',
          },
        }),
      );

      expect(projected).toMatchObject([
        {
          sessionUpdate: 'user_message_chunk',
          content: {
            type: 'image',
            data: 'abc',
            mimeType: 'image/png',
          },
        },
        {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'my image prompt' },
        },
      ]);
      expect(projected).toHaveLength(2);
    });

    it('does not append empty displayText after an image-only record', () => {
      const onDiagnostic = vi.fn();
      const projected = updates(
        createTranscriptReplayMachine({ onDiagnostic }),
        record('user-img-only-empty-display', 'user', {
          message: {
            role: 'user',
            parts: [
              {
                inlineData: {
                  data: 'abc',
                  mimeType: 'image/png',
                },
              },
            ],
          },
          systemPayload: {
            displayText: '',
            hookContext: 'injected hook context',
          },
        }),
      );

      expect(projected).toMatchObject([
        {
          sessionUpdate: 'user_message_chunk',
          content: {
            type: 'image',
            data: 'abc',
            mimeType: 'image/png',
          },
        },
      ]);
      expect(projected).toHaveLength(1);
      expect(onDiagnostic).not.toHaveBeenCalled();
    });

    it('strips a trailing whole-part tagged block when displayText is absent', () => {
      const projected = updates(
        createTranscriptReplayMachine(),
        record('user-2', 'user', {
          message: {
            role: 'user',
            parts: [{ text: 'my prompt' }, { text: tagged }],
          },
        }),
      );

      expect(projected).toMatchObject([
        {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'my prompt' },
        },
      ]);
      expect(projected).toHaveLength(1);
    });

    it('uses released single-field displayText when the final tag proves provenance', () => {
      const projected = updates(
        createTranscriptReplayMachine(),
        record('user-single-field-display', 'user', {
          message: {
            role: 'user',
            parts: [
              {
                inlineData: {
                  data: 'abc123',
                  mimeType: 'image/png',
                },
              },
              { text: 'model-bound prompt' },
              { text: 'legacy bare hook context' },
              { text: tagged },
            ],
          },
          systemPayload: {
            displayText: 'raw @file prompt',
          },
        }),
      );

      expect(projected).toMatchObject([
        {
          sessionUpdate: 'user_message_chunk',
          content: {
            type: 'image',
            data: 'abc123',
            mimeType: 'image/png',
          },
        },
        {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'raw @file prompt' },
        },
      ]);
      expect(projected).toHaveLength(2);
    });

    it('does not trust bare displayText on plain user records', () => {
      const projected = updates(
        createTranscriptReplayMachine(),
        record('user-bare-display', 'user', {
          message: {
            role: 'user',
            parts: [
              {
                inlineData: {
                  data: 'abc123',
                  mimeType: 'image/png',
                },
              },
              { text: 'model-bound prompt' },
              { text: 'legacy bare hook context' },
            ],
          },
          systemPayload: {
            displayText: 'notification-style label',
          },
        }),
      );

      expect(projected).toMatchObject([
        {
          sessionUpdate: 'user_message_chunk',
          content: {
            type: 'image',
            data: 'abc123',
            mimeType: 'image/png',
          },
        },
        {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'model-bound prompt' },
        },
        {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'legacy bare hook context' },
        },
      ]);
      expect(projected).toHaveLength(3);
    });

    it('treats paired empty displayText as authoritative', () => {
      const projected = updates(
        createTranscriptReplayMachine(),
        record('user-empty-display', 'user', {
          message: {
            role: 'user',
            parts: [
              { text: 'expanded model prompt' },
              {
                inlineData: {
                  data: 'abc123',
                  mimeType: 'image/png',
                },
              },
              { text: tagged },
            ],
          },
          systemPayload: {
            displayText: '',
            hookContext: 'injected hook context',
          },
        }),
      );

      expect(projected).toMatchObject([
        {
          sessionUpdate: 'user_message_chunk',
          content: {
            type: 'image',
            data: 'abc123',
            mimeType: 'image/png',
          },
        },
      ]);
      expect(projected).toHaveLength(1);
    });

    it('keeps a sole part that matches the tag shape', () => {
      const projected = updates(
        createTranscriptReplayMachine(),
        record('user-3', 'user', {
          message: {
            role: 'user',
            parts: [{ text: tagged }],
          },
        }),
      );

      expect(projected).toMatchObject([
        {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: tagged },
        },
      ]);
    });
  });

  it('replays attachment references from a mid-turn user record', () => {
    const projected = updates(
      createTranscriptReplayMachine(),
      record('mid-turn-media', 'user', {
        subtype: 'mid_turn_user_message',
        message: { role: 'user', parts: [{ text: 'inspect image' }] },
        systemPayload: {
          displayText: 'inspect image',
          attachmentReferences: [
            {
              type: 'image',
              attachmentId: 'media-1',
              mimeType: 'image/png',
              size: 3,
            },
          ],
        },
      }),
    );

    expect(projected).toMatchObject([
      {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'inspect image' },
        _meta: {
          source: 'mid_turn_message_injected',
          qwenDiscreteMessage: true,
        },
      },
      {
        sessionUpdate: 'user_message_chunk',
        content: {
          type: 'image',
          attachmentId: 'media-1',
          mimeType: 'image/png',
          size: 3,
        },
        _meta: {
          source: 'mid_turn_message_injected',
          qwenDiscreteMessage: true,
        },
      },
    ]);
  });

  it('replays an image-only mid-turn record without its synthetic prefix', () => {
    const projected = updates(
      createTranscriptReplayMachine(),
      record('mid-turn-image-only', 'user', {
        subtype: 'mid_turn_user_message',
        message: {
          role: 'user',
          parts: [{ text: '[User message received during tool execution]: ' }],
        },
        systemPayload: {
          displayText: '',
          attachmentReferences: [
            {
              type: 'image',
              attachmentId: 'media-only',
              mimeType: 'image/png',
              size: 3,
            },
          ],
        },
      }),
    );

    expect(projected).toMatchObject([
      {
        sessionUpdate: 'user_message_chunk',
        content: {
          type: 'image',
          attachmentId: 'media-only',
          mimeType: 'image/png',
          size: 3,
        },
        _meta: {
          source: 'mid_turn_message_injected',
          qwenDiscreteMessage: true,
        },
      },
    ]);
  });

  it('falls back to inline parts for an image-only mid-turn record without references', () => {
    const projected = updates(
      createTranscriptReplayMachine(),
      record('mid-turn-inline-image-only', 'user', {
        subtype: 'mid_turn_user_message',
        message: {
          role: 'user',
          parts: [{ inlineData: { data: 'AQID', mimeType: 'image/png' } }],
        },
        systemPayload: { displayText: '' },
      }),
    );

    expect(projected).toMatchObject([
      {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'image', data: 'AQID', mimeType: 'image/png' },
        _meta: {
          source: 'mid_turn_message_injected',
          qwenDiscreteMessage: true,
        },
      },
    ]);
  });

  it('projects ordered message parts with source metadata', () => {
    const machine = createTranscriptReplayMachine();
    const projected = updates(
      machine,
      record('assistant-1', 'assistant', {
        message: {
          role: 'model',
          parts: [{ text: 'thinking', thought: true }, { text: 'answer' }],
        },
      }),
    );

    expect(projected.map((update) => update.sessionUpdate)).toEqual([
      'agent_thought_chunk',
      'agent_message_chunk',
    ]);
    expect(projected[0]?._meta).toMatchObject({
      timestamp: Date.parse('2026-07-14T00:00:00.000Z'),
      qwenTranscript: { sourceRecordIds: ['assistant-1'] },
    });
  });

  it('uses stable synthetic ids and finalizes dangling calls once', () => {
    const onDiagnostic = vi.fn();
    const machine = createTranscriptReplayMachine({ onDiagnostic });
    const projected = updates(
      machine,
      record('assistant-1', 'assistant', {
        message: {
          role: 'model',
          parts: [{ functionCall: { name: 'read_file', args: {} } }],
        },
      }),
    );

    expect(projected[0]).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'qwen-replay-tool:assistant-1:0',
    });
    const finalized = [...machine.finalize()].map((item) => item.update);
    expect(finalized[0]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'qwen-replay-tool:assistant-1:0',
      status: 'failed',
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: MISSING_TRANSCRIPT_TOOL_RESULT_MESSAGE,
          },
        },
      ],
    });
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'missing_tool_result',
        affectsCompleteness: true,
        recordId: 'assistant-1',
      }),
    );
    expect([...machine.finalize()]).toEqual([]);
  });

  it('skips finalize for selected ask_user_question call ids', () => {
    const machine = createTranscriptReplayMachine({
      skipFinalizeCallIds: new Set(['call-auq']),
    });
    updates(
      machine,
      record('assistant-1', 'assistant', {
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-auq',
                name: 'ask_user_question',
                args: {},
              },
            },
            {
              functionCall: {
                id: 'call-bash',
                name: 'run_shell_command',
                args: { command: 'ls' },
              },
            },
          ],
        },
      }),
    );

    const finalized = [...machine.finalize()].map((item) => item.update);
    expect(finalized).toHaveLength(1);
    expect(finalized[0]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-bash',
      status: 'failed',
    });
    expect(machine.snapshot().pendingToolCalls).toEqual([
      expect.objectContaining({ callId: 'call-auq' }),
    ]);
  });

  it('matches the skip set against raw transcript ids after dedup renames', () => {
    const machine = createTranscriptReplayMachine({
      skipFinalizeCallIds: new Set(['call-auq']),
    });
    // Two dangling calls with the SAME transcript id: the second is renamed
    // to `call-auq:2`, but the skip set (derived from chat history) holds
    // the raw id, so both must stay pending.
    updates(
      machine,
      record('assistant-1', 'assistant', {
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-auq',
                name: 'ask_user_question',
                args: {},
              },
            },
          ],
        },
      }),
    );
    updates(
      machine,
      record('assistant-2', 'assistant', {
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-auq',
                name: 'ask_user_question',
                args: {},
              },
            },
          ],
        },
      }),
    );

    expect([...machine.finalize()]).toEqual([]);
    expect(machine.snapshot().pendingToolCalls).toHaveLength(2);
  });

  it('correlates an id-less result only to one same-name pending call', () => {
    const machine = createTranscriptReplayMachine();
    updates(
      machine,
      record('assistant-1', 'assistant', {
        message: {
          role: 'model',
          parts: [
            { functionCall: { name: 'read_file', args: {}, id: 'call-1' } },
          ],
        },
      }),
    );
    const result = updates(
      machine,
      record('result-1', 'tool_result', {
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'read_file',
                response: { output: 'contents' },
              },
            },
          ],
        },
      }),
    );

    expect(result[0]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
    });
    expect(machine.snapshot().pendingToolCalls).toEqual([]);
  });

  it('prefers filePath over the fileName basename when replaying an edit diff', () => {
    const machine = createTranscriptReplayMachine();
    updates(
      machine,
      record('assistant-1', 'assistant', {
        message: {
          role: 'model',
          parts: [
            { functionCall: { name: 'edit_file', args: {}, id: 'call-1' } },
          ],
        },
      }),
    );
    const result = updates(
      machine,
      record('result-1', 'tool_result', {
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'edit_file',
                response: { output: 'edited' },
              },
            },
          ],
        },
        toolCallResult: {
          callId: 'call-1',
          resultDisplay: {
            fileDiff: '--- a\n+++ b\n',
            fileName: 'Foo.kt',
            filePath: '/workspace/app/src/main/java/com/example/Foo.kt',
            originalContent: 'old',
            newContent: 'new',
          },
        },
      }),
    );

    expect(result[0]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      content: [
        {
          type: 'diff',
          path: '/workspace/app/src/main/java/com/example/Foo.kt',
          oldText: 'old',
          newText: 'new',
        },
      ],
    });
  });

  it('falls back to the fileName basename when filePath is absent (pre-fix persisted sessions)', () => {
    const machine = createTranscriptReplayMachine();
    updates(
      machine,
      record('assistant-1', 'assistant', {
        message: {
          role: 'model',
          parts: [
            { functionCall: { name: 'edit_file', args: {}, id: 'call-1' } },
          ],
        },
      }),
    );
    const result = updates(
      machine,
      record('result-1', 'tool_result', {
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'edit_file',
                response: { output: 'edited' },
              },
            },
          ],
        },
        toolCallResult: {
          callId: 'call-1',
          resultDisplay: {
            fileDiff: '--- a\n+++ b\n',
            fileName: 'Foo.kt',
            originalContent: 'old',
            newContent: 'new',
          },
        },
      }),
    );

    expect(result[0]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      content: [
        {
          type: 'diff',
          path: 'Foo.kt',
          oldText: 'old',
          newText: 'new',
        },
      ],
    });
  });

  it('reports ambiguous same-name result correlation', () => {
    const onDiagnostic = vi.fn();
    const machine = createTranscriptReplayMachine({ onDiagnostic });
    updates(
      machine,
      record('assistant-1', 'assistant', {
        message: {
          role: 'model',
          parts: [
            { functionCall: { name: 'read_file', args: {}, id: 'call-1' } },
            { functionCall: { name: 'read_file', args: {}, id: 'call-2' } },
          ],
        },
      }),
    );
    const result = updates(
      machine,
      record('result-1', 'tool_result', {
        message: {
          role: 'user',
          parts: [{ functionResponse: { name: 'read_file', response: {} } }],
        },
      }),
    );

    expect(result[0]).toMatchObject({
      toolCallId: 'qwen-replay-tool:result-1:result',
    });
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'ambiguous_tool_call_correlation',
        affectsCompleteness: true,
      }),
    );
  });

  it('carries versioned state across pages and rejects unknown versions', () => {
    const first = createTranscriptReplayMachine();
    updates(
      first,
      record('assistant-1', 'assistant', {
        message: {
          role: 'model',
          parts: [
            { functionCall: { name: 'read_file', args: {}, id: 'call-1' } },
          ],
        },
      }),
    );

    const second = createTranscriptReplayMachine({
      initialState: first.snapshot(),
    });
    expect(second.snapshot()).toEqual(first.snapshot());
    expect(() =>
      createTranscriptReplayMachine({
        initialState: { v: 2 } as unknown as TranscriptReplayStateV1,
      }),
    ).toThrow('Unsupported transcript replay state version');
  });

  it('drops a malformed goalState from initialState and reports it', () => {
    const onDiagnostic = vi.fn();
    const machine = createTranscriptReplayMachine({
      onDiagnostic,
      initialState: {
        v: 1,
        pendingToolCalls: [],
        cumulativeUsage: {
          promptTokens: 0,
          cachedTokens: 0,
          candidateTokens: 0,
          apiTimeMs: 0,
        },
        goalState: { v: 2, activity: 'bogus', goal: null },
      } as unknown as TranscriptReplayStateV1,
    });

    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'invalid_replay_state',
        message: 'Dropped a malformed Goal state from replay state.',
        affectsCompleteness: true,
      }),
    );
    expect(machine.snapshot().goalState).toBeUndefined();
  });

  it('drops a malformed goalCause from initialState and reports it', () => {
    const onDiagnostic = vi.fn();
    const machine = createTranscriptReplayMachine({
      onDiagnostic,
      initialState: {
        v: 1,
        pendingToolCalls: [],
        cumulativeUsage: {
          promptTokens: 0,
          cachedTokens: 0,
          candidateTokens: 0,
          apiTimeMs: 0,
        },
        goalCause: 'bogus',
      } as unknown as TranscriptReplayStateV1,
    });

    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'invalid_replay_state',
        message: 'Dropped a malformed Goal cause from replay state.',
        affectsCompleteness: true,
      }),
    );
    expect(machine.snapshot().goalCause).toBeUndefined();
  });

  it('emits gaps, todo plans, and cumulative usage deterministically', () => {
    const machine = createTranscriptReplayMachine({
      gaps: [{ childUuid: 'assistant-1', missingParentUuid: 'missing' }],
    });
    const assistant = updates(
      machine,
      record('assistant-1', 'assistant', {
        message: { role: 'model', parts: [{ text: 'answer' }] },
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 3,
        },
      }),
    );
    expect(assistant.map((update) => update.sessionUpdate)).toEqual([
      'agent_message_chunk',
      'agent_message_chunk',
      'agent_message_chunk',
    ]);
    expect(
      assistant
        .slice(0, 2)
        .map(
          (update) =>
            (
              update._meta as
                | { qwenTranscript?: { segmentId?: string } }
                | undefined
            )?.qwenTranscript?.segmentId,
        ),
    ).toEqual(['assistant-1:0', 'assistant-1:1']);

    const plan = updates(
      machine,
      record('todo-result', 'tool_result', {
        message: {
          role: 'user',
          parts: [{ functionResponse: { name: 'todo_write', response: {} } }],
        },
        toolCallResult: {
          callId: 'todo-call',
          resultDisplay: {
            type: 'todo_list',
            planId: 'plan-1',
            sessionWorkflow: true,
            todos: [
              {
                id: 'ship',
                content: 'Ship it',
                status: 'completed',
                blockedBy: ['test'],
              },
            ],
          },
        },
      }),
    );
    expect(plan[0]).toMatchObject({
      sessionUpdate: 'plan',
      entries: [
        {
          content: 'Ship it',
          priority: 'medium',
          status: 'completed',
          _meta: {
            qwenTodo: { id: 'ship', blockedBy: ['test'] },
          },
        },
      ],
      _meta: {
        qwenSessionWorkflow: true,
        stats: {
          promptTokens: 5,
          candidateTokens: 3,
          cachedTokens: 0,
          apiTimeMs: 0,
        },
        qwenTodoPlan: { id: 'plan-1' },
        qwenTranscript: {
          planToolCallId: 'todo-call',
          sourceRecordIds: ['todo-result'],
        },
      },
    });
  });
});
