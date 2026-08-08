/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { GoalEvidenceRecord } from './goal-evidence.js';
import type { GoalRecoveryRecord } from './goal-persistence.js';
import {
  GOAL_CHECKPOINT_REQUEST_TOO_LARGE_REASON,
  GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
  GOAL_PROPOSAL_REASON_MAX_BYTES,
  type GoalSnapshotV2,
  type GoalStateCause,
  type GoalStateRecordPayloadV2,
  type GoalTurnPermit,
  type TranscriptCursor,
} from './goal-protocol.js';
import {
  createGoalRuntime,
  GoalPersistenceUnavailableError,
  type GoalEvidenceSource,
  type GoalJournal,
  type GoalTurnHost,
} from './goal-runtime.js';
import { GoalConflictError } from './goal-reducer.js';
import type {
  GoalCheckpointVerificationResult,
  GoalCheckpointVerifierInput,
} from './goal-checkpoint.js';
import { GoalCheckpointVerifierInputTooLargeError } from './goal-checkpoint-verifier.js';
import type { GoalVerifier } from './goal-verifier.js';

const FORMER_GOAL_CONTINUATION_LIMIT = 50;

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
  records: RuntimeRecord[];
} {
  const appended: GoalStateRecordPayloadV2[] = [];
  const records: RuntimeRecord[] = [];
  return {
    appended,
    records,
    getTranscriptCursor(): TranscriptCursor {
      return { recordId: null };
    },
    async recordGoalState(
      recordUuid: string,
      payload: GoalStateRecordPayloadV2,
    ): Promise<RuntimeRecord> {
      await options.beforeAppend?.();
      const appendError = options.appendErrors?.shift() ?? options.appendError;
      if (appendError) throw appendError;
      appended.push(structuredClone(payload));
      const record: RuntimeRecord = {
        uuid: recordUuid,
        parentUuid: records.at(-1)?.uuid ?? null,
        sessionId: 's-1',
        timestamp: new Date(0).toISOString(),
        type: 'system',
        subtype: 'goal_state',
        provenance: 'goal_control',
        cwd: '/tmp',
        version: 'test',
        systemPayload: structuredClone(payload),
      };
      records.push(record);
      return record;
    },
  };
}

function goalStateRecord(
  snapshot: GoalSnapshotV2,
  cause: GoalStateCause = 'pause',
): RuntimeRecord {
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
    systemPayload: { v: 2, cause, snapshot },
  };
}

