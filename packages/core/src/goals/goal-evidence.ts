/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import { createHash } from 'node:crypto';
import { ToolNames } from '../tools/tool-names.js';
import { parseGoalStateRecordPayloadV2 } from './goal-reducer.js';
import {
  goalLimitKindForReason,
  type GoalEvidenceCheckpointClaim,
  type GoalEvidenceProofKind,
  type GoalRecord,
  type GoalTerminalProposal,
  type GoalTurnPermit,
} from './goal-protocol.js';
import {
  isUserPromptSubmitContextPartText,
  projectUserTranscriptForDisplay,
} from '../utils/transcript-records.js';

// Previews are cut to a character count while building — cheap, and it bounds
// the work — but the catalog budget they feed is denominated in bytes, so the
// guarantee has to be too. In UTF-8 the two units differ by up to 4x: 240 CJK
// characters are 720 bytes, so a full 32-claim checkpoint of Chinese evidence
// serialized to ~29kB against a 24kB catalog and marked the window truncated
// before a single new record was even scanned — which switched compaction off
// permanently. `capPreviewBytes` is what actually holds the bound; the
// character slices below only keep the intermediate strings small.
const CATALOG_PREVIEW_LIMIT = 240;
const CATALOG_PREVIEW_BYTE_LIMIT = 240;
const CATALOG_ENTRY_LIMIT = 100;
const CATALOG_BYTE_LIMIT = 24_000;
const CATALOG_LINEAGE_LIMIT = 16;
const CHECKPOINT_ENTRY_THRESHOLD = 80;
const CHECKPOINT_BYTE_THRESHOLD = 19_200;
// 100 catalogued records x 2_000 bytes of content stays inside the
// checkpoint verifier's 256_000-byte request limit once previous claims and
// request envelope overhead are added, so one oversized tool output cannot
// permanently exhaust a healthy Goal.
const CHECKPOINT_CONTENT_BYTE_LIMIT = 2_000;
const CHECKPOINT_CONTENT_TRUNCATION_MARKER = '\n\u2026[truncated]';
export const GOAL_EVIDENCE_REFERENCE_LIMIT = CATALOG_ENTRY_LIMIT;
const EVIDENCE_SLICE_BYTE_LIMIT = 24_000;

export type GoalEvidenceProvenance =
  | 'real_user'
  | 'assistant_output'
  | 'tool_result'
  | 'goal_checkpoint';

type GoalRecordProvenance =
  | GoalEvidenceProvenance
  | 'goal_control'
  | 'goal_runtime'
  | 'system';

export interface GoalEvidenceRecord {
  uuid: string;
  timestamp?: string;
  agentId?: string;
  parentToolCallId?: string;
  type: 'user' | 'assistant' | 'tool_result' | 'system';
  subtype?: string;
  provenance?: GoalRecordProvenance;
  goalContext?: unknown;
  message?: { parts?: Part[] };
  systemPayload?: unknown;
  toolCallResult?: unknown;
  sourceComplete?: boolean;
  missingReason?: string;
}

export type { GoalEvidenceProofKind } from './goal-protocol.js';

export interface GoalEvidenceCatalogEntry {
  uuid: string;
  timestamp?: string;
  agentId?: string;
  parentToolCallId?: string;
  provenance: GoalEvidenceProvenance;
  turnId: string;
  preview: string;
  proofKind: GoalEvidenceProofKind;
  sourceComplete?: boolean;
  missingReason?: string;
}

export interface GoalEvidenceCatalog {
  entries: GoalEvidenceCatalogEntry[];
  lineageTurnIds: string[];
  truncated: boolean;
  hasMore?: boolean;
  nextCursor?: string;
  scopeStart?: string;
  snapshotTail?: string;
  snapshotId?: string;
}

export interface ValidatedGoalEvidenceRecord extends GoalEvidenceCatalogEntry {
  content: string;
}

export interface ValidatedGoalEvidence {
  citedRecords: ValidatedGoalEvidenceRecord[];
}

export interface GoalEvidenceContext {
  records: readonly GoalEvidenceRecord[];
  auditRecords?: readonly GoalEvidenceRecord[];
  goal: GoalRecord;
  permit: GoalTurnPermit;
}

export interface GoalEvidenceValidationInput extends GoalEvidenceContext {
  proposal: GoalTerminalProposal;
}

export interface GoalEvidenceCheckpointWindow {
  previousClaims: GoalEvidenceCheckpointClaim[];
  evidence: ValidatedGoalEvidenceRecord[];
  truncated: boolean;
  shouldCheckpoint: boolean;
}

export type EvidenceSourceUnavailableCode =
  | 'cursor_unset'
  | 'cursor_not_found'
  | 'duplicate_record_uuid'
  | 'permit_goal_mismatch'
  | 'malformed_turn_context'
  | 'turn_reentry'
  | 'current_turn_not_tail'
  | 'scope_unavailable'
  | 'invalid_read_cursor';

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
  | 'catalog_truncated'
  | 'immediate_blocker_external_evidence_required'
  | 'infeasible_blocker_external_fact_required'
  | 'immediate_blocker_newer_evidence_required'
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
  currentStateStartIndex?: number;
  allEntries: GoalEvidenceCatalogEntry[];
  eligibleByUuid: Map<string, GoalEvidenceCatalogEntry>;
  indexByUuid: Map<string, number>;
  recordsByUuid: Map<string, GoalEvidenceRecord>;
  auditUuids: Set<string>;
  lineageTurnIds: string[];
}

interface ParsedGoalContext {
  goalId: string;
  revision: number;
  turnId: string;
}

export interface GoalEvidenceRecordIndexHint {
  uuid: string;
  parsedGoalContext?: {
    goalId: string;
    revision: number;
    turnId: string;
  };
  claimedGoalId?: string;
  claimedRevision?: number;
  provenance?: GoalEvidenceProvenance;
  hasCatalogEligibleContent: boolean;
  hasRawEligibleContent: boolean;
  catalogEntryBytes?: number;
}

