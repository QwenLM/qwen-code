/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import { describe, expect, it } from 'vitest';
import type { GoalRecord, GoalTurnPermit } from './goal-protocol.js';
import type { EvidenceSourceUnavailableError } from './goal-evidence.js';
import {
  buildGoalVerifierEvidenceWindow,
  type GoalEvidenceProvenance,
  type GoalEvidenceRecord,
} from './goal-evidence.js';

const GOAL_ID = 'goal-1';
const REVISION = 2;

interface RecordOptions {
  provenance?:
    | GoalEvidenceProvenance
    | 'goal_control'
    | 'goal_runtime'
    | 'system';
  subtype?: string;
  goalId?: string;
  revision?: number;
  turnId?: string;
  text?: string;
  thought?: string;
  toolResponse?: Record<string, unknown>;
  goalContext?: unknown;
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
      functionResponse: {
        name: 'shell',
        response: options.toolResponse,
      },
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
    ...(options.subtype === undefined ? {} : { subtype: options.subtype }),
    ...(options.provenance === undefined
      ? {}
      : { provenance: options.provenance }),
    ...(goalContext === undefined ? {} : { goalContext }),
    ...(parts.length === 0 ? {} : { message: { parts } }),
  };
}

function goal(cursor: string | null = 'cursor'): GoalRecord {
  return {
    goalId: GOAL_ID,
    revision: REVISION,
    objective: 'Ship the requested change',
    status: 'active',
    evidenceCursor: { recordId: cursor },
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

describe('Goal verifier evidence window', () => {
  const cursor = () =>
    record('cursor', 'system', { provenance: 'goal_control' });
  const build = (
    records: GoalEvidenceRecord[],
    budgetBytes = 256_000,
    currentPermit = permit(),
    currentGoal = goal(),
  ) =>
    buildGoalVerifierEvidenceWindow(
      {
        records: [cursor(), ...records],
        goal: currentGoal,
        permit: currentPermit,
      },
      { budgetBytes },
    );
  const tool = (uuid: string, turnId: string, output: string) =>
    record(uuid, 'tool_result', { turnId, toolResponse: { output } });
  /** What one record costs the window: itself, its comma, and a new turn id. */
  const cost = (entry: unknown, newTurnId?: string) =>
    Buffer.byteLength(JSON.stringify(entry), 'utf8') +
    1 +
    (newTurnId === undefined
      ? 0
      : Buffer.byteLength(JSON.stringify(newTurnId), 'utf8') + 1);

  it('reads the transcript tail newest first, across turns and provenances', () => {
    const window = build([
      record('choice', 'user', {
        turnId: 'turn-1',
        provenance: 'real_user',
        text: 'Use the second option',
      }),
      tool('earlier-tool', 'turn-2', 'earlier pass'),
      record('said', 'assistant', { turnId: 'turn-3', text: 'Running it.' }),
      tool('closing-tool', 'turn-3', 'Tests 412 passed'),
    ]);

    expect(window.evidence.map((entry) => entry.uuid)).toEqual([
      'closing-tool',
      'said',
      'earlier-tool',
      'choice',
    ]);
    expect(window.evidence.map((entry) => entry.proofKind)).toEqual([
      'external_fact',
      'delivered_output',
      'external_fact',
      'user_input',
    ]);
    expect(window.turnIds).toEqual(['turn-1', 'turn-2', 'turn-3']);
    expect(window.omitted).toBe(0);
  });

  it('takes only records of this Goal revision, after the cursor, with a coherent provenance and visible content', () => {
    const window = buildGoalVerifierEvidenceWindow(
      {
        records: [
          tool('before-cursor', 'turn-1', 'stale'),
          cursor(),
          tool('other-revision', 'turn-1', 'no'),
          record('outside-goal', 'user', {
            provenance: 'real_user',
            text: 'typed while no Goal turn ran',
          }),
          record('runtime-read', 'tool_result', {
            turnId: 'turn-3',
            provenance: 'goal_runtime',
            toolResponse: { active: true },
          }),
          record('only-thought', 'assistant', {
            turnId: 'turn-3',
            thought: 'hidden',
          }),
          tool('kept', 'turn-3', 'ok'),
        ].map((entry) =>
          entry.uuid === 'other-revision'
            ? record('other-revision', 'tool_result', {
                turnId: 'turn-1',
                revision: REVISION - 1,
                toolResponse: { output: 'no' },
              })
            : entry,
        ),
        goal: goal(),
        permit: permit(),
      },
      { budgetBytes: 256_000 },
    );

    expect(window.evidence.map((entry) => entry.uuid)).toEqual(['kept']);
    expect(window.turnIds).toEqual(['turn-3']);
    // Records that were never candidates are not "left out".
    expect(window.omitted).toBe(0);
  });

  it('stops at the first record that does not fit and counts every older candidate as omitted', () => {
    const records = [
      tool('oldest', 'turn-1', 'a'),
      tool('small-but-older', 'turn-2', 'b'),
      tool('too-big', 'turn-2', 'x'.repeat(2_000)),
      tool('newest', 'turn-3', 'done'),
    ];
    const newest = build(records).evidence[0]!;
    const budget = cost(newest, 'turn-3') + 200;

    const window = build(records, budget);

    // `small-but-older` would fit, but the window is a contiguous tail: a
    // gap in the middle would make `omitted` mean something other than
    // "older than everything present".
    expect(window.evidence.map((entry) => entry.uuid)).toEqual(['newest']);
    expect(window.turnIds).toEqual(['turn-3']);
    expect(window.omitted).toBe(3);
  });

  it('spends the budget on the serialized record, its comma and each new turn id, to the byte', () => {
    const records = [
      tool('older', 'turn-2', 'é"\n'.repeat(50)),
      tool('newer', 'turn-3', 'ok'),
    ];
    const [newer, older] = build(records).evidence;
    const exact = cost(newer, 'turn-3') + cost(older, 'turn-2');

    expect(build(records, exact).evidence).toHaveLength(2);
    const short = build(records, exact - 1);
    expect(short.evidence.map((entry) => entry.uuid)).toEqual(['newer']);
    expect(short.omitted).toBe(1);

    // A second record of a turn already listed does not pay for the id again.
    const sameTurn = [tool('a', 'turn-3', '1'), tool('b', 'turn-3', '2')];
    const [b, a] = build(sameTurn).evidence;
    expect(build(sameTurn, cost(b, 'turn-3') + cost(a)).evidence).toHaveLength(
      2,
    );
  });

  it('counts what it leaves out without rendering it', () => {
    const exploding = {
      ...tool('oldest', 'turn-1', 'unused'),
      message: {
        get parts(): never {
          throw new Error('an omitted record was rendered');
        },
      },
    } as unknown as GoalEvidenceRecord;
    const newest = tool('newest', 'turn-3', 'ok');
    const budget = cost(build([newest]).evidence[0], 'turn-3');

    // `does-not-fit` has to be rendered to be measured; everything older
    // than it is only counted.
    const window = build(
      [exploding, tool('does-not-fit', 'turn-2', 'x'.repeat(500)), newest],
      budget + 5,
    );

    expect(window.evidence.map((entry) => entry.uuid)).toEqual(['newest']);
    expect(window.omitted).toBe(2);
  });

  it('returns an empty window when nothing fits or nothing was recorded', () => {
    expect(build([tool('only', 'turn-3', 'ok')], 10)).toEqual({
      evidence: [],
      turnIds: [],
      omitted: 1,
    });
    expect(build([])).toEqual({ evidence: [], turnIds: [], omitted: 0 });
  });

  it('cuts a long record in the middle, keeping the command and the summary line', () => {
    const output = `$ npm test\n${'noise line\n'.repeat(3_000)}Tests 412 passed`;
    const [entry] = build([tool('long', 'turn-3', output)]).evidence;

    expect(Buffer.byteLength(entry!.content, 'utf8')).toBeLessThanOrEqual(
      8_000,
    );
    expect(entry!.content).toContain('$ npm test');
    expect(entry!.content).toContain('[middle truncated]');
    expect(entry!.content.slice(-40)).toContain('Tests 412 passed');
  });

  it('cuts on code point boundaries on both sides of the marker', () => {
    const [entry] = build([
      record('emoji', 'assistant', {
        turnId: 'turn-3',
        text: '😀'.repeat(4_000),
      }),
    ]).evidence;

    expect(entry!.content).not.toContain('�');
    expect(entry!.content.replace(/\n…\[middle truncated\]\n/, '')).toMatch(
      /^(?:😀)+$/u,
    );
  });

  it('leaves a record at the limit untouched', () => {
    const text = 'y'.repeat(8_000);
    const [entry] = build([
      record('exact', 'assistant', { turnId: 'turn-3', text }),
    ]).evidence;

    expect(entry!.content).toBe(text);
  });

  it('refuses a transcript the window cannot be anchored in', () => {
    const code = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return (error as EvidenceSourceUnavailableError).code;
      }
      return undefined;
    };

    expect(code(() => build([], 256_000, permit(), goal(null)))).toBe(
      'cursor_unset',
    );
    expect(code(() => build([], 256_000, permit(), goal('gone')))).toBe(
      'cursor_not_found',
    );
    expect(
      code(() =>
        build([tool('dup', 'turn-3', '1'), tool('dup', 'turn-3', '2')]),
      ),
    ).toBe('duplicate_record_uuid');
    expect(
      code(() => build([], 256_000, { ...permit(), revision: REVISION + 1 })),
    ).toBe('permit_goal_mismatch');
  });

  it('does not require the current turn to have recorded anything, or to be the newest turn', () => {
    // The lineage checks the citation path needed are not the window's: it
    // reads whatever this Goal revision recorded, newest first.
    const window = build(
      [tool('previous', 'turn-2', 'ok')],
      256_000,
      permit('turn-3'),
    );

    expect(window.evidence.map((entry) => entry.uuid)).toEqual(['previous']);
  });
});
