/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isHistoryMaintenanceStart,
  isHistoryMaintenanceSuccessor,
  parseHistoryMaintenance,
  type HistoryMaintenance,
} from './managed-history-maintenance-record.js';

const ref = {
  resourceId: 'request',
  kind: 'managed-compaction-request',
  schemaVersion: 1,
  byteLength: 2,
  digest: 'a'.repeat(64),
};
const admitted: HistoryMaintenance = {
  schemaVersion: 1,
  kind: 'context_compression',
  operationId: 'compression',
  expectedCompactionRevision: 0,
  historyCutSequence: 5,
  requestRef: ref,
  phase: 'admitted',
  attempt: 0,
  candidateRef: null,
  outcome: null,
  failureCode: null,
  compactionRevision: null,
  run: {
    state: 'admitted',
    reason: null,
    definition: null,
    executionCallId: null,
    effectId: null,
    dispatchId: null,
    deliveryId: null,
    execution: null,
    runtime: null,
    delivery: null,
  },
};
const generating: HistoryMaintenance = {
  ...admitted,
  phase: 'generating',
  attempt: 1,
  run: { ...admitted.run, state: 'running' },
};
const candidate: HistoryMaintenance = {
  ...generating,
  phase: 'candidate',
  candidateRef: { ...ref, resourceId: 'candidate' },
};
const completed: HistoryMaintenance = {
  ...candidate,
  phase: 'settled',
  outcome: 'compressed',
  compactionRevision: 9,
  run: { ...candidate.run, state: 'settled' },
};

describe('Managed history maintenance record', () => {
  it('accepts the durable compression lifecycle and fenced summary retry', () => {
    expect(isHistoryMaintenanceStart(admitted)).toBe(true);
    expect(isHistoryMaintenanceStart(generating)).toBe(false);
    expect(isHistoryMaintenanceSuccessor(admitted, generating)).toBe(true);
    expect(
      isHistoryMaintenanceSuccessor(generating, { ...generating, attempt: 2 }),
    ).toBe(true);
    expect(isHistoryMaintenanceSuccessor(generating, candidate)).toBe(true);
    expect(isHistoryMaintenanceSuccessor(generating, completed)).toBe(false);
    expect(isHistoryMaintenanceSuccessor(candidate, completed)).toBe(true);
    expect(isHistoryMaintenanceSuccessor(completed, completed)).toBe(false);
  });

  it.each([
    { ...admitted, unexpected: true },
    { ...admitted, attempt: 1 },
    { ...generating, candidateRef: ref },
    { ...candidate, candidateRef: null },
    { ...candidate, outcome: 'noop' },
    { ...completed, compactionRevision: null },
    { ...completed, failureCode: 'failure' },
    { ...completed, outcome: 'noop' },
    { ...admitted, run: { ...admitted.run, effectId: 'tool-effect' } },
  ])('rejects malformed or falsely terminal records %j', (record) => {
    expect(() => parseHistoryMaintenance(record)).toThrow();
  });

  it('keeps operation pins and a saved candidate immutable across revisions', () => {
    expect(
      isHistoryMaintenanceSuccessor(generating, {
        ...candidate,
        historyCutSequence: 6,
      }),
    ).toBe(false);
    expect(
      isHistoryMaintenanceSuccessor(generating, {
        ...candidate,
        expectedCompactionRevision: 1,
      }),
    ).toBe(false);
    expect(
      isHistoryMaintenanceSuccessor(generating, { ...generating, attempt: 3 }),
    ).toBe(false);
    expect(
      isHistoryMaintenanceSuccessor(candidate, {
        ...completed,
        candidateRef: ref,
      }),
    ).toBe(false);
  });

  it('records no-op and failure without a compaction revision', () => {
    const noop = {
      ...generating,
      phase: 'settled',
      outcome: 'noop',
      run: { ...generating.run, state: 'settled' },
    };
    const failure = {
      ...generating,
      phase: 'settled',
      outcome: 'failed',
      failureCode: 'provider_unavailable',
      run: { ...generating.run, state: 'failed' },
    };
    expect(isHistoryMaintenanceSuccessor(generating, noop)).toBe(true);
    expect(isHistoryMaintenanceSuccessor(generating, failure)).toBe(true);
  });
});
