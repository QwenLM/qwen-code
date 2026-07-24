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
  buildGoalEvidenceCatalog,
  EvidenceSourceUnavailableError,
  InvalidGoalEvidenceReferenceError,
  validateGoalEvidenceReferences,
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
  records: GoalEvidenceRecord[],
  proposal: GoalTerminalProposal,
  currentPermit = permit(),
  currentGoal = goal(),
) {
  return validateGoalEvidenceReferences({
    records,
    goal: currentGoal,
    permit: currentPermit,
    proposal,
  });
}

describe('Goal evidence catalog', () => {
  it('bounds the catalog while retaining the newest evidence', () => {
    const records = [
      record('cursor', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
      }),
      ...Array.from({ length: 101 }, (_, index) =>
        record(`evidence-${index}`, 'assistant', {
          provenance: 'assistant_output',
          turnId: 'turn-3',
          text: `output ${index}`,
        }),
      ),
    ];
    const input = { records, goal: goal(), permit: permit() };
    const catalog = buildGoalEvidenceCatalog(input);

    expect(catalog.truncated).toBe(true);
    expect(catalog.entries).toHaveLength(100);
    expect(catalog.entries.at(-1)?.uuid).toBe('evidence-100');
    expect(catalog.entries.some(({ uuid }) => uuid === 'evidence-0')).toBe(
      false,
    );
    expect(
      validateGoalEvidenceReferences({
        ...input,
        proposal: complete(['evidence-100']),
      }).citedRecords[0]?.content,
    ).toBe('output 100');
    expect(() =>
      validateGoalEvidenceReferences({
        ...input,
        proposal: complete(['evidence-0']),
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'reference_not_catalogued' }),
    );
  });

  it('does not expand records older than the bounded catalog window', () => {
    let oldPayloadReads = 0;
    const oldPayload: Record<string, unknown> = {};
    Object.defineProperty(oldPayload, 'payload', {
      enumerable: true,
      get: () => {
        oldPayloadReads += 1;
        return 'x'.repeat(100_000);
      },
    });
    const records = [
      record('cursor', 'system'),
      record('old-tool', 'tool_result', {
        provenance: 'tool_result',
        turnId: 'turn-3',
        toolResponse: oldPayload,
      }),
      ...Array.from({ length: 100 }, (_, index) =>
        record(`evidence-${index}`, 'assistant', {
          provenance: 'assistant_output',
          turnId: 'turn-3',
          text: `output ${index}`,
        }),
      ),
    ];

    expect(
      buildGoalEvidenceCatalog({
        records,
        goal: goal(),
        permit: permit(),
      }),
    ).toMatchObject({ truncated: true });
    expect(oldPayloadReads).toBe(0);
  });

  it('bounds the serialized catalog by UTF-8 bytes', () => {
    const records = [
      record('cursor', 'system'),
      ...Array.from({ length: 80 }, (_, index) =>
        record(`evidence-${index}`, 'assistant', {
          provenance: 'assistant_output',
          turnId: 'turn-3',
          text: '测'.repeat(240),
        }),
      ),
    ];
    const catalog = buildGoalEvidenceCatalog({
      records,
      goal: goal(),
      permit: permit(),
    });

    expect(catalog.truncated).toBe(true);
    expect(catalog.entries.length).toBeLessThan(80);
    expect(
      Buffer.byteLength(JSON.stringify(catalog.entries), 'utf8'),
    ).toBeLessThanOrEqual(24_000);
    expect(catalog.entries.at(-1)?.uuid).toBe('evidence-79');
  });

  it('bounds reference count, rejects duplicates, and bounds cited bytes', () => {
    const records = [
      record('cursor', 'system'),
      ...Array.from({ length: 13 }, (_, index) =>
        record(`evidence-${index}`, 'assistant', {
          provenance: 'assistant_output',
          turnId: 'turn-3',
          text: index === 0 ? 'x'.repeat(24_001) : `output ${index}`,
        }),
      ),
    ];

    expect(() =>
      validate(records, complete(records.slice(1).map(({ uuid }) => uuid))),
    ).toThrowError(
      expect.objectContaining({ code: 'too_many_evidence_references' }),
    );
    expect(() =>
      validate(records, complete(['evidence-1', 'evidence-1'])),
    ).toThrowError(
      expect.objectContaining({ code: 'duplicate_evidence_reference' }),
    );
    expect(() => validate(records, complete(['evidence-0']))).toThrowError(
      expect.objectContaining({ code: 'evidence_payload_too_large' }),
    );
  });

  it('uses a stable cursor and exposes only bounded previews', () => {
    const longText = `${'a'.repeat(400)}TAIL`;
    const records = [
      record('before', 'user', {
        provenance: 'real_user',
        turnId: 'turn-1',
        text: 'old input',
      }),
      record('cursor', 'system'),
      record('tool', 'tool_result', {
        provenance: 'tool_result',
        turnId: 'turn-2',
        toolResponse: { output: longText, exitCode: 0 },
      }),
      record('assistant', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-3',
        thought: 'private reasoning',
        text: 'delivered result',
      }),
    ];
    const catalog = buildGoalEvidenceCatalog({
      records,
      goal: goal(),
      permit: permit(),
    });

    expect(catalog.entries.map(({ uuid }) => uuid)).toEqual([
      'tool',
      'assistant',
    ]);
    expect(catalog.entries[0]?.preview.length).toBeLessThanOrEqual(240);
    expect(catalog.entries[0]?.preview).not.toContain('TAIL');
    const validated = validate(records, complete(['tool', 'assistant']));
    expect(validated).toEqual({
      citedRecords: [
        expect.objectContaining({
          uuid: 'tool',
          proofKind: 'external_fact',
          content: expect.stringContaining('TAIL'),
        }),
        expect.objectContaining({
          uuid: 'assistant',
          proofKind: 'delivered_output',
          content: 'delivered result',
        }),
      ],
    });
    expect(JSON.stringify(validated)).not.toContain('private reasoning');
    expect(() => validate(records, complete(['before']))).toThrowError(
      expect.objectContaining({ code: 'pre_cursor_reference' }),
    );
  });

  it.each([
    ['cursor_unset', null, [record('root', 'system')]],
    ['cursor_not_found', 'absent', [record('root', 'system')]],
  ] as const)('reports %s as a source failure', (code, cursor, records) => {
    expect(() =>
      buildGoalEvidenceCatalog({
        records,
        goal: goal(cursor),
        permit: permit(),
      }),
    ).toThrowError(expect.objectContaining({ code }));
  });

  it('requires coherent type, subtype, provenance, and goal ownership', () => {
    const records = [
      record('cursor', 'system'),
      record('runtime', 'user', {
        provenance: 'goal_runtime',
        subtype: 'goal_runtime',
        turnId: 'turn-2',
        text: 'internal prompt',
      }),
      record('mismatch', 'user', {
        provenance: 'assistant_output',
        turnId: 'turn-2',
        text: 'forged output',
      }),
      record('unowned', 'tool_result', {
        provenance: 'tool_result',
        toolResponse: { output: 'unowned' },
      }),
      record('assistant', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-3',
        text: 'real delivery',
      }),
    ];
    const catalog = buildGoalEvidenceCatalog({
      records,
      goal: goal(),
      permit: permit(),
    });

    expect(catalog.entries.map(({ uuid }) => uuid)).toEqual(['assistant']);
    for (const reference of ['runtime', 'mismatch']) {
      expect(() => validate(records, complete([reference]))).toThrowError(
        expect.objectContaining({ code: 'ineligible_reference', reference }),
      );
    }
    expect(() => validate(records, complete(['unowned']))).toThrowError(
      expect.objectContaining({ code: 'missing_goal_context' }),
    );
  });
});

