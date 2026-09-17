/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { capPreviewBytes } from './goal-evidence.js';
import {
  anchorGoalTranscript,
  coherentEvidenceProvenance,
  EvidenceSourceUnavailableError,
  evidenceContent,
  parseGoalContext,
  proofKindOf,
  recordHasEvidenceContent,
  type GoalEvidenceProvenance,
  type GoalEvidenceRecord,
  type GoalEvidenceValidationInput,
} from './goal-evidence-shared.js';
import { isRepeatedBlockerProposal } from './goal-protocol.js';
import type { GoalVerifierEvidenceRecord } from './goal-verifier.js';

/**
 * The evidence a terminal proposal is judged from, built by the runtime
 * rather than cited by the model.
 *
 * A completion is judged from the Goal turn that proposed it, so the
 * decisive checks have to run in that turn. A blocked proposal is judged
 * from the current turn and the two lineage turns before it, the span the
 * repeated-blocker policy names. The one thing carried over from outside
 * those turns is the user's own messages: a claim about what the user
 * asked, chose or approved can only be proven by one of those, and the
 * answer usually arrived turns before the work that depends on it finished,
 * sometimes while the Goal was paused or blocked and so without Goal turn
 * context. Only messages this objective can have prompted are taken: those
 * recorded after the evidence cursor, and those stamped for this Goal
 * revision wherever they sit. Nothing else older is sent: the deliverable is
 * in the workspace and the check that proves it can be run again, which is
 * cheaper and more reliable than a citable ledger of everything a long Goal
 * did.
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
 * reason is the problem, not the evidence. The builder refuses such a
 * budget rather than returning a window that could not prove anything.
 */
export const VERIFIER_EVIDENCE_WINDOW_MIN_BYTES = 64_000;

/**
 * The `turnId` a user message carries when it was sent while no Goal turn
 * was running -- an answer given while the Goal was paused or blocked -- and
 * so has no Goal turn context.
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

/**
 * How many rendered records in a row may fail to fit before the final,
 * recency-ordered pass gives up. The records it would go on to render are
 * older and, past a full window, mostly the same size; rendering a
 * multi-megabyte tool response only to count it is the cost this bounds.
 */
const CONSECUTIVE_MISS_LIMIT = 8;

export interface GoalVerifierEvidenceWindow {
  /** Newest record first, by transcript position. */
  evidence: GoalVerifierEvidenceRecord[];
  /**
   * The Goal turns whose records the window draws from, oldest first; the
   * current turn is last. The user's messages are the exception and may
   * carry another turn id of this Goal revision, or
   * {@link USER_MESSAGE_OUTSIDE_GOAL_TURN}.
   */
  turnIds: string[];
  /**
   * Records with evidence content that did not fit the byte budget. Newer
   * records are tried first, and a record that does not fit is skipped so a
   * smaller, older one still can. Records that would render to nothing are
   * neither evidence nor omissions.
   */
  omitted: number;
}

export interface BuildGoalVerifierEvidenceWindowOptions {
  /**
   * Serialized bytes the verifier request has left for evidence once its
   * envelope is counted. Must be a finite number of at least
   * {@link VERIFIER_EVIDENCE_WINDOW_MIN_BYTES}; capped at
   * {@link VERIFIER_EVIDENCE_WINDOW_BYTE_LIMIT}, which is also the default.
   */
  budgetBytes?: number;
}

export class GoalVerifierWindowBudgetError extends Error {
  constructor(
    readonly code: 'budget_invalid' | 'budget_too_small',
    message: string,
  ) {
    super(message);
    this.name = 'GoalVerifierWindowBudgetError';
  }
}

