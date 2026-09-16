/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { GoalEvidenceRecord } from './goal-evidence.js';
import {
  recoverGoalFromRecords,
  type GoalRecoveryRecord,
} from './goal-persistence.js';
import {
  GOAL_INFEASIBLE_NEXT_STEP,
  GOAL_DEFAULT_TOKEN_BUDGET,
  GOAL_NO_PROGRESS_TURN_LIMIT,
  GOAL_PAUSE_REASON_NO_PROGRESS,
  GOAL_PROPOSAL_REASON_MAX_BYTES,
  goalActiveTimeBudgetReason,
  goalTurnBudgetReason,
  type GoalBroadcastMeta,
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
import type { GoalCheckpointVerifier } from './goal-checkpoint.js';
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
    beforeAppend?: (payload: GoalStateRecordPayloadV2) => Promise<void> | void;
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
      // Answer with the transcript tail, as the real journal does. A fixed
      // { recordId: null } here would make every resume-cursor assertion
      // trivial -- and null is exactly the value the real evidence pipeline
      // hard-rejects (`analyzeEvidence` throws `cursor_unset`).
      return { recordId: records.at(-1)?.uuid ?? null };
    },
    async recordGoalState(
      recordUuid: string,
      payload: GoalStateRecordPayloadV2,
    ): Promise<RuntimeRecord> {
      await options.beforeAppend?.(payload);
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
  journal?: { records: RuntimeRecord[] },
): GoalEvidenceSource & {
  flush: ReturnType<typeof vi.fn>;
  readActiveTranscriptChain: ReturnType<typeof vi.fn>;
} {
  return {
    flush: vi.fn(async () => undefined),
    readActiveTranscriptChain: vi.fn(async () => {
      const source = read().map(
        (record) =>
          journal?.records.find(
            (persisted) => persisted.uuid === record.uuid,
          ) ?? record,
      );
      const present = new Set(source.map((record) => record.uuid));
      return [
        ...source,
        ...(journal?.records ?? []).filter(
          (record) =>
            !present.has(record.uuid) &&
            (record.systemPayload as GoalStateRecordPayloadV2)?.cause !==
              'create' &&
            (record.systemPayload as GoalStateRecordPayloadV2)?.cause !==
              'edit',
        ),
      ];
    }),
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

  it('bills a finished turn the tokens its own records carried', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const spend = new Map<string, number>();
    const runtime = createGoalRuntime({
      journal,
      ledger: {
        takeGoalTurnTokens: (turnId: string) => {
          const tokens = spend.get(turnId) ?? 0;
          spend.delete(turnId);
          return tokens;
        },
      },
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });

    spend.set(host.started[0]!.turnId, 2_500);
    await runtime.finishTurn(host.started[0]!);
    expect(runtime.getSnapshot().goal).toMatchObject({
      turnCount: 1,
      tokensUsed: 2_500,
    });

    spend.set(host.started[1]!.turnId, 500);
    await runtime.finishTurn(host.started[1]!);
    expect(runtime.getSnapshot().goal).toMatchObject({
      turnCount: 2,
      tokensUsed: 3_000,
    });
  });

  it.each(['accept', 'reject'] as const)(
    'persists %s verifier usage once and applies the budget gate',
    async (decision) => {
      const journal = fakeGoalJournal();
      const host = fakeGoalTurnHost();
      let records: readonly RuntimeRecord[] = [];
      const verifier: GoalVerifier = vi.fn<GoalVerifier>(async () => ({
        decision,
        reason: 'Checked the cited result',
        usage: { totalTokenCount: 250 },
      }));
      const runtime = createGoalRuntime({
        journal,
        evidenceSource: fakeEvidenceSource(() => records, journal),
        verifier,
        ledger: { takeGoalTurnTokens: () => 800 },
        tokenBudgetGrant: 1_000,
      });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'deliver result' });
      const permit = host.started[0]!;
      records = verifierEvidenceRecords(
        permit,
        runtime.getSnapshot().goal!.evidenceCursor.recordId!,
      );
      runtime.recordTerminalProposal(permit, {
        status: 'complete',
        reason: 'Delivered',
        evidenceRefs: ['assistant-evidence'],
      });

      await runtime.finishTurn(permit);

      expect(verifier).toHaveBeenCalledOnce();
      expect(
        journal.appended.find(({ cause }) => cause === 'turn_finished')!
          .snapshot.goal?.tokensUsed,
      ).toBe(800);
      expect(
        journal.appended.find(({ cause }) => cause === `verifier_${decision}`)!
          .snapshot.goal,
      ).toMatchObject({ tokensUsed: 1_050, turnCount: 1 });
      expect(runtime.getSnapshot().goal).toMatchObject({
        tokensUsed: 1_050,
        turnCount: 1,
        status: decision === 'accept' ? 'complete' : 'active',
      });
      if (decision === 'reject') {
        expect(host.inputs[1]).toMatchObject({ windDown: true });
      } else {
        expect(host.started).toHaveLength(1);
        expect(journal.appended.at(-1)!.snapshot.goal?.tokensUsed).toBe(1_050);
        const restored = createGoalRuntime({
          journal: fakeGoalJournal(),
          evidenceSource: fakeEvidenceSource(() => records, journal),
          verifier,
        });
        await restored.restore(journal.records);
        expect(restored.getSnapshot().goal?.tokensUsed).toBe(1_050);
        expect(verifier).toHaveBeenCalledOnce();
        restored.dispose();
      }
      runtime.dispose();
    },
  );

  it('asks the ledger for the finishing turn, not the session', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const asked: string[] = [];
    const runtime = createGoalRuntime({
      journal,
      ledger: {
        takeGoalTurnTokens: (turnId: string) => {
          asked.push(turnId);
          return 0;
        },
      },
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });

    const permit = host.started[0]!;
    await runtime.finishTurn(permit);

    expect(asked).toEqual([permit.turnId]);
  });

  it('arms the default token budget when no grant is supplied', async () => {
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    await runtime.dispatch({ action: 'create', objective: 'ship' });

    expect(runtime.getSnapshot().goal?.tokenBudget).toBe(
      GOAL_DEFAULT_TOKEN_BUDGET,
    );
    // The wiring assertion above moves with the constant, so only this
    // literal pin catches a silent rescale of the production default.
    expect(GOAL_DEFAULT_TOKEN_BUDGET).toBe(30_000_000);
  });

  it('stops autonomous continuation when the budget is spent, and resume re-arms it', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const spend = new Map<string, number>();
    const runtime = createGoalRuntime({
      journal,
      ledger: {
        takeGoalTurnTokens: (turnId: string) => {
          const tokens = spend.get(turnId) ?? 0;
          spend.delete(turnId);
          return tokens;
        },
      },
      tokenBudgetGrant: 1_000,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const created = runtime.getSnapshot().goal!;
    expect(created).toMatchObject({ tokenBudget: 1_000, tokensUsed: 0 });

    spend.set(host.started[0]!.turnId, 1_500);
    await runtime.finishTurn(host.started[0]!);

    // The spent window buys exactly one more continuation, flagged so the
    // prompt asks for a hand-off instead of more work.
    expect(host.started).toHaveLength(2);
    expect(host.inputs[1]).toMatchObject({ windDown: true });
    expect(host.inputs[0]).not.toHaveProperty('windDown');
    expect(runtime.getSnapshot().goal?.status).toBe('active');

    // The hand-off reached the model: only a delivered wind-down turn
    // stamps the record.
    runtime.markTurnDelivered(`goal-runtime:${host.started[1]!.turnId}`);
    await runtime.finishTurn(host.started[1]!);

    // The hand-off turn stamps the record, and the stop settles on the
    // dispatch tail where the next continuation was refused.
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().goal?.status).toBe('usage_limited');
    });
    expect(runtime.getSnapshot().goal).toMatchObject({
      limitKind: 'token_budget',
      tokensUsed: 1_500,
      tokenBudget: 1_000,
      windDownTurnId: host.started[1]!.turnId,
      lastReason: expect.stringContaining('autonomous token budget'),
    });
    // No third turn: the hand-off is one per window.
    expect(host.started).toHaveLength(2);
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'turn_finished',
      'usage_limited',
    ]);
    expect(journal.appended[1]!.snapshot.goal).not.toHaveProperty(
      'windDownTurnId',
    );
    expect(journal.appended[2]!.snapshot.goal).toMatchObject({
      windDownTurnId: host.started[1]!.turnId,
    });

    // Resuming IS the user paying for another window: the ceiling moves ahead
    // of the meter, and the re-armed window admits a real continuation again.
    const resumed = await runtime.dispatch({
      action: 'resume',
      expectedGoalId: created.goalId,
      expectedRevision: created.revision,
    });
    expect(resumed.snapshot.goal).toMatchObject({
      status: 'active',
      tokensUsed: 1_500,
      tokenBudget: 2_500,
    });
    expect(resumed.snapshot.goal?.limitKind).toBeUndefined();
    // The re-armed window owes its own hand-off: the old marker is gone and
    // the continuation it admits is ordinary work again.
    expect(resumed.snapshot.goal).not.toHaveProperty('windDownTurnId');
    expect(host.started).toHaveLength(3);
    expect(host.inputs[2]).not.toHaveProperty('windDown');
  });

  it('stops at an exact-ceiling spend without minting another turn', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const spend = new Map<string, number>();
    const runtime = createGoalRuntime({
      journal,
      ledger: {
        takeGoalTurnTokens: (turnId: string) => {
          const tokens = spend.get(turnId) ?? 0;
          spend.delete(turnId);
          return tokens;
        },
      },
      tokenBudgetGrant: 1_000,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });

    // Spend lands exactly on the ceiling: still spent, so the only further
    // turn is the hand-off.
    spend.set(host.started[0]!.turnId, 1_000);
    await runtime.finishTurn(host.started[0]!);
    expect(host.started).toHaveLength(2);
    expect(host.inputs[1]).toMatchObject({ windDown: true });
    // The hand-off reached the model: only a delivered wind-down turn
    // stamps the record.
    runtime.markTurnDelivered(`goal-runtime:${host.started[1]!.turnId}`);
    await runtime.finishTurn(host.started[1]!);

    await vi.waitFor(() => {
      expect(runtime.getSnapshot().goal?.status).toBe('usage_limited');
    });
    expect(runtime.getSnapshot().goal).toMatchObject({
      limitKind: 'token_budget',
      tokensUsed: 1_000,
      tokenBudget: 1_000,
    });
    expect(host.started).toHaveLength(2);
  });

  it('shows the budget stop even when the settle write fails', async () => {
    const journal = fakeGoalJournal({
      appendErrors: [
        undefined,
        undefined,
        undefined,
        new Error('writer unavailable'),
      ],
    });
    const host = fakeGoalTurnHost();
    const spend = new Map<string, number>();
    const runtime = createGoalRuntime({
      journal,
      ledger: {
        takeGoalTurnTokens: (turnId: string) => {
          const tokens = spend.get(turnId) ?? 0;
          spend.delete(turnId);
          return tokens;
        },
      },
      tokenBudgetGrant: 1_000,
    });
    const causes: Array<GoalStateCause | undefined> = [];
    runtime.subscribe((_snapshot, cause) => causes.push(cause));
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });

    spend.set(host.started[0]!.turnId, 1_500);
    await runtime.finishTurn(host.started[0]!);
    // The hand-off reached the model: only a delivered wind-down turn
    // stamps the record.
    runtime.markTurnDelivered(`goal-runtime:${host.started[1]!.turnId}`);
    await runtime.finishTurn(host.started[1]!);

    await vi.waitFor(() => {
      expect(runtime.getSnapshot().goal?.status).toBe('usage_limited');
    });
    // The failed write never reaches the journal, but the visible state
    // still settles: the gate refuses continuations either way, and the
    // user's next action surfaces the persistence loss.
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'turn_finished',
    ]);
    expect(runtime.getSnapshot().goal).toMatchObject({
      limitKind: 'token_budget',
      tokensUsed: 1_500,
      tokenBudget: 1_000,
    });
    expect(causes).toContain('usage_limited');
    expect(host.started).toHaveLength(2);
  });

  it('mints the hand-off again when the host dropped it undelivered', async () => {
    const journal = fakeGoalJournal();
    const spend = new Map<string, number>();
    const failures: Array<Error | undefined> = [];
    const inputs: Array<Parameters<GoalTurnHost['startGoalTurn']>[0]> = [];
    const started: GoalTurnPermit[] = [];
    const host: GoalTurnHost = {
      async startGoalTurn(input) {
        const failure = failures.shift();
        if (failure) throw failure;
        started.push(structuredClone(input.permit));
        inputs.push(structuredClone(input));
      },
      preemptGoalTurn: vi.fn(),
    };
    const runtime = createGoalRuntime({
      journal,
      ledger: {
        takeGoalTurnTokens: (turnId: string) => spend.get(turnId) ?? 0,
      },
      tokenBudgetGrant: 1_000,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });

    // The hand-off's start is refused, so the model never saw it. Only the
    // turn that finishes stamps the record, and nothing finished.
    failures.push(new Error('host is not accepting turns'));
    spend.set(started[0]!.turnId, 1_500);
    await runtime.finishTurn(started[0]!);
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtime.getSnapshot().goal?.status).toBe('active');
    expect(runtime.getSnapshot().goal).not.toHaveProperty('windDownTurnId');

    runtime.bindHost(host);
    await new Promise((resolve) => setImmediate(resolve));
    expect(inputs.at(-1)).toMatchObject({ windDown: true });
    expect(started).toHaveLength(2);
  });

  it('grants the hand-off again when its turn finished without being delivered', async () => {
    // A system message or a direct user query can claim the wind-down
    // continuation's permit and send its own text under it. The turn then
    // finishes, but the user never got the hand-off -- so the record must
    // not say they did, and the next continuation owes it again.
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const spend = new Map<string, number>();
    const runtime = createGoalRuntime({
      journal,
      ledger: {
        takeGoalTurnTokens: (turnId: string) => spend.get(turnId) ?? 0,
      },
      tokenBudgetGrant: 1_000,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    spend.set(host.started[0]!.turnId, 1_500);
    await runtime.finishTurn(host.started[0]!);
    expect(host.inputs[1]).toMatchObject({ windDown: true });

    // Finished under the wind-down permit, never marked delivered.
    await runtime.finishTurn(host.started[1]!);
    await new Promise((resolve) => setImmediate(resolve));

    expect(runtime.getSnapshot().goal?.status).toBe('active');
    expect(runtime.getSnapshot().goal).not.toHaveProperty('windDownTurnId');
    expect(journal.appended.at(-1)!.snapshot.goal).not.toHaveProperty(
      'windDownTurnId',
    );
    expect(host.started).toHaveLength(3);
    expect(host.inputs[2]).toMatchObject({ windDown: true });
  });

  it('stops after the hand-off once a delivered wind-down turn finishes', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const spend = new Map<string, number>();
    const runtime = createGoalRuntime({
      journal,
      ledger: {
        takeGoalTurnTokens: (turnId: string) => spend.get(turnId) ?? 0,
      },
      tokenBudgetGrant: 1_000,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    spend.set(host.started[0]!.turnId, 1_500);
    await runtime.finishTurn(host.started[0]!);
    const windDown = host.started[1]!;
    expect(host.inputs[1]).toMatchObject({ windDown: true });

    runtime.markTurnDelivered(`goal-runtime:${windDown.turnId}`);
    await runtime.finishTurn(windDown);

    await vi.waitFor(() => {
      expect(runtime.getSnapshot().goal?.status).toBe('usage_limited');
    });
    expect(runtime.getSnapshot().goal).toMatchObject({
      limitKind: 'token_budget',
      windDownTurnId: windDown.turnId,
    });
    expect(host.started).toHaveLength(2);
  });

  it('completes a Goal whose hand-off turn proves the objective done', async () => {
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records, journal);
    const verifier: GoalVerifier = vi.fn<GoalVerifier>(async () => ({
      decision: 'accept' as const,
      reason: 'Evidence satisfies the objective',
    }));
    const host = fakeGoalTurnHost();
    const spend = new Map<string, number>();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource,
      verifier,
      ledger: {
        takeGoalTurnTokens: (turnId: string) => spend.get(turnId) ?? 0,
      },
      tokenBudgetGrant: 1_000,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver result' });
    spend.set(host.started[0]!.turnId, 1_500);
    await runtime.finishTurn(host.started[0]!);
    await vi.waitFor(() => expect(host.started).toHaveLength(2));
    const windDown = host.started[1]!;
    expect(host.inputs[1]).toMatchObject({ windDown: true });

    // The hand-off finds the objective already met and says so. A budget
    // stop must not overrule a completion the verifier accepted.
    const cursorId = runtime.getSnapshot().goal!.evidenceCursor.recordId!;
    records = verifierEvidenceRecords(windDown, cursorId);
    runtime.recordTerminalProposal(windDown, {
      status: 'complete',
      reason: 'Delivered',
      evidenceRefs: ['assistant-evidence'],
    });
    await runtime.finishTurn(windDown);

    await vi.waitFor(() => {
      expect(runtime.getSnapshot().goal?.status).toBe('complete');
    });
    expect(journal.appended.map((payload) => payload.cause)).not.toContain(
      'usage_limited',
    );
    expect(host.started).toHaveLength(2);
  });

  it('does not grant a second hand-off after a restart that already saw one', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal, tokenBudgetGrant: 1_000 });
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
            status: 'active',
            evidenceCursor: { recordId: 'limit-record' },
            turnCount: 3,
            activeTimeMs: 1_000,
            tokensUsed: 1_500,
            tokenBudget: 1_000,
            windDownTurnId: 'turn-before-restart',
            createdAt: 1,
            updatedAt: 2,
          },
        },
        'turn_finished',
      ),
    ]);

    // The record says the hand-off already finished; the restart changes
    // nothing about that, so the only thing left to do is stop.
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().goal?.status).toBe('usage_limited');
    });
    expect(runtime.getSnapshot().goal).toMatchObject({
      limitKind: 'token_budget',
      windDownTurnId: 'turn-before-restart',
    });
    expect(host.started).toHaveLength(0);
  });

  it('grants the hand-off after a restart that interrupted it', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal, tokenBudgetGrant: 1_000 });
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
            status: 'active',
            evidenceCursor: { recordId: 'limit-record' },
            turnCount: 3,
            activeTimeMs: 1_000,
            tokensUsed: 1_500,
            tokenBudget: 1_000,
            createdAt: 1,
            updatedAt: 2,
          },
        },
        'turn_finished',
      ),
    ]);

    // No marker: either the window was never handed off, or the process
    // died mid-hand-off. Both mean the user never got one, so it is owed.
    await vi.waitFor(() => expect(host.started).toHaveLength(1));
    expect(host.inputs[0]).toMatchObject({ windDown: true });
    expect(runtime.getSnapshot().goal?.status).toBe('active');
  });

  it('never arms a budget when the runtime opts out with an unbounded grant', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      tokenBudgetGrant: Number.POSITIVE_INFINITY,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    expect(runtime.getSnapshot().goal).not.toHaveProperty('tokenBudget');
    await runtime.finishTurn(host.started[0]!);
    expect(runtime.getSnapshot().goal?.status).toBe('active');
    expect(host.started).toHaveLength(2);
  });

  it('bills nothing when no ledger is configured', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });

    await runtime.finishTurn(host.started[0]!);

    expect(runtime.getSnapshot().goal).toMatchObject({
      turnCount: 1,
      tokensUsed: 0,
    });
  });

  it('finishes the turn when the ledger throws', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      ledger: {
        takeGoalTurnTokens: () => {
          throw new Error('recorder is unavailable');
        },
      },
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });

    await expect(runtime.finishTurn(host.started[0]!)).resolves.toBeUndefined();
    expect(runtime.getSnapshot().goal).toMatchObject({
      turnCount: 1,
      tokensUsed: 0,
    });
  });

  it('persists verifier acceptance before completing a verified proposal', async () => {
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records, journal);
    const verifier: GoalVerifier = vi.fn<GoalVerifier>(async () => ({
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
    const evidenceSource = fakeEvidenceSource(() => records, journal);
    const verifier: GoalVerifier = vi.fn<GoalVerifier>(async () => ({
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

  it('accepts an evidenced infeasible blocker on its first turn, with the next step spelled out', async () => {
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records, journal);
    const verifier: GoalVerifier = vi.fn<GoalVerifier>(async () => ({
      decision: 'accept' as const,
      reason: 'The named branch does not exist',
    }));
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal, evidenceSource, verifier });
    runtime.bindHost(host);
    await runtime.dispatch({
      action: 'create',
      objective: 'Rebase onto the v9 branch',
    });
    const permit = host.started[0]!;
    const cursorId = runtime.getSnapshot().goal!.evidenceCursor.recordId!;
    const base = verifierEvidenceRecords(permit, cursorId, 'probe');
    records = [
      base[0]!,
      {
        ...base[1]!,
        type: 'tool_result',
        provenance: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'shell',
                response: { output: "fatal: branch 'v9' not found" },
              },
            },
          ],
        },
      },
    ];

    // No three-turn streak: the whole point is to stop before the budget
    // does, and the evidence bar (an external fact) is what earns that.
    const receipt = runtime.recordTerminalProposal(permit, {
      status: 'blocked',
      blockerKind: 'infeasible',
      reason:
        'Checked the remote: no v9 branch exists, so nothing in scope can rebase onto it.',
      evidenceRefs: ['probe'],
    });
    expect(receipt).toEqual({ recorded: true, readyForVerification: true });

    await runtime.finishTurn(permit);

    expect(verifier).toHaveBeenCalledWith(
      expect.objectContaining({
        proposal: expect.objectContaining({ blockerKind: 'infeasible' }),
        blockedPolicy: expect.stringContaining(
          'An infeasible blocker may also be accepted immediately',
        ),
      }),
      expect.any(AbortSignal),
    );
    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
      'turn_finished',
      'verifier_accept',
      'blocked',
    ]);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'idle',
      goal: {
        status: 'blocked',
        lastReason: `The named branch does not exist ${GOAL_INFEASIBLE_NEXT_STEP}`,
      },
    });
    expect(host.started).toHaveLength(1);
  });

  it('rejects an invalid evidence reference without calling the verifier', async () => {
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records, journal);
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

  it('verifies a multi-page catalog without checkpointing or changing the fixed scope', async () => {
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records, journal);
    const verifier: GoalVerifier = vi.fn<GoalVerifier>(async () => ({
      decision: 'accept' as const,
      reason: 'Every delivered section is present',
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
    const scopeStart = runtime.getSnapshot().goal!.evidenceCursor.recordId!;
    records = verifierEvidenceWindow(permit, scopeStart, 150);
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'Delivered',
      evidenceRefs: ['assistant-evidence-0'],
    });
    await runtime.finishTurn(permit);
    expect(checkpointVerifier).not.toHaveBeenCalled();
    expect(verifier).toHaveBeenCalledOnce();
    const verification = vi.mocked(verifier).mock.calls[0]![0];
    expect(
      verification.evidenceSnapshot?.requiredEvidence(verification.proposal, {
        includeHistoricalActions: true,
      }),
    ).toHaveLength(150);
    expect(verification.currentDeliveredOutput).toHaveLength(150);
    expect(runtime.getSnapshot().goal).toMatchObject({
      status: 'complete',
      evidenceCursor: { recordId: scopeStart },
    });
    expect(runtime.getSnapshot().goal?.evidenceCheckpoint).toBeUndefined();
    expect(host.started).toHaveLength(1);
  });

  it('sends a real external blocker through verification even when its catalog is multi-page', async () => {
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const verifier: GoalVerifier = vi.fn<GoalVerifier>(async () => ({
      decision: 'accept' as const,
      reason: 'The user needs to grant deployment authority',
    }));
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource: fakeEvidenceSource(() => records, journal),
      verifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deploy' });
    const permit = host.started[0]!;
    const cursorId = runtime.getSnapshot().goal!.evidenceCursor.recordId!;
    records = [
      ...verifierEvidenceWindow(permit, cursorId, 150),
      verifierUserEvidenceRecords(permit, cursorId, 'blocker-evidence')[1]!,
    ];
    runtime.recordTerminalProposal(permit, {
      status: 'blocked',
      blockerKind: 'authority',
      reason: 'User authority is missing',
      evidenceRefs: ['blocker-evidence'],
    });
    await runtime.finishTurn(permit);
    expect(verifier).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot().goal).toMatchObject({ status: 'blocked' });
    expect(runtime.getSnapshot().goal?.limitKind).toBeUndefined();
    expect(host.started).toHaveLength(1);
  });

  it('lets a repeated blocker streak reach the verifier when the catalog truncates', async () => {
    const journal = fakeGoalJournal();
    let records: RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records, journal);
    const verifier: GoalVerifier = vi.fn<GoalVerifier>(async () => ({
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
      'turn_finished',
      'verifier_accept',
      'blocked',
    ]);
    expect(runtime.getSnapshot().goal).toMatchObject({ status: 'blocked' });
  });

  it('preserves raw lineage when a repeated blocker verifier rejects', async () => {
    const journal = fakeGoalJournal();
    let records: RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records, journal);
    const verifier: GoalVerifier = vi.fn<GoalVerifier>(async () => ({
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
    'pauses and retains the proposal when verification %s fails',
    async (failurePoint, failure) => {
      const journal = fakeGoalJournal();
      let records: readonly RuntimeRecord[] = [];
      const evidenceSource = fakeEvidenceSource(() => records, journal);
      if (failurePoint === 'flush') {
        evidenceSource.flush.mockRejectedValueOnce(failure);
      } else if (failurePoint === 'read') {
        evidenceSource.readActiveTranscriptChain.mockRejectedValueOnce(failure);
      }
      const verifier: GoalVerifier =
        failurePoint === 'provider'
          ? vi
              .fn()
              .mockRejectedValueOnce(failure)
              .mockResolvedValue({ decision: 'accept', reason: 'recovered' })
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
          status: 'paused',
          lastReason: expect.stringContaining(failure.message),
        },
      });
      expect(journal.appended.at(-1)?.cause).toBe('pause');
      expect(causes).toEqual(['turn_finished', 'pause']);
      expect(host.started).toHaveLength(1);
      expect(
        journal.appended.at(-1)?.verificationPending?.proposal.evidenceRefs,
      ).toEqual(['assistant-evidence']);
      if (failurePoint === 'cursor')
        records = verifierEvidenceRecords(
          permit,
          runtime.getSnapshot().goal!.evidenceCursor.recordId!,
        );
      await runtime.dispatch({
        action: 'resume',
        expectedGoalId: permit.goalId,
        expectedRevision: permit.revision,
      });
      await vi.waitFor(() =>
        expect(runtime.getSnapshot().goal?.status).toBe('complete'),
      );
      expect(host.started).toHaveLength(1);
    },
  );

  it('invalidates verification and admits a real user turn before a late rejection', async () => {
    const result = deferred<Awaited<ReturnType<GoalVerifier>>>();
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records, journal);
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
    expect(runtime.beginTurn('real-user')).toBeDefined();
    expect(vi.mocked(verifier).mock.calls[0]![1]?.aborted).toBe(true);

    result.resolve({ decision: 'reject', reason: 'Add the missing example' });
    await finishing;

    const userPermit = runtime.permitForTurn('real-user')!;
    expect(userPermit).toBeDefined();
    expect(runtime.getVerifierFeedback(userPermit)).toBeUndefined();
    expect(host.started).toHaveLength(1);
    expect(runtime.getSnapshot().activity).toBe('running');
  });

  it.each(['blocked', 'usage_limited'] as const)(
    'lets real user input invalidate an in-flight %s outcome',
    async (terminalStatus) => {
      const result = deferred<Awaited<ReturnType<GoalVerifier>>>();
      const journal = fakeGoalJournal();
      let records: readonly RuntimeRecord[] = [];
      const evidenceSource = fakeEvidenceSource(() => records, journal);
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
      expect(runtime.beginTurn('real-user')).toBeDefined();
      expect(vi.mocked(verifier).mock.calls[0]![1]?.aborted).toBe(true);

      if (terminalStatus === 'blocked') {
        result.resolve({ decision: 'accept', reason: 'approval required' });
      } else {
        result.reject(new Error('provider unavailable'));
      }
      await finishing;
      expect(runtime.getSnapshot().goal?.status).toBe('active');
      expect(
        journal.appended.some(
          (payload) =>
            payload.cause === 'complete' || payload.cause === 'blocked',
        ),
      ).toBe(false);

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

  it('promotes a waiting reservation when the current turn is released', async () => {
    // The host drains continuations one at a time and the caller holding
    // `queued-user` is what blocks that drain, so minting a fresh
    // continuation here would leave the reservation waiting on a turn that
    // can never start. `finishTurn` promotes in the same situation.
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const initialPermit = host.started[0];

    expect(runtime.beginTurn('queued-user')).toBeUndefined();
    await expect(
      runtime.releaseTurn(`goal-runtime:${initialPermit.turnId}`),
    ).resolves.toBe(true);

    expect(runtime.permitForTurn('queued-user')).toBeDefined();
    expect(host.started).toHaveLength(1);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: { status: 'active' },
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

  it('releases a turn without restarting after a requested pause cannot persist', async () => {
    const writerLost = new Error('writer lost');
    const journal = fakeGoalJournal({
      appendErrors: [undefined, writerLost],
    });
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const permit = host.started[0];

    await expect(
      runtime.dispatch({
        action: 'pause',
        expectedGoalId: permit.goalId,
        expectedRevision: permit.revision,
      }),
    ).rejects.toMatchObject({ cause: writerLost });
    await expect(
      runtime.releaseTurn(`goal-runtime:${permit.turnId}`, {
        requeue: false,
      }),
    ).resolves.toBe(true);

    expect(host.started).toHaveLength(1);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'idle',
      goal: { status: 'active' },
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
    const evidenceSource = fakeEvidenceSource(() => records, journal);
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
      'turn_finished',
      'edit',
    ]);
  });

  it('does not revive an aborted verifier result after pause and resume', async () => {
    const result = deferred<Awaited<ReturnType<GoalVerifier>>>();
    const journal = fakeGoalJournal();
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records, journal);
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
      'turn_finished',
      'pause',
      'resume',
    ]);
    expect(host.started).toHaveLength(2);
  });

  it('does not commit a verifier result after disposal during outcome persistence', async () => {
    const outcomeAppend = deferred<void>();
    const outcomeStarted = deferred<void>();
    const journal = fakeGoalJournal({
      beforeAppend: async (payload) => {
        if (payload.cause === 'verifier_accept') {
          outcomeStarted.resolve();
          await outcomeAppend.promise;
        }
      },
    });
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records, journal);
    const verifier: GoalVerifier = vi.fn<GoalVerifier>(async () => ({
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
    await outcomeStarted.promise;
    runtime.dispose();
    outcomeAppend.resolve();
    await finishing;

    expect(journal.appended.map((payload) => payload.cause)).toEqual([
      'create',
      'turn_finished',
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
    ['verifier_accept', 3, 'accept'],
    ['complete', 4, 'accept'],
    ['verifier_reject', 3, 'reject'],
    ['pause', 3, 'usage'],
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
      const evidenceSource = fakeEvidenceSource(() => records, journal);
      if (outcome === 'usage') {
        evidenceSource.flush.mockRejectedValueOnce(new Error('source failed'));
      }
      const verifier: GoalVerifier = vi.fn<GoalVerifier>(async () => {
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
    const evidenceSource = fakeEvidenceSource(() => records, journal);
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
        const evidenceSource = fakeEvidenceSource(() => records, journal);
        evidenceSource.flush.mockImplementationOnce(() => flushGate.promise);
        const verifier: GoalVerifier = vi.fn<GoalVerifier>(async () =>
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
    const evidenceSource = fakeEvidenceSource(() => records, journal);
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
            tokensUsed: 0,
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
    const evidenceSource = fakeEvidenceSource(() => records, journal);
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

    expect(view.evidenceCatalog).toMatchObject({
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

  it('keeps a failed pause serviceable without reviving its aborted verification', async () => {
    const result = deferred<Awaited<ReturnType<GoalVerifier>>>();
    const journal = fakeGoalJournal({
      appendErrors: [
        undefined,
        undefined,
        undefined,
        new Error('pause write failed'),
      ],
    });
    let records: readonly RuntimeRecord[] = [];
    const evidenceSource = fakeEvidenceSource(() => records, journal);
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
    expect(vi.mocked(verifier).mock.calls[0]![1]?.aborted).toBe(true);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'idle',
      goal: { status: 'paused' },
    });
    result.resolve({ decision: 'accept', reason: 'verified' });
    await finishing;
    expect(runtime.getSnapshot().goal?.status).toBe('paused');
    expect(
      journal.appended.some((payload) => payload.cause === 'complete'),
    ).toBe(false);
    expect(recoverGoalFromRecords(journal.records)).toMatchObject({
      kind: 'v2',
      payload: {
        verificationPending: {
          proposal: { evidenceRefs: ['assistant-evidence'] },
        },
      },
    });
    await runtime.dispatch({
      action: 'resume',
      expectedGoalId: permit.goalId,
      expectedRevision: permit.revision,
    });
    expect(verifier).toHaveBeenCalledTimes(2);
    expect(vi.mocked(verifier).mock.calls[1]![1]?.aborted).toBe(false);
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

  it('reports a lost session writer as GoalPersistenceUnavailableError', async () => {
    // The journal rejects a lost writer with its own error type, but callers
    // key the "no persistence, so no goal" degradation off this class. A raw
    // writer error escaping `clear` is what makes an ACP `/goal clear` fail
    // the user's whole prompt request for the rest of the session.
    class SessionWriterUnavailableError extends Error {
      constructor() {
        super('Session writer is unavailable');
        this.name = 'SessionWriterUnavailableError';
      }
    }
    const writerLost = new SessionWriterUnavailableError();
    const journal = fakeGoalJournal({
      appendErrors: [undefined, writerLost],
    });
    const runtime = createGoalRuntime({ journal });
    await runtime.dispatch({ action: 'create', objective: 'ship it' });
    const current = runtime.getSnapshot().goal;
    if (!current) throw new Error('expected the created goal');

    const clearing = runtime.dispatch({
      action: 'clear',
      expectedGoalId: current.goalId,
      expectedRevision: current.revision,
    });

    await expect(clearing).rejects.toBeInstanceOf(
      GoalPersistenceUnavailableError,
    );
    await expect(clearing).rejects.toMatchObject({
      message: 'Session writer is unavailable',
      cause: writerLost,
    });
    // The failed write must not be mistaken for a committed clear.
    expect(runtime.getSnapshot().goal?.goalId).toBe(current.goalId);
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
          tokensUsed: 0,
          createdAt: 1,
          updatedAt: 2,
        },
      }),
    ]);

    expect(observed).toEqual(['pause']);
  });

  it('marks only the restore broadcast as a replay', async () => {
    // The restore broadcast carries the persisted record's cause. A subscriber
    // counting transitions would otherwise count the recovered `pause` again
    // on every resume, as if the user had just paused.
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    runtime.bindHost(fakeGoalTurnHost());
    const observed: Array<{
      cause: GoalStateCause | undefined;
      meta: GoalBroadcastMeta | undefined;
    }> = [];
    runtime.subscribe((_snapshot, cause, meta) =>
      observed.push({ cause, meta }),
    );

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
          tokensUsed: 0,
          createdAt: 1,
          updatedAt: 2,
        },
      }),
    ]);
    await runtime.dispatch({
      action: 'resume',
      expectedGoalId: 'g-1',
      expectedRevision: 1,
    });

    expect(observed[0]).toEqual({ cause: 'pause', meta: { replayed: true } });
    const live = observed.slice(1);
    expect(live.map(({ cause }) => cause)).toContain('resume');
    expect(live.every(({ meta }) => meta === undefined)).toBe(true);
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
          tokensUsed: 0,
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
        tokensUsed: 0,
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

  it('journals a pause reason and schedules no continuation after it', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const permit = host.started[0];

    await runtime.dispatch({
      action: 'pause',
      expectedGoalId: permit.goalId,
      expectedRevision: permit.revision,
      reason: 'Interrupted by the user.',
    });

    const paused = journal.appended.at(-1);
    expect(paused?.cause).toBe('pause');
    expect(paused?.snapshot.goal?.status).toBe('paused');
    expect(paused?.snapshot.goal?.lastReason).toBe('Interrupted by the user.');
    expect(runtime.getSnapshot().goal?.lastReason).toBe(
      'Interrupted by the user.',
    );

    // A release arriving after the pause -- the host settling the turn the
    // user just interrupted -- must not restart the loop behind their back.
    await runtime.releaseTurn('goal-runtime:' + permit.turnId);
    expect(host.started).toHaveLength(1);
    expect(runtime.getSnapshot().goal?.status).toBe('paused');
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
          tokensUsed: 0,
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
          tokensUsed: 0,
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
        tokensUsed: 0,
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
          tokensUsed: 0,
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
          tokensUsed: 0,
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

  it('prepares an active restore without broadcasting or starting work', async () => {
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    const listener = vi.fn();
    runtime.bindHost(host);
    runtime.subscribe(listener);
    const record = goalStateRecord({
      v: 2,
      activity: 'idle',
      goal: {
        goalId: 'g-selective',
        revision: 1,
        objective: 'resume selectively',
        status: 'active',
        evidenceCursor: { recordId: 'restore-record' },
        turnCount: 1,
        activeTimeMs: 10,
        tokensUsed: 0,
        createdAt: 1,
        updatedAt: 2,
      },
    });

    await runtime.prepareRestore([record]);

    expect(runtime.getSnapshot().goal?.status).toBe('active');
    expect(listener).not.toHaveBeenCalled();
    expect(host.started).toEqual([]);

    await runtime.activateRestoredWork();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(host.started).toHaveLength(1);
  });

  it('does not charge offline time to a restored active Goal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(43_201_000);
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
      runtime.bindHost(host);
      const record = goalStateRecord({
        v: 2,
        activity: 'idle',
        goal: {
          goalId: 'g-restored-time-budget',
          revision: 1,
          objective: 'resume without charging offline time',
          status: 'active',
          evidenceCursor: { recordId: 'restore-record' },
          turnCount: 1,
          activeTimeMs: 10_000,
          activeTimeBudgetMs: 60_000,
          tokensUsed: 0,
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      });

      await runtime.prepareRestore([record]);
      expect(runtime.getSnapshot().goal).toMatchObject({
        status: 'active',
        activeTimeMs: 10_000,
        activeTimeBudgetMs: 60_000,
        updatedAt: 43_201_000,
      });

      await runtime.activateRestoredWork();
      expect(host.inputs).toHaveLength(1);
      expect(host.inputs[0]).not.toHaveProperty('windDown');
      expect(host.inputs[0]?.usage).toMatchObject({
        activeTimeMs: 10_000,
        activeTimeBudgetMs: 60_000,
      });
      expect(runtime.getSnapshot().goal?.status).toBe('active');
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces preparation and activation and rejects activation before preparation', async () => {
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    await expect(runtime.activateRestoredWork()).rejects.toThrow(
      'preparation has not started',
    );
    const record = goalStateRecord({
      v: 2,
      activity: 'idle',
      goal: null,
    });

    const firstPreparation = runtime.prepareRestore([record]);
    const secondPreparation = runtime.prepareRestore([record]);
    await Promise.all([firstPreparation, secondPreparation]);
    const firstActivation = runtime.activateRestoredWork();
    const secondActivation = runtime.activateRestoredWork();

    await expect(
      Promise.all([firstActivation, secondActivation]),
    ).resolves.toEqual([undefined, undefined]);
  });

  it('prevents unfinished restore preparation from committing after disposal', async () => {
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const runtime = createGoalRuntime({
      journal: fakeGoalJournal({ beforeAppend: () => appendGate }),
    });
    const preparing = runtime.prepareRestore([legacyGoalRecord()]);

    await Promise.resolve();
    runtime.dispose();
    releaseAppend();

    await expect(preparing).rejects.toThrow('Goal runtime has been disposed');
    await expect(runtime.activateRestoredWork()).rejects.toThrow(
      'Goal runtime has been disposed',
    );
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
    expect(runtime.getSnapshot().clearedGoal).toEqual({
      goalId: replaced.snapshot.goal!.goalId,
      revision: 1,
      updatedAt: replaced.snapshot.goal!.updatedAt,
    });
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

  it('discards an unconsumed terminal proposal when real user input arrives', async () => {
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

    expect(runtime.beginTurn('real-user-during-verification')).toBeDefined();
    expect(runtime.getSnapshot().activity).toBe('running');
    const replacementHost = fakeGoalTurnHost();
    runtime.bindHost(replacementHost);
    await Promise.resolve();
    expect(replacementHost.started).toEqual([]);
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

  describe('objective-updated notice', () => {
    const flagsOf = (host: ReturnType<typeof fakeGoalTurnHost>) =>
      host.inputs.map((input) => input.objectiveUpdated ?? false);
    // Real hosts mark a continuation delivered when they send its prompt;
    // the fake host records the hand-off and nothing else, so tests that
    // mean "the model saw this turn" say so before finishing it.
    const finishDelivered = async (
      runtime: ReturnType<typeof createGoalRuntime>,
      permit: GoalTurnPermit,
    ) => {
      runtime.markTurnDelivered(`goal-runtime:${permit.turnId}`);
      await runtime.finishTurn(permit);
    };

    it('stays off for a Goal whose objective never changed', async () => {
      const journal = fakeGoalJournal();
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({ journal });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      await finishDelivered(runtime, host.started[0]!);
      await finishDelivered(runtime, host.started[1]!);

      // Including the very first continuation: a new Goal supersedes nothing.
      expect(flagsOf(host)).toEqual([false, false, false]);
    });

    it('fires once after an edit, then goes quiet again', async () => {
      const journal = fakeGoalJournal();
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({ journal });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      await finishDelivered(runtime, host.started[0]!);
      await runtime.dispatch({
        action: 'edit',
        objective: 'ship the rest',
        expectedGoalId: runtime.getSnapshot().goal!.goalId,
        expectedRevision: 1,
      });
      await finishDelivered(runtime, host.started.at(-1)!);

      // create, continuation, edit -> notice, next continuation -> quiet.
      expect(flagsOf(host)).toEqual([false, false, true, false]);
      expect(host.inputs.at(-2)?.continuationContext).toBe('ship the rest');
    });

    it('fires after a replace, which supersedes a different Goal entirely', async () => {
      const journal = fakeGoalJournal();
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({ journal });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      await finishDelivered(runtime, host.started[0]!);
      await runtime.dispatch({
        action: 'replace',
        objective: 'ship something else',
        expectedGoalId: runtime.getSnapshot().goal!.goalId,
        expectedRevision: 1,
      });

      // The new Goal is revision 1 like a fresh create, so the notice cannot
      // key on the revision alone -- what changed is the objective, which the
      // replaced Goal's finished turn handed to the model.
      expect(runtime.getSnapshot().goal).toMatchObject({ revision: 1 });
      expect(flagsOf(host)).toEqual([false, false, true]);
    });

    it('stays off across pause and resume, which change no objective', async () => {
      const journal = fakeGoalJournal();
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({ journal });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      const goalId = runtime.getSnapshot().goal!.goalId;
      await runtime.releaseTurn(`goal-runtime:${host.started[0]!.turnId}`);
      await runtime.dispatch({
        action: 'pause',
        expectedGoalId: goalId,
        expectedRevision: 1,
      });
      await runtime.dispatch({
        action: 'resume',
        expectedGoalId: goalId,
        expectedRevision: 1,
      });

      expect(flagsOf(host).some(Boolean)).toBe(false);
    });

    it('redelivers the notice when the host never took the prompt', async () => {
      const journal = fakeGoalJournal();
      const failures: Array<Error | undefined> = [];
      const inputs: Array<Parameters<GoalTurnHost['startGoalTurn']>[0]> = [];
      const started: GoalTurnPermit[] = [];
      const host: GoalTurnHost = {
        async startGoalTurn(input) {
          const failure = failures.shift();
          if (failure) throw failure;
          started.push(structuredClone(input.permit));
          inputs.push(structuredClone(input));
        },
        preemptGoalTurn: vi.fn(),
      };
      const runtime = createGoalRuntime({ journal });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      const goalId = runtime.getSnapshot().goal!.goalId;
      await finishDelivered(runtime, started[0]!);

      // The edit's continuation is refused by the host, so the notice it
      // carried never reached the model. Marking it announced there would
      // drop it for good.
      failures.push(new Error('host is not accepting turns'));
      await runtime.dispatch({
        action: 'edit',
        objective: 'ship the rest',
        expectedGoalId: goalId,
        expectedRevision: 1,
      });
      await new Promise((resolve) => setImmediate(resolve));
      runtime.bindHost(host);
      await new Promise((resolve) => setImmediate(resolve));

      expect(inputs.at(-1)?.objectiveUpdated).toBe(true);
      expect(inputs.at(-1)?.continuationContext).toBe('ship the rest');
    });

    it('redelivers the notice when an accepted turn is dropped before delivery', async () => {
      const journal = fakeGoalJournal();
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({ journal });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      const goalId = runtime.getSnapshot().goal!.goalId;
      await finishDelivered(runtime, host.started[0]!);
      await runtime.dispatch({
        action: 'edit',
        objective: 'ship the rest',
        expectedGoalId: goalId,
        expectedRevision: 1,
      });

      // The notice-carrying continuation was accepted by the host (queued)
      // but the host drops it before the model sees it -- the TUI Escape
      // path, ACP cancelPendingPrompt. Its replacement carries the same
      // (goalId, revision) pair, so the notice must still be owed.
      expect(host.inputs.at(-1)?.objectiveUpdated).toBe(true);
      await runtime.releaseTurn(`goal-runtime:${host.started.at(-1)!.turnId}`);

      expect(host.inputs.at(-1)?.objectiveUpdated).toBe(true);
      expect(host.inputs.at(-1)?.continuationContext).toBe('ship the rest');
    });

    it('stays quiet when the dropped notice was carried back by its replacement', async () => {
      const journal = fakeGoalJournal();
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({ journal });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      const goalId = runtime.getSnapshot().goal!.goalId;
      await finishDelivered(runtime, host.started[0]!);
      await runtime.dispatch({
        action: 'edit',
        objective: 'ship the rest',
        expectedGoalId: goalId,
        expectedRevision: 1,
      });
      await runtime.releaseTurn(`goal-runtime:${host.started.at(-1)!.turnId}`);
      await finishDelivered(runtime, host.started.at(-1)!);

      // The redelivered notice landed; the continuation after it is quiet.
      expect(flagsOf(host)).toEqual([false, false, true, true, false]);
    });

    it('does not fire for a Goal that replaced one never handed to the model', async () => {
      const journal = fakeGoalJournal();
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({ journal });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      // The create's continuation sat accepted-but-undelivered when replace
      // superseded it: the model never received the old objective, so the
      // new Goal's first continuation cannot claim it replaces one.
      await runtime.dispatch({
        action: 'replace',
        objective: 'ship something else',
        expectedGoalId: runtime.getSnapshot().goal!.goalId,
        expectedRevision: 1,
      });

      expect(runtime.getSnapshot().goal).toMatchObject({ revision: 1 });
      expect(flagsOf(host)).toEqual([false, false]);
    });

    it('does not fire for a delivered turn that settles through releaseTurn', async () => {
      // The ACP degraded-persistence fallback settles a model-started turn
      // with releaseTurn. That turn WAS delivered, so its announcement must
      // stand instead of rolling back and re-firing on the next continuation.
      const journal = fakeGoalJournal();
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({ journal });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      const goalId = runtime.getSnapshot().goal!.goalId;
      await finishDelivered(runtime, host.started[0]!);
      await runtime.dispatch({
        action: 'edit',
        objective: 'ship the rest',
        expectedGoalId: goalId,
        expectedRevision: 1,
      });
      const delivered = host.started.at(-1)!;
      runtime.markTurnDelivered(`goal-runtime:${delivered.turnId}`);

      await runtime.releaseTurn(`goal-runtime:${delivered.turnId}`);

      expect(host.inputs.at(-1)?.objectiveUpdated).toBeFalsy();
    });

    it('keeps the announcement of a delivered turn across a mid-turn pause', async () => {
      const journal = fakeGoalJournal();
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({ journal });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      const goalId = runtime.getSnapshot().goal!.goalId;
      await finishDelivered(runtime, host.started[0]!);
      await runtime.dispatch({
        action: 'edit',
        objective: 'ship the rest',
        expectedGoalId: goalId,
        expectedRevision: 1,
      });
      const inFlight = host.started.at(-1)!;
      runtime.markTurnDelivered(`goal-runtime:${inFlight.turnId}`);
      await runtime.dispatch({
        action: 'pause',
        expectedGoalId: goalId,
        expectedRevision: 2,
      });
      await runtime.dispatch({
        action: 'resume',
        expectedGoalId: goalId,
        expectedRevision: 2,
      });

      // The pause interrupted a turn that already handed the model the new
      // objective; resuming it changes nothing the notice could assert.
      expect(host.inputs.at(-1)?.objectiveUpdated).toBeFalsy();
    });

    it('stays off for a Goal created after a cleared one', async () => {
      const journal = fakeGoalJournal();
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({ journal });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      await finishDelivered(runtime, host.started[0]!);
      await runtime.dispatch({
        action: 'clear',
        expectedGoalId: runtime.getSnapshot().goal!.goalId,
        expectedRevision: 1,
      });
      await runtime.dispatch({
        action: 'create',
        objective: 'do something else',
      });

      // The first continuation of a fresh Goal supersedes nothing, even when
      // an earlier Goal announced an objective in this session.
      expect(flagsOf(host)).toEqual([false, false, false]);
    });

    it('stays off for a Goal that replaces a verifier-accepted one', async () => {
      const journal = fakeGoalJournal();
      let records: readonly RuntimeRecord[] = [];
      const evidenceSource = fakeEvidenceSource(() => records, journal);
      const verifier: GoalVerifier = vi.fn<GoalVerifier>(async () => ({
        decision: 'accept' as const,
        reason: 'Evidence satisfies the objective',
      }));
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({ journal, evidenceSource, verifier });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'deliver result' });
      const permit = host.started[0]!;
      const cursorId = runtime.getSnapshot().goal!.evidenceCursor.recordId!;
      records = verifierEvidenceRecords(permit, cursorId);
      runtime.recordTerminalProposal(permit, {
        status: 'complete',
        reason: 'Delivered',
        evidenceRefs: ['assistant-evidence'],
      });
      await finishDelivered(runtime, permit);

      // Replace directly over the completed Goal -- no clear in between, so
      // only the accept-time reset keeps the old announcement from firing.
      // The previous Goal completed with the verifier's blessing: nothing
      // was swapped out mid-work, so the new Goal's first turn carries no
      // notice.
      await runtime.dispatch({
        action: 'replace',
        objective: 'next goal',
        expectedGoalId: permit.goalId,
        expectedRevision: permit.revision,
      });

      expect(host.inputs.at(-1)?.objectiveUpdated).toBeFalsy();
    });

    it("does not leak a refused turn's announcement into a promoted user turn", async () => {
      const journal = fakeGoalJournal();
      const failures: Array<Error | undefined> = [];
      const inputs: Array<Parameters<GoalTurnHost['startGoalTurn']>[0]> = [];
      const started: GoalTurnPermit[] = [];
      const host: GoalTurnHost = {
        async startGoalTurn(input) {
          const failure = failures.shift();
          if (failure) throw failure;
          started.push(structuredClone(input.permit));
          inputs.push(structuredClone(input));
        },
        preemptGoalTurn: vi.fn(),
      };
      const runtime = createGoalRuntime({ journal });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      const goalId = runtime.getSnapshot().goal!.goalId;
      await finishDelivered(runtime, started[0]!);

      // The edit's continuation is refused by the host; a user turn queued
      // behind it is promoted by the failure settlement. The refused turn's
      // announcement must not ride along into that user turn.
      failures.push(new Error('host is not accepting turns'));
      await runtime.dispatch({
        action: 'edit',
        objective: 'ship the rest',
        expectedGoalId: goalId,
        expectedRevision: 1,
      });
      runtime.beginTurn('user-turn-1');
      await new Promise((resolve) => setImmediate(resolve));
      const userPermit = runtime.permitForTurn('user-turn-1');
      expect(userPermit).toBeDefined();
      await finishDelivered(runtime, userPermit!);
      runtime.bindHost(host);

      // Editing back to the original text hands the model nothing new.
      await runtime.dispatch({
        action: 'edit',
        objective: 'ship',
        expectedGoalId: goalId,
        expectedRevision: 2,
      });

      expect(inputs.at(-1)?.objectiveUpdated).toBeFalsy();
      expect(inputs.at(-1)?.continuationContext).toBe('ship');
    });

    it('stays off for edits that leave the objective text unchanged', async () => {
      const journal = fakeGoalJournal();
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({ journal });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      const goalId = runtime.getSnapshot().goal!.goalId;
      await finishDelivered(runtime, host.started[0]!);

      await runtime.dispatch({
        action: 'edit',
        objective: 'ship',
        expectedGoalId: goalId,
        expectedRevision: 1,
      });
      await runtime.dispatch({
        action: 'edit',
        objective: ' ship ',
        expectedGoalId: goalId,
        expectedRevision: 2,
      });

      // Both edits bumped the revision, but the objective the model is handed
      // is byte-identical to the one it already has: no change, no notice.
      expect(flagsOf(host)).toEqual([false, false, false, false]);

      await runtime.dispatch({
        action: 'edit',
        objective: 'ship the rest',
        expectedGoalId: goalId,
        expectedRevision: 3,
      });
      expect(host.inputs.at(-1)?.objectiveUpdated).toBe(true);
    });

    it('keeps the notice owed when a turn finishes under the permit without the prompt', async () => {
      // A system message or a direct user query can claim a queued
      // continuation's permit and send its own text under it; the turn then
      // finishes normally without the continuation prompt ever being sent.
      // Finishing is not delivery: the next continuation still owes the
      // notice.
      const journal = fakeGoalJournal();
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({ journal });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      const goalId = runtime.getSnapshot().goal!.goalId;
      await finishDelivered(runtime, host.started[0]!);
      await runtime.dispatch({
        action: 'edit',
        objective: 'ship the rest',
        expectedGoalId: goalId,
        expectedRevision: 1,
      });

      await runtime.finishTurn(host.started.at(-1)!);

      expect(flagsOf(host)).toEqual([false, false, true, true]);
    });

    it('ignores a delivery mark carrying a stale turn key', async () => {
      // The mark names the turn it is about; a mark for an earlier turn
      // must not flip the in-flight one to delivered, or a release would
      // commit an announcement the model never received.
      const journal = fakeGoalJournal();
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({ journal });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      const goalId = runtime.getSnapshot().goal!.goalId;
      const first = host.started[0]!;
      await finishDelivered(runtime, first);
      await runtime.dispatch({
        action: 'edit',
        objective: 'ship the rest',
        expectedGoalId: goalId,
        expectedRevision: 1,
      });
      const inFlight = host.started.at(-1)!;

      runtime.markTurnDelivered(`goal-runtime:${first.turnId}`);
      await runtime.releaseTurn(`goal-runtime:${inFlight.turnId}`);

      expect(flagsOf(host)).toEqual([false, false, true, true]);
    });

    it('fires after an edit made while the Goal was blocked', async () => {
      // A blocked Goal is suspended, not ended: the model still holds the
      // objective it was given, so an edit followed by resume is exactly
      // the change the notice exists for -- same as pause -> edit -> resume.
      const journal = fakeGoalJournal();
      let records: readonly RuntimeRecord[] = [];
      const evidenceSource = fakeEvidenceSource(() => records, journal);
      const verifier: GoalVerifier = vi.fn<GoalVerifier>(async () => ({
        decision: 'accept' as const,
        reason: 'User authority is required',
      }));
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({ journal, evidenceSource, verifier });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'deliver result' });
      const permit = host.started[0]!;
      records = verifierUserEvidenceRecords(
        permit,
        runtime.getSnapshot().goal!.evidenceCursor.recordId!,
      );
      runtime.recordTerminalProposal(permit, {
        status: 'blocked',
        blockerKind: 'authority',
        reason: 'Needs sign-off',
        evidenceRefs: ['user-evidence'],
      });
      await finishDelivered(runtime, permit);
      expect(runtime.getSnapshot().goal?.status).toBe('blocked');

      await runtime.dispatch({
        action: 'edit',
        objective: 'deliver the other result',
        expectedGoalId: permit.goalId,
        expectedRevision: permit.revision,
      });
      await runtime.dispatch({
        action: 'resume',
        expectedGoalId: permit.goalId,
        expectedRevision: permit.revision + 1,
      });

      expect(host.inputs.at(-1)?.objectiveUpdated).toBe(true);
    });

    it('stays off for a Goal created after a completed one was cleared', async () => {
      const journal = fakeGoalJournal();
      let records: readonly RuntimeRecord[] = [];
      const evidenceSource = fakeEvidenceSource(() => records, journal);
      const verifier: GoalVerifier = vi.fn<GoalVerifier>(async () => ({
        decision: 'accept' as const,
        reason: 'Evidence satisfies the objective',
      }));
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({ journal, evidenceSource, verifier });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'deliver result' });
      const permit = host.started[0]!;
      const cursorId = runtime.getSnapshot().goal!.evidenceCursor.recordId!;
      records = verifierEvidenceRecords(permit, cursorId);
      runtime.recordTerminalProposal(permit, {
        status: 'complete',
        reason: 'Delivered',
        evidenceRefs: ['assistant-evidence'],
      });
      await finishDelivered(runtime, permit);
      expect(runtime.getSnapshot().goal?.status).toBe('complete');

      await runtime.dispatch({
        action: 'clear',
        expectedGoalId: permit.goalId,
        expectedRevision: permit.revision,
      });
      await runtime.dispatch({ action: 'create', objective: 'next goal' });

      expect(host.inputs.at(-1)?.objectiveUpdated).toBeFalsy();
    });
  });

  describe('continuation usage figures', () => {
    it('hands the host the spend the record held when the turn was scheduled', async () => {
      const journal = fakeGoalJournal();
      const host = fakeGoalTurnHost();
      const spend = new Map<string, number>();
      const runtime = createGoalRuntime({
        journal,
        ledger: {
          takeGoalTurnTokens: (turnId: string) => spend.get(turnId) ?? 0,
        },
        tokenBudgetGrant: 30_000,
      });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      // The first continuation is scheduled before anything has been billed.
      expect(host.inputs[0]?.usage).toEqual({
        tokensUsed: 0,
        tokenBudget: 30_000,
        turnCount: 0,
      });

      spend.set(host.started[0]!.turnId, 2_500);
      await runtime.finishTurn(host.started[0]!);

      expect(host.inputs[1]?.usage).toEqual({
        tokensUsed: 2_500,
        tokenBudget: 30_000,
        turnCount: 1,
      });
    });

    it('omits the ceiling for a Goal that has none', async () => {
      const journal = fakeGoalJournal();
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({
        journal,
        tokenBudgetGrant: Number.POSITIVE_INFINITY,
      });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      expect(host.inputs[0]?.usage).toEqual({
        tokensUsed: 0,
        turnCount: 0,
      });
    });

    it('carries the figures into the wind-down hand-off', async () => {
      // The hand-off reports where the Goal stopped, so it needs the numbers
      // even though it is told not to start new work.
      const journal = fakeGoalJournal();
      const host = fakeGoalTurnHost();
      const spend = new Map<string, number>();
      const runtime = createGoalRuntime({
        journal,
        ledger: {
          takeGoalTurnTokens: (turnId: string) => spend.get(turnId) ?? 0,
        },
        tokenBudgetGrant: 1_000,
      });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      spend.set(host.started[0]!.turnId, 1_500);
      await runtime.finishTurn(host.started[0]!);

      expect(host.inputs[1]).toMatchObject({ windDown: true });
      expect(host.inputs[1]?.usage).toEqual({
        tokensUsed: 1_500,
        tokenBudget: 1_000,
        turnCount: 1,
      });
    });
  });

  describe('no-progress bound', () => {
    function noProgressHarness(
      options: {
        appendErrors?: Array<Error | undefined>;
        beforeAppend?: (payload: GoalStateRecordPayloadV2) => void;
        tokenBudgetGrant?: number;
        countToolResults?: boolean;
        throwOnCount?: boolean;
        countsNotANumber?: boolean;
        checkpointVerifier?: GoalCheckpointVerifier;
      } = {},
    ) {
      const journal = fakeGoalJournal({
        ...(options.appendErrors ? { appendErrors: options.appendErrors } : {}),
        ...(options.beforeAppend ? { beforeAppend: options.beforeAppend } : {}),
      });
      const host = fakeGoalTurnHost();
      const toolResults = new Map<string, number>();
      const spend = new Map<string, number>();
      let records: readonly RuntimeRecord[] = [];
      const runtime = createGoalRuntime({
        journal,
        ledger: {
          takeGoalTurnTokens: (turnId: string) => spend.get(turnId) ?? 0,
          ...(options.countToolResults === false
            ? {}
            : {
                takeGoalTurnToolResults: (turnId: string) => {
                  if (options.throwOnCount) {
                    throw new Error('ledger unavailable');
                  }
                  if (options.countsNotANumber) return Number.NaN;
                  const count = toolResults.get(turnId) ?? 0;
                  toolResults.delete(turnId);
                  return count;
                },
              }),
        },
        ...(options.checkpointVerifier
          ? {
              evidenceSource: fakeEvidenceSource(() => records, journal),
              verifier: vi.fn(),
              checkpointVerifier: options.checkpointVerifier,
            }
          : {}),
        ...(options.tokenBudgetGrant === undefined
          ? {}
          : { tokenBudgetGrant: options.tokenBudgetGrant }),
      });
      runtime.bindHost(host);
      const setEvidence = (next: readonly RuntimeRecord[]) => {
        records = next;
      };
      return { journal, host, runtime, toolResults, spend, setEvidence };
    }

    async function finishAutonomousTurn(
      runtime: ReturnType<typeof createGoalRuntime>,
      permit: GoalTurnPermit,
    ): Promise<void> {
      runtime.markTurnDelivered(`goal-runtime:${permit.turnId}`);
      await runtime.finishTurn(permit);
    }

    it('pauses a Goal whose autonomous turns record nothing to judge', async () => {
      const { journal, host, runtime } = noProgressHarness();
      const causes: Array<GoalStateCause | undefined> = [];
      runtime.subscribe((_snapshot, cause) => causes.push(cause));
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      for (let turn = 0; turn < GOAL_NO_PROGRESS_TURN_LIMIT; turn++) {
        await finishAutonomousTurn(runtime, host.started[turn]!);
      }

      expect(runtime.getSnapshot().goal).toMatchObject({
        status: 'paused',
        noProgressTurns: GOAL_NO_PROGRESS_TURN_LIMIT,
        lastReason: GOAL_PAUSE_REASON_NO_PROGRESS,
      });
      // The bound stops the Goal instead of minting a fourth continuation.
      expect(host.started).toHaveLength(GOAL_NO_PROGRESS_TURN_LIMIT);
      expect(journal.appended.map((payload) => payload.cause)).toEqual([
        'create',
        'turn_finished',
        'turn_finished',
        'turn_finished',
        'pause',
      ]);
      expect(journal.appended.at(-1)?.snapshot.goal).toMatchObject({
        status: 'paused',
        lastReason: GOAL_PAUSE_REASON_NO_PROGRESS,
      });
      expect(causes.at(-1)).toBe('pause');
    });

    it('restarts the streak on a turn that records a tool result', async () => {
      const { host, runtime, toolResults } = noProgressHarness();
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      await finishAutonomousTurn(runtime, host.started[0]!);
      expect(runtime.getSnapshot().goal?.noProgressTurns).toBe(1);

      toolResults.set(host.started[1]!.turnId, 1);
      await finishAutonomousTurn(runtime, host.started[1]!);
      expect(runtime.getSnapshot().goal?.noProgressTurns).toBeUndefined();

      await finishAutonomousTurn(runtime, host.started[2]!);
      await finishAutonomousTurn(runtime, host.started[3]!);
      expect(runtime.getSnapshot().goal).toMatchObject({
        status: 'active',
        noProgressTurns: 2,
      });
    });

    it('restarts the streak on a turn that proposes a terminal state', async () => {
      const { host, runtime } = noProgressHarness();
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      await finishAutonomousTurn(runtime, host.started[0]!);
      expect(runtime.getSnapshot().goal?.noProgressTurns).toBe(1);

      // A first repeated blocker is recorded but not yet ready for the
      // verifier, so the turn stays a working turn -- and it worked.
      runtime.recordTerminalProposal(host.started[1]!, {
        status: 'blocked',
        reason: 'The upstream service is down',
        evidenceRefs: [],
        blockerKind: 'repeated',
      });
      await finishAutonomousTurn(runtime, host.started[1]!);

      expect(runtime.getSnapshot().goal).toMatchObject({ status: 'active' });
      expect(runtime.getSnapshot().goal?.noProgressTurns).toBeUndefined();
    });

    it('restarts the streak on a turn the user drove', async () => {
      const { host, runtime } = noProgressHarness();
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      // No delivery mark: the permit carried the user's own text, so the
      // Goal was being steered rather than idling.
      for (let turn = 0; turn <= GOAL_NO_PROGRESS_TURN_LIMIT; turn++) {
        await runtime.finishTurn(host.started[turn]!);
      }

      expect(runtime.getSnapshot().goal).toMatchObject({ status: 'active' });
      expect(runtime.getSnapshot().goal?.noProgressTurns).toBeUndefined();
    });

    it('exempts the wind-down hand-off from the streak', async () => {
      const { host, runtime, spend } = noProgressHarness({
        tokenBudgetGrant: 1_000,
      });
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      await finishAutonomousTurn(runtime, host.started[0]!);
      spend.set(host.started[1]!.turnId, 1_500);
      await finishAutonomousTurn(runtime, host.started[1]!);
      expect(runtime.getSnapshot().goal?.noProgressTurns).toBe(2);

      const windDown = host.started[2]!;
      expect(host.inputs[2]).toMatchObject({ windDown: true });
      await finishAutonomousTurn(runtime, windDown);

      // The hand-off turn is asked to hand off, not to work, so it neither
      // counts against the streak nor clears it.
      await vi.waitFor(() => {
        expect(runtime.getSnapshot().goal?.status).toBe('usage_limited');
      });
      expect(runtime.getSnapshot().goal?.noProgressTurns).toBe(2);
    });

    it('leaves the bound off when the ledger cannot count tool results', async () => {
      const { host, runtime } = noProgressHarness({ countToolResults: false });
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      for (let turn = 0; turn <= GOAL_NO_PROGRESS_TURN_LIMIT; turn++) {
        await finishAutonomousTurn(runtime, host.started[turn]!);
      }

      expect(runtime.getSnapshot().goal).toMatchObject({ status: 'active' });
      expect(runtime.getSnapshot().goal?.noProgressTurns).toBeUndefined();
    });

    it('leaves the bound off when the ledger throws', async () => {
      const { host, runtime } = noProgressHarness({ throwOnCount: true });
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      for (let turn = 0; turn <= GOAL_NO_PROGRESS_TURN_LIMIT; turn++) {
        await finishAutonomousTurn(runtime, host.started[turn]!);
      }

      expect(runtime.getSnapshot().goal).toMatchObject({ status: 'active' });
      expect(runtime.getSnapshot().goal?.noProgressTurns).toBeUndefined();
    });

    it('leaves the bound off when the ledger answers with something that is not a count', async () => {
      const { host, runtime } = noProgressHarness({ countsNotANumber: true });
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      for (let turn = 0; turn <= GOAL_NO_PROGRESS_TURN_LIMIT; turn++) {
        await finishAutonomousTurn(runtime, host.started[turn]!);
      }

      expect(runtime.getSnapshot().goal).toMatchObject({ status: 'active' });
      expect(runtime.getSnapshot().goal?.noProgressTurns).toBeUndefined();
    });

    it('does not checkpoint the turn that spends the streak', async () => {
      // A checkpoint is work done for the next turn. On the turn that stops
      // the Goal there is no next turn, and the verifier call would be spent
      // for nothing.
      const checkpointVerifier = vi.fn(async () => ({
        claims: [
          {
            proofKind: 'delivered_output' as const,
            claim: 'The implementation result was delivered.',
            sourceRefs: ['assistant-evidence-79'],
          },
        ],
      }));
      const { journal, host, runtime, setEvidence } = noProgressHarness({
        checkpointVerifier,
      });
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      for (let turn = 0; turn < GOAL_NO_PROGRESS_TURN_LIMIT; turn++) {
        const permit = host.started[turn]!;
        setEvidence(
          verifierEvidenceWindow(
            permit,
            runtime.getSnapshot().goal!.evidenceCursor.recordId!,
            80,
          ),
        );
        await finishAutonomousTurn(runtime, permit);
      }

      expect(checkpointVerifier).not.toHaveBeenCalled();
      expect(journal.appended.map((payload) => payload.cause)).toEqual([
        'create',
        'turn_finished',
        'turn_finished',
        'turn_finished',
        'pause',
      ]);
      expect(runtime.getSnapshot()).toMatchObject({
        activity: 'idle',
        goal: { status: 'paused' },
      });
    });

    it('carries a restored streak into the turn that spends it', async () => {
      const { host, runtime } = noProgressHarness();
      await runtime.restore([
        goalStateRecord(
          {
            v: 2,
            goal: {
              goalId: 'g-1',
              revision: 1,
              objective: 'ship',
              status: 'active',
              evidenceCursor: { recordId: null },
              turnCount: 2,
              activeTimeMs: 0,
              tokensUsed: 0,
              noProgressTurns: GOAL_NO_PROGRESS_TURN_LIMIT - 1,
              createdAt: 0,
              updatedAt: 0,
            },
            activity: 'idle',
          },
          'turn_finished',
        ),
      ]);
      await vi.waitFor(() => expect(host.started).toHaveLength(1));

      await finishAutonomousTurn(runtime, host.started[0]!);

      expect(runtime.getSnapshot().goal).toMatchObject({
        status: 'paused',
        noProgressTurns: GOAL_NO_PROGRESS_TURN_LIMIT,
        lastReason: GOAL_PAUSE_REASON_NO_PROGRESS,
      });
    });

    it('clears the streak when the user resumes the Goal', async () => {
      const { host, runtime } = noProgressHarness();
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      for (let turn = 0; turn < GOAL_NO_PROGRESS_TURN_LIMIT; turn++) {
        await finishAutonomousTurn(runtime, host.started[turn]!);
      }
      const paused = runtime.getSnapshot().goal!;

      await runtime.dispatch({
        action: 'resume',
        expectedGoalId: paused.goalId,
        expectedRevision: paused.revision,
      });

      expect(runtime.getSnapshot().goal).toMatchObject({ status: 'active' });
      expect(runtime.getSnapshot().goal?.noProgressTurns).toBeUndefined();
      expect(runtime.getSnapshot().goal?.lastReason).toBeUndefined();

      // A resumed Goal gets the whole allowance again, not the last turn of
      // the one it just spent.
      await finishAutonomousTurn(
        runtime,
        host.started[GOAL_NO_PROGRESS_TURN_LIMIT]!,
      );
      expect(runtime.getSnapshot().goal).toMatchObject({
        status: 'active',
        noProgressTurns: 1,
      });
    });

    it('shows the no-progress stop even when the settle write fails', async () => {
      const { host, runtime } = noProgressHarness({
        appendErrors: [
          undefined,
          undefined,
          undefined,
          undefined,
          new Error('journal unavailable'),
        ],
      });
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      for (let turn = 0; turn < GOAL_NO_PROGRESS_TURN_LIMIT; turn++) {
        await finishAutonomousTurn(runtime, host.started[turn]!);
      }

      expect(runtime.getSnapshot().goal).toMatchObject({
        status: 'paused',
        lastReason: GOAL_PAUSE_REASON_NO_PROGRESS,
      });
      expect(host.started).toHaveLength(GOAL_NO_PROGRESS_TURN_LIMIT);
    });

    it('lets a waiting user turn outrank the bound without a checkpoint', async () => {
      const checkpointVerifier = vi.fn(async () => ({
        claims: [
          {
            proofKind: 'delivered_output' as const,
            claim: 'The implementation result was delivered.',
            sourceRefs: ['assistant-evidence-79'],
          },
        ],
      }));
      const { host, runtime, setEvidence } = noProgressHarness({
        checkpointVerifier,
      });
      await runtime.restore([
        goalStateRecord(
          {
            v: 2,
            goal: {
              goalId: 'g-1',
              revision: 1,
              objective: 'ship',
              status: 'active',
              evidenceCursor: { recordId: 'record-0' },
              turnCount: 2,
              activeTimeMs: 0,
              tokensUsed: 0,
              noProgressTurns: GOAL_NO_PROGRESS_TURN_LIMIT - 1,
              createdAt: 0,
              updatedAt: 0,
            },
            activity: 'idle',
          },
          'turn_finished',
        ),
      ]);
      await vi.waitFor(() => expect(host.started).toHaveLength(1));

      // The user typed while the third turn was still running.
      const last = host.started[0]!;
      setEvidence(
        verifierEvidenceWindow(
          last,
          runtime.getSnapshot().goal!.evidenceCursor.recordId!,
          80,
        ),
      );
      expect(runtime.beginTurn('user-turn')).toBeUndefined();
      await finishAutonomousTurn(runtime, last);

      // The reservation is served rather than stopped in front of, and the
      // streak that reached the bound is still on the record for the turn
      // after it to spend.
      expect(runtime.getSnapshot().goal).toMatchObject({
        status: 'active',
        noProgressTurns: GOAL_NO_PROGRESS_TURN_LIMIT,
      });
      expect(runtime.permitForTurn('user-turn')).toBeDefined();
      expect(checkpointVerifier).not.toHaveBeenCalled();
      expect(runtime.getSnapshot().goal).not.toHaveProperty(
        'evidenceCheckpoint',
      );
    });

    it('serves a user turn reserved while the pause was being written', async () => {
      // `beginTurn` is synchronous and does not queue, so the reservation
      // can land in the middle of the pause record's append. The guard
      // reads the reservation once before that await; if it did not re-read
      // afterwards, the pause would commit over a caller already waiting in
      // `claimGoalTurn`, whose message would then run as an ordinary turn.
      const race: { reserve?: () => void } = {};
      const { journal, host, runtime } = noProgressHarness({
        beforeAppend: (payload) => {
          if (payload.cause === 'pause') race.reserve?.();
        },
      });
      race.reserve = () => {
        expect(runtime.getSnapshot().goal?.status).toBe('active');
        expect(runtime.beginTurn('user-turn')).toBeUndefined();
      };
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      for (let turn = 0; turn < GOAL_NO_PROGRESS_TURN_LIMIT; turn++) {
        await finishAutonomousTurn(runtime, host.started[turn]!);
      }

      expect(runtime.getSnapshot()).toMatchObject({
        activity: 'running',
        goal: {
          status: 'active',
          noProgressTurns: GOAL_NO_PROGRESS_TURN_LIMIT,
        },
      });
      expect(runtime.permitForTurn('user-turn')).toBeDefined();
      expect(host.started).toHaveLength(GOAL_NO_PROGRESS_TURN_LIMIT);
      // The record that lost the race stays in the journal: a restart
      // recovers a paused Goal with its reason, which resume undoes.
      expect(journal.appended.map((payload) => payload.cause)).toEqual([
        'create',
        'turn_finished',
        'turn_finished',
        'turn_finished',
        'pause',
      ]);
    });

    it('does not spend a restored streak on a turn the ledger could not measure', async () => {
      // The record can say the streak is at the limit -- a `turn_finished`
      // written before a pause append that then failed leaves exactly that
      // -- but the bound fires on the count measured this turn. A ledger
      // that cannot see the turn proves nothing about it, so the Goal runs
      // on and the streak stays on the record for a measured turn to spend.
      const { host, runtime } = noProgressHarness({ countToolResults: false });
      await runtime.restore([
        goalStateRecord(
          {
            v: 2,
            goal: {
              goalId: 'g-1',
              revision: 1,
              objective: 'ship',
              status: 'active',
              evidenceCursor: { recordId: null },
              turnCount: 3,
              activeTimeMs: 0,
              tokensUsed: 0,
              noProgressTurns: GOAL_NO_PROGRESS_TURN_LIMIT,
              createdAt: 0,
              updatedAt: 0,
            },
            activity: 'idle',
          },
          'turn_finished',
        ),
      ]);
      await vi.waitFor(() => expect(host.started).toHaveLength(1));

      await finishAutonomousTurn(runtime, host.started[0]!);

      expect(runtime.getSnapshot().goal).toMatchObject({
        status: 'active',
        noProgressTurns: GOAL_NO_PROGRESS_TURN_LIMIT,
      });
      expect(runtime.getSnapshot().goal?.lastReason).toBeUndefined();
      expect(host.started).toHaveLength(2);
    });

    it('lets a spent token budget outrank the bound on the turn that crosses it', async () => {
      // The budget stop lives in the continuation gate, and so does the
      // wind-down hand-off it grants first. When the third quiet turn is
      // also the one that spends the budget, the Goal must reach that gate:
      // an allowance was used up, and the surfaces that tell a budget stop
      // from an idle pause need the `limitKind` only that stop writes.
      const { host, runtime, spend } = noProgressHarness({
        tokenBudgetGrant: 1_000,
      });
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      for (let turn = 0; turn < GOAL_NO_PROGRESS_TURN_LIMIT - 1; turn++) {
        await finishAutonomousTurn(runtime, host.started[turn]!);
      }
      const crossing = host.started[GOAL_NO_PROGRESS_TURN_LIMIT - 1]!;
      spend.set(crossing.turnId, 1_500);
      await finishAutonomousTurn(runtime, crossing);

      expect(runtime.getSnapshot().goal).toMatchObject({
        status: 'active',
        noProgressTurns: GOAL_NO_PROGRESS_TURN_LIMIT,
      });
      expect(host.inputs.at(-1)).toMatchObject({ windDown: true });

      await finishAutonomousTurn(runtime, host.started.at(-1)!);
      await vi.waitFor(() => {
        expect(runtime.getSnapshot().goal?.status).toBe('usage_limited');
      });
      expect(runtime.getSnapshot().goal).toMatchObject({
        limitKind: 'token_budget',
        noProgressTurns: GOAL_NO_PROGRESS_TURN_LIMIT,
      });
      expect(runtime.getSnapshot().goal?.lastReason).not.toBe(
        GOAL_PAUSE_REASON_NO_PROGRESS,
      );
    });
  });
  describe('turn and active-time budgets', () => {
    async function finishDelivered(
      runtime: ReturnType<typeof createGoalRuntime>,
      permit: GoalTurnPermit,
    ): Promise<void> {
      runtime.markTurnDelivered(`goal-runtime:${permit.turnId}`);
      await runtime.finishTurn(permit);
    }

    it('arms no cadence ceiling unless one is granted', async () => {
      // The token budget defaults to a number; these default to nothing. A
      // cadence is what the user asks for, not a guard every Goal needs.
      const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      const goal = runtime.getSnapshot().goal!;
      expect(goal).not.toHaveProperty('turnBudget');
      expect(goal).not.toHaveProperty('activeTimeBudgetMs');
    });

    it('hands off and stops when the turn budget is spent, and resume re-arms it', async () => {
      const journal = fakeGoalJournal();
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({
        journal,
        turnBudgetGrant: 2,
        tokenBudgetGrant: Number.POSITIVE_INFINITY,
      });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      const created = runtime.getSnapshot().goal!;
      expect(created).toMatchObject({ turnBudget: 2, turnCount: 0 });

      // Two turns of real work: the ceiling is checked at the continuation
      // boundary, so the turn that reaches it still runs to completion.
      await finishDelivered(runtime, host.started[0]!);
      expect(host.inputs[1]).not.toHaveProperty('windDown');
      await finishDelivered(runtime, host.started[1]!);

      // The spent window buys exactly one hand-off.
      expect(host.started).toHaveLength(3);
      expect(host.inputs[2]).toMatchObject({ windDown: true });
      expect(runtime.getSnapshot().goal?.status).toBe('active');

      await finishDelivered(runtime, host.started[2]!);
      await vi.waitFor(() => {
        expect(runtime.getSnapshot().goal?.status).toBe('usage_limited');
      });
      expect(runtime.getSnapshot().goal).toMatchObject({
        limitKind: 'turn_budget',
        turnCount: 3,
        turnBudget: 2,
        windDownTurnId: host.started[2]!.turnId,
        lastReason: goalTurnBudgetReason(2),
      });
      expect(host.started).toHaveLength(3);
      expect(journal.appended.map((payload) => payload.cause)).toEqual([
        'create',
        'turn_finished',
        'turn_finished',
        'turn_finished',
        'usage_limited',
      ]);

      const resumed = await runtime.dispatch({
        action: 'resume',
        expectedGoalId: created.goalId,
        expectedRevision: created.revision,
      });
      // The ceiling moves ahead of the count the resume never resets.
      expect(resumed.snapshot.goal).toMatchObject({
        status: 'active',
        turnCount: 3,
        turnBudget: 5,
      });
      expect(resumed.snapshot.goal?.limitKind).toBeUndefined();
      expect(resumed.snapshot.goal).not.toHaveProperty('windDownTurnId');
      expect(host.started).toHaveLength(4);
      expect(host.inputs[3]).not.toHaveProperty('windDown');
    });

    it('still admits a user turn once the ceiling is already spent', async () => {
      // Three surfaces promise this -- the settings row, the schema
      // description and the `turnBudget` doc comment -- and nothing held it:
      // `beginTurn` gates only on the Goal being active, and `spentBudget` sits
      // in the same closure, so a plausible "stop admitting turns at the
      // ceiling" edit would silently discard the user's message instead.
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({
        journal: fakeGoalJournal(),
        turnBudgetGrant: 1,
        tokenBudgetGrant: Number.POSITIVE_INFINITY,
      });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      // One automatic turn spends the window, and the gate grants the hand-off.
      await finishDelivered(runtime, host.started[0]!);
      expect(runtime.getSnapshot().goal).toMatchObject({
        status: 'active',
        turnCount: 1,
        turnBudget: 1,
      });
      expect(host.inputs[1]).toMatchObject({ windDown: true });

      // The user types with the ceiling already spent and the hand-off in
      // flight. The turn is reserved, not refused.
      expect(runtime.beginTurn('real-user')).toBeUndefined();
      await finishDelivered(runtime, host.started[1]!);

      const userPermit = runtime.permitForTurn('real-user');
      expect(userPermit).toBeDefined();
      expect(runtime.getSnapshot().goal?.status).toBe('active');

      // And the stop still arrives once the user's own turn is done.
      await runtime.finishTurn(userPermit!);
      await vi.waitFor(() => {
        expect(runtime.getSnapshot().goal?.status).toBe('usage_limited');
      });
      expect(runtime.getSnapshot().goal?.limitKind).toBe('turn_budget');
    });

    it('counts user-driven turns toward the turn ceiling', async () => {
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({
        journal: fakeGoalJournal(),
        turnBudgetGrant: 2,
        tokenBudgetGrant: Number.POSITIVE_INFINITY,
      });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      const automatic = host.started[0]!;
      expect(runtime.beginTurn('real-user')).toBeUndefined();
      await finishDelivered(runtime, automatic);
      const userPermit = runtime.permitForTurn('real-user');
      expect(userPermit).toBeDefined();
      await runtime.finishTurn(userPermit!);

      expect(runtime.getSnapshot().goal?.turnCount).toBe(2);
      expect(host.inputs.at(-1)).toMatchObject({ windDown: true });
      await finishDelivered(runtime, host.started.at(-1)!);
      await vi.waitFor(() => {
        expect(runtime.getSnapshot().goal?.status).toBe('usage_limited');
      });
      expect(runtime.getSnapshot().goal).toMatchObject({
        limitKind: 'turn_budget',
        turnCount: 3,
      });
    });

    it('hands off and stops when the active-time budget is spent', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(1_000);
        const journal = fakeGoalJournal();
        const host = fakeGoalTurnHost();
        const runtime = createGoalRuntime({
          journal,
          activeTimeBudgetGrantMs: 60_000,
          tokenBudgetGrant: Number.POSITIVE_INFINITY,
        });
        runtime.bindHost(host);
        await runtime.dispatch({ action: 'create', objective: 'ship' });
        expect(runtime.getSnapshot().goal).toMatchObject({
          activeTimeBudgetMs: 60_000,
          activeTimeMs: 0,
        });

        // A turn that runs past the window: the clock is read at the
        // continuation boundary, so the turn itself is never cut short.
        vi.setSystemTime(91_000);
        await finishDelivered(runtime, host.started[0]!);

        expect(runtime.getSnapshot().goal?.activeTimeMs).toBe(90_000);
        expect(host.started).toHaveLength(2);
        expect(host.inputs[1]).toMatchObject({ windDown: true });

        await finishDelivered(runtime, host.started[1]!);
        await vi.waitFor(() => {
          expect(runtime.getSnapshot().goal?.status).toBe('usage_limited');
        });
        expect(runtime.getSnapshot().goal).toMatchObject({
          limitKind: 'time_budget',
          activeTimeBudgetMs: 60_000,
          lastReason: goalActiveTimeBudgetReason(60_000),
        });
        expect(host.started).toHaveLength(2);

        // Resuming grants another window measured from where it stopped.
        const stopped = runtime.getSnapshot().goal!;
        const resumed = await runtime.dispatch({
          action: 'resume',
          expectedGoalId: stopped.goalId,
          expectedRevision: stopped.revision,
        });
        expect(resumed.snapshot.goal).toMatchObject({
          status: 'active',
          activeTimeBudgetMs: stopped.activeTimeMs + 60_000,
        });
        expect(resumed.snapshot.goal).not.toHaveProperty('windDownTurnId');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not accrue active time while the Goal is stopped', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(1_000);
        const host = fakeGoalTurnHost();
        const runtime = createGoalRuntime({
          journal: fakeGoalJournal(),
          activeTimeBudgetGrantMs: 60_000,
          tokenBudgetGrant: Number.POSITIVE_INFINITY,
        });
        runtime.bindHost(host);
        await runtime.dispatch({ action: 'create', objective: 'ship' });
        vi.setSystemTime(11_000);
        await finishDelivered(runtime, host.started[0]!);
        const paused = await runtime.dispatch({
          action: 'pause',
          expectedGoalId: runtime.getSnapshot().goal!.goalId,
          expectedRevision: runtime.getSnapshot().goal!.revision,
        });
        expect(paused.snapshot.goal?.activeTimeMs).toBe(10_000);

        // An hour of wall clock while paused: the window is untouched, so the
        // resumed Goal still has the time it had.
        vi.setSystemTime(3_611_000);
        const resumed = await runtime.dispatch({
          action: 'resume',
          expectedGoalId: paused.snapshot.goal!.goalId,
          expectedRevision: paused.snapshot.goal!.revision,
        });
        expect(resumed.snapshot.goal).toMatchObject({
          status: 'active',
          activeTimeMs: 10_000,
          activeTimeBudgetMs: 60_000,
        });
        // And it is admitted a real continuation rather than a hand-off.
        expect(host.inputs.at(-1)).not.toHaveProperty('windDown');
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports one reason when a turn crosses more than one ceiling', async () => {
      // Token first: it is the ceiling armed by default, so it is the one a
      // user is likeliest to be asking about.
      const host = fakeGoalTurnHost();
      const spend = new Map<string, number>();
      const runtime = createGoalRuntime({
        journal: fakeGoalJournal(),
        ledger: {
          takeGoalTurnTokens: (turnId: string) => spend.get(turnId) ?? 0,
        },
        tokenBudgetGrant: 1_000,
        turnBudgetGrant: 1,
      });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      spend.set(host.started[0]!.turnId, 5_000);
      await finishDelivered(runtime, host.started[0]!);
      await finishDelivered(runtime, host.started[1]!);

      await vi.waitFor(() => {
        expect(runtime.getSnapshot().goal?.status).toBe('usage_limited');
      });
      expect(runtime.getSnapshot().goal?.limitKind).toBe('token_budget');
    });

    it('reports the turn budget before the time budget when both are spent', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(1_000);
        const host = fakeGoalTurnHost();
        const runtime = createGoalRuntime({
          journal: fakeGoalJournal(),
          tokenBudgetGrant: Number.POSITIVE_INFINITY,
          turnBudgetGrant: 1,
          activeTimeBudgetGrantMs: 60_000,
        });
        runtime.bindHost(host);
        await runtime.dispatch({ action: 'create', objective: 'ship' });

        vi.setSystemTime(61_000);
        await finishDelivered(runtime, host.started[0]!);
        expect(host.inputs.at(-1)).toMatchObject({ windDown: true });
        await finishDelivered(runtime, host.started.at(-1)!);
        await vi.waitFor(() => {
          expect(runtime.getSnapshot().goal?.status).toBe('usage_limited');
        });
        expect(runtime.getSnapshot().goal?.limitKind).toBe('turn_budget');
      } finally {
        vi.useRealTimers();
      }
    });

    it('carries the cadence figures to the host that renders the prompt', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(1_000);
        const host = fakeGoalTurnHost();
        const runtime = createGoalRuntime({
          journal: fakeGoalJournal(),
          turnBudgetGrant: 20,
          activeTimeBudgetGrantMs: 1_800_000,
          tokenBudgetGrant: Number.POSITIVE_INFINITY,
        });
        runtime.bindHost(host);
        await runtime.dispatch({ action: 'create', objective: 'ship' });

        expect(host.inputs[0]?.usage).toMatchObject({
          turnCount: 0,
          turnBudget: 20,
          activeTimeMs: 0,
          activeTimeBudgetMs: 1_800_000,
        });

        vi.setSystemTime(61_000);
        await finishDelivered(runtime, host.started[0]!);
        expect(host.inputs[1]?.usage).toMatchObject({
          turnCount: 1,
          turnBudget: 20,
          activeTimeMs: 60_000,
          activeTimeBudgetMs: 1_800_000,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('uses elapsed active time when a queued continuation waits for a host', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(1_000);
        const host = fakeGoalTurnHost();
        const runtime = createGoalRuntime({
          journal: fakeGoalJournal(),
          activeTimeBudgetGrantMs: 1_800_000,
          tokenBudgetGrant: Number.POSITIVE_INFINITY,
        });
        await runtime.dispatch({ action: 'create', objective: 'ship' });

        vi.setSystemTime(61_000);
        runtime.bindHost(host);

        expect(host.inputs).toHaveLength(1);
        expect(host.inputs[0]?.usage).toMatchObject({
          activeTimeMs: 60_000,
          activeTimeBudgetMs: 1_800_000,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('re-reads the time ceiling when a queued continuation is finally delivered', async () => {
      // The time ceiling is the only one whose spent state can change between
      // queueing and delivery: spend and turn count are committed by
      // `finishTurn` before the gate runs, but elapsed active time keeps
      // accruing while the continuation sits queued with no host to flush it.
      // A continuation queued under the ceiling and delivered past it must be
      // the hand-off, not a full work turn a whole window late.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(1_000);
        const host = fakeGoalTurnHost();
        const runtime = createGoalRuntime({
          journal: fakeGoalJournal(),
          activeTimeBudgetGrantMs: 60_000,
          tokenBudgetGrant: Number.POSITIVE_INFINITY,
        });
        // Queued with the ceiling unspent and no host to deliver it.
        await runtime.dispatch({ action: 'create', objective: 'ship' });
        expect(host.inputs).toHaveLength(0);

        // The window runs out while the continuation waits.
        vi.setSystemTime(121_000);
        runtime.bindHost(host);

        expect(host.inputs).toHaveLength(1);
        expect(host.inputs[0]).toMatchObject({ windDown: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it('sends no time figures to a Goal with no time ceiling', async () => {
      // Elapsed active time with nothing to measure it against is a number on
      // every turn that the model cannot act on.
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({
        journal: fakeGoalJournal(),
        turnBudgetGrant: 20,
      });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      expect(host.inputs[0]?.usage).toMatchObject({ turnBudget: 20 });
      expect(host.inputs[0]?.usage).not.toHaveProperty('activeTimeMs');
      expect(host.inputs[0]?.usage).not.toHaveProperty('activeTimeBudgetMs');
    });

    it('lets a spent cadence budget outrank the no-progress bound', async () => {
      // Both bounds are reached on the same turn. The budget owes this Goal a
      // hand-off and a `usage_limited` stop the user can resume from; pausing
      // for idleness here would skip both.
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({
        journal: fakeGoalJournal(),
        ledger: {
          takeGoalTurnTokens: () => 0,
          takeGoalTurnToolResults: () => 0,
        },
        turnBudgetGrant: GOAL_NO_PROGRESS_TURN_LIMIT,
        tokenBudgetGrant: Number.POSITIVE_INFINITY,
      });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      for (let turn = 0; turn < GOAL_NO_PROGRESS_TURN_LIMIT; turn++) {
        await finishDelivered(runtime, host.started[turn]!);
      }

      expect(runtime.getSnapshot().goal?.status).toBe('active');
      expect(host.inputs.at(-1)).toMatchObject({ windDown: true });
      await finishDelivered(runtime, host.started.at(-1)!);
      await vi.waitFor(() => {
        expect(runtime.getSnapshot().goal?.status).toBe('usage_limited');
      });
      expect(runtime.getSnapshot().goal).toMatchObject({
        limitKind: 'turn_budget',
      });
      expect(runtime.getSnapshot().goal?.lastReason).not.toBe(
        GOAL_PAUSE_REASON_NO_PROGRESS,
      );
    });

    it('shows the cadence stop even when the settle write fails', async () => {
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({
        journal: fakeGoalJournal({
          appendErrors: [
            undefined,
            undefined,
            undefined,
            new Error('journal unavailable'),
          ],
        }),
        turnBudgetGrant: 1,
        tokenBudgetGrant: Number.POSITIVE_INFINITY,
      });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      await finishDelivered(runtime, host.started[0]!);
      await finishDelivered(runtime, host.started[1]!);

      await vi.waitFor(() => {
        expect(runtime.getSnapshot().goal?.status).toBe('usage_limited');
      });
      expect(runtime.getSnapshot().goal).toMatchObject({
        limitKind: 'turn_budget',
      });
      expect(host.started).toHaveLength(2);
    });
  });
});

describe('Goal P0 evidence and verification recovery', () => {
  it('gives a user reservation made during the pending append priority over the old proposal', async () => {
    const appendEntered = deferred<void>();
    const appendGate = deferred<void>();
    const journal = fakeGoalJournal({
      beforeAppend: async (payload) => {
        if (payload.verificationPending && payload.cause === 'turn_finished') {
          appendEntered.resolve();
          await appendGate.promise;
        }
      },
    });
    let records: RuntimeRecord[] = [];
    const verifier: GoalVerifier = vi.fn<GoalVerifier>(async () => ({
      decision: 'accept',
      reason: 'Old proposal accepted',
    }));
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource: fakeEvidenceSource(() => records, journal),
      verifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver A' });
    const permit = host.started[0]!;
    records = verifierEvidenceRecords(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
    );
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'Delivered A',
      evidenceRefs: ['assistant-evidence'],
    });
    const finishing = runtime.finishTurn(permit);
    await appendEntered.promise;
    expect(runtime.beginTurn('new-user-requirement')).toBeUndefined();
    appendGate.resolve();
    await finishing;
    expect(verifier).not.toHaveBeenCalled();
    expect(runtime.permitForTurn('new-user-requirement')).toBeDefined();
    expect(runtime.getSnapshot().goal?.status).toBe('active');
    const recovery = recoverGoalFromRecords(journal.records);
    expect(recovery).toMatchObject({
      kind: 'v2',
      payload: { snapshot: { goal: { status: 'active' } } },
    });
    if (recovery.kind === 'v2')
      expect(recovery.payload.verificationPending).toBeUndefined();
  });

  it.each(['user', 'pause', 'edit'] as const)(
    'supersedes an already-started terminal append durably after %s input',
    async (action) => {
      const appendEntered = deferred<void>();
      const appendGate = deferred<void>();
      const journal = fakeGoalJournal({
        beforeAppend: async (payload) => {
          if (payload.cause === 'complete') {
            appendEntered.resolve();
            await appendGate.promise;
          }
        },
      });
      let records: RuntimeRecord[] = [];
      let attemptSignal: AbortSignal | undefined;
      const verifier: GoalVerifier = vi.fn<GoalVerifier>(
        async (_input, signal) => {
          attemptSignal = signal;
          return { decision: 'accept', reason: 'Old proposal accepted' };
        },
      );
      const host = fakeGoalTurnHost();
      const runtime = createGoalRuntime({
        journal,
        evidenceSource: fakeEvidenceSource(() => records, journal),
        verifier,
      });
      runtime.bindHost(host);
      await runtime.dispatch({ action: 'create', objective: 'deliver A' });
      const permit = host.started[0]!;
      records = verifierEvidenceRecords(
        permit,
        runtime.getSnapshot().goal!.evidenceCursor.recordId!,
      );
      runtime.recordTerminalProposal(permit, {
        status: 'complete',
        reason: 'Delivered A',
        evidenceRefs: ['assistant-evidence'],
      });
      const finishing = runtime.finishTurn(permit);
      await appendEntered.promise;
      let control: Promise<unknown> | undefined;
      if (action === 'user')
        expect(runtime.beginTurn('new-user-requirement')).toBeDefined();
      else
        control = runtime.dispatch(
          action === 'edit'
            ? {
                action: 'edit',
                objective: 'deliver B',
                expectedGoalId: permit.goalId,
                expectedRevision: permit.revision,
              }
            : {
                action: 'pause',
                expectedGoalId: permit.goalId,
                expectedRevision: permit.revision,
              },
        );
      expect(attemptSignal?.aborted).toBe(true);
      appendGate.resolve();
      await finishing;
      await control;
      const status = action === 'pause' ? 'paused' : 'active';
      expect(runtime.getSnapshot().goal?.status).toBe(status);
      const recovery = recoverGoalFromRecords(journal.records);
      expect(recovery).toMatchObject({
        kind: 'v2',
        payload: {
          snapshot: { goal: { status, revision: action === 'edit' ? 2 : 1 } },
        },
      });
      if (action === 'user')
        expect(runtime.permitForTurn('new-user-requirement')).toBeDefined();
    },
  );

  it('leaves an in-flight verification intact when a replacement is refused for an active Goal', async () => {
    const decision = deferred<Awaited<ReturnType<GoalVerifier>>>();
    let signal: AbortSignal | undefined;
    const verifier: GoalVerifier = vi.fn((_input, attemptSignal) => {
      signal = attemptSignal;
      return decision.promise;
    });
    const f = await fixture(verifier);
    f.propose();
    const finishing = f.runtime.finishTurn(f.permit);
    await vi.waitFor(() => expect(verifier).toHaveBeenCalledOnce());
    await expect(
      f.runtime.dispatch(
        {
          action: 'replace',
          objective: 'other goal',
          expectedGoalId: f.permit.goalId,
          expectedRevision: f.permit.revision,
        },
        { refuseIfActive: true },
      ),
    ).rejects.toThrow('active Goal');
    expect(signal?.aborted).toBe(false);
    expect(f.runtime.getSnapshot().activity).toBe('verifying');
    decision.resolve({ decision: 'accept', reason: 'Original goal proven' });
    await finishing;
    expect(f.runtime.getSnapshot().goal?.status).toBe('complete');
  });

  it('retains the durable proposal if completion persistence fails after the acceptance audit', async () => {
    const journal = fakeGoalJournal({
      beforeAppend: (payload) => {
        if (payload.cause === 'complete')
          throw new Error('Terminal append failed');
      },
    });
    let records: RuntimeRecord[] = [];
    const verifier: GoalVerifier = vi.fn<GoalVerifier>(async () => ({
      decision: 'accept',
      reason: 'Objective proved',
    }));
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource: fakeEvidenceSource(() => records, journal),
      verifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver' });
    const permit = host.started[0]!;
    records = verifierEvidenceRecords(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
    );
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'Delivered',
      evidenceRefs: ['assistant-evidence'],
    });
    await expect(runtime.finishTurn(permit)).rejects.toThrow(
      'Terminal append failed',
    );
    expect(recoverGoalFromRecords(journal.records)).toMatchObject({
      kind: 'v2',
      payload: {
        verificationPending: {
          permit,
          proposal: { evidenceRefs: ['assistant-evidence'] },
        },
      },
    });
  });

  it('charges late verifier usage to the same Goal after an edit without applying its stale verdict', async () => {
    const lateResponse = deferred<void>();
    const verifier: GoalVerifier = vi.fn<GoalVerifier>(async (input) => {
      await lateResponse.promise;
      await input.onUsage?.({ totalTokenCount: 19 }, 1);
      return { decision: 'accept', reason: 'old proof' };
    });
    const f = await fixture(verifier);
    f.propose();
    const finishing = f.runtime.finishTurn(f.permit);
    await vi.waitFor(() => expect(verifier).toHaveBeenCalledOnce());
    await f.runtime.dispatch({
      action: 'edit',
      objective: 'new requirements',
      expectedGoalId: f.permit.goalId,
      expectedRevision: f.permit.revision,
    });
    lateResponse.resolve();
    await finishing;
    expect(f.runtime.getSnapshot().goal).toMatchObject({
      revision: 2,
      status: 'active',
      tokensUsed: 19,
    });
    expect(recoverGoalFromRecords(f.journal.records)).toMatchObject({
      kind: 'v2',
      payload: {
        snapshot: { goal: { revision: 2, status: 'active', tokensUsed: 19 } },
      },
    });
  });

  async function fixture(verifier: GoalVerifier, objective = 'deliver result') {
    const journal = fakeGoalJournal();
    const state = { records: [] as RuntimeRecord[] };
    const evidenceSource = fakeEvidenceSource(() => state.records, journal);
    const checkpointVerifier = vi.fn();
    const host = fakeGoalTurnHost();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource,
      verifier,
      checkpointVerifier,
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective });
    const permit = host.started[0]!;
    const scopeStart = runtime.getSnapshot().goal!.evidenceCursor.recordId!;
    state.records = verifierEvidenceRecords(permit, scopeStart);
    const propose = (evidenceRefs = ['assistant-evidence']) =>
      runtime.recordTerminalProposal(permit, {
        status: 'complete',
        reason: 'All conditions met',
        evidenceRefs,
      });
    return {
      journal,
      state,
      evidenceSource,
      checkpointVerifier,
      host,
      runtime,
      permit,
      scopeStart,
      propose,
    };
  }

  it('preserves the existing wind-down turn when a real budget ends before verification', async () => {
    const journal = fakeGoalJournal();
    let records: RuntimeRecord[] = [];
    const host = fakeGoalTurnHost();
    const verifier: GoalVerifier = vi.fn<GoalVerifier>(async (input) => {
      const reason = await input.beforeCall?.({
        calls: 0,
        totalTokenCount: 0,
        elapsedMs: 0,
      });
      expect(reason).toContain('token');
      return {
        decision: 'inconclusive',
        failureKind: 'budget',
        reason: reason!,
      };
    });
    const runtime = createGoalRuntime({
      journal,
      evidenceSource: fakeEvidenceSource(() => records, journal),
      verifier,
      tokenBudgetGrant: 10,
      ledger: { takeGoalTurnTokens: () => 10 },
    });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'deliver' });
    const permit = host.started[0]!;
    records = verifierEvidenceRecords(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
    );
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'Delivered',
      evidenceRefs: ['assistant-evidence'],
    });
    await runtime.finishTurn(permit);
    expect(host.inputs).toHaveLength(2);
    expect(host.inputs[1]).toMatchObject({ windDown: true });
    expect(runtime.getSnapshot().goal?.status).toBe('active');
    const windingDown = host.started[1]!;
    runtime.markTurnDelivered(`goal-runtime:${windingDown.turnId}`);
    await runtime.finishTurn(windingDown);
    await vi.waitFor(() =>
      expect(runtime.getSnapshot().goal?.status).toBe('usage_limited'),
    );
    expect(host.inputs).toHaveLength(2);
    const recovery = recoverGoalFromRecords(journal.records);
    expect(recovery).toMatchObject({
      kind: 'v2',
      payload: {
        verificationPending: {
          proposal: { evidenceRefs: ['assistant-evidence'] },
        },
      },
    });
  });

  it('persists and displays unobservable verifier usage without inventing a zero count', async () => {
    const verifier: GoalVerifier = vi.fn<GoalVerifier>(async (input) => {
      await input.onUsage?.({}, 1);
      return {
        decision: 'accept',
        reason: 'Evidence proves the result',
        usageComplete: false,
      };
    });
    const f = await fixture(verifier);
    f.propose();
    await f.runtime.finishTurn(f.permit);
    expect(f.runtime.getSnapshot().goal).toMatchObject({
      status: 'complete',
      verificationUsageIncomplete: true,
    });
    expect(f.runtime.getSnapshot().goal?.lastReason).toMatch(
      /usage excludes.*provider returned no usage/i,
    );
    expect(recoverGoalFromRecords(f.journal.records)).toMatchObject({
      kind: 'v2',
      payload: { snapshot: { goal: { verificationUsageIncomplete: true } } },
    });
    const completionGuard = f.journal.appended.find(
      (payload) =>
        payload.snapshot.goal?.status === 'complete' &&
        !payload.snapshot.goal.verificationUsageIncomplete,
    );
    expect(completionGuard?.cause).toBe('turn_finished');
    expect(
      f.journal.appended.filter((payload) => payload.cause === 'complete'),
    ).toHaveLength(1);
  });

  it('retains a transient failure across restart and retries only on explicit resume', async () => {
    const first: GoalVerifier = vi.fn<GoalVerifier>(async () => ({
      decision: 'inconclusive' as const,
      failureKind: 'service' as const,
      reason: 'Provider unavailable',
      usage: { totalTokenCount: 15 },
    }));
    const f = await fixture(first);
    f.propose();
    await f.runtime.finishTurn(f.permit);
    expect(f.runtime.getSnapshot().goal).toMatchObject({
      status: 'paused',
      tokensUsed: 15,
      evidenceCursor: { recordId: f.scopeStart },
    });
    const pending = f.journal.appended.at(-1)!.verificationPending!;
    expect(pending).toMatchObject({
      proposal: { evidenceRefs: ['assistant-evidence'] },
      failureKind: 'service',
    });
    f.runtime.dispose();

    const journal = fakeGoalJournal();
    journal.records.push(...f.journal.records);
    const retry: GoalVerifier = vi.fn<GoalVerifier>(async (input) => {
      await input.onUsage?.({ totalTokenCount: 7 }, 1);
      return {
        decision: 'accept',
        reason: 'Original evidence verifies',
        usage: { totalTokenCount: 7 },
      };
    });
    const host = fakeGoalTurnHost();
    const restored = createGoalRuntime({
      journal,
      evidenceSource: fakeEvidenceSource(() => f.state.records, journal),
      verifier: retry,
    });
    restored.bindHost(host);
    await restored.restore(journal.records);
    expect(retry).not.toHaveBeenCalled();
    expect(host.started).toHaveLength(0);
    expect(restored.getSnapshot().goal?.tokensUsed).toBe(15);
    await restored.dispatch({
      action: 'resume',
      expectedGoalId: f.permit.goalId,
      expectedRevision: f.permit.revision,
    });
    expect(retry).toHaveBeenCalledOnce();
    expect(restored.getSnapshot().goal).toMatchObject({
      status: 'complete',
      tokensUsed: 22,
      turnCount: 1,
      evidenceCursor: { recordId: f.scopeStart },
    });
    expect(host.started).toHaveLength(0);
    const replay = createGoalRuntime({ journal: fakeGoalJournal() });
    await replay.restore(journal.records);
    expect(replay.getSnapshot().goal).toMatchObject({
      status: 'complete',
      tokensUsed: 22,
    });
  });

  it('meters each response callback once and does not re-add its aggregate', async () => {
    const verifier: GoalVerifier = vi.fn<GoalVerifier>(async (input) => {
      await input.onUsage?.({ totalTokenCount: 11 }, 1);
      await input.onUsage?.({ totalTokenCount: 13 }, 2);
      return {
        decision: 'accept',
        reason: 'Valid after correction',
        usage: { totalTokenCount: 24 },
      };
    });
    const f = await fixture(verifier);
    f.propose();
    await f.runtime.finishTurn(f.permit);
    expect(f.runtime.getSnapshot().goal).toMatchObject({
      status: 'complete',
      tokensUsed: 24,
      turnCount: 1,
    });
    expect(f.journal.appended.at(-1)?.snapshot.goal?.tokensUsed).toBe(24);
    expect(
      f.journal.appended.filter((entry) => entry.cause === 'complete'),
    ).toHaveLength(1);
  });

  it('distinguishes capacity from a real Goal budget stop and preserves both proposals', async () => {
    for (const failureKind of ['capacity', 'budget'] as const) {
      const verifier: GoalVerifier = vi.fn<GoalVerifier>(async () => ({
        decision: 'inconclusive' as const,
        failureKind,
        reason:
          failureKind === 'capacity'
            ? 'Originals exceed model context'
            : 'Goal token budget exhausted',
        usage: { totalTokenCount: 3 },
      }));
      const f = await fixture(verifier);
      f.propose();
      await f.runtime.finishTurn(f.permit);
      expect(f.runtime.getSnapshot().goal).toMatchObject({
        status: failureKind === 'capacity' ? 'paused' : 'usage_limited',
        tokensUsed: 3,
      });
      expect(f.journal.appended.at(-1)?.verificationPending).toMatchObject({
        failureKind,
        proposal: { evidenceRefs: ['assistant-evidence'] },
      });
      expect(f.host.started).toHaveLength(1);
      expect(f.checkpointVerifier).not.toHaveBeenCalled();
      if (failureKind === 'capacity')
        expect(f.runtime.getSnapshot().goal?.lastReason).toContain(
          'unchanged retries may fail again',
        );
    }
  });

  it('declines a stale saved proposal after new real-user evidence instead of replaying acceptance', async () => {
    const verifier: GoalVerifier = vi
      .fn()
      .mockResolvedValueOnce({
        decision: 'inconclusive',
        failureKind: 'service',
        reason: 'Offline',
      })
      .mockResolvedValue({ decision: 'accept', reason: 'Old objective met' });
    const f = await fixture(verifier);
    f.propose();
    await f.runtime.finishTurn(f.permit);
    const tail = f.journal.records.at(-1)!;
    f.state.records.push(
      ...f.journal.records.filter(
        (entry) =>
          !f.state.records.some((record) => record.uuid === entry.uuid),
      ),
    );
    f.state.records.push({
      ...verifierUserEvidenceRecords(
        f.permit,
        tail.uuid,
        'new-user-requirement',
      )[1]!,
      message: {
        role: 'user',
        parts: [{ text: 'Also deliver a second file' }],
      },
    });
    await f.runtime.dispatch({
      action: 'resume',
      expectedGoalId: f.permit.goalId,
      expectedRevision: f.permit.revision,
    });
    expect(verifier).toHaveBeenCalledOnce();
    expect(f.runtime.getSnapshot().goal).toMatchObject({
      status: 'active',
      lastReason: expect.stringContaining('stale'),
    });
    expect(f.journal.appended.some((entry) => entry.cause === 'complete')).toBe(
      false,
    );
  });

  it('rejects an accept if the frozen transcript branch changes during verification', async () => {
    const decision = deferred<Awaited<ReturnType<GoalVerifier>>>();
    const verifier: GoalVerifier = vi.fn(() => decision.promise);
    const f = await fixture(verifier);
    f.propose();
    const finishing = f.runtime.finishTurn(f.permit);
    await vi.waitFor(() => expect(verifier).toHaveBeenCalledOnce());
    f.state.records[1] = {
      ...f.state.records[1]!,
      uuid: 'rewound-branch-output',
      message: { parts: [{ text: 'The earlier branch was discarded' }] },
    };
    decision.resolve({
      decision: 'accept',
      reason: 'Old branch satisfied',
      usage: { totalTokenCount: 9 },
    });
    await finishing;
    expect(f.runtime.getSnapshot().goal).toMatchObject({
      status: 'active',
      tokensUsed: 9,
      lastReason: expect.stringContaining('transcript changed'),
    });
    expect(f.journal.appended.some((entry) => entry.cause === 'complete')).toBe(
      false,
    );
  });

  it('includes subsequent writes and failed checks when only the earlier green check was cited', async () => {
    const verifier: GoalVerifier = vi.fn<GoalVerifier>(async (input) => {
      const snapshot = input.evidenceSnapshot!;
      const evidence = snapshot
        .requiredEvidence(input.proposal, { includeHistoricalActions: true })
        .map((reference) => snapshot.read({ reference }).content)
        .join('\n');
      expect(evidence).toContain('write_file');
      expect(evidence).toContain('FAILED after write');
      return {
        decision: 'reject',
        reason: 'The cited green check predates a write and failed check',
      };
    });
    const f = await fixture(
      verifier,
      'Tests must pass and never modify source files',
    );
    for (const [index, command, output] of [
      [0, 'test', 'PASSED'],
      [1, 'write_file src/main.ts', 'written'],
      [2, 'test', 'FAILED after write'],
    ] as const) {
      const previous = f.state.records.at(-1)!;
      f.state.records.push({
        ...previous,
        uuid: `call-${index}`,
        parentUuid: previous.uuid,
        type: 'assistant',
        provenance: 'assistant_output',
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: `tool-${index}`,
                name: 'run_shell_command',
                args: { command },
              },
            },
          ],
        },
      });
      f.state.records.push({
        ...previous,
        uuid: `result-${index}`,
        parentUuid: `call-${index}`,
        type: 'tool_result',
        provenance: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: `tool-${index}`,
                name: 'run_shell_command',
                response: { output },
              },
            },
          ],
        },
      });
    }
    f.propose(['result-0']);
    await f.runtime.finishTurn(f.permit);
    expect(verifier).toHaveBeenCalledOnce();
    expect(f.runtime.getSnapshot().goal).toMatchObject({
      status: 'active',
      lastReason: expect.stringContaining('predates'),
    });
    expect(f.checkpointVerifier).not.toHaveBeenCalled();
  });

  it('evaluates an explicit requested final format using actual delivered text', async () => {
    const verifier: GoalVerifier = vi.fn<GoalVerifier>(async (input) => ({
      decision: input.currentDeliveredOutput?.some((text) =>
        text.includes('CHECK PASSED'),
      )
        ? 'accept'
        : 'reject',
      reason: 'The final response must paste CHECK PASSED',
    }));
    const f = await fixture(
      verifier,
      'Paste CHECK PASSED in your final response',
    );
    f.propose();
    await f.runtime.finishTurn(f.permit);
    expect(f.runtime.getSnapshot().goal?.status).toBe('active');
    expect(f.runtime.getSnapshot().goal?.lastReason).toContain('must paste');
    expect(f.host.started).toHaveLength(2);
  });

  it('restores a legacy pending checkpoint without starting the removed summarizer', async () => {
    const journal = fakeGoalJournal();
    const host = fakeGoalTurnHost();
    const checkpointVerifier = vi.fn();
    const verifier: GoalVerifier = vi.fn();
    const runtime = createGoalRuntime({
      journal,
      evidenceSource: fakeEvidenceSource(() => [], journal),
      verifier,
      checkpointVerifier,
    });
    runtime.bindHost(host);
    const record = goalStateRecord(
      {
        v: 2,
        activity: 'idle',
        goal: {
          goalId: 'legacy-goal',
          revision: 1,
          objective: 'deliver',
          status: 'active',
          evidenceCursor: { recordId: 'original-create' },
          tokensUsed: 12,
          turnCount: 1,
          activeTimeMs: 100,
          createdAt: 0,
          updatedAt: 1,
        },
      },
      'turn_finished',
    );
    const payload = record.systemPayload as GoalStateRecordPayloadV2;
    payload.checkpointPending = {
      permit: { goalId: 'legacy-goal', revision: 1, turnId: 'old-turn' },
      recordUuid: 'checkpoint-to-replay',
    };
    await runtime.restore([record]);
    expect(checkpointVerifier).not.toHaveBeenCalled();
    expect(verifier).not.toHaveBeenCalled();
    expect(host.started).toHaveLength(1);
    expect(runtime.getSnapshot().goal).toMatchObject({
      status: 'active',
      tokensUsed: 12,
      evidenceCursor: { recordId: 'original-create' },
    });
  });

  it('fails closed on an unsupported newest verification record instead of restoring older active state', async () => {
    const first = await fixture(vi.fn());
    const latest = structuredClone(first.journal.records[0]!);
    latest.uuid = 'unsupported-newest';
    latest.parentUuid = first.journal.records[0]!.uuid;
    const payload = latest.systemPayload as unknown as Record<string, unknown>;
    payload['verificationPending'] = {
      permit: first.permit,
      proposal: { status: 'complete', evidenceRefs: [] },
      snapshotTail: 123,
    };
    const restored = createGoalRuntime({ journal: fakeGoalJournal() });
    const host = fakeGoalTurnHost();
    restored.bindHost(host);
    await expect(
      restored.restore([...first.journal.records, latest]),
    ).rejects.toThrow(/unsupported|invalid|malformed/i);
    expect(host.started).toHaveLength(0);
    expect(restored.getSnapshot().goal).toBeNull();
  });
});

