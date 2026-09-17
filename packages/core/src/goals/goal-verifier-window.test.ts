/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import { describe, expect, it } from 'vitest';
import type {
  GoalRecord,
  GoalTerminalProposal,
  GoalTurnPermit,
} from './goal-protocol.js';
import {
  EvidenceSourceUnavailableError,
  type GoalEvidenceProvenance,
  type GoalEvidenceRecord,
} from './goal-evidence.js';
import {
  buildGoalVerifierEvidenceWindow,
  GoalVerifierCoverageError,
  GoalVerifierWindowBudgetError,
  USER_MESSAGE_OUTSIDE_GOAL_TURN,
  validateGoalVerifierCoverage,
  VERIFIER_EVIDENCE_WINDOW_BYTE_LIMIT,
  VERIFIER_EVIDENCE_WINDOW_MIN_BYTES,
} from './goal-verifier-window.js';

const GOAL_ID = 'goal-1';
const REVISION = 2;

interface RecordOptions {
  provenance?:
    | GoalEvidenceProvenance
    | 'goal_control'
    | 'goal_runtime'
    | 'system';
  goalId?: string;
  revision?: number;
  turnId?: string;
  text?: string;
  thought?: string;
  toolResponse?: Record<string, unknown>;
  goalContext?: unknown;
  systemPayload?: unknown;
}

function record(
  uuid: string,
  type: GoalEvidenceRecord['type'],
  options: RecordOptions = {},
): GoalEvidenceRecord {
  const parts: Part[] = [];
  if (options.thought !== undefined) {
    parts.push({ text: options.thought, thought: true });
  }
  if (options.text !== undefined) parts.push({ text: options.text });
  if (options.toolResponse !== undefined) {
    parts.push({
      functionResponse: { name: 'shell', response: options.toolResponse },
    });
  }
  const goalContext =
    options.goalContext ??
    (options.turnId === undefined
      ? undefined
      : {
          goalId: options.goalId ?? GOAL_ID,
          revision: options.revision ?? REVISION,
          turnId: options.turnId,
        });
  return {
    uuid,
    type,
    ...(options.provenance === undefined
      ? {}
      : { provenance: options.provenance }),
    ...(goalContext === undefined ? {} : { goalContext }),
    ...(options.systemPayload === undefined
      ? {}
      : { systemPayload: options.systemPayload }),
    ...(parts.length === 0 ? {} : { message: { parts } }),
  };
}

const cursor = () => record('cursor', 'system', { provenance: 'goal_control' });
const tool = (uuid: string, turnId: string, output: string) =>
  record(uuid, 'tool_result', { turnId, toolResponse: { output } });
const text = (uuid: string, turnId: string, value: string) =>
  record(uuid, 'assistant', { turnId, text: value });
const userMessage = (uuid: string, value: string, turnId?: string) =>
  record(uuid, 'user', { provenance: 'real_user', text: value, turnId });

function goal(cursorId: string | null = 'cursor'): GoalRecord {
  return {
    goalId: GOAL_ID,
    revision: REVISION,
    objective: 'Ship the requested change',
    status: 'active',
    evidenceCursor: { recordId: cursorId },
    turnCount: 2,
    activeTimeMs: 100,
    tokensUsed: 0,
    createdAt: 1,
    updatedAt: 2,
  };
}

function permit(turnId = 'turn-3'): GoalTurnPermit {
  return { goalId: GOAL_ID, revision: REVISION, turnId };
}

const complete: GoalTerminalProposal = {
  status: 'complete',
  reason: 'The requested result was delivered and verified.',
  evidenceRefs: [],
};

function blocked(
  blockerKind?: GoalTerminalProposal['blockerKind'],
): GoalTerminalProposal {
  return {
    status: 'blocked',
    reason: 'No meaningful in-scope work remains without the cited change.',
    evidenceRefs: [],
    ...(blockerKind ? { blockerKind } : {}),
  };
}

function build(
  records: GoalEvidenceRecord[],
  proposal: GoalTerminalProposal,
  currentPermit = permit(),
  budgetBytes?: number,
  currentGoal = goal(),
) {
  return buildGoalVerifierEvidenceWindow(
    {
      records: [cursor(), ...records],
      goal: currentGoal,
      permit: currentPermit,
      proposal,
    },
    budgetBytes === undefined ? {} : { budgetBytes },
  );
}

