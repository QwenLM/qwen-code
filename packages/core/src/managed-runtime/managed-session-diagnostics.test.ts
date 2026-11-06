/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedSession } from './managed-session-assembly.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';
import { ManagedSessionDiagnostics } from './managed-session-diagnostics.js';
import {
  createManagedModelStatistics,
  MANAGED_MODEL_STATISTICS_KINDS,
  recordManagedModelObservation,
} from './managed-model-statistics.js';
import { uiTelemetryService } from '../telemetry/uiTelemetry.js';

const sessionIds: string[] = [];
afterEach(() => {
  sessionIds.splice(0).forEach((id) => uiTelemetryService.resetSession(id));
});

function fixture(revisions: number[], maintenance = false) {
  const sessionId = randomUUID();
  sessionIds.push(sessionId);
  const bytes = new Map<string, Buffer>();
  const resource = (kind: string, value: object): ManagedSessionDurableRef => {
    const content = Buffer.from(JSON.stringify(value));
    const resourceId = randomUUID();
    bytes.set(resourceId, content);
    return {
      resourceId,
      kind,
      schemaVersion: 1,
      byteLength: content.length,
      digest: createHash('sha256').update(content).digest('hex'),
    };
  };
  const refs = revisions.map((revision) => {
    const statistics = createManagedModelStatistics();
    recordManagedModelObservation(statistics, {
      executionId: `00000000-0000-4000-8000-${String(revision).padStart(12, '0')}`,
      source: 'main',
      model: 'main',
      at: revision,
      outcome: 'success',
      durationMs: 1,
      failureKind: null,
      statusCode: null,
      backoffRetryOrdinal: 0,
      usage: {
        promptTokenCount: revision * 2,
        candidatesTokenCount: revision * 10,
        totalTokenCount: revision * 12,
        cachedContentTokenCount: 0,
        thoughtsTokenCount: 0,
      },
    });
    statistics.snapshotRevision = revision;
    statistics.rawOutputTokensTotal = revision * 10;
    return resource(MANAGED_MODEL_STATISTICS_KINDS.snapshot, {
      version: 1,
      budget: {
        sessionId,
        promptId: `turn-${revision}`,
        budget: 5000,
        outputTokensAtTurnStart: 0,
      },
      statistics,
      context: null,
    });
  });
  const carriers = maintenance
    ? refs.map((modelStatsRef, index) =>
        resource('managed-history_maintenance', {
          schemaVersion: 2,
          kind: 'context_compression',
          operationId: `compression-${index}`,
          expectedCompactionRevision: 0,
          historyCutSequence: 1,
          requestRef: { ...modelStatsRef, kind: 'managed-compaction-request' },
          phase: 'settled',
          attempt: 1,
          candidateRef: null,
          modelStatsRef,
          outcome: 'noop',
          failureCode: null,
          compactionRevision: null,
          run: {
            state: 'settled',
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
        }),
      )
    : [];
  const events: Array<{ kind: string; payload: Record<string, unknown> }> =
    refs.map((usageRef, index) =>
      maintenance
        ? {
            kind: 'domain.committed',
            payload: {
              domain: 'history_maintenance',
              recordRef: carriers[index],
            },
          }
        : {
            kind: 'turn.settled',
            payload: { turnId: `turn-${revisions[index]}`, usageRef },
          },
    );
  if (maintenance) events.push(events[0]);
  const read = vi.fn(
    async (ref: ManagedSessionDurableRef) => bytes.get(ref.resourceId)!,
  );
  const publish = vi.fn(async (_kind: string, _bytes: Buffer) => refs[0]);
  const session = {
    authority: {
      committedSequence: events.length,
      sessionHeader: { sessionKey: { sessionId } },
      eventsInSequenceRange: () => events,
      extensionRecordsInDomain: () => [],
    },
    resources: { read, publish },
  } as unknown as ManagedSession;
  return {
    diagnostics: new ManagedSessionDiagnostics(session),
    sessionId,
    refs,
    carriers,
    bytes,
    read,
    publish,
    events,
  };
}

describe('Managed diagnostic restore', () => {
  it.each(['matching', 'different-turn', 'foreign-session'] as const)(
    'keeps a cold-restored fallback budget only for its %s owner',
    async (owner) => {
      const state = fixture([3]);
      const savedRef = state.refs[0];
      const saved = JSON.parse(
        state.bytes.get(savedRef.resourceId)!.toString(),
      );
      if (owner === 'foreign-session') saved.budget.sessionId = 'other-session';
      state.bytes.set(savedRef.resourceId, Buffer.from(JSON.stringify(saved)));
      const turnId = owner === 'different-turn' ? 'interrupted-turn' : 'turn-3';
      state.events.splice(
        0,
        state.events.length,
        { kind: 'input.accepted', payload: { turnId: 'turn-3' } },
        {
          kind: 'model.attempt',
          payload: {
            attemptId: 'saved-attempt',
            state: 'output_committed',
            usageRef: savedRef,
          },
        },
        ...(owner === 'different-turn'
          ? [
              { kind: 'turn.settled', payload: { turnId: 'turn-3' } },
              { kind: 'input.accepted', payload: { turnId } },
            ]
          : []),
        {
          kind: 'model.attempt',
          payload: {
            attemptId: 'interrupted-attempt',
            state: 'started',
            usageRef: null,
          },
        },
      );
      await state.diagnostics.restore();
      await state.diagnostics.publishTurnFallback(turnId);
      const fallback = JSON.parse(state.publish.mock.calls[0][1].toString());
      expect(fallback.budget).toEqual(
        owner === 'matching' ? saved.budget : null,
      );
      expect(state.diagnostics.getBudget()).toEqual(saved.budget);
      expect(fallback.statistics.snapshotRevision).toBe(4);
      expect(fallback.statistics.totals).toEqual(saved.statistics.totals);
      expect(fallback.statistics.rawOutputTokensTotal).toBe(30);
      expect(fallback.statistics.coverage.gaps).toEqual([
        'unclosed_turn',
        'unclosed_model_attempt',
      ]);
    },
  );

  it.each([false, true])(
    'bounds concurrent reads and keeps the highest revision when maintenance=%s',
    async (maintenance) => {
      const state = fixture(
        [17, ...Array.from({ length: 16 }, (_, index) => index + 1)],
        maintenance,
      );
      let inFlight = 0;
      let maxInFlight = 0;
      const pending: Array<() => void> = [];
      state.read.mockImplementation(async (ref) => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await new Promise<void>((resolve) => pending.push(resolve));
        inFlight--;
        return state.bytes.get(ref.resourceId)!;
      });
      let finished = false;
      const restoring = state.diagnostics.restore().finally(() => {
        finished = true;
      });
      const waves: number[] = [];
      while (!finished) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (pending.length) {
          const wave = pending.splice(0);
          waves.push(wave.length);
          wave.reverse().forEach((resolve) => resolve());
        }
      }
      await restoring;
      expect(maxInFlight).toBe(8);
      expect(waves).toEqual(maintenance ? [8, 8, 1, 8, 8, 1] : [8, 8, 1]);
      expect(state.read).toHaveBeenCalledTimes(maintenance ? 34 : 17);
      if (maintenance)
        expect(
          state.read.mock.calls.filter(
            ([ref]) => ref.resourceId === state.carriers[0].resourceId,
          ),
        ).toHaveLength(1);
      expect(state.diagnostics.getBudget()?.promptId).toBe('turn-17');
      expect(uiTelemetryService.getTotalOutputTokens(state.sessionId)).toBe(
        170,
      );
      await state.diagnostics.publish(MANAGED_MODEL_STATISTICS_KINDS.snapshot);
      const saved = JSON.parse(state.publish.mock.calls[0][1].toString());
      expect(saved.statistics.snapshotRevision).toBe(18);
      expect(saved.statistics.rawOutputTokensTotal).toBe(170);
      expect(saved.statistics.coverage.gaps).toEqual([]);
    },
  );

  it.each(['read', 'json', 'revision'] as const)(
    'rejects a late older resource with a %s failure after restoring a higher revision',
    async (failure) => {
      const state = fixture([
        ...Array.from({ length: 8 }, (_, index) => index + 1),
        1,
      ]);
      const late = state.refs[8];
      if (failure === 'read')
        state.read.mockImplementation(async (ref) => {
          if (ref.resourceId === late.resourceId)
            throw new Error('Resource unavailable');
          return state.bytes.get(ref.resourceId)!;
        });
      else if (failure === 'json')
        state.bytes.set(late.resourceId, Buffer.from('{'));
      else {
        const body = JSON.parse(state.bytes.get(late.resourceId)!.toString());
        body.statistics.observedAt = 123;
        state.bytes.set(late.resourceId, Buffer.from(JSON.stringify(body)));
      }
      await expect(state.diagnostics.restore()).rejects.toThrow(
        failure === 'read'
          ? 'Resource unavailable'
          : failure === 'json'
            ? 'record is not valid JSON.'
            : 'Conflicting model statistics revision.',
      );
      expect(state.read).toHaveBeenCalledTimes(9);
      expect(state.publish).not.toHaveBeenCalled();
    },
  );
});
