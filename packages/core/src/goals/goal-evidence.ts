/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChatRecord,
  ChatRecordProvenance,
} from '../services/chatRecordingService.js';
import type {
  GoalRecord,
  GoalTerminalProposal,
  GoalTurnPermit,
} from './goal-protocol.js';

const CATALOG_PREVIEW_LIMIT = 240;

export type GoalEvidenceProvenance = Extract<
  ChatRecordProvenance,
  'real_user' | 'assistant_output' | 'tool_result'
>;

export type GoalEvidenceProofKind =
  | 'user_input'
  | 'delivered_output'
  | 'external_fact';

export interface GoalEvidenceCatalogEntry {
  uuid: string;
  provenance: GoalEvidenceProvenance;
  turnId: string;
  preview: string;
  proofKind: GoalEvidenceProofKind;
}

export interface GoalEvidenceCatalog {
  entries: GoalEvidenceCatalogEntry[];
  lineageTurnIds: string[];
}

export interface ValidatedGoalEvidenceRecord extends GoalEvidenceCatalogEntry {
  content: string;
}

export interface ValidatedGoalEvidence {
  catalog: GoalEvidenceCatalogEntry[];
  citedRecords: ValidatedGoalEvidenceRecord[];
  lineageTurnIds: string[];
}

export interface GoalEvidenceContext {
  records: readonly ChatRecord[];
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

export type InvalidGoalEvidenceReferenceCode =
  | 'no_evidence_references'
  | 'missing_reference'
  | 'pre_cursor_reference'
  | 'ineligible_reference'
  | 'missing_goal_context'
  | 'wrong_goal_id'
  | 'wrong_revision'
  | 'wrong_turn_lineage'
  | 'immediate_blocker_external_evidence_required'
  | 'repeated_blocker_turn_coverage';

export class InvalidGoalEvidenceReferenceError extends Error {
  constructor(
    readonly code: InvalidGoalEvidenceReferenceCode,
    message: string,
    readonly reference?: string,
  ) {
    super(message);
    this.name = 'InvalidGoalEvidenceReferenceError';
  }
}

interface EvidenceAnalysis {
  cursorIndex: number;
  catalog: GoalEvidenceCatalogEntry[];
  eligibleByUuid: Map<string, ValidatedGoalEvidenceRecord>;
  indexByUuid: Map<string, number>;
  lineageTurnIds: string[];
}

interface ParsedGoalContext {
  goalId: string;
  revision: number;
  turnId: string;
}

export function buildGoalEvidenceCatalog(
  input: GoalEvidenceContext,
): GoalEvidenceCatalog {
  const analysis = analyzeEvidence(input);
  return {
    entries: analysis.catalog.map((entry) => ({ ...entry })),
    lineageTurnIds: [...analysis.lineageTurnIds],
  };
}

export function validateGoalEvidenceReferences(
  input: GoalEvidenceValidationInput,
): ValidatedGoalEvidence {
  const analysis = analyzeEvidence(input);
  if (input.proposal.evidenceRefs.length === 0) {
    throw new InvalidGoalEvidenceReferenceError(
      'no_evidence_references',
      'A terminal Goal proposal must cite at least one evidence record.',
    );
  }
  const citedRecords = input.proposal.evidenceRefs.map((reference) =>
    validateReference(reference, input, analysis),
  );

  validateBlockerCoverage(input.proposal, citedRecords, analysis);

  return {
    catalog: analysis.catalog.map((entry) => ({ ...entry })),
    citedRecords: citedRecords.map((entry) => ({ ...entry })),
    lineageTurnIds: [...analysis.lineageTurnIds],
  };
}

function analyzeEvidence(input: GoalEvidenceContext): EvidenceAnalysis {
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
  for (let index = 0; index < input.records.length; index++) {
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

  const lineageTurnIds: string[] = [];
  const seenTurnIds = new Set<string>();
  let currentLineageTurnId: string | undefined;
  for (let index = cursorIndex + 1; index < input.records.length; index++) {
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
    if (!isNonEmptyString(context.turnId)) {
      throw new EvidenceSourceUnavailableError(
        'malformed_turn_context',
        `Goal-owned transcript record ${input.records[index]!.uuid} has no valid turn ID.`,
      );
    }
    if (context.turnId === currentLineageTurnId) continue;
    if (seenTurnIds.has(context.turnId)) {
      throw new EvidenceSourceUnavailableError(
        'turn_reentry',
        `Goal turn ${context.turnId} re-enters the active transcript lineage.`,
      );
    }
    seenTurnIds.add(context.turnId);
    lineageTurnIds.push(context.turnId);
    currentLineageTurnId = context.turnId;
  }

  if (lineageTurnIds.at(-1) !== input.permit.turnId) {
    throw new EvidenceSourceUnavailableError(
      'current_turn_not_tail',
      'The current Goal permit is not the tail of the active transcript lineage.',
    );
  }

  const catalog: GoalEvidenceCatalogEntry[] = [];
  const eligibleByUuid = new Map<string, ValidatedGoalEvidenceRecord>();
  for (let index = cursorIndex + 1; index < input.records.length; index++) {
    const evidence = eligibleEvidence(input.records[index]!, input);
    if (!evidence) continue;
    catalog.push(stripContent(evidence));
    eligibleByUuid.set(evidence.uuid, evidence);
  }

  return {
    cursorIndex,
    catalog,
    eligibleByUuid,
    indexByUuid,
    lineageTurnIds,
  };
}

function validateReference(
  reference: string,
  input: GoalEvidenceValidationInput,
  analysis: EvidenceAnalysis,
): ValidatedGoalEvidenceRecord {
  const recordIndex = analysis.indexByUuid.get(reference);
  if (recordIndex === undefined) {
    throw new InvalidGoalEvidenceReferenceError(
      'missing_reference',
      `Evidence reference ${reference} is not in the active transcript chain.`,
      reference,
    );
  }
  if (recordIndex <= analysis.cursorIndex) {
    throw new InvalidGoalEvidenceReferenceError(
      'pre_cursor_reference',
      `Evidence reference ${reference} is not after the Goal evidence cursor.`,
      reference,
    );
  }

  const record = input.records[recordIndex]!;
  const provenance = coherentEvidenceProvenance(record);
  if (!provenance) {
    throw new InvalidGoalEvidenceReferenceError(
      'ineligible_reference',
      `Transcript record ${reference} is not an eligible evidence source.`,
      reference,
    );
  }

  const context = parseGoalContext(record.goalContext);
  if (!context) {
    throw new InvalidGoalEvidenceReferenceError(
      'missing_goal_context',
      `Evidence reference ${reference} has no valid Goal turn context.`,
      reference,
    );
  }
  if (context.goalId !== input.goal.goalId) {
    throw new InvalidGoalEvidenceReferenceError(
      'wrong_goal_id',
      `Evidence reference ${reference} belongs to a different Goal.`,
      reference,
    );
  }
  if (context.revision !== input.goal.revision) {
    throw new InvalidGoalEvidenceReferenceError(
      'wrong_revision',
      `Evidence reference ${reference} belongs to a different Goal revision.`,
      reference,
    );
  }
  if (!analysis.lineageTurnIds.includes(context.turnId)) {
    throw new InvalidGoalEvidenceReferenceError(
      'wrong_turn_lineage',
      `Evidence reference ${reference} is not in the active Goal turn lineage.`,
      reference,
    );
  }
  const evidence = analysis.eligibleByUuid.get(reference);
  if (!evidence) {
    throw new InvalidGoalEvidenceReferenceError(
      'ineligible_reference',
      `Transcript record ${reference} has no eligible evidence content.`,
      reference,
    );
  }
  return evidence;
}

function validateBlockerCoverage(
  proposal: GoalTerminalProposal,
  citedRecords: readonly ValidatedGoalEvidenceRecord[],
  analysis: EvidenceAnalysis,
): void {
  if (proposal.status !== 'blocked') return;

  if (
    proposal.blockerKind === 'authority' ||
    proposal.blockerKind === 'external'
  ) {
    if (
      !citedRecords.some(
        (record) =>
          record.provenance === 'real_user' ||
          record.provenance === 'tool_result',
      )
    ) {
      throw new InvalidGoalEvidenceReferenceError(
        'immediate_blocker_external_evidence_required',
        'An immediate blocker requires cited user input or external tool evidence.',
      );
    }
    return;
  }

  const requiredTurnIds = analysis.lineageTurnIds.slice(-3);
  const currentTurnId = requiredTurnIds.at(-1);
  const citedTurnIds = new Set(
    citedRecords
      .filter(
        (record) =>
          record.provenance !== 'assistant_output' ||
          record.turnId === currentTurnId,
      )
      .map((record) => record.turnId),
  );
  if (
    requiredTurnIds.length !== 3 ||
    !requiredTurnIds.every((turnId) => citedTurnIds.has(turnId))
  ) {
    throw new InvalidGoalEvidenceReferenceError(
      'repeated_blocker_turn_coverage',
      'A repeated blocker requires evidence from the current and two immediately preceding Goal turns.',
    );
  }
}

function eligibleEvidence(
  record: ChatRecord,
  input: GoalEvidenceContext,
): ValidatedGoalEvidenceRecord | undefined {
  const provenance = coherentEvidenceProvenance(record);
  if (!provenance) return undefined;

  const context = parseGoalContext(record.goalContext);
  if (
    !context ||
    context.goalId !== input.goal.goalId ||
    context.revision !== input.goal.revision
  ) {
    return undefined;
  }

  const content = evidenceContent(record, provenance);
  if (!content) return undefined;
  return {
    uuid: record.uuid,
    provenance,
    turnId: context.turnId,
    preview: previewOf(content),
    proofKind: proofKindOf(provenance),
    content,
  };
}

function coherentEvidenceProvenance(
  record: ChatRecord,
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

function legacySafeProvenance(
  record: ChatRecord,
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

function evidenceContent(
  record: ChatRecord,
  provenance: GoalEvidenceProvenance,
): string {
  const content: string[] = [];
  for (const part of record.message?.parts ?? []) {
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

function renderToolResponse(functionResponse: {
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

function previewOf(content: string): string {
  if (content.length <= CATALOG_PREVIEW_LIMIT) return content;
  return `${content.slice(0, CATALOG_PREVIEW_LIMIT - 3)}...`;
}

function proofKindOf(
  provenance: GoalEvidenceProvenance,
): GoalEvidenceProofKind {
  if (provenance === 'real_user') return 'user_input';
  if (provenance === 'assistant_output') return 'delivered_output';
  return 'external_fact';
}

function stripContent(
  evidence: ValidatedGoalEvidenceRecord,
): GoalEvidenceCatalogEntry {
  return {
    uuid: evidence.uuid,
    provenance: evidence.provenance,
    turnId: evidence.turnId,
    preview: evidence.preview,
    proofKind: evidence.proofKind,
  };
}

function parseGoalContext(value: unknown): ParsedGoalContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const context = value as Record<string, unknown>;
  if (
    typeof context['goalId'] !== 'string' ||
    typeof context['revision'] !== 'number' ||
    typeof context['turnId'] !== 'string'
  ) {
    return undefined;
  }
  return {
    goalId: context['goalId'],
    revision: context['revision'],
    turnId: context['turnId'],
  };
}

function claimsGoalRevision(value: unknown, goal: GoalRecord): boolean {
  if (!value || typeof value !== 'object') return false;
  const context = value as Record<string, unknown>;
  return (
    context['goalId'] === goal.goalId && context['revision'] === goal.revision
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
