/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { buildOrderedUuidChain } from './conversation-chain.js';
import type { ChatRecord } from '../services/chatRecordingService.js';

function rec(uuid: string, parentUuid: string | null): ChatRecord {
  return {
    uuid,
    parentUuid,
    sessionId: 's',
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'user',
    message: { role: 'user', parts: [{ text: uuid }] },
    cwd: '/tmp',
    version: '0.0.0',
  };
}

describe('buildOrderedUuidChain', () => {
  it('returns [] for empty input', () => {
    expect(buildOrderedUuidChain([])).toEqual({ uuids: [], gaps: [] });
  });

  it('walks a clean chain identically regardless of detectGaps', () => {
    const records = [rec('a1', null), rec('a2', 'a1'), rec('a3', 'a2')];
    const off = buildOrderedUuidChain(records, { detectGaps: false });
    const on = buildOrderedUuidChain(records, { detectGaps: true });

    expect(off.uuids).toEqual(['a1', 'a2', 'a3']);
    expect(off.gaps).toEqual([]);
    expect(on.uuids).toEqual(['a1', 'a2', 'a3']);
    expect(on.gaps).toEqual([]);
  });

  it('truncates at a missing parent and does NOT report a gap when detectGaps is off', () => {
    const records = [
      rec('a1', null),
      rec('a2', 'a1'),
      rec('b1', 'MISSING'),
      rec('b2', 'b1'),
    ];
    const res = buildOrderedUuidChain(records, { detectGaps: false });
    // Walk from the last physical record (b2) stops at b1's missing parent.
    expect(res.uuids).toEqual(['b1', 'b2']);
    expect(res.gaps).toEqual([]);
  });

  it('records the gap but does NOT stitch the earlier island (detectGaps on)', () => {
    const records = [
      rec('a1', null),
      rec('a2', 'a1'),
      rec('b1', 'MISSING'),
      rec('b2', 'b1'),
    ];
    const res = buildOrderedUuidChain(records, { detectGaps: true });

    // Only the reachable tail island — the earlier island is NOT reconstructed.
    expect(res.uuids).toEqual(['b1', 'b2']);
    expect(res.uuids).not.toContain('a1');
    expect(res.uuids).not.toContain('a2');
    expect(res.gaps).toEqual([
      { childUuid: 'b1', missingParentUuid: 'MISSING' },
    ]);
  });

  it('does NOT restore a rewound-away branch when the rewind marker is missing', () => {
    // wenshao's repro: a completed branch u1->a1->u2->a2, then a `rewind` record
    // (dropped in the same write failure), then the post-rewind turn u3 whose
    // parent is the missing rewind uuid. u3 is an ordinary record, so the old
    // (stitching) behavior would bridge to a2 and resurrect the discarded
    // branch. Detect-only must return just the post-rewind branch.
    const records = [
      rec('u1', null),
      rec('a1', 'u1'),
      rec('u2', 'a1'),
      rec('a2', 'u2'),
      rec('u3', 'missing-rewind'), // leaf; parent = dropped rewind marker
    ];
    const res = buildOrderedUuidChain(records, { detectGaps: true });

    expect(res.uuids).toEqual(['u3']);
    for (const discarded of ['u1', 'a1', 'u2', 'a2']) {
      expect(res.uuids).not.toContain(discarded);
    }
    expect(res.gaps).toEqual([
      { childUuid: 'u3', missingParentUuid: 'missing-rewind' },
    ]);
  });

  it('returns a partial transcript on a parentUuid cycle without hanging', () => {
    const records = [rec('a1', 'a2'), rec('a2', 'a1')];
    const res = buildOrderedUuidChain(records, { detectGaps: true });
    expect(res.uuids.length).toBeLessThanOrEqual(2);
  });

  it('honors an explicit leafUuid', () => {
    const records = [rec('a1', null), rec('a2', 'a1'), rec('a3', 'a2')];
    const res = buildOrderedUuidChain(records, { leafUuid: 'a2' });
    expect(res.uuids).toEqual(['a1', 'a2']);
  });

  it('returns empty for a leafUuid not backed by any record', () => {
    const records = [rec('a1', null), rec('a2', 'a1')];
    const res = buildOrderedUuidChain(records, { leafUuid: 'nope' });
    expect(res).toEqual({ uuids: [], gaps: [] });
  });
});
