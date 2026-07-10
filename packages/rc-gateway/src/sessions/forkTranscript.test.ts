/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  forkRecords,
  serializeForked,
  buildForkTitleRecord,
  buildForkHeader,
} from './forkTranscript.js';

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

describe('buildForkHeader', () => {
  it('returns a record with type="fork", parentSessionId, transcriptMode, forkedAt', () => {
    const header = buildForkHeader({
      parentSessionId: 'parent-abc',
      transcriptMode: 'include',
      forkedAt: '2026-07-10T00:00:00.000Z',
    });
    expect(header.type).toBe('fork');
    expect(header.parentSessionId).toBe('parent-abc');
    expect(header.transcriptMode).toBe('include');
    expect(header.forkedAt).toBe('2026-07-10T00:00:00.000Z');
    expect('parentEventId' in header).toBe(false);
  });

  it('includes parentEventId when provided', () => {
    const header = buildForkHeader({
      parentSessionId: 'parent-abc',
      parentEventId: 42,
      transcriptMode: 'summary',
      forkedAt: '2026-07-10T00:00:00.000Z',
    });
    expect(header.parentEventId).toBe(42);
  });

  it('omits parentEventId when undefined', () => {
    const header = buildForkHeader({
      parentSessionId: 'parent-abc',
      transcriptMode: 'empty',
      forkedAt: '2026-07-10T00:00:00.000Z',
    });
    expect('parentEventId' in header).toBe(false);
  });

  it('supports all three transcriptMode values', () => {
    for (const mode of ['include', 'summary', 'empty'] as const) {
      const header = buildForkHeader({
        parentSessionId: 'p',
        transcriptMode: mode,
        forkedAt: '2026-07-10T00:00:00.000Z',
      });
      expect(header.transcriptMode).toBe(mode);
    }
  });
});

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

describe('buildForkTitleRecord', () => {
  const opts = { uuid: 'title-uuid', timestamp: '2026-06-13T00:00:00.000Z' };

  it('mirrors core renameSession shape: chained to tail, cwd/version from first', () => {
    const forked = forkRecords(sample(), 'src', 'NEW');
    const rec = buildForkTitleRecord(forked, 'My Fork', opts);
    expect(rec).toEqual({
      uuid: 'title-uuid',
      // parentUuid = LAST forked record's uuid (u2) -> chains onto the tail.
      parentUuid: 'u2',
      sessionId: 'NEW',
      timestamp: '2026-06-13T00:00:00.000Z',
      type: 'system',
      subtype: 'custom_title',
      // cwd/version copied from the FIRST record (the fields core reads).
      cwd: '/work/proj',
      version: undefined,
      systemPayload: { customTitle: 'My Fork', titleSource: 'manual' },
    });
  });

  it('never stamps forkedFrom (synthesized, not a copied message)', () => {
    const forked = forkRecords(sample(), 'src', 'NEW');
    const rec = buildForkTitleRecord(forked, 'x', opts);
    expect('forkedFrom' in rec).toBe(false);
  });

  it('copies version from the first record when present', () => {
    const src = sample();
    src[0]['version'] = 7;
    const forked = forkRecords(src, 'src', 'NEW');
    const rec = buildForkTitleRecord(forked, 'x', opts);
    expect(rec['version']).toBe(7);
  });

  it('does not mutate the forked records it reads from', () => {
    const forked = forkRecords(sample(), 'src', 'NEW');
    const snapshot = JSON.stringify(forked);
    buildForkTitleRecord(forked, 'x', opts);
    expect(JSON.stringify(forked)).toBe(snapshot);
  });

  it('the appended title is the most-recent custom_title (wins over an inherited one)', () => {
    // Parent already has a custom_title near the tail; forkRecords copies it
    // verbatim, so the forked transcript inherits it. The appended record must
    // win under readSessionTitle's most-recent-wins backwards scan.
    const withTitle = [
      ...sample(),
      {
        uuid: 'told',
        parentUuid: 'u2',
        sessionId: 'src',
        type: 'system',
        subtype: 'custom_title',
        systemPayload: { customTitle: 'inherited name', titleSource: 'manual' },
      },
    ];
    const forked = forkRecords(withTitle, 'src', 'NEW');
    const rec = buildForkTitleRecord(forked, 'new name', opts);
    // Chains onto the inherited title record (the literal last line) — faithful
    // to core's readLastRecordUuid title->title chaining on a double-rename.
    expect(rec['parentUuid']).toBe('told');

    const body = serializeForked([...forked, rec]);
    const titles = body
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
      .filter((r) => r.subtype === 'custom_title')
      .map((r) => r.systemPayload.customTitle);
    // Both titles are present; the appended one is last -> wins a tail scan.
    expect(titles).toEqual(['inherited name', 'new name']);
  });
});
