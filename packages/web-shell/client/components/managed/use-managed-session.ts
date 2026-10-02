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
  const pagedRef = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    cursorRef.current = undefined;
    pagedRef.current = false;
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
    const snapshot = async (preserveLoadedPages: boolean) => {
      const [summary, transcript] = await Promise.all([
        provider.getSession(sessionId, opts),
        provider.getTranscript(sessionId, { ...opts, limit: 100 }),
      ]);
      if (abort.signal.aborted) return transcript.lastEventId;
      if (preserveLoadedPages) {
        // The stream never replays events at or below the snapshot head,
        // so the snapshot is the sole authority for that range (assumed
        // contiguous from its first event): a live event missing from it
        // was superseded server-side (e.g. deltas assembled into an item)
        // and must not survive the merge as a duplicate. An empty snapshot
        // asserts nothing about content, so keep everything, cursor
        // included.
        const firstId = transcript.events.reduce<number | undefined>(
          (min, event) =>
            min === undefined || event.id < min ? event.id : min,
          undefined,
        );
        // The transcript is assembled only while the server holds a durable
        // snapshot; a raw page (no coveredSequence) means the items are gone
        // (e.g. mid-reconciliation), so kept item projections would duplicate
        // or un-retract the raw events.
        const assembled = (transcript.coveredSequence ?? 0) > 0;
        const empty = firstId === undefined;
        // A non-empty snapshot without an older cursor already carries the
        // full history: nothing is left to page, and a stale paging cursor
        // would re-fetch raw events the snapshot has since assembled into
        // items, duplicating them. Clearing it also voids any in-flight
        // older-page fetch (loadOlder checks the cursor is unmoved).
        const fullHistory = !empty && transcript.olderCursor === undefined;
        if (fullHistory) cursorRef.current = undefined;
        else if (!empty) {
          // The cursor must fetch below the oldest RETAINED event. When the
          // user paged, their cursor stays valid (if a full-history gap
          // cleared it, adopt the snapshot's); otherwise nothing below the
          // window survives, so the view starts at the window and the
          // snapshot's cursor is the one that cannot skip content.
          if (pagedRef.current) cursorRef.current ??= transcript.olderCursor;
          else cursorRef.current = transcript.olderCursor;
        }
        setState((current) => {
          const kept = empty
            ? current.events
            : current.events.filter((event) => {
                if (event.id > transcript.lastEventId) return true;
                if (event.id >= firstId) return false;
                // Older than the window: only pages the user paged into
                // survive (an unpaged prefix would otherwise grow and fuse
                // text across the hole), and item projections only while
                // the server still backs them.
                return (
                  pagedRef.current &&
                  (assembled || event.assembledFromItem !== true)
                );
              });
          return {
            ...current,
            summary,
            events: mergeManagedEvents(kept, transcript.events),
            olderCursor: fullHistory
              ? undefined
              : empty
                ? current.olderCursor
                : pagedRef.current
                  ? (current.olderCursor ?? transcript.olderCursor)
                  : transcript.olderCursor,
            loading: false,
            error: undefined,
          };
        });
      } else {
        cursorRef.current = transcript.olderCursor;
        update({
          summary,
          events: transcript.events,
          olderCursor: transcript.olderCursor,
          loading: false,
          error: undefined,
        });
      }
      return transcript.lastEventId;
    };
    void (async () => {
      let lastEventId: number | undefined;
      while (!abort.signal.aborted && lastEventId === undefined) {
        try {
          lastEventId = await snapshot(false);
        } catch (error) {
          fail(error);
          await pause(abort.signal, 3000);
        }
      }
      if (lastEventId === undefined || abort.signal.aborted) return;
      let gapStalls = 0;
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
            gapStalls = 0;
            setState((current) => ({
              ...current,
              events: mergeManagedEvents(current.events, [event]),
              error: undefined,
            }));
          }
          if (gap) {
            const head = await snapshot(true);
            if (head > lastEventId) {
              lastEventId = head;
              gapStalls = 0;
              retryDelayMs = 0;
            } else {
              // A resync that cannot advance the cursor replays its trigger
              // identically: slow to the normal cadence, and after a few
              // stalls surface an error instead of spinning. The resync's
              // setState clears error each pass, so re-assert on every stall
              // — that keeps the banner up for the whole stall and clears a
              // transient error once resyncs succeed again.
              gapStalls += 1;
              retryDelayMs = 3000;
              if (gapStalls >= 3)
                fail(
                  new Error(
                    'Managed Agent event stream is not advancing; retrying',
                  ),
                );
            }
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
      // A gap resync that landed the full history cleared the cursor while
      // this fetch was in flight: its page carries raw events the snapshot
      // has since assembled into items, so merging it would duplicate them.
      if (abort.signal.aborted || cursorRef.current !== before) return;
      cursorRef.current = page.olderCursor;
      pagedRef.current = true;
      setState((current) => ({
        ...current,
        events: mergeManagedEvents(page.events, current.events),
        olderCursor: page.olderCursor,
        error: undefined,
      }));
    } catch (error) {
      if (!abort.signal.aborted && cursorRef.current === before)
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
