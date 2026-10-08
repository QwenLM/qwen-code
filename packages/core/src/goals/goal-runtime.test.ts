/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { GoalEvidenceRecord } from './goal-evidence.js';
import { type GoalRecoveryRecord } from './goal-persistence.js';
import {
  GOAL_INFEASIBLE_NEXT_STEP,
  GOAL_DEFAULT_TOKEN_BUDGET,
  GOAL_NO_PROGRESS_TURN_LIMIT,
  GOAL_PAUSE_REASON_NO_PROGRESS,
  goalPauseReasonForVerifierFailure,
  GOAL_PROPOSAL_REASON_MAX_BYTES,
  goalActiveTimeBudgetReason,
  goalTurnBudgetReason,
  type GoalBlockerKind,
  type GoalBroadcastMeta,
  type GoalSnapshotV2,
  type GoalStateCause,
  type GoalStateRecordPayloadV2,
  type GoalTerminalProposal,
  type GoalTurnPermit,
  type TranscriptCursor,
} from './goal-protocol.js';
import {
  createGoalRuntime,
  GoalPersistenceUnavailableError,
  type CreateGoalRuntimeOptions,
  type GoalTurnHost,
} from './goal-runtime.js';
import { GoalConflictError } from './goal-reducer.js';
import {
  GOAL_VERIFIER_ENVELOPE_TOO_LARGE_REASON,
  GoalVerifierInputTooLargeError,
  type GoalVerifier,
} from './goal-verifier.js';
import {
  content,
  fnResponse,
  modelText,
} from '../test-utils/model-fixtures.js';

const FORMER_GOAL_CONTINUATION_LIMIT = 50;
const STALE_PERMIT = 'Goal turn permit is no longer valid';
const NO_GOAL = { v: 2, goal: null, activity: 'idle' };
/** The id and revision the stored-Goal fixtures below default to. */
const G1 = { goalId: 'g-1', revision: 1 };

type Runtime = ReturnType<typeof createGoalRuntime>;
type FakeJournal = ReturnType<typeof fakeGoalJournal>;
type StoredGoal = NonNullable<GoalSnapshotV2['goal']>;
type Verdict = Awaited<ReturnType<GoalVerifier>>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A `goal_state` record as the journal writes it; payload only when given. */
function goalControlRecord(
  uuid: string,
  parentUuid: string | null,
  systemPayload?: RuntimeRecord['systemPayload'],
): RuntimeRecord {
  return {
    uuid,
    parentUuid,
    sessionId: 's-1',
    timestamp: new Date(0).toISOString(),
    type: 'system',
    subtype: 'goal_state',
    provenance: 'goal_control',
    cwd: '/tmp',
    version: 'test',
    ...(systemPayload !== undefined ? { systemPayload } : {}),
  };
}

function fakeGoalJournal(
  options: {
    appendError?: Error;
    appendErrors?: Array<Error | undefined>;
    beforeAppend?: (payload: GoalStateRecordPayloadV2) => Promise<void> | void;
  } = {},
) {
  const appended: GoalStateRecordPayloadV2[] = [];
  const records: RuntimeRecord[] = [];
  return {
    appended,
    records,
    getTranscriptCursor(): TranscriptCursor {
      // The transcript tail, as the real journal answers: a fixed null would
      // make resume-cursor assertions trivial, and the real evidence pipeline
      // hard-rejects null (`analyzeEvidence` throws `cursor_unset`).
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
      const record = goalControlRecord(
        recordUuid,
        records.at(-1)?.uuid ?? null,
        structuredClone(payload),
      );
      records.push(record);
      return record;
    },
  };
}

/** A journal whose append number `index` (0-based) fails with `error`. */
function failingJournal(index: number, error: Error) {
  const appendErrors: Array<Error | undefined> = Array(index).fill(undefined);
  return fakeGoalJournal({ appendErrors: [...appendErrors, error] });
}

/** A journal whose appends (those `when` picks) signal `reached`, then wait. */
function gatedJournal(when = () => true) {
  const reached = deferred<void>();
  const gate = deferred<void>();
  const journal = fakeGoalJournal({
    beforeAppend: () => {
      if (!when()) return;
      reached.resolve();
      return gate.promise;
    },
  });
  return { journal, reached: reached.promise, release: () => gate.resolve() };
}

function goalStateRecord(
  snapshot: GoalSnapshotV2,
  cause: GoalStateCause = 'pause',
): RuntimeRecord {
  return goalControlRecord('restore-record', null, { v: 2, cause, snapshot });
}

/** An idle snapshot holding a stored Goal: paused `ship it` unless overridden. */
function goalSnapshot(goal: Partial<StoredGoal> = {}): GoalSnapshotV2 {
  return {
    v: 2,
    activity: 'idle',
    goal: {
      ...G1,
      objective: 'ship it',
      status: 'paused',
      evidenceCursor: { recordId: 'create-record' },
      turnCount: 2,
      activeTimeMs: 10,
      tokensUsed: 0,
      createdAt: 1,
      updatedAt: 2,
      ...goal,
    },
  };
}

const goalRecord = (goal: Partial<StoredGoal> = {}, cause?: GoalStateCause) =>
  goalStateRecord(goalSnapshot(goal), cause);

/** A restored active Goal that has not run a turn yet. */
const freshActive = (goal: Partial<StoredGoal> = {}) =>
  goalRecord({
    objective: 'ship',
    status: 'active',
    turnCount: 0,
    activeTimeMs: 0,
    updatedAt: 1,
    ...goal,
  });

/** A restored paused Goal that has not run a turn yet. */
const freshPaused = (goal: Partial<StoredGoal> = {}) =>
  goalRecord({
    evidenceCursor: { recordId: 'restore-record' },
    turnCount: 0,
    activeTimeMs: 0,
    updatedAt: 1,
    ...goal,
  });

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

type TurnInput = Parameters<GoalTurnHost['startGoalTurn']>[0];

