import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ManagedAgentPendingAction,
  ManagedAgentProvider,
  ManagedAgentSessionEvent,
} from './managed-agent-provider';

// Re-reads shortly after the earliest expiry so an unanswered approval leaves
// the page once the Harness has ended it.
const EXPIRY_GRACE_MS = 1_000;

export interface ManagedActionsState {
  /** The approval to show; answered ones stay hidden while they settle. */
  action?: ManagedAgentPendingAction;
  error?: unknown;
  respond(actionId: string, optionId: string): Promise<void>;
}

/**
 * Loads a Session's pending Hosted approvals and answers them. It re-reads
 * when the stream reports an approval change or a gap, when an approval
 * expires, and after an answer.
 */
export function useManagedActions(
  provider: ManagedAgentProvider,
  sessionId: string | undefined,
  clientId: string,
  enabled: boolean,
  events: readonly ManagedAgentSessionEvent[],
): ManagedActionsState {
  const reader = enabled ? provider.actions : undefined;
  const [pending, setPending] = useState<{
    sessionId?: string;
    actions: ManagedAgentPendingAction[];
  }>({ actions: [] });
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<unknown>();
  const [revision, setRevision] = useState(0);
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
    setError(undefined);
  }, [sessionId]);

  useEffect(() => {
    if (!reader || !sessionId) {
      setPending({ actions: [] });
      return undefined;
    }
    const abort = new AbortController();
    reader
      .listPending(sessionId, { clientId, signal: abort.signal })
      .then((actions) => {
        if (abort.signal.aborted) return;
        setPending({ sessionId, actions });
        setError(undefined);
      })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted) setError(failure);
      });
    return () => abort.abort();
  }, [reader, sessionId, clientId, trigger, revision]);

  useEffect(() => {
    if (pending.actions.length === 0) return undefined;
    const earliest = Math.min(
      ...pending.actions.map((action) => action.expiresAt),
    );
    const timer = setTimeout(
      () => setRevision((value) => value + 1),
      Math.max(0, earliest - Date.now()) + EXPIRY_GRACE_MS,
    );
    return () => clearTimeout(timer);
  }, [pending]);

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
        setRevision((value) => value + 1);
      } catch (failure) {
        setAnswered((current) => {
          const next = new Set(current);
          next.delete(actionId);
          return next;
        });
        setError(failure);
      }
    },
    [actions, reader, clientId],
  );

  return { action, error, respond };
}
