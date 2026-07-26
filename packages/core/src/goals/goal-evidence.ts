/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import type {
  GoalRecord,
  GoalTerminalProposal,
  GoalTurnPermit,
} from './goal-protocol.js';

const CATALOG_PREVIEW_LIMIT = 240;
const CATALOG_ENTRY_LIMIT = 100;
const CATALOG_BYTE_LIMIT = 24_000;
const CATALOG_LINEAGE_LIMIT = 16;
const VERIFIER_REFERENCE_LIMIT = 12;
const VERIFIER_EVIDENCE_BYTE_LIMIT = 24_000;

export type GoalEvidenceProvenance =
  | 'real_user'
  | 'assistant_output'
  | 'tool_result';

type GoalRecordProvenance =
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
}

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
  truncated: boolean;
}

export interface ValidatedGoalEvidenceRecord extends GoalEvidenceCatalogEntry {
  content: string;
}

export interface ValidatedGoalEvidence {
  citedRecords: ValidatedGoalEvidenceRecord[];
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

export type InvalidGoalEvidenceReferenceCode =
  | 'no_evidence_references'
  | 'too_many_evidence_references'
  | 'duplicate_evidence_reference'
  | 'evidence_payload_too_large'
  | 'missing_reference'
  | 'pre_cursor_reference'
  | 'ineligible_reference'
  | 'reference_not_catalogued'
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
  eligibleByUuid: Map<string, GoalEvidenceCatalogEntry>;
  indexByUuid: Map<string, number>;
  lineageTurnIds: string[];
  catalogTruncated: boolean;
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
    lineageTurnIds: analysis.lineageTurnIds.slice(-CATALOG_LINEAGE_LIMIT),
    truncated:
      analysis.catalogTruncated ||
      analysis.lineageTurnIds.length > CATALOG_LINEAGE_LIMIT,
  };
}