function coverage(
  records: GoalEvidenceRecord[],
  proposal: GoalTerminalProposal,
  currentPermit = permit(),
) {
  return validateGoalVerifierCoverage({
    records: [cursor(), ...records],
    goal: goal(),
    permit: currentPermit,
    proposal,
  });
}

const serializedBytes = (window: { evidence: object[] }) =>
  window.evidence.reduce(
    (total, entry) => total + Buffer.byteLength(JSON.stringify(entry)) + 1,
    0,
  );

describe('buildGoalVerifierEvidenceWindow', () => {
  it("sends the proposing turn's records newest first, plus the user's messages from anywhere", () => {
    const records = [
      userMessage('before-goal', 'Use the second option'),
      tool('earlier-tool', 'turn-2', 'earlier pass'),
      text('earlier-text', 'turn-2', 'earlier'),
      userMessage('mid-goal', 'and keep the tests', 'turn-2'),
      record('runtime-read', 'tool_result', {
        turnId: 'turn-3',
        provenance: 'goal_runtime',
        toolResponse: { active: true },
      }),
      record('narration', 'assistant', {
        turnId: 'turn-3',
        text: 'Running the suite',
        thought: 'hidden reasoning',
      }),
      tool('check', 'turn-3', '18 tests passed'),
    ];

    const window = build(records, complete);

    expect(window.turnIds).toEqual(['turn-3']);
    expect(window.omitted).toBe(0);
    expect(window.evidence.map((entry) => entry.uuid)).toEqual([
      'check',
      'narration',
      'mid-goal',
      'before-goal',
    ]);
    expect(window.evidence[0]).toMatchObject({
      provenance: 'tool_result',
      proofKind: 'external_fact',
      turnId: 'turn-3',
    });
    expect(window.evidence[0]!.content).toContain('18 tests passed');
    expect(window.evidence[1]).toMatchObject({
      provenance: 'assistant_output',
      proofKind: 'delivered_output',
      content: 'Running the suite',
    });
    expect(window.evidence[2]).toMatchObject({
      proofKind: 'user_input',
      turnId: 'turn-2',
    });
    expect(window.evidence[3]).toMatchObject({
      proofKind: 'user_input',
      turnId: USER_MESSAGE_OUTSIDE_GOAL_TURN,
      content: 'Use the second option',
    });
    const serialized = JSON.stringify(window);
    expect(serialized).not.toContain('hidden reasoning');
    expect(serialized).not.toContain('earlier pass');
    expect(serialized).not.toContain('"earlier"');
  });

  it('covers the current and two preceding turns for a blocked proposal', () => {
    const records = ['turn-1', 'turn-2', 'turn-3', 'turn-4'].map((turnId) =>
      tool(`${turnId}-tool`, turnId, `${turnId} still blocked`),
    );

    const window = build(records, blocked('repeated'), permit('turn-4'));

    expect(window.turnIds).toEqual(['turn-2', 'turn-3', 'turn-4']);
    expect(window.evidence.map((entry) => entry.uuid)).toEqual([
      'turn-4-tool',
      'turn-3-tool',
      'turn-2-tool',
    ]);
    expect(window.omitted).toBe(0);
  });

  it('keeps both ends of a long record so a summary at its end stays visible', () => {
    const output = `$ npm test\n${'not ok 1 - some test\n'.repeat(3_000)}Tests 412 passed`;
    const ask = `Please pick between the two plans below.\n${'log line\n'.repeat(3_000)}\nApproved: go with plan B.`;
    const records = [
      userMessage('ask', ask, 'turn-1'),
      tool('run', 'turn-3', output),
    ];

    const window = build(records, complete);

    const run = window.evidence.find((entry) => entry.uuid === 'run')!;
    expect(run.content.startsWith('{"name":"shell"')).toBe(true);
    expect(run.content).toContain('Tests 412 passed');
    expect(run.content).toContain('[middle truncated]');
    expect(Buffer.byteLength(run.content, 'utf8')).toBeLessThanOrEqual(16_000);
    const user = window.evidence.find((entry) => entry.uuid === 'ask')!;
    expect(user.content.startsWith('Please pick between the two plans')).toBe(
      true,
    );
    expect(user.content.endsWith('Approved: go with plan B.')).toBe(true);
    expect(Buffer.byteLength(user.content, 'utf8')).toBeLessThanOrEqual(16_000);
  });

  it('cuts a long multi-byte record on code point boundaries', () => {
    const records = [
      userMessage('ask', `选项${'界'.repeat(9_000)}批准`, 'turn-3'),
    ];

    const [user] = build(records, complete).evidence;

    expect(user!.content.startsWith('选项界')).toBe(true);
    expect(user!.content.endsWith('界批准')).toBe(true);
    expect(user!.content).not.toContain('�');
    expect(Buffer.byteLength(user!.content, 'utf8')).toBeLessThanOrEqual(
      16_000,
    );
  });

  it('budgets the window by serialized bytes, newest first, counting what it leaves out', () => {
    const records = Array.from({ length: 140 }, (_, index) =>
      text(`a-${index}`, 'turn-3', 'x'.repeat(2_100)),
    );

    const window = build(records, complete, permit(), 100_000);

    // Each record costs its content plus JSON keys, ids and a comma, so
    // fewer than 48 fit a 100 000-byte budget; the ones that do not are
    // the oldest, and they are counted rather than dropped.
    expect(window.evidence.length).toBeLessThan(48);
    expect(window.evidence.length).toBeGreaterThan(40);
    expect(window.omitted).toBe(140 - window.evidence.length);
    expect(window.evidence[0]!.uuid).toBe('a-139');
    expect(window.evidence.at(-1)!.uuid).toBe(
      `a-${140 - window.evidence.length}`,
    );
    const used = serializedBytes(window);
    expect(used).toBeLessThanOrEqual(100_000);
    expect(
      used + Buffer.byteLength(JSON.stringify(window.evidence[0])) + 1,
    ).toBeGreaterThan(100_000);
    // The ceiling holds whatever the caller asks for.
    const capped = build(records, complete, permit(), 10_000_000);
    expect(serializedBytes(capped)).toBeLessThanOrEqual(
      VERIFIER_EVIDENCE_WINDOW_BYTE_LIMIT,
    );
    expect(capped.evidence.length).toBeLessThan(140);
  });

  it('keeps the proposing turn, each preceding turn and a short approval in the smallest window', () => {
    const big = (uuid: string, turnId: string) =>
      tool(uuid, turnId, 'x'.repeat(17_000));
    const records = [
      userMessage('approved', 'yes, approved', 'turn-1'),
      userMessage('paste-1', 'x'.repeat(17_000), 'turn-1'),
      userMessage('paste-2', 'x'.repeat(17_000), 'turn-1'),
      ...Array.from({ length: 6 }, (_, i) => big(`t2-${i}`, 'turn-2')),
      ...Array.from({ length: 6 }, (_, i) => big(`t3-${i}`, 'turn-3')),
      ...Array.from({ length: 6 }, (_, i) => big(`t4-${i}`, 'turn-4')),
    ];

    // A 190 kB objective leaves the smallest window there is. The proposing
    // turn's newest record and one from each preceding turn take most of it;
    // the two pasted logs no longer fit and are skipped instead of ending the
    // scan in front of the user's short approval.
    const window = build(
      records,
      blocked('repeated'),
      permit('turn-4'),
      64_000,
    );

    const uuids = window.evidence.map((entry) => entry.uuid);
    expect(uuids[0]).toBe('t4-5');
    expect(uuids).toContain('t3-5');
    expect(uuids).toContain('t2-5');
    expect(uuids).toContain('approved');
    expect(uuids).not.toContain('paste-1');
    expect(uuids).not.toContain('paste-2');
    expect(window.omitted).toBe(records.length - uuids.length);
    expect(serializedBytes(window)).toBeLessThanOrEqual(64_000);
  });

  it("reserves room for the user's messages when the closing turn fills the window", () => {
    const records = [
      userMessage('approval', 'Approved: plan B', 'turn-1'),
      ...Array.from({ length: 40 }, (_, i) =>
        tool(`t2-${i}`, 'turn-2', 'x'.repeat(2_000)),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        tool(`t3-${i}`, 'turn-3', 'x'.repeat(2_000)),
      ),
      ...Array.from({ length: 200 }, (_, i) =>
        tool(`t4-${i}`, 'turn-4', 'x'.repeat(2_000)),
      ),
    ];

    const completion = build(records, complete, permit('turn-4'));
    expect(completion.evidence[0]!.uuid).toBe('t4-199');
    expect(completion.evidence.some((e) => e.uuid === 'approval')).toBe(true);
    expect(completion.evidence.every((e) => e.turnId !== 'turn-2')).toBe(true);
    expect(completion.omitted).toBeGreaterThan(0);

    const blockedWindow = build(records, blocked('repeated'), permit('turn-4'));
    const byTurn = (turnId: string) =>
      blockedWindow.evidence.filter((e) => e.turnId === turnId).length;
    expect(byTurn('turn-2')).toBeGreaterThan(0);
    expect(byTurn('turn-3')).toBeGreaterThan(0);
    expect(byTurn('turn-4')).toBeGreaterThan(byTurn('turn-3'));
    // Newest first across every part, by transcript position.
    const uuids = blockedWindow.evidence.map((e) => e.uuid);
    expect(uuids[0]).toBe('t4-199');
    expect(uuids.at(-1)).toBe('approval');
    expect(uuids.indexOf('t3-39')).toBeGreaterThan(uuids.indexOf('t4-0'));
  });

  it('returns an empty window for a turn that has recorded nothing yet', () => {
    const records = [text('t2', 'turn-2', 'earlier')];

    expect(build(records, complete)).toEqual({
      evidence: [],
      turnIds: ['turn-3'],
      omitted: 0,
    });
    // A blocked window still reaches back, so the earlier turn's record is
    // admitted even though the current turn has none.
    expect(build(records, blocked('repeated'))).toMatchObject({
      evidence: [{ uuid: 't2', turnId: 'turn-2' }],
      turnIds: ['turn-2', 'turn-3'],
    });
  });

  it("reads the lineage from the cursor forward and the user's messages from anywhere", () => {
    const records = [
      userMessage('old-approval', 'Approved: ship it', 'turn-0'),
      // Malformed Goal-owned context before the cursor: skipped, as the
      // cursor-bounded scan always did.
      record('bad', 'assistant', {
        text: 'claims the goal',
        goalContext: { goalId: GOAL_ID, revision: REVISION },
      }),
      record('resume-cursor', 'system', { provenance: 'goal_control' }),
      tool('shipped', 'turn-3', 'shipped'),
    ];
    const input = {
      records,
      goal: goal('resume-cursor'),
      permit: permit(),
      proposal: complete,
    };

    expect(
      buildGoalVerifierEvidenceWindow(input).evidence.map((e) => e.uuid),
    ).toEqual(['shipped', 'old-approval']);
    // A message before the cursor with no Goal context, or stamped for
    // another Goal or revision, may be consent to something else: not taken.
    expect(
      buildGoalVerifierEvidenceWindow({
        ...input,
        records: [
          userMessage('pre-goal', '/goal set ship it'),
          record('other-revision', 'user', {
            provenance: 'real_user',
            text: 'approved (for the old objective)',
            revision: REVISION - 1,
            turnId: 'turn-0',
          }),
          ...records,
        ],
      }).evidence.map((e) => e.uuid),
    ).toEqual(['shipped', 'old-approval']);
    expect(() =>
      buildGoalVerifierEvidenceWindow({
        ...input,
        records: [...records, { ...records[1]!, uuid: 'bad-after' }],
      }),
    ).toThrow(expect.objectContaining({ code: 'malformed_turn_context' }));
    expect(() =>
      buildGoalVerifierEvidenceWindow({ ...input, goal: goal('missing') }),
    ).toThrow(expect.objectContaining({ code: 'cursor_not_found' }));
    expect(() =>
      buildGoalVerifierEvidenceWindow({ ...input, goal: goal(null) }),
    ).toThrow(expect.objectContaining({ code: 'cursor_unset' }));
  });

  it('counts as omitted only records that would have been evidence', () => {
    const records = [
      record('call-only', 'assistant', {
        turnId: 'turn-3',
        goalContext: { goalId: GOAL_ID, revision: REVISION, turnId: 'turn-3' },
      }),
      record('no-response', 'tool_result', { turnId: 'turn-3' }),
      record('thought-only', 'assistant', {
        turnId: 'turn-3',
        thought: 'hidden',
      }),
      userMessage('blank', '   ', 'turn-3'),
      ...Array.from({ length: 60 }, (_, index) =>
        tool(`t-${index}`, 'turn-3', 'x'.repeat(2_000)),
      ),
    ];
    records[0]!.message = {
      parts: [{ functionCall: { name: 'shell', args: {} } }],
    };

    const window = build(records, complete, permit(), 64_000);

    expect(window.evidence.length).toBeGreaterThan(20);
    expect(window.omitted).toBe(60 - window.evidence.length);
    expect(
      window.evidence.some((entry) =>
        ['call-only', 'no-response', 'thought-only', 'blank'].includes(
          entry.uuid,
        ),
      ),
    ).toBe(false);
  });

  it("admits a user message inside a preceding turn as that turn's evidence", () => {
    const big = (uuid: string, turnId: string) =>
      tool(uuid, turnId, 'x'.repeat(17_000));
    const records = [
      text('t2-prose', 'turn-2', 'still blocked'),
      userMessage('t2-user', 'still no access from my side', 'turn-2'),
      ...Array.from({ length: 6 }, (_, i) => big(`t3-${i}`, 'turn-3')),
      ...Array.from({ length: 6 }, (_, i) => big(`t4-${i}`, 'turn-4')),
    ];

    const window = build(
      records,
      blocked('repeated'),
      permit('turn-4'),
      64_000,
    );

    const uuids = window.evidence.map((entry) => entry.uuid);
    expect(uuids).toContain('t2-user');
    expect(uuids.filter((uuid) => uuid === 't2-user')).toHaveLength(1);
    expect(() =>
      coverage(records, blocked('repeated'), permit('turn-4')),
    ).not.toThrow();
  });

  it('stops the recency pass after a run of records that do not fit', () => {
    const records = [
      text('tiny-but-old', 'turn-3', 'ok'),
      ...Array.from({ length: 12 }, (_, i) =>
        tool(`big-${i}`, 'turn-3', 'y'.repeat(25_000)),
      ),
    ];

    const window = build(records, complete, permit(), 64_000);

    // Three capped records fill the window; the next eight do not fit and
    // end the pass, so the tiny record behind them is left out rather than
    // every remaining response being serialized to find it.
    expect(window.evidence.map((e) => e.uuid)).toEqual([
      'big-11',
      'big-10',
      'big-9',
    ]);
    expect(window.omitted).toBe(10);
  });

  it('keeps admitting small records between large ones that do not fit', () => {
    const records: GoalEvidenceRecord[] = [];
    for (let i = 0; i < 30; i += 1) {
      records.push(tool(`big-${i}`, 'turn-3', 'y'.repeat(25_000)));
      records.push(tool(`small-${i}`, 'turn-3', 'ok'));
    }

    const window = build(records, complete, permit(), 64_000);

    // Three capped records fill the window. Every later large record is a
    // miss, but each small one between them is admitted, which starts the
    // miss count over, so the pass reaches all thirty of them.
    const uuids = window.evidence.map((e) => e.uuid);
    expect(uuids.filter((uuid) => uuid.startsWith('small-'))).toHaveLength(30);
    expect(uuids.filter((uuid) => uuid.startsWith('big-'))).toHaveLength(3);
  });

  it('renders a user message whose expanded parts are far larger than its display text', () => {
    const records = [
      record('approval', 'user', {
        provenance: 'real_user',
        turnId: 'turn-1',
        text: `yes, go ahead @design.md\n${'design file contents\n'.repeat(1_500)}`,
        systemPayload: {
          hookContext: 'expanded',
          displayText: 'yes, go ahead @design.md',
        },
      }),
      ...Array.from({ length: 6 }, (_, i) =>
        tool(`t3-${i}`, 'turn-3', 'x'.repeat(17_000)),
      ),
    ];

    const window = build(records, complete, permit(), 64_000);

    expect(window.evidence.find((e) => e.uuid === 'approval')).toMatchObject({
      proofKind: 'user_input',
      content: 'yes, go ahead @design.md',
    });
  });

  it("guarantees the proposing turn's newest tool result ahead of its closing prose", () => {
    const records = [
      ...Array.from({ length: 4 }, (_, i) =>
        tool(`t2-${i}`, 'turn-2', 'x'.repeat(17_000)),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        tool(`t3-${i}`, 'turn-3', 'x'.repeat(17_000)),
      ),
      tool('decisive', 'turn-4', `dependency check\n${'x'.repeat(17_000)}`),
      text('closing-prose', 'turn-4', 'z'.repeat(17_000)),
    ];

    const window = build(
      records,
      blocked('repeated'),
      permit('turn-4'),
      64_000,
    );

    const uuids = window.evidence.map((e) => e.uuid);
    expect(uuids).toContain('decisive');
    expect(uuids).toContain('t3-3');
    expect(uuids).toContain('t2-3');
    expect(uuids).not.toContain('closing-prose');
  });

  it('does not take a user message whose Goal stamp cannot be read', () => {
    const records = [
      record('tainted', 'user', {
        provenance: 'real_user',
        text: 'approved',
        goalContext: { goalId: 'goal-9' },
      }),
      tool('run', 'turn-2', 'ok'),
    ];

    // The preceding turn's tool result is in a blocked window; the tainted
    // message is not, and it cannot stand in for user input either.
    expect(
      build(records, blocked('authority')).evidence.map((e) => e.uuid),
    ).toEqual(['run']);
    expect(() => coverage(records, blocked('authority'))).toThrow(
      expect.objectContaining({
        code: 'immediate_blocker_external_evidence_required',
      }),
    );
  });

  it('treats a user prompt whose display text is blank as no evidence', () => {
    const records = [
      record('blank-prompt', 'user', {
        provenance: 'real_user',
        turnId: 'turn-3',
        text: 'expanded context that the user never typed',
        systemPayload: { hookContext: 'expanded', displayText: '   ' },
      }),
    ];

    expect(build(records, complete).evidence).toEqual([]);
    expect(() => coverage(records, blocked('authority'))).toThrow(
      GoalVerifierCoverageError,
    );
  });

  it('refuses a budget that is not a finite number or too small to judge anything', () => {
    const records = [tool('run', 'turn-3', 'ok')];

    expect(() => build(records, complete, permit(), Number.NaN)).toThrow(
      expect.objectContaining({ code: 'budget_invalid' }),
    );
    expect(() =>
      build(records, complete, permit(), Number.POSITIVE_INFINITY),
    ).toThrow(GoalVerifierWindowBudgetError);
    expect(() =>
      build(
        records,
        complete,
        permit(),
        VERIFIER_EVIDENCE_WINDOW_MIN_BYTES - 1,
      ),
    ).toThrow(expect.objectContaining({ code: 'budget_too_small' }));
    expect(() =>
      build(records, complete, permit(), VERIFIER_EVIDENCE_WINDOW_MIN_BYTES),
    ).not.toThrow();
  });

  it('refuses a chain that repeats a record uuid', () => {
    const records = [
      tool('run', 'turn-3', 'once'),
      tool('run', 'turn-3', 'twice'),
    ];

    expect(() => build(records, complete)).toThrow(
      expect.objectContaining({ code: 'duplicate_record_uuid' }),
    );
  });

  it('rejects a permit that does not match the Goal or is not the lineage tail', () => {
    const records = [
      text('t2', 'turn-2', 'earlier'),
      text('t3', 'turn-3', 'now'),
    ];

    expect(() => build(records, complete, permit('turn-2'))).toThrow(
      expect.objectContaining({ code: 'current_turn_not_tail' }),
    );
    expect(() => build(records, complete, permit('turn-4'))).not.toThrow();
    expect(() =>
      build(records, complete, { ...permit(), revision: REVISION + 1 }),
    ).toThrow(expect.objectContaining({ code: 'permit_goal_mismatch' }));
    expect(() => build(records, complete)).not.toThrow(
      EvidenceSourceUnavailableError,
    );
  });
});

