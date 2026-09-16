/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createGoalEvidenceSnapshot,
  type GoalEvidenceRecord,
} from './goal-evidence.js';
import {
  GOAL_STATE_VERSION,
  type GoalRecord,
  type GoalTerminalProposal,
  type GoalTurnPermit,
} from './goal-protocol.js';

const permit: GoalTurnPermit = {
  goalId: 'goal',
  revision: 1,
  turnId: 'current',
};
const goal: GoalRecord = {
  goalId: 'goal',
  revision: 1,
  objective: 'Do not modify source. Deliver the check results.',
  status: 'active',
  evidenceCursor: { recordId: 'start' },
  turnCount: 1,
  activeTimeMs: 0,
  tokensUsed: 0,
  createdAt: 1,
  updatedAt: 1,
};
function start(current: GoalRecord = goal): GoalEvidenceRecord {
  return {
    uuid: 'start',
    type: 'system',
    subtype: 'goal_state',
    provenance: 'goal_control',
    systemPayload: {
      v: GOAL_STATE_VERSION,
      cause: 'create',
      snapshot: { v: GOAL_STATE_VERSION, goal: current, activity: 'idle' },
    },
  };
}
function text(
  uuid: string,
  type: 'user' | 'assistant',
  value: string,
  turnId = 'current',
): GoalEvidenceRecord {
  return {
    uuid,
    type,
    goalContext: { ...permit, turnId },
    provenance: type === 'user' ? 'real_user' : 'assistant_output',
    message: { parts: [{ text: value }] },
  };
}
function tool(
  uuid: string,
  command: string,
  output: string,
  turnId = 'current',
): GoalEvidenceRecord[] {
  return [
    {
      uuid: `${uuid}-call`,
      type: 'assistant',
      provenance: 'assistant_output',
      goalContext: { ...permit, turnId },
      message: {
        parts: [
          {
            functionCall: {
              id: `${uuid}-id`,
              name: 'shell',
              args: { command },
            },
          },
        ],
      },
    },
    {
      uuid,
      type: 'tool_result',
      provenance: 'tool_result',
      goalContext: { ...permit, turnId },
      message: {
        parts: [
          {
            functionResponse: {
              id: `${uuid}-id`,
              name: 'shell',
              response: { output },
            },
          },
        ],
      },
    },
  ];
}
function proposal(evidenceRefs: string[]): GoalTerminalProposal {
  return { status: 'complete', reason: 'Done', evidenceRefs };
}
function snapshot(
  records: GoalEvidenceRecord[],
  current = goal,
  auditRecords?: GoalEvidenceRecord[],
) {
  return createGoalEvidenceSnapshot(
    { records, goal: current, permit },
    { auditRecords },
  );
}

