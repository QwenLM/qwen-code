import type { DaemonDecisionSettlement } from './chat-controller.js';

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
