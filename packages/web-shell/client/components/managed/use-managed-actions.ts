import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ManagedAgentPendingAction,
  ManagedAgentProvider,
  ManagedAgentSessionEvent,
} from './managed-agent-provider';

// Re-reads shortly after the earliest expiry so an unanswered approval leaves
// the page once the Harness has ended it.
const EXPIRY_GRACE_MS = 1_000;
// A failed read of the pending approvals is retried a few times, so one
// transient failure does not hide an approval until it expires.
const LOAD_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
// The contract answers these when the Action already ended, so retrying the
// answer can never succeed.
const ENDED_ACTION_CODES: ReadonlySet<string> = new Set([
  'action_expired',
  'action_cancelled',
  'action_already_resolved',
]);

/** A 4xx other than a timeout or rate limit fails the same way again. */
export function isNonRetryableClientError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

function endedAction(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === 'string' && ENDED_ACTION_CODES.has(code);
}

export interface ManagedActionsState {
  /** The approval to show; answered ones stay hidden while they settle. */
  action?: ManagedAgentPendingAction;
  /**
   * Reading the pending approvals failed. Transient failures are retried in
   * the background; a client error is not.
   */
  loadError?: unknown;
  /** Answering the shown approval failed; it is shown again. */
  answerError?: unknown;
  respond(actionId: string, optionId: string): Promise<void>;
  /** Reads the pending approvals again now. */
  retry(): void;
}

/**
 * Loads a Session's pending Hosted approvals and answers them. It re-reads
 * when the stream reports an approval change or a reconciled gap, when an
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
  const [failedAnswer, setFailedAnswer] = useState<{
    actionId: string;
    cause: unknown;
  }>();
  const [revision, setRevision] = useState(0);
  const loadFailures = useRef(0);
  // Only a read started by the retry timer continues the retry ladder; any
  // other read starts it again.
  const retrying = useRef(false);
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
    setFailedAnswer(undefined);
  }, [sessionId]);

  useEffect(() => {
    if (!reader || !sessionId) {
      setPending({ actions: [] });
      return undefined;
    }
    if (enabled === undefined) return undefined;
    if (!retrying.current) loadFailures.current = 0;
    retrying.current = false;
    const abort = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    reader
      .listPending(sessionId, { clientId, signal: abort.signal })
      .then((actions) => {
        if (abort.signal.aborted) return;
        setPending({ sessionId, actions });
        setLoadError(undefined);
      })
      .catch((failure: unknown) => {
        if (abort.signal.aborted) return;
        setLoadError(failure);
        if (isNonRetryableClientError(failure)) return;
        const delay = LOAD_RETRY_DELAYS_MS[loadFailures.current];
        loadFailures.current += 1;
        if (delay !== undefined) {
          retryTimer = setTimeout(() => {
            retrying.current = true;
            setRevision((value) => value + 1);
          }, delay);
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
  const action = actions.find((entry) => !answered.has(entry.actionId));

  const respond = useCallback(
    async (actionId: string, optionId: string) => {
      const target = actions.find((entry) => entry.actionId === actionId);
      if (!target || !reader) return;
      setAnswered((current) => new Set(current).add(actionId));
      try {
        // One key per Action and option: a retried click replays the same
        // durable operation instead of answering twice.
        await reader.respond(target, optionId, {
          clientId,
          idempotencyKey: `${target.actionId}:${optionId}`,
        });
        setFailedAnswer(undefined);
        setRevision((value) => value + 1);
      } catch (failure) {
        if (endedAction(failure)) {
          // Another answer or the expiry ended it; keep it hidden and read
          // the list again instead of offering a retry that cannot succeed.
          setFailedAnswer(undefined);
          setRevision((value) => value + 1);
          return;
        }
        setAnswered((current) => {
          const next = new Set(current);
          next.delete(actionId);
          return next;
        });
        setFailedAnswer({ actionId, cause: failure });
        throw failure;
      }
    },
    [actions, reader, clientId],
  );

  const retry = useCallback(() => {
    setRevision((value) => value + 1);
  }, []);

  // The failure belongs to one approval: it is not shown beside another.
  const answerError =
    failedAnswer && action?.actionId === failedAnswer.actionId
      ? failedAnswer.cause
      : undefined;
  return { action, loadError, answerError, respond, retry };
}
