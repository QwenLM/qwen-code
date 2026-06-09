/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { forkRecords, serializeForked } from './forkTranscript.js';

function sample(): Array<Record<string, unknown>> {
  return [
    {
      uuid: 'u0',
      parentUuid: null,
      sessionId: 'src',
      cwd: '/work/proj',
      type: 'user',
      message: { role: 'user', parts: [{ text: 'hello' }] },
    },
    {
      uuid: 'u1',
      parentUuid: 'u0',
      sessionId: 'src',
      cwd: '/work/proj',
      type: 'assistant',
      message: { role: 'model', parts: [{ text: 'hi there' }] },
    },
    {
      uuid: 'u2',
      parentUuid: 'u1',
      sessionId: 'src',
      cwd: '/work/proj',
      type: 'user',
      message: { role: 'user', parts: [{ text: 'again' }] },
    },
  ];
}

describe('forkRecords', () => {
  it('rewrites every record sessionId to the new id', () => {
    const out = forkRecords(sample(), 'src', 'NEW');
    expect(out.map((r) => r.sessionId)).toEqual(['NEW', 'NEW', 'NEW']);
  });

  it('rebuilds parentUuid as a linear chain in write order [null, u0, u1]', () => {
    const out = forkRecords(sample(), 'src', 'NEW');
    expect(out.map((r) => r.parentUuid)).toEqual([null, 'u0', 'u1']);
  });

  it('stamps forkedFrom {sessionId: source, messageUuid: that record uuid}', () => {
    const out = forkRecords(sample(), 'src', 'NEW');
    expect(out.map((r) => r.forkedFrom)).toEqual([
      { sessionId: 'src', messageUuid: 'u0' },
      { sessionId: 'src', messageUuid: 'u1' },
      { sessionId: 'src', messageUuid: 'u2' },
    ]);
  });

  it('leaves cwd and message content untouched (deep-equal except the 3 fields)', () => {
    const src = sample();
    const out = forkRecords(src, 'src', 'NEW');
    out.forEach((rec, i) => {
      const stripped = { ...rec };
      delete stripped['sessionId'];
      delete stripped['parentUuid'];
      delete stripped['forkedFrom'];
      const original = { ...src[i] };
      delete original['sessionId'];
      delete original['parentUuid'];
      expect(stripped).toEqual(original);
    });
  });

  it('does not mutate the input records', () => {
    const src = sample();
    forkRecords(src, 'src', 'NEW');
    expect(src[0].sessionId).toBe('src');
    expect(src[1].parentUuid).toBe('u0');
    expect(src[0].forkedFrom).toBeUndefined();
  });
});

describe('serializeForked', () => {
  it('emits one JSON line per record with a trailing newline', () => {
    const out = forkRecords(sample(), 'src', 'NEW');
    const body = serializeForked(out);
    const lines = body.split('\n');
    expect(body.endsWith('\n')).toBe(true);
    // 3 records => 3 lines + the empty trailing element after the final \n.
    expect(lines.filter((l) => l.length > 0)).toHaveLength(3);
    expect(JSON.parse(lines[0]).sessionId).toBe('NEW');
  });

  it('round-trips line-per-record', () => {
    const out = forkRecords(sample(), 'src', 'NEW');
    const body = serializeForked(out);
    const parsed = body
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    expect(parsed).toEqual(out);
  });
});
