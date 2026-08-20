/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { resolveTurn } from './turnResolver.js';
import type { ForkRecord } from './forkTranscript.js';

function userRec(uuid: string): ForkRecord {
  return { uuid, type: 'user', message: { role: 'user', parts: [] } };
}
function assistantRec(uuid: string): ForkRecord {
  return { uuid, type: 'assistant', message: { role: 'model', parts: [] } };
}
function compressionCheckpoint(uuid: string): ForkRecord {
  return { uuid, type: 'system', subtype: 'chat_compression' };
}

describe('resolveTurn', () => {
  it('rejects a negative toTurn as invalid_turn', () => {
    const result = resolveTurn([userRec('a')], -1);
    expect(result).toEqual({ ok: false, error: 'invalid_turn' });
  });

  it('rejects a non-integer toTurn as invalid_turn', () => {
    const result = resolveTurn([userRec('a')], 1.5);
    expect(result).toEqual({ ok: false, error: 'invalid_turn' });
  });

  it('rejects a non-number toTurn as invalid_turn', () => {
    const result = resolveTurn([userRec('a')], 'nope' as unknown as number);
    expect(result).toEqual({ ok: false, error: 'invalid_turn' });
  });

  it('toTurn=0 truncates to the index of the very first user record', () => {
    const records = [userRec('u0'), assistantRec('a0'), userRec('u1')];
    const result = resolveTurn(records, 0);
    expect(result).toEqual({
      ok: true,
      targetTurnIndex: 0,
      addressableTurnCount: 2,
      truncatedEventId: 0,
    });
  });

  it('a mid-conversation toTurn truncates at the Nth user record', () => {
    const records = [
      userRec('u0'), // index 0 — turn 0
      assistantRec('a0'), // index 1
      userRec('u1'), // index 2 — turn 1
      assistantRec('a1'), // index 3
      userRec('u2'), // index 4 — turn 2
      assistantRec('a2'), // index 5
    ];
    const result = resolveTurn(records, 1);
    expect(result).toEqual({
      ok: true,
      targetTurnIndex: 1,
      addressableTurnCount: 3,
      truncatedEventId: 2,
    });
  });

  it('toTurn equal to the last turn keeps the whole transcript (tip)', () => {
    const records = [
      userRec('u0'),
      assistantRec('a0'),
      userRec('u1'),
      assistantRec('a1'),
    ];
    // 2 user turns exist (indices 0 and 2); toTurn=2 addresses the tip.
    const result = resolveTurn(records, 2);
    expect(result).toEqual({
      ok: true,
      targetTurnIndex: 2,
      addressableTurnCount: 2,
      truncatedEventId: records.length,
    });
  });

  it('toTurn beyond the last turn is rewind_not_applicable', () => {
    const records = [userRec('u0'), assistantRec('a0')];
    const result = resolveTurn(records, 5);
    expect(result).toEqual({ ok: false, error: 'rewind_not_applicable' });
  });

  it('turns at or before a compression checkpoint are not addressable', () => {
    const records = [
      userRec('u0'), // index 0 — compressed away
      assistantRec('a0'), // index 1
      compressionCheckpoint('ck'), // index 2 — checkpoint
      userRec('u1'), // index 3 — turn 0 (first addressable turn)
      assistantRec('a1'), // index 4
    ];
    // Only 1 addressable turn exists after the checkpoint; toTurn=1 (the tip)
    // truncates at records.length; toTurn=2 is beyond it.
    expect(resolveTurn(records, 0)).toEqual({
      ok: true,
      targetTurnIndex: 0,
      addressableTurnCount: 1,
      truncatedEventId: 3,
    });
    expect(resolveTurn(records, 1)).toEqual({
      ok: true,
      targetTurnIndex: 1,
      addressableTurnCount: 1,
      truncatedEventId: records.length,
    });
    expect(resolveTurn(records, 2)).toEqual({
      ok: false,
      error: 'rewind_not_applicable',
    });
  });

  it('an empty transcript only accepts toTurn=0 (tip = 0 records)', () => {
    expect(resolveTurn([], 0)).toEqual({
      ok: true,
      targetTurnIndex: 0,
      addressableTurnCount: 0,
      truncatedEventId: 0,
    });
    expect(resolveTurn([], 1)).toEqual({
      ok: false,
      error: 'rewind_not_applicable',
    });
  });
});
