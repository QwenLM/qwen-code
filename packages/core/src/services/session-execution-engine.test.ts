/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  SessionExecutionEngineAccumulator,
  type SessionExecutionSnapshot,
} from './session-execution-engine.js';

const snapshot: SessionExecutionSnapshot = {
  filePath: '/tmp/session.jsonl',
  dev: 1,
  ino: 1,
  size: 4,
  lastUpdated: '2026-01-01T00:00:00.000Z',
};

function line(fields: Record<string, unknown>): string {
  return JSON.stringify({
    uuid: 'rec-1',
    parentUuid: null,
    sessionId: 's1',
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: '/workspace',
    version: 'test',
    ...fields,
  });
}

function userRecord(sessionId = 's1', uuid = 'rec-1'): string {
  return line({
    uuid,
    sessionId,
    type: 'user',
    message: { role: 'user', parts: [{ text: 'hello' }] },
  });
}

function ownerRecord(engine: string, version = 1, uuid = 'owner-1'): string {
  return line({
    uuid,
    type: 'system',
    subtype: 'session_execution_engine',
    systemPayload: { version, engine },
  });
}

describe('SessionExecutionEngineAccumulator', () => {
  it('reports an empty transcript as unavailable', () => {
    const accumulator = new SessionExecutionEngineAccumulator('s1');
    expect(accumulator.finish(snapshot)).toEqual({
      status: 'unavailable',
      sessionId: 's1',
      snapshot,
      reason: 'empty transcript',
    });
  });

  it('reports a record from another session as an invalid transcript record', () => {
    const accumulator = new SessionExecutionEngineAccumulator('s1');
    accumulator.parseLine(userRecord('other-session'), snapshot.filePath);
    expect(accumulator.finish(snapshot)).toEqual({
      status: 'unavailable',
      sessionId: 's1',
      snapshot,
      reason: 'invalid transcript record',
    });
  });

  it('reports a torn physical line as an incomplete transcript', () => {
    const accumulator = new SessionExecutionEngineAccumulator('s1');
    accumulator.parseLine('{"uuid":"rec-1', snapshot.filePath);
    expect(accumulator.sourceComplete).toBe(false);
    expect(accumulator.finish(snapshot)).toMatchObject({
      status: 'unavailable',
      reason: 'incomplete transcript',
    });
  });

  it('reports an owner record with an unknown version as invalid owner record', () => {
    const accumulator = new SessionExecutionEngineAccumulator('s1');
    accumulator.parseLine(ownerRecord('managed', 2), snapshot.filePath);
    expect(accumulator.finish(snapshot)).toMatchObject({
      status: 'unavailable',
      reason: 'invalid owner record',
    });
  });

  it('reports an owner record with an unknown engine as invalid owner record', () => {
    const accumulator = new SessionExecutionEngineAccumulator('s1');
    accumulator.parseLine(ownerRecord('hosted'), snapshot.filePath);
    expect(accumulator.finish(snapshot)).toMatchObject({
      status: 'unavailable',
      reason: 'invalid owner record',
    });
  });

  it('reports an owner record whose payload is not an object as invalid owner record', () => {
    const accumulator = new SessionExecutionEngineAccumulator('s1');
    expect(() =>
      accumulator.parseLine(
        line({
          type: 'system',
          subtype: 'session_execution_engine',
          systemPayload: 'managed',
        }),
        snapshot.filePath,
      ),
    ).not.toThrow();
    expect(accumulator.finish(snapshot)).toMatchObject({
      status: 'unavailable',
      reason: 'invalid owner record',
    });
  });

  it('reports two owner records naming different engines as conflicting owners', () => {
    const accumulator = new SessionExecutionEngineAccumulator('s1');
    accumulator.parseLine(
      ownerRecord('managed', 1, 'owner-1'),
      snapshot.filePath,
    );
    accumulator.parseLine(
      ownerRecord('legacy', 1, 'owner-2'),
      snapshot.filePath,
    );
    expect(accumulator.finish(snapshot)).toMatchObject({
      status: 'unavailable',
      reason: 'conflicting owners',
    });
  });

  it('verifies a complete legacy transcript with no owner record', () => {
    const accumulator = new SessionExecutionEngineAccumulator('s1');
    accumulator.parseLine(userRecord(), snapshot.filePath);
    expect(accumulator.finish(snapshot)).toEqual({
      status: 'verified',
      sessionId: 's1',
      snapshot,
      engine: 'legacy',
      recorded: false,
    });
  });

  it('verifies a transcript whose owner record names managed', () => {
    const accumulator = new SessionExecutionEngineAccumulator('s1');
    accumulator.parseLine(ownerRecord('managed'), snapshot.filePath);
    accumulator.parseLine(userRecord(), snapshot.filePath);
    expect(accumulator.finish(snapshot)).toEqual({
      status: 'verified',
      sessionId: 's1',
      snapshot,
      engine: 'managed',
      recorded: true,
    });
  });

  it('returns the raw value alongside the validated record', () => {
    const accumulator = new SessionExecutionEngineAccumulator('s1');
    const raw = line({
      sessionId: 's1',
      type: 'user',
      message: {
        role: 'user',
        parts: [{ text: 'hi' }],
        'kept-only-in-raw': true,
      },
    });
    // validateTranscriptRecord returns a fresh normalized object that
    // rebuilds `message` as {role, parts} only, so the two halves of the
    // pair are independently meaningful and each must be pinned.
    expect(accumulator.parseLine(raw, snapshot.filePath)).toEqual([
      {
        value: JSON.parse(raw),
        record: expect.objectContaining({
          uuid: 'rec-1',
          sessionId: 's1',
          message: { role: 'user', parts: [{ text: 'hi' }] },
        }),
      },
    ]);
  });

  it('keeps a slot for a physical record that fails validation', () => {
    const accumulator = new SessionExecutionEngineAccumulator('s1');
    const raw = JSON.stringify({ not: 'a transcript record' });
    // One entry per physical record, even when the record half is undefined:
    // buildIndex counts fragments over these slots and the snapshot reader
    // pushes every value, so the array must stay 1:1 with the parsed lines.
    expect(accumulator.parseLine(raw, snapshot.filePath)).toEqual([
      { value: JSON.parse(raw), record: undefined },
    ]);
  });
});
