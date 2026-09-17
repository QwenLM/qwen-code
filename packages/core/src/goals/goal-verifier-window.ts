/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  capPreviewBytes,
  coherentEvidenceProvenance,
  collectLineageTurnIds,
  EvidenceSourceUnavailableError,
  evidenceContent,
  parseGoalContext,
  proofKindOf,
  type GoalEvidenceContext,
  type GoalEvidenceProvenance,
  type GoalEvidenceRecord,
  type GoalEvidenceValidationInput,
} from './goal-evidence.js';
import { isRepeatedBlockerProposal } from './goal-protocol.js';
import type { GoalVerifierEvidenceRecord } from './goal-verifier.js';

/**
 * The evidence a terminal proposal is judged from, built by the runtime
 * rather than cited by the model.
 *
 * A completion is judged from the Goal turn that proposed it, so the
 * decisive checks have to run in that turn. A blocked proposal is judged
 * from the current turn and the two lineage turns before it, the span the
 * repeated-blocker policy names. The one thing carried over from anywhere
 * else in the session is the user's own messages: a claim about what the
 * user asked, chose or approved can only be proven by one of those, the
 * answer usually arrived turns before the work that depends on it finished,
 * and it may have been given while the Goal was paused or blocked or before
 * it was edited, so those messages are taken with or without Goal turn
 * context. Nothing else older is sent: the deliverable is in the workspace
 * and the check that proves it can be run again, which is cheaper and more
 * reliable than keeping a citable ledger of everything a long Goal did.
 */

/**
 * The most serialized bytes the window ever holds, measured on each record
 * exactly as the verifier request carries it (uuid, provenance, turnId,
 * proofKind and content, with their JSON keys and the comma between
 * records). The caller passes the budget the request actually has left
 * after its envelope; this is the ceiling on that budget.
 */
export const VERIFIER_EVIDENCE_WINDOW_BYTE_LIMIT = 224_000;

/**
 * Below this budget the window cannot carry a couple of full records next
 * to the envelope (a 16 000-byte record can double under JSON escaping), so
 * the proposal cannot be judged at all: the objective or the proposal
 * reason is the problem, not the evidence.
 */
export const VERIFIER_EVIDENCE_WINDOW_MIN_BYTES = 64_000;

/**
 * The `turnId` a user message carries when it was sent while no Goal turn
 * was running -- an answer given while the Goal was paused or blocked, or
 * before it was edited -- and so has no Goal turn context.
 */
export const USER_MESSAGE_OUTSIDE_GOAL_TURN = 'outside_goal_turn';

/**
 * How much of one record the window keeps, and how that budget is split.
 * Records are front- and back-loaded: a tool result opens with the command
 * and ends with its summary line ("Tests 412 passed"), a user message opens
 * with the instruction and ends with the decision, so the cut is taken out
 * of the middle, marked, and the tail gets the larger share.
 */
const RECORD_CONTENT_BYTE_LIMIT = 16_000;
const RECORD_HEAD_BYTES = 6_000;
const MIDDLE_TRUNCATION_MARKER = '\n…[middle truncated]\n';

/**
 * The user's messages the window admits before filling by recency: the
 * newest few unconditionally, then up to this share of the budget. A busy
 * closing turn -- a hundred tool calls -- fills a newest-first window by
 * itself, and without a guarantee the user's earlier approval would never
 * get in.
 */
const USER_MESSAGE_GUARANTEED_COUNT = 4;
const USER_MESSAGE_BUDGET_FRACTION = 8;

/** A record with one byte of content still costs its keys and ids. */
const MIN_ENTRY_BYTES = 96;

export interface GoalVerifierEvidenceWindow {
  /** Newest record first, by transcript position. */
  evidence: GoalVerifierEvidenceRecord[];
  /** The Goal turns the window covers, oldest first; the current turn is last. */
  turnIds: string[];
  /**
   * Eligible records left out because they did not fit the byte budget.
   * Newer records are tried first, and a record that does not fit is skipped
   * so a smaller, older one still can.
   */
  omitted: number;
}

