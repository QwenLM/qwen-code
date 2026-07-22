/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Part } from '@google/genai';
import type {
  ChatRecord,
  ChatRecordProvenance,
} from '../services/chatRecordingService.js';
import type {
  GoalRecord,
  GoalTerminalProposal,
  GoalTurnPermit,
} from './goal-protocol.js';
import {
  buildGoalEvidenceCatalog,
  EvidenceSourceUnavailableError,
  InvalidGoalEvidenceReferenceError,
  validateGoalEvidenceReferences,
} from './goal-evidence.js';

const GOAL_ID = 'goal-1';
const REVISION = 2;

interface RecordOptions {
  provenance?: ChatRecordProvenance;
  subtype?: ChatRecord['subtype'];
  goalId?: string;
  revision?: number;
  turnId?: string;
  text?: string;
  toolResponse?: Record<string, unknown>;
  thought?: string;
}

function record(
  uuid: string,
  type: ChatRecord['type'],
  options: RecordOptions = {},
): ChatRecord {
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

  return {
    uuid,
    parentUuid: null,
    sessionId: 'session-1',
    timestamp: '2026-07-21T00:00:00.000Z',
    type,
    ...(options.provenance === undefined
      ? {}
      : { provenance: options.provenance }),
    ...(options.subtype === undefined ? {} : { subtype: options.subtype }),
    ...(options.turnId === undefined
      ? {}
      : {
          goalContext: {
            goalId: options.goalId ?? GOAL_ID,
            revision: options.revision ?? REVISION,
            turnId: options.turnId,
          },
        }),
    cwd: '/workspace',
    version: '1.0.0',
    ...(parts.length === 0
      ? {}
      : {
          message: {
            role: type === 'assistant' ? 'model' : 'user',
            parts,
          },
        }),
  };
}

function chain(records: ChatRecord[]): ChatRecord[] {
  return records.map((value, index) => ({
    ...value,
    parentUuid: index === 0 ? null : records[index - 1]!.uuid,
  }));
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
    createdAt: 1,
    updatedAt: 2,
  };
}

function permit(turnId = 'turn-3'): GoalTurnPermit {
  return { goalId: GOAL_ID, revision: REVISION, turnId };
}

function complete(evidenceRefs: string[]): GoalTerminalProposal {
  return {
    status: 'complete',
    reason: 'The requested result was delivered and verified.',
    evidenceRefs,
  };
}

function blocked(
  blockerKind: 'authority' | 'external' | 'repeated',
  evidenceRefs: string[],
): GoalTerminalProposal {
  return {
    status: 'blocked',
    reason: 'No meaningful in-scope work remains without the cited change.',
    evidenceRefs,
    blockerKind,
  };
}

function validate(
  records: ChatRecord[],
  proposal: GoalTerminalProposal,
  currentPermit = permit(),
  currentGoal = goal(),
) {
  return validateGoalEvidenceReferences({
    records: chain(records),
    goal: currentGoal,
    permit: currentPermit,
    proposal,
  });
}