describe('Goal verification compatibility guard durability', () => {
  it('preserves the committed proposal if interrupted before a later pending write', async () => {
    let pendingWrites = 0;
    let crashRecords: RuntimeRecord[] = [];
    const journal = fakeGoalJournal({
      beforeAppend: (payload) => {
        if (payload.verificationPending && ++pendingWrites === 2) {
          crashRecords = structuredClone(journal.records);
        }
      },
    });
    let evidence: RuntimeRecord[] = [];
    const verifier: GoalVerifier = async (input) => {
      await input.onUsage?.({ totalTokenCount: 7 }, 1);
      return {
        decision: 'inconclusive',
        failureKind: 'service',
        reason: 'Temporary failure',
        usage: { totalTokenCount: 7 },
      };
    };
    const runtime = createGoalRuntime({
      journal,
      evidenceSource: fakeEvidenceSource(() => evidence, journal),
      verifier,
    });
    await runtime.dispatch({ action: 'create', objective: 'Deliver result' });
    const permit = runtime.beginTurn('user')!;
    evidence = verifierEvidenceRecords(
      permit,
      runtime.getSnapshot().goal!.evidenceCursor.recordId!,
    );
    runtime.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'Delivered',
      evidenceRefs: ['assistant-evidence'],
    });
    await runtime.finishTurn(permit);
    expect(recoverGoalFromRecords(crashRecords)).toMatchObject({
      kind: 'v2',
      payload: {
        verificationPending: {
          permit,
          proposal: { evidenceRefs: ['assistant-evidence'] },
        },
      },
    });
    const guards = journal.appended.filter(
      (payload) =>
        payload.snapshot.goal?.status === 'paused' &&
        !payload.verificationPending,
    );
    expect(guards).toHaveLength(1);
    expect(guards[0]?.cause).toBe('turn_finished');
    runtime.dispose();
  });

  it('reuses the persisted compatible stop when retrying after process restore', async () => {
    const firstJournal = fakeGoalJournal();
    let evidence: RuntimeRecord[] = [];
    const first = createGoalRuntime({
      journal: firstJournal,
      evidenceSource: fakeEvidenceSource(() => evidence, firstJournal),
      verifier: async () => ({
        decision: 'inconclusive',
        failureKind: 'service',
        reason: 'Temporary failure',
      }),
    });
    await first.dispatch({ action: 'create', objective: 'Deliver result' });
    const permit = first.beginTurn('user')!;
    evidence = verifierEvidenceRecords(
      permit,
      first.getSnapshot().goal!.evidenceCursor.recordId!,
    );
    first.recordTerminalProposal(permit, {
      status: 'complete',
      reason: 'Delivered',
      evidenceRefs: ['assistant-evidence'],
    });
    await first.finishTurn(permit);
    const goal = first.getSnapshot().goal!;
    first.dispose();
    let crashRecords: RuntimeRecord[] = [];
    const journal = fakeGoalJournal({
      beforeAppend: (payload) => {
        if (payload.cause === 'resume' && payload.verificationPending)
          crashRecords = structuredClone(journal.records);
      },
    });
    journal.records.push(...firstJournal.records);
    const restored = createGoalRuntime({
      journal,
      evidenceSource: fakeEvidenceSource(() => evidence, journal),
      verifier: async () => ({ decision: 'accept', reason: 'Verified' }),
    });
    await restored.restore(journal.records);
    await restored.dispatch({
      action: 'resume',
      expectedGoalId: goal.goalId,
      expectedRevision: goal.revision,
    });
    expect(recoverGoalFromRecords(crashRecords)).toMatchObject({
      kind: 'v2',
      payload: {
        snapshot: { goal: { status: 'paused' } },
        verificationPending: {
          proposal: { evidenceRefs: ['assistant-evidence'] },
        },
      },
    });
    expect(
      journal.appended.some(
        (payload) =>
          payload.snapshot.goal?.status === 'paused' &&
          !payload.verificationPending,
      ),
    ).toBe(false);
    expect(restored.getSnapshot().goal?.status).toBe('complete');
    restored.dispose();
  });
});
