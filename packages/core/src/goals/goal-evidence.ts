/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import type {
  GoalEvidenceProofKind,
  GoalRecord,
  GoalTurnPermit,
} from './goal-protocol.js';
import { projectUserTranscriptForDisplay } from '../utils/transcript-records.js';

/**
 * How much of one record the verifier window keeps. A tool result opens with
 * the command and ends with its summary line ("Tests 412 passed"), and a user
 * message ends with the decision, so the cut is taken out of the middle,
 * marked, and the tail gets the larger share.
 */
const VERIFIER_EVIDENCE_CONTENT_BYTE_LIMIT = 8_000;
const VERIFIER_EVIDENCE_HEAD_BYTES = 3_000;
const VERIFIER_EVIDENCE_MIDDLE_TRUNCATION_MARKER =
  '\n\u2026[middle truncated]\n';
/**
 * The least room the verifier request must have left for evidence: one
 * record at the content limit with every byte doubled by JSON escaping,
 * plus its keys and ids. Under this the window holds a stub or nothing, the
 * verifier can only reject, and the model can only propose again; what has
 * to shrink is the objective, so the runtime says that instead.
 */
export const VERIFIER_EVIDENCE_WINDOW_MIN_BYTES =
  VERIFIER_EVIDENCE_CONTENT_BYTE_LIMIT * 2 + 512;
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

/** One transcript record as the terminal verifier receives it. */
export interface GoalVerifierEvidenceRecord {
  uuid: string;
  provenance: GoalEvidenceProvenance;
  turnId: string;
  proofKind: GoalEvidenceProofKind;
  content: string;
}

/**
 * The evidence a terminal proposal is judged from: the tail of the Goal's
 * transcript. Every record after the evidence cursor that belongs to this
 * Goal revision and carries a coherent provenance is a candidate, and
 * candidates are taken newest first until the next one no longer fits the
 * bytes the verifier request has left. There is no quota per turn or per
 * provenance and nothing is reserved: a small closing turn lets the window
 * reach into earlier turns on its own, and a long one fills it with what
 * was done last, which is where a completion's checks are run.
 */
export interface GoalVerifierEvidenceWindow {
  /** Newest record first. */
  evidence: GoalVerifierEvidenceRecord[];
  /** The Goal turns the records present belong to, oldest first. */
  turnIds: string[];
  /**
   * Older candidates the byte budget left out. They are counted without
   * being rendered, so one with nothing visible in it is counted too.
   */
  omitted: number;
}

export interface BuildGoalVerifierEvidenceWindowOptions {
  /**
   * Serialized bytes the verifier request has left for evidence once its
   * envelope (objective, proposal, policy) is counted.
   */
  budgetBytes: number;
}

