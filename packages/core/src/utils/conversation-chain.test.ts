/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { buildOrderedUuidChain } from './conversation-chain.js';
import type { ChatRecord } from '../services/chatRecordingService.js';

/**
 * Minimal ChatRecord factory. `parentUuid` is the only structurally important
 * field for the chain walk; the rest satisfy the type.
 */
function rec(
  uuid: string,
  parentUuid: string | null,
  opts: {
    type?: ChatRecord['type'];
    ts?: string;
    sidechain?: boolean;
    subtype?: ChatRecord['subtype'];
  } = {},
): ChatRecord {
  return {
    uuid,
    parentUuid,
    sessionId: 's',
    timestamp: opts.ts ?? '2026-01-01T00:00:00.000Z',
    type: opts.type ?? 'user',
    message: { role: 'user', parts: [{ text: uuid }] },
    cwd: '/tmp',
    version: '0.0.0',
    ...(opts.sidechain ? { isSidechain: true } : {}),
    ...(opts.subtype ? { subtype: opts.subtype } : {}),
  };
}

describe('buildOrderedUuidChain', () => {
  it('returns [] for empty input', () => {
    expect(buildOrderedUuidChain([])).toEqual({ uuids: [], gaps: [] });
  });

  it('walks a clean chain identically regardless of bridgeGaps', () => {
    // a1(root) <- a2 <- a3(leaf)
    const records = [rec('a1', null), rec('a2', 'a1'), rec('a3', 'a2')];
    const off = buildOrderedUuidChain(records, { bridgeGaps: false });
    const on = buildOrderedUuidChain(records, { bridgeGaps: true });

    expect(off.uuids).toEqual(['a1', 'a2', 'a3']);
    expect(off.gaps).toEqual([]);
    expect(on.uuids).toEqual(['a1', 'a2', 'a3']);
    expect(on.gaps).toEqual([]);
  });

  it('truncates at a missing parent when bridgeGaps is off (today behavior)', () => {
    // Island A: a1(root) <- a2. Island B: b1(parent=MISSING) <- b2(leaf).
    const records = [
      rec('a1', null, { ts: '2026-06-25T00:00:00.000Z' }),
      rec('a2', 'a1', { ts: '2026-06-26T00:00:00.000Z' }),
      rec('b1', 'MISSING', { ts: '2026-07-05T00:00:00.000Z' }),
      rec('b2', 'b1', { ts: '2026-07-05T01:00:00.000Z' }),
    ];
    const res = buildOrderedUuidChain(records, { bridgeGaps: false });
    // Walk from last physical (b2) stops at b1's missing parent.
    expect(res.uuids).toEqual(['b1', 'b2']);
    expect(res.gaps).toEqual([]);
  });

  it('bridges a single gap onto the preceding island (965867 shape)', () => {
    const records = [
      rec('a1', null, { ts: '2026-06-25T00:00:00.000Z' }),
      rec('a2', 'a1', { ts: '2026-06-26T00:00:00.000Z' }),
      rec('b1', 'MISSING', { ts: '2026-07-05T00:00:00.000Z' }),
      rec('b2', 'b1', { ts: '2026-07-05T01:00:00.000Z' }),
    ];
    const res = buildOrderedUuidChain(records, { bridgeGaps: true });

    expect(res.uuids).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(res.gaps).toHaveLength(1);
    expect(res.gaps[0]).toMatchObject({
      childUuid: 'b1',
      missingParentUuid: 'MISSING',
      bridgedToUuid: 'a2',
    });
    // ~9 days between 6/26 and 7/5.
    expect(res.gaps[0].approxLostMs).toBeGreaterThan(0);
  });

  it('does NOT resurrect an abandoned rewind branch when bridging a gap', () => {
    // Tail component {r0,x1,c1,c2}: r0 dangles (parent missing), x1 is an
    // abandoned rewind branch off r0, c1<-c2 is the active branch.
    // Separate earlier island E {e1<-e2}. x1 is positioned BEFORE r0 so only
    // the connected-component guard (not position) can exclude it.
    const records = [
      rec('e1', null, { ts: '2026-06-01T00:00:00.000Z' }),
      rec('e2', 'e1', { ts: '2026-06-02T00:00:00.000Z' }),
      rec('x1', 'r0', { ts: '2026-06-10T00:00:00.000Z' }), // abandoned, tail comp
      rec('r0', 'MISSING', { ts: '2026-06-11T00:00:00.000Z' }),
      rec('c1', 'r0', { ts: '2026-06-12T00:00:00.000Z' }),
      rec('c2', 'c1', { ts: '2026-06-13T00:00:00.000Z' }), // leaf (last physical)
    ];
    const res = buildOrderedUuidChain(records, { bridgeGaps: true });

    // Active branch + stitched E island, but NOT x1 (same component as tail).
    expect(res.uuids).toEqual(['e1', 'e2', 'r0', 'c1', 'c2']);
    expect(res.uuids).not.toContain('x1');
    expect(res.gaps).toHaveLength(1);
    expect(res.gaps[0]).toMatchObject({ childUuid: 'r0', bridgedToUuid: 'e2' });
  });

  it('treats a rewind gap child as a barrier (does not resurrect the rewound-away branch)', () => {
    // Corrupted session that was later rewound: an older island a1<-a2, an
    // abandoned branch b1(parent MISSING)<-b2, then a `rewind` record whose
    // own parent is also missing, followed by the active post-rewind turn.
    const records = [
      rec('a1', null, { ts: '2026-06-25T00:00:00.000Z' }),
      rec('a2', 'a1', { ts: '2026-06-26T00:00:00.000Z' }),
      rec('b1', 'MISSING', { ts: '2026-07-05T00:00:00.000Z' }),
      rec('b2', 'b1', { ts: '2026-07-05T01:00:00.000Z' }),
      rec('rw', 'MISSING', {
        type: 'system',
        subtype: 'rewind',
        ts: '2026-07-06T00:00:00.000Z',
      }),
      rec('p1', 'rw', { ts: '2026-07-06T01:00:00.000Z' }), // active leaf
    ];
    const res = buildOrderedUuidChain(records, { bridgeGaps: true });

    // Only the active post-rewind branch — nothing before the rewind barrier.
    expect(res.uuids).toEqual(['rw', 'p1']);
    expect(res.uuids).not.toContain('b1');
    expect(res.uuids).not.toContain('b2');
    // A deliberate re-root is not "lost history"; no gap marker is emitted.
    expect(res.gaps).toEqual([]);
  });

  it('chains multiple islands across multiple gaps in order', () => {
    // Three islands, each older one reachable only by bridging.
    const records = [
      rec('a1', null, { ts: '2026-06-01T00:00:00.000Z' }),
      rec('a2', 'a1', { ts: '2026-06-02T00:00:00.000Z' }),
      rec('b1', 'MISS1', { ts: '2026-06-10T00:00:00.000Z' }),
      rec('b2', 'b1', { ts: '2026-06-11T00:00:00.000Z' }),
      rec('c1', 'MISS2', { ts: '2026-06-20T00:00:00.000Z' }),
      rec('c2', 'c1', { ts: '2026-06-21T00:00:00.000Z' }),
    ];
    const res = buildOrderedUuidChain(records, { bridgeGaps: true });

    expect(res.uuids).toEqual(['a1', 'a2', 'b1', 'b2', 'c1', 'c2']);
    expect(res.gaps.map((g) => g.childUuid)).toEqual(['b1', 'c1']);
    expect(res.gaps.map((g) => g.bridgedToUuid)).toEqual(['a2', 'b2']);
  });

  it('records a gap with null bridge when no earlier island exists', () => {
    const records = [
      rec('b1', 'MISSING', { ts: '2026-07-05T00:00:00.000Z' }),
      rec('b2', 'b1', { ts: '2026-07-05T01:00:00.000Z' }),
    ];
    const res = buildOrderedUuidChain(records, { bridgeGaps: true });
    expect(res.uuids).toEqual(['b1', 'b2']);
    expect(res.gaps).toEqual([
      { childUuid: 'b1', missingParentUuid: 'MISSING', bridgedToUuid: null },
    ]);
  });

  it('does not bridge onto a sidechain island', () => {
    // Preceding island is a subagent sidechain; must be skipped as a target.
    const records = [
      rec('s1', null, { ts: '2026-06-01T00:00:00.000Z', sidechain: true }),
      rec('s2', 's1', { ts: '2026-06-02T00:00:00.000Z', sidechain: true }),
      rec('b1', 'MISSING', { ts: '2026-07-05T00:00:00.000Z' }),
      rec('b2', 'b1', { ts: '2026-07-05T01:00:00.000Z' }),
    ];
    const res = buildOrderedUuidChain(records, { bridgeGaps: true });
    expect(res.uuids).toEqual(['b1', 'b2']);
    expect(res.gaps[0].bridgedToUuid).toBeNull();
  });

  it('bridges within a pure-sidechain transcript (background-agent shape)', () => {
    // Background-agent JSONL records are all isSidechain; the tail is a
    // sidechain too, so sidechain targets are eligible and the gap bridges.
    const records = [
      rec('a1', null, { ts: '2026-06-01T00:00:00.000Z', sidechain: true }),
      rec('a2', 'a1', { ts: '2026-06-02T00:00:00.000Z', sidechain: true }),
      rec('b1', 'MISSING', { ts: '2026-07-05T00:00:00.000Z', sidechain: true }),
      rec('b2', 'b1', { ts: '2026-07-05T01:00:00.000Z', sidechain: true }),
    ];
    const res = buildOrderedUuidChain(records, { bridgeGaps: true });
    expect(res.uuids).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(res.gaps).toHaveLength(1);
    expect(res.gaps[0].bridgedToUuid).toBe('a2');
  });

  it('returns a partial transcript on a parentUuid cycle without hanging', () => {
    // a1 <-> a2 cycle; leaf a2.
    const records = [rec('a1', 'a2'), rec('a2', 'a1')];
    const res = buildOrderedUuidChain(records, { bridgeGaps: true });
    // Cycle guard stops after visiting both; no throw, no infinite loop.
    expect(res.uuids.length).toBeLessThanOrEqual(2);
  });

  it('honors an explicit leafUuid', () => {
    const records = [rec('a1', null), rec('a2', 'a1'), rec('a3', 'a2')];
    const res = buildOrderedUuidChain(records, { leafUuid: 'a2' });
    expect(res.uuids).toEqual(['a1', 'a2']);
  });
});