export interface BuildGoalVerifierEvidenceWindowOptions {
  /**
   * Serialized bytes the verifier request has left for evidence once its
   * envelope is counted. Capped at {@link VERIFIER_EVIDENCE_WINDOW_BYTE_LIMIT},
   * which is also the default.
   */
  budgetBytes?: number;
}

/**
 * Builds the evidence window a terminal proposal is verified against.
 *
 * Throws {@link EvidenceSourceUnavailableError} when the transcript cannot be
 * attributed to this permit: a permit that does not match the Goal revision,
 * a missing or duplicated evidence cursor, a Goal-owned record after the
 * cursor with malformed turn context, a turn that re-enters the lineage, or
 * a current turn that is in the lineage but not at its tail. Records before
 * the cursor are read only for the user's messages and are not examined for
 * lineage, so an anomaly a resume or edit already moved past stays behind
 * it. A current turn that has recorded nothing yet is not an error: its
 * window is empty, and the verifier answers that with a rejection the model
 * can act on.
 */
export function buildGoalVerifierEvidenceWindow(
  input: GoalEvidenceValidationInput,
  options: BuildGoalVerifierEvidenceWindowOptions = {},
): GoalVerifierEvidenceWindow {
  const { cursorIndex, lineageTurnIds } = attributeTranscript(input);
  const currentTurnId = input.permit.turnId;
  const currentIndex = lineageTurnIds.indexOf(currentTurnId);
  const priorTurnIds =
    currentIndex === -1 ? lineageTurnIds : lineageTurnIds.slice(0, -1);
  const priorWindowTurnIds =
    input.proposal.status === 'blocked' ? priorTurnIds.slice(-2) : [];
  const turnIds = [...priorWindowTurnIds, currentTurnId];

  // Candidates newest first, rendered only when a pass reaches them: most of
  // a long turn never fits, and rendering a tool response that will be
  // counted rather than sent is wasted work.
  interface Candidate {
    index: number;
    record: GoalEvidenceRecord;
    provenance: GoalEvidenceProvenance;
    turnId: string;
    rendered?: { entry: GoalVerifierEvidenceRecord; bytes: number } | null;
  }
  const current: Candidate[] = [];
  const user: Candidate[] = [];
  const prior = new Map<string, Candidate[]>(
    priorWindowTurnIds.map((turnId) => [turnId, [] as Candidate[]]),
  );
  for (let index = input.records.length - 1; index >= 0; index -= 1) {
    const record = input.records[index]!;
    const provenance = coherentEvidenceProvenance(record);
    if (!provenance) continue;
    const context = parseGoalContext(record.goalContext);
    if (provenance === 'real_user') {
      user.push({
        index,
        record,
        provenance,
        turnId: context?.turnId ?? USER_MESSAGE_OUTSIDE_GOAL_TURN,
      });
      continue;
    }
    if (
      index <= cursorIndex ||
      !context ||
      context.goalId !== input.goal.goalId ||
      context.revision !== input.goal.revision
    ) {
      continue;
    }
    const group =
      context.turnId === currentTurnId ? current : prior.get(context.turnId);
    group?.push({ index, record, provenance, turnId: context.turnId });
  }
  const render = (candidate: Candidate) => {
    if (candidate.rendered !== undefined) return candidate.rendered;
    const content = capRecordContent(
      evidenceContent(candidate.record, candidate.provenance),
    );
    if (!content) {
      candidate.rendered = null;
      return null;
    }
    const entry: GoalVerifierEvidenceRecord = {
      uuid: candidate.record.uuid,
      provenance: candidate.provenance,
      turnId: candidate.turnId,
      proofKind: proofKindOf(candidate.provenance),
      content,
    };
    candidate.rendered = {
      entry,
      // The comma that separates records in the request array counts too.
      bytes: Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1,
    };
    return candidate.rendered;
  };

  const budget = Math.max(
    0,
    Math.min(
      VERIFIER_EVIDENCE_WINDOW_BYTE_LIMIT,
      options.budgetBytes ?? VERIFIER_EVIDENCE_WINDOW_BYTE_LIMIT,
    ),
  );
  const admitted = new Set<number>();
  let used = 0;
  // Admits records of `group`, newest first, at most `count` of them and at
  // most `share` bytes on this pass. A record that does not fit is skipped,
  // not the end of the pass, so a short, older message can still make it in
  // behind a long one; the pass stops once nothing could fit at all.
  const admit = (
    group: readonly Candidate[],
    count = Number.POSITIVE_INFINITY,
    share = Number.POSITIVE_INFINITY,
    accept: (candidate: Candidate) => boolean = () => true,
  ): void => {
    let taken = 0;
    let spent = 0;
    for (const candidate of group) {
      if (taken >= count || budget - used < MIN_ENTRY_BYTES) break;
      if (admitted.has(candidate.index) || !accept(candidate)) continue;
      const rendered = render(candidate);
      if (!rendered) continue;
      if (spent + rendered.bytes > share || used + rendered.bytes > budget) {
        continue;
      }
      admitted.add(candidate.index);
      taken += 1;
      spent += rendered.bytes;
      used += rendered.bytes;
    }
  };
  // The proposing turn's newest record first: a completion is proven by what
  // its own turn produced. Then one record the model did not merely write
  // from each preceding turn a blocked policy reads, then the user's newest
  // messages, then the user's share, then everything else by recency.
  admit(current, 1);
  for (const group of prior.values()) {
    admit(
      group,
      1,
      Number.POSITIVE_INFINITY,
      (candidate) => candidate.provenance !== 'assistant_output',
    );
  }
  admit(user, USER_MESSAGE_GUARANTEED_COUNT);
  admit(
    user,
    Number.POSITIVE_INFINITY,
    Math.floor(budget / USER_MESSAGE_BUDGET_FRACTION),
  );
  const rest = [...current, ...user, ...prior.values()]
    .flat()
    .sort((left, right) => right.index - left.index);
  admit(rest);

  const evidence = rest
    .filter((candidate) => admitted.has(candidate.index))
    .map((candidate) => candidate.rendered!.entry);
  return {
    evidence,
    turnIds,
    omitted: rest.filter(
      (candidate) =>
        !admitted.has(candidate.index) && candidate.rendered !== null,
    ).length,
  };
}