function legacyGoalRecord(): RuntimeRecord {
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
): RuntimeRecord[] {
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

function verifierEvidenceWindow(
  permit: GoalTurnPermit,
  cursorId: string,
  count: number,
  prefix = 'assistant-evidence',
): RuntimeRecord[] {
  return [
    verifierEvidenceRecords(permit, cursorId)[0]!,
    ...Array.from({ length: count }, (_, index) => ({
      ...verifierEvidenceRecords(permit, cursorId, `${prefix}-${index}`)[1]!,
      message: {
        role: 'model',
        parts: [{ text: `Delivered result ${index}` }],
      },
    })),
  ];
}

function verifierUserEvidenceRecords(
  permit: GoalTurnPermit,
  cursorId: string,
  evidenceId = 'user-evidence',
): RuntimeRecord[] {
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
  read: () => readonly RuntimeRecord[],
): GoalEvidenceSource & {
  flush: ReturnType<typeof vi.fn>;
  readActiveTranscriptChain: ReturnType<typeof vi.fn>;
} {
  return {
    flush: vi.fn(async () => undefined),
    readActiveTranscriptChain: vi.fn(async () => read()),
  };
}

type RuntimeRecord = GoalEvidenceRecord &
  GoalRecoveryRecord & {
    parentUuid: string | null;
    sessionId: string;
    timestamp: string;
    cwd: string;
    version: string;
    message?: GoalEvidenceRecord['message'] & { role?: string };
  };

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
    let records: readonly RuntimeRecord[] = [];
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
    expect(verifier).toHaveBeenCalledWith(
      expect.objectContaining({
        currentTurnId: permit.turnId,
        currentDeliveredOutput: ['Delivered result'],
      }),
      expect.any(AbortSignal),
    );
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
    let records: readonly RuntimeRecord[] = [];
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
    let records: readonly RuntimeRecord[] = [];
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

  it('stops continuations when completion evidence exceeds the catalog', async () => {
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal, evidenceSource, verifier });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const permit = host.started[0];
    const cursorId = runtime.getSnapshot().goal!.evidenceCursor.recordId!;
    records = verifierEvidenceWindow(permit, cursorId, 101);
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'Delivered',
      evidenceRefs: ['assistant-evidence-100'],
    });
    const causes: Array<GoalStateCause | undefined> = [];
    runtime.subscribe((_snapshot, cause) => causes.push(cause));

    await runtime.finishTurn(permit);

    expect(verifier).not.toHaveBeenCalled();
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'idle',
      goal: {
        status: 'usage_limited',
        lastReason: expect.stringContaining('bounded evidence catalog'),
      },
    });
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'usage_limited',
    ]);
    expect(causes).toEqual(['turn_finished', 'usage_limited']);
    expect(host.started).toHaveLength(1);

    await expect(
      runtime.dispatch({
        action: 'resume',
        expectedGoalId: permit.goalId,
        expectedRevision: permit.revision,
      }),
    ).rejects.toThrow('edit or replace');
    expect(host.started).toHaveLength(1);

    const edited = await runtime.dispatch({
      action: 'edit',
      objective: 'deliver result',
      expectedGoalId: permit.goalId,
      expectedRevision: permit.revision,
    });
    expect(edited.snapshot.goal).toMatchObject({
      status: 'usage_limited',
      revision: 2,
      lastReason: undefined,
    });
    expect(edited.snapshot.goal?.evidenceCursor.recordId).not.toBe(cursorId);
    await runtime.dispatch({
      action: 'resume',
      expectedGoalId: permit.goalId,
      expectedRevision: 2,
    });
    expect(runtime.getSnapshot().goal?.status).toBe('active');
    expect(host.started).toHaveLength(2);
  });

  it('does not accept catalog exhaustion as an external blocker', async () => {
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn(async () => ({
      decision: 'accept' as const,
      reason: 'External blocker accepted',
    }));
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal, evidenceSource, verifier });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const permit = host.started[0]!;
    const cursorId = runtime.getSnapshot().goal!.evidenceCursor.recordId!;
    records = [
      ...verifierEvidenceWindow(permit, cursorId, 100),
      verifierUserEvidenceRecords(permit, cursorId, 'blocker-evidence')[1]!,
    ];
    runtime.recordTerminalProposal(permit, {
      status: 'blocked',
      blockerKind: 'external',
      reason: 'The evidence catalog is truncated',
      evidenceRefs: ['blocker-evidence'],
    });

    await runtime.finishTurn(permit);

    expect(verifier).not.toHaveBeenCalled();
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'idle',
      goal: {
        status: 'usage_limited',
        lastReason: expect.stringContaining('bounded evidence catalog'),
      },
    });
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'usage_limited',
    ]);
    expect(host.started).toHaveLength(1);
  });

  it('lets a repeated blocker streak reach the verifier when the catalog truncates', async () => {
    const journal = fakeGoalJournal();
    let records: RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn(async () => ({
      decision: 'accept' as const,
      reason: 'The repeated blocker is established',
    }));
    const checkpointVerifier = vi.fn();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource,
      verifier,
      checkpointVerifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const cursorId = runtime.getSnapshot().goal!.evidenceCursor.recordId!;
    records = [verifierEvidenceRecords(host.started[0]!, cursorId)[0]!];

    const firstPermit = host.started[0]!;
    records.push(
      ...verifierEvidenceWindow(firstPermit, cursorId, 98, 'first-turn').slice(
        1,
      ),
    );
    records.push(
      verifierUserEvidenceRecords(firstPermit, cursorId, 'blocker-1')[1]!,
    );
    expect(
      runtime.recordTerminalProposal(firstPermit, {
        status: 'blocked',
        blockerKind: 'repeated',
        reason: 'The same dependency is unavailable',
        evidenceRefs: [],
      }),
    ).toMatchObject({ readyForVerification: false });
    await runtime.finishTurn(firstPermit);

    const secondPermit = host.started[1]!;
    records.push(
      verifierUserEvidenceRecords(secondPermit, cursorId, 'blocker-2')[1]!,
    );
    expect(
      runtime.recordTerminalProposal(secondPermit, {
        status: 'blocked',
        blockerKind: 'repeated',
        reason: 'The same dependency is unavailable',
        evidenceRefs: [],
      }),
    ).toMatchObject({ readyForVerification: false });
    await runtime.finishTurn(secondPermit);

    const thirdPermit = host.started[2]!;
    records.push(
      ...verifierEvidenceWindow(thirdPermit, cursorId, 2, 'third-turn').slice(
        1,
      ),
    );
    records.push(
      verifierUserEvidenceRecords(thirdPermit, cursorId, 'blocker-3')[1]!,
    );
    expect(
      runtime.recordTerminalProposal(thirdPermit, {
        status: 'blocked',
        blockerKind: 'repeated',
        reason: 'The same dependency is unavailable',
        evidenceRefs: ['blocker-1', 'blocker-2', 'blocker-3'],
      }),
    ).toMatchObject({ readyForVerification: true });

    await runtime.finishTurn(thirdPermit);

    expect(checkpointVerifier).not.toHaveBeenCalled();
    expect(verifier).toHaveBeenCalledOnce();
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'turn_finished',
      'turn_finished',
      'verifier_accept',
      'blocked',
    ]);
    expect(runtime.getSnapshot().goal).toMatchObject({ status: 'blocked' });
  });

  it('checkpoints long-running evidence before starting the next turn', async () => {
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn();
    const checkpointVerifier = vi.fn(async () => ({
      claims: [
        {
          proofKind: 'delivered_output' as const,
          claim: 'The implementation result was delivered.',
          sourceRefs: ['assistant-evidence-79'],
        },
      ],
    }));
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource,
      verifier,
      checkpointVerifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const permit = host.started[0]!;
    const cursorId = runtime.getSnapshot().goal!.evidenceCursor.recordId!;
    records = verifierEvidenceWindow(permit, cursorId, 80);

    await runtime.finishTurn(permit);

    expect(checkpointVerifier).toHaveBeenCalledOnce();
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'checkpoint',
    ]);
    const checkpoint = runtime.getSnapshot().goal!.evidenceCheckpoint!;
    expect(journal.records.at(-1)?.uuid).toBe(checkpoint.checkpointId);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: {
        status: 'active',
        evidenceCursor: { recordId: checkpoint.checkpointId },
        evidenceCheckpoint: {
          claims: [
            {
              id: expect.any(String),
              proofKind: 'delivered_output',
              claim: 'The implementation result was delivered.',
              sourceRefs: ['assistant-evidence-79'],
            },
          ],
        },
      },
    });
    expect(host.started).toHaveLength(2);

    const nextPermit = host.started[1]!;
    records = [
      ...records,
      {
        uuid: checkpoint.checkpointId,
        parentUuid: records.at(-1)!.uuid,
        sessionId: 's-1',
        timestamp: new Date(2).toISOString(),
        type: 'system',
        subtype: 'goal_state',
        provenance: 'goal_control',
        cwd: '/tmp',
        version: 'test',
      },
      {
        ...verifierEvidenceRecords(
          nextPermit,
          checkpoint.checkpointId,
          'next-turn-output',
        )[1]!,
        parentUuid: checkpoint.checkpointId,
      },
    ];

    await expect(runtime.getGoalForWorker(nextPermit)).resolves.toMatchObject({
      evidenceCatalog: {
        entries: [
          {
            uuid: checkpoint.claims[0]!.id,
            proofKind: 'delivered_output',
            preview: 'The implementation result was delivered.',
          },
          { uuid: 'next-turn-output' },
        ],
        truncated: false,
      },
    });

    vi.mocked(verifier).mockResolvedValue({
      decision: 'accept',
      reason: 'Checkpoint and current evidence satisfy the objective',
    });
    runtime.recordTerminalProposal(nextPermit, {
      status: 'complete',
      reason: 'Delivered across both evidence windows',
      evidenceRefs: [checkpoint.claims[0]!.id, 'next-turn-output'],
    });

    await runtime.finishTurn(nextPermit);

    expect(verifier).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence: [
          expect.objectContaining({
            uuid: checkpoint.claims[0]!.id,
            provenance: 'goal_checkpoint',
            content: 'The implementation result was delivered.',
          }),
          expect.objectContaining({ uuid: 'next-turn-output' }),
        ],
      }),
      expect.any(AbortSignal),
    );
    expect(runtime.getSnapshot().goal).toMatchObject({
      status: 'complete',
      lastReason: 'Checkpoint and current evidence satisfy the objective',
    });
  });

  it('continues without a checkpoint while evidence remains below threshold', async () => {
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn();
    const checkpointVerifier = vi.fn();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource,
      verifier,
      checkpointVerifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const permit = host.started[0]!;
    const cursorId = runtime.getSnapshot().goal!.evidenceCursor.recordId!;
    records = verifierEvidenceWindow(permit, cursorId, 79);

    await runtime.finishTurn(permit);

    expect(checkpointVerifier).not.toHaveBeenCalled();
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'checkpoint',
    ]);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: { status: 'active' },
    });
    expect(runtime.getSnapshot().goal).not.toHaveProperty('evidenceCheckpoint');
    expect(runtime.getSnapshot().goal?.evidenceCursor.recordId).toBe(cursorId);
    expect(host.started).toHaveLength(2);
  });

  it('keeps a goal active when an empty turn finishes during the checkpoint check', async () => {
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const checkpointVerifier = vi.fn();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource,
      verifier: vi.fn(),
      checkpointVerifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const permit = host.started[0]!;
    // The turn finished without recording any goal-owned transcript records
    // (e.g. a hook blocked the prompt before anything was recorded).
    records = [journal.records[0]!];

    await runtime.finishTurn(permit);

    expect(checkpointVerifier).not.toHaveBeenCalled();
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'checkpoint',
    ]);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: { status: 'active' },
    });
    expect(runtime.getSnapshot().goal).not.toHaveProperty('evidenceCheckpoint');
    expect(host.started).toHaveLength(2);
  });

  it('counts checkpoint check time below the compaction threshold', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000);
      const flushGate = deferred<void>();
      const journal = fakeGoalJournal();
      let records: readonly RuntimeRecord[] = [];
      const evidenceSource = fakeEvidenceSource(() => records);
      evidenceSource.flush.mockImplementationOnce(() => flushGate.promise);
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({
        journal,
        evidenceSource,
        verifier: vi.fn(),
        checkpointVerifier: vi.fn(),
      });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'deliver result' });
      const permit = host.started[0]!;
      records = verifierEvidenceRecords(
        permit,
        runtime.getSnapshot().goal!.evidenceCursor.recordId!,
      );

      vi.setSystemTime(2_000);
      const finishing = runtime.finishTurn(permit);
      await new Promise((resolve) => setImmediate(resolve));
      expect(runtime.getSnapshot().goal?.activeTimeMs).toBe(1_000);

      vi.setSystemTime(5_000);
      flushGate.resolve();
      await finishing;

      expect(runtime.getSnapshot().goal?.activeTimeMs).toBe(4_000);
      expect(journal.appended.at(-1)?.snapshot.goal?.activeTimeMs).toBe(4_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts active verifier time before committing a checkpoint', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000);
      const result = deferred<GoalCheckpointVerificationResult>();
      const journal = fakeGoalJournal();
      let records: readonly RuntimeRecord[] = [];
      const evidenceSource = fakeEvidenceSource(() => records);
      const checkpointVerifier = vi.fn(() => result.promise);
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({
        journal,
        evidenceSource,
        verifier: vi.fn(),
        checkpointVerifier,
      });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'deliver result' });
      const permit = host.started[0]!;
      records = verifierEvidenceWindow(
        permit,
        runtime.getSnapshot().goal!.evidenceCursor.recordId!,
        80,
      );

      vi.setSystemTime(2_000);
      const finishing = runtime.finishTurn(permit);
      await vi.waitFor(() => expect(checkpointVerifier).toHaveBeenCalledOnce());

      vi.setSystemTime(5_000);
      result.resolve({
        claims: [
          {
            proofKind: 'delivered_output',
            claim: 'The implementation result was delivered.',
            sourceRefs: ['assistant-evidence-79'],
          },
        ],
      });
      await finishing;

      const checkpointRecord = journal.appended.at(-1);
      expect(checkpointRecord?.cause).toBe('checkpoint');
      expect(checkpointRecord?.snapshot.goal?.activeTimeMs).toBe(4_000);
      expect(runtime.getSnapshot()).toMatchObject({
        goal: {
          activeTimeMs: 4_000,
          evidenceCheckpoint: { checkpointId: expect.any(String) },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts active checkpoint time before settling a failed checkpoint', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000);
      const result = deferred<GoalCheckpointVerificationResult>();
      const journal = fakeGoalJournal();
      let records: readonly RuntimeRecord[] = [];
      const evidenceSource = fakeEvidenceSource(() => records);
      const checkpointVerifier = vi.fn(() => result.promise);
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({
        journal,
        evidenceSource,
        verifier: vi.fn(),
        checkpointVerifier,
      });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'deliver result' });
      const permit = host.started[0]!;
      records = verifierEvidenceWindow(
        permit,
        runtime.getSnapshot().goal!.evidenceCursor.recordId!,
        80,
      );

      vi.setSystemTime(2_000);
      const finishing = runtime.finishTurn(permit);
      await vi.waitFor(() => expect(checkpointVerifier).toHaveBeenCalledOnce());

      vi.setSystemTime(5_000);
      result.reject(new Error('provider failed'));
      await finishing;

      const settledRecord = journal.appended.at(-1);
      expect(settledRecord?.cause).toBe('checkpoint');
      expect(settledRecord?.snapshot.goal?.activeTimeMs).toBe(4_000);
      expect(runtime.getSnapshot().goal?.status).toBe('active');
    } finally {
      vi.useRealTimers();
    }
  });

  it('records the request limit when the checkpoint request is structurally oversized', async () => {
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const checkpointVerifier = vi.fn(() => {
      throw new GoalCheckpointVerifierInputTooLargeError(300_000);
    });
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource,
      verifier: vi.fn(),
      checkpointVerifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const permit = host.started[0]!;
    records = verifierEvidenceWindow(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
      80,
    );

    await runtime.finishTurn(permit);

    expect(checkpointVerifier).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot().goal).toMatchObject({
      status: 'usage_limited',
      lastReason: GOAL_CHECKPOINT_REQUEST_TOO_LARGE_REASON,
    });
    // The oversized request cannot shrink on its own, so resume must stay
    // blocked instead of re-limiting on every resumed turn.
    await expect(
      runtime.dispatch({
        action: 'resume',
        expectedGoalId: permit.goalId,
        expectedRevision: permit.revision,
      }),
    ).rejects.toThrow('edit or replace');
  });

  it('skips a checkpoint that changes source proof semantics', async () => {
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn();
    const checkpointVerifier = vi.fn(async () => ({
      claims: [
        {
          proofKind: 'external_fact' as const,
          claim: 'The delivered result was externally verified.',
          sourceRefs: ['assistant-evidence-79'],
        },
      ],
    }));
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource,
      verifier,
      checkpointVerifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const permit = host.started[0]!;
    records = verifierEvidenceWindow(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
      80,
    );

    await runtime.finishTurn(permit);

    // A malformed verifier output is a transient verifier failure: the
    // checkpoint is skipped so the healthy goal continues and a later turn
    // retries, instead of aborting the goal on one bad compression.
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: { status: 'active' },
    });
    expect(runtime.getSnapshot().goal).not.toHaveProperty('evidenceCheckpoint');
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'checkpoint',
    ]);
    expect(host.started).toHaveLength(2);
  });

  it.each(['flush', 'read', 'truncated'] as const)(
    'moves to usage_limited when checkpoint %s fails',
    async (failurePoint) => {
      const journal = fakeGoalJournal();
      let records: readonly RuntimeRecord[] = [];
      const evidenceSource = fakeEvidenceSource(() => records);
      if (failurePoint === 'flush') {
        evidenceSource.flush.mockRejectedValueOnce(new Error('flush failed'));
      } else if (failurePoint === 'read') {
        evidenceSource.readActiveTranscriptChain.mockRejectedValueOnce(
          new Error('read failed'),
        );
      }
      const checkpointVerifier = vi.fn(async () => ({
        claims: [
          {
            proofKind: 'delivered_output' as const,
            claim: 'The implementation result was delivered.',
            sourceRefs: ['assistant-evidence-79'],
          },
        ],
      }));
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({
        journal,
        evidenceSource,
        verifier: vi.fn(),
        checkpointVerifier,
      });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'deliver result' });
      const permit = host.started[0]!;
      records = verifierEvidenceWindow(
        permit,
        runtime.getSnapshot().goal!.evidenceCursor.recordId!,
        failurePoint === 'truncated' ? 101 : 80,
      );

      await runtime.finishTurn(permit);

      expect(runtime.getSnapshot()).toMatchObject({
        activity: 'idle',
        goal: { status: 'usage_limited' },
      });
      expect(journal.appended.map((payload) => payload.cause)).toEqual([
        'create',
        'turn_finished',
        'usage_limited',
      ]);
      expect(host.started).toHaveLength(1);
      expect(checkpointVerifier).toHaveBeenCalledTimes(0);
      if (failurePoint === 'truncated') {
        expect(runtime.getSnapshot().goal?.lastReason).toBe(
          GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
        );
        await expect(
          runtime.dispatch({
            action: 'resume',
            expectedGoalId: permit.goalId,
            expectedRevision: permit.revision,
          }),
        ).rejects.toThrow('edit or replace');
      }
    },
  );

  it('keeps a goal active when the checkpoint verifier provider fails', async () => {
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const checkpointVerifier = vi.fn(async () => {
      throw new Error('provider failed');
    });
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource,
      verifier: vi.fn(),
      checkpointVerifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const permit = host.started[0]!;
    records = verifierEvidenceWindow(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
      80,
    );

    await runtime.finishTurn(permit);

    // A single transient verifier failure must not abort a healthy goal; the
    // checkpoint is skipped and retried on a later turn while the evidence
    // remains citable.
    expect(checkpointVerifier).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: { status: 'active' },
    });
    expect(runtime.getSnapshot().goal).not.toHaveProperty('evidenceCheckpoint');
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'checkpoint',
    ]);
    expect(host.started).toHaveLength(2);
  });

  it('replaces an earlier checkpoint with a cumulative checkpoint', async () => {
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn();
    const checkpointVerifier = vi
      .fn()
      .mockResolvedValueOnce({
        claims: [
          {
            proofKind: 'delivered_output' as const,
            claim: 'The first result was delivered.',
            sourceRefs: ['first-window-79'],
          },
        ],
      })
      .mockImplementationOnce(async (input: GoalCheckpointVerifierInput) => ({
        claims: [
          {
            proofKind: 'delivered_output' as const,
            claim: 'The first result remains part of the evidence.',
            sourceRefs: [input.previousClaims[0]!.id],
          },
          {
            proofKind: 'delivered_output' as const,
            claim: 'The second result was delivered.',
            sourceRefs: ['second-window-78'],
          },
        ],
      }));
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource,
      verifier,
      checkpointVerifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const firstPermit = host.started[0]!;
    records = verifierEvidenceWindow(
      firstPermit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
      80,
      'first-window',
    );
    await runtime.finishTurn(firstPermit);
    const firstCheckpoint = runtime.getSnapshot().goal!.evidenceCheckpoint!;
    const secondPermit = host.started[1]!;
    records = [
      ...records,
      {
        uuid: firstCheckpoint.checkpointId,
        parentUuid: records.at(-1)!.uuid,
        sessionId: 's-1',
        timestamp: new Date(2).toISOString(),
        type: 'system',
        subtype: 'goal_state',
        provenance: 'goal_control',
        cwd: '/tmp',
        version: 'test',
      },
      ...verifierEvidenceWindow(
        secondPermit,
        firstCheckpoint.checkpointId,
        79,
        'second-window',
      ).slice(1),
    ];

    await runtime.finishTurn(secondPermit);

    const secondCheckpoint = runtime.getSnapshot().goal!.evidenceCheckpoint!;
    expect(checkpointVerifier).toHaveBeenCalledTimes(2);
    expect(checkpointVerifier.mock.calls[1]![0]).toMatchObject({
      previousClaims: firstCheckpoint.claims,
      evidence: expect.arrayContaining([
        expect.objectContaining({ uuid: 'second-window-78' }),
      ]),
    });
    expect(secondCheckpoint.checkpointId).not.toBe(
      firstCheckpoint.checkpointId,
    );
    expect(secondCheckpoint.claims).toMatchObject([
      { sourceRefs: [firstCheckpoint.claims[0]!.id] },
      { sourceRefs: ['second-window-78'] },
    ]);
    expect(runtime.getSnapshot().goal!.evidenceCursor.recordId).toBe(
      secondCheckpoint.checkpointId,
    );
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'checkpoint',
      'turn_finished',
      'checkpoint',
    ]);
    expect(host.started).toHaveLength(3);
  });

  it('promotes queued user input before an automatic post-checkpoint turn', async () => {
    const result = deferred<GoalCheckpointVerificationResult>();
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn();
    const checkpointVerifier = vi.fn(() => result.promise);
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource,
      verifier,
      checkpointVerifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const permit = host.started[0]!;
    records = verifierEvidenceWindow(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
      80,
    );

    const finishing = runtime.finishTurn(permit);
    await vi.waitFor(() => expect(checkpointVerifier).toHaveBeenCalledOnce());
    expect(runtime.beginTurn('real-user')).toBeUndefined();

    result.resolve({
      claims: [
        {
          proofKind: 'delivered_output',
          claim: 'The implementation result was delivered.',
          sourceRefs: ['assistant-evidence-79'],
        },
      ],
    });
    await finishing;

    expect(runtime.permitForTurn('real-user')).toBeDefined();
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: { evidenceCheckpoint: { checkpointId: expect.any(String) } },
    });
    expect(host.started).toHaveLength(1);
  });

  it('keeps a user turn queued when it was reserved before a checkpoint commit', async () => {
    const result = deferred<GoalCheckpointVerificationResult>();
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn();
    const checkpointVerifier = vi.fn(() => result.promise);
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource,
      verifier,
      checkpointVerifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const permit = host.started[0]!;
    records = verifierEvidenceWindow(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
      80,
    );

    expect(runtime.beginTurn('real-user')).toBeUndefined();
    const finishing = runtime.finishTurn(permit);
    await vi.waitFor(() => expect(checkpointVerifier).toHaveBeenCalledOnce());

    result.resolve({
      claims: [
        {
          proofKind: 'delivered_output',
          claim: 'The implementation result was delivered.',
          sourceRefs: ['assistant-evidence-79'],
        },
      ],
    });
    await finishing;

    expect(runtime.permitForTurn('real-user')).toBeDefined();
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: { evidenceCheckpoint: { checkpointId: expect.any(String) } },
    });
    expect(host.started).toHaveLength(1);
  });

  it('recovers a durable pending checkpoint before continuing after a crash', async () => {
    const result = deferred<GoalCheckpointVerificationResult>();
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const checkpointVerifier = vi.fn(() => result.promise);
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource,
      verifier: vi.fn(),
      checkpointVerifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const permit = host.started[0]!;
    const evidence = verifierEvidenceWindow(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
      80,
    );
    records = evidence;

    const finishing = runtime.finishTurn(permit);
    await vi.waitFor(() => expect(checkpointVerifier).toHaveBeenCalledOnce());
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
    ]);
    runtime.dispose();
    result.resolve({
      claims: [
        {
          proofKind: 'delivered_output',
          claim: 'The implementation result was delivered.',
          sourceRefs: ['assistant-evidence-79'],
        },
      ],
    });
    await finishing;

    const recoveryRecords = [
      journal.records[0]!,
      ...evidence.slice(1),
      journal.records[1]!,
    ];
    const restoredJournal = fakeGoalJournal();
    const restoredHost = fakeGoalTurnHost();
    const restoredCheckpointVerifier = vi.fn(async () => ({
      claims: [
        {
          proofKind: 'delivered_output' as const,
          claim: 'The implementation result was delivered.',
          sourceRefs: ['assistant-evidence-79'],
        },
      ],
    }));
    const restored = createGoalRuntime({
      journal: restoredJournal,
      evidenceSource: fakeEvidenceSource(() => recoveryRecords),
      verifier: vi.fn(),
      checkpointVerifier: restoredCheckpointVerifier,
    });
    restored.bindHost(restoredHost);

    await restored.restore(recoveryRecords);

    expect(restoredCheckpointVerifier).toHaveBeenCalledOnce();
    expect(restoredJournal.appended.map((payload) => payload.cause)).toEqual([
      'checkpoint',
    ]);
    expect(restored.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: {
        evidenceCursor: { recordId: expect.any(String) },
        evidenceCheckpoint: { checkpointId: expect.any(String) },
      },
    });
    expect(restoredJournal.records.at(-1)?.uuid).toBe(
      restored.getSnapshot().goal!.evidenceCheckpoint!.checkpointId,
    );
    expect(restoredHost.started).toHaveLength(1);
  });

  it('keeps a restored goal serviceable when the recovery checkpoint write fails', async () => {
    const result = deferred<GoalCheckpointVerificationResult>();
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const checkpointVerifier = vi.fn(() => result.promise);
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource,
      verifier: vi.fn(),
      checkpointVerifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const permit = host.started[0]!;
    const evidence = verifierEvidenceWindow(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
      80,
    );
    records = evidence;

    const finishing = runtime.finishTurn(permit);
    await vi.waitFor(() => expect(checkpointVerifier).toHaveBeenCalledOnce());
    runtime.dispose();
    result.resolve({
      claims: [
        {
          proofKind: 'delivered_output',
          claim: 'The implementation result was delivered.',
          sourceRefs: ['assistant-evidence-79'],
        },
      ],
    });
    await finishing;

    const recoveryRecords = [
      journal.records[0]!,
      ...evidence.slice(1),
      journal.records[1]!,
    ];
    const restoredJournal = fakeGoalJournal({
      appendError: new Error('writer lease inactive'),
    });
    const restoredHost = fakeGoalTurnHost();
    const restoredCheckpointVerifier = vi.fn(async () => ({
      claims: [
        {
          proofKind: 'delivered_output' as const,
          claim: 'The implementation result was delivered.',
          sourceRefs: ['assistant-evidence-79'],
        },
      ],
    }));
    const restored = createGoalRuntime({
      journal: restoredJournal,
      evidenceSource: fakeEvidenceSource(() => recoveryRecords),
      verifier: vi.fn(),
      checkpointVerifier: restoredCheckpointVerifier,
    });
    restored.bindHost(restoredHost);

    await restored.restore(recoveryRecords);
    expect(restoredCheckpointVerifier).toHaveBeenCalledOnce();
    expect(restoredJournal.appended).toEqual([]);
    // Recovery committed before the replay began, so the failed replay
    // degrades instead of bricking the runtime: the pending checkpoint is
    // dropped, the verifying activity rewinds, and the restored goal stays
    // active and serviceable.
    expect(restored.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: { status: 'active' },
    });
    expect(restoredHost.started).toHaveLength(1);
    await expect(
      restored.dispatch({
        action: 'clear',
        expectedGoalId: permit.goalId,
        expectedRevision: permit.revision,
      }),
    ).rejects.toMatchObject({ message: 'writer lease inactive' });
  });

  it('settles a post-commit checkpoint write failure instead of stalling', async () => {
    const journal = fakeGoalJournal({
      appendErrors: [
        undefined, // create
        undefined, // turn_finished
        undefined, // verifier_reject with checkpointPending
        new Error('writer lease lost'), // checkpoint record
        new Error('writer lease lost'), // usage_limited fallback
      ],
    });
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn(async () => ({
      decision: 'reject' as const,
      reason: 'More work remains',
    }));
    const checkpointVerifier = vi.fn(async () => ({
      claims: [
        {
          proofKind: 'delivered_output' as const,
          claim: 'The implementation result was delivered.',
          sourceRefs: ['assistant-evidence-79'],
        },
      ],
    }));
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource,
      verifier,
      checkpointVerifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const permit = host.started[0]!;
    records = verifierEvidenceWindow(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
      80,
    );
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'Delivered',
      evidenceRefs: ['assistant-evidence-79'],
    });

    // The turn already committed; the post-commit bookkeeping failure must
    // not reject it or leave the goal stranded on a verifying activity.
    await expect(runtime.finishTurn(permit)).resolves.toBeUndefined();

    expect(checkpointVerifier).toHaveBeenCalledOnce();
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'verifier_reject',
    ]);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: { status: 'active', lastReason: 'More work remains' },
    });
    expect(host.started).toHaveLength(2);
    expect(host.inputs[1]?.verifierFeedback).toBe('More work remains');
  });

  it('checkpoints before continuing after the terminal verifier rejects', async () => {
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn(async () => ({
      decision: 'reject' as const,
      reason: 'More work remains',
    }));
    const checkpointVerifier = vi.fn(async () => ({
      claims: [
        {
          proofKind: 'delivered_output' as const,
          claim: 'The latest implementation result was delivered.',
          sourceRefs: ['assistant-evidence-79'],
        },
      ],
    }));
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource,
      verifier,
      checkpointVerifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const permit = host.started[0]!;
    records = verifierEvidenceWindow(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
      80,
    );
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'Delivered',
      evidenceRefs: ['assistant-evidence-79'],
    });

    await runtime.finishTurn(permit);

    expect(checkpointVerifier).toHaveBeenCalledOnce();
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'verifier_reject',
      'verifier_reject',
    ]);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: {
        status: 'active',
        evidenceCheckpoint: { checkpointId: expect.any(String) },
      },
    });
    expect(host.started).toHaveLength(2);
    expect(host.inputs[1]?.verifierFeedback).toBe('More work remains');

    const restoredJournal = fakeGoalJournal();
    const restoredHost = fakeGoalTurnHost();
    const restored = createGoalRuntime({
      journal: restoredJournal,
      evidenceSource,
      verifier,
      checkpointVerifier,
    });
    restored.bindHost(restoredHost);
    await restored.restore([journal.records.at(-2)!]);

    expect(checkpointVerifier).toHaveBeenCalledTimes(2);
    expect(restoredJournal.appended.map((payload) => payload.cause)).toEqual([
      'verifier_reject',
    ]);
    expect(restoredHost.inputs[0]?.verifierFeedback).toBe('More work remains');
  });

  it('persists the rejection cause when the checkpoint check stays below threshold', async () => {
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn(async () => ({
      decision: 'reject' as const,
      reason: 'More work remains',
    }));
    const checkpointVerifier = vi.fn();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource,
      verifier,
      checkpointVerifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const permit = host.started[0]!;
    records = verifierEvidenceWindow(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
      79,
    );
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'Delivered',
      evidenceRefs: ['assistant-evidence-78'],
    });

    await runtime.finishTurn(permit);

    expect(checkpointVerifier).not.toHaveBeenCalled();
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'verifier_reject',
      'verifier_reject',
    ]);
    expect(runtime.getSnapshot().goal).not.toHaveProperty('evidenceCheckpoint');
    expect(host.started).toHaveLength(2);
    expect(host.inputs[1]?.verifierFeedback).toBe('More work remains');
  });

  it('keeps rejection feedback for continuation when the checkpoint fails after rejection', async () => {
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn(async () => ({
      decision: 'reject' as const,
      reason: 'More work remains',
    }));
    const checkpointVerifier = vi.fn(async () => {
      throw new Error('provider failed');
    });
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource,
      verifier,
      checkpointVerifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const permit = host.started[0]!;
    records = verifierEvidenceWindow(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
      80,
    );
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'Delivered',
      evidenceRefs: ['assistant-evidence-79'],
    });

    await runtime.finishTurn(permit);

    // The skipped checkpoint settles the rejection follow-up; the rejection
    // feedback must still reach the continuation turn.
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: { status: 'active' },
    });
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'verifier_reject',
      'verifier_reject',
    ]);
    expect(host.started).toHaveLength(2);
    expect(host.inputs[1]?.verifierFeedback).toBe('More work remains');
  });

  it.each(['pause', 'dispose'] as const)(
    'aborts an in-flight checkpoint attempt on %s',
    async (action) => {
      const result = deferred<GoalCheckpointVerificationResult>();
      let capturedSignal: AbortSignal | undefined;
      const journal = fakeGoalJournal();
      let records: readonly RuntimeRecord[] = [];
      const evidenceSource = fakeEvidenceSource(() => records);
      const checkpointVerifier = vi.fn(
        (_input: GoalCheckpointVerifierInput, signal?: AbortSignal) => {
          capturedSignal = signal;
          return result.promise;
        },
      );
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({
        journal,
        evidenceSource,
        verifier: vi.fn(),
        checkpointVerifier,
      });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'deliver result' });
      const permit = host.started[0]!;
      records = verifierEvidenceWindow(
        permit,
        runtime.getSnapshot().goal!.evidenceCursor.recordId!,
        80,
      );

      const finishing = runtime.finishTurn(permit);
      await vi.waitFor(() => expect(checkpointVerifier).toHaveBeenCalledOnce());
      expect(capturedSignal?.aborted).toBe(false);

      if (action === 'pause') {
        await runtime.dispatch({
          action: 'pause',
          expectedGoalId: permit.goalId,
          expectedRevision: permit.revision,
        });
        expect(runtime.getSnapshot().goal?.status).toBe('paused');
      } else {
        runtime.dispose();
      }
      expect(capturedSignal?.aborted).toBe(true);

      result.resolve({
        claims: [
          {
            proofKind: 'delivered_output',
            claim: 'The implementation result was delivered.',
            sourceRefs: ['assistant-evidence-79'],
          },
        ],
      });
      await finishing;

      expect(runtime.getSnapshot().goal).not.toHaveProperty(
        'evidenceCheckpoint',
      );
      expect(journal.appended.map((payload) => payload.cause)).toEqual(
        action === 'pause'
          ? ['create', 'turn_finished', 'pause']
          : ['create', 'turn_finished'],
      );
      expect(host.started).toHaveLength(1);
    },
  );

  it('preserves raw lineage when a repeated blocker verifier rejects', async () => {
    const journal = fakeGoalJournal();
    let records: RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records);
    const verifier: GoalVerifier = vi.fn(async () => ({
      decision: 'reject' as const,
      reason: 'The repeated blocker is not established',
    }));
    const checkpointVerifier = vi.fn();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource,
      verifier,
      checkpointVerifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    const cursorId = runtime.getSnapshot().goal!.evidenceCursor.recordId!;
    records = [verifierEvidenceRecords(host.started[0]!, cursorId)[0]!];

    for (let index = 0; index < 2; index += 1) {
      const permit = host.started[index]!;
      records.push(
        verifierUserEvidenceRecords(
          permit,
          cursorId,
          `blocker-${index + 1}`,
        )[1]!,
      );
      expect(
        runtime.recordTerminalProposal(permit, {
          status: 'blocked',
          blockerKind: 'repeated',
          reason: 'The same dependency is unavailable',
          evidenceRefs: [],
        }),
      ).toMatchObject({ readyForVerification: false });
      await runtime.finishTurn(permit);
    }

    const thirdPermit = host.started[2]!;
    records.push(
      ...verifierEvidenceWindow(thirdPermit, cursorId, 78, 'third-turn').slice(
        1,
      ),
    );
    expect(
      runtime.recordTerminalProposal(thirdPermit, {
        status: 'blocked',
        blockerKind: 'repeated',
        reason: 'The same dependency is unavailable',
        evidenceRefs: ['blocker-1', 'blocker-2', 'third-turn-77'],
      }),
    ).toMatchObject({ readyForVerification: true });

    await runtime.finishTurn(thirdPermit);

    expect(verifier).toHaveBeenCalledOnce();
    expect(checkpointVerifier).not.toHaveBeenCalled();
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'turn_finished',
      'turn_finished',
      'verifier_reject',
    ]);
    expect(runtime.getSnapshot().goal).toMatchObject({
      status: 'active',
      evidenceCursor: { recordId: cursorId },
    });
    expect(runtime.getSnapshot().goal).not.toHaveProperty('evidenceCheckpoint');
    expect(host.started).toHaveLength(4);
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
      let records: readonly RuntimeRecord[] = [];
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
    let records: readonly RuntimeRecord[] = [];
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
      let records: readonly RuntimeRecord[] = [];
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
    let records: readonly RuntimeRecord[] = [];
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
    let records: readonly RuntimeRecord[] = [];
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
    let records: readonly RuntimeRecord[] = [];
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
    expect(journal.appended.at(-1)?.snapshot.goal?.status).toBe('active');
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
      let records: readonly RuntimeRecord[] = [];
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
    let records: readonly RuntimeRecord[] = [];
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
        let records: readonly RuntimeRecord[] = [];
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
    let records: readonly RuntimeRecord[] = [];
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

  it('continues beyond the former fixed continuation limit', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'loop forever' });

    const turns = FORMER_GOAL_CONTINUATION_LIMIT + 25;
    for (let i = 0; i < turns; i++) {
      const permit = host.started[host.started.length - 1];
      expect(permit).toBeDefined();
      await runtime.finishTurn(permit);
    }

    expect(host.started).toHaveLength(turns + 1);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: { status: 'active', turnCount: turns },
    });
    expect(
      journal.appended.map((p) => p.cause).filter((c) => c === 'usage_limited'),
    ).toHaveLength(0);
  });

  it('resumes persisted state at the former limit without resetting its turn count', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    runtime.bindHost(host);
    await runtime.restore([
      goalStateRecord(
        {
          v: 2,
          activity: 'idle',
          goal: {
            goalId: 'g-1',
            revision: 1,
            objective: 'keep going',
            status: 'usage_limited',
            evidenceCursor: { recordId: 'limit-record' },
            turnCount: FORMER_GOAL_CONTINUATION_LIMIT,
            activeTimeMs: 1_000,
            createdAt: 1,
            updatedAt: 2,
          },
        },
        'usage_limited',
      ),
    ]);

    const resumed = await runtime.dispatch({
      action: 'resume',
      expectedGoalId: 'g-1',
      expectedRevision: 1,
    });

    expect(resumed.snapshot).toMatchObject({
      activity: 'running',
      goal: { status: 'active', turnCount: FORMER_GOAL_CONTINUATION_LIMIT },
    });
    expect(host.started).toHaveLength(1);
    await runtime.finishTurn(host.started[0]);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: { status: 'active', turnCount: FORMER_GOAL_CONTINUATION_LIMIT + 1 },
    });
  });

  it('returns a bounded catalog without exposing full evidence content', async () => {
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
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
      truncated: false,
    });
    expect(view.evidenceCatalog?.entries[0]).not.toHaveProperty('content');
  });

  it('keeps verification live when a pausing lifecycle append fails', async () => {
    const result = deferred<Awaited<ReturnType<GoalVerifier>>>();
    const journal = fakeGoalJournal({
      appendErrors: [undefined, undefined, new Error('pause write failed')],
    });
    let records: readonly RuntimeRecord[] = [];
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

  it('migrates a legacy active goal once into a paused state', async () => {
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
          status: 'paused',
          evidenceCursor: { recordId: expect.any(String) },
        },
      },
    });
    expect(host.started).toEqual([]);
    runtime.bindHost(host);
    await Promise.resolve();
    expect(host.started).toEqual([]);
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

  it('returns defensive worker state and checks the complete permit atomically', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const permit = host.started[0];

    const view = await runtime.getGoalForWorker(permit);
    const permittedSnapshot = runtime.getSnapshotForPermit(permit);
    view.objective = 'mutated';
    view.evidenceCursor.recordId = 'mutated';
    permittedSnapshot.goal!.objective = 'mutated snapshot';
    expect(runtime.getSnapshot().goal).toMatchObject({
      objective: 'ship',
      evidenceCursor: { recordId: expect.not.stringContaining('mutated') },
    });
    expect(() =>
      runtime.getSnapshotForPermit({
        ...permit,
        turnId: 'different-turn',
      }),
    ).toThrow('Goal turn permit is no longer valid');

    await runtime.dispatch({
      action: 'edit',
      objective: 'ship better',
      expectedGoalId: permit.goalId,
      expectedRevision: permit.revision,
    });
    await expect(runtime.getGoalForWorker(permit)).rejects.toThrow(
      'Goal turn permit is no longer valid',
    );
    expect(() => runtime.getSnapshotForPermit(permit)).toThrow(
      'Goal turn permit is no longer valid',
    );
  });

  it('rejects an oversized proposal reason before consuming the turn proposal slot', async () => {
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const permit = host.started[0];

    expect(() =>
      runtime.recordTerminalProposal(permit, {
        status: 'complete',
        reason: '界'.repeat(Math.floor(GOAL_PROPOSAL_REASON_MAX_BYTES / 3) + 1),
        evidenceRefs: ['oversized'],
      }),
    ).toThrow(/UTF-8 bytes/i);
    expect(
      runtime.recordTerminalProposal(permit, {
        status: 'complete',
        reason: 'valid reason',
        evidenceRefs: ['valid'],
      }),
    ).toEqual({ recorded: true, readyForVerification: true });
  });

  it('normalizes omitted blocker kinds in the repeated audit and resets it on resume', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });

    for (const blockerKind of [undefined, 'repeated'] as const) {
      const permit = host.started.at(-1)!;
      expect(
        runtime.recordTerminalProposal(permit, {
          status: 'blocked',
          reason: 'waiting for access',
          evidenceRefs: [],
          ...(blockerKind ? { blockerKind } : {}),
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
    const recoveredPayload = journal.appended.at(-1)!;
    await restored.restore([
      {
        ...goalStateRecord(recoveredPayload.snapshot),
        systemPayload: {
          ...recoveredPayload,
          blockedAudit: {
            ...recoveredPayload.blockedAudit!,
            fingerprint: '\nwaiting for access',
          },
        },
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
    } as unknown as RuntimeRecord['systemPayload'];
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    runtime.bindHost(host);

    await expect(runtime.restore([malformed])).rejects.toBeInstanceOf(
      GoalPersistenceUnavailableError,
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

    await expect(runtime.restore([legacyGoalRecord()])).rejects.toEqual(
      expect.objectContaining({
        name: 'GoalPersistenceUnavailableError',
        message: 'migration write failed',
        cause: expect.objectContaining({ message: 'migration write failed' }),
      }),
    );
    await expect(
      runtime.dispatch({ action: 'create', objective: 'must not overwrite' }),
    ).rejects.toThrow('migration write failed');
    expect(host.started).toEqual([]);

    await runtime.restore([legacyGoalRecord()]);
    expect(runtime.getSnapshot().goal).toMatchObject({
      objective: 'ship it',
      status: 'paused',
    });
  });

  it('commits paused legacy recovery before a reentrant resume', async () => {
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
      if (reentered || snapshot.goal?.status !== 'paused') return;
      reentered = true;
      try {
        runtime.bindHost(host);
      } catch (error) {
        bindError = error;
      }
      reentrantDispatch = runtime.dispatch({
        action: 'resume',
        expectedGoalId: snapshot.goal.goalId,
        expectedRevision: snapshot.goal.revision,
      });
    });

    await runtime.restore([legacyGoalRecord()]);
    await reentrantDispatch;

    expect(bindError).toBeUndefined();
    expect(host.started).toHaveLength(1);
    expect(runtime.getSnapshot().goal?.status).toBe('active');
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