/**
 * Builds the evidence window a terminal proposal is verified against.
 *
 * Throws {@link GoalVerifierWindowBudgetError} for a budget that is not a
 * finite number or is too small to judge anything, and
 * {@link EvidenceSourceUnavailableError} when the transcript cannot be
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
  const budget = resolveBudget(options.budgetBytes);
  const { cursorIndex, lineageTurnIds } = attributeTranscript(input);
  const currentTurnId = input.permit.turnId;
  const priorTurnIds =
    lineageTurnIds.at(-1) === currentTurnId
      ? lineageTurnIds.slice(0, -1)
      : lineageTurnIds;
  const priorWindowTurnIds =
    input.proposal.status === 'blocked' ? priorTurnIds.slice(-2) : [];
  const turnIds = [...priorWindowTurnIds, currentTurnId];

  // Candidates newest first, rendered only when a pass reaches them: most of
  // a long turn never fits, and rendering a tool response that will be
  // counted rather than sent is wasted work. A record that would render to
  // nothing is not a candidate at all.
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
  // The cheap attribution filters run before the provenance and content
  // checks: most records of a long transcript are ruled out by position or
  // stamp alone, and the content check projects a user prompt.
  for (let index = input.records.length - 1; index >= 0; index -= 1) {
    const record = input.records[index]!;
    if (record.type === 'system') continue;
    const context = parseGoalContext(record.goalContext);
    const ownContext =
      context !== undefined &&
      context.goalId === input.goal.goalId &&
      context.revision === input.goal.revision;
    if (record.goalContext !== undefined && !ownContext) continue;
    if (index <= cursorIndex && !ownContext && record.type !== 'user') {
      continue;
    }
    const provenance = coherentEvidenceProvenance(record);
    if (!provenance) continue;
    if (provenance === 'real_user') {
      // Only a message this objective can have prompted: recorded after the
      // cursor, or stamped for this revision wherever it sits. A message
      // stamped for another Goal or an earlier revision may be the user's
      // consent to something else, and one whose stamp cannot be read is
      // not trusted as unstamped.
      if (index <= cursorIndex && !ownContext) continue;
      if (!recordHasEvidenceContent(record, provenance)) continue;
      const candidate = {
        index,
        record,
        provenance,
        turnId: context?.turnId ?? USER_MESSAGE_OUTSIDE_GOAL_TURN,
      };
      user.push(candidate);
      // A user message inside a preceding window turn is also that turn's
      // evidence, exactly as the coverage rule counts it.
      if (context) prior.get(context.turnId)?.push(candidate);
      continue;
    }
    if (index <= cursorIndex || !ownContext) continue;
    const group =
      context.turnId === currentTurnId ? current : prior.get(context.turnId);
    if (!group || !recordHasEvidenceContent(record, provenance)) continue;
    group.push({ index, record, provenance, turnId: context.turnId });
  }
  const render = (candidate: Candidate) => {
    if (candidate.rendered !== undefined) return candidate.rendered;
    const content = capRecordContent(
      evidenceContent(candidate.record, candidate.provenance),
    );
    if (!content) {
      // The shape check said content and the renderer found none (a tool
      // response that cannot be serialized): not evidence, not an omission.
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

  const admitted = new Set<number>();
  let used = 0;
  // Admits records of `group`, newest first, at most `count` of them and at
  // most `share` bytes on this pass. A record that does not fit is skipped,
  // not the end of the pass, so a short, older message can still make it in
  // behind a long one. The pass stops once nothing could fit at all, or once
  // `missLimit` rendered records in a row have failed to fit; an admission
  // starts that count over.
  const admit = (
    group: readonly Candidate[],
    {
      count = Number.POSITIVE_INFINITY,
      share = Number.POSITIVE_INFINITY,
      missLimit = Number.POSITIVE_INFINITY,
      accept = () => true,
    }: {
      count?: number;
      share?: number;
      missLimit?: number;
      accept?: (candidate: Candidate) => boolean;
    } = {},
  ): void => {
    let taken = 0;
    let spent = 0;
    let misses = 0;
    for (const candidate of group) {
      if (
        taken >= count ||
        misses >= missLimit ||
        budget - used < MIN_ENTRY_BYTES
      ) {
        break;
      }
      if (admitted.has(candidate.index) || !accept(candidate)) continue;
      // The text parts alone bound a model or tool record from below; one
      // that cannot fit on that bound is skipped without serializing its
      // tool response. A user record is always rendered: its parts may be an
      // expanded file reference that displays as one line.
      if (used + leastBytes(candidate) > budget) continue;
      const rendered = render(candidate);
      if (!rendered) continue;
      if (spent + rendered.bytes > share || used + rendered.bytes > budget) {
        misses += 1;
        continue;
      }
      admitted.add(candidate.index);
      misses = 0;
      taken += 1;
      spent += rendered.bytes;
      used += rendered.bytes;
    }
  };
  // The proposing turn's newest tool result first: a completion is proven by
  // what its own turn produced, and the decisive check is usually followed
  // by the model's closing prose. Then one record the model did not merely
  // write from each preceding turn a blocked policy reads, then the user's
  // newest messages, then the user's share, then everything else by
  // recency, which puts that closing prose next.
  const notProse = (candidate: Candidate) =>
    candidate.provenance !== 'assistant_output';
  admit(current, { count: 1, accept: notProse });
  if (admitted.size === 0) admit(current, { count: 1 });
  for (const group of prior.values()) {
    admit(group, { count: 1, accept: notProse });
  }
  admit(user, { count: USER_MESSAGE_GUARANTEED_COUNT });
  admit(user, { share: Math.floor(budget / USER_MESSAGE_BUDGET_FRACTION) });
  const seen = new Set<number>();
  const rest = [...current, ...user, ...prior.values()]
    .flat()
    .filter((candidate) => {
      if (seen.has(candidate.index)) return false;
      seen.add(candidate.index);
      return true;
    })
    .sort((left, right) => right.index - left.index);
  admit(rest, { missLimit: CONSECUTIVE_MISS_LIMIT });

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
 * transcript rather than on the packed window so that a tight budget cannot
 * turn a well-evidenced blocker into a refusal. Only records with evidence
 * content count, and a user message counts only when this objective can
 * have prompted it (after the cursor, or stamped for this revision): the
 * message that created the Goal must not satisfy its own blocker.
 *
 * An infeasible blocker needs a tool result in the current turn; an
 * authority or external blocker needs such a user message or a tool result
 * in the current turn; a repeated blocker needs at least three lineage
 * turns, evidence of any kind in the current one and a tool result or a
 * user message in each of the two before it, as the rule this replaces
 * required. A
 * verifier prompt can restate these rules; only code can refuse a proposal
 * that breaks them every time. The newest records are what the window sends
 * first, so contradictory newer evidence cannot be left out the way a cited
 * list could.
 */