describe('Goal evidence catalog', () => {
  it('keeps delivered output from earlier Goal turns citable', () => {
    const records = [
      record('cursor', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
      }),
      record('letter-t-1', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-1',
        text: 't',
      }),
      record('letter-e', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-2',
        text: 'e',
      }),
      record('letter-s', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-3',
        text: 's',
      }),
      record('letter-t-2', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-4',
        text: 't',
      }),
      record('continuation', 'user', {
        provenance: 'goal_runtime',
        subtype: 'goal_runtime',
        turnId: 'turn-5',
        text: 'Continue working on the active Goal.',
      }),
    ];
    const currentPermit = permit('turn-5');

    const catalog = buildGoalEvidenceCatalog({
      records: chain(records),
      goal: goal(),
      permit: currentPermit,
    });

    expect(catalog.entries).toMatchObject([
      { uuid: 'letter-t-1', proofKind: 'delivered_output' },
      { uuid: 'letter-e', proofKind: 'delivered_output' },
      { uuid: 'letter-s', proofKind: 'delivered_output' },
      { uuid: 'letter-t-2', proofKind: 'delivered_output' },
    ]);
    expect(
      validate(
        records,
        complete(['letter-t-1', 'letter-e', 'letter-s', 'letter-t-2']),
        currentPermit,
      ).citedRecords.map((entry) => entry.content),
    ).toEqual(['t', 'e', 's', 't']);
  });

  it('uses the stable cursor and includes only later records', () => {
    const records = [
      record('before', 'user', {
        provenance: 'real_user',
        turnId: 'turn-0',
        text: 'old input',
      }),
      record('cursor', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
      }),
      record('after', 'user', {
        provenance: 'real_user',
        turnId: 'turn-3',
        text: 'new input',
      }),
    ];

    const catalog = buildGoalEvidenceCatalog({
      records: chain(records),
      goal: goal(),
      permit: permit(),
    });

    expect(catalog).toEqual({
      entries: [
        {
          uuid: 'after',
          provenance: 'real_user',
          turnId: 'turn-3',
          preview: 'new input',
          proofKind: 'user_input',
        },
      ],
      lineageTurnIds: ['turn-3'],
    });
    expect(() => validate(records, complete(['before']))).toThrowError(
      expect.objectContaining({
        name: 'InvalidGoalEvidenceReferenceError',
        code: 'pre_cursor_reference',
        reference: 'before',
      }),
    );
    expect(() => validate(records, complete(['cursor']))).toThrowError(
      expect.objectContaining({
        name: 'InvalidGoalEvidenceReferenceError',
        code: 'pre_cursor_reference',
        reference: 'cursor',
      }),
    );
  });

  it.each([
    ['cursor_unset', null, ['root']],
    ['cursor_not_found', 'absent', ['root']],
  ] as const)(
    'reports %s as an evidence-source failure',
    (code, cursor, recordIds) => {
      const records = recordIds.map((uuid) =>
        record(uuid, 'user', {
          provenance: 'real_user',
          turnId: 'turn-3',
          text: 'input',
        }),
      );

      expect(() =>
        buildGoalEvidenceCatalog({
          records: chain(records),
          goal: goal(cursor),
          permit: permit(),
        }),
      ).toThrowError(
        expect.objectContaining({
          name: 'EvidenceSourceUnavailableError',
          code,
        }),
      );
    },
  );

  it('rejects a terminal proposal without evidence references', () => {
    const records = [
      record('cursor', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
      }),
      record('delivered', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-3',
        text: 'delivered result',
      }),
    ];

    expect(() => validate(records, complete([]))).toThrowError(
      expect.objectContaining({
        name: 'InvalidGoalEvidenceReferenceError',
        code: 'no_evidence_references',
      }),
    );
  });

  it('requires coherent type, subtype, and provenance', () => {
    const records = [
      record('cursor', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
      }),
      record('system', 'system', {
        provenance: 'system',
        turnId: 'turn-3',
        text: 'system claim',
      }),
      record('compression', 'system', {
        provenance: 'system',
        subtype: 'chat_compression',
        turnId: 'turn-3',
      }),
      record('goal-control', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
        turnId: 'turn-3',
      }),
      record('goal-runtime', 'user', {
        provenance: 'goal_runtime',
        subtype: 'goal_runtime',
        turnId: 'turn-3',
        text: 'verifier feedback',
      }),
      record('slash', 'user', {
        provenance: 'real_user',
        subtype: 'slash_command',
        turnId: 'turn-3',
        text: '/goal ...',
      }),
      record('activation', 'user', {
        provenance: 'real_user',
        subtype: 'agent_launch_prompt',
        turnId: 'turn-3',
        text: 'activation prompt',
      }),
      record('mismatch', 'user', {
        provenance: 'assistant_output',
        turnId: 'turn-3',
        text: 'forged assistant output',
      }),
      record('assistant', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-3',
        text: 'real delivery',
      }),
    ];

    const catalog = buildGoalEvidenceCatalog({
      records: chain(records),
      goal: goal(),
      permit: permit(),
    });
    expect(catalog.entries.map((entry) => entry.uuid)).toEqual(['assistant']);

    for (const reference of [
      'system',
      'compression',
      'goal-control',
      'goal-runtime',
      'slash',
      'activation',
      'mismatch',
    ]) {
      expect(() => validate(records, complete([reference]))).toThrowError(
        expect.objectContaining({
          name: 'InvalidGoalEvidenceReferenceError',
          code: 'ineligible_reference',
          reference,
        }),
      );
    }
  });

  it('derives only legacy-safe provenance and still requires Goal context', () => {
    const records = [
      record('cursor', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
      }),
      record('legacy-user', 'user', {
        turnId: 'turn-2',
        text: 'approval is required',
      }),
      record('legacy-tool', 'tool_result', {
        turnId: 'turn-2',
        toolResponse: { output: 'remote is unavailable' },
      }),
      record('legacy-assistant', 'assistant', {
        turnId: 'turn-3',
        text: 'delivered text',
      }),
      record('unowned', 'tool_result', {
        toolResponse: { output: 'cannot attribute this result' },
      }),
    ];

    const catalog = buildGoalEvidenceCatalog({
      records: chain(records),
      goal: goal(),
      permit: permit(),
    });
    expect(catalog.entries).toMatchObject([
      { uuid: 'legacy-user', provenance: 'real_user' },
      { uuid: 'legacy-tool', provenance: 'tool_result' },
      { uuid: 'legacy-assistant', provenance: 'assistant_output' },
    ]);
    expect(() => validate(records, complete(['unowned']))).toThrowError(
      expect.objectContaining({
        code: 'missing_goal_context',
        reference: 'unowned',
      }),
    );
  });

  it('keeps previews bounded and reveals full content only after validation', () => {
    const longText = `${'a'.repeat(400)}TAIL`;
    const records = [
      record('cursor', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
      }),
      record('user', 'user', {
        provenance: 'real_user',
        turnId: 'turn-2',
        text: 'Please implement it',
      }),
      record('tool', 'tool_result', {
        provenance: 'tool_result',
        turnId: 'turn-2',
        toolResponse: { output: longText, exitCode: 0 },
      }),
      record('assistant', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-3',
        thought: 'private reasoning',
        text: 'Here is the requested output',
      }),
    ];

    const result = validate(records, complete(['tool', 'assistant']));

    expect(
      result.catalog.find((entry) => entry.uuid === 'tool')?.preview.length,
    ).toBeLessThanOrEqual(240);
    expect(
      result.catalog.find((entry) => entry.uuid === 'tool')?.preview,
    ).not.toContain('TAIL');
    expect(result.citedRecords).toMatchObject([
      {
        uuid: 'tool',
        proofKind: 'external_fact',
        provenance: 'tool_result',
        turnId: 'turn-2',
      },
      {
        uuid: 'assistant',
        proofKind: 'delivered_output',
        provenance: 'assistant_output',
        turnId: 'turn-3',
        content: 'Here is the requested output',
      },
    ]);
    expect(result.citedRecords[0]?.content).toContain('TAIL');
    expect(result.citedRecords[1]?.content).not.toContain('private reasoning');
    expect(JSON.stringify(result.catalog)).not.toContain('TAIL');
  });

  it('keeps proof kinds distinct so assistant output cannot become external proof', () => {
    const records = [
      record('cursor', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
      }),
      record('assistant', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-3',
        text: 'I ran tests and changed the remote deployment.',
      }),
    ];

    expect(validate(records, complete(['assistant']))).toMatchObject({
      citedRecords: [
        {
          uuid: 'assistant',
          proofKind: 'delivered_output',
          provenance: 'assistant_output',
        },
      ],
    });
  });
});