export class GoalVerifierCoverageError extends Error {
  constructor(
    readonly code:
      | 'infeasible_blocker_external_fact_required'
      | 'immediate_blocker_external_evidence_required'
      | 'repeated_blocker_turn_coverage',
    message: string,
  ) {
    super(message);
    this.name = 'GoalVerifierCoverageError';
  }
}

/**
 * The deterministic half of the blocked-proposal policy, decided on the
 * lineage records rather than on the packed window so that a tight budget
 * cannot turn a well-evidenced blocker into a refusal: an infeasible
 * blocker needs a tool result in the current turn, an immediate one needs a
 * user message anywhere or a tool result in the current turn, and a
 * repeated one needs at least three lineage turns with a tool result or a
 * user message in each of the last three. A verifier prompt can restate
 * these rules; only code can refuse a proposal that breaks them every time.
 */
export function validateGoalVerifierCoverage(
  input: GoalEvidenceValidationInput,
): void {
  const { proposal } = input;
  if (proposal.status !== 'blocked') return;
  const { cursorIndex, lineageTurnIds } = attributeTranscript(input);
  const currentTurnId = input.permit.turnId;
  const kindsByTurn = new Map<string, Set<'tool' | 'user'>>();
  let userAnywhere = false;
  for (let index = 0; index < input.records.length; index += 1) {
    const record = input.records[index]!;
    const provenance = coherentEvidenceProvenance(record);
    if (!provenance || provenance === 'assistant_output') continue;
    if (provenance === 'real_user') userAnywhere = true;
    if (index <= cursorIndex) continue;
    const context = parseGoalContext(record.goalContext);
    if (
      !context ||
      context.goalId !== input.goal.goalId ||
      context.revision !== input.goal.revision
    ) {
      continue;
    }
    const kinds = kindsByTurn.get(context.turnId) ?? new Set();
    kinds.add(provenance === 'real_user' ? 'user' : 'tool');
    kindsByTurn.set(context.turnId, kinds);
  }
  const has = (turnId: string, kind: 'tool' | 'user') =>
    kindsByTurn.get(turnId)?.has(kind) ?? false;

  if (proposal.blockerKind === 'infeasible' && !has(currentTurnId, 'tool')) {
    throw new GoalVerifierCoverageError(
      'infeasible_blocker_external_fact_required',
      'An infeasible blocker requires a tool result in this turn showing the fact that makes the objective unsatisfiable.',
    );
  }
  if (!isRepeatedBlockerProposal(proposal)) {
    if (!userAnywhere && !has(currentTurnId, 'tool')) {
      throw new GoalVerifierCoverageError(
        'immediate_blocker_external_evidence_required',
        'An immediate blocker requires a message from the user or a tool result in this turn as evidence.',
      );
    }
    return;
  }
  const required = lineageTurnIds.slice(-3);
  if (
    lineageTurnIds.at(-1) !== currentTurnId ||
    required.length !== 3 ||
    !required.every((turnId) => has(turnId, 'tool') || has(turnId, 'user'))
  ) {
    throw new GoalVerifierCoverageError(
      'repeated_blocker_turn_coverage',
      'A repeated blocker requires a tool result or a message from the user in each of the current and two immediately preceding Goal turns.',
    );
  }
}