describe('validateGoalVerifierCoverage', () => {
  const turns = ['turn-2', 'turn-3', 'turn-4'];
  const proseOnly = turns.map((turnId) =>
    text(`${turnId}-text`, turnId, 'still blocked'),
  );
  const withFacts = turns.map((turnId) =>
    tool(`${turnId}-tool`, turnId, `${turnId}: dependency missing`),
  );

  it('accepts anything that is not a blocked proposal', () => {
    expect(() => coverage([], complete)).not.toThrow();
  });

  it('holds an infeasible blocker to a tool result in the current turn', () => {
    expect(() => coverage([proseOnly[2]!], blocked('infeasible'))).toThrow(
      expect.objectContaining({
        code: 'infeasible_blocker_external_fact_required',
      }),
    );
    expect(() =>
      coverage(
        [userMessage('u', 'cannot be done', 'turn-4')],
        blocked('infeasible'),
        permit('turn-4'),
      ),
    ).toThrow(GoalVerifierCoverageError);
    expect(() =>
      coverage([withFacts[2]!], blocked('infeasible'), permit('turn-4')),
    ).not.toThrow();
  });

  it('requires a user message during the Goal or a tool result for an immediate blocker', () => {
    for (const kind of ['authority', 'external'] as const) {
      expect(() =>
        coverage([proseOnly[2]!], blocked(kind), permit('turn-4')),
      ).toThrow(
        expect.objectContaining({
          code: 'immediate_blocker_external_evidence_required',
        }),
      );
      // The message that created the Goal sits before the cursor and must
      // not satisfy the Goal's own blocker; neither may a blank one or one
      // stamped for another revision.
      expect(() =>
        validateGoalVerifierCoverage({
          records: [
            userMessage('create', '/goal set ship it'),
            cursor(),
            record('old-rev', 'user', {
              provenance: 'real_user',
              text: 'approved',
              revision: REVISION - 1,
              turnId: 'turn-0',
            }),
            userMessage('blank', '  ', 'turn-4'),
            proseOnly[2]!,
          ],
          goal: goal(),
          permit: permit('turn-4'),
          proposal: blocked(kind),
        }),
      ).toThrow(
        expect.objectContaining({
          code: 'immediate_blocker_external_evidence_required',
        }),
      );
      expect(() =>
        coverage(
          [userMessage('u', 'stop here')],
          blocked(kind),
          permit('turn-4'),
        ),
      ).not.toThrow();
      expect(() =>
        coverage([withFacts[2]!], blocked(kind), permit('turn-4')),
      ).not.toThrow();
      // A tool result with no response is not evidence of anything.
      expect(() =>
        coverage(
          [record('no-response', 'tool_result', { turnId: 'turn-4' })],
          blocked(kind),
          permit('turn-4'),
        ),
      ).toThrow(GoalVerifierCoverageError);
    }
  });

  it('requires three lineage turns, the earlier two with non-assistant evidence, for a repeated blocker', () => {
    const repeated = blocked('repeated');
    expect(() => coverage(proseOnly, repeated, permit('turn-4'))).toThrow(
      expect.objectContaining({ code: 'repeated_blocker_turn_coverage' }),
    );
    expect(() =>
      coverage(withFacts.slice(1), repeated, permit('turn-4')),
    ).toThrow(
      expect.objectContaining({ code: 'repeated_blocker_turn_coverage' }),
    );
    // The current turn is the one being judged: what the model wrote in it
    // counts, as the rule this replaces allowed.
    expect(() =>
      coverage(
        [withFacts[0]!, withFacts[1]!, proseOnly[2]!],
        repeated,
        permit('turn-4'),
      ),
    ).not.toThrow();
    expect(() =>
      coverage(
        [withFacts[0]!, proseOnly[1]!, withFacts[2]!],
        repeated,
        permit('turn-4'),
      ),
    ).toThrow(
      expect.objectContaining({ code: 'repeated_blocker_turn_coverage' }),
    );
    expect(() => coverage(withFacts, repeated, permit('turn-4'))).not.toThrow();
    // An omitted blockerKind follows the repeated audit.
    expect(() =>
      coverage(withFacts, blocked(), permit('turn-4')),
    ).not.toThrow();
    expect(() =>
      coverage(
        [
          withFacts[0]!,
          userMessage('u', 'still no access', 'turn-3'),
          withFacts[2]!,
        ],
        repeated,
        permit('turn-4'),
      ),
    ).not.toThrow();
  });

  it('raises the same source failures as the window for an unattributable transcript', () => {
    expect(() =>
      coverage(
        [tool('run', 'turn-3', 'a'), tool('run', 'turn-3', 'b')],
        blocked('external'),
      ),
    ).toThrow(expect.objectContaining({ code: 'duplicate_record_uuid' }));
  });
});