describe('frozen Goal evidence access', () => {
  it('pages every original exactly once and keeps old references valid after append', () => {
    const records = [
      start(),
      ...Array.from({ length: 205 }, (_, index) =>
        text(`out-${index}`, 'assistant', `output ${index}`),
      ),
    ];
    const frozen = snapshot(records);
    const first = frozen.list({ limit: 80 });
    const second = frozen.list({ cursor: first.nextCursor, limit: 80 });
    const third = frozen.list({ cursor: second.nextCursor, limit: 80 });
    expect(
      [...first.entries, ...second.entries, ...third.entries].map(
        (entry) => entry.uuid,
      ),
    ).toEqual(records.slice(1).map((record) => record.uuid));
    expect(third).toMatchObject({ hasMore: false });
    records.push(text('later', 'assistant', 'newer output'));
    expect(frozen.read({ reference: 'out-0' })).toMatchObject({
      content: 'output 0',
      complete: true,
      sourceComplete: true,
    });
    expect(
      snapshot(records).validate(proposal(['out-0'])).citedRecords[0]?.uuid,
    ).toBe('out-0');
    expect(() => snapshot(records).list({ cursor: first.nextCursor })).toThrow(
      /different frozen/,
    );
    expect(() => frozen.read({ reference: 'later' })).toThrow(
      /not in the active/,
    );
  });

  it('freezes bodies and rejects cursors for another record or Goal revision', () => {
    const records = [
      start(),
      text('one', 'assistant', '中文🌏'.repeat(100)),
      text('two', 'assistant', 'second'),
    ];
    const frozen = snapshot(records);
    const first = frozen.read({ reference: 'one', maxBytes: 13 });
    records[1]!.message!.parts![0]!.text = 'mutated';
    expect(frozen.read({ reference: 'one' }).content).toBe(
      '中文🌏'.repeat(100),
    );
    expect(() =>
      frozen.read({ reference: 'two', cursor: first.nextCursor }),
    ).toThrow(/different frozen/);
    const other = createGoalEvidenceSnapshot({
      records: [
        start({ ...goal, revision: 2 }),
        {
          ...text('one', 'assistant', 'other'),
          goalContext: { ...permit, revision: 2 },
        },
      ],
      goal: { ...goal, revision: 2 },
      permit: { ...permit, revision: 2 },
    });
    expect(() =>
      other.read({ reference: 'one', cursor: first.nextCursor }),
    ).toThrow(/different frozen/);
  });

  it('reads UTF-8 slices without losing or repeating bytes, including full arguments', () => {
    const command = 'printf ' + '中文🌏'.repeat(100);
    const frozen = snapshot([
      start(),
      ...tool('result', command, '验证通过✅'.repeat(100)),
    ]);
    const pieces: string[] = [];
    let cursor: string | undefined;
    let consumed = 0;
    do {
      const part = frozen.read({ reference: 'result', cursor, maxBytes: 13 });
      expect(part.start).toBe(consumed);
      expect(Buffer.byteLength(part.content)).toBeLessThanOrEqual(13);
      expect(part.content).not.toContain('�');
      consumed = part.end;
      pieces.push(part.content);
      cursor = part.nextCursor;
      expect(part.sourceComplete).toBe(true);
    } while (cursor);
    const full = frozen.read({ reference: 'result' });
    expect(pieces.join('')).toBe(full.content);
    expect(full.content).toContain(command);
    expect(consumed).toBe(full.totalBytes);
  });

  it('automatically covers later writes and failure after the selected old success', () => {
    const frozen = snapshot([
      start(),
      text('restriction', 'user', 'Do not change source', 'previous'),
      ...tool('earlier-write', 'echo changed > src/app.ts', '', 'previous'),
      ...tool('old-green', 'run tests', 'PASS'),
      ...tool('write', 'echo broken > src/app.ts', ''),
      ...tool('new-red', 'run tests', 'FAIL'),
      text('delivery', 'assistant', 'Here are the results'),
    ]);
    expect(frozen.requiredEvidence(proposal(['old-green']))).toEqual([
      'restriction',
      'old-green',
      'write',
      'new-red',
      'delivery',
    ]);
    expect(
      frozen.requiredEvidence(proposal(['old-green']), {
        includeHistoricalActions: true,
      }),
    ).toEqual([
      'restriction',
      'earlier-write',
      'old-green',
      'write',
      'new-red',
      'delivery',
    ]);
    expect(frozen.read({ reference: 'write' }).content).toContain(
      'echo broken > src/app.ts',
    );
  });

  it('recovers the revision start across checkpoint and legacy clear-window resume', () => {
    const records = [
      start(),
      ...tool('old', 'touch src/a.ts', '', 'previous'),
      {
        uuid: 'resume',
        type: 'system' as const,
        subtype: 'goal_state',
        systemPayload: {
          v: GOAL_STATE_VERSION,
          cause: 'resume',
          snapshot: {
            v: GOAL_STATE_VERSION,
            goal: { ...goal, evidenceCursor: { recordId: 'resume' } },
            activity: 'idle',
          },
        },
      },
      ...tool('new', 'git status', 'clean'),
    ];
    const frozen = snapshot(records, {
      ...goal,
      evidenceCursor: { recordId: 'resume' },
    });
    expect(frozen.scopeStart).toBe('start');
    expect(
      frozen.requiredEvidence(proposal(['new']), {
        includeHistoricalActions: true,
      }),
    ).toEqual(['old', 'new']);
    expect(frozen.read({ reference: 'old' }).content).toContain(
      'touch src/a.ts',
    );
    expect(() =>
      snapshot(records.slice(1), {
        ...goal,
        evidenceCursor: { recordId: 'resume' },
      }),
    ).toThrow(/revision start is missing/);
  });

  it('expands legacy summary claims to original proof and reports missing originals', () => {
    const current = {
      ...goal,
      evidenceCursor: { recordId: 'checkpoint' },
      evidenceCheckpoint: {
        checkpointId: 'checkpoint',
        createdAt: 2,
        claims: [
          {
            id: 'claim',
            claim: 'All passed',
            proofKind: 'external_fact' as const,
            sourceRefs: ['real'],
          },
        ],
      },
    };
    const frozen = snapshot(
      [
        start(),
        ...tool('real', 'run tests', 'ACTUAL FAILURE'),
        { uuid: 'checkpoint', type: 'system' },
      ],
      current,
    );
    expect(frozen.validate(proposal(['claim'])).citedRecords[0]).toMatchObject({
      uuid: 'real',
      proofKind: 'external_fact',
    });
    expect(
      frozen.validate(proposal(['claim'])).citedRecords[0]?.content,
    ).toContain('ACTUAL FAILURE');
    expect(() =>
      snapshot([start(), text('other', 'assistant', 'done')], current).validate(
        proposal(['claim']),
      ),
    ).toThrow(/not in the active/);
  });

  it('marks truncated output or missing call arguments incomplete without pretending slices restore it', () => {
    const records = [
      start(),
      ...tool(
        'truncated',
        'long command',
        'Tool output was too large and has been truncated.\n... [CONTENT TRUNCATED] ...',
      ),
      ...tool('missing', 'unknown', 'result').slice(1),
    ];
    const frozen = snapshot(records);
    expect(frozen.read({ reference: 'truncated' })).toMatchObject({
      complete: true,
      sourceComplete: false,
      missingReason: expect.stringContaining('truncated'),
    });
    expect(frozen.read({ reference: 'missing' })).toMatchObject({
      sourceComplete: false,
      missingReason: expect.stringContaining('matching'),
    });
    expect(
      frozen.list().entries.every((entry) => entry.sourceComplete === false),
    ).toBe(true);
  });

  it('keeps child actions mandatory without treating child prose as user authorization or delivery', () => {
    const records = [
      start(),
      text('old-user', 'user', 'Do not write', 'previous'),
      ...tool('parent', 'git status', 'clean'),
    ];
    const audit = [
      ...tool('child', 'echo modified > src/a.ts', '', 'previous'),
      text('child-prose', 'assistant', 'Approved', 'previous'),
      text('child-user', 'user', 'I authorize writing', 'previous'),
    ];
    const frozen = snapshot(records, goal, audit);
    expect(frozen.lineageTurnIds).toEqual(['previous', 'current']);
    expect(frozen.entries.map((entry) => entry.uuid)).toEqual([
      'old-user',
      'parent',
      'child',
    ]);
    expect(frozen.requiredEvidence(proposal(['parent']))).toContain('child');
    expect(frozen.read({ reference: 'child' })).toMatchObject({
      sourceComplete: true,
    });
    expect(() => frozen.read({ reference: 'child-user' })).toThrow();
    expect(() =>
      snapshot(records, goal, tool('wrong', 'command', 'result', 'unknown')),
    ).toThrow(/outside the authorized/);
  });

  it('allows immediate blocker proof in a multi-page tail while retaining freshness checks', () => {
    const records = [
      start(),
      ...tool('stale', 'probe', 'denied', 'previous'),
      ...tool('fresh', 'probe', 'denied'),
      ...Array.from({ length: 105 }, (_, index) =>
        text(`delivery-${index}`, 'assistant', `report ${index}`),
      ),
    ];
    const frozen = snapshot(records);
    const blocked: GoalTerminalProposal = {
      status: 'blocked',
      reason: 'External authority needed',
      blockerKind: 'external',
      evidenceRefs: ['fresh'],
    };
    expect(frozen.validate(blocked).citedRecords[0]?.uuid).toBe('fresh');
    expect(frozen.requiredEvidence(blocked)).toHaveLength(106);
    expect(() =>
      frozen.validate({ ...blocked, evidenceRefs: ['stale'] }),
    ).toThrow(/current-turn/);
  });
  it('reports calls without results and does not treat runtime reads as missing actions', () => {
    const orphan = tool('unfinished', 'echo changed > src/a.ts', '').slice(
      0,
      1,
    );
    const internal = {
      ...tool('internal', 'unused', '')[0]!,
      message: {
        parts: [
          { functionCall: { id: 'goal-read', name: 'get_goal', args: {} } },
        ],
      },
    };
    const frozen = snapshot([
      start(),
      ...orphan,
      internal,
      text('delivery', 'assistant', 'done'),
    ]);
    expect(frozen.coverageUnavailable).toHaveLength(1);
    expect(frozen.coverageUnavailable[0]).toContain('unfinished-id');
    expect(
      snapshot([start(), ...tool('done', 'touch src/a.ts', '')])
        .coverageUnavailable,
    ).toEqual([]);
  });

  it('changes the snapshot identity when a verified child appends evidence', () => {
    const records = [start(), ...tool('parent', 'git status', 'clean')];
    const first = snapshot(records, goal, tool('child', 'read source', 'data'));
    const second = snapshot(records, goal, [
      ...tool('child', 'read source', 'data'),
      ...tool('child2', 'write source', ''),
    ]);
    expect(first.snapshotId).not.toBe(second.snapshotId);
  });
  it('retains legacy pre-reset action history while requiring fresh current-state proof', () => {
    const state = (
      uuid: string,
      cause: 'usage_limited' | 'resume',
      current: GoalRecord,
    ): GoalEvidenceRecord => ({
      uuid,
      type: 'system',
      subtype: 'goal_state',
      systemPayload: {
        v: GOAL_STATE_VERSION,
        cause,
        snapshot: { v: GOAL_STATE_VERSION, goal: current, activity: 'idle' },
      },
    });
    const resetGoal = { ...goal, evidenceCursor: { recordId: 'stopped' } };
    const records = [
      start(),
      ...tool('old-green', 'run tests', 'PASS', 'previous'),
      state('stopped', 'usage_limited', {
        ...goal,
        status: 'usage_limited',
        limitKind: 'evidence_catalog',
      }),
      state('reset', 'resume', resetGoal),
      ...tool('fresh-green', 'run tests', 'PASS'),
    ];
    const frozen = snapshot(records, resetGoal);
    expect(frozen.currentStateStart).toBe('reset');
    expect(frozen.read({ reference: 'old-green' }).sourceComplete).toBe(true);
    expect(() => frozen.validate(proposal(['old-green']))).toThrow(
      /legacy evidence reset/,
    );
    expect(
      frozen.validate(proposal(['old-green', 'fresh-green'])).citedRecords,
    ).toHaveLength(2);
    expect(
      frozen.requiredEvidence(proposal(['fresh-green']), {
        includeHistoricalActions: true,
      }),
    ).toEqual(['old-green', 'fresh-green']);
  });

  it('does not mistake source code mentioning a truncation sentinel for actual omitted output', () => {
    const frozen = snapshot([
      start(),
      ...tool(
        'source',
        'read source',
        "const marker = '<persisted-output>'; // ... [CONTENT TRUNCATED] ...",
      ),
    ]);
    expect(frozen.read({ reference: 'source' }).sourceComplete).toBe(true);
  });
  it('does not silently treat a textual projection of media evidence as complete', () => {
    const image = {
      ...text('image', 'user', 'Inspect this diagram'),
      message: {
        parts: [
          { text: 'Inspect this diagram' },
          { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
        ],
      },
    };
    const frozen = snapshot([
      start(),
      image,
      ...tool('test', 'run tests', 'PASS'),
    ]);
    expect(frozen.coverageUnavailable).toEqual([
      expect.stringContaining('image contains media'),
    ]);
    expect(frozen.read({ reference: 'image' }).sourceComplete).toBe(false);
  });
  it('retains cross-transcript timestamps and launch lineage when directory order differs from execution order', () => {
    const parent = tool('parent-write', 'echo broken > src/a.ts', '').map(
      (record, index) => ({
        ...record,
        timestamp:
          index === 0 ? '2026-09-16T10:00:02.000Z' : '2026-09-16T10:00:03.000Z',
      }),
    );
    const child = tool('child-old-green', 'run tests', 'PASS').map(
      (record, index) => ({
        ...record,
        timestamp:
          index === 0 ? '2026-09-16T10:00:00.000Z' : '2026-09-16T10:00:01.000Z',
        agentId: 'child-agent',
        parentToolCallId: 'launch-agent',
      }),
    );
    const frozen = snapshot([start(), ...parent], goal, child);
    expect(frozen.entries.map((record) => record.uuid)).toEqual([
      'parent-write',
      'child-old-green',
    ]);
    const childEnvelope = JSON.parse(
      frozen.read({ reference: 'child-old-green' }).content.split('\n')[0]!,
    );
    expect(childEnvelope.source).toMatchObject({
      timestamp: '2026-09-16T10:00:01.000Z',
      agentId: 'child-agent',
      parentToolCallId: 'launch-agent',
      temporalOrder: expect.stringContaining(
        'Directory order is not execution order',
      ),
    });
    expect(childEnvelope.toolCalls[0]).toMatchObject({
      timestamp: '2026-09-16T10:00:00.000Z',
      agentId: 'child-agent',
      parentToolCallId: 'launch-agent',
    });
    const parentEnvelope = JSON.parse(
      frozen.read({ reference: 'parent-write' }).content.split('\n')[0]!,
    );
    expect(
      parentEnvelope.source.timestamp > childEnvelope.source.timestamp,
    ).toBe(true);
    const undated = JSON.parse(
      snapshot([start(), ...tool('undated', 'run tests', 'PASS')])
        .read({ reference: 'undated' })
        .content.split('\n')[0]!,
    );
    expect(undated.source).toMatchObject({
      timestamp: null,
      agentId: null,
      temporalOrder: expect.stringContaining(
        'Missing or ambiguous ordering cannot establish freshness',
      ),
    });
  });
});