export class GoalEvidenceRecordIndexAccumulator {
  private readonly uuid: string;
  private readonly parsedGoalContext?: ParsedGoalContext;
  private readonly claimedGoalId?: string;
  private readonly claimedRevision?: number;
  private readonly provenance?: GoalEvidenceProvenance;
  private readonly hasObjectSystemPayload: boolean;
  private readonly displayText?: string;
  private readonly hasHookContext: boolean;
  private prefixPreview = '';
  private lastPartPreviewValues: string[] = [];
  private lastPartIsHookContext = false;
  private partCount = 0;
  private hasRawEligibleContent = false;

  constructor(record: GoalEvidenceRecord) {
    this.uuid = record.uuid;
    this.parsedGoalContext = parseGoalContext(record.goalContext);
    const claimed = isRecord(record.goalContext)
      ? record.goalContext
      : undefined;
    this.claimedGoalId =
      typeof claimed?.['goalId'] === 'string' ? claimed['goalId'] : undefined;
    this.claimedRevision =
      typeof claimed?.['revision'] === 'number'
        ? claimed['revision']
        : undefined;
    this.provenance = this.parsedGoalContext
      ? coherentEvidenceProvenance(record)
      : undefined;
    const systemPayload = isRecord(record.systemPayload)
      ? record.systemPayload
      : undefined;
    this.hasObjectSystemPayload = systemPayload !== undefined;
    this.displayText =
      typeof systemPayload?.['displayText'] === 'string'
        ? systemPayload['displayText'].slice(0, CATALOG_PREVIEW_LIMIT)
        : undefined;
    this.hasHookContext = typeof systemPayload?.['hookContext'] === 'string';
    this.addFragment(record);
  }

  addFragment(record: GoalEvidenceRecord): void {
    if (!this.provenance) return;
    for (const part of record.message?.parts ?? []) {
      this.finishPreviousPart();
      const previewValues: string[] = [];
      if (part.thought !== true && typeof part.text === 'string') {
        previewValues.push(part.text.slice(0, CATALOG_PREVIEW_LIMIT));
        if (part.text.trim()) this.hasRawEligibleContent = true;
      }
      if (
        part.thought !== true &&
        this.provenance === 'tool_result' &&
        part.functionResponse
      ) {
        previewValues.push(renderToolResponsePreview(part.functionResponse));
        if (part.functionResponse.response !== undefined) {
          this.hasRawEligibleContent = true;
        }
      }
      this.lastPartPreviewValues = previewValues;
      this.lastPartIsHookContext =
        typeof part.text === 'string' &&
        isUserPromptSubmitContextPartText(part.text);
      this.partCount++;
    }
  }

  finish(): GoalEvidenceRecordIndexHint {
    let preview: string;
    const hasFinalHookContextPart =
      this.partCount > 1 && this.lastPartIsHookContext;
    if (
      this.provenance === 'real_user' &&
      (this.hasHookContext || hasFinalHookContextPart) &&
      this.displayText !== undefined
    ) {
      preview = this.displayText.slice(0, CATALOG_PREVIEW_LIMIT).trim();
    } else if (
      this.provenance === 'real_user' &&
      !this.hasObjectSystemPayload &&
      hasFinalHookContextPart
    ) {
      preview = this.prefixPreview.trim();
    } else {
      preview = appendPreviewValues(
        this.prefixPreview,
        this.lastPartPreviewValues,
      ).trim();
    }
    preview = capPreviewBytes(preview, CATALOG_PREVIEW_BYTE_LIMIT);
    const catalogEntry =
      this.provenance && this.parsedGoalContext && preview
        ? {
            uuid: this.uuid,
            provenance: this.provenance,
            turnId: this.parsedGoalContext.turnId,
            preview,
            proofKind: proofKindOf(this.provenance),
          }
        : undefined;
    return {
      uuid: this.uuid,
      ...(this.parsedGoalContext
        ? { parsedGoalContext: this.parsedGoalContext }
        : {}),
      ...(this.claimedGoalId !== undefined
        ? { claimedGoalId: this.claimedGoalId }
        : {}),
      ...(this.claimedRevision !== undefined
        ? { claimedRevision: this.claimedRevision }
        : {}),
      ...(this.provenance ? { provenance: this.provenance } : {}),
      hasCatalogEligibleContent: catalogEntry !== undefined,
      hasRawEligibleContent: this.hasRawEligibleContent,
      ...(catalogEntry
        ? {
            catalogEntryBytes: Buffer.byteLength(
              JSON.stringify(catalogEntry),
              'utf8',
            ),
          }
        : {}),
    };
  }

  private finishPreviousPart(): void {
    if (this.partCount === 0) return;
    this.prefixPreview = appendPreviewValues(
      this.prefixPreview,
      this.lastPartPreviewValues,
    );
  }
}

function appendPreviewValues(
  current: string,
  values: readonly string[],
): string {
  let preview = current;
  for (const value of values) {
    if (!value || preview.length >= CATALOG_PREVIEW_LIMIT) continue;
    const separator = preview ? '\n' : '';
    const remaining = CATALOG_PREVIEW_LIMIT - preview.length;
    preview += `${separator}${value}`.slice(0, remaining);
  }
  return preview;
}

export class GoalEvidenceCheckpointAccumulator {
  private readonly candidateUuids: string[] = [];
  private readonly candidateUuidSet = new Set<string>();
  private readonly captured = new Map<string, ValidatedGoalEvidenceRecord>();
  private readonly checkpointEntries: GoalEvidenceCatalogEntry[];
  private readonly truncated: boolean;
  private readonly shouldCheckpoint: boolean;