/** A start throws the next queued `failures` entry, if any. */
function fakeGoalTurnHost() {
  const started: GoalTurnPermit[] = [];
  const inputs: TurnInput[] = [];
  const failures: Array<Error | undefined> = [];
  return {
    started,
    inputs,
    failures,
    async startGoalTurn(input: TurnInput) {
      const failure = failures.shift();
      if (failure) throw failure;
      started.push(structuredClone(input.permit));
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
    goalControlRecord(cursorId, null),
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
      message: modelText(`Delivered result ${index}`),
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

function asToolResult(record: RuntimeRecord, output: string): RuntimeRecord {
  return {
    ...record,
    type: 'tool_result',
    provenance: 'tool_result',
    message: content('user', fnResponse('shell', { output })),
  };
}

function fakeEvidenceSource(read: () => readonly RuntimeRecord[]) {
  return {
    flush: vi.fn(async (): Promise<void> => undefined),
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

function complete(
  reason: string,
  evidenceRefs?: string[],
): GoalTerminalProposal {
  return { status: 'complete', reason, ...(evidenceRefs && { evidenceRefs }) };
}
/** `complete` citing the default assistant evidence record. */
const delivered = (reason = 'Delivered') =>
  complete(reason, ['assistant-evidence']);
function blocked(
  reason: string,
  blockerKind?: GoalBlockerKind,
  evidenceRefs?: string[],
): GoalTerminalProposal {
  return {
    status: 'blocked',
    reason,
    ...(blockerKind && { blockerKind }),
    ...(evidenceRefs && { evidenceRefs }),
  };
}

const accepting = (reason: string): GoalVerifier =>
  vi.fn(async () => ({ decision: 'accept' as const, reason }));
const rejecting = (reason: string): GoalVerifier =>
  vi.fn(async () => ({ decision: 'reject' as const, reason }));

/** A ledger billing each turn what `spend` holds for it; `take` consumes. */
function spendLedger(take = false) {
  const spend = new Map<string, number>();
  const takeGoalTurnTokens = (turnId: string) => {
    const tokens = spend.get(turnId) ?? 0;
    if (take) spend.delete(turnId);
    return tokens;
  };
  return { spend, ledger: { takeGoalTurnTokens } };
}

type StartOptions = Omit<CreateGoalRuntimeOptions, 'journal'> & {
  journal?: FakeJournal;
  objective?: string | null; // null: no Goal is created
  restore?: RuntimeRecord[]; // restored in place of creating a Goal
  bind?: boolean; // false: the host is never bound
  spend?: 'peek' | 'take'; // installs a spendLedger
};

// Where most cases start: fake journal and host, the runtime bound to it, and
// a created (or `restore`d) Goal whose first continuation is `permit`.
async function startGoal({
  journal = fakeGoalJournal(),
  objective = 'ship',
  restore,
  bind = true,
  spend,
  ...options
}: StartOptions = {}) {
  const billing = spendLedger(spend === 'take');
  const host = fakeGoalTurnHost();
  const runtime = createGoalRuntime({
    journal,
    ...(spend && { ledger: billing.ledger }),
    ...options,
  });
  if (bind) runtime.bindHost(host);
  if (restore) await runtime.restore(restore);
  else if (objective !== null) await create(runtime, objective);
  return {
    journal,
    host,
    runtime,
    spend: billing.spend,
    permit: host.started[0]!,
    goal: () => runtime.getSnapshot().goal,
    snap: () => runtime.getSnapshot(),
    finishWith: (permit: GoalTurnPermit, tokens: number) => {
      billing.spend.set(permit.turnId, tokens);
      return runtime.finishTurn(permit);
    },
  };
}

// startGoal plus evidence source and verifier: `evidence` then builds the
// transcript (`source.records`) and `proposal` is recorded for `permit`.
async function startVerifiedGoal({
  verifier = vi.fn(),
  evidence = verifierEvidenceRecords,
  proposal,
  objective = 'deliver result',
  ...options
}: StartOptions & {
  verifier?: GoalVerifier;
  evidence?: (permit: GoalTurnPermit, cursorId: string) => RuntimeRecord[];
  proposal?: GoalTerminalProposal;
} = {}) {
  const source: { records: RuntimeRecord[] } = { records: [] };
  const evidenceSource = fakeEvidenceSource(() => source.records);
  const started = await startGoal({
    ...options,
    objective,
    evidenceSource,
    verifier,
  });
  source.records = evidence(started.permit, cursorOf(started.runtime));
  const receipt =
    proposal &&
    started.runtime.recordTerminalProposal(started.permit, proposal);
  return { ...started, verifier, evidenceSource, source, receipt };
}

/** startVerifiedGoal, then its first turn finishes; `causes` it broadcast. */
async function verifiedTurn(options: Parameters<typeof startVerifiedGoal>[0]) {
  const started = await startVerifiedGoal(options);
  const causes = recordCauses(started.runtime);
  await started.runtime.finishTurn(started.permit);
  return { ...started, causes };
}

// startVerifiedGoal whose verifier waits on `verdict`, the turn `finishing`;
// by default `ship`, finished proposing completion.
async function verifyingGoal(
  options: Omit<Parameters<typeof startVerifiedGoal>[0], 'verifier'> = {},
) {
  const verdict = deferred<Verdict>();
  const started = await startVerifiedGoal({
    objective: 'ship',
    proposal: delivered('Done'),
    ...options,
    verifier: vi.fn(() => verdict.promise),
  });
  const finishing = started.runtime.finishTurn(started.permit);
  await vi.waitFor(() => expect(started.verifier).toHaveBeenCalledOnce());
  return { ...started, verdict, finishing };
}

const cursorOf = (runtime: Runtime) =>
  runtime.getSnapshot().goal!.evidenceCursor.recordId!;
const turnKey = (permit: GoalTurnPermit) => `goal-runtime:${permit.turnId}`;
const causesOf = (journal: FakeJournal) =>
  journal.appended.map((payload) => payload.cause);
/** Asserts the journaled causes, written as one space-separated list. */
const expectCauses = (journal: FakeJournal, causes: string) =>
  expect(causesOf(journal)).toEqual(causes.split(' '));
const expectState = (
  runtime: Runtime,
  activity: GoalSnapshotV2['activity'],
  goal: Record<string, unknown>,
) => expect(runtime.getSnapshot()).toMatchObject({ activity, goal });
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A token grant that opts the Goal out of the budget. */
const UNBOUNDED = { tokenBudgetGrant: Number.POSITIVE_INFINITY };
/** No Goal, host not yet bound. */
const BARE = { bind: false, objective: null } as const;
/** A Goal with a 1 000-token window billed through a spend ledger. */
const budgetGoal = (spend: 'peek' | 'take', options: StartOptions = {}) =>
  startGoal({ ...options, spend, tokenBudgetGrant: 1_000 });

const create = (runtime: Runtime, objective = 'ship') =>
  runtime.dispatch({ action: 'create', objective });

/** Dispatches `action` against `target`'s goal id and revision. */
function control(
  runtime: Runtime,
  action: 'pause' | 'resume' | 'clear',
  target: { goalId: string; revision: number },
  extra: { reason?: string } = {},
) {
  return runtime.dispatch({
    action,
    expectedGoalId: target.goalId,
    expectedRevision: target.revision,
    ...extra,
  });
}

function edit(
  runtime: Runtime,
  target: { goalId: string; revision: number },
  objective: string,
  action: 'edit' | 'replace' = 'edit',
) {
  return runtime.dispatch({
    action,
    objective,
    expectedGoalId: target.goalId,
    expectedRevision: target.revision,
  });
}

// Real hosts mark a continuation delivered when they send its prompt; the
// fake host does not, so cases where the model saw the turn say so first.
async function finishDelivered(runtime: Runtime, permit: GoalTurnPermit) {
  runtime.markTurnDelivered(turnKey(permit));
  await runtime.finishTurn(permit);
}

// A wind-down turn stamps the record only once delivered; its stop settles
// after the finish, on the dispatch tail that refuses the next continuation.
async function finishHandOff(runtime: Runtime, permit: GoalTurnPermit) {
  await finishDelivered(runtime, permit);
  await waitForStatus(runtime, 'usage_limited');
}

/** Delivers and finishes the first `count` continuations in order. */
async function finishDeliveredTurns(
  { runtime, host }: { runtime: Runtime; host: { started: GoalTurnPermit[] } },
  count = GOAL_NO_PROGRESS_TURN_LIMIT,
) {
  for (let turn = 0; turn < count; turn++) {
    await finishDelivered(runtime, host.started[turn]!);
  }
}

/** Records `proposal`, asserting it was taken and whether it is ready. */
const expectReceipt = (
  runtime: Runtime,
  permit: GoalTurnPermit,
  proposal: GoalTerminalProposal,
  readyForVerification = true,
) =>
  expect(runtime.recordTerminalProposal(permit, proposal)).toEqual({
    recorded: true,
    readyForVerification,
  });

/** A runtime whose hand-written host records each permit, then awaits `hold`. */
function holdingRuntime(
  hold?: Promise<void>,
  preemptGoalTurn: GoalTurnHost['preemptGoalTurn'] = vi.fn(),
) {
  const started: GoalTurnPermit[] = [];
  const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
  runtime.bindHost({
    async startGoalTurn({ permit }) {
      started.push(permit);
      await hold;
    },
    preemptGoalTurn,
  });
  return { runtime, started };
}

function recordCauses(runtime: Runtime) {
  const causes: Array<GoalStateCause | undefined> = [];
  runtime.subscribe((_snapshot, cause) => causes.push(cause));
  return causes;
}

function recordSnapshots(runtime: Runtime) {
  const observed: GoalSnapshotV2[] = [];
  runtime.subscribe((snapshot) => observed.push(snapshot));
  return observed;
}

const waitForStatus = (runtime: Runtime, status: StoredGoal['status']) =>
  vi.waitFor(() => expect(runtime.getSnapshot().goal?.status).toBe(status));

/** Runs `body` with only `Date` faked, starting at `start`. */
async function withFakeDate(start: number, body: () => Promise<void>) {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(start);
    await body();
  } finally {
    vi.useRealTimers();
  }
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
    const { journal, reached, release } = gatedJournal();
    const runtime = createGoalRuntime({ journal });

    const creating = create(runtime);
    await reached;
    runtime.dispose();
    release();

    await expect(creating).rejects.toThrow('disposed');
    expect(runtime.getSnapshot()).toEqual(NO_GOAL);
  });

  it('bills a finished turn the tokens its own records carried', async () => {
    const { host, goal, finishWith } = await startGoal({ spend: 'take' });

    await finishWith(host.started[0]!, 2_500);
    expect(goal()).toMatchObject({ turnCount: 1, tokensUsed: 2_500 });

    await finishWith(host.started[1]!, 500);
    expect(goal()).toMatchObject({ turnCount: 2, tokensUsed: 3_000 });
  });

  it.each(['accept', 'reject'] as const)(
    'persists %s verifier usage once and applies the budget gate',
    async (decision) => {
      const { journal, host, runtime, verifier, source, goal } =
        await verifiedTurn({
          verifier: vi.fn(async () => ({
            decision,
            reason: 'Checked the cited result',
            usage: { totalTokenCount: 250 },
          })),
          ledger: { takeGoalTurnTokens: () => 800 },
          tokenBudgetGrant: 1_000,
          proposal: delivered(),
        });

      expect(verifier).toHaveBeenCalledOnce();
      expect(
        journal.appended.find(({ cause }) => cause === 'turn_finished')!
          .snapshot.goal?.tokensUsed,
      ).toBe(800);
      expect(
        journal.appended.find(({ cause }) => cause === `verifier_${decision}`)!
          .snapshot.goal,
      ).toMatchObject({ tokensUsed: 1_050, turnCount: 1 });
      expect(goal()).toMatchObject({
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
          evidenceSource: fakeEvidenceSource(() => source.records),
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
    const takeGoalTurnTokens = vi.fn((_turnId: string) => 0);
    const { runtime, permit } = await startGoal({
      ledger: { takeGoalTurnTokens },
    });

    await runtime.finishTurn(permit);

    expect(takeGoalTurnTokens.mock.calls).toEqual([[permit.turnId]]);
  });

  it('arms the default token budget when no grant is supplied', async () => {
    const { goal } = await startGoal({ bind: false });

    expect(goal()?.tokenBudget).toBe(GOAL_DEFAULT_TOKEN_BUDGET);
    // The check above tracks the constant; only this pin catches a rescale.
    expect(GOAL_DEFAULT_TOKEN_BUDGET).toBe(30_000_000);
  });

  it('stops autonomous continuation when the budget is spent, and resume re-arms it', async () => {
    const { journal, host, runtime, goal, finishWith } =
      await budgetGoal('take');
    const created = goal()!;
    expect(created).toMatchObject({ tokenBudget: 1_000, tokensUsed: 0 });

    await finishWith(host.started[0]!, 1_500);

    // The spent window buys one more turn, flagged to ask for a hand-off.
    expect(host.started).toHaveLength(2);
    expect(host.inputs[1]).toMatchObject({ windDown: true });
    expect(host.inputs[0]).not.toHaveProperty('windDown');
    expect(goal()?.status).toBe('active');

    // Delivered (only a delivered wind-down turn stamps the record); the stop
    // settles on the dispatch tail where the next continuation was refused.
    runtime.markTurnDelivered(turnKey(host.started[1]!));
    await runtime.finishTurn(host.started[1]!);
    await waitForStatus(runtime, 'usage_limited');
    expect(goal()).toMatchObject({
      limitKind: 'token_budget',
      tokensUsed: 1_500,
      tokenBudget: 1_000,
      windDownTurnId: host.started[1]!.turnId,
      lastReason: expect.stringContaining('autonomous token budget'),
    });
    // No third turn: the hand-off is one per window.
    expect(host.started).toHaveLength(2);
    expectCauses(journal, 'create turn_finished turn_finished usage_limited');
    expect(journal.appended[1]!.snapshot.goal).not.toHaveProperty(
      'windDownTurnId',
    );
    expect(journal.appended[2]!.snapshot.goal).toMatchObject({
      windDownTurnId: host.started[1]!.turnId,
    });

    // Resuming IS the user paying for another window: the ceiling moves ahead
    // of the meter, and the re-armed window admits a real continuation again.
    const resumed = await control(runtime, 'resume', created);
    expect(resumed.snapshot.goal).toMatchObject({
      status: 'active',
      tokensUsed: 1_500,
      tokenBudget: 2_500,
    });
    expect(resumed.snapshot.goal?.limitKind).toBeUndefined();
    // The re-armed window owes its own hand-off: the old marker is gone.
    expect(resumed.snapshot.goal).not.toHaveProperty('windDownTurnId');
    expect(host.started).toHaveLength(3);
    expect(host.inputs[2]).not.toHaveProperty('windDown');
  });

  it('stops at an exact-ceiling spend without minting another turn', async () => {
    const { host, runtime, goal, finishWith } = await budgetGoal('take');

    // Spend lands exactly on the ceiling: still spent, so the only further
    // turn is the hand-off.
    await finishWith(host.started[0]!, 1_000);
    expect(host.started).toHaveLength(2);
    expect(host.inputs[1]).toMatchObject({ windDown: true });
    runtime.markTurnDelivered(turnKey(host.started[1]!));
    await runtime.finishTurn(host.started[1]!);
    await waitForStatus(runtime, 'usage_limited');
    expect(goal()).toMatchObject({
      limitKind: 'token_budget',
      tokensUsed: 1_000,
      tokenBudget: 1_000,
    });
    expect(host.started).toHaveLength(2);
  });

  it('shows the budget stop even when the settle write fails', async () => {
    const journal = failingJournal(3, new Error('writer unavailable'));
    const { host, runtime, goal, finishWith } = await budgetGoal('take', {
      journal,
      objective: null,
    });
    const causes = recordCauses(runtime);
    await create(runtime);

    await finishWith(host.started[0]!, 1_500);
    runtime.markTurnDelivered(turnKey(host.started[1]!));
    await runtime.finishTurn(host.started[1]!);
    await waitForStatus(runtime, 'usage_limited');
    // Unjournaled, yet the visible state settles: the gate refuses continuations
    // either way, and the user's next action surfaces the persistence loss.
    expectCauses(journal, 'create turn_finished turn_finished');
    expect(goal()).toMatchObject({
      limitKind: 'token_budget',
      tokensUsed: 1_500,
      tokenBudget: 1_000,
    });
    expect(causes).toContain('usage_limited');
    expect(host.started).toHaveLength(2);
  });

  it('mints the hand-off again when the host dropped it undelivered', async () => {
    const { host, runtime, goal, finishWith } = await budgetGoal('peek');

    // The hand-off's start is refused, so the model never saw it. Only the
    // turn that finishes stamps the record, and nothing finished.
    host.failures.push(new Error('host is not accepting turns'));
    await finishWith(host.started[0]!, 1_500);
    await tick();
    expect(goal()?.status).toBe('active');
    expect(goal()).not.toHaveProperty('windDownTurnId');

    runtime.bindHost(host);
    await tick();
    expect(host.inputs.at(-1)).toMatchObject({ windDown: true });
    expect(host.started).toHaveLength(2);
  });

  it('grants the hand-off again when its turn finished without being delivered', async () => {
    // A system message or direct user query can claim the wind-down permit
    // and send its own text: the turn finishes but the user never got the
    // hand-off, so the record must not say so and the next turn owes it.
    const { journal, host, runtime, goal, finishWith } =
      await budgetGoal('peek');
    await finishWith(host.started[0]!, 1_500);
    expect(host.inputs[1]).toMatchObject({ windDown: true });

    // Finished under the wind-down permit, never marked delivered.
    await runtime.finishTurn(host.started[1]!);
    await tick();

    expect(goal()?.status).toBe('active');
    expect(goal()).not.toHaveProperty('windDownTurnId');
    expect(journal.appended.at(-1)!.snapshot.goal).not.toHaveProperty(
      'windDownTurnId',
    );
    expect(host.started).toHaveLength(3);
    expect(host.inputs[2]).toMatchObject({ windDown: true });
  });

  it('stops after the hand-off once a delivered wind-down turn finishes', async () => {
    const { host, runtime, goal, finishWith } = await budgetGoal('peek');
    await finishWith(host.started[0]!, 1_500);
    const windDown = host.started[1]!;
    expect(host.inputs[1]).toMatchObject({ windDown: true });

    runtime.markTurnDelivered(turnKey(windDown));
    await runtime.finishTurn(windDown);
    await waitForStatus(runtime, 'usage_limited');
    expect(goal()).toMatchObject({
      limitKind: 'token_budget',
      windDownTurnId: windDown.turnId,
    });
    expect(host.started).toHaveLength(2);
  });

  it('completes a Goal whose hand-off turn proves the objective done', async () => {
    const { journal, host, runtime, source, finishWith } =
      await startVerifiedGoal({
        verifier: accepting('Evidence satisfies the objective'),
        evidence: () => [],
        spend: 'peek',
        tokenBudgetGrant: 1_000,
      });
    await finishWith(host.started[0]!, 1_500);
    await vi.waitFor(() => expect(host.started).toHaveLength(2));
    const windDown = host.started[1]!;
    expect(host.inputs[1]).toMatchObject({ windDown: true });

    // The hand-off finds the objective already met and says so. A budget
    // stop must not overrule a completion the verifier accepted.
    source.records = verifierEvidenceRecords(windDown, cursorOf(runtime));
    runtime.recordTerminalProposal(windDown, delivered());
    await runtime.finishTurn(windDown);

    await waitForStatus(runtime, 'complete');
    expect(causesOf(journal)).not.toContain('usage_limited');
    expect(host.started).toHaveLength(2);
  });

  // A restored Goal whose 1 000-token window is already spent.
  const spentWindow = (goal: Partial<StoredGoal> = {}) =>
    goalRecord(
      {
        objective: 'keep going',
        status: 'active',
        evidenceCursor: { recordId: 'limit-record' },
        turnCount: 3,
        activeTimeMs: 1_000,
        tokensUsed: 1_500,
        tokenBudget: 1_000,
        ...goal,
      },
      'turn_finished',
    );

  it('does not grant a second hand-off after a restart that already saw one', async () => {
    const { host, runtime, goal } = await startGoal({
      tokenBudgetGrant: 1_000,
      objective: null,
    });
    await runtime.restore([
      spentWindow({ windDownTurnId: 'turn-before-restart' }),
    ]);

    // The record says the hand-off already finished; the restart changes
    // nothing about that, so the only thing left to do is stop.
    await waitForStatus(runtime, 'usage_limited');
    expect(goal()).toMatchObject({
      limitKind: 'token_budget',
      windDownTurnId: 'turn-before-restart',
    });
    expect(host.started).toHaveLength(0);
  });

  it('grants the hand-off after a restart that interrupted it', async () => {
    const { host, goal } = await startGoal({
      tokenBudgetGrant: 1_000,
      restore: [spentWindow()],
    });

    // No marker: either the window was never handed off, or the process
    // died mid-hand-off. Both mean the user never got one, so it is owed.
    await vi.waitFor(() => expect(host.started).toHaveLength(1));
    expect(host.inputs[0]).toMatchObject({ windDown: true });
    expect(goal()?.status).toBe('active');
  });

  it('never arms a budget when the runtime opts out with an unbounded grant', async () => {
    const { host, runtime, goal } = await startGoal(UNBOUNDED);
    expect(goal()).not.toHaveProperty('tokenBudget');
    await runtime.finishTurn(host.started[0]!);
    expect(goal()?.status).toBe('active');
    expect(host.started).toHaveLength(2);
  });

  it.each([
    ['bills nothing when no ledger is configured', {}],
    [
      'finishes the turn when the ledger throws',
      {
        ledger: {
          takeGoalTurnTokens: () => {
            throw new Error('recorder is unavailable');
          },
        },
      },
    ],
  ])('%s', async (_title, options) => {
    const { runtime, permit, goal } = await startGoal(options);

    await expect(runtime.finishTurn(permit)).resolves.toBeUndefined();
    expect(goal()).toMatchObject({ turnCount: 1, tokensUsed: 0 });
  });

  it('persists verifier acceptance before completing a verified proposal', async () => {
    const started = await verifiedTurn({
      verifier: accepting('Evidence satisfies the objective'),
      proposal: delivered(),
    });
    const { journal, host, runtime, permit, verifier, causes } = started;

    expect(started.evidenceSource.flush).toHaveBeenCalledOnce();
    expect(verifier).toHaveBeenCalledWith(
      expect.objectContaining({
        currentTurnId: permit.turnId,
        evidenceTurnIds: [permit.turnId],
        evidence: [
          expect.objectContaining({
            uuid: 'assistant-evidence',
            proofKind: 'delivered_output',
            content: 'Delivered result',
          }),
        ],
      }),
      expect.any(AbortSignal),
    );
    expectCauses(journal, 'create turn_finished verifier_accept complete');
    expect(causes).toEqual(['turn_finished', 'complete']);
    expectState(runtime, 'idle', {
      status: 'complete',
      lastReason: 'Evidence satisfies the objective',
    });
    expect(host.started).toHaveLength(1);
  });

  it('accepts a verified blocker as a resumable terminal state', async () => {
    const { journal, runtime, verifier, causes } = await verifiedTurn({
      verifier: accepting('User authority is required'),
      objective: 'deploy',
      evidence: verifierUserEvidenceRecords,
      proposal: blocked('Need deployment approval', 'authority', [
        'user-evidence',
      ]),
    });

    expectCauses(journal, 'create turn_finished verifier_accept blocked');
    expect(causes).toEqual(['turn_finished', 'blocked']);
    expectState(runtime, 'idle', {
      status: 'blocked',
      lastReason: 'User authority is required',
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
    const { journal, host, runtime, verifier, receipt } = await verifiedTurn({
      verifier: accepting('The named branch does not exist'),
      objective: 'Rebase onto the v9 branch',
      evidence: (p, cursorId) => {
        const [cursor, probe] = verifierEvidenceRecords(p, cursorId, 'probe');
        return [cursor!, asToolResult(probe!, "fatal: branch 'v9' not found")];
      },
      // No three-turn streak: the whole point is to stop before the budget
      // does, and the evidence bar (an external fact) is what earns that.
      proposal: blocked(
        'Checked the remote: no v9 branch exists, so nothing in scope can rebase onto it.',
        'infeasible',
        ['probe'],
      ),
    });

    expect(receipt).toEqual({ recorded: true, readyForVerification: true });
    expect(verifier).toHaveBeenCalledWith(
      expect.objectContaining({
        proposal: expect.objectContaining({ blockerKind: 'infeasible' }),
        blockedPolicy: expect.stringContaining(
          'An infeasible blocker may also be accepted immediately',
        ),
      }),
      expect.any(AbortSignal),
    );
    expectCauses(journal, 'create turn_finished verifier_accept blocked');
    expectState(runtime, 'idle', {
      status: 'blocked',
      lastReason: `The named branch does not exist ${GOAL_INFEASIBLE_NEXT_STEP}`,
    });
    expect(host.started).toHaveLength(1);
  });

  it("sends the verifier this turn's records newest first, without references", async () => {
    const { permit, verifier, goal } = await verifiedTurn({
      verifier: accepting('The suite passed in this turn'),
      evidence: (p, cursorId) => {
        const base = verifierEvidenceRecords(p, cursorId);
        return [
          ...base,
          {
            ...asToolResult(base[1]!, '18 tests passed'),
            uuid: 'tool-evidence',
          },
        ];
      },
      proposal: complete('Delivered', ['a-reference-the-runtime-ignores']),
    });

    expect(verifier).toHaveBeenCalledOnce();
    const input = vi.mocked(verifier).mock.calls[0]![0];
    expect(input).toMatchObject({
      currentTurnId: permit.turnId,
      evidenceTurnIds: [permit.turnId],
      proposal: { status: 'complete', reason: 'Delivered' },
    });
    expect(input).not.toHaveProperty('omitted');
    expect(input.evidence.map((record) => record.uuid)).toEqual([
      'tool-evidence',
      'assistant-evidence',
    ]);
    expect(input.evidence[0]).toMatchObject({
      provenance: 'tool_result',
      proofKind: 'external_fact',
      turnId: permit.turnId,
    });
    expect(input.evidence[0]!.content).toContain('18 tests passed');
    expect(input.evidence[1]).toMatchObject({
      provenance: 'assistant_output',
      proofKind: 'delivered_output',
      content: 'Delivered result',
    });
    expect(goal()).toMatchObject({ status: 'complete' });
  });

  it('keeps the newest records of the turn and reports the ones the verifier limit left out', async () => {
    const { journal, verifier, goal } = await verifiedTurn({
      verifier: accepting('The newest output proves it'),
      // 140 records of 2 100 content bytes against a 256 000-byte request
      // (serialized): the newest hundred or so are sent, the rest counted, so
      // a turn that ran a hundred tools is judged from its tail, not stopped.
      evidence: (p, cursorId) =>
        verifierEvidenceWindow(p, cursorId, 140).map((record) =>
          record.type === 'assistant'
            ? { ...record, message: modelText('x'.repeat(2_100)) }
            : record,
        ),
      proposal: complete('Delivered'),
    });

    expect(verifier).toHaveBeenCalledOnce();
    const input = vi.mocked(verifier).mock.calls[0]![0];
    expect(input.evidence.length).toBeGreaterThan(100);
    expect(input.evidence.length).toBeLessThan(125);
    expect(input.evidence[0]!.uuid).toBe('assistant-evidence-139');
    expect(input.evidence.at(-1)!.uuid).toBe(
      `assistant-evidence-${140 - input.evidence.length}`,
    );
    expect(input.omitted).toBe(140 - input.evidence.length);
    expect(goal()).toMatchObject({ status: 'complete' });
    expectCauses(journal, 'create turn_finished verifier_accept complete');
  });

  it.each([
    ['fills the request by itself', 260_000],
    // Room for a stub but not for one full record: the verifier could only
    // reject for what the window left out, turn after turn.
    ['leaves less room than one full record needs', 245_000],
  ])(
    'pauses with a clear reason when the objective %s',
    async (_name, length) => {
      // /goal set accepts any length; a pasted 250 kB specification is the
      // objective, and no evidence window can fit next to it.
      const { journal, host, runtime, verifier, goal } = await verifiedTurn({
        objective: 'x'.repeat(length),
        proposal: complete('Delivered'),
      });

      expect(verifier).not.toHaveBeenCalled();
      expectState(runtime, 'idle', {
        status: 'paused',
        lastReason: GOAL_VERIFIER_ENVELOPE_TOO_LARGE_REASON,
      });
      expect(goal()).not.toHaveProperty('limitKind');
      expect(journal.appended.at(-1)).toMatchObject({ cause: 'pause' });
      expect(host.started).toHaveLength(1);
    },
  );

  it('still asks the verifier when a long objective leaves room for a full record', async () => {
    const { verifier, goal } = await verifiedTurn({
      verifier: accepting('ok'),
      objective: 'x'.repeat(230_000),
      proposal: complete('Delivered'),
    });

    expect(verifier).toHaveBeenCalledOnce();
    expect(goal()).toMatchObject({ status: 'complete' });
  });

  it.each([
    ['times out', new Error('Goal verifier timed out after 120000ms')],
    ['cannot send the request', new GoalVerifierInputTooLargeError(300_000)],
    [
      'answers with something that is not a verdict',
      new Error('Goal verifier returned invalid JSON'),
    ],
  ])(
    'pauses the Goal, resumably, when the verifier %s',
    async (_name, failure) => {
      const { journal, host, runtime, verifier, snap, goal } =
        await verifiedTurn({
          verifier: vi.fn(async () => {
            throw failure;
          }),
          proposal: complete('Delivered'),
        });

      // One attempt: a request the model could not answer is not resent at
      // another size, and no verdict is no limit.
      expect(verifier).toHaveBeenCalledOnce();
      expectCauses(journal, 'create turn_finished pause');
      const paused = snap();
      expect(paused).toMatchObject({
        activity: 'idle',
        goal: {
          status: 'paused',
          lastReason: goalPauseReasonForVerifierFailure(failure.message),
        },
      });
      expect(paused.goal).not.toHaveProperty('limitKind');
      expect(host.started).toHaveLength(1);

      await control(runtime, 'resume', paused.goal!);
      expect(goal()).toMatchObject({ status: 'active' });
      expect(host.started).toHaveLength(2);
    },
  );

  it('leaves a blocked proposal to the verifier instead of refusing it on a coverage rule', async () => {
    // The default evidence: only the model's own prose says it cannot be done.
    const { journal, host, verifier, goal } = await verifiedTurn({
      verifier: rejecting('Only the assistant says it cannot be done'),
      objective: 'rebase onto v9',
      proposal: blocked('I do not think this can be done', 'infeasible'),
    });

    expect(verifier).toHaveBeenCalledOnce();
    expect(vi.mocked(verifier).mock.calls[0]![0]).toMatchObject({
      proposal: { status: 'blocked', blockerKind: 'infeasible' },
      blockedPolicy: expect.stringContaining('external_fact evidence'),
    });
    expectCauses(journal, 'create turn_finished verifier_reject');
    expect(goal()).toMatchObject({
      status: 'active',
      lastReason: 'Only the assistant says it cannot be done',
    });
    expect(host.started).toHaveLength(2);
  });

  // A verified Goal with only its cursor record: `outputs` and `userBlocker`
  // build a streak turn's records, `propose` records its repeated blocker.
  async function streakGoal(verifier: GoalVerifier) {
    const started = await startVerifiedGoal({
      verifier,
      evidence: (p, cursorId) => [verifierEvidenceRecords(p, cursorId)[0]!],
    });
    const cursorId = cursorOf(started.runtime);
    const reason = 'The same dependency is unavailable';
    return {
      ...started,
      cursorId,
      outputs: (permit: GoalTurnPermit, count: number, prefix: string) =>
        verifierEvidenceWindow(permit, cursorId, count, prefix).slice(1),
      userBlocker: (permit: GoalTurnPermit, id: string) =>
        verifierUserEvidenceRecords(permit, cursorId, id)[1]!,
      propose: (permit: GoalTurnPermit, evidenceRefs: string[]) =>
        started.runtime.recordTerminalProposal(
          permit,
          blocked(reason, 'repeated', evidenceRefs),
        ),
    };
  }

  it('lets a repeated blocker streak reach the verifier when the catalog truncates', async () => {
    const streak = await streakGoal(
      accepting('The repeated blocker is established'),
    );
    const { journal, host, runtime, verifier, goal, source } = streak;
    const { outputs, userBlocker, propose } = streak;

    const first = host.started[0]!;
    source.records.push(
      ...outputs(first, 98, 'first-turn'),
      userBlocker(first, 'blocker-1'),
    );
    expect(propose(first, [])).toMatchObject({ readyForVerification: false });
    await runtime.finishTurn(first);

    const second = host.started[1]!;
    source.records.push(userBlocker(second, 'blocker-2'));
    expect(propose(second, [])).toMatchObject({ readyForVerification: false });
    await runtime.finishTurn(second);

    const third = host.started[2]!;
    source.records.push(
      ...outputs(third, 2, 'third-turn'),
      userBlocker(third, 'blocker-3'),
    );
    expect(
      propose(third, ['blocker-1', 'blocker-2', 'blocker-3']),
    ).toMatchObject({ readyForVerification: true });

    await runtime.finishTurn(third);

    expect(verifier).toHaveBeenCalledOnce();
    expectCauses(
      journal,
      'create turn_finished turn_finished turn_finished verifier_accept blocked',
    );
    expect(goal()).toMatchObject({ status: 'blocked' });
  });

  // What a build that compressed evidence into checkpoints journaled: a
  // checkpoint, a stall streak with its diagnostic, and a check left pending
  // at shutdown. Written by hand: nothing can produce these shapes any more.
  const legacyCheckpointGoal = {
    ...goalSnapshot({
      objective: 'deliver result',
      status: 'active',
      evidenceCursor: { recordId: 'checkpoint-record' },
      turnCount: 6,
      tokensUsed: 1200,
    }).goal,
    evidenceCheckpoint: {
      checkpointId: 'checkpoint-record',
      createdAt: 2,
      claims: [
        {
          id: 'checkpoint-record:1',
          proofKind: 'delivered_output',
          claim: 'The implementation result was delivered.',
          sourceRefs: ['assistant-evidence-79'],
        },
      ],
    },
    checkpointStalls: 2,
    lastCheckpointFailure: 'InvalidGoalCheckpointError: claims were not JSON',
  };
  const legacyRecord = (
    uuid: string,
    cause: string,
    goal: Record<string, unknown>,
    checkpointPending?: Record<string, unknown>,
  ) =>
    goalControlRecord(uuid, null, {
      v: 2,
      cause,
      snapshot: { v: 2, activity: 'idle', goal },
      ...(checkpointPending && { checkpointPending }),
    });

  it('restores a Goal an earlier build left mid-checkpoint, and continues it', async () => {
    const { journal, host, runtime } = await startGoal({ objective: null });

    await runtime.restore([
      legacyRecord('checkpoint-record', 'checkpoint', legacyCheckpointGoal),
      legacyRecord(
        'turn-record',
        'turn_finished',
        { ...legacyCheckpointGoal, turnCount: 7 },
        {
          permit: { goalId: 'g-1', revision: 1, turnId: 'turn-7' },
          recordUuid: 'pending-checkpoint-record',
        },
      ),
    ]);

    // Recovered, not lost to a parser that no longer knows the keys; nothing
    // is replayed or written for the pending check, and the next turn starts.
    const goal = runtime.getSnapshot().goal;
    expect(goal).toMatchObject({
      goalId: 'g-1',
      status: 'active',
      turnCount: 7,
      tokensUsed: 1200,
      evidenceCursor: { recordId: 'checkpoint-record' },
    });
    expect(goal).not.toHaveProperty('evidenceCheckpoint');
    expect(goal).not.toHaveProperty('checkpointStalls');
    expect(goal).not.toHaveProperty('lastCheckpointFailure');
    expect(journal.appended).toEqual([]);
    expect(runtime.getSnapshot().activity).toBe('running');
    expect(host.started).toHaveLength(1);

    // What it journals from here on carries none of the old keys.
    await runtime.finishTurn(host.started[0]!);
    expect(journal.appended.at(-1)).not.toHaveProperty('checkpointPending');
    expect(journal.appended.at(-1)!.snapshot.goal).not.toHaveProperty(
      'evidenceCheckpoint',
    );
  });

  it.each(['evidence_catalog', 'checkpoint_request'] as const)(
    'resumes a Goal an earlier build stopped at the %s limit from a fresh window',
    async (limitKind) => {
      const { host, runtime, goal } = await startGoal({ objective: null });
      await runtime.restore([
        legacyRecord('stop-record', 'usage_limited', {
          ...legacyCheckpointGoal,
          status: 'usage_limited',
          limitKind,
          lastReason: 'The evidence window could not be compressed.',
        }),
      ]);
      expect(goal()).toMatchObject({ status: 'usage_limited', limitKind });
      expect(host.started).toHaveLength(0);

      await control(runtime, 'resume', G1);

      const resumed = goal()!;
      expect(resumed.status).toBe('active');
      expect(resumed.limitKind).toBeUndefined();
      expect(resumed.evidenceCursor.recordId).not.toBe('checkpoint-record');
      expect(host.started).toHaveLength(1);
    },
  );

  it('preserves raw lineage when a repeated blocker verifier rejects', async () => {
    const streak = await streakGoal(
      rejecting('The repeated blocker is not established'),
    );
    const { journal, host, runtime, verifier, goal, source, cursorId } = streak;

    for (let index = 0; index < 2; index += 1) {
      const permit = host.started[index]!;
      source.records.push(streak.userBlocker(permit, `blocker-${index + 1}`));
      expect(streak.propose(permit, [])).toMatchObject({
        readyForVerification: false,
      });
      await runtime.finishTurn(permit);
    }

    const third = host.started[2]!;
    source.records.push(...streak.outputs(third, 78, 'third-turn'));
    expect(
      streak.propose(third, ['blocker-1', 'blocker-2', 'third-turn-77']),
    ).toMatchObject({ readyForVerification: true });

    await runtime.finishTurn(third);

    expect(verifier).toHaveBeenCalledOnce();
    expectCauses(
      journal,
      'create turn_finished turn_finished turn_finished verifier_reject',
    );
    expect(goal()).toMatchObject({
      status: 'active',
      evidenceCursor: { recordId: cursorId },
    });
    expect(host.started).toHaveLength(4);
  });

  it.each([
    ['flush', new Error('flush failed')],
    ['read', new Error('read failed')],
    ['cursor', new Error('is not in the active transcript chain')],
  ] as const)(
    'moves to usage_limited when verification %s fails before the verifier is asked',
    async (failurePoint, failure) => {
      const { journal, host, runtime, permit, verifier, evidenceSource, snap } =
        await startVerifiedGoal({
          verifier: accepting('ok'),
          // cursor: the chain no longer holds the record the Goal's window
          // starts after, so there is nothing to anchor the window in.
          evidence: (p, cursorId) =>
            verifierEvidenceRecords(p, cursorId).slice(
              failurePoint === 'cursor' ? 1 : 0,
            ),
          proposal: delivered(),
        });
      if (failurePoint === 'flush') {
        evidenceSource.flush.mockRejectedValueOnce(failure);
      } else if (failurePoint === 'read') {
        evidenceSource.readActiveTranscriptChain.mockRejectedValueOnce(failure);
      }
      const causes = recordCauses(runtime);

      await runtime.finishTurn(permit);

      expectState(runtime, 'idle', {
        status: 'usage_limited',
        lastReason: expect.stringContaining(failure.message),
      });
      expect(verifier).not.toHaveBeenCalled();
      expect(journal.appended.at(-1)?.cause).toBe('usage_limited');
      expect(causes).toEqual(['turn_finished', 'usage_limited']);
      expect(host.started).toHaveLength(1);
      // Not one of the evidence limits: those can no longer occur.
      expect(snap().goal).not.toHaveProperty('limitKind');
      await control(runtime, 'resume', permit);
      expect(snap().goal?.status).toBe('active');
      expect(host.started).toHaveLength(2);
    },
  );

  it('promotes queued user input with exact verifier feedback after rejection', async () => {
    const { host, runtime, snap, verdict, finishing } = await verifyingGoal({
      objective: 'deliver result',
      proposal: delivered(),
    });
    expect(runtime.beginTurn('real-user')).toBeUndefined();

    verdict.resolve({ decision: 'reject', reason: 'Add the missing example' });
    await finishing;

    const userPermit = runtime.permitForTurn('real-user')!;
    expect(userPermit).toBeDefined();
    expect(runtime.getVerifierFeedback(userPermit)).toBe(
      'Add the missing example',
    );
    expect(host.started).toHaveLength(1);
    expect(snap().activity).toBe('running');
  });

  it.each(['blocked', 'paused'] as const)(
    'preserves queued user priority when verification stops as %s',
    async (terminalStatus) => {
      const { host, runtime, permit, snap, verdict, finishing } =
        await verifyingGoal({
          objective: 'deploy',
          ...(terminalStatus === 'blocked' && {
            evidence: verifierUserEvidenceRecords,
            proposal: blocked('Need approval', 'authority', ['user-evidence']),
          }),
        });
      expect(runtime.beginTurn('real-user')).toBeUndefined();

      if (terminalStatus === 'blocked') {
        verdict.resolve({ decision: 'accept', reason: 'approval required' });
      } else {
        verdict.reject(new Error('provider unavailable'));
      }
      await finishing;
      expect(snap().goal?.status).toBe(terminalStatus);
      await control(runtime, 'resume', permit);

      expect(runtime.permitForTurn('real-user')).toBeDefined();
      expect(host.started).toHaveLength(1);
      expect(snap().activity).toBe('running');
    },
  );

  it.each([
    ['releases a queued user reservation before it is promoted', false],
    ['releases a promoted user reservation and resumes autonomously', true],
  ])('%s', async (_title, promoted) => {
    const { host, runtime, permit } = await startGoal();

    expect(runtime.beginTurn('queued-user')).toBeUndefined();
    if (promoted) {
      await runtime.finishTurn(permit);
      expect(runtime.permitForTurn('queued-user')).toBeDefined();
    }
    await expect(runtime.releaseTurn('queued-user')).resolves.toBe(true);
    if (!promoted) await runtime.finishTurn(permit);

    expect(runtime.permitForTurn('queued-user')).toBeUndefined();
    expect(host.started).toHaveLength(2);
    expectState(runtime, 'running', { status: 'active', turnCount: 1 });
  });

  it('promotes a waiting reservation when the current turn is released', async () => {
    // The host drains continuations one at a time and `queued-user` blocks
    // that drain, so a fresh continuation would leave the reservation waiting
    // on a turn that can never start. `finishTurn` promotes likewise.
    const { host, runtime, permit } = await startGoal();

    expect(runtime.beginTurn('queued-user')).toBeUndefined();
    await expect(runtime.releaseTurn(turnKey(permit))).resolves.toBe(true);

    expect(runtime.permitForTurn('queued-user')).toBeDefined();
    expect(host.started).toHaveLength(1);
    expectState(runtime, 'running', { status: 'active' });
  });

  it('releases a turn without restarting after a requested pause cannot persist', async () => {
    const writerLost = new Error('writer lost');
    const { host, runtime, permit } = await startGoal({
      journal: failingJournal(1, writerLost),
    });

    await expect(control(runtime, 'pause', permit)).rejects.toMatchObject({
      cause: writerLost,
    });
    await expect(
      runtime.releaseTurn(turnKey(permit), { requeue: false }),
    ).resolves.toBe(true);

    expect(host.started).toHaveLength(1);
    expectState(runtime, 'idle', { status: 'active' });
  });

  it('serializes reservation release behind an in-flight turn commit', async () => {
    let blockTurnFinish = false;
    const { journal, reached, release } = gatedJournal(() => blockTurnFinish);
    const { host, runtime, permit } = await startGoal({ journal });
    expect(runtime.beginTurn('queued-user')).toBeUndefined();

    blockTurnFinish = true;
    const finishing = runtime.finishTurn(permit);
    await reached;
    const releasing = runtime.releaseTurn('queued-user');
    release();
    await Promise.all([finishing, releasing]);

    expect(runtime.permitForTurn('queued-user')).toBeUndefined();
    expect(host.started).toHaveLength(2);
    expectState(runtime, 'running', { status: 'active', turnCount: 1 });
  });

  it('ignores an in-flight accept after edit changes the revision', async () => {
    const { journal, runtime, permit, snap, verdict, finishing } =
      await verifyingGoal({ objective: 'first' });

    await edit(runtime, permit, 'second');
    verdict.resolve({ decision: 'accept', reason: 'Old evidence' });
    await finishing;

    expect(snap()).toMatchObject({
      goal: { goalId: permit.goalId, revision: 2, status: 'active' },
    });
    expectCauses(journal, 'create turn_finished edit');
  });

  it('does not revive an aborted verifier result after pause and resume', async () => {
    const { journal, host, runtime, permit, verdict, finishing } =
      await verifyingGoal();

    await control(runtime, 'pause', permit);
    await control(runtime, 'resume', permit);
    verdict.reject(new Error('late provider failure'));
    await finishing;

    expectState(runtime, 'running', {
      revision: permit.revision,
      status: 'active',
    });
    expectCauses(journal, 'create turn_finished pause resume');
    expect(host.started).toHaveLength(2);
  });

  it('does not commit a verifier result after disposal during outcome persistence', async () => {
    const outcomeAppend = deferred<void>();
    let appendCount = 0;
    const { journal, runtime, permit } = await startVerifiedGoal({
      journal: fakeGoalJournal({
        beforeAppend: async () => {
          appendCount += 1;
          if (appendCount === 3) await outcomeAppend.promise;
        },
      }),
      verifier: accepting('verified'),
      objective: 'ship',
      proposal: delivered('Done'),
    });

    const finishing = runtime.finishTurn(permit);
    await vi.waitFor(() => expect(appendCount).toBe(3));
    runtime.dispose();
    outcomeAppend.resolve();
    await finishing;

    expectCauses(journal, 'create turn_finished verifier_accept');
    expect(journal.appended.at(-1)?.snapshot.goal?.status).toBe('active');
    expectState(runtime, 'verifying', { status: 'active' });
  });

  it.each([
    ['verifier_accept', 2, 'accept'],
    ['complete', 3, 'accept'],
    ['verifier_reject', 2, 'reject'],
    ['usage_limited', 2, 'usage'],
  ] as const)(
    'keeps verifying and does not continue when %s persistence fails',
    async (_cause, index, outcome) => {
      const { host, runtime, permit, evidenceSource } = await startVerifiedGoal(
        {
          journal: failingJournal(index, new Error('outcome write failed')),
          verifier:
            outcome === 'reject'
              ? rejecting('not enough evidence')
              : accepting('verified'),
          objective: 'ship',
          proposal: delivered('Done'),
        },
      );
      if (outcome === 'usage') {
        evidenceSource.flush.mockRejectedValueOnce(new Error('source failed'));
      }

      await expect(runtime.finishTurn(permit)).rejects.toThrow(
        'outcome write failed',
      );

      expectState(runtime, 'verifying', { status: 'active' });
      expect(host.started).toHaveLength(1);
    },
  );

  it('returns the worker view without reading the transcript', async () => {
    const { runtime, permit, evidenceSource, goal } = await startVerifiedGoal({
      objective: 'ship',
    });

    const view = await runtime.getGoalForWorker(permit);

    expect(evidenceSource.flush).not.toHaveBeenCalled();
    expect(evidenceSource.readActiveTranscriptChain).not.toHaveBeenCalled();
    expect(view).toEqual({
      goalId: permit.goalId,
      revision: permit.revision,
      objective: 'ship',
      evidenceCursor: goal()!.evidenceCursor,
    });
    expect(view).not.toHaveProperty('evidenceCatalog');
  });

  it.each(['accept', 'reject', 'usage_limited'] as const)(
    'counts active verifier time before committing %s',
    (outcome) =>
      withFakeDate(1_000, async () => {
        const flushGate = deferred<void>();
        const { journal, runtime, permit, evidenceSource, goal } =
          await startVerifiedGoal({
            verifier:
              outcome === 'reject' ? rejecting('retry') : accepting('verified'),
            objective: 'ship',
            proposal: delivered('Done'),
          });
        evidenceSource.flush.mockImplementationOnce(() => flushGate.promise);

        vi.setSystemTime(2_000);
        const finishing = runtime.finishTurn(permit);
        await tick();
        expect(goal()?.activeTimeMs).toBe(1_000);
        vi.setSystemTime(5_000);
        if (outcome === 'usage_limited') {
          flushGate.reject(new Error('source unavailable'));
        } else {
          flushGate.resolve();
        }
        await finishing;

        expect(goal()?.activeTimeMs).toBe(4_000);
        expect(journal.appended.at(-1)?.snapshot.goal?.activeTimeMs).toBe(
          4_000,
        );
      }),
  );

  it('publishes one continuation snapshot after verifier rejection', async () => {
    const { host, runtime, verdict, finishing } = await verifyingGoal();
    // Subscribed once the verifier is running: only what the rejection
    // publishes is observed.
    const observed = recordSnapshots(runtime);

    verdict.resolve({ decision: 'reject', reason: 'retry' });
    await finishing;

    expect(host.started).toHaveLength(2);
    expect(host.inputs[1]?.verifierFeedback).toBe('retry');
    expect(observed).toHaveLength(1);
    expect(observed[0]?.activity).toBe('running');
  });

  it('continues beyond the former fixed continuation limit', async () => {
    const { journal, host, runtime } = await startGoal({
      objective: 'loop forever',
    });

    const turns = FORMER_GOAL_CONTINUATION_LIMIT + 25;
    for (let i = 0; i < turns; i++) {
      const permit = host.started[host.started.length - 1];
      expect(permit).toBeDefined();
      await runtime.finishTurn(permit);
    }

    expect(host.started).toHaveLength(turns + 1);
    expectState(runtime, 'running', { status: 'active', turnCount: turns });
    expect(
      causesOf(journal).filter((cause) => cause === 'usage_limited'),
    ).toHaveLength(0);
  });

  it('resumes persisted state at the former limit without resetting its turn count', async () => {
    const { host, runtime } = await startGoal({ objective: null });
    await runtime.restore([
      goalRecord(
        {
          objective: 'keep going',
          status: 'usage_limited',
          evidenceCursor: { recordId: 'limit-record' },
          turnCount: FORMER_GOAL_CONTINUATION_LIMIT,
          activeTimeMs: 1_000,
        },
        'usage_limited',
      ),
    ]);

    const resumed = await control(runtime, 'resume', G1);

    expect(resumed.snapshot).toMatchObject({
      activity: 'running',
      goal: { status: 'active', turnCount: FORMER_GOAL_CONTINUATION_LIMIT },
    });
    expect(host.started).toHaveLength(1);
    await runtime.finishTurn(host.started[0]);
    expectState(runtime, 'running', {
      status: 'active',
      turnCount: FORMER_GOAL_CONTINUATION_LIMIT + 1,
    });
  });

  it('keeps verification live when a pausing lifecycle append fails', async () => {
    const { runtime, permit, snap, verdict, finishing } = await verifyingGoal({
      journal: failingJournal(2, new Error('pause write failed')),
    });

    await expect(control(runtime, 'pause', permit)).rejects.toThrow(
      'pause write failed',
    );
    expect(snap().activity).toBe('verifying');
    verdict.resolve({ decision: 'accept', reason: 'verified' });
    await finishing;

    expect(snap().goal?.status).toBe('complete');
  });

  it('does not mutate or broadcast when lifecycle persistence fails', async () => {
    const journal = fakeGoalJournal({ appendError: new Error('disk full') });
    const runtime = createGoalRuntime({ journal });
    const observed = recordSnapshots(runtime);

    await expect(create(runtime, 'ship it')).rejects.toThrow('disk full');

    expect(runtime.getSnapshot()).toEqual(NO_GOAL);
    expect(observed).toEqual([]);
    expect(vi.isMockFunction(journal.recordGoalState)).toBe(false);
  });

  it('reports a lost session writer as GoalPersistenceUnavailableError', async () => {
    // The journal rejects a lost writer with its own error type, but callers
    // key the "no persistence, so no goal" degradation off this class: a raw
    // writer error escaping `clear` fails ACP `/goal clear` prompts for good.
    class SessionWriterUnavailableError extends Error {
      constructor() {
        super('Session writer is unavailable');
        this.name = 'SessionWriterUnavailableError';
      }
    }
    const writerLost = new SessionWriterUnavailableError();
    const { runtime, goal } = await startGoal({
      journal: failingJournal(1, writerLost),
      bind: false,
      objective: 'ship it',
    });
    const current = goal()!;

    const clearing = control(runtime, 'clear', current);

    await expect(clearing).rejects.toBeInstanceOf(
      GoalPersistenceUnavailableError,
    );
    await expect(clearing).rejects.toMatchObject({
      message: 'Session writer is unavailable',
      cause: writerLost,
    });
    // The failed write must not be mistaken for a committed clear.
    expect(goal()?.goalId).toBe(current.goalId);
  });

  it('publishes a lifecycle cause only after its append commits', async () => {
    const { journal, release } = gatedJournal();
    const { runtime } = await startGoal({ journal, objective: null });
    const causes = recordCauses(runtime);
    const snapshots = recordSnapshots(runtime);

    const creating = create(runtime);
    await Promise.resolve();

    expect(causes).toEqual([]);
    release();
    await creating;

    expect(causes).toEqual(['create', undefined]);
    expect(snapshots.map(({ activity }) => activity)).toEqual([
      'idle',
      'running',
    ]);
  });

  it('publishes the recovered record cause after restore commits', async () => {
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    const observed = recordCauses(runtime);

    await runtime.restore([goalRecord()]);

    expect(observed).toEqual(['pause']);
  });

  it('marks only the restore broadcast as a replay', async () => {
    // The restore broadcast carries the record's cause; unmarked, a subscriber
    // counting transitions would recount the recovered `pause` on every resume.
    const { runtime } = await startGoal({ objective: null });
    const observed: Array<{
      cause: GoalStateCause | undefined;
      meta: GoalBroadcastMeta | undefined;
    }> = [];
    runtime.subscribe((_snapshot, cause, meta) =>
      observed.push({ cause, meta }),
    );

    await runtime.restore([goalRecord()]);
    await control(runtime, 'resume', G1);

    expect(observed[0]).toEqual({ cause: 'pause', meta: { replayed: true } });
    const live = observed.slice(1);
    expect(live.map(({ cause }) => cause)).toContain('resume');
    expect(live.every(({ meta }) => meta === undefined)).toBe(true);
  });

  it('resumes an idle stopped goal exactly once', async () => {
    const { host, runtime } = await startGoal(BARE);
    await runtime.restore([goalRecord()]);
    runtime.bindHost(host);

    await control(runtime, 'resume', G1);

    expect(host.started).toHaveLength(1);
  });

  it('broadcasts a restored v2 snapshot to existing subscribers', async () => {
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    const observed = recordSnapshots(runtime);
    const restoredSnapshot = goalSnapshot();

    await runtime.restore([goalStateRecord(restoredSnapshot)]);

    expect(observed).toEqual([restoredSnapshot]);
  });

  it('preempts and admits an active create only after persistence commits', async () => {
    const { journal, release } = gatedJournal();
    const { host, runtime } = await startGoal({ journal, objective: null });

    const creating = create(runtime);
    await Promise.resolve();

    expect(host.preemptGoalTurn).not.toHaveBeenCalled();
    expect(host.started).toEqual([]);

    release();
    await creating;

    expect(host.preemptGoalTurn).toHaveBeenCalledOnce();
    expect(host.started).toHaveLength(1);
  });

  it('preempts and invalidates an in-flight turn when paused', async () => {
    const { journal, host, runtime, permit, goal } = await startGoal();
    const evidenceCursor = goal()?.evidenceCursor;
    vi.mocked(host.preemptGoalTurn).mockClear();

    await control(runtime, 'pause', permit);
    await expect(runtime.finishTurn(permit)).rejects.toThrow(STALE_PERMIT);

    expect(host.preemptGoalTurn).toHaveBeenCalledOnce();
    expect(host.started).toHaveLength(1);
    expectState(runtime, 'idle', {
      status: 'paused',
      revision: 1,
      turnCount: 0,
      evidenceCursor,
    });
    expectCauses(journal, 'create pause');
  });

  it('resumes with a new permit after pause invalidates the running turn', async () => {
    const { host, runtime, snap } = await startGoal({ objective: null });
    const observed = recordSnapshots(runtime);
    await create(runtime);
    const permit = host.started[0];

    expect(
      runtime.recordTerminalProposal(permit, complete('done', ['e-1'])),
    ).toMatchObject({ recorded: true });
    expect(
      runtime.recordTerminalProposal(
        permit,
        blocked('duplicate', undefined, []),
      ),
    ).toMatchObject({ recorded: false });

    await control(runtime, 'pause', permit);
    expect(snap().activity).toBe('idle');
    await control(runtime, 'resume', permit);
    expect(snap().activity).toBe('running');
    expect(host.started).toHaveLength(2);
    const resumedPermit = host.started[1];
    expect(resumedPermit).not.toEqual(permit);
    await control(runtime, 'pause', resumedPermit);

    expect(host.started).toHaveLength(2);
    expect(snap().activity).toBe('idle');
    expect(observed.at(-1)?.activity).toBe('idle');
    expect(observed.some((value) => value.activity === 'verifying')).toBe(
      false,
    );
  });

  it('journals a pause reason and schedules no continuation after it', async () => {
    const { journal, host, runtime, permit, goal } = await startGoal();

    await control(runtime, 'pause', permit, {
      reason: 'Interrupted by the user.',
    });

    const paused = journal.appended.at(-1);
    expect(paused?.cause).toBe('pause');
    expect(paused?.snapshot.goal?.status).toBe('paused');
    expect(paused?.snapshot.goal?.lastReason).toBe('Interrupted by the user.');
    expect(goal()?.lastReason).toBe('Interrupted by the user.');

    // A release arriving after the pause -- the host settling the turn the
    // user just interrupted -- must not restart the loop behind their back.
    await runtime.releaseTurn(turnKey(permit));
    expect(host.started).toHaveLength(1);
    expect(goal()?.status).toBe('paused');
  });

  it('lets ordinary user input claim the queued slot before continuation and reuses its permit', async () => {
    const { host, runtime, permit: automaticPermit, snap } = await startGoal();

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
    expect(snap().activity).toBe('running');
  });

  it('invalidates an old permit before broadcasting an objective change', async () => {
    const { host, runtime, permit } = await startGoal({ objective: 'first' });
    let listenerError: unknown;
    let lateAccepted = false;
    runtime.subscribe((value) => {
      if (value.goal?.revision !== 2) return;
      try {
        lateAccepted = runtime.recordTerminalProposal(
          permit,
          complete('late', []),
        ).recorded;
      } catch (error) {
        listenerError = error;
      }
    });

    await edit(runtime, permit, 'second');

    expect(listenerError).toEqual(
      expect.objectContaining({ message: STALE_PERMIT }),
    );
    expect(lateAccepted).toBe(false);
    expect(host.started).toHaveLength(2);
  });

  it('preempts the permit-owning host when a subscriber rebinds during broadcast', async () => {
    const newHost = fakeGoalTurnHost();
    const started = await startGoal({ objective: 'first' });
    const { host: oldHost, runtime, permit } = started;
    vi.mocked(oldHost.preemptGoalTurn).mockClear();
    runtime.subscribe((snapshot) => {
      if (snapshot.goal?.revision === 2) runtime.bindHost(newHost);
    });

    await edit(runtime, { goalId: permit.goalId, revision: 1 }, 'second');

    expect(oldHost.preemptGoalTurn).toHaveBeenCalledOnce();
    expect(newHost.preemptGoalTurn).not.toHaveBeenCalled();
    expect(newHost.started).toHaveLength(1);
  });

  it('preempts the bound host that owns a directly admitted user turn', async () => {
    const newHost = fakeGoalTurnHost();
    const { host: oldHost, runtime } = await startGoal(BARE);
    await runtime.restore([
      freshPaused({
        objective: 'first',
        evidenceCursor: { recordId: 'create-record' },
      }),
    ]);
    runtime.bindHost(oldHost);
    let userPermit: GoalTurnPermit | undefined;
    runtime.subscribe((snapshot) => {
      if (snapshot.goal?.status === 'active' && !userPermit) {
        userPermit = runtime.beginTurn('real-user');
      }
    });
    await control(runtime, 'resume', G1);
    expect(userPermit).toBeDefined();
    runtime.bindHost(newHost);

    await edit(runtime, G1, 'second');

    expect(oldHost.preemptGoalTurn).toHaveBeenCalledOnce();
    expect(newHost.preemptGoalTurn).not.toHaveBeenCalled();
  });

  it('preempts the bound host that owns a promoted queued user turn', async () => {
    const newHost = fakeGoalTurnHost();
    const { host: oldHost, runtime, permit } = await startGoal();
    expect(runtime.beginTurn('real-user')).toBeUndefined();

    await runtime.finishTurn(permit);
    expect(runtime.permitForTurn('real-user')).toBeDefined();
    vi.mocked(oldHost.preemptGoalTurn).mockClear();
    runtime.bindHost(newHost);
    await control(runtime, 'clear', permit);

    expect(oldHost.preemptGoalTurn).toHaveBeenCalledOnce();
    expect(newHost.preemptGoalTurn).not.toHaveBeenCalled();
  });

  it('restores a transcript that predates journaled Goal state with no Goal, and writes nothing', async () => {
    // Builds before #7895 journaled goal_status cards, not state. Those are
    // history: nothing is migrated, nothing is written, nothing starts.
    const { journal, host, runtime } = await startGoal(BARE);

    await runtime.restore([legacyGoalRecord()]);

    expect(runtime.getSnapshot()).toEqual(NO_GOAL);
    expect(runtime.getRecoveryCause?.()).toBeUndefined();
    expect(journal.appended).toEqual([]);
    runtime.bindHost(host);
    await Promise.resolve();
    expect(host.started).toEqual([]);
  });

  it('releases a rejected host start without an unhandled rejection', async () => {
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    await runtime.restore([freshActive()]);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      runtime.bindHost({
        startGoalTurn: vi.fn().mockRejectedValue(new Error('host rejected')),
        preemptGoalTurn: vi.fn(),
      });
      await tick();

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
    const { runtime } = holdingRuntime(failedStart.promise);
    await create(runtime);
    const replacement = fakeGoalTurnHost();
    runtime.bindHost(replacement);

    failedStart.reject(new Error('host rejected'));

    await vi.waitFor(() => expect(replacement.started).toHaveLength(1));
    expect(runtime.getSnapshot().activity).toBe('running');
  });

  it('promotes queued user input before automatic retry after start failure', async () => {
    const failedStart = deferred<void>();
    const { runtime } = holdingRuntime(failedStart.promise);
    await create(runtime);
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
    const { runtime, started } = holdingRuntime(failedStart.promise);
    await create(runtime);
    const rejectedPermit = started[0];
    expectReceipt(
      runtime,
      rejectedPermit,
      complete('stale proposal', ['stale']),
    );
    expect(runtime.beginTurn('real-user')).toBeUndefined();

    failedStart.reject(new Error('host rejected'));
    await vi.waitFor(() =>
      expect(runtime.permitForTurn('real-user')).toBeDefined(),
    );
    const promotedPermit = runtime.permitForTurn('real-user')!;

    expectReceipt(
      runtime,
      promotedPermit,
      complete('fresh proposal', ['fresh']),
    );
    await runtime.finishTurn(promotedPermit);
    expect(runtime.takePendingTerminalProposal()).toEqual({
      permit: promotedPermit,
      proposal: complete('fresh proposal', ['fresh']),
    });
  });

  it('returns defensive worker state and checks the complete permit atomically', async () => {
    const { runtime, permit, goal } = await startGoal();

    const view = await runtime.getGoalForWorker(permit);
    const permittedSnapshot = runtime.getSnapshotForPermit(permit);
    view.objective = 'mutated';
    view.evidenceCursor.recordId = 'mutated';
    permittedSnapshot.goal!.objective = 'mutated snapshot';
    expect(goal()).toMatchObject({
      objective: 'ship',
      evidenceCursor: { recordId: expect.not.stringContaining('mutated') },
    });
    expect(() =>
      runtime.getSnapshotForPermit({ ...permit, turnId: 'different-turn' }),
    ).toThrow(STALE_PERMIT);

    await edit(runtime, permit, 'ship better');
    await expect(runtime.getGoalForWorker(permit)).rejects.toThrow(
      STALE_PERMIT,
    );
    expect(() => runtime.getSnapshotForPermit(permit)).toThrow(STALE_PERMIT);
  });

  it('rejects an oversized proposal reason before consuming the turn proposal slot', async () => {
    const { runtime, permit } = await startGoal();

    expect(() =>
      runtime.recordTerminalProposal(
        permit,
        complete(
          '界'.repeat(Math.floor(GOAL_PROPOSAL_REASON_MAX_BYTES / 3) + 1),
          ['oversized'],
        ),
      ),
    ).toThrow(/UTF-8 bytes/i);
    expectReceipt(runtime, permit, complete('valid reason', ['valid']));
  });

  const waitingForAccess = (blockerKind?: GoalBlockerKind) =>
    blocked('waiting for access', blockerKind, []);
  const sameBlocker = () => blocked('same blocker', 'repeated', []);

  it('normalizes omitted blocker kinds in the repeated audit and resets it on resume', async () => {
    const { host, runtime } = await startGoal();

    for (const blockerKind of [undefined, 'repeated'] as const) {
      const permit = host.started.at(-1)!;
      expectReceipt(runtime, permit, waitingForAccess(blockerKind), false);
      await runtime.finishTurn(permit);
    }

    const thirdPermit = host.started.at(-1)!;
    expectReceipt(runtime, thirdPermit, waitingForAccess());
    await control(runtime, 'pause', thirdPermit);
    await control(runtime, 'resume', thirdPermit);

    const afterResume = host.started.at(-1)!;
    expectReceipt(runtime, afterResume, waitingForAccess('repeated'), false);
  });

  it('restores the repeated blocker audit from the durable Goal state', async () => {
    const { journal, host, runtime } = await startGoal();

    for (let index = 0; index < 2; index += 1) {
      const permit = host.started.at(-1)!;
      runtime.recordTerminalProposal(permit, waitingForAccess('repeated'));
      await runtime.finishTurn(permit);
    }

    const recovered = journal.appended.at(-1)!;
    const { host: restoredHost, runtime: restored } = await startGoal({
      bind: false,
      restore: [
        goalControlRecord('restore-record', null, {
          ...recovered,
          blockedAudit: {
            ...recovered.blockedAudit!,
            fingerprint: '\nwaiting for access',
          },
        }),
      ],
    });
    restored.bindHost(restoredHost);
    await vi.waitFor(() => expect(restoredHost.started).toHaveLength(1));

    expectReceipt(
      restored,
      restoredHost.started[0],
      waitingForAccess('repeated'),
    );
  });

  it('restores and bounds a repeated blocker audit after verifier rejection', async () => {
    const record = goalControlRecord('restore-record', null, {
      v: 2,
      cause: 'verifier_reject',
      snapshot: goalSnapshot({
        goalId: 'g-rejected',
        objective: 'ship',
        status: 'active',
        turnCount: 3,
        activeTimeMs: 0,
      }),
      blockedAudit: {
        fingerprint: 'repeated\nwaiting for access',
        count: 3,
        turnIds: ['turn-1', 'turn-2', 'turn-3'],
      },
    });
    const { journal, host, runtime } = await startGoal(BARE);
    await runtime.restore([record]);
    runtime.bindHost(host);
    await vi.waitFor(() => expect(host.started).toHaveLength(1));

    expectReceipt(runtime, host.started[0], waitingForAccess('repeated'));
    await runtime.finishTurn(host.started[0]);

    expect(journal.appended.at(-1)?.blockedAudit).toMatchObject({
      count: 3,
      turnIds: ['turn-2', 'turn-3', host.started[0].turnId],
    });
  });

  it('does not count a repeated proposal recorded before pause and resume', async () => {
    const { host, runtime, permit: beforeResume } = await startGoal();
    runtime.recordTerminalProposal(beforeResume, sameBlocker());
    await control(runtime, 'pause', beforeResume);
    await control(runtime, 'resume', beforeResume);
    expect(() =>
      runtime.recordTerminalProposal(
        beforeResume,
        complete('second proposal from same permit', []),
      ),
    ).toThrow(STALE_PERMIT);
    await expect(runtime.finishTurn(beforeResume)).rejects.toThrow(
      STALE_PERMIT,
    );
    expect(runtime.takePendingTerminalProposal()).toBeUndefined();

    for (let index = 0; index < 2; index += 1) {
      const permit = host.started.at(-1)!;
      expectReceipt(runtime, permit, sameBlocker(), false);
      await runtime.finishTurn(permit);
    }

    expectReceipt(runtime, host.started.at(-1)!, sameBlocker());
  });

  it('retains an active terminal proposal for verifier handoff without continuing', async () => {
    const { host, runtime, permit, snap } = await startGoal();
    runtime.recordTerminalProposal(permit, complete('done', ['e-1']));

    await runtime.finishTurn(permit);

    expect(snap().activity).toBe('verifying');
    expect(host.started).toHaveLength(1);
    expect(runtime.takePendingTerminalProposal()).toEqual({
      permit,
      proposal: { status: 'complete', reason: 'done', evidenceRefs: ['e-1'] },
    });
    expect(runtime.takePendingTerminalProposal()).toBeUndefined();
  });

  it.each(['authority', 'external'] as const)(
    'admits %s blockers for verification immediately',
    async (blockerKind) => {
      const { host, runtime } = await startGoal(BARE);
      expect(runtime.beginTurn('not-active')).toBeUndefined();

      runtime.bindHost(host);
      await create(runtime);
      expectReceipt(
        runtime,
        host.started[0],
        blocked('maintainer decision required', blockerKind, []),
      );
    },
  );

  it('requires repeated blocker observations to be consecutive active finishes', async () => {
    const { host, runtime } = await startGoal();
    const propose = (permit: GoalTurnPermit) =>
      runtime.recordTerminalProposal(permit, sameBlocker());

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
    const { journal, release } = gatedJournal();
    const runtime = createGoalRuntime({ journal });

    const first = create(runtime, 'first');
    const second = create(runtime, 'second');
    release();
    const created = await first;
    const conflict = await second.catch((error: unknown) => error);

    expect(conflict).toBeInstanceOf(GoalConflictError);
    expect((conflict as GoalConflictError).current).toEqual(created.snapshot);
    expect(journal.appended).toHaveLength(1);
  });

  it('keeps turn state and the dispatch mutex usable when turn persistence fails', async () => {
    const { host, runtime, permit, snap } = await startGoal({
      journal: failingJournal(1, new Error('turn write failed')),
    });
    runtime.recordTerminalProposal(permit, complete('done', []));

    await expect(runtime.finishTurn(permit)).rejects.toThrow(
      'turn write failed',
    );

    expect(snap().activity).toBe('running');
    expect(runtime.permitForTurn(turnKey(permit))).toEqual(permit);
    expect(
      runtime.recordTerminalProposal(permit, complete('duplicate', []))
        .recorded,
    ).toBe(false);
    expect(host.started).toHaveLength(1);

    await runtime.finishTurn(permit);
    expectState(runtime, 'verifying', { turnCount: 1 });
  });

  it('restores active state once while stopped state remains display-only', async () => {
    const activeHost = fakeGoalTurnHost();
    const active = createGoalRuntime({ journal: fakeGoalJournal() });
    await active.restore([freshActive({ goalId: 'g-active' })]);
    active.bindHost(activeHost);
    active.bindHost(fakeGoalTurnHost());
    await vi.waitFor(() => expect(activeHost.started).toHaveLength(1));

    const stoppedHost = fakeGoalTurnHost();
    const stopped = createGoalRuntime({ journal: fakeGoalJournal() });
    await stopped.restore([
      goalRecord({
        goalId: 'g-complete',
        objective: 'ship',
        status: 'complete',
        turnCount: 1,
        activeTimeMs: 1,
      }),
    ]);
    stopped.bindHost(stoppedHost);
    await Promise.resolve();
    expect(stoppedHost.started).toEqual([]);
    expect(stopped.getSnapshot().goal?.status).toBe('complete');
  });

  it('surfaces unsupported recovery without scheduling or fallback', async () => {
    const malformed = goalControlRecord('restore-record', null, { v: 99 });
    const { host, runtime, goal } = await startGoal({ objective: null });

    await expect(runtime.restore([malformed])).rejects.toBeInstanceOf(
      GoalPersistenceUnavailableError,
    );
    await expect(create(runtime, 'must not overwrite')).rejects.toThrow(
      'malformed or uses an unsupported version',
    );
    expect(goal()).toBeNull();
    expect(host.started).toEqual([]);
  });

  it('blocks writes after a failed restore until one succeeds', async () => {
    const { host, runtime, goal } = await startGoal({ objective: null });
    const unreadable = goalControlRecord('restore-record', null, { v: 99 });

    await expect(runtime.restore([unreadable])).rejects.toEqual(
      expect.objectContaining({
        name: 'GoalPersistenceUnavailableError',
        message: expect.stringContaining('unsupported version'),
      }),
    );
    await expect(create(runtime, 'must not overwrite')).rejects.toThrow(
      'unsupported version',
    );
    expect(host.started).toEqual([]);

    await runtime.restore([freshPaused()]);
    expect(goal()).toMatchObject({ objective: 'ship it', status: 'paused' });
  });

  it('treats a record whose blockedAudit does not parse as unreadable, and blocks writes', async () => {
    // `prepareRestore` reads only `parseGoalStateRecordPayloadV2` output, which
    // rejects a record malformed anywhere: no partial record exists to trip
    // over, so a malformed audit is the unsupported case, not an exception.
    const { journal, runtime, goal } = await startGoal({ objective: null });
    const malformedAudit = goalControlRecord('restore-record', null, {
      v: 2,
      cause: 'blocked',
      snapshot: goalSnapshot({
        goalId: 'g-audit',
        revision: 3,
        evidenceCursor: { recordId: 'restore-record' },
        turnCount: 3,
        activeTimeMs: 0,
        updatedAt: 1,
      }),
      blockedAudit: { fingerprint: 42, count: 3, turnIds: ['t1'] },
    });

    await expect(runtime.restore([malformedAudit])).rejects.toThrow(
      GoalPersistenceUnavailableError,
    );
    await expect(create(runtime, 'must not overwrite')).rejects.toThrow(
      GoalPersistenceUnavailableError,
    );
    expect(goal()).toBeNull();
    expect(journal.appended).toEqual([]);
  });

  it('refuses a restore preparation that was still queued when the runtime was disposed', async () => {
    // A restore writes nothing but queues behind the runtime's work; disposal
    // while it waits must reach it before it commits anything.
    const { journal, release } = gatedJournal();
    const runtime = createGoalRuntime({ journal });
    const creating = create(runtime, 'hold the queue');
    const preparing = runtime.prepareRestore([
      freshPaused({ goalId: 'g-queued', objective: 'queued restore' }),
    ]);

    await Promise.resolve();
    runtime.dispose();
    release();

    await creating.catch(() => undefined);
    await expect(preparing).rejects.toThrow('Goal runtime has been disposed');
    await expect(runtime.activateRestoredWork()).rejects.toThrow(
      'Goal runtime has been disposed',
    );
    expect(runtime.getSnapshot().goal?.objective).not.toBe('queued restore');
  });

  it('prepares an active restore without broadcasting or starting work', async () => {
    const { host, runtime, goal } = await startGoal({ objective: null });
    const listener = vi.fn();
    runtime.subscribe(listener);
    const record = goalRecord({
      goalId: 'g-selective',
      objective: 'resume selectively',
      status: 'active',
      evidenceCursor: { recordId: 'restore-record' },
      turnCount: 1,
    });

    await runtime.prepareRestore([record]);

    expect(goal()?.status).toBe('active');
    expect(listener).not.toHaveBeenCalled();
    expect(host.started).toEqual([]);

    await runtime.activateRestoredWork();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(host.started).toHaveLength(1);
  });

  it('does not charge offline time to a restored active Goal', () =>
    withFakeDate(43_201_000, async () => {
      const { host, runtime, goal } = await startGoal({ objective: null });
      const record = goalRecord({
        goalId: 'g-restored-time-budget',
        objective: 'resume without charging offline time',
        status: 'active',
        evidenceCursor: { recordId: 'restore-record' },
        turnCount: 1,
        activeTimeMs: 10_000,
        activeTimeBudgetMs: 60_000,
        createdAt: 1_000,
        updatedAt: 1_000,
      });

      await runtime.prepareRestore([record]);
      expect(goal()).toMatchObject({
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
      expect(goal()?.status).toBe('active');
    }));

  it('coalesces preparation and activation and rejects activation before preparation', async () => {
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    await expect(runtime.activateRestoredWork()).rejects.toThrow(
      'preparation has not started',
    );
    const record = goalStateRecord({ v: 2, activity: 'idle', goal: null });

    const firstPreparation = runtime.prepareRestore([record]);
    const secondPreparation = runtime.prepareRestore([record]);
    await Promise.all([firstPreparation, secondPreparation]);
    const firstActivation = runtime.activateRestoredWork();
    const secondActivation = runtime.activateRestoredWork();

    await expect(
      Promise.all([firstActivation, secondActivation]),
    ).resolves.toEqual([undefined, undefined]);
  });

  it('commits a restored paused Goal before a reentrant resume', async () => {
    const { host, runtime, goal } = await startGoal(BARE);
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
      reentrantDispatch = control(runtime, 'resume', snapshot.goal);
    });

    await runtime.restore([freshPaused()]);
    await reentrantDispatch;

    expect(bindError).toBeUndefined();
    expect(host.started).toHaveLength(1);
    expect(goal()?.status).toBe('active');
  });

  it('preempts replace and clear after commit and admits only active replacements', async () => {
    const { host, runtime, permit, goal } = await startGoal({ objective: 'a' });
    vi.mocked(host.preemptGoalTurn).mockClear();
    const replaced = await edit(runtime, permit, 'b', 'replace');
    expect(replaced.snapshot.goal).toMatchObject({
      revision: 1,
      objective: 'b',
    });
    expect(host.preemptGoalTurn).toHaveBeenCalledOnce();
    expect(host.started).toHaveLength(2);

    vi.mocked(host.preemptGoalTurn).mockClear();
    await control(runtime, 'clear', replaced.snapshot.goal!);
    expect(host.preemptGoalTurn).toHaveBeenCalledOnce();
    expect(host.started).toHaveLength(2);
    expect(goal()).toBeNull();
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

    const response = await create(runtime, 'original');
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
    const { host, runtime } = await startGoal({ objective: null });
    runtime.subscribe(() => {
      throw new Error('listener failed');
    });

    await expect(create(runtime)).resolves.toBeDefined();
    expect(host.started).toHaveLength(1);
  });

  it('does not hold the writer mutex while the host owns a running turn', async () => {
    const hostTurn = deferred<void>();
    const { runtime, started } = holdingRuntime(hostTurn.promise);
    let dispatchSettled = false;
    const creating = create(runtime).then(() => {
      dispatchSettled = true;
    });

    await tick();
    expect(started).toHaveLength(1);
    expect(dispatchSettled).toBe(true);

    hostTurn.resolve();
    await creating;
  });

  it('keeps real user input queued while a terminal proposal is verifying', async () => {
    const { runtime, permit, snap } = await startGoal();
    runtime.recordTerminalProposal(permit, complete('done', []));
    await runtime.finishTurn(permit);

    expect(runtime.beginTurn('real-user-during-verification')).toBeUndefined();
    expect(snap().activity).toBe('verifying');
    const replacementHost = fakeGoalTurnHost();
    runtime.bindHost(replacementHost);
    await Promise.resolve();
    expect(replacementHost.started).toEqual([]);
    expect(runtime.takePendingTerminalProposal()).toBeDefined();
    expect(runtime.takePendingTerminalProposal()).toBeUndefined();
  });

  it('cancels pending verification on pause and resumes exactly once', async () => {
    const { host, runtime, permit } = await startGoal();
    runtime.recordTerminalProposal(permit, complete('done', []));
    await runtime.finishTurn(permit);

    await control(runtime, 'pause', permit);
    expectState(runtime, 'idle', { status: 'paused' });
    expect(runtime.takePendingTerminalProposal()).toBeUndefined();

    await control(runtime, 'resume', permit);
    expect(host.started).toHaveLength(2);
  });

  it('does not let host preemption failures break committed lifecycle state', async () => {
    const { runtime, started } = holdingRuntime(undefined, () => {
      throw new Error('preempt failed');
    });

    await expect(create(runtime)).resolves.toBeDefined();
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

    await expect(create(runtime)).resolves.toBeDefined();
    await tick();
    expect(runtime.getSnapshot().activity).toBe('idle');
  });

  describe('objective-updated notice', () => {
    const flagsOf = (host: ReturnType<typeof fakeGoalTurnHost>) =>
      host.inputs.map((input) => input.objectiveUpdated ?? false);

    // Create, deliver the first continuation, edit to `ship the rest`;
    // `refuse` makes the host refuse the edit's continuation.
    async function editedGoal(refuse?: Error) {
      const started = await startGoal();
      await finishDelivered(started.runtime, started.permit);
      if (refuse) started.host.failures.push(refuse);
      await edit(started.runtime, started.permit, 'ship the rest');
      return started;
    }

    it('stays off for a Goal whose objective never changed', async () => {
      const started = await startGoal();
      await finishDeliveredTurns(started, 2);

      // Including the very first continuation: a new Goal supersedes nothing.
      expect(flagsOf(started.host)).toEqual([false, false, false]);
    });

    it('fires once after an edit, then goes quiet again', async () => {
      const { host, runtime } = await editedGoal();
      await finishDelivered(runtime, host.started.at(-1)!);

      // create, continuation, edit -> notice, next continuation -> quiet.
      expect(flagsOf(host)).toEqual([false, false, true, false]);
      expect(host.inputs.at(-2)?.continuationContext).toBe('ship the rest');
    });

    it('fires after a replace, which supersedes a different Goal entirely', async () => {
      const { host, runtime, permit, goal } = await startGoal();
      await finishDelivered(runtime, permit);
      await edit(runtime, goal()!, 'ship something else', 'replace');

      // The new Goal is revision 1 like a fresh create, so the notice cannot
      // key on the revision alone -- what changed is the objective, which the
      // replaced Goal's finished turn handed to the model.
      expect(goal()).toMatchObject({ revision: 1 });
      expect(flagsOf(host)).toEqual([false, false, true]);
    });

    it('stays off across pause and resume, which change no objective', async () => {
      const { host, runtime, permit } = await startGoal();
      await runtime.releaseTurn(turnKey(permit));
      await control(runtime, 'pause', permit);
      await control(runtime, 'resume', permit);

      expect(flagsOf(host).some(Boolean)).toBe(false);
    });

    it('redelivers the notice when the host never took the prompt', async () => {
      // The host refused the edit's continuation, so its notice never reached
      // the model; marking it announced there would drop it for good.
      const { host, runtime } = await editedGoal(
        new Error('host is not accepting turns'),
      );
      await tick();
      runtime.bindHost(host);
      await tick();

      expect(host.inputs.at(-1)?.objectiveUpdated).toBe(true);
      expect(host.inputs.at(-1)?.continuationContext).toBe('ship the rest');
    });

    it('redelivers the notice when an accepted turn is dropped before delivery', async () => {
      const { host, runtime } = await editedGoal();

      // The host accepted (queued) the notice-carrying continuation, then
      // dropped it unseen (TUI Escape, ACP cancelPendingPrompt). Its
      // replacement has the same (goalId, revision), so the notice is owed.
      expect(host.inputs.at(-1)?.objectiveUpdated).toBe(true);
      await runtime.releaseTurn(turnKey(host.started.at(-1)!));

      expect(host.inputs.at(-1)?.objectiveUpdated).toBe(true);
      expect(host.inputs.at(-1)?.continuationContext).toBe('ship the rest');
    });

    it('stays quiet when the dropped notice was carried back by its replacement', async () => {
      const { host, runtime } = await editedGoal();
      await runtime.releaseTurn(turnKey(host.started.at(-1)!));
      await finishDelivered(runtime, host.started.at(-1)!);

      // The redelivered notice landed; the continuation after it is quiet.
      expect(flagsOf(host)).toEqual([false, false, true, true, false]);
    });

    it('does not fire for a Goal that replaced one never handed to the model', async () => {
      const { host, runtime, goal } = await startGoal();

      // The create's continuation sat accepted-but-undelivered when replace
      // superseded it: the model never received the old objective, so the
      // new Goal's first continuation cannot claim it replaces one.
      await edit(runtime, goal()!, 'ship something else', 'replace');

      expect(goal()).toMatchObject({ revision: 1 });
      expect(flagsOf(host)).toEqual([false, false]);
    });

    it('does not fire for a delivered turn that settles through releaseTurn', async () => {
      // The ACP degraded-persistence fallback settles a model-started turn
      // with releaseTurn. That turn WAS delivered, so its announcement must
      // stand instead of rolling back and re-firing on the next continuation.
      const { host, runtime } = await editedGoal();
      const deliveredTurn = host.started.at(-1)!;
      runtime.markTurnDelivered(turnKey(deliveredTurn));

      await runtime.releaseTurn(turnKey(deliveredTurn));

      expect(host.inputs.at(-1)?.objectiveUpdated).toBeFalsy();
    });

    it('keeps the announcement of a delivered turn across a mid-turn pause', async () => {
      const { host, runtime, goal } = await editedGoal();
      runtime.markTurnDelivered(turnKey(host.started.at(-1)!));
      await control(runtime, 'pause', goal()!);
      await control(runtime, 'resume', goal()!);

      // The pause interrupted a turn that already handed the model the new
      // objective; resuming it changes nothing the notice could assert.
      expect(host.inputs.at(-1)?.objectiveUpdated).toBeFalsy();
    });

    it('stays off for a Goal created after a cleared one', async () => {
      const { host, runtime, permit } = await startGoal();
      await finishDelivered(runtime, permit);
      await control(runtime, 'clear', permit);
      await create(runtime, 'do something else');

      // The first continuation of a fresh Goal supersedes nothing, even when
      // an earlier Goal announced an objective in this session.
      expect(flagsOf(host)).toEqual([false, false, false]);
    });

    it('stays off for a Goal that replaces a verifier-accepted one', async () => {
      const { host, runtime, permit } = await startVerifiedGoal({
        verifier: accepting('Evidence satisfies the objective'),
        proposal: delivered(),
      });
      await finishDelivered(runtime, permit);

      // Replace directly over the completed Goal (no clear in between), so
      // only the accept-time reset keeps the old announcement from firing:
      // nothing was swapped out mid-work, so the new first turn has no notice.
      await edit(runtime, permit, 'next goal', 'replace');

      expect(host.inputs.at(-1)?.objectiveUpdated).toBeFalsy();
    });

    it("does not leak a refused turn's announcement into a promoted user turn", async () => {
      // The edit's continuation is refused by the host; a user turn queued
      // behind it is promoted by the failure settlement. The refused turn's
      // announcement must not ride along into that user turn.
      const { host, runtime, goal } = await editedGoal(
        new Error('host is not accepting turns'),
      );
      runtime.beginTurn('user-turn-1');
      await tick();
      const userPermit = runtime.permitForTurn('user-turn-1');
      expect(userPermit).toBeDefined();
      await finishDelivered(runtime, userPermit!);
      runtime.bindHost(host);

      // Editing back to the original text hands the model nothing new.
      await edit(runtime, goal()!, 'ship');

      expect(host.inputs.at(-1)?.objectiveUpdated).toBeFalsy();
      expect(host.inputs.at(-1)?.continuationContext).toBe('ship');
    });

    it('stays off for edits that leave the objective text unchanged', async () => {
      const { host, runtime, permit, goal } = await startGoal();
      await finishDelivered(runtime, permit);

      await edit(runtime, goal()!, 'ship');
      await edit(runtime, goal()!, ' ship ');

      // Both edits bumped the revision, but the objective the model is handed
      // is byte-identical to the one it already has: no change, no notice.
      expect(flagsOf(host)).toEqual([false, false, false, false]);

      await edit(runtime, goal()!, 'ship the rest');
      expect(host.inputs.at(-1)?.objectiveUpdated).toBe(true);
    });

    it('keeps the notice owed when a turn finishes under the permit without the prompt', async () => {
      // A system message or direct user query can claim a queued permit and
      // send its own text; the turn finishes without the continuation prompt.
      // Finishing is not delivery: the next continuation still owes it.
      const { host, runtime } = await editedGoal();

      await runtime.finishTurn(host.started.at(-1)!);

      expect(flagsOf(host)).toEqual([false, false, true, true]);
    });

    it('ignores a delivery mark carrying a stale turn key', async () => {
      // A mark for an earlier turn must not flip the in-flight one to
      // delivered, or a release would commit an unreceived announcement.
      const { host, runtime, permit: first } = await editedGoal();
      const inFlight = host.started.at(-1)!;

      runtime.markTurnDelivered(turnKey(first));
      await runtime.releaseTurn(turnKey(inFlight));

      expect(flagsOf(host)).toEqual([false, false, true, true]);
    });

    it('fires after an edit made while the Goal was blocked', async () => {
      // A blocked Goal is suspended, not ended: the model still holds the
      // objective it was given, so an edit followed by resume is exactly
      // the change the notice exists for -- same as pause -> edit -> resume.
      const { host, runtime, permit, goal } = await startVerifiedGoal({
        verifier: accepting('User authority is required'),
        evidence: verifierUserEvidenceRecords,
        proposal: blocked('Needs sign-off', 'authority', ['user-evidence']),
      });
      await finishDelivered(runtime, permit);
      expect(goal()?.status).toBe('blocked');

      await edit(runtime, permit, 'deliver the other result');
      await control(runtime, 'resume', goal()!);

      expect(host.inputs.at(-1)?.objectiveUpdated).toBe(true);
    });

    it('stays off for a Goal created after a completed one was cleared', async () => {
      const { host, runtime, permit, goal } = await startVerifiedGoal({
        verifier: accepting('Evidence satisfies the objective'),
        proposal: delivered(),
      });
      await finishDelivered(runtime, permit);
      expect(goal()?.status).toBe('complete');

      await control(runtime, 'clear', permit);
      await create(runtime, 'next goal');

      expect(host.inputs.at(-1)?.objectiveUpdated).toBeFalsy();
    });
  });

  describe('continuation usage figures', () => {
    it('hands the host the spend the record held when the turn was scheduled', async () => {
      const { host, finishWith } = await startGoal({
        spend: 'peek',
        tokenBudgetGrant: 30_000,
      });

      // The first continuation is scheduled before anything has been billed.
      expect(host.inputs[0]?.usage).toEqual({
        tokensUsed: 0,
        tokenBudget: 30_000,
        turnCount: 0,
      });

      await finishWith(host.started[0]!, 2_500);

      expect(host.inputs[1]?.usage).toEqual({
        tokensUsed: 2_500,
        tokenBudget: 30_000,
        turnCount: 1,
      });
    });

    it('omits the ceiling for a Goal that has none', async () => {
      const { host } = await startGoal(UNBOUNDED);

      expect(host.inputs[0]?.usage).toEqual({ tokensUsed: 0, turnCount: 0 });
    });

    it('carries the figures into the wind-down hand-off', async () => {
      // The hand-off reports where the Goal stopped, so it needs the numbers
      // even though it is told not to start new work.
      const { host, finishWith } = await budgetGoal('peek');

      await finishWith(host.started[0]!, 1_500);

      expect(host.inputs[1]).toMatchObject({ windDown: true });
      expect(host.inputs[1]?.usage).toEqual({
        tokensUsed: 1_500,
        tokenBudget: 1_000,
        turnCount: 1,
      });
    });
  });

  describe('no-progress bound', () => {
    // startGoal with a peeking spend ledger that also counts (and consumes)
    // tool results per turn; `count` makes that count absent, throw or NaN.
    async function noProgressGoal({
      count,
      ...options
    }: StartOptions & { count?: 'absent' | 'throws' | 'NaN' } = {}) {
      const toolResults = new Map<string, number>();
      const { spend, ledger } = spendLedger();
      const takeGoalTurnToolResults = (turnId: string) => {
        if (count === 'throws') throw new Error('ledger unavailable');
        if (count === 'NaN') return Number.NaN;
        const results = toolResults.get(turnId) ?? 0;
        toolResults.delete(turnId);
        return results;
      };
      const started = await startGoal({
        ...options,
        ledger:
          count === 'absent' ? ledger : { ...ledger, takeGoalTurnToolResults },
      });
      return { ...started, toolResults, spend };
    }

    it('pauses a Goal whose autonomous turns record nothing to judge', async () => {
      const started = await noProgressGoal({ objective: null });
      const { journal, host, runtime, goal } = started;
      const causes = recordCauses(runtime);
      await create(runtime);

      await finishDeliveredTurns(started);

      expect(goal()).toMatchObject({
        status: 'paused',
        noProgressTurns: GOAL_NO_PROGRESS_TURN_LIMIT,
        lastReason: GOAL_PAUSE_REASON_NO_PROGRESS,
      });
      // The bound stops the Goal instead of minting a fourth continuation.
      expect(host.started).toHaveLength(GOAL_NO_PROGRESS_TURN_LIMIT);
      expectCauses(
        journal,
        'create turn_finished turn_finished turn_finished pause',
      );
      expect(journal.appended.at(-1)?.snapshot.goal).toMatchObject({
        status: 'paused',
        lastReason: GOAL_PAUSE_REASON_NO_PROGRESS,
      });
      expect(causes.at(-1)).toBe('pause');
    });

    it('drops a stall count a previous build persisted and still pauses an idle Goal', async () => {
      const { host, runtime, goal } = await noProgressGoal({ objective: null });
      await runtime.restore([
        goalRecord(
          {
            status: 'active',
            turnCount: 4,
            checkpointStalls: 2,
            lastCheckpointFailure: 'InvalidGoalCheckpointError: old build',
          } as Partial<StoredGoal>,
          'turn_finished',
        ),
      ]);
      expect(goal()).not.toHaveProperty('checkpointStalls');
      expect(goal()).not.toHaveProperty('lastCheckpointFailure');

      for (let turn = 0; turn < GOAL_NO_PROGRESS_TURN_LIMIT; turn++) {
        await vi.waitFor(() =>
          expect(host.started.length).toBeGreaterThan(turn),
        );
        await finishDelivered(runtime, host.started[turn]!);
      }

      expect(goal()).toMatchObject({
        status: 'paused',
        lastReason: GOAL_PAUSE_REASON_NO_PROGRESS,
      });
    });

    it('restarts the streak on a turn that records a tool result', async () => {
      const { host, runtime, toolResults, goal } = await noProgressGoal();

      await finishDelivered(runtime, host.started[0]!);
      expect(goal()?.noProgressTurns).toBe(1);

      toolResults.set(host.started[1]!.turnId, 1);
      await finishDelivered(runtime, host.started[1]!);
      expect(goal()?.noProgressTurns).toBeUndefined();

      await finishDelivered(runtime, host.started[2]!);
      await finishDelivered(runtime, host.started[3]!);
      expect(goal()).toMatchObject({ status: 'active', noProgressTurns: 2 });
    });

    it('restarts the streak on a turn that proposes a terminal state', async () => {
      const { host, runtime, goal } = await noProgressGoal();

      await finishDelivered(runtime, host.started[0]!);
      expect(goal()?.noProgressTurns).toBe(1);

      // A first repeated blocker is recorded but not yet ready for the
      // verifier, so the turn stays a working turn -- and it worked.
      runtime.recordTerminalProposal(
        host.started[1]!,
        blocked('The upstream service is down', 'repeated', []),
      );
      await finishDelivered(runtime, host.started[1]!);

      expect(goal()).toMatchObject({ status: 'active' });
      expect(goal()?.noProgressTurns).toBeUndefined();
    });

    it.each([
      // No delivery mark: the permit carried the user's own text, so the
      // Goal was being steered rather than idling.
      ['restarts the streak on a turn the user drove', {}, false],
      [
        'leaves the bound off when the ledger cannot count tool results',
        { count: 'absent' },
        true,
      ],
      [
        'leaves the bound off when the ledger throws',
        { count: 'throws' },
        true,
      ],
      [
        'leaves the bound off when the ledger answers with something that is not a count',
        { count: 'NaN' },
        true,
      ],
    ] as const)('%s', async (_title, options, delivered) => {
      const { host, runtime, goal } = await noProgressGoal(options);

      for (let turn = 0; turn <= GOAL_NO_PROGRESS_TURN_LIMIT; turn++) {
        const permit = host.started[turn]!;
        await (delivered
          ? finishDelivered(runtime, permit)
          : runtime.finishTurn(permit));
      }

      expect(goal()).toMatchObject({ status: 'active' });
      expect(goal()?.noProgressTurns).toBeUndefined();
    });

    it('exempts the wind-down hand-off from the streak', async () => {
      const { host, runtime, spend, goal } = await noProgressGoal({
        tokenBudgetGrant: 1_000,
      });

      await finishDelivered(runtime, host.started[0]!);
      spend.set(host.started[1]!.turnId, 1_500);
      await finishDelivered(runtime, host.started[1]!);
      expect(goal()?.noProgressTurns).toBe(2);

      const windDown = host.started[2]!;
      expect(host.inputs[2]).toMatchObject({ windDown: true });

      // The hand-off turn is asked to hand off, not to work, so it neither
      // counts against the streak nor clears it.
      await finishHandOff(runtime, windDown);
      expect(goal()?.noProgressTurns).toBe(2);
    });

    // A restored active Goal whose streak stands at `noProgressTurns`.
    const restoredStreak = (turnCount: number, noProgressTurns: number) =>
      goalRecord(
        {
          objective: 'ship',
          status: 'active',
          evidenceCursor: { recordId: null },
          turnCount,
          activeTimeMs: 0,
          noProgressTurns,
          createdAt: 0,
          updatedAt: 0,
        },
        'turn_finished',
      );

    it('carries a restored streak into the turn that spends it', async () => {
      const { host, runtime, goal } = await noProgressGoal({
        restore: [restoredStreak(2, GOAL_NO_PROGRESS_TURN_LIMIT - 1)],
      });
      await vi.waitFor(() => expect(host.started).toHaveLength(1));

      await finishDelivered(runtime, host.started[0]!);

      expect(goal()).toMatchObject({
        status: 'paused',
        noProgressTurns: GOAL_NO_PROGRESS_TURN_LIMIT,
        lastReason: GOAL_PAUSE_REASON_NO_PROGRESS,
      });
    });

    it('clears the streak when the user resumes the Goal', async () => {
      const started = await noProgressGoal();
      const { host, runtime, goal } = started;
      await finishDeliveredTurns(started);

      await control(runtime, 'resume', goal()!);

      expect(goal()).toMatchObject({ status: 'active' });
      expect(goal()?.noProgressTurns).toBeUndefined();
      expect(goal()?.lastReason).toBeUndefined();

      // A resumed Goal gets the whole allowance again, not the last turn of
      // the one it just spent.
      await finishDelivered(
        runtime,
        host.started[GOAL_NO_PROGRESS_TURN_LIMIT]!,
      );
      expect(goal()).toMatchObject({ status: 'active', noProgressTurns: 1 });
    });

    it('shows the no-progress stop even when the settle write fails', async () => {
      const started = await noProgressGoal({
        journal: failingJournal(4, new Error('journal unavailable')),
      });
      await finishDeliveredTurns(started);

      expect(started.goal()).toMatchObject({
        status: 'paused',
        lastReason: GOAL_PAUSE_REASON_NO_PROGRESS,
      });
      expect(started.host.started).toHaveLength(GOAL_NO_PROGRESS_TURN_LIMIT);
    });

    it('serves a user turn reserved while the pause was being written', async () => {
      // `beginTurn` is synchronous and does not queue, so a reservation can
      // land mid-append of the pause record. Unless the guard re-reads it
      // after that await, the pause commits over a caller already waiting in
      // `claimGoalTurn`, whose message then runs as an ordinary turn.
      const race: { reserve?: () => void } = {};
      const started = await noProgressGoal({
        journal: fakeGoalJournal({
          beforeAppend: (payload) => {
            if (payload.cause === 'pause') race.reserve?.();
          },
        }),
      });
      const { journal, host, runtime } = started;
      race.reserve = () => {
        expect(runtime.getSnapshot().goal?.status).toBe('active');
        expect(runtime.beginTurn('user-turn')).toBeUndefined();
      };
      await finishDeliveredTurns(started);

      expectState(runtime, 'running', {
        status: 'active',
        noProgressTurns: GOAL_NO_PROGRESS_TURN_LIMIT,
      });
      expect(runtime.permitForTurn('user-turn')).toBeDefined();
      expect(host.started).toHaveLength(GOAL_NO_PROGRESS_TURN_LIMIT);
      // The record that lost the race stays in the journal: a restart
      // recovers a paused Goal with its reason, which resume undoes.
      expectCauses(
        journal,
        'create turn_finished turn_finished turn_finished pause',
      );
    });

    it('does not spend a restored streak on a turn the ledger could not measure', async () => {
      // The record can hold a streak at the limit (a `turn_finished` written
      // before a failed pause append), but the bound fires on this turn's
      // measured count. An unmeasured turn proves nothing: the Goal runs on
      // and the streak stays on the record for a measured turn to spend.
      const { host, runtime, goal } = await noProgressGoal({
        count: 'absent',
        restore: [restoredStreak(3, GOAL_NO_PROGRESS_TURN_LIMIT)],
      });
      await vi.waitFor(() => expect(host.started).toHaveLength(1));

      await finishDelivered(runtime, host.started[0]!);

      expect(goal()).toMatchObject({
        status: 'active',
        noProgressTurns: GOAL_NO_PROGRESS_TURN_LIMIT,
      });
      expect(goal()?.lastReason).toBeUndefined();
      expect(host.started).toHaveLength(2);
    });

    it('lets a spent token budget outrank the bound on the turn that crosses it', async () => {
      // The budget stop, and the hand-off it grants first, live in the
      // continuation gate. When the third quiet turn also spends the budget,
      // the Goal must reach that gate: surfaces telling a budget stop from an
      // idle pause need the `limitKind` only that stop writes.
      const started = await noProgressGoal({ tokenBudgetGrant: 1_000 });
      const { host, runtime, spend, goal } = started;

      await finishDeliveredTurns(started, GOAL_NO_PROGRESS_TURN_LIMIT - 1);
      const crossing = host.started[GOAL_NO_PROGRESS_TURN_LIMIT - 1]!;
      spend.set(crossing.turnId, 1_500);
      await finishDelivered(runtime, crossing);

      expect(goal()).toMatchObject({
        status: 'active',
        noProgressTurns: GOAL_NO_PROGRESS_TURN_LIMIT,
      });
      expect(host.inputs.at(-1)).toMatchObject({ windDown: true });

      await finishHandOff(runtime, host.started.at(-1)!);
      expect(goal()).toMatchObject({
        limitKind: 'token_budget',
        noProgressTurns: GOAL_NO_PROGRESS_TURN_LIMIT,
      });
      expect(goal()?.lastReason).not.toBe(GOAL_PAUSE_REASON_NO_PROGRESS);
    });
  });
  describe('turn and active-time budgets', () => {
    // A cadence ceiling alone: the token budget opts out.
    const cadenceGoal = (options: StartOptions) =>
      startGoal({ ...options, ...UNBOUNDED });

    it('arms no cadence ceiling unless one is granted', async () => {
      // The token budget defaults to a number; these default to nothing. A
      // cadence is what the user asks for, not a guard every Goal needs.
      const { goal } = await startGoal({ bind: false });

      expect(goal()!).not.toHaveProperty('turnBudget');
      expect(goal()!).not.toHaveProperty('activeTimeBudgetMs');
    });

    it('hands off and stops when the turn budget is spent, and resume re-arms it', async () => {
      const { journal, host, runtime, goal } = await cadenceGoal({
        turnBudgetGrant: 2,
      });
      const created = goal()!;
      expect(created).toMatchObject({ turnBudget: 2, turnCount: 0 });

      // Two turns of real work: the ceiling is checked at the continuation
      // boundary, so the turn that reaches it still runs to completion.
      await finishDelivered(runtime, host.started[0]!);
      expect(host.inputs[1]).not.toHaveProperty('windDown');
      await finishDelivered(runtime, host.started[1]!);

      // The spent window buys exactly one hand-off.
      expect(host.started).toHaveLength(3);
      expect(host.inputs[2]).toMatchObject({ windDown: true });
      expect(goal()?.status).toBe('active');

      await finishHandOff(runtime, host.started[2]!);
      expect(goal()).toMatchObject({
        limitKind: 'turn_budget',
        turnCount: 3,
        turnBudget: 2,
        windDownTurnId: host.started[2]!.turnId,
        lastReason: goalTurnBudgetReason(2),
      });
      expect(host.started).toHaveLength(3);
      expectCauses(
        journal,
        'create turn_finished turn_finished turn_finished usage_limited',
      );

      const resumed = await control(runtime, 'resume', created);
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
      // Promised by the settings row, the schema description and the
      // `turnBudget` doc comment, and nothing held it: `beginTurn` gates only
      // on the Goal being active, and a plausible "stop admitting turns at the
      // ceiling" edit (`spentBudget` is in the same closure) drops the message.
      const { host, runtime, goal } = await cadenceGoal({ turnBudgetGrant: 1 });

      // One automatic turn spends the window; the gate grants the hand-off.
      await finishDelivered(runtime, host.started[0]!);
      expect(goal()).toMatchObject({
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
      expect(goal()?.status).toBe('active');

      // And the stop still arrives once the user's own turn is done.
      await runtime.finishTurn(userPermit!);
      await waitForStatus(runtime, 'usage_limited');
      expect(goal()?.limitKind).toBe('turn_budget');
    });

    it('counts user-driven turns toward the turn ceiling', async () => {
      const { host, runtime, permit, goal } = await cadenceGoal({
        turnBudgetGrant: 2,
      });

      expect(runtime.beginTurn('real-user')).toBeUndefined();
      await finishDelivered(runtime, permit);
      const userPermit = runtime.permitForTurn('real-user');
      expect(userPermit).toBeDefined();
      await runtime.finishTurn(userPermit!);

      expect(goal()?.turnCount).toBe(2);
      expect(host.inputs.at(-1)).toMatchObject({ windDown: true });
      await finishHandOff(runtime, host.started.at(-1)!);
      expect(goal()).toMatchObject({ limitKind: 'turn_budget', turnCount: 3 });
    });

    it('hands off and stops when the active-time budget is spent', () =>
      withFakeDate(1_000, async () => {
        const { host, runtime, goal } = await cadenceGoal({
          activeTimeBudgetGrantMs: 60_000,
        });
        expect(goal()).toMatchObject({
          activeTimeBudgetMs: 60_000,
          activeTimeMs: 0,
        });

        // A turn that runs past the window: the clock is read at the
        // continuation boundary, so the turn itself is never cut short.
        vi.setSystemTime(91_000);
        await finishDelivered(runtime, host.started[0]!);

        expect(goal()?.activeTimeMs).toBe(90_000);
        expect(host.started).toHaveLength(2);
        expect(host.inputs[1]).toMatchObject({ windDown: true });

        await finishHandOff(runtime, host.started[1]!);
        expect(goal()).toMatchObject({
          limitKind: 'time_budget',
          activeTimeBudgetMs: 60_000,
          lastReason: goalActiveTimeBudgetReason(60_000),
        });
        expect(host.started).toHaveLength(2);

        // Resuming grants another window measured from where it stopped.
        const stopped = goal()!;
        const resumed = await control(runtime, 'resume', stopped);
        expect(resumed.snapshot.goal).toMatchObject({
          status: 'active',
          activeTimeBudgetMs: stopped.activeTimeMs + 60_000,
        });
        expect(resumed.snapshot.goal).not.toHaveProperty('windDownTurnId');
      }));

    it('does not accrue active time while the Goal is stopped', () =>
      withFakeDate(1_000, async () => {
        const { host, runtime, goal } = await cadenceGoal({
          activeTimeBudgetGrantMs: 60_000,
        });
        vi.setSystemTime(11_000);
        await finishDelivered(runtime, host.started[0]!);
        const paused = await control(runtime, 'pause', goal()!);
        expect(paused.snapshot.goal?.activeTimeMs).toBe(10_000);

        // An hour of wall clock while paused: the window is untouched, so the
        // resumed Goal still has the time it had.
        vi.setSystemTime(3_611_000);
        const resumed = await control(runtime, 'resume', paused.snapshot.goal!);
        expect(resumed.snapshot.goal).toMatchObject({
          status: 'active',
          activeTimeMs: 10_000,
          activeTimeBudgetMs: 60_000,
        });
        // And it is admitted a real continuation rather than a hand-off.
        expect(host.inputs.at(-1)).not.toHaveProperty('windDown');
      }));

    it('reports one reason when a turn crosses more than one ceiling', async () => {
      // Token first: it is the ceiling armed by default, so it is the one a
      // user is likeliest to be asking about.
      const { host, runtime, spend, goal } = await budgetGoal('peek', {
        turnBudgetGrant: 1,
      });

      spend.set(host.started[0]!.turnId, 5_000);
      await finishDelivered(runtime, host.started[0]!);
      await finishHandOff(runtime, host.started[1]!);
      expect(goal()?.limitKind).toBe('token_budget');
    });

    it('reports the turn budget before the time budget when both are spent', () =>
      withFakeDate(1_000, async () => {
        const { host, runtime, goal } = await cadenceGoal({
          turnBudgetGrant: 1,
          activeTimeBudgetGrantMs: 60_000,
        });

        vi.setSystemTime(61_000);
        await finishDelivered(runtime, host.started[0]!);
        expect(host.inputs.at(-1)).toMatchObject({ windDown: true });
        await finishHandOff(runtime, host.started.at(-1)!);
        expect(goal()?.limitKind).toBe('turn_budget');
      }));

    it('carries the cadence figures to the host that renders the prompt', () =>
      withFakeDate(1_000, async () => {
        const { host, runtime } = await cadenceGoal({
          turnBudgetGrant: 20,
          activeTimeBudgetGrantMs: 1_800_000,
        });

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
      }));

    it.each([
      [
        'uses elapsed active time when a queued continuation waits for a host',
        1_800_000,
        61_000,
        { usage: { activeTimeMs: 60_000, activeTimeBudgetMs: 1_800_000 } },
      ],
      // Only the time ceiling can become spent between queueing and delivery:
      // `finishTurn` commits spend and turn count before the gate, but active
      // time accrues while the continuation waits for a host. Queued under the
      // ceiling and delivered past it, it must be the hand-off, not a work turn.
      [
        're-reads the time ceiling when a queued continuation is finally delivered',
        60_000,
        121_000,
        { windDown: true },
      ],
    ])('%s', (_title, activeTimeBudgetGrantMs, now, firstInput) =>
      withFakeDate(1_000, async () => {
        // Queued unspent, with no host to deliver it, while the clock runs on.
        const { host, runtime } = await cadenceGoal({
          activeTimeBudgetGrantMs,
          bind: false,
        });
        expect(host.inputs).toHaveLength(0);
        vi.setSystemTime(now);
        runtime.bindHost(host);

        expect(host.inputs).toHaveLength(1);
        expect(host.inputs[0]).toMatchObject(firstInput);
      }),
    );

    it('sends no time figures to a Goal with no time ceiling', async () => {
      // Elapsed active time with nothing to measure it against is a number on
      // every turn that the model cannot act on.
      const { host } = await startGoal({ turnBudgetGrant: 20 });

      expect(host.inputs[0]?.usage).toMatchObject({ turnBudget: 20 });
      expect(host.inputs[0]?.usage).not.toHaveProperty('activeTimeMs');
      expect(host.inputs[0]?.usage).not.toHaveProperty('activeTimeBudgetMs');
    });

    it('lets a spent cadence budget outrank the no-progress bound', async () => {
      // Both bounds are reached on the same turn. The budget owes this Goal a
      // hand-off and a `usage_limited` stop the user can resume from; pausing
      // for idleness here would skip both.
      const started = await cadenceGoal({
        ledger: {
          takeGoalTurnTokens: () => 0,
          takeGoalTurnToolResults: () => 0,
        },
        turnBudgetGrant: GOAL_NO_PROGRESS_TURN_LIMIT,
      });
      const { host, runtime, goal } = started;

      await finishDeliveredTurns(started);

      expect(goal()?.status).toBe('active');
      expect(host.inputs.at(-1)).toMatchObject({ windDown: true });
      await finishHandOff(runtime, host.started.at(-1)!);
      expect(goal()).toMatchObject({ limitKind: 'turn_budget' });
      expect(goal()?.lastReason).not.toBe(GOAL_PAUSE_REASON_NO_PROGRESS);
    });

    it('shows the cadence stop even when the settle write fails', async () => {
      const { host, runtime, goal } = await cadenceGoal({
        journal: failingJournal(3, new Error('journal unavailable')),
        turnBudgetGrant: 1,
      });

      await finishDelivered(runtime, host.started[0]!);
      await finishHandOff(runtime, host.started[1]!);
      expect(goal()).toMatchObject({ limitKind: 'turn_budget' });
      expect(host.started).toHaveLength(2);
    });
  });
});
