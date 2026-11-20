import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import { extractPendingPermission } from '../adapters/transcriptAdapter.js';
import type { DaemonDecisionSettlement } from './chat-controller.js';

/**
 * The option id a question answer must vote to be applied. A question is
 * answered by selecting its submit (`allow_once`) option with the answers
 * attached — the same wire shape `AskUserQuestion.handleSubmit` uses. Voting
 * with no option id sends a `cancelled` outcome, which discards the answers and
 * cancels the question, so the submit option is required. Returns undefined when
 * the request is not pending or has no submit option.
 */
export function questionSubmitOptionId(
  pendingPermissions: ReadonlyArray<
    Extract<DaemonTranscriptBlock, { kind: 'permission' }>
  >,
  requestId: string,
): string | undefined {
  const permission = pendingPermissions.find(
    (candidate) => candidate.requestId === requestId,
  );
  if (!permission) return undefined;
  return extractPendingPermission([permission])?.options.find(
    (option) => option.kind === 'allow_once',
  )?.id;
}

/**
 * The permission-derived signals the daemon controller needs but the provider
 * does not expose as explicit channels: approval currency and decision
 * settlement. Both are derived from the pending-permission set across renders.
 *
 * Currency: a request is live while its permission is pending. It is marked
 * not-live only when it leaves the pending set *without* this controller having
 * answered it — i.e. it was superseded. A request this controller answered stays
 * live so its decision can establish; the engine releases the identity itself on
 * establishment.
 *
 * Decision settlement: when a permission this controller answered leaves the
 * pending set, the daemon applied the answer, so an `applied: true` settlement is
 * emitted for that request. This is authoritative evidence (the block resolved),
 * not the transport's admission.
 */
export interface PermissionSignals {
  readonly currency: ReadonlyArray<readonly [requestId: string, live: boolean]>;
  readonly decisions: readonly DaemonDecisionSettlement[];
  readonly answered: ReadonlySet<string>;
}

export function derivePermissionSignals(
  prevPending: ReadonlySet<string>,
  nextPending: ReadonlySet<string>,
  answered: ReadonlySet<string>,
): PermissionSignals {
  const currency: Array<readonly [string, boolean]> = [];
  const decisions: DaemonDecisionSettlement[] = [];
  const nextAnswered = new Set(answered);

  // A newly pending request is live.
  for (const requestId of nextPending) {
    if (!prevPending.has(requestId)) {
      currency.push([requestId, true]);
    }
  }

  // A request that left the pending set was resolved. If this controller
  // answered it, the daemon applied the answer (decision settlement); the
  // request stays live so the decision can establish. Otherwise it was
  // superseded, so it is no longer live.
  for (const requestId of prevPending) {
    if (nextPending.has(requestId)) continue;
    if (nextAnswered.has(requestId)) {
      decisions.push({ requestId, applied: true });
      nextAnswered.delete(requestId);
    } else {
      currency.push([requestId, false]);
    }
  }

  return { currency, decisions, answered: nextAnswered };
}
