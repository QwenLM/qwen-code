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
  buildGoalEvidenceCheckpointWindow,
  buildGoalEvidenceCatalog,
  buildGoalVerifierEvidenceWindow,
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
    tokensUsed: 0,
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
  blockerKind: NonNullable<GoalTerminalProposal['blockerKind']>,
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
    expect(() =>
      validateGoalEvidenceReferences({
        ...input,
        proposal: complete(['evidence-100']),
      }),
    ).toThrowError(expect.objectContaining({ code: 'catalog_truncated' }));
    expect(() =>
      validateGoalEvidenceReferences({
        ...input,
        proposal: complete(['evidence-0']),
      }),
    ).toThrowError(expect.objectContaining({ code: 'catalog_truncated' }));
  });

  it('scopes the truncated catalog gate to full-window coverage proposals', () => {
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

    // Immediate blockers depend on the full post-cursor window, which
    // truncation silently weakens, so they stay fail-closed.
    expect(() =>
      validateGoalEvidenceReferences({
        ...input,
        proposal: blocked('external', ['evidence-100']),
      }),
    ).toThrowError(expect.objectContaining({ code: 'catalog_truncated' }));

    // A repeated blocker only has to cover the newest three turns, and the
    // bounded catalog still holds that coverage here, so it reaches the
    // coverage check instead of dying at the truncation gate.
    expect(() =>
      validateGoalEvidenceReferences({
        ...input,
        proposal: blocked('repeated', ['evidence-100']),
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'repeated_blocker_turn_coverage' }),
    );
  });

  it('keeps the catalog whole when only ineligible records sit past the entry cap', () => {
    const records = [
      record('cursor', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
      }),
      record('runtime-prompt', 'user', {
        provenance: 'goal_runtime',
        subtype: 'goal_runtime',
        turnId: 'turn-3',
        text: 'Continue working on the active Goal.',
      }),
      ...Array.from({ length: 100 }, (_, index) =>
        record(`evidence-${index}`, 'assistant', {
          provenance: 'assistant_output',
          turnId: 'turn-3',
          text: `output ${index}`,
        }),
      ),
    ];
    const input = { records, goal: goal(), permit: permit() };

    expect(buildGoalEvidenceCatalog(input).truncated).toBe(false);
    expect(buildGoalEvidenceCheckpointWindow(input)).toMatchObject({
      truncated: false,
      shouldCheckpoint: true,
    });
  });

  it('keeps the catalog whole when a whitespace-only record sits past the entry cap', () => {
    const records = [
      record('cursor', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
      }),
      record('whitespace-only', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-3',
        text: ' \t\n ',
      }),
      ...Array.from({ length: 100 }, (_, index) =>
        record(`evidence-${index}`, 'assistant', {
          provenance: 'assistant_output',
          turnId: 'turn-3',
          text: `output ${index}`,
        }),
      ),
    ];
    const input = { records, goal: goal(), permit: permit() };

    // A whitespace-only record trims to an empty preview, so catalogEvidence
    // can never admit it; the truncation probe must agree and must not flag
    // the catalog truncated on that record alone.
    expect(buildGoalEvidenceCatalog(input).truncated).toBe(false);
    expect(buildGoalEvidenceCheckpointWindow(input)).toMatchObject({
      truncated: false,
      shouldCheckpoint: true,
    });
  });

  it('fails closed when truncation evicts a repeated blocker turn', () => {
    const checkpointGoal: GoalRecord = {
      ...goal('checkpoint-1'),
      evidenceCheckpoint: {
        checkpointId: 'checkpoint-1',
        createdAt: 42,
        claims: Array.from({ length: 32 }, (_, index) => ({
          id: `checkpoint-1:${index + 1}`,
          proofKind: 'external_fact' as const,
          claim: `claim ${index + 1}`,
          sourceRefs: [`source-${index + 1}`],
        })),
      },
    };
    const records = [
      record('checkpoint-1', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
      }),
      ...Array.from({ length: 5 }, (_, index) =>
        record(`old-${index}`, 'tool_result', {
          provenance: 'tool_result',
          turnId: 'turn-1',
          toolResponse: { output: `old failure ${index}` },
        }),
      ),
      ...Array.from({ length: 67 }, (_, index) =>
        record(`mid-${index}`, 'tool_result', {
          provenance: 'tool_result',
          turnId: 'turn-2',
          toolResponse: { output: `mid failure ${index}` },
        }),
      ),
      record('new-0', 'tool_result', {
        provenance: 'tool_result',
        turnId: 'turn-3',
        toolResponse: { output: 'new failure' },
      }),
    ];
    const input = { records, goal: checkpointGoal, permit: permit() };

    expect(buildGoalEvidenceCatalog(input).truncated).toBe(true);
    // The evicted turn makes the required coverage unsatisfiable, and the
    // gate runs before reference validation, so even a citation of the
    // evicted record reports catalog exhaustion rather than an unknown
    // reference.
    expect(() =>
      validateGoalEvidenceReferences({
        ...input,
        proposal: blocked('repeated', ['old-0', 'mid-0', 'new-0']),
      }),
    ).toThrowError(expect.objectContaining({ code: 'catalog_truncated' }));
    expect(() =>
      validateGoalEvidenceReferences({
        ...input,
        proposal: blocked('repeated', ['mid-0', 'new-0']),
      }),
    ).toThrowError(expect.objectContaining({ code: 'catalog_truncated' }));
  });

  it('keeps a repeated blocker validatable while its turns stay catalogued', () => {
    const checkpointGoal: GoalRecord = {
      ...goal('checkpoint-1'),
      evidenceCheckpoint: {
        checkpointId: 'checkpoint-1',
        createdAt: 42,
        claims: Array.from({ length: 32 }, (_, index) => ({
          id: `checkpoint-1:${index + 1}`,
          proofKind: 'external_fact' as const,
          claim: `claim ${index + 1}`,
          sourceRefs: [`source-${index + 1}`],
        })),
      },
    };
    const records = [
      record('checkpoint-1', 'system', {
        provenance: 'goal_control',
        subtype: 'goal_state',
      }),
      ...Array.from({ length: 5 }, (_, index) =>
        record(`old-${index}`, 'tool_result', {
          provenance: 'tool_result',
          turnId: 'turn-1',
          toolResponse: { output: `old failure ${index}` },
        }),
      ),
      ...Array.from({ length: 66 }, (_, index) =>
        record(`mid-${index}`, 'tool_result', {
          provenance: 'tool_result',
          turnId: 'turn-2',
          toolResponse: { output: `mid failure ${index}` },
        }),
      ),
      record('new-0', 'tool_result', {
        provenance: 'tool_result',
        turnId: 'turn-3',
        toolResponse: { output: 'new failure' },
      }),
    ];
    const input = { records, goal: checkpointGoal, permit: permit() };

    // The entry cap still evicts older records of the oldest turn, but the
    // turn itself stays catalogued, so the coverage check remains reachable.
    expect(buildGoalEvidenceCatalog(input).truncated).toBe(true);
    expect(
      validateGoalEvidenceReferences({
        ...input,
        proposal: blocked('repeated', ['old-4', 'mid-0', 'new-0']),
      }).citedRecords,
    ).toHaveLength(3);
    // Once the relaxed truncation gate lets the proposal through, citing a
    // record the entry cap evicted surfaces as an ordinary retryable
    // reference failure rather than catalog exhaustion.
    expect(() =>
      validateGoalEvidenceReferences({
        ...input,
        proposal: blocked('repeated', ['old-0', 'mid-0', 'new-0']),
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

  it('requests a checkpoint before the catalog reaches its byte limit', () => {
    const records = [
      record('cursor', 'system'),
      record('tool-0', 'tool_result', {
        provenance: 'tool_result',
        turnId: 'turn-3',
        toolResponse: { output: 'y'.repeat(500), exitCode: 0 },
      }),
      ...Array.from({ length: 59 }, (_, index) =>
        record(`evidence-${index + 1}`, 'assistant', {
          provenance: 'assistant_output',
          turnId: 'turn-3',
          text: 'x'.repeat(300),
        }),
      ),
    ];

    const window = buildGoalEvidenceCheckpointWindow({
      records,
      goal: goal(),
      permit: permit(),
    });

    expect(window).toMatchObject({
      truncated: false,
      shouldCheckpoint: true,
    });
    expect(window.evidence).toHaveLength(60);
    expect(window.evidence).toContainEqual(
      expect.objectContaining({
        uuid: 'evidence-59',
        preview: 'x'.repeat(240),
        content: 'x'.repeat(300),
      }),
    );
    const toolEntry = window.evidence.find(({ uuid }) => uuid === 'tool-0');
    expect(toolEntry?.content).toContain('y'.repeat(500));
    expect(toolEntry!.content.length).toBeGreaterThan(
      toolEntry!.preview.length,
    );
  });

  it('caps oversized window content with a truncation marker', () => {
    const records = [
      record('cursor', 'system'),
      record('evidence-large', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-3',
        text: 'x'.repeat(10_000),
      }),
      record('tool-large', 'tool_result', {
        provenance: 'tool_result',
        turnId: 'turn-3',
        toolResponse: { output: 'y'.repeat(100_000), exitCode: 0 },
      }),
      ...Array.from({ length: 78 }, (_, index) =>
        record(`evidence-${index}`, 'assistant', {
          provenance: 'assistant_output',
          turnId: 'turn-3',
          text: `output ${index}`,
        }),
      ),
    ];

    const window = buildGoalEvidenceCheckpointWindow({
      records,
      goal: goal(),
      permit: permit(),
    });

    // The 80th entry crosses the checkpoint entry threshold while the
    // bounded previews keep the catalog whole.
    expect(window.truncated).toBe(false);
    expect(window.shouldCheckpoint).toBe(true);
    expect(window.evidence).toHaveLength(80);

    const largeAssistant = window.evidence.find(
      ({ uuid }) => uuid === 'evidence-large',
    );
    expect(largeAssistant?.content.endsWith('\n\u2026[truncated]')).toBe(true);
    expect(
      Buffer.byteLength(largeAssistant!.content, 'utf8'),
    ).toBeLessThanOrEqual(2_000);
    expect(largeAssistant?.content.startsWith('x'.repeat(100))).toBe(true);

    const largeTool = window.evidence.find(({ uuid }) => uuid === 'tool-large');
    expect(Buffer.byteLength(largeTool!.content, 'utf8')).toBeLessThanOrEqual(
      2_000,
    );
    expect(largeTool?.content.endsWith('\n\u2026[truncated]')).toBe(true);

    const small = window.evidence.find(({ uuid }) => uuid === 'evidence-1');
    expect(small?.content).toBe('output 1');
  });

  it('does not start truncated under a full checkpoint of multi-byte claims', () => {
    // The failure this guards: catalog previews were cut to 240 *characters*
    // while the catalog budget counts *bytes*. A legal 32-claim checkpoint of
    // Chinese claims serialized to ~29kB against the 24kB cap, so the window
    // was truncated before a single new record was scanned — and `truncated`
    // switches `shouldCheckpoint` off, so compaction could never run again and
    // the Goal was stopped as `usage_limited` with nothing to salvage.
    const checkpointGoal: GoalRecord = {
      ...goal('checkpoint-1'),
      evidenceCheckpoint: {
        checkpointId: 'checkpoint-1',
        createdAt: 1,
        claims: Array.from({ length: 32 }, (_, index) => ({
          id: `checkpoint-1:${index + 1}`,
          proofKind: 'external_fact' as const,
          claim: '\u4e2d'.repeat(2_000),
          sourceRefs: ['cursor'],
        })),
      },
    };

    const window = buildGoalEvidenceCheckpointWindow({
      records: [
        record('checkpoint-1', 'system'),
        record('evidence-0', 'assistant', {
          provenance: 'assistant_output',
          turnId: 'turn-3',
          text: '\u4e2d'.repeat(50),
        }),
      ],
      goal: checkpointGoal,
      permit: permit(),
    });

    expect(window.truncated).toBe(false);
  });

  it('caps window content on a code point boundary for multi-byte text', () => {
    const records = [
      record('cursor', 'system'),
      // Sized against the byte-capped catalog entry (~364 bytes each), not the
      // ~910 a 240-character CJK preview used to cost: 53 entries reach the
      // 19,200-byte checkpoint threshold, 66 would reach the 24,000 cap.
      ...Array.from({ length: 55 }, (_, index) =>
        record(`evidence-${index}`, 'assistant', {
          provenance: 'assistant_output',
          turnId: 'turn-3',
          text: '\u4e2d'.repeat(5_000),
        }),
      ),
    ];

    const window = buildGoalEvidenceCheckpointWindow({
      records,
      goal: goal(),
      permit: permit(),
    });

    expect(window.truncated).toBe(false);
    expect(window.shouldCheckpoint).toBe(true);
    const capped = window.evidence.find(({ uuid }) => uuid === 'evidence-0');
    const bytes = Buffer.byteLength(capped!.content, 'utf8');
    expect(bytes).toBeLessThanOrEqual(2_000);
    expect(capped?.content.endsWith('\n\u2026[truncated]')).toBe(true);
    // The prefix must survive the cap untouched, code point aligned.
    expect(capped?.content.startsWith('\u4e2d'.repeat(600))).toBe(true);
    expect(capped?.content).not.toContain('\ufffd');
  });

  it('does not expand raw evidence below the checkpoint threshold', () => {
    let fullPayloadReads = 0;
    const level2: Record<string, unknown> = {};
    Object.defineProperty(level2, 'payload', {
      enumerable: true,
      get: () => {
        fullPayloadReads += 1;
        return 'x'.repeat(1_000_000);
      },
    });
    const records = [
      record('cursor', 'system'),
      record('tool-1', 'tool_result', {
        provenance: 'tool_result',
        turnId: 'turn-3',
        toolResponse: { level1: { level2 } },
      }),
    ];
    const input = { records, goal: goal(), permit: permit() };

    expect(buildGoalEvidenceCatalog(input).truncated).toBe(false);
    expect(fullPayloadReads).toBe(0);

    expect(buildGoalEvidenceCheckpointWindow(input)).toMatchObject({
      shouldCheckpoint: false,
      truncated: false,
      evidence: [],
    });
    expect(fullPayloadReads).toBe(0);
  });

  it('bounds reference count, rejects duplicates, and bounds cited bytes', () => {
    const records = [
      record('cursor', 'system'),
      ...Array.from({ length: 13 }, (_, index) =>
        record(`evidence-${index}`, 'assistant', {
          provenance: 'assistant_output',
          turnId: 'turn-3',
          text: index === 0 ? 'x'.repeat(256_001) : `output ${index}`,
        }),
      ),
    ];

    const tooManyRecords = [
      record('cursor', 'system'),
      ...Array.from({ length: 101 }, (_, index) =>
        record(`short-${index}`, 'assistant', {
          provenance: 'assistant_output',
          turnId: 'turn-3',
          text: `output ${index}`,
        }),
      ),
    ];

    expect(() =>
      validate(
        tooManyRecords,
        complete(tooManyRecords.slice(1).map(({ uuid }) => uuid)),
      ),
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

  it('admits delivered output larger than the catalog preview budget', () => {
    const records = [
      record('cursor', 'system'),
      record('output', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-3',
        text: 'x'.repeat(24_001),
      }),
    ];

    expect(
      validate(records, complete(['output'])).citedRecords[0],
    ).toMatchObject({
      uuid: 'output',
      content: 'x'.repeat(24_001),
    });
  });

  it('admits thirteen delivered outputs plus independent evidence', () => {
    const records = [
      record('cursor', 'system'),
      record('tool', 'tool_result', {
        provenance: 'tool_result',
        turnId: 'turn-3',
        toolResponse: { output: 'tests passed' },
      }),
      ...Array.from({ length: 13 }, (_, index) =>
        record(`output-${index}`, 'assistant', {
          provenance: 'assistant_output',
          turnId: 'turn-3',
          text: `output ${index}`,
        }),
      ),
    ];

    expect(
      validate(records, complete(records.slice(1).map(({ uuid }) => uuid)))
        .citedRecords,
    ).toHaveLength(14);
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

  it('treats only display metadata as real-user evidence', () => {
    const user = record('user', 'user', {
      provenance: 'real_user',
      turnId: 'turn-3',
      text: 'expanded model prompt',
    });
    user.message?.parts?.push({
      text: [
        '<qwen:user-prompt-submit-context>',
        'hook-only context',
        '</qwen:user-prompt-submit-context>',
      ].join('\n'),
    });
    user.systemPayload = {
      displayText: 'raw @file prompt',
      hookContext: 'hook-only context',
    };
    const records = [record('cursor', 'system'), user];

    const catalog = buildGoalEvidenceCatalog({
      records,
      goal: goal(),
      permit: permit(),
    });
    const validated = validate(records, complete(['user']));

    expect(catalog.entries[0]?.preview).toBe('raw @file prompt');
    expect(validated.citedRecords[0]?.content).toBe('raw @file prompt');
    expect(JSON.stringify({ catalog, validated })).not.toContain(
      'hook-only context',
    );
  });

  it('keeps mid-turn model text instead of its display label', () => {
    const modelText =
      '[User message received during tool execution]: save logs';
    const user = record('user', 'user', {
      provenance: 'real_user',
      subtype: 'mid_turn_user_message',
      turnId: 'turn-3',
      text: `\n${modelText}`,
    });
    user.systemPayload = { displayText: 'save logs' };
    const records = [record('cursor', 'system'), user];

    const catalog = buildGoalEvidenceCatalog({
      records,
      goal: goal(),
      permit: permit(),
    });
    const validated = validate(records, complete(['user']));

    expect(catalog.entries[0]?.preview).toBe(modelText);
    expect(validated.citedRecords[0]?.content).toBe(modelText);
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
  it('keeps completion available after the lineage display window fills', () => {
    const records = [
      record('cursor', 'system'),
      ...Array.from({ length: 17 }, (_, index) =>
        record(`output-${index + 1}`, 'assistant', {
          provenance: 'assistant_output',
          turnId: `turn-${index + 1}`,
          text: `output ${index + 1}`,
        }),
      ),
    ];
    const currentPermit = permit('turn-17');
    const input = { records, goal: goal(), permit: currentPermit };

    expect(buildGoalEvidenceCatalog(input)).toMatchObject({
      truncated: false,
      lineageTurnIds: Array.from(
        { length: 16 },
        (_, index) => `turn-${index + 2}`,
      ),
    });
    expect(
      validate(records, complete(['output-17']), currentPermit).citedRecords,
    ).toHaveLength(1);
  });

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
        validate(records, blocked(blockerKind, ['user', 'assistant']))
          .citedRecords[0],
      ).toMatchObject({ proofKind: 'user_input' });
      expect(() =>
        validate(records, blocked(blockerKind, ['user'])),
      ).toThrowError(
        expect.objectContaining({
          code: 'immediate_blocker_newer_evidence_required',
        }),
      );
    },
  );

  it('holds an infeasible blocker to external facts, not user input or prose', () => {
    // Infeasibility is a claim about the world. A user can authorise a stop
    // (that is `authority`), but cannot make an objective impossible, and
    // the assistant saying it is impossible is exactly the exit this kind
    // must not become -- so only a tool result can carry it.
    const records = [
      record('cursor', 'system'),
      record('user', 'user', {
        provenance: 'real_user',
        turnId: 'turn-2',
        text: 'Please target the v9 branch',
      }),
      record('probe', 'tool_result', {
        provenance: 'tool_result',
        turnId: 'turn-3',
        toolResponse: { output: "fatal: branch 'v9' not found" },
      }),
      record('assistant', 'assistant', {
        provenance: 'assistant_output',
        turnId: 'turn-3',
        text: 'The v9 branch does not exist, so this objective cannot be met.',
      }),
    ];

    expect(() =>
      validate(records, blocked('infeasible', ['assistant'])),
    ).toThrowError(
      expect.objectContaining({
        code: 'infeasible_blocker_external_fact_required',
      }),
    );
    expect(() =>
      validate(records, blocked('infeasible', ['user', 'assistant'])),
    ).toThrowError(
      expect.objectContaining({
        code: 'infeasible_blocker_external_fact_required',
      }),
    );
    expect(
      validate(records, blocked('infeasible', ['probe', 'assistant']))
        .citedRecords[0],
    ).toMatchObject({ uuid: 'probe', proofKind: 'external_fact' });
    // Like the other immediate blockers, it cannot leave newer evidence
    // uncited: a later record could contradict the impossibility.
    expect(() =>
      validate(records, blocked('infeasible', ['probe'])),
    ).toThrowError(
      expect.objectContaining({
        code: 'immediate_blocker_newer_evidence_required',
      }),
    );
  });

  it.each(['authority', 'external'] as const)(
    'gates an immediate %s blocker on checkpoint claims like raw evidence',
    (blockerKind) => {
      const checkpointGoal: GoalRecord = {
        ...goal('checkpoint-1'),
        evidenceCheckpoint: {
          checkpointId: 'checkpoint-1',
          createdAt: 42,
          claims: [
            {
              id: 'checkpoint-1:1',
              proofKind: 'user_input',
              claim: 'The user withheld deploy authority.',
              sourceRefs: ['user-old'],
            },
            {
              id: 'checkpoint-1:2',
              proofKind: 'delivered_output',
              claim: 'The change was delivered.',
              sourceRefs: ['assistant-old'],
            },
          ],
        },
      };
      const records = [
        record('checkpoint-1', 'system', {
          provenance: 'goal_control',
          subtype: 'goal_state',
        }),
        record('assistant-new', 'assistant', {
          provenance: 'assistant_output',
          turnId: 'turn-3',
          text: 'new output',
        }),
      ];

      expect(
        validate(
          records,
          blocked(blockerKind, [
            'checkpoint-1:1',
            'checkpoint-1:2',
            'assistant-new',
          ]),
          permit(),
          checkpointGoal,
        ).citedRecords[0],
      ).toMatchObject({
        uuid: 'checkpoint-1:1',
        proofKind: 'user_input',
        content: 'The user withheld deploy authority.',
      });
      expect(() =>
        validate(
          records,
          blocked(blockerKind, ['checkpoint-1:2', 'assistant-new']),
          permit(),
          checkpointGoal,
        ),
      ).toThrowError(
        expect.objectContaining({
          code: 'immediate_blocker_external_evidence_required',
        }),
      );
      expect(() =>
        validate(
          records,
          blocked(blockerKind, ['checkpoint-1:1', 'checkpoint-1:2']),
          permit(),
          checkpointGoal,
        ),
      ).toThrowError(
        expect.objectContaining({
          code: 'immediate_blocker_newer_evidence_required',
        }),
      );
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