export interface GoalEvidenceContext {
  records: readonly GoalEvidenceRecord[];
  goal: GoalRecord;
  permit: GoalTurnPermit;
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

interface ParsedGoalContext {
  goalId: string;
  revision: number;
  turnId: string;
}

/**
 * Builds the evidence window a terminal proposal is verified against.
 *
 * Throws {@link EvidenceSourceUnavailableError} when the window cannot be
 * anchored: a permit that does not match the Goal revision, or an evidence
 * cursor that is unset, missing from the chain, or in a chain that repeats a
 * record uuid. A Goal that has recorded nothing yet is not an error: its
 * window is empty, and the verifier answers that with a rejection the model
 * can act on.
 */
export function buildGoalVerifierEvidenceWindow(
  input: GoalEvidenceContext,
  options: BuildGoalVerifierEvidenceWindowOptions,
): GoalVerifierEvidenceWindow {
  assertPermitMatchesGoal(input);
  const { cursorIndex } = locateEvidenceCursor(input);
  const evidence: GoalVerifierEvidenceRecord[] = [];
  const seenTurnIds = new Set<string>();
  let remaining = options.budgetBytes;
  let full = false;
  let omitted = 0;
  for (let index = input.records.length - 1; index > cursorIndex; index -= 1) {
    const record = input.records[index]!;
    const provenance = coherentEvidenceProvenance(record);
    if (!provenance) continue;
    const context = parseGoalContext(record.goalContext);
    if (
      !context ||
      context.goalId !== input.goal.goalId ||
      context.revision !== input.goal.revision
    ) {
      continue;
    }
    if (full) {
      // Counted, not rendered: a long session holds thousands of tool
      // results behind the window, and none of them is going to be sent.
      omitted += 1;
      continue;
    }
    const content = evidenceContent(record, provenance);
    if (!content) continue;
    const entry: GoalVerifierEvidenceRecord = {
      uuid: record.uuid,
      provenance,
      turnId: context.turnId,
      proofKind: proofKindOf(provenance),
      content: capVerifierEvidenceContent(content),
    };
    // The comma that separates records in the request array counts too, and
    // so does the entry a turn not seen yet adds to the request's turn list.
    const bytes =
      Buffer.byteLength(JSON.stringify(entry), 'utf8') +
      1 +
      (seenTurnIds.has(context.turnId)
        ? 0
        : Buffer.byteLength(JSON.stringify(context.turnId), 'utf8') + 1);
    if (bytes > remaining) {
      // The window is a contiguous tail: once a record does not fit,
      // everything older is left out with it, so `omitted` always means
      // "older than every record present".
      full = true;
      omitted += 1;
      continue;
    }
    remaining -= bytes;
    seenTurnIds.add(context.turnId);
    evidence.push(entry);
  }
  // Sets iterate in insertion order, which here is newest turn first.
  return { evidence, turnIds: [...seenTurnIds].reverse(), omitted };
}

function assertPermitMatchesGoal(input: GoalEvidenceContext): void {
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
}

/**
 * The Goal's evidence cursor in the active transcript chain, with the index
 * of every record: a chain that repeats a record uuid cannot be anchored.
 */
function locateEvidenceCursor(input: GoalEvidenceContext): {
  cursorIndex: number;
  indexByUuid: Map<string, number>;
} {
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
  return { cursorIndex, indexByUuid };
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

/**
 * Keeps the first {@link VERIFIER_EVIDENCE_HEAD_BYTES} and the last of the
 * remaining budget of a record, with a marker where the middle was.
 */
function capVerifierEvidenceContent(content: string): string {
  if (
    Buffer.byteLength(content, 'utf8') <= VERIFIER_EVIDENCE_CONTENT_BYTE_LIMIT
  ) {
    return content;
  }
  const tailBudget =
    VERIFIER_EVIDENCE_CONTENT_BYTE_LIMIT -
    VERIFIER_EVIDENCE_HEAD_BYTES -
    Buffer.byteLength(VERIFIER_EVIDENCE_MIDDLE_TRUNCATION_MARKER, 'utf8');
  return `${capPreviewBytes(content, VERIFIER_EVIDENCE_HEAD_BYTES)}${VERIFIER_EVIDENCE_MIDDLE_TRUNCATION_MARKER}${takeTrailingBytes(content, tailBudget)}`;
}

/**
 * The longest suffix of `value` within `budget` UTF-8 bytes, on a code point
 * boundary. Walks back from the end one UTF-16 unit at a time, so the cost
 * is the budget, not the size of a pasted log.
 */
function takeTrailingBytes(value: string, budget: number): string {
  let byteLength = 0;
  let start = value.length;
  while (start > 0) {
    let next = start - 1;
    const unit = value.charCodeAt(next);
    if (unit >= 0xdc00 && unit <= 0xdfff && next > 0) {
      const lead = value.charCodeAt(next - 1);
      if (lead >= 0xd800 && lead <= 0xdbff) next -= 1;
    }
    const codePointBytes = Buffer.byteLength(value.slice(next, start), 'utf8');
    if (byteLength + codePointBytes > budget) break;
    byteLength += codePointBytes;
    start = next;
  }
  return value.slice(start);
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