export function validateGoalVerifierCoverage(
  input: GoalEvidenceValidationInput,
): void {
  const { proposal } = input;
  if (proposal.status !== 'blocked') return;
  const { cursorIndex, lineageTurnIds } = attributeTranscript(input);
  const currentTurnId = input.permit.turnId;
  const kindsByTurn = new Map<string, Set<GoalEvidenceProvenance>>();
  let userMessage = false;
  for (let index = 0; index < input.records.length; index += 1) {
    const record = input.records[index]!;
    if (record.type === 'system') continue;
    const context = parseGoalContext(record.goalContext);
    const ownContext =
      context !== undefined &&
      context.goalId === input.goal.goalId &&
      context.revision === input.goal.revision;
    if (record.goalContext !== undefined && !ownContext) continue;
    if (index <= cursorIndex && !ownContext) continue;
    const provenance = coherentEvidenceProvenance(record);
    if (!provenance || !recordHasEvidenceContent(record, provenance)) {
      continue;
    }
    if (provenance === 'real_user') {
      userMessage = true;
      if (!context) continue;
    } else if (!ownContext) {
      continue;
    }
    const kinds = kindsByTurn.get(context!.turnId) ?? new Set();
    kinds.add(provenance);
    kindsByTurn.set(context!.turnId, kinds);
  }
  const has = (turnId: string, ...kinds: GoalEvidenceProvenance[]) =>
    kinds.some((kind) => kindsByTurn.get(turnId)?.has(kind) ?? false);

  if (
    proposal.blockerKind === 'infeasible' &&
    !has(currentTurnId, 'tool_result')
  ) {
    throw new GoalVerifierCoverageError(
      'infeasible_blocker_external_fact_required',
      'An infeasible blocker requires a tool result in this turn showing the fact that makes the objective unsatisfiable.',
    );
  }
  if (!isRepeatedBlockerProposal(proposal)) {
    if (!userMessage && !has(currentTurnId, 'tool_result')) {
      throw new GoalVerifierCoverageError(
        'immediate_blocker_external_evidence_required',
        'An immediate blocker requires a message from the user during this Goal or a tool result in this turn as evidence.',
      );
    }
    return;
  }
  // The current turn is the one being judged, so what the model wrote in
  // it counts; the two turns before it have to show something the model
  // did not merely say, as the rule this replaces required.
  const required = lineageTurnIds.slice(-3);
  const covered =
    lineageTurnIds.at(-1) === currentTurnId &&
    required.length === 3 &&
    required.every((turnId) =>
      turnId === currentTurnId
        ? has(turnId, 'tool_result', 'real_user', 'assistant_output')
        : has(turnId, 'tool_result', 'real_user'),
    );
  if (!covered) {
    throw new GoalVerifierCoverageError(
      'repeated_blocker_turn_coverage',
      'A repeated blocker requires evidence in the current turn and a tool result or a message from the user in each of the two immediately preceding Goal turns.',
    );
  }
}

