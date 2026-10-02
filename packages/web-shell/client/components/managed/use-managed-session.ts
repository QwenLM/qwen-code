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
  // Whether any older page was ever loaded; the highest id any page returned
  // (the paged region's top edge); and whether paging reached the beginning.
  const pagedRef = useRef(false);
  const pagedHeadRef = useRef<number | undefined>(undefined);
  const exhaustedRef = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    cursorRef.current = undefined;
    pagedRef.current = false;
    pagedHeadRef.current = undefined;
    exhaustedRef.current = false;
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
        const empty = firstId === undefined;
        // A non-empty snapshot without an older cursor already carries the
        // full history: nothing is left to page, and a stale paging cursor
        // would re-fetch raw events the snapshot has since assembled into
        // items, duplicating them. Paging may matter again after a later
        // raw-page gap, so exhaustion is reset too.
        const fullHistory = !empty && transcript.olderCursor === undefined;
        // The cursor must fetch below the oldest retained event; one
        // decision feeds both the fetch gate (cursorRef) and the affordance
        // (state.olderCursor). Pages top out at pagedHeadRef, so a window
        // starting above it leaves a hole only the snapshot's own cursor
        // can refill.
        let nextCursor: string | undefined;
        if (fullHistory) nextCursor = undefined;
        else if (empty) nextCursor = cursorRef.current;
        else if (!pagedRef.current) nextCursor = transcript.olderCursor;
        else if (
          pagedHeadRef.current !== undefined &&
          pagedHeadRef.current < firstId - 1
        ) {
          // A hole between the paged pages and the window is content the
          // exhaustion flag never covered: adopt the window's cursor so the
          // hole stays pageable, and drop the now-stale exhaustion.
          nextCursor = transcript.olderCursor;
          exhaustedRef.current = false;
        } else if (exhaustedRef.current) nextCursor = cursorRef.current;
        else nextCursor = cursorRef.current ?? transcript.olderCursor;
        if (fullHistory) exhaustedRef.current = false;
        cursorRef.current = nextCursor;
        setState((current) => {
          const kept = empty
            ? current.events
            : current.events.filter((event) => {
                if (event.id > transcript.lastEventId) return true;
                if (event.id >= firstId) return false;
                // Older than the window: only events the user paged in
                // survive (anything else would grow and fuse text across a
                // hole), and item projections never do — the raw originals
                // are what the server stands behind after a retraction.
                return (
                  pagedRef.current &&
                  event.id <= (pagedHeadRef.current ?? -1) &&
                  event.assembledFromItem !== true
                );
              });
          return {
            ...current,
            summary,
            events: mergeManagedEvents(kept, transcript.events),
            olderCursor: nextCursor,
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
    const fetchPage = async (
      cursor: string,
      allowRetry: boolean,
    ): Promise<void> => {
      try {
        const page = await provider.getTranscript(sessionId, {
          clientId,
          before: cursor,
          limit: 100,
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        // A gap resync moved the cursor while this fetch was in flight. If
        // it cleared the cursor (full-history snapshot), the page carries
        // raw events the snapshot has since assembled into items — merging
        // it would duplicate them, so discard it. If it merely slid forward
        // (a windowed gap), retry once on the new cursor instead of
        // swallowing the click.
        if (cursorRef.current !== cursor) {
          const moved = cursorRef.current;
          if (moved !== undefined && allowRetry) return fetchPage(moved, false);
          return;
        }
        cursorRef.current = page.olderCursor;
        pagedRef.current = true;
        exhaustedRef.current = page.olderCursor === undefined;
        if (page.events.length > 0)
          pagedHeadRef.current = Math.max(
            pagedHeadRef.current ?? 0,
            ...page.events.map((event) => event.id),
          );
        // The fresh page wins over local copies on a shared id: the server
        // may have corrected (e.g. retracted) the text since.
        setState((current) => ({
          ...current,
          events: mergeManagedEvents(current.events, page.events),
          olderCursor: page.olderCursor,
          error: undefined,
        }));
      } catch (error) {
        if (!abort.signal.aborted && cursorRef.current === cursor)
          setState((current) => ({
            ...current,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
    };
    try {
      await fetchPage(before, true);
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