/**
 * Anchors the transcript to this permit: the cursor's position in a chain
 * with no repeated uuid, and the Goal turns recorded after it. The current
 * turn may be absent (nothing recorded yet) but, if present, must be last.
 */
function attributeTranscript(input: GoalEvidenceContext): {
  cursorIndex: number;
  lineageTurnIds: string[];
} {
  if (
    input.permit.goalId !== input.goal.goalId ||
    input.permit.revision !== input.goal.revision ||
    !input.permit.turnId.trim()
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
  const seen = new Set<string>();
  let cursorIndex = -1;
  for (let index = 0; index < input.records.length; index += 1) {
    const uuid = input.records[index]!.uuid;
    if (seen.has(uuid)) {
      throw new EvidenceSourceUnavailableError(
        'duplicate_record_uuid',
        `The active transcript chain contains duplicate record UUID ${uuid}.`,
      );
    }
    seen.add(uuid);
    if (uuid === cursorId) cursorIndex = index;
  }
  if (cursorIndex === -1) {
    throw new EvidenceSourceUnavailableError(
      'cursor_not_found',
      `The Goal evidence cursor ${cursorId} is not in the active transcript chain.`,
    );
  }
  const lineageTurnIds = collectLineageTurnIds(input, cursorIndex);
  const currentIndex = lineageTurnIds.indexOf(input.permit.turnId);
  if (currentIndex !== -1 && currentIndex !== lineageTurnIds.length - 1) {
    throw new EvidenceSourceUnavailableError(
      'current_turn_not_tail',
      'The current Goal permit is not the tail of the active transcript lineage.',
    );
  }
  return { cursorIndex, lineageTurnIds };
}

/**
 * Keeps the first {@link RECORD_HEAD_BYTES} and the last of the remaining
 * budget of a record, with a marker where the middle was.
 */
function capRecordContent(content: string): string {
  if (Buffer.byteLength(content, 'utf8') <= RECORD_CONTENT_BYTE_LIMIT) {
    return content;
  }
  const tailBudget =
    RECORD_CONTENT_BYTE_LIMIT -
    RECORD_HEAD_BYTES -
    Buffer.byteLength(MIDDLE_TRUNCATION_MARKER, 'utf8');
  return `${capPreviewBytes(content, RECORD_HEAD_BYTES)}${MIDDLE_TRUNCATION_MARKER}${takeTrailingBytes(content, tailBudget)}`;
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
