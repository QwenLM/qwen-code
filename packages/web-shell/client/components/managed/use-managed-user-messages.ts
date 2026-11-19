import { useCallback, useEffect, useRef, useState } from 'react';
import type { ManagedAgentProvider } from './managed-agent-provider';
import { managedRequestId } from './managed-session-storage';

export type ManagedUserMessageSnapshot =
  import('./generated/managed-agent-api').components['schemas']['UserMessageSnapshot'];
export type ManagedUserMessageCommand =
  import('./generated/managed-agent-api').components['schemas']['UserMessageCommand'];

export function useManagedUserMessages(
  provider: ManagedAgentProvider,
  sessionId?: string,
) {
  const [state, setState] = useState<{
    sessionId?: string;
    provider?: ManagedAgentProvider;
    snapshot?: ManagedUserMessageSnapshot;
    error?: string;
  }>({});
  const current = useRef({ sessionId, provider });
  current.current = { sessionId, provider };
  const querySequence = useRef(0);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!sessionId || !provider.userMessages) return;
      const sequence = ++querySequence.current;
      try {
        const snapshot = await provider.userMessages.query(sessionId, {
          signal,
          clientId: 'managed-user-messages',
        });
        if (
          !signal?.aborted &&
          current.current.sessionId === sessionId &&
          current.current.provider === provider &&
          sequence === querySequence.current
        )
          setState({ sessionId, provider, snapshot });
      } catch {
        // A transient read failure must not discard an authoritative snapshot.
      }
    },
    [provider, sessionId],
  );
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    const poll = async () => {
      if (running) return;
      running = true;
      try {
        await refresh(controller.signal);
      } finally {
        running = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh]);
  const command = useCallback(
    async (command: ManagedUserMessageCommand, key = managedRequestId()) => {
      if (!sessionId || !provider.userMessages)
        throw new Error('User message queue unavailable');
      try {
        await provider.userMessages.command(sessionId, command, {
          idempotencyKey: key,
        });
        await refresh();
      } catch (error) {
        if (
          current.current.sessionId === sessionId &&
          current.current.provider === provider
        )
          setState((state) => ({
            ...state,
            error: error instanceof Error ? error.message : String(error),
          }));
        await refresh();
        throw error;
      }
    },
    [provider, sessionId, refresh],
  );
  const snapshot =
    state.sessionId === sessionId && state.provider === provider
      ? state.snapshot
      : undefined;
  return {
    snapshot,
    supported: !!snapshot,
    error:
      state.sessionId === sessionId && state.provider === provider
        ? state.error
        : undefined,
    command,
    refresh,
  };
}