export function validateGoalEvidenceReferences(
  input: GoalEvidenceValidationInput,
): ValidatedGoalEvidence {
  const references = input.proposal.evidenceRefs;
  if (references.length === 0) {
    throw new InvalidGoalEvidenceReferenceError(
      'no_evidence_references',
      'A terminal Goal proposal must cite at least one evidence record.',
    );
  }
  if (references.length > VERIFIER_REFERENCE_LIMIT) {
    throw new InvalidGoalEvidenceReferenceError(
      'too_many_evidence_references',
      `A terminal Goal proposal may cite at most ${VERIFIER_REFERENCE_LIMIT} evidence records.`,
    );
  }
  if (new Set(references).size !== references.length) {
    throw new InvalidGoalEvidenceReferenceError(
      'duplicate_evidence_reference',
      'A terminal Goal proposal must not cite the same evidence record more than once.',
    );
  }

  const analysis = analyzeEvidence(input);
  const citedRecords = references.map((reference) =>
    validateReference(reference, input, analysis),
  );
  const evidenceBytes = citedRecords.reduce(
    (total, record) => total + Buffer.byteLength(record.content, 'utf8'),
    0,
  );
  if (evidenceBytes > VERIFIER_EVIDENCE_BYTE_LIMIT) {
    throw new InvalidGoalEvidenceReferenceError(
      'evidence_payload_too_large',
      `Cited Goal evidence exceeds the ${VERIFIER_EVIDENCE_BYTE_LIMIT}-byte verifier limit.`,
    );
  }

  validateBlockerCoverage(input.proposal, citedRecords, analysis);
  return {
    citedRecords: citedRecords.map((entry) => ({ ...entry })),
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

  const lineageTurnIds = collectLineageTurnIds(input, cursorIndex);
  if (lineageTurnIds.at(-1) !== input.permit.turnId) {
    throw new EvidenceSourceUnavailableError(
      'current_turn_not_tail',
      'The current Goal permit is not the tail of the active transcript lineage.',
    );
  }

  const selectedEvidence: GoalEvidenceCatalogEntry[] = [];
  let catalogBytes = 0;
  let catalogTruncated = false;
  for (let index = input.records.length - 1; index > cursorIndex; index -= 1) {
    if (selectedEvidence.length >= CATALOG_ENTRY_LIMIT) {
      catalogTruncated = true;
      break;
    }
    const evidence = catalogEvidence(input.records[index]!, input);
    if (!evidence) continue;
    const entryBytes = Buffer.byteLength(JSON.stringify(evidence), 'utf8');
    if (catalogBytes + entryBytes > CATALOG_BYTE_LIMIT) {
      catalogTruncated = true;
      break;
    }
    selectedEvidence.push(evidence);
    catalogBytes += entryBytes;
  }

  selectedEvidence.reverse();
  const eligibleByUuid = new Map(
    selectedEvidence.map((entry) => [entry.uuid, entry]),
  );
  return {
    cursorIndex,
    catalog: selectedEvidence,
    eligibleByUuid,
    indexByUuid,
    lineageTurnIds,
    catalogTruncated,
  };
}

function collectLineageTurnIds(
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
  if (!coherentEvidenceProvenance(record)) {
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

  const catalogEntry = analysis.eligibleByUuid.get(reference);
  if (!catalogEntry) {
    throw new InvalidGoalEvidenceReferenceError(
      'reference_not_catalogued',
      `Evidence reference ${reference} is outside the bounded Goal evidence catalog.`,
      reference,
    );
  }
  const content = evidenceContent(record, catalogEntry.provenance);
  if (!content) {
    throw new InvalidGoalEvidenceReferenceError(
      'ineligible_reference',
      `Transcript record ${reference} has no eligible evidence content.`,
      reference,
    );
  }
  return { ...catalogEntry, content };
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
        ({ provenance }) =>
          provenance === 'real_user' || provenance === 'tool_result',
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
      .map(({ turnId }) => turnId),
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

function catalogEvidence(
  record: GoalEvidenceRecord,
  input: GoalEvidenceContext,
): GoalEvidenceCatalogEntry | undefined {
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

  const preview = evidencePreview(record, provenance);
  if (!preview) return undefined;
  return {
    uuid: record.uuid,
    provenance,
    turnId: context.turnId,
    preview,
    proofKind: proofKindOf(provenance),
  };
}

function coherentEvidenceProvenance(
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

function legacySafeProvenance(
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

function evidenceContent(
  record: GoalEvidenceRecord,
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

function evidencePreview(
  record: GoalEvidenceRecord,
  provenance: GoalEvidenceProvenance,
): string {
  let preview = '';
  const append = (value: string) => {
    if (!value || preview.length >= CATALOG_PREVIEW_LIMIT) return;
    const separator = preview ? '\n' : '';
    const remaining = CATALOG_PREVIEW_LIMIT - preview.length;
    preview += `${separator}${value}`.slice(0, remaining);
  };

  for (const part of record.message?.parts ?? []) {
    if (part.thought !== true && typeof part.text === 'string') {
      append(part.text);
    }
    if (provenance === 'tool_result' && part.functionResponse) {
      append(renderToolResponsePreview(part.functionResponse));
    }
    if (preview.length >= CATALOG_PREVIEW_LIMIT) break;
  }
  return preview.trim();
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

function renderToolResponsePreview(functionResponse: {
  name?: string;
  response?: unknown;
}): string {
  if (functionResponse.response === undefined) return '';
  try {
    return JSON.stringify({
      ...(functionResponse.name === undefined
        ? {}
        : { name: functionResponse.name }),
      response: summarizeJsonValue(
        functionResponse.response,
        0,
        new WeakSet<object>(),
      ),
    }).slice(0, CATALOG_PREVIEW_LIMIT);
  } catch {
    return '';
  }
}

function summarizeJsonValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') {
    return value.slice(0, CATALOG_PREVIEW_LIMIT);
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  if (depth >= 2) return '[Nested value]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, 6)
      .map((entry) => summarizeJsonValue(entry, depth + 1, seen));
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 6)
      .map(([key, entry]) => [key, summarizeJsonValue(entry, depth + 1, seen)]),
  );
}

function proofKindOf(
  provenance: GoalEvidenceProvenance,
): GoalEvidenceProofKind {
  if (provenance === 'real_user') return 'user_input';
  if (provenance === 'assistant_output') return 'delivered_output';
  return 'external_fact';
}

function parseGoalContext(value: unknown): ParsedGoalContext | undefined {
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

function claimsGoalRevision(value: unknown, goal: GoalRecord): boolean {
  if (!isRecord(value)) return false;
  return value['goalId'] === goal.goalId && value['revision'] === goal.revision;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
