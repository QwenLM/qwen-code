import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ManagedAgentPendingAction,
  ManagedAgentProvider,
  ManagedAgentSessionEvent,
} from './managed-agent-provider';
import { isNonRetryableClientError } from './managed-request-error';

// Re-reads shortly after the earliest expiry so an unanswered approval leaves
// the page once the Harness has ended it.
const EXPIRY_GRACE_MS = 1_000;
// A failed read of the pending approvals is retried a few times, so one
// transient failure does not hide an approval until it expires.
const LOAD_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
// The contract's codes for an Action that already ended: it expired, was
// cancelled, or was answered elsewhere. Retrying the answer cannot succeed.
const ENDED_ACTION_CODES: ReadonlySet<string> = new Set([
  'action_expired',
  'action_cancelled',
  'action_already_resolved',
]);

function endedAction(failure: unknown): boolean {
  const code =
    typeof failure === 'object' && failure !== null && 'code' in failure
      ? (failure as { code?: unknown }).code
      : undefined;
  return typeof code === 'string' && ENDED_ACTION_CODES.has(code);
}

export interface ManagedActionsState {
  /** The approval to show; answered ones stay hidden while they settle. */
  action?: ManagedAgentPendingAction;
  /** Reading the pending approvals failed; retries run in the background. */
  loadError?: unknown;
  /**
   * The pending approvals have been read for this Session, so a failed read is
   * a failed refresh of what the page already shows rather than an empty list.
   */
  loaded: boolean;
  /** Sending an answer failed; the approval is shown again. */
  answerError?: unknown;
  /**
   * The service refused an answer as creator-only. That is a fact about the
   * viewer and the Session, not about one Action, so it outlives the refused
   * Action, covers every later approval the same Session raises, and survives
   * leaving that Session and coming back. It is remembered per mount: a reload
   * or reopening the panel starts clean.
   */
  respondForbidden: boolean;
  respond(actionId: string, optionId: string): Promise<void>;
  /** Reads the pending approvals again now. */
  retry(): void;
}

/**
 * Loads a Session's pending Hosted approvals and answers them. It re-reads
 * when the transcript reports an approval change or a reconciled gap, when an
 * approval expires, and after an answer. `enabled` is undefined while the
 * Session summary is unknown, for example during a reload: the shown approval
 * stays and can be answered, and reads resume once the capability is known.
 */