describe('Goal evidence reference validation', () => {
  it('rejects missing UUIDs before verification', () => {
    const records = [
      record('cursor', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
      }),
      record('assistant', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-3',
        text: 'done',
      }),
    ];

    expect(() => validate(records, complete(['missing']))).toThrowError(
      expect.objectContaining({
        name: 'InvalidGoalEvidenceReferenceError',
        code: 'missing_reference',
        reference: 'missing',
      }),
    );
  });

  it.each([
    ['wrong_goal_id', { goalId: 'other-goal' }],
    ['wrong_revision', { revision: REVISION - 1 }],
  ] as const)('rejects %s references', (code, override) => {
    const records = [
      record('cursor', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
      }),
      record('wrong', 'tool_result', {
        provenance: 'tool_result',
        turnId: 'turn-2',
        toolResponse: { output: 'result' },
        ...override,
      }),
      record('current', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-3',
        text: 'current output',
      }),
    ];

    expect(() => validate(records, complete(['wrong']))).toThrowError(
      expect.objectContaining({
        name: 'InvalidGoalEvidenceReferenceError',
        code,
        reference: 'wrong',
      }),
    );
  });

  it('allows evidence from earlier turns in the active Goal lineage', () => {
    const records = [
      record('cursor', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
      }),
      record('old-user', 'user', {
        provenance: 'real_user',
        turnId: 'turn-1',
        text: 'I cannot grant that permission',
      }),
      record('old-assistant', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-1',
        text: 'old self-report',
      }),
      record('old-tool', 'tool_result', {
        provenance: 'tool_result',
        turnId: 'turn-2',
        toolResponse: { output: 'permission denied' },
      }),
      record('current-assistant', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-3',
        text: 'current delivery',
      }),
    ];

    expect(
      validate(
        records,
        complete([
          'old-user',
          'old-assistant',
          'old-tool',
          'current-assistant',
        ]),
      ).citedRecords,
    ).toMatchObject([
      { uuid: 'old-user', proofKind: 'user_input' },
      { uuid: 'old-assistant', proofKind: 'delivered_output' },
      { uuid: 'old-tool', proofKind: 'external_fact' },
      { uuid: 'current-assistant', proofKind: 'delivered_output' },
    ]);
  });

  it('rejects turn re-entry and a current permit that is not the lineage tail', () => {
    const reentered = [
      record('cursor', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
      }),
      record('a-1', 'user', {
        provenance: 'real_user',
        turnId: 'turn-a',
        text: 'a',
      }),
      record('b', 'tool_result', {
        provenance: 'tool_result',
        turnId: 'turn-b',
        toolResponse: { output: 'b' },
      }),
      record('a-2', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-a',
        text: 'a again',
      }),
    ];

    expect(() =>
      buildGoalEvidenceCatalog({
        records: chain(reentered),
        goal: goal(),
        permit: permit('turn-a'),
      }),
    ).toThrowError(
      expect.objectContaining({
        name: 'EvidenceSourceUnavailableError',
        code: 'turn_reentry',
      }),
    );

    const wrongTail = [
      record('cursor', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
      }),
      record('current', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-3',
        text: 'done',
      }),
      record('later', 'tool_result', {
        provenance: 'tool_result',
        turnId: 'turn-4',
        toolResponse: { output: 'later result' },
      }),
    ];
    expect(() =>
      buildGoalEvidenceCatalog({
        records: chain(wrongTail),
        goal: goal(),
        permit: permit(),
      }),
    ).toThrowError(
      expect.objectContaining({
        name: 'EvidenceSourceUnavailableError',
        code: 'current_turn_not_tail',
      }),
    );
  });

  it('treats malformed owned turn context as an evidence-source failure', () => {
    const malformed = record('malformed', 'tool_result', {
      provenance: 'tool_result',
      toolResponse: { output: 'result' },
    });
    malformed.goalContext = {
      goalId: GOAL_ID,
      revision: REVISION,
    } as GoalTurnPermit;
    const records = [
      record('cursor', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
      }),
      malformed,
      record('current', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-3',
        text: 'done',
      }),
    ];

    expect(() =>
      buildGoalEvidenceCatalog({
        records: chain(records),
        goal: goal(),
        permit: permit(),
      }),
    ).toThrowError(
      expect.objectContaining({
        name: 'EvidenceSourceUnavailableError',
        code: 'malformed_turn_context',
      }),
    );
  });

  it.each(['authority', 'external'] as const)(
    'requires external evidence for an immediate %s blocker',
    (blockerKind) => {
      const records = [
        record('cursor', 'system', {
          provenance: 'goal_control',
          subtype: 'goal_state',
        }),
        record('user', 'user', {
          provenance: 'real_user',
          turnId: 'turn-2',
          text: 'I will not grant production access',
        }),
        record('tool', 'tool_result', {
          provenance: 'tool_result',
          turnId: 'turn-2',
          toolResponse: { output: 'service remains unavailable' },
        }),
        record('assistant', 'assistant', {
          provenance: 'assistant_output',
          turnId: 'turn-3',
          text: 'I need access',
        }),
      ];

      expect(() =>
        validate(records, blocked(blockerKind, ['assistant'])),
      ).toThrowError(
        expect.objectContaining({
          name: 'InvalidGoalEvidenceReferenceError',
          code: 'immediate_blocker_external_evidence_required',
        }),
      );
      expect(
        validate(records, blocked(blockerKind, ['user'])).citedRecords[0],
      ).toMatchObject({ proofKind: 'user_input' });
      expect(
        validate(records, blocked(blockerKind, ['tool'])).citedRecords[0],
      ).toMatchObject({ proofKind: 'external_fact' });
    },
  );

  it('requires repeated blocker evidence from the last three lineage turns', () => {
    const records = [
      record('cursor', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
      }),
      record('turn-0', 'tool_result', {
        provenance: 'tool_result',
        turnId: 'turn-0',
        toolResponse: { output: 'older failure' },
      }),
      record('turn-1', 'tool_result', {
        provenance: 'tool_result',
        turnId: 'turn-1',
        toolResponse: { output: 'first failure' },
      }),
      record('turn-2', 'tool_result', {
        provenance: 'tool_result',
        turnId: 'turn-2',
        toolResponse: { output: 'second failure' },
      }),
      record('turn-3', 'tool_result', {
        provenance: 'tool_result',
        turnId: 'turn-3',
        toolResponse: { output: 'third failure' },
      }),
    ];

    expect(
      validate(records, blocked('repeated', ['turn-1', 'turn-2', 'turn-3']))
        .lineageTurnIds,
    ).toEqual(['turn-0', 'turn-1', 'turn-2', 'turn-3']);
    expect(() =>
      validate(records, blocked('repeated', ['turn-0', 'turn-2', 'turn-3'])),
    ).toThrowError(
      expect.objectContaining({
        name: 'InvalidGoalEvidenceReferenceError',
        code: 'repeated_blocker_turn_coverage',
      }),
    );
    expect(() =>
      validate(records, blocked('repeated', ['turn-1', 'turn-2'])),
    ).toThrowError(
      expect.objectContaining({
        code: 'repeated_blocker_turn_coverage',
      }),
    );

    const selfReports = [
      record('cursor', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
      }),
      record('self-report-1', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-1',
        text: 'Still blocked',
      }),
      record('self-report-2', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-2',
        text: 'Still blocked',
      }),
      record('self-report-3', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-3',
        text: 'Still blocked',
      }),
    ];
    expect(() =>
      validate(
        selfReports,
        blocked('repeated', [
          'self-report-1',
          'self-report-2',
          'self-report-3',
        ]),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'repeated_blocker_turn_coverage',
      }),
    );
  });
});

describe('Goal evidence errors', () => {
  it('keeps source and reference failures distinguishable', () => {
    expect(
      new EvidenceSourceUnavailableError('cursor_unset', 'missing'),
    ).toBeInstanceOf(EvidenceSourceUnavailableError);
    expect(
      new InvalidGoalEvidenceReferenceError(
        'missing_reference',
        'missing',
        'missing',
      ),
    ).toBeInstanceOf(InvalidGoalEvidenceReferenceError);
  });
});
