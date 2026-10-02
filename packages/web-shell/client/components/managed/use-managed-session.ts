import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionEvent,
  ManagedAgentSessionSummary,
} from './managed-agent-provider';
import { isNonRetryableClientError } from './managed-request-error';
import { mergeManagedEvents } from './managed-session-messages';

const BASE_RETRY_DELAY_MS = 3_000;
const MAX_RETRY_DELAY_MS = 30_000;

// Rung zero must stay exactly BASE_RETRY_DELAY_MS: ManagedSessionsPage pins
// the gap-recovery cadence with a 2999/3000ms boundary in another file, and
// any first-failure jitter would break it.
export function failureRetryDelayMs(failures: number): number {
  const cap = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** failures);
  return (
    BASE_RETRY_DELAY_MS +
    Math.floor(Math.random() * (cap - BASE_RETRY_DELAY_MS))
  );
}

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
  // A terminal (non-retryable) stop, sticky across per-event updates that
  // legitimately clear the transient `error` of the loop that owns it.
  stoppedReason?: string;
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
    const stop = (error: unknown) =>
      update({
        stoppedReason: error instanceof Error ? error.message : String(error),
      });
    void (async () => {
      let lastEventId: number | undefined;
      let failures = 0;
      while (!abort.signal.aborted && lastEventId === undefined) {
        try {
          lastEventId = await snapshot();
          failures = 0;
        } catch (error) {
          fail(error);
          if (isNonRetryableClientError(error)) {
            stop(error);
            return;
          }
          await pause(abort.signal, failureRetryDelayMs(failures++));
        }
      }
      if (lastEventId === undefined || abort.signal.aborted) return;
      // The durable snapshot read has its own health: the stream can keep
      // delivering while it fails, so it climbs its own ladder instead of
      // being charged to (and zeroed by) the stream's counter.
      let snapshotFailures = 0;
      while (!abort.signal.aborted) {
        let gap = false;
        let delayMs = 0;
        let delivered = false;
        const connectedAt = Date.now();
        try {
          for await (const event of provider.subscribeEvents(sessionId, {
            ...opts,
            lastEventId,
          })) {
            if (abort.signal.aborted) return;
            delivered = true;
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
            try {
              lastEventId = await snapshot();
              snapshotFailures = 0;
            } catch (error) {
              fail(error);
              if (isNonRetryableClientError(error)) {
                stop(error);
                return;
              }
              delayMs = failureRetryDelayMs(snapshotFailures++);
            }
          } else if (!abort.signal.aborted) {
            update({
              summary: await provider.getSession(sessionId, opts),
            });
            delayMs = BASE_RETRY_DELAY_MS;
          }
          failures = 0;
        } catch (error) {
          fail(error);
          if (isNonRetryableClientError(error)) {
            stop(error);
            return;
          }
          // Any delivered frame, or a connection that simply lived long
          // enough, proves the path healthy; only back-to-back failures
          // with nothing delivered should stretch the ladder.
          if (delivered || Date.now() - connectedAt >= BASE_RETRY_DELAY_MS)
            failures = 0;
          delayMs = failureRetryDelayMs(failures++);
        }
        await pause(abort.signal, delayMs);
      }
    })();
    void (async () => {
      let failures = 0;
      while (!abort.signal.aborted) {
        await pause(abort.signal, failureRetryDelayMs(failures));
        if (abort.signal.aborted) return;
        try {
          update({ summary: await provider.getSession(sessionId, opts) });
          failures = 0;
        } catch (error) {
          fail(error);
          if (isNonRetryableClientError(error)) {
            stop(error);
            return;
          }
          failures++;
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