export function useManagedActions(
  provider: ManagedAgentProvider,
  sessionId: string | undefined,
  clientId: string,
  enabled: boolean | undefined,
  events: readonly ManagedAgentSessionEvent[],
): ManagedActionsState {
  const reader = enabled === false ? undefined : provider.actions;
  const [pending, setPending] = useState<{
    sessionId?: string;
    actions: ManagedAgentPendingAction[];
  }>({ actions: [] });
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [loadError, setLoadError] = useState<unknown>();
  const [answerError, setAnswerError] = useState<unknown>();
  // The Sessions that refused this viewer as a non-creator, keyed by Session so
  // that leaving a refused one and coming back does not re-admit the 403.
  const [forbiddenSessions, setForbiddenSessions] = useState<
    ReadonlySet<string>
  >(new Set());
  const [revision, setRevision] = useState(0);
  const loadFailures = useRef(0);
  // The Action whose answer last failed, so the warning can be dropped once
  // that Action is no longer pending instead of labelling the next one.
  const answerFailure = useRef<string | undefined>(undefined);
  // Actions hidden because the service reported them ended when answered. A
  // read that still lists one shows it again, so a wrong report cannot hide
  // an approvable Action.
  const endedAnswers = useRef(new Set<string>());
  const trigger = useMemo(() => {
    let last = 0;
    for (const event of events) {
      if (event.type === 'action_updated' || event.type === 'stream_gap') {
        last = event.id;
      }
    }
    return last;
  }, [events]);

  useEffect(() => {
    setAnswered(new Set());
    setLoadError(undefined);
    setAnswerError(undefined);
    loadFailures.current = 0;
    answerFailure.current = undefined;
    endedAnswers.current.clear();
  }, [sessionId]);

  useEffect(() => {
    if (!reader || !sessionId) {
      setPending({ actions: [] });
      // A withdrawn reader is not a failed read: a restored reader gets the
      // whole retry budget back instead of a single attempt with no ladder.
      loadFailures.current = 0;
      return undefined;
    }
    if (enabled === undefined) {
      // So is a reload, which is how a user retries from the page: the
      // reader comes back with the same Session and a fresh retry budget.
      loadFailures.current = 0;
      return undefined;
    }
    const abort = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    reader
      .listPending(sessionId, { clientId, signal: abort.signal })
      .then((actions) => {
        if (abort.signal.aborted) return;
        loadFailures.current = 0;
        setPending({ sessionId, actions });
        setLoadError(undefined);
        const stillListed = actions
          .map((entry) => entry.actionId)
          .filter((id) => endedAnswers.current.has(id));
        endedAnswers.current.clear();
        if (stillListed.length > 0) {
          setAnswered((current) => {
            const next = new Set(current);
            for (const id of stillListed) next.delete(id);
            return next;
          });
        }
        // The Action whose answer failed is no longer pending, so the
        // unconfirmed-answer warning has nothing left to describe; keeping it
        // would announce a stale failure beside an unrelated card.
        if (
          answerFailure.current !== undefined &&
          !actions.some((entry) => entry.actionId === answerFailure.current)
        ) {
          answerFailure.current = undefined;
          setAnswerError(undefined);
        }
      })
      .catch((failure: unknown) => {
        if (abort.signal.aborted) return;
        setLoadError(failure);
        // A 4xx the service will answer the same way every time is not a
        // hiccup: retrying it only burns requests, and the Retry button would
        // keep offering an attempt that cannot succeed. Timeouts and rate
        // limits still back off as before.
        if (isNonRetryableClientError(failure)) return;
        const delay = LOAD_RETRY_DELAYS_MS[loadFailures.current];
        loadFailures.current += 1;
        if (delay !== undefined) {
          retryTimer = setTimeout(
            () => setRevision((value) => value + 1),
            delay,
          );
        }
      });
    return () => {
      abort.abort();
      clearTimeout(retryTimer);
    };
  }, [reader, enabled, sessionId, clientId, trigger, revision]);

  const earliestExpiry = pending.actions.length
    ? Math.min(...pending.actions.map((action) => action.expiresAt))
    : undefined;
  useEffect(() => {
    if (earliestExpiry === undefined) return undefined;
    const timer = setTimeout(
      () => setRevision((value) => value + 1),
      Math.max(0, earliestExpiry - Date.now()) + EXPIRY_GRACE_MS,
    );
    return () => clearTimeout(timer);
  }, [earliestExpiry]);

  const actions = useMemo(
    () => (pending.sessionId === sessionId ? pending.actions : []),
    [pending.sessionId, pending.actions, sessionId],
  );
  // `pending.sessionId` is set by the success branch of a read only.
  const loaded = pending.sessionId === sessionId;
  const action = actions.find((entry) => !answered.has(entry.actionId));
  const current = useRef({ sessionId, actions });
  current.current = { sessionId, actions };

  const respond = useCallback(
    async (actionId: string, optionId: string) => {
      const target = actions.find((entry) => entry.actionId === actionId);
      if (!target || !reader) return;
      const isPending = () =>
        current.current.sessionId === target.sessionId &&
        current.current.actions.some((entry) => entry.actionId === actionId);
      setAnswered((current) => new Set(current).add(actionId));
      try {
        // One key per Action and option: a retried click replays the same
        // durable operation instead of answering twice.
        await reader.respond(target, optionId, {
          clientId,
          idempotencyKey: `${target.actionId}:${optionId}`,
        });
        if (!isPending()) return;
        if (answerFailure.current === actionId) {
          setAnswerError(undefined);
          answerFailure.current = undefined;
        }
        setRevision((value) => value + 1);
      } catch (failure) {
        if (
          typeof failure === 'object' &&
          failure !== null &&
          'code' in failure &&
          (failure as { code?: unknown }).code === 'action_forbidden'
        ) {
          // Responding requires the Session creator, which the service decides
          // from the (tenant, Session, actor) row rather than the Action, and
          // checks before it checks that the Action still exists. So the
          // refusal is recorded even when a re-read has already dropped the
          // refused Action, and it covers every later approval of the Session
          // the answer was aimed at — not the one now selected.
          setForbiddenSessions((current) =>
            new Set(current).add(target.sessionId),
          );
        }
        if (!isPending()) throw failure;
        if (endedAction(failure)) {
          // No retry can succeed, so keep the card hidden and read the list
          // again instead of offering an answer the service will refuse.
          endedAnswers.current.add(actionId);
          if (answerFailure.current === actionId) {
            answerFailure.current = undefined;
            setAnswerError(undefined);
          }
          setRevision((value) => value + 1);
          return;
        }
        setAnswered((current) => {
          const next = new Set(current);
          next.delete(actionId);
          return next;
        });
        setAnswerError(failure);
        answerFailure.current = actionId;
        throw failure;
      }
    },
    [actions, reader, clientId],
  );

  const retry = useCallback(() => {
    loadFailures.current = 0;
    setRevision((value) => value + 1);
  }, []);

  return {
    action,
    loadError,
    loaded,
    answerError:
      answerFailure.current === action?.actionId ? answerError : undefined,
    respondForbidden:
      sessionId !== undefined && forbiddenSessions.has(sessionId),
    respond,
    retry,
  };
}
