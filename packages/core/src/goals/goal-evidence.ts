/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import {
  GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
  isRepeatedBlockerProposal,
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
const VERIFIER_EVIDENCE_BYTE_LIMIT = 256_000;

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
  type: 'user' | 'assistant' | 'tool_result' | 'system';
  subtype?: string;
  provenance?: GoalRecordProvenance;
  goalContext?: unknown;
  message?: { parts?: Part[] };
  systemPayload?: unknown;
}

export type { GoalEvidenceProofKind } from './goal-protocol.js';

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
  catalog: GoalEvidenceCatalogEntry[];
  eligibleByUuid: Map<string, GoalEvidenceCatalogEntry>;
  indexByUuid: Map<string, number>;
  lineageTurnIds: string[];
  catalogTruncated: boolean;
  catalogBytes: number;
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
      if (this.provenance === 'tool_result' && part.functionResponse) {
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
  const analysis = analyzeEvidence(input);
  return {
    entries: analysis.catalog.map((entry) => ({ ...entry })),
    lineageTurnIds: analysis.lineageTurnIds.slice(-CATALOG_LINEAGE_LIMIT),
    truncated: analysis.catalogTruncated,
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
  const references = input.proposal.evidenceRefs ?? [];
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

  const analysis = analyzeEvidence(input);
  // Truncation drops the oldest post-cursor evidence, so fail closed unless
  // the bounded catalog can still satisfy the proposal's required coverage.
  // A repeated blocker only needs the newest three turns, and only when each
  // of them still holds evidence the coverage check can actually cite.
  if (
    analysis.catalogTruncated &&
    !(
      isRepeatedBlockerProposal(input.proposal) &&
      repeatedBlockerCoverageCatalogued(analysis)
    )
  ) {
    throw new InvalidGoalEvidenceReferenceError(
      'catalog_truncated',
      GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
    );
  }
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

interface GoalTranscriptAnchor {
  cursorIndex: number;
  indexByUuid: Map<string, number>;
  lineageTurnIds: string[];
}

/**
 * Locates the Goal's cursor in the active transcript chain and checks the
 * chain is one this permit may read: the permit names the Goal revision, the
 * cursor is set and present, no record uuid repeats, and the permit's turn
 * is the newest Goal turn in the lineage.
 */
function anchorGoalTranscript(
  input: GoalEvidenceContext,
): GoalTranscriptAnchor {
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
  return { cursorIndex, indexByUuid, lineageTurnIds };
}

// ── verifier window ─────────────────────────────────────────────────────────

/**
 * What one transcript record may add to a verifier request. Content past
 * this is cut in the middle, so the head and the tail both survive -- a
 * tool result's opening and its final lines -- and the verifier is told
 * where the cut was.
 */
const VERIFIER_RECORD_CONTENT_BYTE_LIMIT = 8_000;
/**
 * A window too small for four records at the full limit shrinks the limit
 * instead of the window: on a side query model with a few thousand bytes
 * to spare, the newest records must still fit, or nothing is ever judged.
 */
const VERIFIER_RECORD_BUDGET_SHARE = 4;
const VERIFIER_RECORD_CONTENT_BYTE_FLOOR = 1_000;
/** Below this, a further cut of a record is not worth sending. */
const VERIFIER_RECORD_CONTENT_BYTE_RETRY_FLOOR = 200;
/** How many times a record is re-cut by its measured escape ratio. */
const VERIFIER_RECORD_REFIT_PASSES = 4;
/** The call arguments a tool result carries along, cut in the middle. */
const VERIFIER_CALL_ARGS_BYTE_LIMIT = 1_000;
/** The head keeps five eighths of a cut record; the tail the rest. */
const VERIFIER_RECORD_HEAD_SHARE = 5 / 8;
export const VERIFIER_MIDDLE_TRUNCATION_MARKER =
  '\n\u2026[middle truncated]\u2026\n';

export interface GoalVerifierEvidenceRecord {
  uuid: string;
  provenance: GoalEvidenceProvenance;
  turnId: string;
  proofKind: GoalEvidenceProofKind;
  content: string;
}

export interface GoalVerifierWindow {
  /** The transcript tail the verifier judges from, newest record first. */
  evidence: GoalVerifierEvidenceRecord[];
  /** The Goal turns the tail reaches, oldest first. */
  turnIds: string[];
  /**
   * Evidence of this Goal revision the window does not hold: records after
   * the cursor that did not fit, records before the cursor (a pause that
   * moved it, a resume) and, for a Goal restored from before the window
   * existed, the claims its last checkpoint folded earlier records into.
   * None of it is sent; the verifier must know it exists out of reach.
   */
  omitted: number;
  /**
   * The turn the first record that did not fit belongs to, when a record
   * was left out: that turn is in the window only in part, and a rule that
   * needs a whole turn (the repeated-blocker audit) must treat it as absent.
   */
  partialTurnId?: string;
}

export interface BuildGoalVerifierWindowOptions {
  /**
   * Bytes the serialized `evidence` and `turnIds` arrays may take together,
   * commas included: the verifier request limit less the rest of the request.
   */
  budgetBytes: number;
  /**
   * Turns whose evidence the verifier must see whatever the tail holds: for
   * each, the newest record that is not the model's own prose (a tool result
   * or the user's message) is admitted before the tail is filled. The
   * repeated-blocker audit names its three turns here, since three turns of
   * tool calls rarely fit a window together.
   */
  reachTurnIds?: readonly string[];
}

/**
 * The tail of the Goal's transcript, as the verifier sees it.
 *
 * Every record after the cursor that belongs to this Goal revision and
 * carries a coherent evidence provenance is a candidate. They are taken
 * newest first until the budget is spent; the first one that does not fit
 * ends the window, and it and every older candidate are counted as omitted,
 * so the window is always a contiguous suffix of the transcript. No slot is
 * reserved for any kind of record: the closing turn's records are the newest,
 * and a Goal whose proof lies further back than the budget reaches is told
 * so through `omitted` and judged accordingly.
 */
export function buildGoalVerifierWindow(
  input: GoalEvidenceContext,
  options: BuildGoalVerifierWindowOptions,
): GoalVerifierWindow {
  const { cursorIndex, lineageTurnIds } = anchorGoalTranscript(input);
  const budget = Number.isFinite(options.budgetBytes)
    ? Math.max(0, Math.floor(options.budgetBytes))
    : 0;
  const recordLimit = Math.min(
    VERIFIER_RECORD_CONTENT_BYTE_LIMIT,
    Math.max(
      VERIFIER_RECORD_CONTENT_BYTE_FLOOR,
      Math.floor(budget / VERIFIER_RECORD_BUDGET_SHARE),
    ),
  );
  const calls = indexToolCalls(input, cursorIndex);
  const evidence: GoalVerifierEvidenceRecord[] = [];
  const admittedIndexes = new Set<number>();
  const turnIds = new Set<string>();
  let bytes = 0;
  // A checkpoint an earlier version left summarises the records before the
  // cursor; count its claims, or those records, never both.
  const checkpointClaims = input.goal.evidenceCheckpoint?.claims.length ?? 0;
  let omitted = checkpointClaims;
  let full = false;
  let partialTurnId: string | undefined;
  const entrySize = (entry: GoalVerifierEvidenceRecord): number =>
    Buffer.byteLength(JSON.stringify(entry), 'utf8') +
    1 +
    (turnIds.has(entry.turnId)
      ? 0
      : Buffer.byteLength(JSON.stringify(entry.turnId), 'utf8') + 1);
  const admit = (index: number, entry: GoalVerifierEvidenceRecord) => {
    bytes += entrySize(entry);
    evidence.push(entry);
    admittedIndexes.add(index);
    turnIds.add(entry.turnId);
  };
  /**
   * The record rendered to fit what the budget still holds: cut once by
   * the limit and, for a record the window must hold (the newest one, or
   * one reserved for a turn the verifier must reach), again by the measured
   * escape ratio while it still overruns, since the head and the tail a cut
   * keeps may escape more densely than the middle it drops. Any other
   * record gets the one cut: the tail stays a contiguous suffix, and the
   * first record that does not fit ends it.
   */
  const fitted = (
    record: GoalEvidenceRecord,
    refit: boolean,
  ): GoalVerifierEvidenceRecord | 'unfit' | undefined => {
    let entry = verifierEvidence(record, input, recordLimit, calls);
    if (!entry) return undefined;
    if (!refit) return bytes + entrySize(entry) <= budget ? entry : 'unfit';
    let limit = recordLimit;
    for (let pass = 0; pass < VERIFIER_RECORD_REFIT_PASSES; pass += 1) {
      const entryBytes = entrySize(entry);
      if (bytes + entryBytes <= budget) return entry;
      const serializedContent = Buffer.byteLength(
        JSON.stringify(entry.content),
        'utf8',
      );
      const rawContent = Buffer.byteLength(entry.content, 'utf8');
      const room = budget - bytes - (entryBytes - serializedContent);
      if (room <= 0 || rawContent === 0) return 'unfit';
      limit =
        Math.min(
          limit - 1,
          Math.floor((room * rawContent) / serializedContent),
        ) - 16;
      if (limit < VERIFIER_RECORD_CONTENT_BYTE_RETRY_FLOOR) return 'unfit';
      const recut = verifierEvidence(record, input, limit, calls);
      if (!recut) return 'unfit';
      entry = recut;
    }
    return bytes + entrySize(entry) <= budget ? entry : 'unfit';
  };
  // The turns the verifier must reach come first: for each, the newest
  // record that is not the model's own prose.
  for (const turnId of options.reachTurnIds ?? []) {
    for (
      let index = input.records.length - 1;
      index > cursorIndex;
      index -= 1
    ) {
      const record = input.records[index]!;
      const admitted = admissibleVerifierRecord(record, input);
      if (
        !admitted ||
        admitted.turnId !== turnId ||
        admitted.provenance === 'assistant_output' ||
        !hasVerifierContent(record, admitted.provenance)
      ) {
        continue;
      }
      const entry = fitted(record, true);
      if (entry !== undefined && entry !== 'unfit') admit(index, entry);
      break;
    }
  }
  for (let index = input.records.length - 1; index >= 0; index -= 1) {
    if (admittedIndexes.has(index)) continue;
    const record = input.records[index]!;
    // Once the window is full, or before the cursor, a record is only
    // counted: eligibility is cheap, rendering a multi-megabyte tool result
    // for a count is not.
    if (full || index <= cursorIndex) {
      if (
        (index > cursorIndex || checkpointClaims === 0) &&
        isVerifierEvidence(record, input)
      ) {
        omitted += 1;
      }
      continue;
    }
    const entry = fitted(record, evidence.length === 0);
    if (entry === undefined) continue;
    if (entry === 'unfit') {
      full = true;
      partialTurnId = admissibleVerifierRecord(record, input)?.turnId;
      omitted += 1;
      continue;
    }
    admit(index, entry);
  }
  // Newest first, whatever order the reserved records were admitted in.
  const order = new Map(
    input.records.map((record, index) => [record.uuid, index] as const),
  );
  evidence.sort((a, b) => order.get(b.uuid)! - order.get(a.uuid)!);
  return {
    evidence,
    turnIds: lineageTurnIds.filter((turnId) => turnIds.has(turnId)),
    omitted,
    ...(partialTurnId === undefined ? {} : { partialTurnId }),
  };
}

/**
 * The tool calls made after the cursor, by call id, so a tool result can
 * carry the call that produced it. The assistant record holding the call is
 * older than the result and may be the record the window cuts at; the
 * result must not lose its command to that.
 */
function indexToolCalls(
  input: GoalEvidenceContext,
  cursorIndex: number,
): Map<string, string> {
  const calls = new Map<string, string>();
  for (let index = cursorIndex + 1; index < input.records.length; index += 1) {
    const record = input.records[index]!;
    if (record.type !== 'assistant') continue;
    for (const part of record.message?.parts ?? []) {
      const id = part.functionCall?.id;
      if (id === undefined) continue;
      const rendered = renderToolCallArgs(part.functionCall?.args);
      if (rendered !== undefined) calls.set(id, rendered);
    }
  }
  return calls;
}

function renderToolCallArgs(args: unknown): string | undefined {
  if (args === undefined) return undefined;
  try {
    return cutMiddleBytes(JSON.stringify(args), VERIFIER_CALL_ARGS_BYTE_LIMIT);
  } catch {
    return undefined;
  }
}

function verifierEvidence(
  record: GoalEvidenceRecord,
  input: GoalEvidenceContext,
  recordLimit: number,
  calls: ReadonlyMap<string, string>,
): GoalVerifierEvidenceRecord | undefined {
  const admitted = admissibleVerifierRecord(record, input);
  if (!admitted) return undefined;
  const content = verifierContent(record, admitted.provenance, calls);
  if (!content) return undefined;
  return {
    uuid: record.uuid,
    provenance: admitted.provenance,
    turnId: admitted.turnId,
    proofKind: proofKindOf(admitted.provenance),
    content: cutMiddleBytes(content, recordLimit),
  };
}

/** Whether the record would enter the window, decided without rendering it. */
function isVerifierEvidence(
  record: GoalEvidenceRecord,
  input: GoalEvidenceContext,
): boolean {
  const admitted = admissibleVerifierRecord(record, input);
  return (
    admitted !== undefined && hasVerifierContent(record, admitted.provenance)
  );
}

function admissibleVerifierRecord(
  record: GoalEvidenceRecord,
  input: GoalEvidenceContext,
): { provenance: GoalEvidenceProvenance; turnId: string } | undefined {
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
  return { provenance, turnId: context.turnId };
}

function hasVerifierContent(
  record: GoalEvidenceRecord,
  provenance: GoalEvidenceProvenance,
): boolean {
  if (provenance === 'real_user') {
    return evidenceContent(record, provenance).length > 0;
  }
  return (record.message?.parts ?? []).some(
    (part) =>
      (part.thought !== true &&
        typeof part.text === 'string' &&
        part.text.trim().length > 0) ||
      (provenance === 'assistant_output' && part.functionCall !== undefined) ||
      (provenance === 'tool_result' &&
        part.functionResponse?.response !== undefined),
  );
}

/**
 * A record's content as the verifier reads it. Unlike the catalog's
 * `evidenceContent`, an assistant record keeps the tool calls it made, with
 * their arguments: a tool result carries only the response, so without the
 * call the verifier cannot tell which file was read or which command ran.
 */
function verifierContent(
  record: GoalEvidenceRecord,
  provenance: GoalEvidenceProvenance,
  calls: ReadonlyMap<string, string>,
): string {
  if (provenance === 'real_user') return evidenceContent(record, provenance);
  const content: string[] = [];
  for (const part of record.message?.parts ?? []) {
    if (part.thought !== true && typeof part.text === 'string') {
      content.push(part.text);
    }
    if (provenance === 'assistant_output' && part.functionCall) {
      const rendered = renderToolCall(part.functionCall);
      if (rendered) content.push(rendered);
    }
    if (provenance === 'tool_result' && part.functionResponse) {
      const rendered = renderToolResponse(
        part.functionResponse,
        part.functionResponse.id === undefined
          ? undefined
          : calls.get(part.functionResponse.id),
      );
      if (rendered) content.push(rendered);
    }
  }
  return content.join('\n').trim();
}

function renderToolCall(functionCall: {
  id?: string;
  name?: string;
  args?: unknown;
}): string {
  try {
    // The id is what ties a result to its call when a turn made several
    // calls of the same tool.
    return JSON.stringify({
      call: functionCall.name ?? '',
      ...(functionCall.id === undefined ? {} : { id: functionCall.id }),
      ...(functionCall.args === undefined ? {} : { args: functionCall.args }),
    });
  } catch {
    return '';
  }
}

/**
 * Cut `content` to at most `limit` UTF-8 bytes by removing its middle,
 * never splitting a code point. The head keeps `VERIFIER_RECORD_HEAD_SHARE`
 * of what the marker leaves; the tail keeps the rest.
 */
export function cutMiddleBytes(content: string, limit: number): string {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length <= limit) return content;
  const markerBytes = Buffer.byteLength(
    VERIFIER_MIDDLE_TRUNCATION_MARKER,
    'utf8',
  );
  const room = Math.max(0, limit - markerBytes);
  const headBytes = Math.floor(room * VERIFIER_RECORD_HEAD_SHARE);
  const tailBytes = room - headBytes;
  return `${leadingBytes(bytes, headBytes)}${VERIFIER_MIDDLE_TRUNCATION_MARKER}${trailingBytes(bytes, tailBytes)}`;
}

function leadingBytes(bytes: Buffer, count: number): string {
  let end = Math.min(count, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString('utf8');
}

function trailingBytes(bytes: Buffer, count: number): string {
  let start = Math.max(0, bytes.length - count);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return bytes.subarray(start).toString('utf8');
}

// ── evidence catalog (retired: nothing reads it after the window landed) ────

function analyzeEvidence(input: GoalEvidenceContext): EvidenceAnalysis {
  const { cursorIndex, indexByUuid, lineageTurnIds } =
    anchorGoalTranscript(input);

  const checkpointEntries = checkpointCatalogEntries(input.goal);
  const selectedEvidence: GoalEvidenceCatalogEntry[] = [];
  let catalogBytes = checkpointEntries.reduce(
    (total, entry) => total + Buffer.byteLength(JSON.stringify(entry), 'utf8'),
    0,
  );
  let catalogTruncated =
    checkpointEntries.length >= CATALOG_ENTRY_LIMIT ||
    catalogBytes > CATALOG_BYTE_LIMIT;
  const rawEntryLimit = Math.max(
    0,
    CATALOG_ENTRY_LIMIT - checkpointEntries.length,
  );
  for (let index = input.records.length - 1; index > cursorIndex; index -= 1) {
    const record = input.records[index]!;
    if (selectedEvidence.length >= rawEntryLimit) {
      // The entry cap keeps the newest evidence; only call the catalog
      // truncated when eligible evidence is actually left behind.
      if (hasCatalogEligibleEvidence(record, input)) {
        catalogTruncated = true;
        break;
      }
      continue;
    }
    const evidence = catalogEvidence(record, input);
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
  const catalog = [...checkpointEntries, ...selectedEvidence];
  const eligibleByUuid = new Map(catalog.map((entry) => [entry.uuid, entry]));
  return {
    cursorIndex,
    catalog,
    eligibleByUuid,
    indexByUuid,
    lineageTurnIds,
    catalogTruncated,
    catalogBytes,
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
  const checkpointClaim = input.goal.evidenceCheckpoint?.claims.find(
    (claim) => claim.id === reference,
  );
  if (checkpointClaim) {
    const catalogEntry = analysis.eligibleByUuid.get(reference);
    if (!catalogEntry) {
      throw new InvalidGoalEvidenceReferenceError(
        'reference_not_catalogued',
        `Evidence reference ${reference} is outside the bounded Goal evidence catalog.`,
        reference,
      );
    }
    return { ...catalogEntry, content: checkpointClaim.claim };
  }

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

function repeatedBlockerCoverageCatalogued(
  analysis: EvidenceAnalysis,
): boolean {
  const requiredTurnIds = analysis.lineageTurnIds.slice(-3);
  const currentTurnId = requiredTurnIds.at(-1);
  return requiredTurnIds.every((turnId) =>
    analysis.catalog.some(
      (entry) =>
        entry.turnId === turnId &&
        (turnId === currentTurnId || entry.provenance !== 'assistant_output'),
    ),
  );
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
    const citedIds = new Set(citedRecords.map(({ uuid }) => uuid));
    const oldestBlockerIndex = Math.min(
      ...citedRecords
        .filter(
          ({ proofKind }) =>
            proofKind === 'user_input' || proofKind === 'external_fact',
        )
        .map(({ uuid }) =>
          analysis.catalog.findIndex((entry) => entry.uuid === uuid),
        ),
    );
    const uncitedNewerEvidence = analysis.catalog
      .slice(oldestBlockerIndex + 1)
      .filter(({ uuid }) => !citedIds.has(uuid));
    if (uncitedNewerEvidence.length > 0) {
      throw new InvalidGoalEvidenceReferenceError(
        'immediate_blocker_newer_evidence_required',
        'An immediate blocker must cite every newer bounded evidence record so contradictory evidence cannot be omitted.',
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

function hasCatalogEligibleEvidence(
  record: GoalEvidenceRecord,
  input: GoalEvidenceContext,
): boolean {
  const provenance = coherentEvidenceProvenance(record);
  if (!provenance) return false;
  const context = parseGoalContext(record.goalContext);
  if (
    !context ||
    context.goalId !== input.goal.goalId ||
    context.revision !== input.goal.revision
  ) {
    return false;
  }
  for (const part of record.message?.parts ?? []) {
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
    if (provenance === 'tool_result' && part.functionResponse) {
      append(renderToolResponsePreview(part.functionResponse));
    }
    if (preview.length >= CATALOG_PREVIEW_LIMIT) break;
  }
  return capPreviewBytes(preview.trim(), CATALOG_PREVIEW_BYTE_LIMIT);
}

function renderToolResponse(
  functionResponse: {
    id?: string;
    name?: string;
    response?: unknown;
  },
  callArgs?: string,
): string {
  if (functionResponse.response === undefined) return '';
  try {
    // The call's arguments ride along as text, so a result stays
    // attributable even when the assistant record that made the call was
    // cut from the window or cut in the middle.
    return JSON.stringify({
      ...(functionResponse.name === undefined
        ? {}
        : { name: functionResponse.name }),
      ...(functionResponse.id === undefined ? {} : { id: functionResponse.id }),
      ...(callArgs === undefined ? {} : { call: callArgs }),
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
