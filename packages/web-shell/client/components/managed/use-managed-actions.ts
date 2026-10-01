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

export interface ManagedActionsState {
  /** The approval to show; answered ones stay hidden while they settle. */
  action?: ManagedAgentPendingAction;
  /** Reading the pending approvals failed; retries run in the background. */
  loadError?: unknown;
  /** Sending an answer failed; the approval is shown again. */
  answerError?: unknown;
  respond(actionId: string, optionId: string): Promise<void>;
  /** Reads the pending approvals again now. */
  retry(): void;
}

/**
 * Loads a Session's pending Hosted approvals and answers them. It re-reads
 * when the stream reports an approval change or a gap, when an approval
 * expires, and after an answer. `enabled` is undefined while the Session
 * summary is unknown, for example during a reload: the shown approval stays
 * and can be answered, and reads resume once the capability is known.
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
  const [revision, setRevision] = useState(0);
  const loadFailures = useRef(0);
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
  }, [sessionId]);

  useEffect(() => {
    if (!reader || !sessionId) {
      setPending({ actions: [] });
      return undefined;
    }
    if (enabled === undefined) return undefined;
    const abort = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    reader
      .listPending(sessionId, { clientId, signal: abort.signal })
      .then((actions) => {
        if (abort.signal.aborted) return;
        loadFailures.current = 0;
        setPending({ sessionId, actions });
        setLoadError(undefined);
      })
      .catch((failure: unknown) => {
        if (abort.signal.aborted) return;
        setLoadError(failure);
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
        setAnswerError(undefined);
        setRevision((value) => value + 1);
      } catch (failure) {
        setAnswered((current) => {
          const next = new Set(current);
          next.delete(actionId);
          return next;
        });
        setAnswerError(failure);
        throw failure;
      }
    },
    [actions, reader, clientId],
  );

  const retry = useCallback(() => {
    loadFailures.current = 0;
    setRevision((value) => value + 1);
  }, []);

  return { action, loadError, answerError, respond, retry };
}
