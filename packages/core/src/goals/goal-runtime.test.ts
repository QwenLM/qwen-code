/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ChatRecord } from '../services/chatRecordingService.js';
import type {
  GoalSnapshotV2,
  GoalStateCause,
  GoalStateRecordPayloadV2,
  GoalTurnPermit,
  TranscriptCursor,
} from './goal-protocol.js';
import {
  createGoalRuntime,
  type GoalEvidenceSource,
  type GoalJournal,
  type GoalTurnHost,
} from './goal-runtime.js';
import { goalTurnContext } from './goal-turn-context.js';
import { GoalConflictError } from './goal-reducer.js';
import type { GoalVerifier } from './goal-verifier.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeGoalJournal(
  options: {
    appendError?: Error;
    appendErrors?: Array<Error | undefined>;
    beforeAppend?: () => Promise<void>;
  } = {},
): GoalJournal & {
  appended: GoalStateRecordPayloadV2[];
} {
  const appended: GoalStateRecordPayloadV2[] = [];
  return {
    appended,
    getTranscriptCursor(): TranscriptCursor {
      return { recordId: null };
    },
    async recordGoalState(
      recordUuid: string,
      payload: GoalStateRecordPayloadV2,
    ): Promise<ChatRecord> {
      await options.beforeAppend?.();
      const appendError = options.appendErrors?.shift() ?? options.appendError;
      if (appendError) throw appendError;
      appended.push(structuredClone(payload));
      return {
        uuid: recordUuid,
        parentUuid: null,
        sessionId: 's-1',
        timestamp: new Date(0).toISOString(),
        type: 'system',
        subtype: 'goal_state',
        cwd: '/tmp',
        version: 'test',
        systemPayload: payload,
      };
    },
  };
}

function goalStateRecord(snapshot: GoalSnapshotV2): ChatRecord {
  return {
    uuid: 'restore-record',
    parentUuid: null,
    sessionId: 's-1',
    timestamp: new Date(0).toISOString(),
    type: 'system',
    subtype: 'goal_state',
    provenance: 'goal_control',
    cwd: '/tmp',
    version: 'test',
    systemPayload: { v: 2, cause: 'pause', snapshot },
  };
}

function legacyGoalRecord(): ChatRecord {
  return {
    uuid: 'legacy-record',
    parentUuid: null,
    sessionId: 's-1',
    timestamp: new Date(0).toISOString(),
    type: 'system',
    subtype: 'slash_command',
    cwd: '/tmp',
    version: 'test',
    systemPayload: {
      phase: 'result',
      rawCommand: '/goal ship it',
      outputHistoryItems: [
        { type: 'goal_status', kind: 'set', condition: 'ship it' },
      ],
    },
  };
}

function fakeGoalTurnHost(): GoalTurnHost & {
  started: GoalTurnPermit[];
  inputs: Array<Parameters<GoalTurnHost['startGoalTurn']>[0]>;
} {
  const started: GoalTurnPermit[] = [];
  const inputs: Array<Parameters<GoalTurnHost['startGoalTurn']>[0]> = [];
  return {
    started,
    inputs,
    async startGoalTurn(input) {
      const { permit } = input;
      started.push(structuredClone(permit));
      inputs.push(structuredClone(input));
    },
    preemptGoalTurn: vi.fn(),
  };
}

function verifierEvidenceRecords(
  permit: GoalTurnPermit,
  cursorId: string,
  evidenceId = 'assistant-evidence',
): ChatRecord[] {
  return [
    {
      uuid: cursorId,
      parentUuid: null,
      sessionId: 's-1',
      timestamp: new Date(0).toISOString(),
      type: 'system',
      subtype: 'goal_state',
      provenance: 'goal_control',
      cwd: '/tmp',
      version: 'test',
    },
    {
      uuid: evidenceId,
      parentUuid: cursorId,
      sessionId: 's-1',
      timestamp: new Date(1).toISOString(),
      type: 'assistant',
      provenance: 'assistant_output',
      goalContext: permit,
      cwd: '/tmp',
      version: 'test',
      message: { role: 'model', parts: [{ text: 'Delivered result' }] },
    },
  ];
}

function verifierUserEvidenceRecords(
  permit: GoalTurnPermit,
  cursorId: string,
  evidenceId = 'user-evidence',
): ChatRecord[] {
  const records = verifierEvidenceRecords(permit, cursorId, evidenceId);
  records[1] = {
    ...records[1]!,
    type: 'user',
    provenance: 'real_user',
    message: { role: 'user', parts: [{ text: 'No deployment authority' }] },
  };
  return records;
}

function fakeEvidenceSource(
  read: () => readonly ChatRecord[],
): GoalEvidenceSource & {
  flush: ReturnType<typeof vi.fn>;
  readActiveTranscriptChain: ReturnType<typeof vi.fn>;
} {
  return {
    flush: vi.fn(async () => undefined),
    readActiveTranscriptChain: vi.fn(async () => read()),
  };
}

