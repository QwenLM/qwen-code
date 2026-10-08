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
  // Paging state: whether any older page was ever loaded, the highest id any
  // page returned (the paged region's top edge), and whether the user paged
  // all the way to the beginning.
  const pagedRef = useRef(false);
  const pagedHeadRef = useRef<number | undefined>(undefined);
  const exhaustedRef = useRef(false);
  // The stream loop, the summary poll and loadOlder share the error field;
  // a success may only clear what its own writer raised, so every live
  // condition is booked under its writer here and a release reveals the
  // highest-priority survivor. The stall alert is the one error whose
  // condition outlives the pass that raised it: it stays armed until an
  // advancing event or resync ends it, and outranks every booked entry. A
  // poll entry is never revealed by another writer's release: the poll
  // re-asserts on its own 3 s cadence, while stream and paging conditions
  // may never re-assert.
  const errorOwnership = useRef<{
    writers: Map<'stream' | 'poll' | 'paging', string>;
    stall?: string;
  }>({ writers: new Map() });
  const releaseError = useCallback((writer: 'stream' | 'poll' | 'paging') => {
    const ownership = errorOwnership.current;
    if (!ownership.writers.delete(writer)) return { clear: false as const };
    const reveal =
      ownership.stall ??
      ownership.writers.get('stream') ??
      ownership.writers.get('paging');
    return { clear: true as const, reveal };
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    cursorRef.current = undefined;
    pagedRef.current = false;
    pagedHeadRef.current = undefined;
    exhaustedRef.current = false;
    errorOwnership.current = { writers: new Map() };
    setLoadingOlder(false);
    setState({ sessionId, events: [], loading: Boolean(sessionId) });
    if (!sessionId) return () => abort.abort();
    const opts = { clientId, signal: abort.signal };
    const update = (change: Partial<ManagedSessionState>) => {
      if (!abort.signal.aborted)
        setState((current) => ({ ...current, ...change }));
    };
    const fail = (writer: 'stream' | 'poll', error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // The tag is only meaningful to the run that raised it: a superseded
      // run's late rejection must not book itself into the fresh ledger.
      if (!abort.signal.aborted)
        errorOwnership.current.writers.set(writer, message);
      update({ error: message, loading: false });
    };
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
        // items, duplicating them.
        const fullHistory = !empty && transcript.olderCursor === undefined;
        // The paged region abuts the window exactly when its top edge is
        // adjacent to it; only then may it stay — a retained region across
        // a hole would render two unrelated delta runs as one bubble.
        const contiguous =
          firstId !== undefined &&
          pagedHeadRef.current !== undefined &&
          pagedHeadRef.current >= firstId - 1;
        // The cursor must fetch below the oldest retained event; one
        // decision feeds both the fetch gate (cursorRef) and the affordance
        // (state.olderCursor). On a hole the window's own cursor is adopted
        // so the user can page the hole back.
        let nextCursor: string | undefined;
        if (fullHistory) {
          nextCursor = undefined;
          // The full history is already shown; a later raw-page gap can
          // re-open paging, so exhaustion does not survive.
          exhaustedRef.current = false;
        } else if (empty) nextCursor = cursorRef.current;
        else if (!pagedRef.current) nextCursor = transcript.olderCursor;
        else if (!contiguous) {
          // The hole is content exhaustion never covered: adopt the
          // window's cursor and let exhaustion re-derive from re-paging.
          nextCursor = transcript.olderCursor;
          exhaustedRef.current = false;
        } else if (!exhaustedRef.current)
          nextCursor = cursorRef.current ?? transcript.olderCursor;
        else nextCursor = cursorRef.current;
        cursorRef.current = nextCursor;
        errorOwnership.current.writers.clear();
        setState((current) => {
          const kept = empty
            ? current.events
            : current.events.filter((event) => {
                if (event.id > transcript.lastEventId) return true;
                if (event.id >= firstId) return false;
                // Older than the window: only events the user paged in
                // survive, only while the paged region abuts the window,
                // and item projections never do — the raw originals are
                // what the server stands behind after a retraction.
                return (
                  pagedRef.current &&
                  contiguous &&
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
        errorOwnership.current.writers.clear();
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
          fail('stream', error);
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
            onEstablished: () => {
              // A re-established stream can idle on heartbeats forever, so
              // neither an advancing event nor a completed pass may ever
              // come: establishment itself ends its failure's condition.
              if (abort.signal.aborted) return;
              const release = releaseError('stream');
              if (release.clear)
                setState((current) => ({
                  ...current,
                  error: release.reveal,
                }));
            },
          })) {
            if (abort.signal.aborted) return;
            if (event.type === 'stream_gap') {
              gap = true;
              break;
            }
            if (event.id <= lastEventId) continue;
            lastEventId = event.id;
            gapStalls = 0;
            errorOwnership.current.writers.clear();
            errorOwnership.current.stall = undefined;
            setState((current) => ({
              ...current,
              events: mergeManagedEvents(current.events, [event]),
              error: undefined,
            }));
          }
          if (gap) {
            const head = await snapshot(true);
            if (!abort.signal.aborted) {
              if (head > lastEventId) {
                lastEventId = head;
                gapStalls = 0;
                errorOwnership.current.writers.clear();
                errorOwnership.current.stall = undefined;
                retryDelayMs = 0;
              } else {
                // A resync that cannot advance the cursor replays its
                // trigger identically: slow to the normal cadence, and after
                // a few stalls surface an error instead of spinning. The
                // resync's setState clears error each pass, so re-assert on
                // every stall — that keeps the banner up for the whole stall
                // and clears a transient error once resyncs succeed again.
                gapStalls += 1;
                retryDelayMs = 3000;
                if (gapStalls >= 3) {
                  const stall =
                    'Managed Agent event stream is not advancing; retrying';
                  errorOwnership.current.stall = stall;
                  update({ error: stall, loading: false });
                }
              }
            }
          } else if (!abort.signal.aborted) {
            // Every success path must clear a previous transient failure,
            // or an idle session keeps the stale alert forever — but only
            // what its own writer raised: the poll's error belongs to the
            // poll, a paging error to loadOlder, and an armed stall alert
            // outlives this loop's clean passes.
            const summary = await provider.getSession(sessionId, opts);
            if (!abort.signal.aborted) {
              const release = releaseError('stream');
              setState((current) => ({
                ...current,
                summary,
                error: release.clear ? release.reveal : current.error,
              }));
            }
          }
        } catch (error) {
          fail('stream', error);
        }
        await pause(abort.signal, retryDelayMs);
      }
    })();
    void (async () => {
      while (!abort.signal.aborted) {
        await pause(abort.signal, 3000);
        if (abort.signal.aborted) return;
        try {
          const summary = await provider.getSession(sessionId, opts);
          // The poll's success releases only the poll's own error — an
          // identical message from the stream loop is not the poll's to
          // clear — and clearing the poll's banner reveals a stall alert
          // that is still armed.
          if (!abort.signal.aborted) {
            const release = releaseError('poll');
            setState((current) => ({
              ...current,
              summary,
              error: release.clear ? release.reveal : current.error,
            }));
          }
        } catch (error) {
          fail('poll', error);
        }
      }
    })();
    return () => abort.abort();
  }, [provider, clientId, sessionId, revision, releaseError]);

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
        const release = releaseError('paging');
        setState((current) => ({
          ...current,
          events: mergeManagedEvents(current.events, page.events),
          olderCursor: page.olderCursor,
          error: release.clear ? release.reveal : current.error,
        }));
      } catch (error) {
        if (abort.signal.aborted) return;
        if (cursorRef.current !== cursor) {
          // The cursor moved mid-flight (a gap resync): retry once on the
          // new cursor rather than swallowing the click silently.
          const moved = cursorRef.current;
          if (moved !== undefined && allowRetry) return fetchPage(moved, false);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        errorOwnership.current.writers.set('paging', message);
        setState((current) => ({
          ...current,
          error: message,
        }));
      }
    };
    try {
      await fetchPage(before, true);
    } finally {
      if (!abort.signal.aborted) setLoadingOlder(false);
    }
  }, [provider, clientId, sessionId, loadingOlder, releaseError]);
  const reload = useCallback(() => setRevision((current) => current + 1), []);
  const visible =
    state.sessionId === sessionId
      ? state
      : { events: [], loading: Boolean(sessionId) };
  return { ...visible, loadingOlder, loadOlder, reload };
}
