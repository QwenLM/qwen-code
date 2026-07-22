/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  prepareTranscriptRecords,
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

  it('accepts goal lifecycle and runtime records without completeness gaps', () => {
    const prepared = prepareTranscriptRecords([
      record('state', null, {
        type: 'system',
        subtype: 'goal_state',
        message: undefined,
        systemPayload: { v: 2 },
      }),
      record('runtime', 'state', {
        subtype: 'goal_runtime',
        message: { role: 'user', parts: [{ text: 'continue' }] },
      }),
    ]);

    expect(prepared.diagnostics).not.toContainEqual(
      expect.objectContaining({
        code: 'unknown_record_or_part',
        affectsCompleteness: true,
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