  constructor(
    hints: readonly GoalEvidenceRecordIndexHint[],
    private readonly goal: GoalRecord,
    permit: GoalTurnPermit,
  ) {
    if (
      permit.goalId !== goal.goalId ||
      permit.revision !== goal.revision ||
      !isNonEmptyString(permit.turnId)
    ) {
      throw new EvidenceSourceUnavailableError(
        'permit_goal_mismatch',
        'The current Goal permit does not match the Goal evidence revision.',
      );
    }
    const indexByUuid = new Map<string, number>();
    for (let index = 0; index < hints.length; index++) {
      const uuid = hints[index]!.uuid;
      if (indexByUuid.has(uuid)) {
        throw new EvidenceSourceUnavailableError(
          'duplicate_record_uuid',
          `The active transcript chain contains duplicate record UUID ${uuid}.`,
        );
      }
      indexByUuid.set(uuid, index);
    }
    const cursorId = goal.evidenceCursor.recordId;
    if (cursorId === null) {
      throw new EvidenceSourceUnavailableError(
        'cursor_unset',
        'The Goal evidence cursor is not available.',
      );
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
    let currentTurnId: string | undefined;
    for (let index = cursorIndex + 1; index < hints.length; index++) {
      const hint = hints[index]!;
      const context = hint.parsedGoalContext;
      if (!context) {
        if (
          hint.claimedGoalId === goal.goalId &&
          hint.claimedRevision === goal.revision
        ) {
          throw new EvidenceSourceUnavailableError(
            'malformed_turn_context',
            `Goal-owned transcript record ${hint.uuid} has malformed turn context.`,
          );
        }
        continue;
      }
      if (
        context.goalId !== goal.goalId ||
        context.revision !== goal.revision
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
    if (lineageTurnIds.at(-1) !== permit.turnId) {
      throw new EvidenceSourceUnavailableError(
        'current_turn_not_tail',
        'The current Goal permit is not the tail of the active transcript lineage.',
      );
    }

    this.checkpointEntries = checkpointCatalogEntries(goal);
    const checkpointBytes = this.checkpointEntries.reduce(
      (total, entry) =>
        total + Buffer.byteLength(JSON.stringify(entry), 'utf8'),
      0,
    );
    let truncated =
      this.checkpointEntries.length >= CATALOG_ENTRY_LIMIT ||
      checkpointBytes > CATALOG_BYTE_LIMIT;
    const rawEntryLimit = Math.max(
      0,
      CATALOG_ENTRY_LIMIT - this.checkpointEntries.length,
    );
    let catalogBytes = checkpointBytes;
    for (
      let index = hints.length - 1;
      !truncated && index > cursorIndex;
      index--
    ) {
      const hint = hints[index]!;
      const context = hint.parsedGoalContext;
      if (
        !hint.provenance ||
        !context ||
        context.goalId !== goal.goalId ||
        context.revision !== goal.revision
      ) {
        continue;
      }
      if (this.candidateUuids.length >= rawEntryLimit) {
        if (hint.hasRawEligibleContent) {
          truncated = true;
          break;
        }
        continue;
      }
      if (!hint.hasCatalogEligibleContent) continue;
      const entryBytes = hint.catalogEntryBytes;
      if (
        entryBytes === undefined ||
        catalogBytes + entryBytes > CATALOG_BYTE_LIMIT
      ) {
        truncated = true;
        break;
      }
      this.candidateUuids.push(hint.uuid);
      this.candidateUuidSet.add(hint.uuid);
      catalogBytes += entryBytes;
    }
    this.truncated = truncated;
    // A truncated window is the case that most needs compressing, not the one
    // that should skip it: the budget is already full, and the newest evidence
    // that did fit is exactly what a checkpoint would fold into claims. Gating
    // compaction on `!truncated` meant the one state compaction exists to
    // resolve was the one state it refused to run in, and the Goal was stopped
    // instead. Compress whatever the window did capture; the older evidence
    // left behind is already covered by the previous checkpoint's claims.
    this.shouldCheckpoint =
      this.candidateUuids.length > 0 &&
      (truncated ||
        this.checkpointEntries.length + this.candidateUuids.length >=
          CHECKPOINT_ENTRY_THRESHOLD ||
        catalogBytes >= CHECKPOINT_BYTE_THRESHOLD);
  }

  getCandidateUuids(): readonly string[] {
    return this.shouldCheckpoint ? this.candidateUuids : [];
  }

  capture(record: GoalEvidenceRecord): void {
    if (!this.shouldCheckpoint || !this.candidateUuidSet.has(record.uuid)) {
      return;
    }
    const provenance = coherentEvidenceProvenance(record);
    if (!provenance) return;
    const context = parseGoalContext(record.goalContext);
    if (
      !context ||
      context.goalId !== this.goal.goalId ||
      context.revision !== this.goal.revision
    ) {
      return;
    }
    const preview = evidencePreview(record, provenance);
    const content = evidenceContent(record, provenance);
    if (!preview || !content) return;
    this.captured.set(record.uuid, {
      uuid: record.uuid,
      provenance,
      turnId: context.turnId,
      preview,
      proofKind: proofKindOf(provenance),
      content: capCheckpointContent(content),
    });
  }

  finish(): GoalEvidenceCheckpointWindow {
    const selected = this.shouldCheckpoint
      ? this.candidateUuids.map((uuid) => {
          const entry = this.captured.get(uuid);
          if (!entry) {
            throw new InvalidGoalEvidenceReferenceError(
              'ineligible_reference',
              `Transcript record ${uuid} has no eligible evidence content.`,
              uuid,
            );
          }
          return entry;
        })
      : [];
    selected.reverse();
    return {
      previousClaims: structuredClone(
        this.goal.evidenceCheckpoint?.claims ?? [],
      ),
      evidence: selected,
      truncated: this.truncated,
      shouldCheckpoint: this.shouldCheckpoint,
    };
  }
}

export function getGoalEvidenceRecordIndexHint(
  record: GoalEvidenceRecord,
): GoalEvidenceRecordIndexHint {
  return new GoalEvidenceRecordIndexAccumulator(record).finish();
}

export function buildGoalEvidenceCatalog(
  input: GoalEvidenceContext,
): GoalEvidenceCatalog {
  const snapshot = createGoalEvidenceSnapshot(input);
  const page = snapshot.list({ direction: 'backward' });
  return {
    ...page,
    lineageTurnIds: snapshot.lineageTurnIds.slice(-CATALOG_LINEAGE_LIMIT),
    truncated: page.hasMore,
  };
}

export function buildGoalEvidenceCheckpointWindow(
  input: GoalEvidenceContext,
): GoalEvidenceCheckpointWindow {
  const accumulator = new GoalEvidenceCheckpointAccumulator(
    input.records.map(getGoalEvidenceRecordIndexHint),
    input.goal,
    input.permit,
  );
  const recordsByUuid = new Map(
    input.records.map((record) => [record.uuid, record]),
  );
  for (const uuid of accumulator.getCandidateUuids()) {
    const record = recordsByUuid.get(uuid);
    if (record) accumulator.capture(record);
  }
  return accumulator.finish();
}

export function validateGoalEvidenceReferences(
  input: GoalEvidenceValidationInput,
): ValidatedGoalEvidence {
  return validateEvidenceReferences(input);
}

function validateEvidenceReferences(
  input: GoalEvidenceValidationInput,
  existingAnalysis?: EvidenceAnalysis,
): ValidatedGoalEvidence {
  const references = input.proposal.evidenceRefs;
  if (references.length === 0) {
    throw new InvalidGoalEvidenceReferenceError(
      'no_evidence_references',
      'A terminal Goal proposal must cite at least one evidence record.',
    );
  }
  if (references.length > GOAL_EVIDENCE_REFERENCE_LIMIT) {
    throw new InvalidGoalEvidenceReferenceError(
      'too_many_evidence_references',
      `A terminal Goal proposal may cite at most ${GOAL_EVIDENCE_REFERENCE_LIMIT} evidence records.`,
    );
  }
  if (new Set(references).size !== references.length) {
    throw new InvalidGoalEvidenceReferenceError(
      'duplicate_evidence_reference',
      'A terminal Goal proposal must not cite the same evidence record more than once.',
    );
  }

  const analysis = existingAnalysis ?? analyzeEvidence(input);
  const citedRecords = references.flatMap((reference) => {
    const claim = input.goal.evidenceCheckpoint?.claims.find(
      (entry) => entry.id === reference,
    );
    const originals = claim ? claim.sourceRefs : [reference];
    if (originals.length === 0) {
      throw new InvalidGoalEvidenceReferenceError(
        'missing_reference',
        `Checkpoint claim ${reference} has no recorded original sources.`,
        reference,
      );
    }
    return originals.map((original) => {
      const validated = validateReference(original, input, analysis);
      if (claim && validated.proofKind !== claim.proofKind) {
        throw new InvalidGoalEvidenceReferenceError(
          'ineligible_reference',
          `Checkpoint claim ${reference} does not match its original source proof kind.`,
          reference,
        );
      }
      return validated;
    });
  });
  const externalFacts = citedRecords.filter(
    (record) => record.proofKind === 'external_fact',
  );
  if (
    input.proposal.status === 'complete' &&
    analysis.currentStateStartIndex !== undefined &&
    externalFacts.length > 0 &&
    externalFacts.every(
      (record) =>
        evidenceOrder(record, input, analysis) <=
        analysis.currentStateStartIndex!,
    )
  ) {
    throw new InvalidGoalEvidenceReferenceError(
      'pre_cursor_reference',
      'The cited external facts precede the legacy evidence reset. Cite fresh current-state proof; earlier history remains available for action auditing.',
    );
  }
  validateBlockerCoverage(input.proposal, citedRecords, analysis);
  return {
    citedRecords: [
      ...new Map(citedRecords.map((entry) => [entry.uuid, entry])).values(),
    ],
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
  const cursorIndex = resolveScopeStart(input, indexByUuid);
  const lineageTurnIds = collectLineageTurnIds(input, cursorIndex);
  if (lineageTurnIds.at(-1) !== input.permit.turnId) {
    throw new EvidenceSourceUnavailableError(
      'current_turn_not_tail',
      'The current Goal permit is not the tail of the active transcript lineage.',
    );
  }

  const recordsByUuid = new Map(
    input.records.map((record) => [record.uuid, record]),
  );
  const auditUuids = new Set<string>();
  for (const [index, record] of (input.auditRecords ?? []).entries()) {
    const context = parseGoalContext(record.goalContext);
    if (
      !context ||
      context.goalId !== input.goal.goalId ||
      context.revision !== input.goal.revision ||
      !lineageTurnIds.includes(context.turnId)
    ) {
      throw new EvidenceSourceUnavailableError(
        'malformed_turn_context',
        `Derived evidence ${record.uuid} is outside the authorized Goal lineage.`,
      );
    }
    if (recordsByUuid.has(record.uuid)) {
      throw new EvidenceSourceUnavailableError(
        'duplicate_record_uuid',
        `Derived evidence duplicates record UUID ${record.uuid}.`,
      );
    }
    auditUuids.add(record.uuid);
    recordsByUuid.set(record.uuid, record);
    indexByUuid.set(record.uuid, input.records.length + index);
  }
  const allEntries = input.records.slice(cursorIndex + 1).flatMap((record) => {
    const entry = catalogEvidence(record, input);
    return entry ? [entry] : [];
  });
  for (const record of input.auditRecords ?? []) {
    if (coherentEvidenceProvenance(record) !== 'tool_result') continue;
    const entry = catalogEvidence(record, input);
    if (entry) allEntries.push(entry);
  }
  return {
    cursorIndex,
    currentStateStartIndex: legacyCurrentStateStart(input, cursorIndex),
    allEntries,
    eligibleByUuid: new Map(allEntries.map((entry) => [entry.uuid, entry])),
    indexByUuid,
    recordsByUuid,
    auditUuids,
    lineageTurnIds,
  };
}

function resolveScopeStart(
  input: GoalEvidenceContext,
  indices: ReadonlyMap<string, number>,
): number {
  let hasMovedCursor = Boolean(input.goal.evidenceCheckpoint);
  for (let index = 0; index < input.records.length; index++) {
    const record = input.records[index]!;
    if (record.type !== 'system' || record.subtype !== 'goal_state') continue;
    const payload = parseGoalStateRecordPayloadV2(record.systemPayload);
    const state = payload?.snapshot.goal;
    if (
      !payload ||
      !state ||
      state.goalId !== input.goal.goalId ||
      state.revision !== input.goal.revision
    )
      continue;
    const cause = payload.cause;
    if (
      cause === 'create' ||
      cause === 'replace' ||
      cause === 'edit' ||
      cause === 'migrated'
    ) {
      return index;
    }
    if (cause === 'checkpoint' || cause === 'resume') hasMovedCursor = true;
  }
  if (hasMovedCursor) {
    throw new EvidenceSourceUnavailableError(
      'scope_unavailable',
      'The current Goal revision start is missing; a checkpoint or resume cursor cannot establish evidence scope.',
    );
  }
  const cursorId = input.goal.evidenceCursor.recordId;
  if (cursorId === null) {
    throw new EvidenceSourceUnavailableError(
      'cursor_unset',
      'The Goal evidence scope start is not available.',
    );
  }
  const index = indices.get(cursorId);
  if (index === undefined) {
    throw new EvidenceSourceUnavailableError(
      'cursor_not_found',
      `The Goal evidence scope start ${cursorId} is not in the active transcript chain.`,
    );
  }
  if (
    input.records
      .slice(0, index + 1)
      .some((record) => claimsGoalRevision(record.goalContext, input.goal))
  ) {
    throw new EvidenceSourceUnavailableError(
      'scope_unavailable',
      'The Goal cursor would omit earlier actions without a recorded revision start.',
    );
  }
  return index;
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
  input: GoalEvidenceContext,
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
      `Evidence reference ${reference} precedes the current Goal revision scope.`,
      reference,
    );
  }

  const record = analysis.recordsByUuid.get(reference)!;
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
      `Evidence reference ${reference} has no eligible recorded content in the authorized Goal scope.`,
      reference,
    );
  }
  const rendered = evidenceContentWithCalls(
    record,
    catalogEntry.provenance,
    analysis.auditUuids.has(reference)
      ? (input.auditRecords ?? [])
      : input.records,
  );
  const { content } = rendered;
  if (!content) {
    throw new InvalidGoalEvidenceReferenceError(
      'ineligible_reference',
      `Transcript record ${reference} has no eligible evidence content.`,
      reference,
    );
  }
  return { ...catalogEntry, ...rendered };
}

