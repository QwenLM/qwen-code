/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  createPermissionAuditPublisher,
  DEFAULT_PERMISSION_AUDIT_RING_SIZE,
  PermissionAuditRing,
} from './permissionAudit.js';
import type {
  PermissionRequestRecord,
  PermissionVote,
} from '@qwen-code/acp-bridge/permission';

const RECORD: PermissionRequestRecord = {
  requestId: 'req-1',
  sessionId: 'sess-1',
  originatorClientId: 'client_A',
  allowedOptionIds: new Set(['proceed_once']),
  issuedAtMs: 1_000_000,
};

const VOTE: PermissionVote = {
  requestId: 'req-1',
  sessionId: 'sess-1',
  clientId: 'client_A',
  optionId: 'proceed_once',
  receivedAtMs: 1_000_010,
  fromLoopback: false,
};

describe('PermissionAuditRing', () => {
  it('has the documented default capacity', () => {
    const ring = new PermissionAuditRing();
    expect(ring.capacity).toBe(DEFAULT_PERMISSION_AUDIT_RING_SIZE);
    expect(ring.size).toBe(0);
  });

  it('throws on non-positive-integer capacity', () => {
    expect(() => new PermissionAuditRing(0)).toThrow(/positive integer/);
    expect(() => new PermissionAuditRing(-1)).toThrow(/positive integer/);
    expect(() => new PermissionAuditRing(1.5)).toThrow(/positive integer/);
    expect(() => new PermissionAuditRing(Number.NaN)).toThrow(
      /positive integer/,
    );
  });

  it('evicts the oldest entry on overflow (FIFO)', () => {
    const ring = new PermissionAuditRing(3);
    const publisher = createPermissionAuditPublisher({
      ring,
      now: () => 0,
    });
    publisher.recordRequested(
      { ...RECORD, requestId: 'req-1' },
      'first-responder',
      new Set(),
    );
    publisher.recordRequested(
      { ...RECORD, requestId: 'req-2' },
      'first-responder',
      new Set(),
    );
    publisher.recordRequested(
      { ...RECORD, requestId: 'req-3' },
      'first-responder',
      new Set(),
    );
    expect(ring.size).toBe(3);

    publisher.recordRequested(
      { ...RECORD, requestId: 'req-4' },
      'first-responder',
      new Set(),
    );
    expect(ring.size).toBe(3);
    const ids = ring.snapshot().map((e) => e.requestId);
    expect(ids).toEqual(['req-2', 'req-3', 'req-4']);
  });

  it('snapshot honors limit and rejects invalid limits', () => {
    const ring = new PermissionAuditRing();
    const publisher = createPermissionAuditPublisher({ ring, now: () => 0 });
    for (let i = 0; i < 10; i++) {
      publisher.recordRequested(
        { ...RECORD, requestId: `req-${i}` },
        'first-responder',
        new Set(),
      );
    }
    expect(ring.snapshot(3).map((e) => e.requestId)).toEqual([
      'req-7',
      'req-8',
      'req-9',
    ]);
    expect(ring.snapshot().length).toBe(10);
    expect(() => ring.snapshot(-1)).toThrow();
    expect(() => ring.snapshot(1.5)).toThrow();
  });

  it('snapshotForSession filters by sessionId', () => {
    const ring = new PermissionAuditRing();
    const publisher = createPermissionAuditPublisher({ ring, now: () => 0 });
    publisher.recordRequested(
      { ...RECORD, sessionId: 'A' },
      'first-responder',
      new Set(),
    );
    publisher.recordRequested(
      { ...RECORD, sessionId: 'B' },
      'first-responder',
      new Set(),
    );
    publisher.recordRequested(
      { ...RECORD, sessionId: 'A' },
      'first-responder',
      new Set(),
    );
    expect(ring.snapshotForSession('A').length).toBe(2);
    expect(ring.snapshotForSession('B').length).toBe(1);
    expect(ring.snapshotForSession('C').length).toBe(0);
  });
});

describe('createPermissionAuditPublisher', () => {
  it('writes the requested entry shape with timestamp and votersAtIssue', () => {
    const ring = new PermissionAuditRing();
    const publisher = createPermissionAuditPublisher({
      ring,
      now: () => 12_345,
    });
    publisher.recordRequested(
      RECORD,
      'consensus',
      new Set(['client_A', 'client_B']),
    );
    const [entry] = ring.snapshot();
    expect(entry).toMatchObject({
      kind: 'permission.requested',
      recordedAtMs: 12_345,
      requestId: 'req-1',
      sessionId: 'sess-1',
      originatorClientId: 'client_A',
      policy: 'consensus',
      issuedAtMs: 1_000_000,
    });
    expect(entry!.kind).toBe('permission.requested');
    if (entry!.kind === 'permission.requested') {
      expect(Array.from(entry.votersAtIssue).sort()).toEqual([
        'client_A',
        'client_B',
      ]);
      expect(entry.allowedOptionIds).toEqual(['proceed_once']);
    }
  });

  it('writes the voted entry with vote shape and outcome', () => {
    const ring = new PermissionAuditRing();
    const publisher = createPermissionAuditPublisher({ ring, now: () => 0 });
    publisher.recordVoted(RECORD, VOTE, {
      kind: 'resolved',
      resolvedOptionId: 'proceed_once',
    });
    const [entry] = ring.snapshot();
    expect(entry).toMatchObject({
      kind: 'permission.voted',
      requestId: 'req-1',
      sessionId: 'sess-1',
      clientId: 'client_A',
      optionId: 'proceed_once',
      fromLoopback: false,
      receivedAtMs: 1_000_010,
      outcome: { kind: 'resolved', resolvedOptionId: 'proceed_once' },
    });
  });

  it('writes the forbidden entry with the reason', () => {
    const ring = new PermissionAuditRing();
    const publisher = createPermissionAuditPublisher({ ring, now: () => 0 });
    publisher.recordForbidden(RECORD, VOTE, 'designated_mismatch');
    const [entry] = ring.snapshot();
    expect(entry).toMatchObject({
      kind: 'permission.forbidden',
      requestId: 'req-1',
      sessionId: 'sess-1',
      clientId: 'client_A',
      reason: 'designated_mismatch',
    });
  });

  it('writes the resolved entry with structured decisionReason', () => {
    const ring = new PermissionAuditRing();
    const publisher = createPermissionAuditPublisher({ ring, now: () => 0 });
    publisher.recordResolved(
      RECORD,
      { kind: 'option', optionId: 'proceed_once' },
      { type: 'first-responder', resolverClientId: 'client_A' },
    );
    const [entry] = ring.snapshot();
    expect(entry).toMatchObject({
      kind: 'permission.resolved',
      requestId: 'req-1',
      sessionId: 'sess-1',
      resolution: { kind: 'option', optionId: 'proceed_once' },
      decisionReason: {
        type: 'first-responder',
        resolverClientId: 'client_A',
      },
    });
  });

  it('writes the timeout entry without resolution data', () => {
    const ring = new PermissionAuditRing();
    const publisher = createPermissionAuditPublisher({
      ring,
      now: () => 5_555,
    });
    publisher.recordTimeout(RECORD);
    const [entry] = ring.snapshot();
    expect(entry).toMatchObject({
      kind: 'permission.timeout',
      recordedAtMs: 5_555,
      requestId: 'req-1',
      sessionId: 'sess-1',
      issuedAtMs: 1_000_000,
    });
  });
});
