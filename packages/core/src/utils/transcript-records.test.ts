/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ChatRecord } from '../services/chatRecordingService.js';
import {
  isTranscriptConversationRecord,
  prepareTranscriptRecords,
  projectUserTranscriptForDisplay,
  validateTranscriptRecord,
  wrapUserPromptSubmitContext,
  type TranscriptRecordPreparationError,
} from './transcript-records.js';

function record(
  uuid: string,
  parentUuid: string | null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    uuid,
    parentUuid,
    sessionId: 'session-1',
    timestamp: '2026-07-14T00:00:00.000Z',
    type: 'user',
    message: { role: 'user', parts: [{ text: uuid }] },
    ...overrides,
  };
}

/** A message-less system record; `systemPayload` is left out when not given. */
function systemRecord(
  uuid: string,
  parentUuid: string | null,
  subtype: string,
  systemPayload?: Record<string, unknown>,
): Record<string, unknown> {
  return record(uuid, parentUuid, {
    type: 'system',
    subtype,
    message: undefined,
    ...(systemPayload === undefined ? {} : { systemPayload }),
  });
}

type Prepared = ReturnType<typeof prepareTranscriptRecords>;

const uuidsOf = (prepared: Prepared) =>
  prepared.records.map((item) => item.uuid);

/** Asserts no unknown-subtype diagnostic (for `recordId`, when given). */
function expectNoUnknownSubtype(prepared: Prepared, recordId?: string) {
  expect(prepared.diagnostics).not.toContainEqual(
    expect.objectContaining({
      code: 'unknown_record_or_part',
      ...(recordId === undefined ? {} : { recordId }),
      path: 'subtype',
    }),
  );
}

const errorWithCode = (code: TranscriptRecordPreparationError['code']) =>
  expect.objectContaining<Partial<TranscriptRecordPreparationError>>({ code });