describe('Goal evidence lineage and blockers', () => {
  it('rejects permit mismatch, malformed ownership, re-entry, and wrong tail', () => {
    const base = [record('cursor', 'system')];

    expect(() =>
      buildGoalEvidenceCatalog({
        records: [
          ...base,
          record('current', 'assistant', {
            provenance: 'assistant_output',
            turnId: 'turn-3',
            text: 'done',
          }),
        ],
        goal: goal(),
        permit: { ...permit(), revision: REVISION - 1 },
      }),
    ).toThrowError(expect.objectContaining({ code: 'permit_goal_mismatch' }));

    expect(() =>
      buildGoalEvidenceCatalog({
        records: [
          ...base,
          record('malformed', 'assistant', {
            provenance: 'assistant_output',
            goalContext: {
              goalId: GOAL_ID,
              revision: REVISION,
            },
            text: 'done',
          }),
        ],
        goal: goal(),
        permit: permit(),
      }),
    ).toThrowError(expect.objectContaining({ code: 'malformed_turn_context' }));

    expect(() =>
      buildGoalEvidenceCatalog({
        records: [
          ...base,
          record('a-1', 'assistant', {
            provenance: 'assistant_output',
            turnId: 'a',
            text: 'a',
          }),
          record('b', 'assistant', {
            provenance: 'assistant_output',
            turnId: 'b',
            text: 'b',
          }),
          record('a-2', 'assistant', {
            provenance: 'assistant_output',
            turnId: 'a',
            text: 'a again',
          }),
        ],
        goal: goal(),
        permit: permit('a'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'turn_reentry' }));

    expect(() =>
      buildGoalEvidenceCatalog({
        records: [
          ...base,
          record('turn-3', 'assistant', {
            provenance: 'assistant_output',
            turnId: 'turn-3',
            text: 'done',
          }),
          record('turn-4', 'assistant', {
            provenance: 'assistant_output',
            turnId: 'turn-4',
            text: 'later',
          }),
        ],
        goal: goal(),
        permit: permit(),
      }),
    ).toThrowError(expect.objectContaining({ code: 'current_turn_not_tail' }));
  });

  it.each(['authority', 'external'] as const)(
    'requires user or tool evidence for an immediate %s blocker',
    (blockerKind) => {
      const records = [
        record('cursor', 'system'),
        record('user', 'user', {
          provenance: 'real_user',
          turnId: 'turn-2',
          text: 'I will not grant access',
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
          code: 'immediate_blocker_external_evidence_required',
        }),
      );
      expect(
        validate(records, blocked(blockerKind, ['user'])).citedRecords[0],
      ).toMatchObject({ proofKind: 'user_input' });
    },
  );

  it('requires non-self-reported evidence from the last three turns', () => {
    const records = [
      record('cursor', 'system'),
      ...[1, 2, 3].map((turn) =>
        record(`tool-${turn}`, 'tool_result', {
          provenance: 'tool_result',
          turnId: `turn-${turn}`,
          toolResponse: { output: `failure ${turn}` },
        }),
      ),
    ];

    expect(
      validate(records, blocked('repeated', ['tool-1', 'tool-2', 'tool-3']))
        .citedRecords,
    ).toHaveLength(3);
    expect(() =>
      validate(records, blocked('repeated', ['tool-2', 'tool-3'])),
    ).toThrowError(
      expect.objectContaining({ code: 'repeated_blocker_turn_coverage' }),
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