function resolveBudget(budgetBytes: number | undefined): number {
  if (budgetBytes === undefined) return VERIFIER_EVIDENCE_WINDOW_BYTE_LIMIT;
  if (!Number.isFinite(budgetBytes)) {
    throw new GoalVerifierWindowBudgetError(
      'budget_invalid',
      `The verifier evidence window budget must be a finite number of bytes; got ${String(budgetBytes)}.`,
    );
  }
  if (budgetBytes < VERIFIER_EVIDENCE_WINDOW_MIN_BYTES) {
    throw new GoalVerifierWindowBudgetError(
      'budget_too_small',
      `The verifier request leaves ${Math.floor(budgetBytes)} bytes for evidence, under the ${VERIFIER_EVIDENCE_WINDOW_MIN_BYTES} a proposal can be judged from.`,
    );
  }
  return Math.min(VERIFIER_EVIDENCE_WINDOW_BYTE_LIMIT, Math.floor(budgetBytes));
}

/**
 * Anchors the transcript to this permit and checks the one rule the window
 * adds to the shared anchor: the current turn may be absent (nothing
 * recorded yet) but, if present, must be the lineage's tail.
 */
function attributeTranscript(input: GoalEvidenceValidationInput): {
  cursorIndex: number;
  lineageTurnIds: string[];
} {
  const { cursorIndex, lineageTurnIds } = anchorGoalTranscript(input);
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
 * A lower bound on a record's serialized entry, cheap enough to decide
 * "cannot fit" without serializing a tool response. For a model or tool
 * record the trimmed text parts are sent as they are, so their length is a
 * bound (a UTF-16 unit is at least one UTF-8 byte). A user record has no
 * such bound: its parts may be an expanded file reference that displays as
 * one line, so it costs only the bare entry until rendered.
 */
function leastBytes(candidate: {
  record: GoalEvidenceRecord;
  provenance: GoalEvidenceProvenance;
}): number {
  if (candidate.provenance === 'real_user') return MIN_ENTRY_BYTES;
  let text = 0;
  for (const part of candidate.record.message?.parts ?? []) {
    if (part.thought !== true && typeof part.text === 'string') {
      text += part.text.trim().length;
    }
  }
  const capped =
    RECORD_CONTENT_BYTE_LIMIT -
    Buffer.byteLength(MIDDLE_TRUNCATION_MARKER, 'utf8');
  return MIN_ENTRY_BYTES + Math.min(text, capped);
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
    let codePointBytes: number;
    const unit = value.charCodeAt(next);
    if (
      unit >= 0xdc00 &&
      unit <= 0xdfff &&
      next > 0 &&
      value.charCodeAt(next - 1) >= 0xd800 &&
      value.charCodeAt(next - 1) <= 0xdbff
    ) {
      next -= 1;
      codePointBytes = 4;
    } else if (unit < 0x80) {
      codePointBytes = 1;
    } else if (unit < 0x800) {
      codePointBytes = 2;
    } else {
      codePointBytes = 3;
    }
    if (byteLength + codePointBytes > budget) break;
    byteLength += codePointBytes;
    start = next;
  }
  return value.slice(start);
}
