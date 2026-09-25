import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionEvent,
  ManagedAgentSessionSummary,
} from './managed-agent-provider';
import { mergeManagedEvents } from './managed-session-messages';

function pause(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

interface ManagedSessionState {
  sessionId?: string;
  summary?: ManagedAgentSessionSummary;
  events: ManagedAgentSessionEvent[];
  olderCursor?: string;
  loading: boolean;
  error?: string;
}

export function useManagedSession(
  provider: ManagedAgentProvider,
  clientId: string,
  sessionId: string | undefined,
) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ManagedSessionState>({
    events: [],
    loading: false,
  });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const cursorRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    cursorRef.current = undefined;
    setLoadingOlder(false);
    setState({ sessionId, events: [], loading: Boolean(sessionId) });
    if (!sessionId) return () => abort.abort();
    const opts = { clientId, signal: abort.signal };
    const update = (change: Partial<ManagedSessionState>) => {
      if (!abort.signal.aborted)
        setState((current) => ({ ...current, ...change }));
    };
    const fail = (error: unknown) =>
      update({
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      });
    const snapshot = async () => {
      const [summary, transcript] = await Promise.all([
        provider.getSession(sessionId, opts),
        provider.getTranscript(sessionId, { ...opts, limit: 100 }),
      ]);
      if (abort.signal.aborted) return transcript.lastEventId;
      cursorRef.current = transcript.olderCursor;
      update({
        summary,
        events: transcript.events,
        olderCursor: transcript.olderCursor,
        loading: false,
        error: undefined,
      });
      return transcript.lastEventId;
    };
    void (async () => {
      let lastEventId: number | undefined;
      while (!abort.signal.aborted && lastEventId === undefined) {
        try {
          lastEventId = await snapshot();
        } catch (error) {
          fail(error);
          await pause(abort.signal, 3000);
        }
      }
      if (lastEventId === undefined || abort.signal.aborted) return;
      while (!abort.signal.aborted) {
        let gap = false;
        let retryDelayMs = 3000;
        try {
          for await (const event of provider.subscribeEvents(sessionId, {
            ...opts,
            lastEventId,
          })) {
            if (abort.signal.aborted) return;
            if (event.type === 'stream_gap') {
              gap = true;
              break;
            }
            if (event.id <= lastEventId) continue;
            lastEventId = event.id;
            setState((current) => ({
              ...current,
              events: mergeManagedEvents(current.events, [event]),
              error: undefined,
            }));
          }
          if (gap) {
            lastEventId = await snapshot();
            retryDelayMs = 0;
          } else if (!abort.signal.aborted)
            update({
              summary: await provider.getSession(sessionId, opts),
            });
        } catch (error) {
          fail(error);
        }
        await pause(abort.signal, retryDelayMs);
      }
    })();
    void (async () => {
      while (!abort.signal.aborted) {
        await pause(abort.signal, 3000);
        if (abort.signal.aborted) return;
        try {
          update({ summary: await provider.getSession(sessionId, opts) });
        } catch (error) {
          fail(error);
        }
      }
    })();
    return () => abort.abort();
  }, [provider, clientId, sessionId, revision]);

  const loadOlder = useCallback(async () => {
    const abort = lifetime.current;
    const before = cursorRef.current;
    if (!abort || abort.signal.aborted || !sessionId || !before || loadingOlder)
      return;
    setLoadingOlder(true);
    try {
      const page = await provider.getTranscript(sessionId, {
        clientId,
        before,
        limit: 100,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      cursorRef.current = page.olderCursor;
      setState((current) => ({
        ...current,
        events: mergeManagedEvents(page.events, current.events),
        olderCursor: page.olderCursor,
        error: undefined,
      }));
    } catch (error) {
      if (!abort.signal.aborted)
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : String(error),
        }));
    } finally {
      if (!abort.signal.aborted) setLoadingOlder(false);
    }
  }, [provider, clientId, sessionId, loadingOlder]);
  const reload = useCallback(() => setRevision((current) => current + 1), []);
  const visible =
    state.sessionId === sessionId
      ? state
      : { events: [], loading: Boolean(sessionId) };
  return { ...visible, loadingOlder, loadOlder, reload };
}
