/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rules shared by the evidence catalog and the verifier window: which
 * transcript records are evidence, how their content is read, and how a
 * transcript is anchored to a Goal permit. Kept out of the goals barrel on
 * purpose: nothing here is package API, and the catalog side of it goes
 * away with the catalog.
 */

import type { Part } from '@google/genai';
import type {
  GoalEvidenceProofKind,
  GoalRecord,
  GoalTerminalProposal,
  GoalTurnPermit,
} from './goal-protocol.js';
import { projectUserTranscriptForDisplay } from '../utils/transcript-records.js';

export type GoalEvidenceProvenance =
  | 'real_user'
  | 'assistant_output'
  | 'tool_result'
  | 'goal_checkpoint';

export type GoalRecordProvenance =
  | GoalEvidenceProvenance
  | 'goal_control'
  | 'goal_runtime'
  | 'system';

export interface GoalEvidenceRecord {
  uuid: string;
  type: 'user' | 'assistant' | 'tool_result' | 'system';
  subtype?: string;
  provenance?: GoalRecordProvenance;
  goalContext?: unknown;
  message?: { parts?: Part[] };
  systemPayload?: unknown;
}

export interface GoalEvidenceContext {
  records: readonly GoalEvidenceRecord[];
  goal: GoalRecord;
  permit: GoalTurnPermit;
}

export interface GoalEvidenceValidationInput extends GoalEvidenceContext {
  proposal: GoalTerminalProposal;
}

export type EvidenceSourceUnavailableCode =
  | 'cursor_unset'
  | 'cursor_not_found'
  | 'duplicate_record_uuid'
  | 'permit_goal_mismatch'
  | 'malformed_turn_context'
  | 'turn_reentry'
  | 'current_turn_not_tail';

export class EvidenceSourceUnavailableError extends Error {
  constructor(
    readonly code: EvidenceSourceUnavailableCode,
    message: string,
  ) {
    super(message);
    this.name = 'EvidenceSourceUnavailableError';
  }
}

export interface ParsedGoalContext {
  goalId: string;
  revision: number;
  turnId: string;
}

/**
 * Anchors a transcript to a Goal permit: checks the permit against the Goal
 * revision, finds the evidence cursor in a chain with no repeated uuid, and
 * collects the Goal turns recorded after it. Whether the current turn has
 * to be at the lineage's tail is the caller's rule: the catalog requires
 * it, the verifier window allows a current turn that has recorded nothing.
 *
 * @internal Shared with the verifier window; not part of the package API.
 */
export function anchorGoalTranscript(input: GoalEvidenceContext): {
  cursorIndex: number;
  indexByUuid: Map<string, number>;
  lineageTurnIds: string[];
} {
  if (
    input.permit.goalId !== input.goal.goalId ||
    input.permit.revision !== input.goal.revision ||
    !isNonEmptyString(input.permit.turnId)
  ) {
    throw new EvidenceSourceUnavailableError(
      'permit_goal_mismatch',
      'The current Goal permit does not match the Goal evidence revision.',
    );
  }

  const cursorId = input.goal.evidenceCursor.recordId;
  if (cursorId === null) {
    throw new EvidenceSourceUnavailableError(
      'cursor_unset',
      'The Goal evidence cursor is not available.',
    );
  }

  const indexByUuid = new Map<string, number>();
  for (let index = 0; index < input.records.length; index += 1) {
    const uuid = input.records[index]!.uuid;
    if (indexByUuid.has(uuid)) {
      throw new EvidenceSourceUnavailableError(
        'duplicate_record_uuid',
        `The active transcript chain contains duplicate record UUID ${uuid}.`,
      );
    }
    indexByUuid.set(uuid, index);
  }

  const cursorIndex = indexByUuid.get(cursorId);
  if (cursorIndex === undefined) {
    throw new EvidenceSourceUnavailableError(
      'cursor_not_found',
      `The Goal evidence cursor ${cursorId} is not in the active transcript chain.`,
    );
  }

  return {
    cursorIndex,
    indexByUuid,
    lineageTurnIds: collectLineageTurnIds(input, cursorIndex),
  };
}

/**
 * Whether a record would render to any evidence content at all, decided
 * from the shape of its parts without serializing a tool response: a
 * non-blank text part that is not a thought, or a tool response that is
 * present. A record that would not is neither evidence nor an omission.
 *
 * @internal Shared with the verifier window; not part of the package API.
 */
export function recordHasEvidenceContent(
  record: GoalEvidenceRecord,
  provenance: GoalEvidenceProvenance,
): boolean {
  // The same projection `evidenceContent` renders from, so the two cannot
  // disagree: a user prompt's display text stands in for its parts, and a
  // trailing hook-context part is not content.
  const projection =
    provenance === 'real_user'
      ? projectUserTranscriptForDisplay(record)
      : undefined;
  if (projection?.displayText !== undefined) {
    return projection.displayText.trim().length > 0;
  }
  for (const part of projection?.parts ?? record.message?.parts ?? []) {
    if (
      part.thought !== true &&
      typeof part.text === 'string' &&
      part.text.trim()
    ) {
      return true;
    }
    if (
      provenance === 'tool_result' &&
      part.functionResponse &&
      part.functionResponse.response !== undefined
    ) {
      return true;
    }
  }
  return false;
}