describe('goal runtime', () => {
  it('requires evidence source and verifier dependencies as a pair', () => {
    const journal = fakeGoalJournal();
    const evidenceSource = fakeEvidenceSource(() => []);
    const verifier: GoalVerifier = vi.fn();

    expect(() => createGoalRuntime({ journal, evidenceSource })).toThrow(
      'must be configured together',
    );
    expect(() => createGoalRuntime({ journal, verifier })).toThrow(
      'must be configured together',
    );
  });

  it('does not activate a control after disposal during persistence', async () => {
    const appendStarted = deferred<void>();
    const appendGate = deferred<void>();
    const journal = fakeGoalJournal({
      beforeAppend: async () => {
        appendStarted.resolve();
        await appendGate.promise;
      },
    });
    const runtime = createGoalRuntime({ journal });

    const creating = runtime.dispatch({ action: 'create', objective: 'ship' });
    await appendStarted.promise;
    runtime.dispose();
    appendGate.resolve();

    await expect(creating).rejects.toThrow('disposed');
    expect(runtime.getSnapshot()).toEqual({
      v: 2,
      goal: null,
      activity: 'idle',
    });
  });

  it('persists verifier acceptance before completing a verified proposal', async () => {
    const journal = fakeGoalJournal();
    let records: readonly ChatRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn(async () => ({
      decision: 'accept' as const,
      reason: 'Evidence satisfies the objective',
    }));
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal, evidenceSource, verifier });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const permit = host.started[0];
    const cursorId = runtime.getSnapshot().goal!.evidenceCursor.recordId!;
    records = verifierEvidenceRecords(permit, cursorId);
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'Delivered',
      evidenceRefs: ['assistant-evidence'],
    });
    const causes: Array<GoalStateCause | undefined> = [];
    runtime.subscribe((_snapshot, cause) => causes.push(cause));

    await runtime.finishTurn(permit);

    expect(evidenceSource.flush).toHaveBeenCalledOnce();
    expect(verifier).toHaveBeenCalledOnce();
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'verifier_accept',
      'complete',
    ]);
    expect(causes).toEqual(['turn_finished', 'complete']);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'idle',
      goal: {
        status: 'complete',
        lastReason: 'Evidence satisfies the objective',
      },
    });
    expect(host.started).toHaveLength(1);
  });

  it('accepts a verified blocker as a resumable terminal state', async () => {
    const journal = fakeGoalJournal();
    let records: readonly ChatRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn(async () => ({
      decision: 'accept' as const,
      reason: 'User authority is required',
    }));
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal, evidenceSource, verifier });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deploy' });
    const permit = host.started[0];
    records = verifierUserEvidenceRecords(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
    );
    runtime.recordTerminalProposal(permit, {
      status: 'blocked',
      blockerKind: 'authority',
      reason: 'Need deployment approval',
      evidenceRefs: ['user-evidence'],
    });
    const causes: Array<GoalStateCause | undefined> = [];
    runtime.subscribe((_snapshot, cause) => causes.push(cause));

    await runtime.finishTurn(permit);

    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'verifier_accept',
      'blocked',
    ]);
    expect(causes).toEqual(['turn_finished', 'blocked']);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'idle',
      goal: { status: 'blocked', lastReason: 'User authority is required' },
    });
    expect(verifier).toHaveBeenCalledWith(
      expect.objectContaining({
        blockedPolicy: expect.stringContaining(
          'Difficulty, uncertainty, incomplete work',
        ),
      }),
      expect.any(AbortSignal),
    );
  });

  it('rejects an invalid evidence reference without calling the verifier', async () => {
    const journal = fakeGoalJournal();
    let records: readonly ChatRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal, evidenceSource, verifier });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const permit = host.started[0];
    records = verifierEvidenceRecords(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
    );
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'Delivered',
      evidenceRefs: ['missing-evidence'],
    });
    const causes: Array<GoalStateCause | undefined> = [];
    runtime.subscribe((_snapshot, cause) => causes.push(cause));

    await runtime.finishTurn(permit);

    expect(verifier).not.toHaveBeenCalled();
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'verifier_reject',
    ]);
    expect(causes).toEqual(['turn_finished', 'verifier_reject']);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: { status: 'active' },
    });
    expect(host.started).toHaveLength(2);
  });

  it.each([
    ['flush', new Error('flush failed')],
    ['read', new Error('read failed')],
    ['cursor', new Error('not in the active transcript chain')],
    ['provider', new Error('provider failed')],
  ] as const)(
    'moves to usage_limited when verification %s fails',
    async (failurePoint, failure) => {
      const journal = fakeGoalJournal();
      let records: readonly ChatRecord[] = [];
      const evidenceSource = fakeEvidenceSource(() => records);
      if (failurePoint === 'flush') {
        evidenceSource.flush.mockRejectedValueOnce(failure);
      } else if (failurePoint === 'read') {
        evidenceSource.readActiveTranscriptChain.mockRejectedValueOnce(failure);
      }
      const verifier: GoalVerifier =
        failurePoint === 'provider'
          ? vi.fn(async () => {
              throw failure;
            })
          : vi.fn(async () => ({ decision: 'accept', reason: 'ok' }));
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({ journal, evidenceSource, verifier });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'deliver result' });
      const permit = host.started[0];
      records = verifierEvidenceRecords(
        permit,
        runtime.getSnapshot().goal!.evidenceCursor.recordId!,
      );
      if (failurePoint === 'cursor') records = records.slice(1);
      runtime.recordTerminalProposal(permit, {
        status: 'complete',
        reason: 'Delivered',
        evidenceRefs: ['assistant-evidence'],
      });
      const causes: Array<GoalStateCause | undefined> = [];
      runtime.subscribe((_snapshot, cause) => causes.push(cause));

      await runtime.finishTurn(permit);

      expect(runtime.getSnapshot()).toMatchObject({
        activity: 'idle',
        goal: {
          status: 'usage_limited',
          lastReason: expect.stringContaining(failure.message),
        },
      });
      expect(journal.appended.at(-1)?.cause).toBe('usage_limited');
      expect(causes).toEqual(['turn_finished', 'usage_limited']);
      expect(host.started).toHaveLength(1);
      await runtime.dispatch({
        action: 'resume',
        expectedGoalId: permit.goalId,
        expectedRevision: permit.revision,
      });
      expect(runtime.getSnapshot().goal?.status).toBe('active');
      expect(host.started).toHaveLength(2);
    },
  );

  it('promotes queued user input with exact verifier feedback after rejection', async () => {
    const result = deferred<Awaited<ReturnType<GoalVerifier>>>();
    const journal = fakeGoalJournal();
    let records: readonly ChatRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn(() => result.promise);
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal, evidenceSource, verifier });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const permit = host.started[0];
    records = verifierEvidenceRecords(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
    );
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'Delivered',
      evidenceRefs: ['assistant-evidence'],
    });
    const finishing = runtime.finishTurn(permit);
    await vi.waitFor(() => expect(verifier).toHaveBeenCalledOnce());
    expect(runtime.beginTurn('real-user')).toBeUndefined();

    result.resolve({ decision: 'reject', reason: 'Add the missing example' });
    await finishing;

    const userPermit = runtime.permitForTurn('real-user')!;
    expect(userPermit).toBeDefined();
    expect(runtime.getVerifierFeedback(userPermit)).toBe(
      'Add the missing example',
    );
    expect(host.started).toHaveLength(1);
    expect(runtime.getSnapshot().activity).toBe('running');
  });

  it.each(['blocked', 'usage_limited'] as const)(
    'preserves queued user priority when verification stops as %s',
    async (terminalStatus) => {
      const result = deferred<Awaited<ReturnType<GoalVerifier>>>();
      const journal = fakeGoalJournal();
      let records: readonly ChatRecord[] = [];
      const evidenceSource = fakeEvidenceSource(() => records);
      const verifier: GoalVerifier = vi.fn(() => result.promise);
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({ journal, evidenceSource, verifier });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'deploy' });
      const permit = host.started[0];
      records =
        terminalStatus === 'blocked'
          ? verifierUserEvidenceRecords(
              permit,
              runtime.getSnapshot().goal!.evidenceCursor.recordId!,
            )
          : verifierEvidenceRecords(
              permit,
              runtime.getSnapshot().goal!.evidenceCursor.recordId!,
            );
      runtime.recordTerminalProposal(
        permit,
        terminalStatus === 'blocked'
          ? {
              status: 'blocked',
              blockerKind: 'authority',
              reason: 'Need approval',
              evidenceRefs: ['user-evidence'],
            }
          : {
              status: 'complete',
              reason: 'Done',
              evidenceRefs: ['assistant-evidence'],
            },
      );
      const finishing = runtime.finishTurn(permit);
      await vi.waitFor(() => expect(verifier).toHaveBeenCalledOnce());
      expect(runtime.beginTurn('real-user')).toBeUndefined();

      if (terminalStatus === 'blocked') {
        result.resolve({ decision: 'accept', reason: 'approval required' });
      } else {
        result.reject(new Error('provider unavailable'));
      }
      await finishing;
      expect(runtime.getSnapshot().goal?.status).toBe(terminalStatus);
      await runtime.dispatch({
        action: 'resume',
        expectedGoalId: permit.goalId,
        expectedRevision: permit.revision,
      });

      expect(runtime.permitForTurn('real-user')).toBeDefined();
      expect(host.started).toHaveLength(1);
      expect(runtime.getSnapshot().activity).toBe('running');
    },
  );

  it('releases a queued user reservation before it is promoted', async () => {
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const initialPermit = host.started[0];

    expect(runtime.beginTurn('queued-user')).toBeUndefined();
    await expect(runtime.releaseTurn('queued-user')).resolves.toBe(true);
    await runtime.finishTurn(initialPermit);

    expect(runtime.permitForTurn('queued-user')).toBeUndefined();
    expect(host.started).toHaveLength(2);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: { status: 'active', turnCount: 1 },
    });
  });

  it('releases a promoted user reservation and resumes autonomously', async () => {
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const initialPermit = host.started[0];

    expect(runtime.beginTurn('queued-user')).toBeUndefined();
    await runtime.finishTurn(initialPermit);
    expect(runtime.permitForTurn('queued-user')).toBeDefined();

    await expect(runtime.releaseTurn('queued-user')).resolves.toBe(true);

    expect(runtime.permitForTurn('queued-user')).toBeUndefined();
    expect(host.started).toHaveLength(2);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: { status: 'active', turnCount: 1 },
    });
  });

  it('serializes reservation release behind an in-flight turn commit', async () => {
    const appendReached = deferred<void>();
    const appendGate = deferred<void>();
    let blockTurnFinish = false;
    const journal = fakeGoalJournal({
      beforeAppend: async () => {
        if (!blockTurnFinish) return;
        appendReached.resolve();
        await appendGate.promise;
      },
    });
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const initialPermit = host.started[0];
    expect(runtime.beginTurn('queued-user')).toBeUndefined();

    blockTurnFinish = true;
    const finishing = runtime.finishTurn(initialPermit);
    await appendReached.promise;
    const releasing = runtime.releaseTurn('queued-user');
    appendGate.resolve();
    await Promise.all([finishing, releasing]);

    expect(runtime.permitForTurn('queued-user')).toBeUndefined();
    expect(host.started).toHaveLength(2);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: { status: 'active', turnCount: 1 },
    });
  });

  it('ignores an in-flight accept after edit changes the revision', async () => {
    const result = deferred<Awaited<ReturnType<GoalVerifier>>>();
    const journal = fakeGoalJournal();
    let records: readonly ChatRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn(() => result.promise);
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal, evidenceSource, verifier });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'first' });
    const permit = host.started[0];
    records = verifierEvidenceRecords(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
    );
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'Done',
      evidenceRefs: ['assistant-evidence'],
    });
    const finishing = runtime.finishTurn(permit);
    await vi.waitFor(() => expect(verifier).toHaveBeenCalledOnce());

    await runtime.dispatch({
      action: 'edit',
      objective: 'second',
      expectedGoalId: permit.goalId,
      expectedRevision: permit.revision,
    });
    result.resolve({ decision: 'accept', reason: 'Old evidence' });
    await finishing;

    expect(runtime.getSnapshot()).toMatchObject({
      goal: { goalId: permit.goalId, revision: 2, status: 'active' },
    });
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'edit',
    ]);
  });

  it('does not revive an aborted verifier result after pause and resume', async () => {
    const result = deferred<Awaited<ReturnType<GoalVerifier>>>();
    const journal = fakeGoalJournal();
    let records: readonly ChatRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn(() => result.promise);
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal, evidenceSource, verifier });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const permit = host.started[0];
    records = verifierEvidenceRecords(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
    );
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'Done',
      evidenceRefs: ['assistant-evidence'],
    });
    const finishing = runtime.finishTurn(permit);
    await vi.waitFor(() => expect(verifier).toHaveBeenCalledOnce());

    await runtime.dispatch({
      action: 'pause',
      expectedGoalId: permit.goalId,
      expectedRevision: permit.revision,
    });
    await runtime.dispatch({
      action: 'resume',
      expectedGoalId: permit.goalId,
      expectedRevision: permit.revision,
    });
    result.reject(new Error('late provider failure'));
    await finishing;

    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: { revision: permit.revision, status: 'active' },
    });
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'pause',
      'resume',
    ]);
    expect(host.started).toHaveLength(2);
  });

  it('does not commit a verifier result after disposal during outcome persistence', async () => {
    const outcomeAppend = deferred<void>();
    let appendCount = 0;
    const journal = fakeGoalJournal({
      beforeAppend: async () => {
        appendCount += 1;
        if (appendCount === 3) await outcomeAppend.promise;
      },
    });
    let records: readonly ChatRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn(async () => ({
      decision: 'accept' as const,
      reason: 'verified',
    }));
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal, evidenceSource, verifier });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const permit = host.started[0];
    records = verifierEvidenceRecords(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
    );
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'Done',
      evidenceRefs: ['assistant-evidence'],
    });

    const finishing = runtime.finishTurn(permit);
    await vi.waitFor(() => expect(appendCount).toBe(3));
    runtime.dispose();
    outcomeAppend.resolve();
    await finishing;

    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'verifier_accept',
    ]);
    expect(journal.appended.at(-1)?.snapshot.goal?.status).toBe('complete');
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'verifying',
      goal: { status: 'active' },
    });
  });

  it.each([
    ['verifier_accept', 2, 'accept'],
    ['complete', 3, 'accept'],
    ['verifier_reject', 2, 'reject'],
    ['usage_limited', 2, 'usage'],
  ] as const)(
    'keeps verifying and does not continue when %s persistence fails',
    async (_cause, failingAppendIndex, outcome) => {
      const appendErrors: Array<Error | undefined> = [
        undefined,
        undefined,
        undefined,
        undefined,
      ];
      appendErrors[failingAppendIndex] = new Error('outcome write failed');
      const journal = fakeGoalJournal({ appendErrors });
      let records: readonly ChatRecord[] = [];
      const evidenceSource = fakeEvidenceSource(() => records);
      if (outcome === 'usage') {
        evidenceSource.flush.mockRejectedValueOnce(new Error('source failed'));
      }
      const verifier: GoalVerifier = vi.fn(async () => {
        if (outcome === 'reject') {
          return {
            decision: 'reject' as const,
            reason: 'not enough evidence',
          };
        }
        return { decision: 'accept' as const, reason: 'verified' };
      });
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({ journal, evidenceSource, verifier });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      const permit = host.started[0];
      records = verifierEvidenceRecords(
        permit,
        runtime.getSnapshot().goal!.evidenceCursor.recordId!,
      );
      runtime.recordTerminalProposal(permit, {
        status: 'complete',
        reason: 'Done',
        evidenceRefs: ['assistant-evidence'],
      });

      await expect(runtime.finishTurn(permit)).rejects.toThrow(
        'outcome write failed',
      );

      expect(runtime.getSnapshot()).toMatchObject({
        activity: 'verifying',
        goal: { status: 'active' },
      });
      expect(host.started).toHaveLength(1);
    },
  );

  it('returns only a bounded evidence catalog and rejects it after stale I/O', async () => {
    const flushGate = deferred<void>();
    const journal = fakeGoalJournal();
    let records: readonly ChatRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    evidenceSource.flush.mockImplementationOnce(() => flushGate.promise);
    const verifier: GoalVerifier = vi.fn();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal, evidenceSource, verifier });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const permit = host.started[0];
    records = verifierEvidenceRecords(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
    );

    const reading = runtime.getGoalForWorker(permit);
    await vi.waitFor(() => expect(evidenceSource.flush).toHaveBeenCalledOnce());
    const editing = runtime.dispatch({
      action: 'edit',
      objective: 'ship revised',
      expectedGoalId: permit.goalId,
      expectedRevision: permit.revision,
    });
    await expect(editing).resolves.toBeDefined();
    flushGate.resolve();

    await expect(reading).rejects.toThrow(
      'Goal turn permit is no longer valid',
    );
  });

  it.each(['accept', 'reject', 'usage_limited'] as const)(
    'counts active verifier time before committing %s',
    async (outcome) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(1_000);
        const flushGate = deferred<void>();
        const journal = fakeGoalJournal();
        let records: readonly ChatRecord[] = [];
        const evidenceSource = fakeEvidenceSource(() => records);
        evidenceSource.flush.mockImplementationOnce(() => flushGate.promise);
        const verifier: GoalVerifier = vi.fn(async () =>
          outcome === 'reject'
            ? { decision: 'reject' as const, reason: 'retry' }
            : { decision: 'accept' as const, reason: 'verified' },
        );
        const host = fakeGoalTurnHost();
        const runtime = createGoalRuntime({
          journal,
          evidenceSource,
          verifier,
        });
        runtime.bindHost(host);
        await runtime.dispatch({ action: 'create', objective: 'ship' });
        const permit = host.started[0];
        records = verifierEvidenceRecords(
          permit,
          runtime.getSnapshot().goal!.evidenceCursor.recordId!,
        );
        runtime.recordTerminalProposal(permit, {
          status: 'complete',
          reason: 'Done',
          evidenceRefs: ['assistant-evidence'],
        });

        vi.setSystemTime(2_000);
        const finishing = runtime.finishTurn(permit);
        await new Promise((resolve) => setImmediate(resolve));
        expect(runtime.getSnapshot().goal?.activeTimeMs).toBe(1_000);
        vi.setSystemTime(5_000);
        if (outcome === 'usage_limited') {
          flushGate.reject(new Error('source unavailable'));
        } else {
          flushGate.resolve();
        }
        await finishing;

        expect(runtime.getSnapshot().goal?.activeTimeMs).toBe(4_000);
        expect(journal.appended.at(-1)?.snapshot.goal?.activeTimeMs).toBe(
          4_000,
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('publishes one continuation snapshot after verifier rejection', async () => {
    const result = deferred<Awaited<ReturnType<GoalVerifier>>>();
    const journal = fakeGoalJournal();
    let records: readonly ChatRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn(() => result.promise);
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal, evidenceSource, verifier });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const permit = host.started[0];
    records = verifierEvidenceRecords(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
    );
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'Done',
      evidenceRefs: ['assistant-evidence'],
    });
    const observed: GoalSnapshotV2[] = [];
    runtime.subscribe((value) => observed.push(value));
    const finishing = runtime.finishTurn(permit);
    await vi.waitFor(() => expect(verifier).toHaveBeenCalledOnce());
    observed.length = 0;

    result.resolve({ decision: 'reject', reason: 'retry' });
    await finishing;

    expect(host.started).toHaveLength(2);
    expect(host.inputs[1]?.verifierFeedback).toBe('retry');
    expect(observed).toHaveLength(1);
    expect(observed[0]?.activity).toBe('running');
  });

  it('returns a bounded catalog without exposing full evidence content', async () => {
    const journal = fakeGoalJournal();
    let records: readonly ChatRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal, evidenceSource, verifier });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const permit = host.started[0];
    records = verifierEvidenceRecords(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
    );

    const view = await runtime.getGoalForWorker(permit);

    expect(view.evidenceCatalog).toEqual({
      entries: [
        {
          uuid: 'assistant-evidence',
          provenance: 'assistant_output',
          turnId: permit.turnId,
          preview: 'Delivered result',
          proofKind: 'delivered_output',
        },
      ],
      lineageTurnIds: [permit.turnId],
    });
    expect(view.evidenceCatalog?.entries[0]).not.toHaveProperty('content');
  });

  it('keeps verification live when a pausing lifecycle append fails', async () => {
    const result = deferred<Awaited<ReturnType<GoalVerifier>>>();
    const journal = fakeGoalJournal({
      appendErrors: [undefined, undefined, new Error('pause write failed')],
    });
    let records: readonly ChatRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn(() => result.promise);
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal, evidenceSource, verifier });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const permit = host.started[0];
    records = verifierEvidenceRecords(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
    );
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'Done',
      evidenceRefs: ['assistant-evidence'],
    });
    const finishing = runtime.finishTurn(permit);
    await vi.waitFor(() => expect(verifier).toHaveBeenCalledOnce());

    await expect(
      runtime.dispatch({
        action: 'pause',
        expectedGoalId: permit.goalId,
        expectedRevision: permit.revision,
      }),
    ).rejects.toThrow('pause write failed');
    expect(runtime.getSnapshot().activity).toBe('verifying');
    result.resolve({ decision: 'accept', reason: 'verified' });
    await finishing;

    expect(runtime.getSnapshot().goal?.status).toBe('complete');
  });

  it('keeps a Goal permit across asynchronous turn continuations', async () => {
    const permit: GoalTurnPermit = {
      goalId: 'g-1',
      revision: 1,
      turnId: 't-1',
    };

    const observed = await goalTurnContext.run(permit, async () => {
      await Promise.resolve();
      return goalTurnContext.getStore();
    });

    expect(observed).toEqual(permit);
    expect(goalTurnContext.getStore()).toBeUndefined();
  });

  it('does not mutate or broadcast when lifecycle persistence fails', async () => {
    const journal = fakeGoalJournal({
      appendError: new Error('disk full'),
    });
    const runtime = createGoalRuntime({ journal });
    const observed: GoalSnapshotV2[] = [];
    runtime.subscribe((snapshot) => observed.push(snapshot));

    await expect(
      runtime.dispatch({ action: 'create', objective: 'ship it' }),
    ).rejects.toThrow('disk full');

    expect(runtime.getSnapshot()).toEqual({
      v: 2,
      goal: null,
      activity: 'idle',
    });
    expect(observed).toEqual([]);
    expect(vi.isMockFunction(journal.recordGoalState)).toBe(false);
  });

  it('publishes a lifecycle cause only after its append commits', async () => {
    const appendGate = deferred<void>();
    const journal = fakeGoalJournal({ beforeAppend: () => appendGate.promise });
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    const observed: Array<{
      snapshot: GoalSnapshotV2;
      cause: GoalStateCause | undefined;
    }> = [];
    runtime.subscribe((snapshot, cause) => observed.push({ snapshot, cause }));
    runtime.bindHost(host);

    const creating = runtime.dispatch({ action: 'create', objective: 'ship' });
    await Promise.resolve();

    expect(observed).toEqual([]);
    appendGate.resolve();
    await creating;

    expect(observed.map(({ cause }) => cause)).toEqual(['create', undefined]);
    expect(observed.map(({ snapshot }) => snapshot.activity)).toEqual([
      'idle',
      'running',
    ]);
  });

  it('publishes the recovered record cause after restore commits', async () => {
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    const observed: Array<GoalStateCause | undefined> = [];
    runtime.subscribe((_snapshot, cause) => observed.push(cause));

    await runtime.restore([
      goalStateRecord({
        v: 2,
        activity: 'idle',
        goal: {
          goalId: 'g-1',
          revision: 1,
          objective: 'ship it',
          status: 'paused',
          evidenceCursor: { recordId: 'create-record' },
          turnCount: 2,
          activeTimeMs: 10,
          createdAt: 1,
          updatedAt: 2,
        },
      }),
    ]);

    expect(observed).toEqual(['pause']);
  });

  it('resumes an idle stopped goal exactly once', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    await runtime.restore([
      goalStateRecord({
        v: 2,
        activity: 'idle',
        goal: {
          goalId: 'g-1',
          revision: 1,
          objective: 'ship it',
          status: 'paused',
          evidenceCursor: { recordId: 'create-record' },
          turnCount: 2,
          activeTimeMs: 10,
          createdAt: 1,
          updatedAt: 2,
        },
      }),
    ]);
    runtime.bindHost(host);

    await runtime.dispatch({
      action: 'resume',
      expectedGoalId: 'g-1',
      expectedRevision: 1,
    });

    expect(host.started).toHaveLength(1);
  });

  it('broadcasts a restored v2 snapshot to existing subscribers', async () => {
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    const observed: GoalSnapshotV2[] = [];
    runtime.subscribe((snapshot) => observed.push(snapshot));
    const restoredSnapshot: GoalSnapshotV2 = {
      v: 2,
      activity: 'idle',
      goal: {
        goalId: 'g-1',
        revision: 1,
        objective: 'ship it',
        status: 'paused',
        evidenceCursor: { recordId: 'create-record' },
        turnCount: 2,
        activeTimeMs: 10,
        createdAt: 1,
        updatedAt: 2,
      },
    };

    await runtime.restore([goalStateRecord(restoredSnapshot)]);

    expect(observed).toEqual([restoredSnapshot]);
  });

  it('preempts and admits an active create only after persistence commits', async () => {
    const appendGate = deferred<void>();
    const journal = fakeGoalJournal({ beforeAppend: () => appendGate.promise });
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    runtime.bindHost(host);

    const creating = runtime.dispatch({ action: 'create', objective: 'ship' });
    await Promise.resolve();

    expect(host.preemptGoalTurn).not.toHaveBeenCalled();
    expect(host.started).toEqual([]);

    appendGate.resolve();
    await creating;

    expect(host.preemptGoalTurn).toHaveBeenCalledOnce();
    expect(host.started).toHaveLength(1);
  });

  it('preempts and invalidates an in-flight turn when paused', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const permit = host.started[0];
    const evidenceCursor = runtime.getSnapshot().goal?.evidenceCursor;
    vi.mocked(host.preemptGoalTurn).mockClear();

    await runtime.dispatch({
      action: 'pause',
      expectedGoalId: permit.goalId,
      expectedRevision: permit.revision,
    });
    await expect(runtime.finishTurn(permit)).rejects.toThrow(
      'Goal turn permit is no longer valid',
    );

    expect(host.preemptGoalTurn).toHaveBeenCalledOnce();
    expect(host.started).toHaveLength(1);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'idle',
      goal: {
        status: 'paused',
        revision: 1,
        turnCount: 0,
        evidenceCursor,
      },
    });
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'pause',
    ]);
  });

  it('resumes with a new permit after pause invalidates the running turn', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    const observed: GoalSnapshotV2[] = [];
    runtime.subscribe((value) => observed.push(value));
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const permit = host.started[0];

    expect(
      runtime.recordTerminalProposal(permit, {
        status: 'complete',
        reason: 'done',
        evidenceRefs: ['e-1'],
      }),
    ).toMatchObject({ recorded: true });
    expect(
      runtime.recordTerminalProposal(permit, {
        status: 'blocked',
        reason: 'duplicate',
        evidenceRefs: [],
      }),
    ).toMatchObject({ recorded: false });

    await runtime.dispatch({
      action: 'pause',
      expectedGoalId: permit.goalId,
      expectedRevision: permit.revision,
    });
    expect(runtime.getSnapshot().activity).toBe('idle');
    await runtime.dispatch({
      action: 'resume',
      expectedGoalId: permit.goalId,
      expectedRevision: permit.revision,
    });
    expect(runtime.getSnapshot().activity).toBe('running');
    expect(host.started).toHaveLength(2);
    const resumedPermit = host.started[1];
    expect(resumedPermit).not.toEqual(permit);
    await runtime.dispatch({
      action: 'pause',
      expectedGoalId: resumedPermit.goalId,
      expectedRevision: resumedPermit.revision,
    });

    expect(host.started).toHaveLength(2);
    expect(runtime.getSnapshot().activity).toBe('idle');
    expect(observed.at(-1)?.activity).toBe('idle');
    expect(observed.some((value) => value.activity === 'verifying')).toBe(
      false,
    );
  });

  it('lets ordinary user input claim the queued slot before continuation and reuses its permit', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const automaticPermit = host.started[0];

    expect(runtime.beginTurn('real-user-1')).toBeUndefined();
    await runtime.finishTurn(automaticPermit);

    expect(host.started).toHaveLength(1);
    const userPermit = runtime.permitForTurn('real-user-1');
    expect(userPermit).toEqual(
      expect.objectContaining({
        goalId: automaticPermit.goalId,
        revision: automaticPermit.revision,
        turnId: expect.any(String),
      }),
    );
    expect(userPermit?.turnId).not.toBe(automaticPermit.turnId);
    expect(runtime.beginTurn('real-user-1')).toEqual(userPermit);
    expect(runtime.getSnapshot().activity).toBe('running');
  });

  it('invalidates an old permit before broadcasting an objective change', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'first' });
    const oldPermit = host.started[0];
    let listenerError: unknown;
    let lateAccepted = false;
    runtime.subscribe((value) => {
      if (value.goal?.revision !== 2) return;
      try {
        lateAccepted = runtime.recordTerminalProposal(oldPermit, {
          status: 'complete',
          reason: 'late',
          evidenceRefs: [],
        }).recorded;
      } catch (error) {
        listenerError = error;
      }
    });

    await runtime.dispatch({
      action: 'edit',
      objective: 'second',
      expectedGoalId: oldPermit.goalId,
      expectedRevision: oldPermit.revision,
    });

    expect(listenerError).toEqual(
      expect.objectContaining({
        message: 'Goal turn permit is no longer valid',
      }),
    );
    expect(lateAccepted).toBe(false);
    expect(host.started).toHaveLength(2);
  });

  it('preempts the permit-owning host when a subscriber rebinds during broadcast', async () => {
    const oldHost = fakeGoalTurnHost();
    const newHost = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    runtime.bindHost(oldHost);
    const created = await runtime.dispatch({
      action: 'create',
      objective: 'first',
    });
    vi.mocked(oldHost.preemptGoalTurn).mockClear();
    runtime.subscribe((snapshot) => {
      if (snapshot.goal?.revision === 2) runtime.bindHost(newHost);
    });

    await runtime.dispatch({
      action: 'edit',
      objective: 'second',
      expectedGoalId: created.snapshot.goal!.goalId,
      expectedRevision: 1,
    });

    expect(oldHost.preemptGoalTurn).toHaveBeenCalledOnce();
    expect(newHost.preemptGoalTurn).not.toHaveBeenCalled();
    expect(newHost.started).toHaveLength(1);
  });

  it('preempts the bound host that owns a directly admitted user turn', async () => {
    const oldHost = fakeGoalTurnHost();
    const newHost = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    await runtime.restore([
      goalStateRecord({
        v: 2,
        activity: 'idle',
        goal: {
          goalId: 'g-1',
          revision: 1,
          objective: 'first',
          status: 'paused',
          evidenceCursor: { recordId: 'create-record' },
          turnCount: 0,
          activeTimeMs: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      }),
    ]);
    runtime.bindHost(oldHost);
    let userPermit: GoalTurnPermit | undefined;
    runtime.subscribe((snapshot) => {
      if (snapshot.goal?.status === 'active' && !userPermit) {
        userPermit = runtime.beginTurn('real-user');
      }
    });
    await runtime.dispatch({
      action: 'resume',
      expectedGoalId: 'g-1',
      expectedRevision: 1,
    });
    expect(userPermit).toBeDefined();
    runtime.bindHost(newHost);

    await runtime.dispatch({
      action: 'edit',
      objective: 'second',
      expectedGoalId: 'g-1',
      expectedRevision: 1,
    });

    expect(oldHost.preemptGoalTurn).toHaveBeenCalledOnce();
    expect(newHost.preemptGoalTurn).not.toHaveBeenCalled();
  });

  it('preempts the bound host that owns a promoted queued user turn', async () => {
    const oldHost = fakeGoalTurnHost();
    const newHost = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    runtime.bindHost(oldHost);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const automaticPermit = oldHost.started[0];
    expect(runtime.beginTurn('real-user')).toBeUndefined();

    await runtime.finishTurn(automaticPermit);
    expect(runtime.permitForTurn('real-user')).toBeDefined();
    vi.mocked(oldHost.preemptGoalTurn).mockClear();
    runtime.bindHost(newHost);
    await runtime.dispatch({
      action: 'clear',
      expectedGoalId: automaticPermit.goalId,
      expectedRevision: automaticPermit.revision,
    });

    expect(oldHost.preemptGoalTurn).toHaveBeenCalledOnce();
    expect(newHost.preemptGoalTurn).not.toHaveBeenCalled();
  });

  it('migrates a legacy active goal once before making it schedulable', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });

    await runtime.restore([legacyGoalRecord()]);
    await runtime.restore([legacyGoalRecord()]);

    expect(journal.appended).toHaveLength(1);
    expect(journal.appended[0]).toMatchObject({
      cause: 'migrated',
      snapshot: {
        activity: 'idle',
        goal: {
          objective: 'ship it',
          revision: 1,
          status: 'active',
          evidenceCursor: { recordId: expect.any(String) },
        },
      },
    });
    expect(host.started).toEqual([]);
    runtime.bindHost(host);
    await vi.waitFor(() => expect(host.started).toHaveLength(1));
  });

  it('releases a rejected host start without an unhandled rejection', async () => {
    const journal = fakeGoalJournal();
    const runtime = createGoalRuntime({ journal });
    await runtime.restore([
      goalStateRecord({
        v: 2,
        activity: 'idle',
        goal: {
          goalId: 'g-1',
          revision: 1,
          objective: 'ship',
          status: 'active',
          evidenceCursor: { recordId: 'create-record' },
          turnCount: 0,
          activeTimeMs: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      }),
    ]);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      runtime.bindHost({
        startGoalTurn: vi.fn().mockRejectedValue(new Error('host rejected')),
        preemptGoalTurn: vi.fn(),
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(runtime.getSnapshot().activity).toBe('idle');
      expect(unhandled).toEqual([]);

      const replacement = fakeGoalTurnHost();
      runtime.bindHost(replacement);
      await vi.waitFor(() => expect(replacement.started).toHaveLength(1));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('hands a queued continuation to a replacement host after start failure', async () => {
    const failedStart = deferred<void>();
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    const failingHost: GoalTurnHost = {
      startGoalTurn: () => failedStart.promise,
      preemptGoalTurn: vi.fn(),
    };
    runtime.bindHost(failingHost);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const replacement = fakeGoalTurnHost();
    runtime.bindHost(replacement);

    failedStart.reject(new Error('host rejected'));

    await vi.waitFor(() => expect(replacement.started).toHaveLength(1));
    expect(runtime.getSnapshot().activity).toBe('running');
  });

  it('promotes queued user input before automatic retry after start failure', async () => {
    const failedStart = deferred<void>();
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    runtime.bindHost({
      startGoalTurn: () => failedStart.promise,
      preemptGoalTurn: vi.fn(),
    });
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    expect(runtime.beginTurn('real-user')).toBeUndefined();
    const replacement = fakeGoalTurnHost();
    runtime.bindHost(replacement);

    failedStart.reject(new Error('host rejected'));

    await vi.waitFor(() =>
      expect(runtime.permitForTurn('real-user')).toBeDefined(),
    );
    expect(replacement.started).toEqual([]);
    expect(runtime.getSnapshot().activity).toBe('running');
  });

  it('discards the rejected permit proposal before promoting queued user input', async () => {
    const failedStart = deferred<void>();
    const started: GoalTurnPermit[] = [];
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    runtime.bindHost({
      async startGoalTurn({ permit }) {
        started.push(permit);
        await failedStart.promise;
      },
      preemptGoalTurn: vi.fn(),
    });
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const rejectedPermit = started[0];
    expect(
      runtime.recordTerminalProposal(rejectedPermit, {
        status: 'complete',
        reason: 'stale proposal',
        evidenceRefs: ['stale'],
      }),
    ).toEqual({ recorded: true, readyForVerification: true });
    expect(runtime.beginTurn('real-user')).toBeUndefined();

    failedStart.reject(new Error('host rejected'));
    await vi.waitFor(() =>
      expect(runtime.permitForTurn('real-user')).toBeDefined(),
    );
    const promotedPermit = runtime.permitForTurn('real-user')!;

    expect(
      runtime.recordTerminalProposal(promotedPermit, {
        status: 'complete',
        reason: 'fresh proposal',
        evidenceRefs: ['fresh'],
      }),
    ).toEqual({ recorded: true, readyForVerification: true });
    await runtime.finishTurn(promotedPermit);
    expect(runtime.takePendingTerminalProposal()).toEqual({
      permit: promotedPermit,
      proposal: {
        status: 'complete',
        reason: 'fresh proposal',
        evidenceRefs: ['fresh'],
      },
    });
  });

  it('returns a defensive worker view and rejects it after permit invalidation', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const permit = host.started[0];

    const view = await runtime.getGoalForWorker(permit);
    view.objective = 'mutated';
    view.evidenceCursor.recordId = 'mutated';
    expect(runtime.getSnapshot().goal).toMatchObject({
      objective: 'ship',
      evidenceCursor: { recordId: expect.not.stringContaining('mutated') },
    });

    await runtime.dispatch({
      action: 'edit',
      objective: 'ship better',
      expectedGoalId: permit.goalId,
      expectedRevision: permit.revision,
    });
    await expect(runtime.getGoalForWorker(permit)).rejects.toThrow(
      'Goal turn permit is no longer valid',
    );
  });

  it('requires three repeated blocked turns and resets that audit on resume', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });

    for (let index = 0; index < 2; index += 1) {
      const permit = host.started.at(-1)!;
      expect(
        runtime.recordTerminalProposal(permit, {
          status: 'blocked',
          reason: 'waiting for access',
          evidenceRefs: [],
          blockerKind: 'repeated',
        }),
      ).toEqual({ recorded: true, readyForVerification: false });
      await runtime.finishTurn(permit);
    }

    const thirdPermit = host.started.at(-1)!;
    expect(
      runtime.recordTerminalProposal(thirdPermit, {
        status: 'blocked',
        reason: 'waiting for access',
        evidenceRefs: [],
        blockerKind: 'repeated',
      }),
    ).toEqual({ recorded: true, readyForVerification: true });
    await runtime.dispatch({
      action: 'pause',
      expectedGoalId: thirdPermit.goalId,
      expectedRevision: thirdPermit.revision,
    });
    await runtime.dispatch({
      action: 'resume',
      expectedGoalId: thirdPermit.goalId,
      expectedRevision: thirdPermit.revision,
    });

    const afterResume = host.started.at(-1)!;
    expect(
      runtime.recordTerminalProposal(afterResume, {
        status: 'blocked',
        reason: 'waiting for access',
        evidenceRefs: [],
        blockerKind: 'repeated',
      }),
    ).toEqual({ recorded: true, readyForVerification: false });
  });

  it('restores the repeated blocker audit from the durable Goal state', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });

    for (let index = 0; index < 2; index += 1) {
      const permit = host.started.at(-1)!;
      runtime.recordTerminalProposal(permit, {
        status: 'blocked',
        reason: 'waiting for access',
        evidenceRefs: [],
        blockerKind: 'repeated',
      });
      await runtime.finishTurn(permit);
    }

    const restoredHost = fakeGoalTurnHost();
    const restored = createGoalRuntime({ journal: fakeGoalJournal() });
    await restored.restore([
      {
        ...goalStateRecord(journal.appended.at(-1)!.snapshot),
        systemPayload: journal.appended.at(-1)!,
      },
    ]);
    restored.bindHost(restoredHost);
    await vi.waitFor(() => expect(restoredHost.started).toHaveLength(1));

    expect(
      restored.recordTerminalProposal(restoredHost.started[0], {
        status: 'blocked',
        reason: 'waiting for access',
        evidenceRefs: [],
        blockerKind: 'repeated',
      }),
    ).toEqual({ recorded: true, readyForVerification: true });
  });

  it('restores and bounds a repeated blocker audit after verifier rejection', async () => {
    const activeSnapshot: GoalSnapshotV2 = {
      v: 2,
      activity: 'idle',
      goal: {
        goalId: 'g-rejected',
        revision: 1,
        objective: 'ship',
        status: 'active',
        evidenceCursor: { recordId: 'create-record' },
        turnCount: 3,
        activeTimeMs: 0,
        createdAt: 1,
        updatedAt: 2,
      },
    };
    const record = goalStateRecord(activeSnapshot);
    record.systemPayload = {
      v: 2,
      cause: 'verifier_reject',
      snapshot: activeSnapshot,
      blockedAudit: {
        fingerprint: 'repeated\nwaiting for access',
        count: 3,
        turnIds: ['turn-1', 'turn-2', 'turn-3'],
      },
    };
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    await runtime.restore([record]);
    runtime.bindHost(host);
    await vi.waitFor(() => expect(host.started).toHaveLength(1));

    expect(
      runtime.recordTerminalProposal(host.started[0], {
        status: 'blocked',
        reason: 'waiting for access',
        evidenceRefs: [],
        blockerKind: 'repeated',
      }),
    ).toEqual({ recorded: true, readyForVerification: true });
    await runtime.finishTurn(host.started[0]);

    expect(journal.appended.at(-1)?.blockedAudit).toMatchObject({
      count: 3,
      turnIds: ['turn-2', 'turn-3', host.started[0].turnId],
    });
  });

  it('does not count a repeated proposal recorded before pause and resume', async () => {
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const beforeResume = host.started[0];
    runtime.recordTerminalProposal(beforeResume, {
      status: 'blocked',
      reason: 'same blocker',
      evidenceRefs: [],
      blockerKind: 'repeated',
    });
    await runtime.dispatch({
      action: 'pause',
      expectedGoalId: beforeResume.goalId,
      expectedRevision: beforeResume.revision,
    });
    await runtime.dispatch({
      action: 'resume',
      expectedGoalId: beforeResume.goalId,
      expectedRevision: beforeResume.revision,
    });
    expect(() =>
      runtime.recordTerminalProposal(beforeResume, {
        status: 'complete',
        reason: 'second proposal from same permit',
        evidenceRefs: [],
      }),
    ).toThrow('Goal turn permit is no longer valid');
    await expect(runtime.finishTurn(beforeResume)).rejects.toThrow(
      'Goal turn permit is no longer valid',
    );
    expect(runtime.takePendingTerminalProposal()).toBeUndefined();

    for (let index = 0; index < 2; index += 1) {
      const permit = host.started.at(-1)!;
      expect(
        runtime.recordTerminalProposal(permit, {
          status: 'blocked',
          reason: 'same blocker',
          evidenceRefs: [],
          blockerKind: 'repeated',
        }),
      ).toEqual({ recorded: true, readyForVerification: false });
      await runtime.finishTurn(permit);
    }

    const thirdPermit = host.started.at(-1)!;
    expect(
      runtime.recordTerminalProposal(thirdPermit, {
        status: 'blocked',
        reason: 'same blocker',
        evidenceRefs: [],
        blockerKind: 'repeated',
      }),
    ).toEqual({ recorded: true, readyForVerification: true });
  });

  it('retains an active terminal proposal for verifier handoff without continuing', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const permit = host.started[0];
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'done',
      evidenceRefs: ['e-1'],
    });

    await runtime.finishTurn(permit);

    expect(runtime.getSnapshot().activity).toBe('verifying');
    expect(host.started).toHaveLength(1);
    const pending = runtime.takePendingTerminalProposal();
    expect(pending).toEqual({
      permit,
      proposal: {
        status: 'complete',
        reason: 'done',
        evidenceRefs: ['e-1'],
      },
    });
    expect(runtime.takePendingTerminalProposal()).toBeUndefined();
  });

  it.each(['authority', 'external'] as const)(
    'admits %s blockers for verification immediately',
    async (blockerKind) => {
      const journal = fakeGoalJournal();
      const runtime = createGoalRuntime({ journal });
      const permit = runtime.beginTurn('not-active');
      expect(permit).toBeUndefined();

      const host = fakeGoalTurnHost();
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      expect(
        runtime.recordTerminalProposal(host.started[0], {
          status: 'blocked',
          reason: 'maintainer decision required',
          evidenceRefs: [],
          blockerKind,
        }),
      ).toEqual({ recorded: true, readyForVerification: true });
    },
  );

  it('requires repeated blocker observations to be consecutive active finishes', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const propose = (permit: GoalTurnPermit) =>
      runtime.recordTerminalProposal(permit, {
        status: 'blocked',
        reason: 'same blocker',
        evidenceRefs: [],
        blockerKind: 'repeated',
      });

    let permit = host.started.at(-1)!;
    expect(propose(permit).readyForVerification).toBe(false);
    await runtime.finishTurn(permit);
    permit = host.started.at(-1)!;
    await runtime.finishTurn(permit);

    permit = host.started.at(-1)!;
    expect(propose(permit).readyForVerification).toBe(false);
    await runtime.finishTurn(permit);
    permit = host.started.at(-1)!;
    expect(propose(permit).readyForVerification).toBe(false);
  });

  it('serializes concurrent controls and reports the committed snapshot on conflict', async () => {
    const appendGate = deferred<void>();
    const journal = fakeGoalJournal({ beforeAppend: () => appendGate.promise });
    const runtime = createGoalRuntime({ journal });

    const first = runtime.dispatch({ action: 'create', objective: 'first' });
    const second = runtime.dispatch({ action: 'create', objective: 'second' });
    appendGate.resolve();
    const created = await first;
    const conflict = await second.catch((error: unknown) => error);

    expect(conflict).toBeInstanceOf(GoalConflictError);
    expect((conflict as GoalConflictError).current).toEqual(created.snapshot);
    expect(journal.appended).toHaveLength(1);
  });

  it('keeps turn state and the dispatch mutex usable when turn persistence fails', async () => {
    const journal = fakeGoalJournal({
      appendErrors: [undefined, new Error('turn write failed')],
    });
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const permit = host.started[0];
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'done',
      evidenceRefs: [],
    });

    await expect(runtime.finishTurn(permit)).rejects.toThrow(
      'turn write failed',
    );

    expect(runtime.getSnapshot().activity).toBe('running');
    expect(runtime.permitForTurn(`goal-runtime:${permit.turnId}`)).toEqual(
      permit,
    );
    expect(
      runtime.recordTerminalProposal(permit, {
        status: 'complete',
        reason: 'duplicate',
        evidenceRefs: [],
      }).recorded,
    ).toBe(false);
    expect(host.started).toHaveLength(1);

    await runtime.finishTurn(permit);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'verifying',
      goal: { turnCount: 1 },
    });
  });

  it('restores active state once while stopped state remains display-only', async () => {
    const activeHost = fakeGoalTurnHost();
    const active = createGoalRuntime({ journal: fakeGoalJournal() });
    await active.restore([
      goalStateRecord({
        v: 2,
        activity: 'idle',
        goal: {
          goalId: 'g-active',
          revision: 1,
          objective: 'ship',
          status: 'active',
          evidenceCursor: { recordId: 'create-record' },
          turnCount: 0,
          activeTimeMs: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      }),
    ]);
    active.bindHost(activeHost);
    active.bindHost(fakeGoalTurnHost());
    await vi.waitFor(() => expect(activeHost.started).toHaveLength(1));

    const stoppedHost = fakeGoalTurnHost();
    const stopped = createGoalRuntime({ journal: fakeGoalJournal() });
    await stopped.restore([
      goalStateRecord({
        v: 2,
        activity: 'idle',
        goal: {
          goalId: 'g-complete',
          revision: 1,
          objective: 'ship',
          status: 'complete',
          evidenceCursor: { recordId: 'create-record' },
          turnCount: 1,
          activeTimeMs: 1,
          createdAt: 1,
          updatedAt: 2,
        },
      }),
    ]);
    stopped.bindHost(stoppedHost);
    await Promise.resolve();
    expect(stoppedHost.started).toEqual([]);
    expect(stopped.getSnapshot().goal?.status).toBe('complete');
  });

  it('surfaces unsupported recovery without scheduling or fallback', async () => {
    const malformed = goalStateRecord({ v: 2, activity: 'idle', goal: null });
    malformed.systemPayload = {
      v: 99,
    } as unknown as ChatRecord['systemPayload'];
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    runtime.bindHost(host);

    await expect(runtime.restore([malformed])).rejects.toThrow(
      'malformed or uses an unsupported version',
    );
    await expect(
      runtime.dispatch({ action: 'create', objective: 'must not overwrite' }),
    ).rejects.toThrow('malformed or uses an unsupported version');
    expect(runtime.getSnapshot().goal).toBeNull();
    expect(host.started).toEqual([]);
  });

  it('blocks writes after failed legacy migration until restore succeeds', async () => {
    const journal = fakeGoalJournal({
      appendErrors: [new Error('migration write failed'), undefined],
    });
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    runtime.bindHost(host);

    await expect(runtime.restore([legacyGoalRecord()])).rejects.toThrow(
      'migration write failed',
    );
    await expect(
      runtime.dispatch({ action: 'create', objective: 'must not overwrite' }),
    ).rejects.toThrow('migration write failed');
    expect(host.started).toEqual([]);

    await runtime.restore([legacyGoalRecord()]);
    expect(runtime.getSnapshot().goal).toMatchObject({
      objective: 'ship it',
      status: 'active',
    });
  });

  it('commits successful legacy recovery before reentrant subscribers run', async () => {
    const journal = fakeGoalJournal({
      appendErrors: [new Error('migration write failed'), undefined],
    });
    const runtime = createGoalRuntime({ journal });
    await expect(runtime.restore([legacyGoalRecord()])).rejects.toThrow(
      'migration write failed',
    );
    const host = fakeGoalTurnHost();
    let bindError: unknown;
    let reentrantDispatch: Promise<unknown> | undefined;
    let reentered = false;
    runtime.subscribe((snapshot) => {
      if (reentered || snapshot.goal?.status !== 'active') return;
      reentered = true;
      try {
        runtime.bindHost(host);
      } catch (error) {
        bindError = error;
      }
      reentrantDispatch = runtime.dispatch({
        action: 'pause',
        expectedGoalId: snapshot.goal.goalId,
        expectedRevision: snapshot.goal.revision,
      });
    });

    await runtime.restore([legacyGoalRecord()]);
    await reentrantDispatch;

    expect(bindError).toBeUndefined();
    expect(host.started).toHaveLength(1);
    expect(runtime.getSnapshot().goal?.status).toBe('paused');
  });

  it('preempts replace and clear after commit and admits only active replacements', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    runtime.bindHost(host);
    const created = await runtime.dispatch({
      action: 'create',
      objective: 'a',
    });
    vi.mocked(host.preemptGoalTurn).mockClear();
    const replaced = await runtime.dispatch({
      action: 'replace',
      objective: 'b',
      expectedGoalId: created.snapshot.goal!.goalId,
      expectedRevision: 1,
    });
    expect(replaced.snapshot.goal).toMatchObject({
      revision: 1,
      objective: 'b',
    });
    expect(host.preemptGoalTurn).toHaveBeenCalledOnce();
    expect(host.started).toHaveLength(2);

    vi.mocked(host.preemptGoalTurn).mockClear();
    await runtime.dispatch({
      action: 'clear',
      expectedGoalId: replaced.snapshot.goal!.goalId,
      expectedRevision: 1,
    });
    expect(host.preemptGoalTurn).toHaveBeenCalledOnce();
    expect(host.started).toHaveLength(2);
    expect(runtime.getSnapshot().goal).toBeNull();
  });

  it('defensively copies response, subscriber, and getter snapshots', async () => {
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    runtime.subscribe((value) => {
      if (value.goal) {
        value.goal.objective = 'listener mutation';
        value.goal.evidenceCursor.recordId = 'listener mutation';
      }
    });

    const response = await runtime.dispatch({
      action: 'create',
      objective: 'original',
    });
    response.snapshot.goal!.objective = 'response mutation';
    response.snapshot.goal!.evidenceCursor.recordId = 'response mutation';
    const firstRead = runtime.getSnapshot();
    firstRead.goal!.objective = 'getter mutation';

    expect(runtime.getSnapshot().goal).toMatchObject({
      objective: 'original',
      evidenceCursor: { recordId: expect.any(String) },
    });
  });

  it('does not let a subscriber failure block committed host admission', async () => {
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    runtime.subscribe(() => {
      throw new Error('listener failed');
    });
    runtime.bindHost(host);

    await expect(
      runtime.dispatch({ action: 'create', objective: 'ship' }),
    ).resolves.toBeDefined();
    expect(host.started).toHaveLength(1);
  });

  it('does not hold the writer mutex while the host owns a running turn', async () => {
    const hostTurn = deferred<void>();
    const started: GoalTurnPermit[] = [];
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    runtime.bindHost({
      async startGoalTurn({ permit }) {
        started.push(permit);
        await hostTurn.promise;
      },
      preemptGoalTurn: vi.fn(),
    });
    let dispatchSettled = false;
    const creating = runtime
      .dispatch({ action: 'create', objective: 'ship' })
      .then(() => {
        dispatchSettled = true;
      });

    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toHaveLength(1);
    expect(dispatchSettled).toBe(true);

    hostTurn.resolve();
    await creating;
  });

  it('keeps real user input queued while a terminal proposal is verifying', async () => {
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const permit = host.started[0];
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'done',
      evidenceRefs: [],
    });
    await runtime.finishTurn(permit);

    expect(runtime.beginTurn('real-user-during-verification')).toBeUndefined();
    expect(runtime.getSnapshot().activity).toBe('verifying');
    const replacementHost = fakeGoalTurnHost();
    runtime.bindHost(replacementHost);
    await Promise.resolve();
    expect(replacementHost.started).toEqual([]);
    expect(runtime.takePendingTerminalProposal()).toBeDefined();
    expect(runtime.takePendingTerminalProposal()).toBeUndefined();
  });

  it('cancels pending verification on pause and resumes exactly once', async () => {
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const permit = host.started[0];
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'done',
      evidenceRefs: [],
    });
    await runtime.finishTurn(permit);

    await runtime.dispatch({
      action: 'pause',
      expectedGoalId: permit.goalId,
      expectedRevision: permit.revision,
    });
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'idle',
      goal: { status: 'paused' },
    });
    expect(runtime.takePendingTerminalProposal()).toBeUndefined();

    await runtime.dispatch({
      action: 'resume',
      expectedGoalId: permit.goalId,
      expectedRevision: permit.revision,
    });
    expect(host.started).toHaveLength(2);
  });

  it('does not let host preemption failures break committed lifecycle state', async () => {
    const started: GoalTurnPermit[] = [];
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    runtime.bindHost({
      async startGoalTurn({ permit }) {
        started.push(permit);
      },
      preemptGoalTurn() {
        throw new Error('preempt failed');
      },
    });

    await expect(
      runtime.dispatch({ action: 'create', objective: 'ship' }),
    ).resolves.toBeDefined();
    expect(started).toHaveLength(1);
    expect(() => runtime.dispose()).not.toThrow();
  });

  it('recovers when a host start throws synchronously', async () => {
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    runtime.bindHost({
      startGoalTurn(): Promise<void> {
        throw new Error('synchronous host failure');
      },
      preemptGoalTurn: vi.fn(),
    });

    await expect(
      runtime.dispatch({ action: 'create', objective: 'ship' }),
    ).resolves.toBeDefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtime.getSnapshot().activity).toBe('idle');
  });
});