function validateBlockerCoverage(
  proposal: GoalTerminalProposal,
  citedRecords: readonly ValidatedGoalEvidenceRecord[],
  analysis: EvidenceAnalysis,
): void {
  if (proposal.status !== 'blocked') return;

  // Infeasibility is a claim about the world, so it is held to external
  // facts only: user input can authorise stopping, but it cannot make an
  // objective impossible, and assistant prose saying so is exactly the
  // "I think this can't be done" exit this kind must not become.
  if (
    proposal.blockerKind === 'infeasible' &&
    !citedRecords.some(({ proofKind }) => proofKind === 'external_fact')
  ) {
    throw new InvalidGoalEvidenceReferenceError(
      'infeasible_blocker_external_fact_required',
      'An infeasible blocker requires cited external tool evidence of the fact that makes the objective unsatisfiable.',
    );
  }

  if (
    proposal.blockerKind === 'authority' ||
    proposal.blockerKind === 'external' ||
    proposal.blockerKind === 'infeasible'
  ) {
    if (
      !citedRecords.some(
        ({ proofKind }) =>
          proofKind === 'user_input' || proofKind === 'external_fact',
      )
    ) {
      throw new InvalidGoalEvidenceReferenceError(
        'immediate_blocker_external_evidence_required',
        'An immediate blocker requires cited user input or external tool evidence.',
      );
    }
    if (
      !citedRecords.some(
        (record) =>
          record.turnId === analysis.lineageTurnIds.at(-1) &&
          (record.proofKind === 'external_fact' ||
            (proposal.blockerKind !== 'infeasible' &&
              record.proofKind === 'user_input')),
      )
    ) {
      throw new InvalidGoalEvidenceReferenceError(
        'immediate_blocker_newer_evidence_required',
        'An immediate blocker requires current-turn user input or external tool evidence.',
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

function checkpointCatalogEntries(
  goal: GoalRecord,
): GoalEvidenceCatalogEntry[] {
  const checkpoint = goal.evidenceCheckpoint;
  if (!checkpoint) return [];
  return checkpoint.claims.map((claim) => ({
    uuid: claim.id,
    provenance: 'goal_checkpoint',
    turnId: `checkpoint:${checkpoint.checkpointId}`,
    preview: capPreviewBytes(
      claim.claim.slice(0, CATALOG_PREVIEW_LIMIT),
      CATALOG_PREVIEW_BYTE_LIMIT,
    ),
    proofKind: claim.proofKind,
  }));
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
    ...(record.timestamp ? { timestamp: record.timestamp } : {}),
    ...(record.agentId ? { agentId: record.agentId } : {}),
    ...(record.parentToolCallId
      ? { parentToolCallId: record.parentToolCallId }
      : {}),
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

/**
 * Cut `value` to at most `limit` UTF-8 bytes without splitting a code point.
 */
export function capPreviewBytes(value: string, limit: number): string {
  if (Buffer.byteLength(value, 'utf8') <= limit) {
    return value;
  }
  let byteLength = 0;
  let cutoff = 0;
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
    if (byteLength + codePointBytes > limit) break;
    byteLength += codePointBytes;
    cutoff += codePoint.length;
  }
  return value.slice(0, cutoff);
}

function capCheckpointContent(content: string): string {
  if (Buffer.byteLength(content, 'utf8') <= CHECKPOINT_CONTENT_BYTE_LIMIT) {
    return content;
  }
  const budget =
    CHECKPOINT_CONTENT_BYTE_LIMIT -
    Buffer.byteLength(CHECKPOINT_CONTENT_TRUNCATION_MARKER, 'utf8');
  let byteLength = 0;
  let cutoff = 0;
  for (const codePoint of content) {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
    if (byteLength + codePointBytes > budget) break;
    byteLength += codePointBytes;
    cutoff += codePoint.length;
  }
  return `${content.slice(0, cutoff)}${CHECKPOINT_CONTENT_TRUNCATION_MARKER}`;
}

function evidenceContent(
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
    if (
      part.thought !== true &&
      provenance === 'tool_result' &&
      part.functionResponse
    ) {
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
  const projection =
    provenance === 'real_user'
      ? projectUserTranscriptForDisplay(record)
      : undefined;
  if (projection?.displayText !== undefined) {
    return capPreviewBytes(
      projection.displayText.slice(0, CATALOG_PREVIEW_LIMIT).trim(),
      CATALOG_PREVIEW_BYTE_LIMIT,
    );
  }
  let preview = '';
  const append = (value: string) => {
    if (!value || preview.length >= CATALOG_PREVIEW_LIMIT) return;
    const separator = preview ? '\n' : '';
    const remaining = CATALOG_PREVIEW_LIMIT - preview.length;
    preview += `${separator}${value}`.slice(0, remaining);
  };

  const parts = projection?.parts ?? record.message?.parts ?? [];
  for (const part of parts) {
    if (part.thought !== true && typeof part.text === 'string') {
      append(part.text);
    }
    if (
      part.thought !== true &&
      provenance === 'tool_result' &&
      part.functionResponse
    ) {
      append(renderToolResponsePreview(part.functionResponse));
    }
    if (preview.length >= CATALOG_PREVIEW_LIMIT) break;
  }
  return capPreviewBytes(preview.trim(), CATALOG_PREVIEW_BYTE_LIMIT);
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

export interface GoalEvidencePage {
  entries: GoalEvidenceCatalogEntry[];
  hasMore: boolean;
  nextCursor?: string;
  scopeStart: string;
  snapshotTail: string;
  snapshotId: string;
}

export interface GoalEvidenceSlice extends ValidatedGoalEvidenceRecord {
  start: number;
  end: number;
  totalBytes: number;
  complete: boolean;
  sourceComplete: boolean;
  nextCursor?: string;
}

export interface GoalEvidenceListRequest {
  cursor?: string;
  limit?: number;
  direction?: 'forward' | 'backward';
}

export interface GoalEvidenceReadRequest {
  reference: string;
  cursor?: string;
  maxBytes?: number;
}

interface EvidenceReadCursor {
  snapshotId: string;
  kind: 'list' | 'read';
  offset: number;
  reference?: string;
  direction?: 'forward' | 'backward';
}

export function createGoalEvidenceSnapshot(
  input: GoalEvidenceContext,
  options: { auditRecords?: readonly GoalEvidenceRecord[] } = {},
): GoalEvidenceSnapshot {
  return new GoalEvidenceSnapshot({
    ...input,
    ...(options.auditRecords ? { auditRecords: options.auditRecords } : {}),
  });
}

export class GoalEvidenceSnapshot {
  readonly scopeStart: string;
  readonly currentStateStart?: string;
  readonly snapshotTail: string;
  readonly snapshotId: string;
  readonly lineageTurnIds: readonly string[];
  readonly coverageUnavailable: readonly string[];
  private readonly input: GoalEvidenceContext;
  private readonly analysis: EvidenceAnalysis;
  private readonly contents = new Map<string, ValidatedGoalEvidenceRecord>();

  constructor(input: GoalEvidenceContext) {
    this.input = structuredClone(input);
    this.analysis = analyzeEvidence(this.input);
    this.scopeStart = this.input.records[this.analysis.cursorIndex]!.uuid;
    this.currentStateStart =
      this.analysis.currentStateStartIndex === undefined
        ? undefined
        : this.input.records[this.analysis.currentStateStartIndex]!.uuid;
    this.snapshotTail = this.input.records.at(-1)!.uuid;
    this.snapshotId = createHash('sha256')
      .update(
        JSON.stringify([
          input.goal.goalId,
          input.goal.revision,
          this.scopeStart,
          this.snapshotTail,
          this.input.auditRecords ?? [],
        ]),
      )
      .digest('hex');
    this.lineageTurnIds = Object.freeze([...this.analysis.lineageTurnIds]);
    this.coverageUnavailable = Object.freeze([
      ...orphanedCalls(
        this.input.records.slice(this.analysis.cursorIndex + 1),
        this.input.goal,
      ),
      ...orphanedCalls(this.input.auditRecords ?? [], this.input.goal),
      ...unreadableMedia(
        [
          ...this.input.records.slice(this.analysis.cursorIndex + 1),
          ...(this.input.auditRecords ?? []),
        ],
        this.input.goal,
      ),
    ]);
  }

  get entries(): readonly GoalEvidenceCatalogEntry[] {
    return this.analysis.allEntries.map((entry) => ({ ...entry }));
  }

  list(request: GoalEvidenceListRequest = {}): GoalEvidencePage {
    const cursor = request.cursor
      ? this.decodeCursor(request.cursor, 'list')
      : undefined;
    const direction = cursor?.direction ?? request.direction ?? 'forward';
    if (cursor && request.direction && cursor.direction !== request.direction) {
      this.invalidCursor();
    }
    const limit = request.limit ?? CATALOG_ENTRY_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > CATALOG_ENTRY_LIMIT) {
      throw new RangeError(
        `Goal evidence page limit must be between 1 and ${CATALOG_ENTRY_LIMIT}.`,
      );
    }
    let index =
      cursor?.offset ??
      (direction === 'forward' ? 0 : this.analysis.allEntries.length - 1);
    const entries: GoalEvidenceCatalogEntry[] = [];
    let bytes = 0;
    while (
      index >= 0 &&
      index < this.analysis.allEntries.length &&
      entries.length < limit
    ) {
      const entry = this.analysis.allEntries[index]!;
      const original = this.fullRecord(entry.uuid);
      const listed = {
        ...entry,
        sourceComplete: original.sourceComplete,
        ...(original.missingReason
          ? { missingReason: original.missingReason }
          : {}),
      };
      const size = Buffer.byteLength(JSON.stringify(listed), 'utf8') + 1;
      if (bytes + size + 2 > CATALOG_BYTE_LIMIT) break;
      entries.push(listed);
      bytes += size;
      index += direction === 'forward' ? 1 : -1;
    }
    if (direction === 'backward') entries.reverse();
    const hasMore = index >= 0 && index < this.analysis.allEntries.length;
    if (hasMore && entries.length === 0) {
      throw new EvidenceSourceUnavailableError(
        'scope_unavailable',
        'A Goal evidence directory entry exceeds the page capacity.',
      );
    }
    return {
      entries,
      hasMore,
      ...(hasMore
        ? {
            nextCursor: this.encodeCursor({
              kind: 'list',
              offset: index,
              direction,
            }),
          }
        : {}),
      scopeStart: this.scopeStart,
      snapshotTail: this.snapshotTail,
      snapshotId: this.snapshotId,
    };
  }

  read(request: GoalEvidenceReadRequest): GoalEvidenceSlice {
    const record = this.fullRecord(request.reference);
    const cursor = request.cursor
      ? this.decodeCursor(request.cursor, 'read')
      : undefined;
    if (cursor && cursor.reference !== request.reference) this.invalidCursor();
    const start = cursor?.offset ?? 0;
    const maxBytes = request.maxBytes ?? EVIDENCE_SLICE_BYTE_LIMIT;
    if (
      !Number.isInteger(maxBytes) ||
      maxBytes < 4 ||
      maxBytes > EVIDENCE_SLICE_BYTE_LIMIT
    ) {
      throw new RangeError(
        `Goal evidence read size must be between 4 and ${EVIDENCE_SLICE_BYTE_LIMIT} bytes.`,
      );
    }
    const bytes = Buffer.from(record.content, 'utf8');
    if (
      start > bytes.length ||
      (start < bytes.length && (bytes[start]! & 0xc0) === 0x80)
    )
      this.invalidCursor();
    let end = Math.min(bytes.length, start + maxBytes);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    const complete = end === bytes.length;
    return {
      ...record,
      content: bytes.subarray(start, end).toString('utf8'),
      sourceComplete: record.sourceComplete !== false,
      start,
      end,
      totalBytes: bytes.length,
      complete,
      ...(!complete
        ? {
            nextCursor: this.encodeCursor({
              kind: 'read',
              offset: end,
              reference: request.reference,
            }),
          }
        : {}),
    };
  }

  validate(proposal: GoalTerminalProposal): ValidatedGoalEvidence {
    return validateEvidenceReferences(
      { ...this.input, proposal },
      this.analysis,
    );
  }

  requiredEvidence(
    proposal: GoalTerminalProposal,
    options: { includeHistoricalActions?: boolean } = {},
  ): string[] {
    const cited = this.validate(proposal).citedRecords;
    const externalIndices = cited
      .filter((record) => record.proofKind === 'external_fact')
      .map((record) => evidenceOrder(record, this.input, this.analysis));
    const turnStart = this.input.records.findIndex(
      (record, index) =>
        index > this.analysis.cursorIndex &&
        parseGoalContext(record.goalContext)?.turnId ===
          this.input.permit.turnId,
    );
    const tailStart = externalIndices.length
      ? Math.min(...externalIndices)
      : turnStart;
    const citedIds = new Set(cited.map((record) => record.uuid));
    return this.analysis.allEntries
      .filter(
        (entry) =>
          citedIds.has(entry.uuid) ||
          this.analysis.auditUuids.has(entry.uuid) ||
          entry.proofKind === 'user_input' ||
          (entry.proofKind === 'delivered_output' &&
            entry.turnId === this.input.permit.turnId) ||
          (options.includeHistoricalActions &&
            entry.proofKind === 'external_fact') ||
          this.analysis.indexByUuid.get(entry.uuid)! >= tailStart,
      )
      .map((entry) => entry.uuid);
  }

  private fullRecord(reference: string): ValidatedGoalEvidenceRecord {
    const cached = this.contents.get(reference);
    if (cached) return cached;
    const record = validateReference(reference, this.input, this.analysis);
    this.contents.set(reference, record);
    return record;
  }

  private encodeCursor(cursor: Omit<EvidenceReadCursor, 'snapshotId'>): string {
    return Buffer.from(
      JSON.stringify({ ...cursor, snapshotId: this.snapshotId }),
    ).toString('base64url');
  }

  private decodeCursor(
    value: string,
    kind: EvidenceReadCursor['kind'],
  ): EvidenceReadCursor {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    } catch {
      this.invalidCursor();
    }
    if (
      !isRecord(parsed) ||
      parsed['snapshotId'] !== this.snapshotId ||
      parsed['kind'] !== kind ||
      typeof parsed['offset'] !== 'number' ||
      !Number.isInteger(parsed['offset']) ||
      parsed['offset'] < 0 ||
      (kind === 'list' &&
        parsed['direction'] !== 'forward' &&
        parsed['direction'] !== 'backward') ||
      (kind === 'list' &&
        parsed['offset'] >= this.analysis.allEntries.length) ||
      (kind === 'read' && typeof parsed['reference'] !== 'string')
    )
      this.invalidCursor();
    return parsed as unknown as EvidenceReadCursor;
  }

  private invalidCursor(): never {
    throw new EvidenceSourceUnavailableError(
      'invalid_read_cursor',
      'The evidence cursor is invalid or belongs to a different frozen Goal snapshot.',
    );
  }
}

function evidenceContentWithCalls(
  record: GoalEvidenceRecord,
  provenance: GoalEvidenceProvenance,
  records: readonly GoalEvidenceRecord[],
): { content: string; sourceComplete: boolean; missingReason?: string } {
  const content = evidenceContent(record, provenance);
  const mediaReason = containsEvidenceMedia(record)
    ? 'The record contains media that the text evidence reader cannot fully inspect.'
    : undefined;
  if (provenance !== 'tool_result') {
    return {
      content,
      sourceComplete:
        record.sourceComplete !== false && mediaReason === undefined,
      ...(record.missingReason || mediaReason
        ? { missingReason: record.missingReason ?? mediaReason }
        : {}),
    };
  }
  const metadata = isRecord(record.toolCallResult)
    ? record.toolCallResult
    : undefined;
  const responses = (record.message?.parts ?? []).flatMap((part) =>
    part.thought !== true && part.functionResponse
      ? [part.functionResponse]
      : [],
  );
  const resultIndex = records.findIndex((entry) => entry.uuid === record.uuid);
  const context = parseGoalContext(record.goalContext);
  const calls: unknown[] = [];
  let missingCall = responses.length === 0;
  for (const response of responses) {
    const id = response.id ?? metadata?.['callId'];
    const matches = records
      .slice(0, resultIndex)
      .filter((entry) => {
        const callContext = parseGoalContext(entry.goalContext);
        return (
          entry.type === 'assistant' &&
          coherentEvidenceProvenance(entry) === 'assistant_output' &&
          callContext?.goalId === context?.goalId &&
          callContext?.revision === context?.revision &&
          callContext?.turnId === context?.turnId
        );
      })
      .flatMap((entry) =>
        (entry.message?.parts ?? []).flatMap((part) =>
          part.thought !== true &&
          part.functionCall &&
          typeof id === 'string' &&
          part.functionCall.id === id &&
          (!response.name || part.functionCall.name === response.name)
            ? [
                {
                  ...part.functionCall,
                  recordId: entry.uuid,
                  timestamp: entry.timestamp ?? null,
                  agentId: entry.agentId ?? null,
                  parentToolCallId: entry.parentToolCallId ?? null,
                },
              ]
            : [],
        ),
      );
    if (matches.length !== 1) missingCall = true;
    calls.push(...matches);
  }
  const truncated =
    record.sourceComplete === false ||
    responses.some((response) => hasTruncatedOutput(response.response)) ||
    (record.message?.parts ?? []).some(
      (part) => part.thought !== true && hasTruncatedOutput(part.text),
    );
  const missingReason =
    record.missingReason ??
    mediaReason ??
    (truncated
      ? 'The recorded tool result is truncated; its omitted original is unavailable in this evidence snapshot.'
      : missingCall
        ? 'The recorded tool result has no unique matching Goal-owned call and arguments.'
        : undefined);
  return {
    content: `${JSON.stringify({
      source: {
        recordId: record.uuid,
        timestamp: record.timestamp ?? null,
        agentId: record.agentId ?? null,
        parentToolCallId: record.parentToolCallId ?? null,
        temporalOrder:
          'Directory order is not execution order across transcripts; use timestamps and verified parent call/completion lineage. Missing or ambiguous ordering cannot establish freshness.',
      },
      toolCalls: calls,
      ...(metadata?.['executionStatus']
        ? { executionStatus: metadata['executionStatus'] }
        : {}),
    })}\n${content}`,
    sourceComplete: !truncated && !missingCall && mediaReason === undefined,
    ...(missingReason ? { missingReason } : {}),
  };
}

function orphanedCalls(
  records: readonly GoalEvidenceRecord[],
  goal: GoalRecord,
): string[] {
  const missing: string[] = [];
  for (const [index, record] of records.entries()) {
    const context = parseGoalContext(record.goalContext);
    if (
      coherentEvidenceProvenance(record) !== 'assistant_output' ||
      context?.goalId !== goal.goalId ||
      context.revision !== goal.revision
    )
      continue;
    for (const part of record.message?.parts ?? []) {
      const call = part.functionCall;
      if (
        part.thought === true ||
        !call ||
        call.name === ToolNames.GET_GOAL ||
        call.name === ToolNames.UPDATE_GOAL
      )
        continue;
      const matching = records.slice(index + 1).filter((result) => {
        const resultContext = parseGoalContext(result.goalContext);
        const metadata = isRecord(result.toolCallResult)
          ? result.toolCallResult
          : undefined;
        return (
          coherentEvidenceProvenance(result) === 'tool_result' &&
          resultContext?.goalId === context.goalId &&
          resultContext.revision === context.revision &&
          resultContext.turnId === context.turnId &&
          (result.message?.parts ?? []).some(
            (response) =>
              response.thought !== true &&
              response.functionResponse !== undefined &&
              typeof call.id === 'string' &&
              (response.functionResponse.id ?? metadata?.['callId']) ===
                call.id &&
              response.functionResponse?.name === call.name &&
              response.functionResponse.response !== undefined,
          )
        );
      });
      if (matching.length !== 1)
        missing.push(
          `Tool call ${call.id ?? record.uuid} (${call.name ?? 'unknown'}) has no unique recorded completion; its action coverage is unavailable.`,
        );
    }
  }
  return missing;
}

function hasTruncatedOutput(value: unknown): boolean {
  if (typeof value === 'string')
    return (
      value.startsWith('Tool output was too large and has been truncated') ||
      value.startsWith('<persisted-output>') ||
      (value.includes('... [CONTENT TRUNCATED] ...') &&
        value.endsWith('[Note: Could not save full output to file]'))
    );
  if (Array.isArray(value)) return value.some(hasTruncatedOutput);
  return isRecord(value) && Object.values(value).some(hasTruncatedOutput);
}

function legacyCurrentStateStart(
  input: GoalEvidenceContext,
  scopeStart: number,
): number | undefined {
  let previous: GoalRecord | undefined;
  let boundary: number | undefined;
  for (let index = scopeStart; index < input.records.length; index++) {
    const record = input.records[index]!;
    if (record.type !== 'system' || record.subtype !== 'goal_state') continue;
    const payload = parseGoalStateRecordPayloadV2(record.systemPayload);
    const state = payload?.snapshot.goal;
    if (
      !payload ||
      !state ||
      state.goalId !== input.goal.goalId ||
      state.revision !== input.goal.revision
    )
      continue;
    const limit =
      previous?.limitKind ?? goalLimitKindForReason(previous?.lastReason ?? '');
    if (
      payload.cause === 'resume' &&
      previous?.status === 'usage_limited' &&
      (limit === 'evidence_catalog' || limit === 'checkpoint_request') &&
      state.evidenceCursor.recordId !== previous.evidenceCursor.recordId
    )
      boundary = index;
    previous = state;
  }
  return boundary;
}

function evidenceOrder(
  record: ValidatedGoalEvidenceRecord,
  input: GoalEvidenceContext,
  analysis: EvidenceAnalysis,
): number {
  return analysis.auditUuids.has(record.uuid)
    ? input.records.findIndex(
        (entry, index) =>
          index > analysis.cursorIndex &&
          parseGoalContext(entry.goalContext)?.turnId === record.turnId,
      )
    : analysis.indexByUuid.get(record.uuid)!;
}

function unreadableMedia(
  records: readonly GoalEvidenceRecord[],
  goal: GoalRecord,
): string[] {
  return records.flatMap((record) => {
    const context = parseGoalContext(record.goalContext);
    if (
      !coherentEvidenceProvenance(record) ||
      context?.goalId !== goal.goalId ||
      context.revision !== goal.revision
    )
      return [];
    return containsEvidenceMedia(record)
      ? [
          `Evidence ${record.uuid} contains media that the text evidence reader cannot fully inspect.`,
        ]
      : [];
  });
}

function containsEvidenceMedia(record: GoalEvidenceRecord): boolean {
  return (record.message?.parts ?? []).some((part) => {
    if (part.thought === true) return false;
    if (part.inlineData || part.fileData) return true;
    const response = part.functionResponse;
    return (
      isRecord(response) &&
      Array.isArray(response['parts']) &&
      response['parts'].some(
        (item) =>
          isRecord(item) &&
          (item['inlineData'] !== undefined || item['fileData'] !== undefined),
      )
    );
  });
}
