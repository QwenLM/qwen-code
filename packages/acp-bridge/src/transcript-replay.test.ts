/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { summarizeReplay } from './replay-summary.js';
import {
  createTranscriptReplayMachine,
  createTranscriptToolCallResultUpdate,
  MISSING_TRANSCRIPT_TOOL_RESULT_MESSAGE,
  type TranscriptReplayStateV1,
} from './transcript-replay.js';
import type { TranscriptRecordInput } from '@qwen-code/qwen-code-core/transcriptRecords';
import {
  EVENT_API_ERROR,
  EVENT_API_RESPONSE,
  EVENT_TOOL_CALL,
} from '@qwen-code/qwen-code-core/telemetryConstants';
import {
  GOAL_PAUSE_REASON_COMMAND,
  type GoalRecord,
  type GoalStateCause,
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
  it('replays exported artifact descriptors with the slash command result', () => {
    const sessionArtifacts = [
      {
        kind: 'html',
        storage: 'workspace',
        title: 'export.html',
        workspacePath: 'export.html',
      },
    ];
    const projected = updates(
      createTranscriptReplayMachine(),
      goalCardRecord('export-result', {
        type: 'assistant',
        text: 'Session exported to HTML: export.html',
        sessionArtifacts,
      }),
    );
    expect(projected).toEqual([
      expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        _meta: expect.objectContaining({
          source: 'slash_command',
          sessionArtifacts,
        }),
      }),
    ]);
  });

  it('projects the daemon identity on every user block before a turn result', () => {
    const projected = updates(
      createTranscriptReplayMachine(),
      record('user-1', 'user', {
        daemonPromptId: 'daemon-prompt-1',
        message: {
          role: 'user',
          parts: [
            { text: 'model input' },
            { inlineData: { mimeType: 'image/png', data: 'AQID' } },
          ],
        },
        systemPayload: {
          displayText: 'visible input',
          hookContext: '',
          attachmentReferences: [
            {
              type: 'resource',
              attachmentId: 'notes.txt',
              mimeType: 'text/plain',
              size: 3,
            },
          ],
        },
      }),
    );
    expect(projected).toHaveLength(3);
    for (const update of projected) {
      expect(update.sessionUpdate).toBe('user_message_chunk');
      expect(update._meta).not.toHaveProperty('daemonPromptId');
      expect(update._meta).toMatchObject({
        promptId: 'daemon-prompt-1',
        qwenTranscript: { sourceRecordIds: ['user-1'] },
      });
    }
  });

  it('does not infer a prompt identity for legacy user records', () => {
    const projected = updates(
      createTranscriptReplayMachine(),
      record('legacy', 'user', {
        message: { role: 'user', parts: [{ text: 'same prompt' }] },
      }),
    );
    expect(projected).toHaveLength(1);
    expect(projected[0]?._meta?.['promptId']).toBeUndefined();
  });

  it('preserves background execution identity without leaking into the next record', () => {
    const machine = createTranscriptReplayMachine();
    const backgroundTurn = {
      turnId: 'notification-1',
      taskId: 'Explore-1',
      kind: 'agent',
      sourceTurnId: 'user-1',
      startedAt: 1000,
    };
    const backgroundRecord = {
      ...record('assistant-bg', 'assistant', {
        message: {
          role: 'model',
          parts: [{ text: 'result' }, { text: 'thought', thought: true }],
        },
      }),
      backgroundTurn,
    };
    const projected = updates(machine, backgroundRecord);
    expect(projected.length).toBeGreaterThan(0);
    for (const update of projected) {
      expect(update._meta?.['backgroundTurn']).toEqual(backgroundTurn);
    }
    const next = updates(
      machine,
      record('assistant-next', 'assistant', {
        message: { role: 'model', parts: [{ text: 'new response' }] },
      }),
    );
    expect(
      next.every((update) => update._meta?.['backgroundTurn'] === undefined),
    ).toBe(true);
  });

  it('replays task completion as session status rather than an automatic execution', () => {
    const backgroundTask = {
      taskId: 'Explore-1',
      kind: 'agent',
      status: 'completed',
    };
    const item = {
      ...record('completed-1', 'system', {
        subtype: 'background_task_completed',
        systemPayload: { displayText: 'Explore completed', backgroundTask },
      }),
      backgroundTurn: {
        turnId: 'unrelated',
        taskId: 'other',
        kind: 'agent',
        startedAt: 1000,
      },
    };
    const projected = updates(createTranscriptReplayMachine(), item);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Explore completed' },
      _meta: {
        source: 'background_task_completed',
        qwenDiscreteMessage: true,
        backgroundTask,
      },
    });
    expect(projected[0]._meta?.['backgroundTurn']).toBeUndefined();
  });

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

  it('replays only a typed pause as the user typing it', () => {
    // The runtime writes `pause` records of its own (the no-progress bound
    // stops an idle Goal with nobody at the keyboard). Replaying those as a
    // `/goal pause` the user typed would attribute the stop to the person
    // who was away; the paused card that follows carries the reason.
    const typed = updates(
      createTranscriptReplayMachine(),
      goalStateRecord('goal-pause-typed', 'pause', {
        ...GOAL,
        status: 'paused',
        lastReason: GOAL_PAUSE_REASON_COMMAND,
      }),
    );
    expect(typed).toHaveLength(2);
    expect(typed[0]).toMatchObject({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: '/goal pause' },
      _meta: { source: 'goal_control' },
    });

    const autonomous = updates(
      createTranscriptReplayMachine(),
      goalStateRecord('goal-pause-idle', 'pause', {
        ...GOAL,
        status: 'paused',
        lastReason:
          'Three Goal turns in a row recorded nothing to judge and no proposal.',
      }),
    );
    expect(autonomous).toHaveLength(1);
    expect(autonomous[0]).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      _meta: {
        goalStatus: { kind: 'paused' },
        'qwen.session.recordId': 'goal-pause-idle',
      },
    });

    // A record from before pauses carried reasons keeps its projection.
    const { lastReason: _reason, ...unreasoned } = GOAL;
    const legacy = updates(
      createTranscriptReplayMachine(),
      goalStateRecord('goal-pause-legacy', 'pause', {
        ...unreasoned,
        status: 'paused',
      }),
    );
    expect(legacy[0]).toMatchObject({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: '/goal pause' },
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

  it('emits one achieved card for a terminal goal_state, with no terminal twin', () => {
    const projected = updates(
      createTranscriptReplayMachine(),
      goalStateRecord('goal-complete', 'complete', {
        ...GOAL,
        status: 'complete',
      }),
    );

    expect(projected[0]?._meta).toMatchObject({
      goalStatus: {
        kind: 'achieved',
        condition: GOAL.objective,
        iterations: GOAL.turnCount,
        durationMs: GOAL.activeTimeMs,
      },
    });
    expect(projected[0]?._meta).not.toHaveProperty('goalTerminal');
  });

  it('carries a recorded compression payload back through replay', () => {
    const contextCompression = {
      phase: 'done',
      originalTokenCount: 200,
      newTokenCount: 100,
      originalTokenCountIsEstimated: false,
      newTokenCountIsEstimated: true,
    };
    const projected = updates(
      createTranscriptReplayMachine(),
      goalCardRecord('compress-1', {
        type: 'assistant',
        text: 'Compressing context...\nContext compressed (200 -> ~100).',
        contextCompression,
      }),
    );

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: 'Compressing context...  \nContext compressed (200 -> ~100).',
      },
    });
    expect(projected[0]?._meta).toMatchObject({
      source: 'slash_command',
      contextCompression,
    });
  });

  it('replays a recorded notice on its own key', () => {
    const notice = { phase: 'notice', instructionsLimit: 2000 };
    const projected = updates(
      createTranscriptReplayMachine(),
      goalCardRecord(
        'compress-notice-1',
        {
          type: 'assistant',
          text: 'Compression instructions were truncated to 2000 characters.\n',
          contextCompressionNotice: notice,
        },
        {
          type: 'assistant',
          text: 'Context compressed (200 -> 100).',
          contextCompression: {
            phase: 'done',
            originalTokenCount: 200,
            newTokenCount: 100,
          },
        },
      ),
    );

    // Both keys replay exactly as recorded, so the folded block keeps the note
    // beside the result without borrowing a marker other clients interpret.
    expect(projected).toHaveLength(2);
    expect(projected[0]?._meta).toMatchObject({
      source: 'slash_command',
      contextCompressionNotice: notice,
    });
    expect(projected[0]?._meta).not.toHaveProperty('qwenDiscreteMessage');
    expect(projected[0]?._meta).not.toHaveProperty('contextCompression');
    expect(
      projected
        .map((update) =>
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content.type === 'text'
            ? update.content.text
            : '',
        )
        .join(''),
    ).toBe(
      'Compression instructions were truncated to 2000 characters.  \nContext compressed (200 -> 100).',
    );
    expect(projected[1]?._meta).toMatchObject({
      source: 'slash_command',
      contextCompression: { phase: 'done' },
    });
  });

  it('keeps a slash-command record without a compression payload unchanged', () => {
    const projected = updates(
      createTranscriptReplayMachine(),
      goalCardRecord('command-1', { type: 'assistant', text: 'Plain output.' }),
    );

    expect(projected[0]?._meta).not.toHaveProperty('contextCompression');
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

    // As a build that still compressed evidence into checkpoints journaled
    // it: the parser accepts the old key and leaves it behind.
    const checkpointed: GoalRecord & { evidenceCheckpoint: unknown } = {
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

    const rejected = {
      ...checkpointed,
      lastReason: 'More work remains',
    };
    expect(
      updates(
        machine,
        goalStateRecord('goal-reject', 'verifier_reject', rejected),
      ),
    ).toHaveLength(1);

    const recommitted = {
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

    const { evidenceCheckpoint: _legacy, ...parsed } = recommitted;
    expect(machine.snapshot().goalState?.goal).toEqual(parsed);
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

  it.each([
    undefined,
    null,
    'invalid',
    {},
    { callId: '', subagentSessionReady: true },
    { callId: 1, subagentSessionReady: true },
    { callId: 'agent-1', subagentSessionReady: 'false' },
  ])('reports and skips malformed readiness payload %j', (systemPayload) => {
    const onDiagnostic = vi.fn();
    const machine = createTranscriptReplayMachine({ onDiagnostic });
    expect(
      updates(
        machine,
        record('ready-malformed', 'system', {
          subtype: 'agent_session_ready',
          systemPayload,
        }),
      ),
    ).toEqual([]);
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        code: 'malformed_agent_session_ready',
        recordId: 'ready-malformed',
        path: 'systemPayload',
      }),
    );
  });

  it.each([false, true])(
    'replays valid readiness %s without a diagnostic',
    (subagentSessionReady) => {
      const onDiagnostic = vi.fn();
      const machine = createTranscriptReplayMachine({ onDiagnostic });
      updates(
        machine,
        record('start', 'assistant', {
          message: {
            role: 'model',
            parts: [
              { functionCall: { id: 'agent-1', name: 'agent', args: {} } },
            ],
          },
        }),
      );
      expect(
        updates(
          machine,
          record('ready', 'system', {
            subtype: 'agent_session_ready',
            systemPayload: { callId: 'agent-1', subagentSessionReady },
          }),
        ),
      ).toEqual([
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'agent-1',
          _meta: expect.objectContaining({ subagentSessionReady }),
        }),
      ]);
      expect(onDiagnostic).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'reports and skips readiness %s without a matching tool start',
    (subagentSessionReady) => {
      const onDiagnostic = vi.fn();
      const machine = createTranscriptReplayMachine({ onDiagnostic });
      expect(
        updates(
          machine,
          record('orphan-ready', 'system', {
            subtype: 'agent_session_ready',
            systemPayload: { callId: 'missing-start', subagentSessionReady },
          }),
        ),
      ).toEqual([]);
      expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          code: 'orphan_agent_session_ready',
          recordId: 'orphan-ready',
          path: 'systemPayload.callId',
        }),
      );
    },
  );

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

  it.each([
    ['file', '@README.md'],
    ['mcp', '@mcp:o2'],
    ['extension', '@ext:browser'],
  ])('restores %s input annotations from saved user records', (kind, text) => {
    const inputAnnotations = [
      {
        type: 'reference',
        start: 0,
        end: text.length,
        text,
        reference: { id: text, kind, value: text.slice(1), serialized: text },
      },
    ];
    const projected = updates(
      createTranscriptReplayMachine(),
      record('user-tag', 'user', {
        daemonPromptId: 'tag-prompt',
        message: { role: 'user', parts: [{ text: 'expanded model input' }] },
        systemPayload: { displayText: text, hookContext: '', inputAnnotations },
      }),
    );

    expect(projected).toEqual([
      expect.objectContaining({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text },
        _meta: expect.objectContaining({
          inputAnnotations,
          promptId: 'tag-prompt',
          qwenTranscript: {
            sourceRecordIds: ['user-tag'],
            segmentId: 'user-tag:0',
          },
        }),
      }),
    ]);
  });

  it.each([undefined, null, 'invalid', {}, [null], ['x'], [[null]]])(
    'ignores missing or non-array saved input annotations (%j)',
    (inputAnnotations) => {
      const projected = updates(
        createTranscriptReplayMachine(),
        record('user-plain', 'user', {
          message: { role: 'user', parts: [{ text: '@README.md' }] },
          systemPayload: {
            displayText: '@README.md',
            hookContext: '',
            inputAnnotations,
          },
        }),
      );
      expect(projected[0]._meta).not.toHaveProperty('inputAnnotations');
      expect(projected[0]).toMatchObject({
        content: { type: 'text', text: '@README.md' },
      });
    },
  );

  it('forwards only object elements from saved input annotations', () => {
    const valid = {
      type: 'reference',
      start: 0,
      end: 10,
      text: '@README.md',
      reference: {
        id: '@README.md',
        kind: 'file',
        value: 'README.md',
        serialized: '@README.md',
      },
    };
    const projected = updates(
      createTranscriptReplayMachine(),
      record('user-mixed', 'user', {
        message: { role: 'user', parts: [{ text: '@README.md' }] },
        systemPayload: {
          displayText: '@README.md',
          hookContext: '',
          inputAnnotations: [valid, null, 'x'],
        },
      }),
    );
    expect(projected[0]._meta).toMatchObject({ inputAnnotations: [valid] });
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

    it.each(['read both', ''])(
      'replays original resource links with unchanged URIs and metadata (%j)',
      (text) => {
        const resourceLinks = [
          {
            type: 'resource_link',
            uri: 'transit://resource-a',
            name: 'notes.md',
            mimeType: 'text/markdown',
            size: 0,
            title: 'First notes',
            description: 'Original reference',
            annotations: { audience: ['user'], priority: 0.5 },
            _meta: { preview: { version: 1 } },
          },
          {
            type: 'resource_link',
            uri: 'https://example.com/notes.md',
            name: 'notes.md',
            mimeType: null,
          },
        ];
        const projected = updates(
          createTranscriptReplayMachine(),
          record('user-resource', 'user', {
            daemonPromptId: 'resource-prompt',
            message: {
              role: 'user',
              parts: [{ text: 'expanded model input' }],
            },
            systemPayload: {
              displayText: text,
              hookContext: '',
              resourceLinks,
            },
          }),
        );

        expect(
          projected.map((update) =>
            'content' in update ? update.content : update,
          ),
        ).toEqual([
          ...(text ? [{ type: 'text', text }] : []),
          ...resourceLinks,
        ]);
        for (const update of projected) {
          expect(update._meta).toMatchObject({
            promptId: 'resource-prompt',
            qwenTranscript: { sourceRecordIds: ['user-resource'] },
          });
        }
        const lastUpdate = projected.at(-1)!;
        expect(
          'content' in lastUpdate ? lastUpdate.content : lastUpdate,
        ).not.toBe(resourceLinks[1]);
      },
    );

    it('ignores invalid resource references and does not infer them from fileData', () => {
      const projected = updates(
        createTranscriptReplayMachine(),
        record('user-resource', 'user', {
          message: {
            role: 'user',
            parts: [
              { text: 'read' },
              { fileData: { fileUri: 'https://example.com/video.mp4' } },
            ],
          },
          systemPayload: {
            displayText: 'read',
            hookContext: '',
            resourceLinks: [
              null,
              { type: 'resource_link', uri: 'transit://x' },
              {
                type: 'resource_link',
                uri: '',
                name: 'empty',
              },
            ],
          },
        }),
      );

      expect(
        projected.map((update) =>
          'content' in update ? update.content : update,
        ),
      ).toEqual([{ type: 'text', text: 'read' }]);
    });

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

  it.each(['completed', 'failed', 'cancelled', 'timed_out'] as const)(
    'replays persisted structured shell %s results without flattening metadata',
    (outcome) => {
      const resultDisplay = {
        type: 'shell_result' as const,
        version: 1 as const,
        text: 'Display text differs from model envelope',
        output: outcome === 'completed' ? '' : 'partial 😀 output',
        directory: '/workspace/项目',
        exitCode: outcome === 'completed' ? 0 : null,
        signal: outcome === 'cancelled' ? 15 : null,
        pid: 42,
        error: outcome === 'failed' ? 'execution failed' : null,
        outcome,
        notices: ['Output persisted', 'Retained notice'],
        truncated: true,
        outputFiles: ['/tmp/shell-output.log'],
      };
      const projected = updates(
        createTranscriptReplayMachine(),
        record('shell-result', 'tool_result', {
          toolCallResult: {
            callId: 'shell-1',
            toolName: 'run_shell_command',
            status: outcome === 'completed' ? 'success' : 'error',
            resultDisplay,
          },
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'shell-1',
                  name: 'run_shell_command',
                  response: { output: 'Legacy model-facing envelope' },
                },
              },
            ],
          },
        }),
      );
      expect(projected).toHaveLength(1);
      expect(projected[0]).toMatchObject({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'shell-1',
        status: outcome === 'completed' ? 'completed' : 'failed',
        rawOutput: resultDisplay,
      });
      expect(projected[0]).toHaveProperty('rawOutput', resultDisplay);
    },
  );

  it('attributes persisted Agent usage to its parent and omits it in summary', () => {
    const machine = createTranscriptReplayMachine();
    const result = updates(
      machine,
      record('agent-result', 'tool_result', {
        toolCallResult: {
          callId: 'agent-1',
          toolName: 'agent',
          status: 'success',
          resultDisplay: {
            type: 'task_execution',
            result: 'done',
            executionSummary: {
              inputTokens: 100,
              outputTokens: 20,
              totalTokens: 120,
            },
          },
        },
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'agent-1',
                name: 'agent',
                response: { output: 'done' },
              },
            },
          ],
        },
      }),
    );
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      _meta: {
        parentToolCallId: 'agent-1',
        usage: { inputTokens: 100, outputTokens: 20 },
      },
    });
    const events = result.map((data, id) => ({
      id: id + 1,
      v: 1 as const,
      type: 'session_update',
      data,
    }));
    expect(summarizeReplay(events)).toHaveLength(1);
    expect(summarizeReplay(events)[0]?.data).toMatchObject({
      sessionUpdate: 'tool_call_update',
      rawOutput: { result: 'done', executionSummary: {} },
    });
    expect(machine.snapshot().cumulativeUsage.promptTokens).toBe(100);
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