describe('prepareTranscriptRecords', () => {
  it.each([undefined, '', '   ', 42, { id: 'untrusted' }])(
    'keeps user content readable without a valid daemonPromptId (%j)',
    (daemonPromptId) => {
      const prepared = prepareTranscriptRecords([
        record('user', null, { daemonPromptId }),
      ]);
      expect(prepared.records).toHaveLength(1);
      expect(prepared.records[0]?.daemonPromptId).toBeUndefined();
      expect(prepared.records[0]?.message?.parts).toEqual([{ text: 'user' }]);
    },
  );

  it('preserves distinct daemon identities for identical user prompts', () => {
    const message = { role: 'user', parts: [{ text: 'same prompt' }] };
    const prepared = prepareTranscriptRecords([
      record('first', null, { message, daemonPromptId: 'daemon-first' }),
      record('second', 'first', { message, daemonPromptId: 'daemon-second' }),
    ]);
    expect(prepared.records.map((item) => item.daemonPromptId)).toEqual([
      'daemon-first',
      'daemon-second',
    ]);
  });

  it('does not use CLI history prompt IDs as daemon identities', () => {
    const prepared = prepareTranscriptRecords([
      record('legacy', null, { promptId: 'session-1########42' }),
      record('current', 'legacy', {
        promptId: 'session-1########43',
        daemonPromptId: 'daemon-current',
      }),
    ]);
    expect(prepared.records.map((item) => item.daemonPromptId)).toEqual([
      undefined,
      'daemon-current',
    ]);
  });

  it('selects the active branch and aggregates same-uuid fragments', () => {
    const prepared = prepareTranscriptRecords([
      record('root', null),
      record('abandoned', 'root'),
      record('active', 'root', {
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'first' }] },
      }),
      record('active', 'root', {
        type: 'assistant',
        timestamp: '2026-07-14T00:00:01.000Z',
        message: { role: 'model', parts: [{ text: 'second' }] },
      }),
    ]);

    expect(uuidsOf(prepared)).toEqual(['root', 'active']);
    expect(prepared.records[1]?.message?.parts).toEqual([
      { text: 'first' },
      { text: 'second' },
    ]);
    expect(prepared.records[1]?.timestamp).toBe('2026-07-14T00:00:01.000Z');
  });

  it('ignores a trailing artifact when selecting the default leaf', () => {
    const prepared = prepareTranscriptRecords([
      record('root', null),
      record('reply', 'root', { type: 'assistant' }),
      record('artifact', 'reply', {
        type: 'system',
        subtype: 'session_artifact_event',
      }),
    ]);

    expect(uuidsOf(prepared)).toEqual(['root', 'reply']);
  });

  it('stops at a missing parent and reports a history gap', () => {
    const prepared = prepareTranscriptRecords([
      record('orphan', 'missing'),
      record('leaf', 'orphan'),
    ]);

    expect(uuidsOf(prepared)).toEqual(['orphan', 'leaf']);
    expect(prepared.gaps).toEqual([
      { childUuid: 'orphan', missingParentUuid: 'missing' },
    ]);
    expect(prepared.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'history_gap',
        affectsCompleteness: true,
      }),
    );
  });

  it('reports cycles and conflicting duplicate parents', () => {
    const prepared = prepareTranscriptRecords(
      [
        record('a', 'b'),
        record('b', 'a'),
        record('b', null, { message: undefined }),
      ],
      { leafUuid: 'a' },
    );

    expect(prepared.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['parent_cycle', 'conflicting_parent_uuid']),
    );
  });

  it('keeps valid records while diagnosing malformed siblings', () => {
    const prepared = prepareTranscriptRecords([
      null,
      record('root', null, { timestamp: 'not-a-date' }),
    ]);

    expect(prepared.records).toHaveLength(1);
    expect(prepared.records[0]?.timestamp).toBeUndefined();
    expect(prepared.diagnostics.map((item) => item.code)).toEqual([
      'invalid_record',
      'invalid_timestamp',
    ]);
  });

  it('keeps an unknown subtype but marks its content incomplete', () => {
    const prepared = prepareTranscriptRecords([
      record('root', null, { subtype: 'future_visible_record' }),
    ]);

    expect(prepared.records).toHaveLength(1);
    expect(prepared.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'unknown_record_or_part',
        affectsCompleteness: true,
        recordId: 'root',
        path: 'subtype',
      }),
    );
  });

  it('accepts background completion metadata without degrading restored history', () => {
    const prepared = prepareTranscriptRecords([
      systemRecord('completion', null, 'background_task_completed', {
        displayText: 'Task finished',
        backgroundTask: {
          taskId: 'agent-1',
          kind: 'agent',
          status: 'completed',
        },
      }),
      record('root', 'completion'),
    ]);
    expect(prepared.diagnostics).toEqual([]);
  });

  it('accepts Omni recall metadata without marking history incomplete', () => {
    const prepared = prepareTranscriptRecords([
      systemRecord('recall', null, 'omni_recall', {
        resourceIds: ['media-1'],
        selectedEntryIds: ['entry-1'],
      }),
      record('root', 'recall'),
    ]);
    expect(prepared.diagnostics).toEqual([]);
  });

  it('accepts session source metadata as a known record subtype', () => {
    const prepared = prepareTranscriptRecords([
      systemRecord('source', null, 'session_source', {
        sourceType: 'web',
        sourceId: 'demo',
      }),
      record('root', 'source'),
    ]);
    expectNoUnknownSubtype(prepared, 'source');
  });

  it('accepts session model metadata as a known record subtype', () => {
    const prepared = prepareTranscriptRecords([
      systemRecord('model', null, 'session_model', {
        modelId: 'qwen3-coder-plus',
        authType: 'openai',
      }),
      record('root', 'model'),
    ]);
    expectNoUnknownSubtype(prepared, 'model');
  });

  it('accepts session approval metadata as a known record subtype', () => {
    const prepared = prepareTranscriptRecords([
      record('approval', null, {
        type: 'system',
        subtype: 'session_approval_mode',
        message: undefined,
        systemPayload: { mode: 'yolo' },
      }),
      record('root', 'approval'),
    ]);

    expect(prepared.diagnostics).not.toContainEqual(
      expect.objectContaining({
        code: 'unknown_record_or_part',
        recordId: 'approval',
        path: 'subtype',
      }),
    );
  });

  it('accepts the workflow agent retry marker as a known record subtype', () => {
    const prepared = prepareTranscriptRecords([
      record('root', null),
      systemRecord('retry', 'root', 'agent_retry', { attempt: 2 }),
    ]);
    expectNoUnknownSubtype(prepared, 'retry');
  });

  it('accepts Realtime dialogue as a known record subtype', () => {
    const prepared = prepareTranscriptRecords([
      record('realtime-user', null, {
        subtype: 'realtime_message',
        message: { role: 'user', parts: [{ text: 'voice question' }] },
      }),
    ]);

    expect(prepared.records).toHaveLength(1);
    expect(prepared.diagnostics).toEqual([]);
  });

  it('accepts Goal state and runtime records as known subtypes', () => {
    const prepared = prepareTranscriptRecords([
      systemRecord('goal-state', null, 'goal_state'),
      record('goal-runtime', 'goal-state', { subtype: 'goal_runtime' }),
    ]);
    expectNoUnknownSubtype(prepared);
  });

  it('accepts branch_checkpoint as a known record subtype', () => {
    const prepared = prepareTranscriptRecords([
      systemRecord('checkpoint', null, 'branch_checkpoint', {
        assistantRecordUuid: 'a1b2c3d4-e5f6-1a2b-8c3d-4e5f6a7b8c9d',
        checkpointUuid: 'f9e8d7c6-b5a4-1f2e-9a3b-4c5d6e7f8a9b',
      }),
      record('root', 'checkpoint'),
    ]);
    expectNoUnknownSubtype(prepared);
  });

  it.each([
    'managed_session_header_v1',
    'managed_session_event_v1',
    'managed_session_commit_v1',
  ])('keeps %s out of ordinary conversation projection', (subtype) => {
    const prepared = prepareTranscriptRecords([
      record('root', null),
      systemRecord('managed', 'root', subtype, { managedSession: {} }),
    ]);

    expect(uuidsOf(prepared)).toEqual(['root']);
    expectNoUnknownSubtype(prepared, 'managed');
    expect(isTranscriptConversationRecord({ type: 'system', subtype })).toBe(
      false,
    );
  });

  it('rejects mixed sessions and an explicit artifact leaf', () => {
    expect(() =>
      prepareTranscriptRecords([
        record('a', null),
        record('b', 'a', { sessionId: 'session-2' }),
      ]),
    ).toThrowError(errorWithCode('mixed_session_ids'));

    expect(() =>
      prepareTranscriptRecords(
        [
          record('artifact', null, {
            type: 'system',
            subtype: 'session_artifact_snapshot',
          }),
        ],
        { leafUuid: 'artifact' },
      ),
    ).toThrowError(errorWithCode('leaf_not_found'));
  });
});

