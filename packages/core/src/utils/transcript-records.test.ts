/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  prepareTranscriptRecords,
  projectUserTranscriptForDisplay,
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

describe('prepareTranscriptRecords', () => {
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

    expect(prepared.records.map((item) => item.uuid)).toEqual([
      'root',
      'active',
    ]);
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

    expect(prepared.records.map((item) => item.uuid)).toEqual([
      'root',
      'reply',
    ]);
  });

  it('stops at a missing parent and reports a history gap', () => {
    const prepared = prepareTranscriptRecords([
      record('orphan', 'missing'),
      record('leaf', 'orphan'),
    ]);

    expect(prepared.records.map((item) => item.uuid)).toEqual([
      'orphan',
      'leaf',
    ]);
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

  it('accepts session source metadata as a known record subtype', () => {
    const prepared = prepareTranscriptRecords([
      record('source', null, {
        type: 'system',
        subtype: 'session_source',
        message: undefined,
        systemPayload: { sourceType: 'web', sourceId: 'demo' },
      }),
      record('root', 'source'),
    ]);

    expect(prepared.diagnostics).not.toContainEqual(
      expect.objectContaining({
        code: 'unknown_record_or_part',
        recordId: 'source',
        path: 'subtype',
      }),
    );
  });

  it('accepts the workflow agent retry marker as a known record subtype', () => {
    const prepared = prepareTranscriptRecords([
      record('root', null),
      record('retry', 'root', {
        type: 'system',
        subtype: 'agent_retry',
        message: undefined,
        systemPayload: { attempt: 2 },
      }),
    ]);

    expect(prepared.diagnostics).not.toContainEqual(
      expect.objectContaining({
        code: 'unknown_record_or_part',
        recordId: 'retry',
        path: 'subtype',
      }),
    );
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
      record('goal-state', null, {
        type: 'system',
        subtype: 'goal_state',
        message: undefined,
      }),
      record('goal-runtime', 'goal-state', {
        subtype: 'goal_runtime',
      }),
    ]);

    expect(prepared.diagnostics).not.toContainEqual(
      expect.objectContaining({
        code: 'unknown_record_or_part',
        path: 'subtype',
      }),
    );
  });

  it('accepts branch_checkpoint as a known record subtype', () => {
    const prepared = prepareTranscriptRecords([
      record('checkpoint', null, {
        type: 'system',
        subtype: 'branch_checkpoint',
        message: undefined,
        systemPayload: {
          assistantRecordUuid: 'a1b2c3d4-e5f6-1a2b-8c3d-4e5f6a7b8c9d',
          checkpointUuid: 'f9e8d7c6-b5a4-1f2e-9a3b-4c5d6e7f8a9b',
        },
      }),
      record('root', 'checkpoint'),
    ]);

    expect(prepared.diagnostics).not.toContainEqual(
      expect.objectContaining({
        code: 'unknown_record_or_part',
        path: 'subtype',
      }),
    );
  });

  it('rejects mixed sessions and an explicit artifact leaf', () => {
    expect(() =>
      prepareTranscriptRecords([
        record('a', null),
        record('b', 'a', { sessionId: 'session-2' }),
      ]),
    ).toThrowError(
      expect.objectContaining<Partial<TranscriptRecordPreparationError>>({
        code: 'mixed_session_ids',
      }),
    );

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
    ).toThrowError(
      expect.objectContaining<Partial<TranscriptRecordPreparationError>>({
        code: 'leaf_not_found',
      }),
    );
  });
});

describe('projectUserTranscriptForDisplay', () => {
  it('uses display metadata even when the display text is empty', () => {
    const imagePart = {
      inlineData: { mimeType: 'image/png', data: 'data' },
    };
    expect(
      projectUserTranscriptForDisplay({
        message: {
          parts: [
            imagePart,
            { text: wrapUserPromptSubmitContext('hook context') },
          ],
        },
        systemPayload: { displayText: '', hookContext: 'hook context' },
      }),
    ).toEqual({ displayText: '', parts: [imagePart] });
  });

  it('uses released single-field display metadata when the final tag proves provenance', () => {
    const imagePart = {
      inlineData: { mimeType: 'image/png', data: 'data' },
    };
    expect(
      projectUserTranscriptForDisplay({
        message: {
          parts: [
            imagePart,
            { text: 'expanded model prompt' },
            { text: wrapUserPromptSubmitContext('hook context') },
          ],
        },
        systemPayload: { displayText: 'raw @file prompt' },
      }),
    ).toEqual({ displayText: 'raw @file prompt', parts: [imagePart] });
  });

  it('does not treat notification display labels as user prompt metadata', () => {
    const modelPart = { text: 'notification model text' };
    expect(
      projectUserTranscriptForDisplay({
        message: { parts: [modelPart] },
        systemPayload: { displayText: 'Background agent completed' },
      }),
    ).toEqual({ displayText: undefined, parts: [modelPart] });
  });

  it('removes only a complete final tag-only context part', () => {
    const userPart = { text: 'user text' };
    expect(
      projectUserTranscriptForDisplay({
        message: {
          parts: [
            userPart,
            { text: wrapUserPromptSubmitContext('hook context') },
          ],
        },
      }),
    ).toEqual({ displayText: undefined, parts: [userPart] });
  });

  it('treats non-object system payloads as absent metadata', () => {
    const userPart = { text: 'user text' };
    const taggedPart = {
      text: wrapUserPromptSubmitContext('hook context'),
    };

    expect(
      projectUserTranscriptForDisplay({
        message: { parts: [userPart, taggedPart] },
        systemPayload: null,
      }),
    ).toEqual({ displayText: undefined, parts: [userPart] });
  });

  it('preserves legacy bare context and user-authored tag-like text', () => {
    const legacyParts = [{ text: 'user text' }, { text: 'bare hook context' }];
    expect(
      projectUserTranscriptForDisplay({
        message: { parts: legacyParts },
      }),
    ).toEqual({ displayText: undefined, parts: legacyParts });

    const userAuthoredTag = {
      text: wrapUserPromptSubmitContext('user-authored text'),
    };
    expect(
      projectUserTranscriptForDisplay({
        message: { parts: [userAuthoredTag] },
      }),
    ).toEqual({ displayText: undefined, parts: [userAuthoredTag] });
  });

  it('does not trust bare displayText without a final context tag', () => {
    const taggedPart = {
      text: '<qwen:user-prompt-submit-context>user-authored text</qwen:user-prompt-submit-context>',
    };
    expect(
      projectUserTranscriptForDisplay({
        message: { parts: [{ text: 'user text' }, taggedPart] },
        systemPayload: { displayText: 'notification label' },
      }),
    ).toEqual({
      displayText: undefined,
      parts: [{ text: 'user text' }, taggedPart],
    });
  });
});