describe('ui_telemetry timing frames', () => {
  const API_RESPONSE_EVENT = {
    'event.name': EVENT_API_RESPONSE,
    'event.timestamp': '2026-07-14T00:00:06.544Z',
    response_id: 'chatcmpl-abc',
    model: 'qwen3.8-max',
    status_code: 200,
    duration_ms: 6544,
    ttft_ms: 2344,
    input_token_count: 21309,
    output_token_count: 252,
    total_token_count: 21561,
    prompt_id: 'session-1########0',
    auth_type: 'openai',
    response_text: 'a long response body that must not ride along',
  };

  const TOOL_CALL_EVENT = {
    'event.name': EVENT_TOOL_CALL,
    'event.timestamp': '2026-07-14T00:00:06.560Z',
    call_id: 'call_glob_1',
    function_name: 'glob',
    function_args: { pattern: 'must not ride along' },
    duration_ms: 16,
    status: 'success',
    execution_status: 'success',
    success: true,
    prompt_id: 'session-1########0',
    response_id: 'chatcmpl-abc',
    tool_type: 'native',
  };

  function telemetry(
    uuid: string,
    uiEvent: Record<string, unknown>,
  ): TranscriptRecordInput {
    return record(uuid, 'system', {
      subtype: 'ui_telemetry',
      systemPayload: { uiEvent },
    });
  }

  function timingMachine() {
    return createTranscriptReplayMachine({ includeTiming: true });
  }

  function timings(
    machine: ReturnType<typeof createTranscriptReplayMachine>,
    item: TranscriptRecordInput,
  ) {
    return updates(machine, item).map(
      (update) =>
        (update as unknown as { _meta?: { timing?: Record<string, unknown> } })
          ._meta?.timing,
    );
  }

  function assistantWithToolCall(
    uuid: string,
    callId: string,
  ): TranscriptRecordInput {
    return record(uuid, 'assistant', {
      message: {
        role: 'model',
        parts: [{ functionCall: { id: callId, name: 'glob', args: {} } }],
      },
    });
  }

  it('emits nothing for telemetry records unless timing is requested', () => {
    const machine = createTranscriptReplayMachine();
    const diagnostics: unknown[] = [];
    const watched = createTranscriptReplayMachine({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(updates(machine, telemetry('t1', API_RESPONSE_EVENT))).toEqual([]);
    expect(updates(watched, telemetry('t2', TOOL_CALL_EVENT))).toEqual([]);
    expect(
      updates(
        createTranscriptReplayMachine({ includeTiming: false }),
        telemetry('t3', API_RESPONSE_EVENT),
      ),
    ).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it('leaves the projection byte-identical when timing is off', () => {
    const conversation = [
      record('user-1', 'user', {
        message: { role: 'user', parts: [{ text: 'hi' }] },
      }),
      telemetry('tel-1', API_RESPONSE_EVENT),
      record('assistant-1', 'assistant', {
        message: { role: 'model', parts: [{ text: 'hello' }] },
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
    ];
    const withTelemetry = createTranscriptReplayMachine();
    const withoutTelemetry = createTranscriptReplayMachine();

    const projectedWith = conversation.flatMap((item) =>
      updates(withTelemetry, item),
    );
    const projectedWithout = conversation
      .filter((item) => item.subtype !== 'ui_telemetry')
      .flatMap((item) => updates(withoutTelemetry, item));

    expect(projectedWith).toEqual(projectedWithout);
    expect(withTelemetry.snapshot()).toEqual(withoutTelemetry.snapshot());
  });

  it('projects a model request as an inert empty-text frame', () => {
    const projected = updates(
      timingMachine(),
      telemetry('tel-1', API_RESPONSE_EVENT),
    );

    expect(projected).toHaveLength(1);
    const update = projected[0] as unknown as {
      sessionUpdate: string;
      content: { type: string; text: string };
      _meta: Record<string, unknown>;
    };
    expect(update.sessionUpdate).toBe('agent_message_chunk');
    expect(update.content).toEqual({ type: 'text', text: '' });
    // The live-vs-replay discriminator must stay absent, or the daemon
    // metrics ring would count these replayed frames as live rounds.
    expect(update._meta['usage']).toBeUndefined();
    expect(update._meta['timing']).toEqual({
      kind: 'request',
      status: 'ok',
      durationMs: 6544,
      ttftMs: 2344,
      // event.timestamp marks the end of the span.
      startedAt: Date.parse('2026-07-14T00:00:06.544Z') - 6544,
      responseId: 'chatcmpl-abc',
      promptId: 'session-1########0',
      model: 'qwen3.8-max',
    });
  });

  it('carries the telemetry record as the emission source', () => {
    const emissions = [
      ...timingMachine().project(telemetry('tel-1', API_RESPONSE_EVENT)),
    ];

    expect(emissions).toHaveLength(1);
    expect(emissions[0]!.sourceRecordId).toBe('tel-1');
    expect(
      (
        emissions[0]!.update as unknown as {
          _meta: { qwenTranscript: { sourceRecordIds: string[] } };
        }
      )._meta.qwenTranscript.sourceRecordIds,
    ).toEqual(['tel-1']);
  });

  it('projects a tool call with its correlation keys', () => {
    expect(
      timings(timingMachine(), telemetry('tel-1', TOOL_CALL_EVENT)),
    ).toEqual([
      {
        kind: 'tool',
        durationMs: 16,
        callId: 'call_glob_1',
        toolName: 'glob',
        toolStatus: 'success',
        responseId: 'chatcmpl-abc',
        promptId: 'session-1########0',
      },
    ]);
  });

  it('uses recorded tool starts instead of the later batch log timestamp', () => {
    const machine = timingMachine();
    const starts = [1_760_000_000_000, 1_760_000_010_000];
    const frames = starts.flatMap((startedAt, index) =>
      timings(
        machine,
        telemetry(`timed-${index}`, {
          ...TOOL_CALL_EVENT,
          call_id: `timed-${index}`,
          started_at: startedAt,
          duration_ms: 4_000,
        }),
      ),
    );
    expect(
      frames.map((frame) => [frame?.['startedAt'], frame?.['durationMs']]),
    ).toEqual(starts.map((startedAt) => [startedAt, 4_000]));
    const [legacy] = timings(machine, telemetry('legacy', TOOL_CALL_EVENT));
    expect(legacy).not.toHaveProperty('startedAt');
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, '1760000000000'])(
    'omits an invalid recorded tool start: %s',
    (started_at) => {
      const [frame] = timings(
        timingMachine(),
        telemetry('invalid-start', { ...TOOL_CALL_EVENT, started_at }),
      );
      expect(frame).not.toHaveProperty('startedAt');
      expect(frame).toMatchObject({ kind: 'tool', durationMs: 16 });
    },
  );

  it('omits bulky recorded fields the conversation already carries', () => {
    const [requestTiming] = timings(
      timingMachine(),
      telemetry('tel-1', API_RESPONSE_EVENT),
    );
    const [toolTiming] = timings(
      timingMachine(),
      telemetry('tel-2', TOOL_CALL_EVENT),
    );

    expect(requestTiming).not.toHaveProperty('response_text');
    expect(requestTiming).not.toHaveProperty('input_token_count');
    expect(toolTiming).not.toHaveProperty('function_args');
  });

  it('marks a failed request without inventing a TTFT', () => {
    expect(
      timings(
        timingMachine(),
        telemetry('tel-1', {
          'event.name': EVENT_API_ERROR,
          'event.timestamp': '2026-07-14T00:00:02.000Z',
          response_id: 'chatcmpl-err',
          model: 'qwen3.8-max',
          duration_ms: 1200,
          prompt_id: 'session-1########0',
          error_message: 'Request failed with status 429',
          status_code: 429,
        }),
      ),
    ).toEqual([
      {
        kind: 'request',
        status: 'error',
        durationMs: 1200,
        startedAt: Date.parse('2026-07-14T00:00:02.000Z') - 1200,
        responseId: 'chatcmpl-err',
        promptId: 'session-1########0',
        model: 'qwen3.8-max',
      },
    ]);
  });

  it('keeps a subagent identity so nesting can be decoded downstream', () => {
    const subagentPromptId = 'session-1#general-purpose-call_parent#0';
    const [requestTiming] = timings(
      timingMachine(),
      telemetry('tel-1', {
        ...API_RESPONSE_EVENT,
        prompt_id: subagentPromptId,
        subagent_id: 'general-purpose-call_parent',
        subagent_name: 'general-purpose',
        subagent_type: 'general-purpose',
      }),
    );

    expect(requestTiming).toMatchObject({
      kind: 'request',
      promptId: subagentPromptId,
      subagentId: 'general-purpose-call_parent',
    });
  });

  it('re-points a tool frame at a rewritten call id', () => {
    const machine = timingMachine();
    // Two assistant records reusing one recorded call id: the second
    // allocation collides and the machine rewrites it. Once the first call's
    // result has closed it out, the rewritten one is the only holder of the
    // recorded id left, so the frame must follow it.
    updates(machine, assistantWithToolCall('assistant-1', 'call_dup'));
    const rewritten = updates(
      machine,
      assistantWithToolCall('assistant-2', 'call_dup'),
    );
    const rewrittenCallId = (rewritten[0] as unknown as { toolCallId: string })
      .toolCallId;
    expect(rewrittenCallId).not.toBe('call_dup');
    updates(
      machine,
      record('result-1', 'tool_result', {
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: { id: 'call_dup', name: 'glob', response: {} },
            },
          ],
        },
        toolCallResult: { callId: 'call_dup', status: 'success' },
      }),
    );

    const [toolTiming] = timings(
      machine,
      telemetry('tel-1', { ...TOOL_CALL_EVENT, call_id: 'call_dup' }),
    );

    expect(toolTiming).toMatchObject({ callId: rewrittenCallId });
  });

  it('passes a subagent tool id through untouched', () => {
    const machine = timingMachine();
    updates(machine, assistantWithToolCall('assistant-1', 'call_parent'));

    const [toolTiming] = timings(
      machine,
      telemetry('tel-1', { ...TOOL_CALL_EVENT, call_id: 'call_subagent_own' }),
    );

    expect(toolTiming).toMatchObject({ callId: 'call_subagent_own' });
  });

  it('never lets a subagent tool claim a main-session call', () => {
    // The shape real data has: `logToolCall` attaches no subagent identity, so
    // only the prompt id marks the round as a subagent's. With a provider that
    // reuses `call_0`, the Agent call is rewritten to `call_0:2` and a tool
    // inside the subagent reports plain `call_0` first.
    const machine = timingMachine();
    updates(machine, assistantWithToolCall('assistant-1', 'call_0'));
    const agentCall = updates(
      machine,
      assistantWithToolCall('assistant-2', 'call_0'),
    );
    const agentCallId = (agentCall[0] as unknown as { toolCallId: string })
      .toolCallId;

    const [subagentTiming] = timings(
      machine,
      telemetry('tel-1', {
        ...TOOL_CALL_EVENT,
        call_id: 'call_0',
        prompt_id: 'session-1#general-purpose-call_0#0',
      }),
    );

    expect(subagentTiming).toMatchObject({ callId: 'call_0' });
    expect(subagentTiming).not.toMatchObject({ callId: agentCallId });

    // And the Agent call's own frame is still free to claim it afterwards.
    const [mainTiming] = timings(
      machine,
      telemetry('tel-2', { ...TOOL_CALL_EVENT, call_id: 'call_0' }),
    );
    expect(mainTiming).toMatchObject({ callId: 'call_0' });
  });

  it('requires the tool name to agree before claiming a call', () => {
    const machine = timingMachine();
    updates(machine, assistantWithToolCall('assistant-1', 'call_0'));
    const second = updates(
      machine,
      assistantWithToolCall('assistant-2', 'call_0'),
    );
    const rewrittenCallId = (second[0] as unknown as { toolCallId: string })
      .toolCallId;

    const [other] = timings(
      machine,
      telemetry('tel-1', {
        ...TOOL_CALL_EVENT,
        call_id: 'call_0',
        function_name: 'run_shell_command',
      }),
    );

    // Neither allocation is a `run_shell_command`, so nothing is claimed.
    expect(other).toMatchObject({ callId: 'call_0' });
    const [glob] = timings(
      machine,
      telemetry('tel-2', { ...TOOL_CALL_EVENT, call_id: 'call_0' }),
    );
    expect(glob).toMatchObject({ callId: 'call_0' });
    const [nextGlob] = timings(
      machine,
      telemetry('tel-3', { ...TOOL_CALL_EVENT, call_id: 'call_0' }),
    );
    expect(nextGlob).toMatchObject({ callId: rewrittenCallId });
  });

  it.each([
    ['a missing duration', { duration_ms: undefined }],
    ['a non-numeric duration', { duration_ms: '6544' }],
    ['a negative duration', { duration_ms: -1 }],
    ['a NaN duration', { duration_ms: Number.NaN }],
  ])('emits no frame for %s', (_label, overrides) => {
    expect(
      updates(
        timingMachine(),
        telemetry('tel-1', { ...API_RESPONSE_EVENT, ...overrides }),
      ),
    ).toEqual([]);
  });

  it.each([
    ['an unknown event name', { 'event.name': 'qwen-code.user_prompt' }],
    ['a missing event name', { 'event.name': undefined }],
  ])('emits no frame for %s', (_label, overrides) => {
    const diagnostics: unknown[] = [];
    const machine = createTranscriptReplayMachine({
      includeTiming: true,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(
      updates(
        machine,
        telemetry('tel-1', { ...API_RESPONSE_EVENT, ...overrides }),
      ),
    ).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it.each([
    ['a missing payload', undefined],
    ['a payload without uiEvent', {}],
    ['a non-object uiEvent', { uiEvent: 'nope' }],
  ])('emits no frame for %s', (_label, systemPayload) => {
    expect(
      updates(
        timingMachine(),
        record('tel-1', 'system', { subtype: 'ui_telemetry', systemPayload }),
      ),
    ).toEqual([]);
  });

  it('emits no frame for a tool call without a call id', () => {
    expect(
      updates(
        timingMachine(),
        telemetry('tel-1', { ...TOOL_CALL_EVENT, call_id: undefined }),
      ),
    ).toEqual([]);
  });

  it.each([
    ['a TTFT longer than the request', 9000],
    ['a negative TTFT', -5],
    ['a non-numeric TTFT', '2344'],
  ])('drops %s but keeps the frame', (_label, ttft) => {
    const [requestTiming] = timings(
      timingMachine(),
      telemetry('tel-1', { ...API_RESPONSE_EVENT, ttft_ms: ttft }),
    );

    expect(requestTiming).toMatchObject({ kind: 'request', durationMs: 6544 });
    expect(requestTiming).not.toHaveProperty('ttftMs');
  });

  it('drops an unparsable end time but keeps the frame', () => {
    const [requestTiming] = timings(
      timingMachine(),
      telemetry('tel-1', { ...API_RESPONSE_EVENT, 'event.timestamp': 'nope' }),
    );

    expect(requestTiming).toMatchObject({ kind: 'request', durationMs: 6544 });
    expect(requestTiming).not.toHaveProperty('startedAt');
  });

  it.each([
    ['an unknown tool status', 'timed_out'],
    ['a non-string tool status', 7],
  ])('drops %s but keeps the frame', (_label, status) => {
    const [toolTiming] = timings(
      timingMachine(),
      telemetry('tel-1', { ...TOOL_CALL_EVENT, status }),
    );

    expect(toolTiming).toMatchObject({ kind: 'tool', callId: 'call_glob_1' });
    expect(toolTiming).not.toHaveProperty('toolStatus');
  });

  it('survives a page split between a request and its assistant record', () => {
    // A backward page may start exactly at the assistant record, stranding
    // its api_response record on the older page. Frames are emitted in place,
    // so splitting there must lose nothing.
    const page = [
      telemetry('tel-1', API_RESPONSE_EVENT),
      record('assistant-1', 'assistant', {
        message: { role: 'model', parts: [{ text: 'hello' }] },
      }),
      telemetry('tel-2', TOOL_CALL_EVENT),
    ];

    const whole = timingMachine();
    const wholeTimings = page.flatMap((item) => timings(whole, item));

    const older = timingMachine();
    const newer = timingMachine();
    const splitTimings = [
      ...timings(older, page[0]!),
      ...page.slice(1).flatMap((item) => timings(newer, item)),
    ];

    expect(splitTimings).toEqual(wholeTimings);
    expect(wholeTimings.filter(Boolean)).toHaveLength(2);
  });

  it('does not break the assistant text segment it sits inside', () => {
    const conversation = (machine: ReturnType<typeof timingMachine>) => [
      ...updates(
        machine,
        record('assistant-1', 'assistant', {
          message: { role: 'model', parts: [{ text: 'first' }] },
        }),
      ),
      ...updates(machine, telemetry('tel-1', API_RESPONSE_EVENT)),
      ...updates(
        machine,
        record('assistant-2', 'assistant', {
          message: { role: 'model', parts: [{ text: 'second' }] },
        }),
      ),
    ];
    const segmentIds = (projected: ReturnType<typeof conversation>) =>
      projected
        .filter(
          (update) =>
            (update as unknown as { content?: { text?: string } }).content
              ?.text,
        )
        .map(
          (update) =>
            (
              update as unknown as {
                _meta?: { qwenTranscript?: { segmentId?: string } };
              }
            )._meta?.qwenTranscript?.segmentId,
        );

    const withTiming = segmentIds(conversation(timingMachine()));
    const withoutTiming = segmentIds(
      conversation(
        createTranscriptReplayMachine() as ReturnType<typeof timingMachine>,
      ).filter((update) => {
        const meta = (update as unknown as { _meta?: { timing?: unknown } })
          ._meta;
        return meta?.timing === undefined;
      }),
    );

    expect(withTiming).toEqual(withoutTiming);
  });

  it('keeps timing frames out of the replay state when it is off', () => {
    const conversation = [
      telemetry('tel-1', API_RESPONSE_EVENT),
      assistantWithToolCall('assistant-1', 'call_glob_1'),
      telemetry('tel-2', TOOL_CALL_EVENT),
    ];
    const off = createTranscriptReplayMachine();
    const withoutTelemetry = createTranscriptReplayMachine();
    for (const item of conversation) {
      updates(off, item);
      if (item.subtype !== 'ui_telemetry') updates(withoutTelemetry, item);
    }

    expect(off.snapshot()).toEqual(withoutTelemetry.snapshot());
  });

  it('records only the claim flag in the replay state when it is on', () => {
    // The one state change timing makes: the claimed call is flagged so a
    // later page cannot hand the same allocation a second frame.
    const conversation = [
      telemetry('tel-1', API_RESPONSE_EVENT),
      assistantWithToolCall('assistant-1', 'call_glob_1'),
      telemetry('tel-2', TOOL_CALL_EVENT),
    ];
    const on = timingMachine();
    const off = createTranscriptReplayMachine();
    for (const item of conversation) {
      updates(on, item);
      updates(off, item);
    }
    const base = off.snapshot();

    expect(on.snapshot()).toEqual({
      ...base,
      pendingToolCalls: base.pendingToolCalls.map((pending) => ({
        ...pending,
        timingMatched: true,
      })),
    });
  });

  it('derives no tool start time when the record carries none', () => {
    // logToolCall runs in one loop after the whole batch settles, so the
    // recorded timestamp is the batch's end for every tool in it. Subtracting
    // a fast tool's own duration from that would place it just before the
    // batch ended rather than when it ran — so a record written before
    // `started_at_ms` existed gets no start at all.
    const [toolTiming] = timings(
      timingMachine(),
      telemetry('tel-1', TOOL_CALL_EVENT),
    );

    expect(toolTiming).toMatchObject({ kind: 'tool', durationMs: 16 });
    expect(toolTiming).not.toHaveProperty('startedAt');
  });

  it('carries the start time a tool record measured', () => {
    // The shape a scheduled batch leaves behind: this call started at :01 and
    // took 16 ms, but was only logged at :06.560 when its batch settled. The
    // start must be the recorded one, not the log time minus the duration.
    const startedAtMs = Date.parse('2026-07-14T00:00:01.000Z');
    const [toolTiming] = timings(
      timingMachine(),
      telemetry('tel-1', {
        ...TOOL_CALL_EVENT,
        started_at_ms: startedAtMs,
        started_at: startedAtMs - 1000,
      }),
    );

    expect(toolTiming).toMatchObject({
      kind: 'tool',
      durationMs: 16,
      startedAt: startedAtMs,
    });
  });

  it.each([
    ['negative', -1],
    ['not a number', Number.NaN],
    ['a string', '2026-07-14T00:00:01.000Z'],
  ])('drops a recorded tool start that is %s', (_label, value) => {
    const [toolTiming] = timings(
      timingMachine(),
      telemetry('tel-1', { ...TOOL_CALL_EVENT, started_at_ms: value }),
    );

    expect(toolTiming).toMatchObject({ kind: 'tool', durationMs: 16 });
    expect(toolTiming).not.toHaveProperty('startedAt');
  });

  it('still derives a start time for a request', () => {
    // A request is logged the moment its own stream ends, so the subtraction
    // is sound there.
    const [requestTiming] = timings(
      timingMachine(),
      telemetry('tel-1', API_RESPONSE_EVENT),
    );

    expect(requestTiming).toMatchObject({
      startedAt: Date.parse('2026-07-14T00:00:06.544Z') - 6544,
    });
  });

  it.each([
    ['denied at confirmation', 'error'],
    ['cancelled before it ran', 'cancelled'],
    ['an unrecognized status', 'timed_out'],
  ])('emits no tool frame for a zero duration on %s', (_label, status) => {
    // `ToolCallEvent` writes 0 when a call never ran, so a zero on anything
    // but a success is a placeholder rather than a measurement.
    expect(
      updates(
        timingMachine(),
        telemetry('tel-1', {
          ...TOOL_CALL_EVENT,
          duration_ms: 0,
          status,
        }),
      ),
    ).toEqual([]);
  });

  it('keeps a zero duration reported by a successful tool', () => {
    const [toolTiming] = timings(
      timingMachine(),
      telemetry('tel-1', { ...TOOL_CALL_EVENT, duration_ms: 0 }),
    );

    expect(toolTiming).toMatchObject({ kind: 'tool', durationMs: 0 });
  });

  it.each([
    ['error', 'started_at_ms'],
    ['cancelled', 'started_at_ms'],
    ['error', 'started_at'],
    ['cancelled', 'started_at'],
  ] as const)(
    'keeps measured zero duration and status for %s with recorded %s',
    (status, startField) => {
      const [toolTiming] = timings(
        timingMachine(),
        telemetry('measured-zero', {
          ...TOOL_CALL_EVENT,
          duration_ms: 0,
          [startField]: 1_760_000_000_000,
          status,
        }),
      );
      expect(toolTiming).toMatchObject({
        kind: 'tool',
        durationMs: 0,
        startedAt: 1_760_000_000_000,
        toolStatus: status,
      });
    },
  );

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, '1760000000000'])(
    'does not treat an invalid start as measured zero timing: %s',
    (started_at) => {
      expect(
        timings(
          timingMachine(),
          telemetry('invalid-zero', {
            ...TOOL_CALL_EVENT,
            duration_ms: 0,
            started_at,
            status: 'cancelled',
          }),
        ),
      ).toEqual([]);
    },
  );

  it('consumes duplicate recorded ids in allocation order', () => {
    // Two calls recorded under one id: the first keeps it, the second is
    // rewritten. Each telemetry record must claim its own allocation.
    const machine = timingMachine();
    updates(machine, assistantWithToolCall('assistant-1', 'call_dup'));
    const second = updates(
      machine,
      assistantWithToolCall('assistant-2', 'call_dup'),
    );
    const rewrittenCallId = (second[0] as unknown as { toolCallId: string })
      .toolCallId;
    expect(rewrittenCallId).not.toBe('call_dup');

    const first = timings(
      machine,
      telemetry('tel-1', { ...TOOL_CALL_EVENT, call_id: 'call_dup' }),
    );
    const next = timings(
      machine,
      telemetry('tel-2', { ...TOOL_CALL_EVENT, call_id: 'call_dup' }),
    );

    expect(first[0]).toMatchObject({ callId: 'call_dup' });
    expect(next[0]).toMatchObject({ callId: rewrittenCallId });
  });

  it('resolves a rewritten id from a telemetry record on a later page', () => {
    // A page can end right after the assistant record, leaving the tool's
    // telemetry for the next one, which replays from the serialized state.
    const first = timingMachine();
    updates(first, assistantWithToolCall('assistant-1', 'call_dup'));
    const rewritten = updates(
      first,
      assistantWithToolCall('assistant-2', 'call_dup'),
    );
    const rewrittenCallId = (rewritten[0] as unknown as { toolCallId: string })
      .toolCallId;

    const carried = JSON.parse(
      JSON.stringify(first.snapshot()),
    ) as TranscriptReplayStateV1;
    expect(carried.pendingToolCalls).toContainEqual(
      expect.objectContaining({ rawCallId: 'call_dup' }),
    );

    const next = createTranscriptReplayMachine({
      includeTiming: true,
      initialState: carried,
    });
    const firstFrame = timings(
      next,
      telemetry('tel-1', { ...TOOL_CALL_EVENT, call_id: 'call_dup' }),
    );
    const secondFrame = timings(
      next,
      telemetry('tel-2', { ...TOOL_CALL_EVENT, call_id: 'call_dup' }),
    );

    expect(firstFrame[0]).toMatchObject({ callId: 'call_dup' });
    expect(secondFrame[0]).toMatchObject({ callId: rewrittenCallId });
  });

  it('pairs reused bridge call ids with resolved tool names across page state', () => {
    const first = timingMachine();
    const target = 'mcp__yuque__yuque_whoami';
    const starts = ['assistant-1', 'assistant-2'].map((uuid) =>
      updates(
        first,
        record(uuid, 'assistant', {
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'bridge-dup',
                  name: 'tool_call',
                  args: { name: target, arguments: {} },
                },
              },
            ],
          },
        }),
      ),
    );
    const callIds = starts.map(
      (items) => (items[0] as unknown as { toolCallId: string }).toolCallId,
    );
    expect(callIds[0]).not.toBe(callIds[1]);
    const carried = JSON.parse(
      JSON.stringify(first.snapshot()),
    ) as TranscriptReplayStateV1;
    expect(carried.pendingToolCalls).toEqual([
      expect.objectContaining({
        toolName: 'tool_call',
        resolvedToolName: target,
      }),
      expect.objectContaining({
        toolName: 'tool_call',
        resolvedToolName: target,
        rawCallId: 'bridge-dup',
      }),
    ]);
    const next = createTranscriptReplayMachine({
      includeTiming: true,
      initialState: carried,
    });
    const frames = [515, 42].map(
      (duration_ms, index) =>
        timings(
          next,
          telemetry(`bridge-timing-${index}`, {
            ...TOOL_CALL_EVENT,
            call_id: 'bridge-dup',
            function_name: target,
            duration_ms,
          }),
        )[0],
    );
    expect(frames).toMatchObject([
      { callId: callIds[0], toolName: target, durationMs: 515 },
      { callId: callIds[1], toolName: target, durationMs: 42 },
    ]);
  });

  it('does not re-claim a call already matched on an earlier page', () => {
    const first = timingMachine();
    updates(first, assistantWithToolCall('assistant-1', 'call_dup'));
    updates(first, assistantWithToolCall('assistant-2', 'call_dup'));
    timings(
      first,
      telemetry('tel-1', { ...TOOL_CALL_EVENT, call_id: 'call_dup' }),
    );

    const carried = JSON.parse(
      JSON.stringify(first.snapshot()),
    ) as TranscriptReplayStateV1;
    const next = createTranscriptReplayMachine({
      includeTiming: true,
      initialState: carried,
    });
    const [later] = timings(
      next,
      telemetry('tel-2', { ...TOOL_CALL_EVENT, call_id: 'call_dup' }),
    );

    expect(later).not.toMatchObject({ callId: 'call_dup' });
  });

  it('pins the telemetry event names to core', () => {
    expect([EVENT_API_RESPONSE, EVENT_API_ERROR, EVENT_TOOL_CALL]).toEqual([
      'qwen-code.api_response',
      'qwen-code.api_error',
      'qwen-code.tool_call',
    ]);
  });
});

it('keeps raw wrapper timings attached to distinct replay ids across snapshots', () => {
  const initial = createTranscriptReplayMachine({ includeTiming: true });
  const calls = ['first', 'second'].flatMap((uuid) =>
    updates(
      initial,
      record(uuid, 'assistant', {
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'duplicate',
                name: 'tool_call',
                args: { name: 'mcp__server__lookup', arguments: {} },
              },
            },
          ],
        },
      }),
    ),
  );
  expect(calls).toMatchObject([
    { toolCallId: 'duplicate' },
    { toolCallId: 'duplicate:2' },
  ]);
  const resumed = createTranscriptReplayMachine({
    includeTiming: true,
    initialState: JSON.parse(JSON.stringify(initial.snapshot())),
  });
  const timings = [800, 900].flatMap((durationMs, index) =>
    updates(
      resumed,
      record(`timing-${index}`, 'system', {
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': EVENT_TOOL_CALL,
            call_id: 'duplicate',
            function_name: 'tool_call',
            status: 'cancelled',
            duration_ms: durationMs,
          },
        },
      }),
    ),
  );
  expect(timings).toMatchObject([
    { _meta: { timing: { callId: 'duplicate', durationMs: 800 } } },
    { _meta: { timing: { callId: 'duplicate:2', durationMs: 900 } } },
  ]);
});

it('marks goal runtime text as injected within the existing turn', () => {
  const machine = createTranscriptReplayMachine();
  expect(
    updates(
      machine,
      record('goal', 'user', {
        subtype: 'goal_runtime',
        systemPayload: { displayText: 'Continue the goal' },
        message: { role: 'user', parts: [{ text: 'Continue the goal' }] },
      }),
    ),
  ).toMatchObject([{ _meta: { source: 'goal_runtime' } }]);
});