describe('projectUserTranscriptForDisplay', () => {
  /** Projects a user record; `systemPayload` is left out when not given. */
  const project = (parts: unknown[], systemPayload?: unknown) =>
    projectUserTranscriptForDisplay({
      message: { parts },
      ...(systemPayload === undefined ? {} : { systemPayload }),
    });
  const imagePart = () => ({
    inlineData: { mimeType: 'image/png', data: 'data' },
  });
  const hookTag = () => ({ text: wrapUserPromptSubmitContext('hook context') });

  it('uses display metadata even when the display text is empty', () => {
    expect(
      project([imagePart(), hookTag()], {
        displayText: '',
        hookContext: 'hook context',
      }),
    ).toEqual({ displayText: '', parts: [imagePart()] });
  });

  it('uses released single-field display metadata when the final tag proves provenance', () => {
    expect(
      project([imagePart(), { text: 'expanded model prompt' }, hookTag()], {
        displayText: 'raw @file prompt',
      }),
    ).toEqual({ displayText: 'raw @file prompt', parts: [imagePart()] });
  });

  it('does not treat notification display labels as user prompt metadata', () => {
    const modelPart = { text: 'notification model text' };
    expect(
      project([modelPart], { displayText: 'Background agent completed' }),
    ).toEqual({ displayText: undefined, parts: [modelPart] });
  });

  it('removes only a complete final tag-only context part', () => {
    const userPart = { text: 'user text' };
    expect(project([userPart, hookTag()])).toEqual({
      displayText: undefined,
      parts: [userPart],
    });
  });

  it('treats non-object system payloads as absent metadata', () => {
    const userPart = { text: 'user text' };
    expect(project([userPart, hookTag()], null)).toEqual({
      displayText: undefined,
      parts: [userPart],
    });
  });

  it('preserves legacy bare context and user-authored tag-like text', () => {
    const legacyParts = [{ text: 'user text' }, { text: 'bare hook context' }];
    expect(project(legacyParts)).toEqual({
      displayText: undefined,
      parts: legacyParts,
    });

    const userAuthoredTag = {
      text: wrapUserPromptSubmitContext('user-authored text'),
    };
    expect(project([userAuthoredTag])).toEqual({
      displayText: undefined,
      parts: [userAuthoredTag],
    });
  });

  it('does not trust bare displayText without a final context tag', () => {
    const taggedPart = {
      text: '<qwen:user-prompt-submit-context>user-authored text</qwen:user-prompt-submit-context>',
    };
    expect(
      project([{ text: 'user text' }, taggedPart], {
        displayText: 'notification label',
      }),
    ).toEqual({
      displayText: undefined,
      parts: [{ text: 'user text' }, taggedPart],
    });
  });
});