export function collectLineageTurnIds(
  input: GoalEvidenceContext,
  cursorIndex: number,
): string[] {
  const lineageTurnIds: string[] = [];
  const seenTurnIds = new Set<string>();
  let currentTurnId: string | undefined;

  for (let index = cursorIndex + 1; index < input.records.length; index += 1) {
    const record = input.records[index]!;
    const context = parseGoalContext(record.goalContext);
    if (!context) {
      if (claimsGoalRevision(record.goalContext, input.goal)) {
        throw new EvidenceSourceUnavailableError(
          'malformed_turn_context',
          `Goal-owned transcript record ${record.uuid} has malformed turn context.`,
        );
      }
      continue;
    }
    if (
      context.goalId !== input.goal.goalId ||
      context.revision !== input.goal.revision
    ) {
      continue;
    }
    if (context.turnId === currentTurnId) continue;
    if (seenTurnIds.has(context.turnId)) {
      throw new EvidenceSourceUnavailableError(
        'turn_reentry',
        `Goal turn ${context.turnId} re-enters the active transcript lineage.`,
      );
    }
    seenTurnIds.add(context.turnId);
    lineageTurnIds.push(context.turnId);
    currentTurnId = context.turnId;
  }
  return lineageTurnIds;
}

export function coherentEvidenceProvenance(
  record: GoalEvidenceRecord,
): GoalEvidenceProvenance | undefined {
  if (record.type === 'system') return undefined;
  const provenance = record.provenance ?? legacySafeProvenance(record);
  if (provenance === 'real_user') {
    return record.type === 'user' &&
      (record.subtype === undefined ||
        record.subtype === 'mid_turn_user_message')
      ? provenance
      : undefined;
  }
  if (provenance === 'assistant_output') {
    return record.type === 'assistant' && record.subtype === undefined
      ? provenance
      : undefined;
  }
  if (provenance === 'tool_result') {
    return record.type === 'tool_result' && record.subtype === undefined
      ? provenance
      : undefined;
  }
  return undefined;
}

export function legacySafeProvenance(
  record: GoalEvidenceRecord,
): GoalEvidenceProvenance | undefined {
  if (
    record.type === 'user' &&
    (record.subtype === undefined || record.subtype === 'mid_turn_user_message')
  ) {
    return 'real_user';
  }
  if (record.type === 'assistant' && record.subtype === undefined) {
    return 'assistant_output';
  }
  if (record.type === 'tool_result' && record.subtype === undefined) {
    return 'tool_result';
  }
  return undefined;
}

export function evidenceContent(
  record: GoalEvidenceRecord,
  provenance: GoalEvidenceProvenance,
): string {
  const projection =
    provenance === 'real_user'
      ? projectUserTranscriptForDisplay(record)
      : undefined;
  if (projection?.displayText !== undefined) {
    return projection.displayText.trim();
  }
  const content: string[] = [];
  const parts = projection?.parts ?? record.message?.parts ?? [];
  for (const part of parts) {
    if (part.thought !== true && typeof part.text === 'string') {
      content.push(part.text);
    }
    if (provenance === 'tool_result' && part.functionResponse) {
      const rendered = renderToolResponse(part.functionResponse);
      if (rendered) content.push(rendered);
    }
  }
  return content.join('\n').trim();
}

export function renderToolResponse(functionResponse: {
  name?: string;
  response?: unknown;
}): string {
  if (functionResponse.response === undefined) return '';
  try {
    return JSON.stringify({
      ...(functionResponse.name === undefined
        ? {}
        : { name: functionResponse.name }),
      response: functionResponse.response,
    });
  } catch {
    return '';
  }
}

export function proofKindOf(
  provenance: GoalEvidenceProvenance,
): GoalEvidenceProofKind {
  if (provenance === 'real_user') return 'user_input';
  if (provenance === 'assistant_output') return 'delivered_output';
  return 'external_fact';
}

export function parseGoalContext(
  value: unknown,
): ParsedGoalContext | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !hasOnlyKeys(value, ['goalId', 'revision', 'turnId']) ||
    !isNonEmptyString(value['goalId']) ||
    typeof value['revision'] !== 'number' ||
    !Number.isInteger(value['revision']) ||
    value['revision'] < 1 ||
    !isNonEmptyString(value['turnId'])
  ) {
    return undefined;
  }
  return {
    goalId: value['goalId'],
    revision: value['revision'],
    turnId: value['turnId'],
  };
}

export function claimsGoalRevision(value: unknown, goal: GoalRecord): boolean {
  if (!isRecord(value)) return false;
  return value['goalId'] === goal.goalId && value['revision'] === goal.revision;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