describe('validateTranscriptRecord', () => {
  // Typed as a total record, so a subtype added to ChatRecord fails to compile
  // here until it is listed, and then fails below until the validator knows it.
  // An unknown subtype makes the whole transcript incomplete, which a paired
  // host reads as unprovable ownership and refuses to restore.
  const RECORDED_SUBTYPES: Record<NonNullable<ChatRecord['subtype']>, true> = {
    chat_compression: true,
    slash_command: true,
    ui_telemetry: true,
    at_command: true,
    attribution_snapshot: true,
    notification: true,
    background_task_completed: true,
    cron: true,
    mid_turn_user_message: true,
    custom_title: true,
    parent_session: true,
    session_source: true,
    session_execution_engine: true,
    omni_recall: true,
    session_model: true,
    session_approval_mode: true,
    rewind: true,
    agent_bootstrap: true,
    agent_launch_prompt: true,
    agent_retry: true,
    agent_session_ready: true,
    file_history_snapshot: true,
    user_text_elements: true,
    session_artifact_event: true,
    session_artifact_snapshot: true,
    session_sources_snapshot: true,
    branch_checkpoint: true,
    goal_state: true,
    goal_runtime: true,
    goal_turn_end: true,
    code_mode_tool_result: true,
    realtime_message: true,
    turn_result: true,
    managed_session_header_v1: true,
    managed_session_event_v1: true,
    managed_session_commit_v1: true,
  };

  it.each(Object.keys(RECORDED_SUBTYPES))(
    'knows the recorded subtype %s',
    (subtype) => {
      const { diagnostics } = validateTranscriptRecord(
        record('system-record', null, { type: 'system', subtype }),
      );
      expect(
        diagnostics.filter((diagnostic) => diagnostic.path === 'subtype'),
      ).toEqual([]);
    },
  );

  // Likewise for record types.
  const RECORDED_TYPES: Record<ChatRecord['type'], true> = {
    user: true,
    assistant: true,
    tool_result: true,
    system: true,
  };

  it.each(Object.keys(RECORDED_TYPES))('knows the recorded type %s', (type) => {
    const { diagnostics } = validateTranscriptRecord(
      record(`${type}-record`, null, { type }),
    );
    expect(
      diagnostics.filter((diagnostic) =>
        diagnostic.message.includes('unknown record type'),
      ),
    ).toEqual([]);
  });

  it('still flags a record type nothing records', () => {
    const { diagnostics } = validateTranscriptRecord(
      record('unknown-record', null, { type: 'not_recorded' }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'unknown_record_or_part',
        message: expect.stringContaining('unknown record type'),
        affectsCompleteness: true,
      }),
    );
  });

  it('still flags a subtype nothing records', () => {
    const { diagnostics } = validateTranscriptRecord(
      record('system-record', null, {
        type: 'system',
        subtype: 'not_recorded',
      }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'unknown_record_or_part',
        path: 'subtype',
        affectsCompleteness: true,
      }),
    );
  });
});
