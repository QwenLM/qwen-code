import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionEvent,
  ManagedAgentSessionSummary,
} from './managed-agent-provider';
import {
  isAuthFailure,
  isNonRetryableClientError,
} from './managed-request-error';
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
  // Paging state: whether any older page was ever loaded, the highest id any
  // page returned (the paged region's top edge), and whether the user paged
  // all the way to the beginning.
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
        // Mark the transcript leg so a caller can classify a definite
        // answer by which read it belongs to: a pruned history says
        // nothing about whether the session itself exists.
        provider
          .getTranscript(sessionId, { ...opts, limit: 100 })
          .catch((error: unknown) => {
            (error as Record<string, unknown>)['snapshotLeg'] = 'transcript';
            throw error;
          }),
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
            stoppedReason: undefined,
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
          stoppedReason: undefined,
        });
      }
      return transcript.lastEventId;
    };
    const stop = (error: unknown) =>
      update({
        stoppedReason: error instanceof Error ? error.message : String(error),
      });
    // A terminal (definite 4xx) answer: surface it transiently and stickily.
    // Callers return from their loop when this holds, unless they own a
    // retryable-in-principle retry that must outlive the classification.
    const failed = (error: unknown): boolean => {
      fail(error);
      if (isAuthFailure(error) || !isNonRetryableClientError(error))
        return false;
      stop(error);
      return true;
    };
    void (async () => {
      let lastEventId: number | undefined;
      let failures = 0;
      while (!abort.signal.aborted && lastEventId === undefined) {
        try {
          lastEventId = await snapshot(false);
          failures = 0;
        } catch (error) {
          // The transcript leg being definitively gone says nothing about
          // the session: record it stickily but keep retrying so the
          // stream starts as soon as the read recovers.
          if (
            (error as { snapshotLeg?: string }).snapshotLeg === 'transcript'
          ) {
            fail(error);
            if (!isAuthFailure(error) && isNonRetryableClientError(error))
              stop(error);
          } else if (failed(error)) return;
          await pause(abort.signal, failureRetryDelayMs(failures++));
        }
      }
      if (lastEventId === undefined || abort.signal.aborted) return;
      // The durable snapshot read has its own health: the stream can keep
      // delivering while it fails, so it climbs its own ladder instead of
      // being charged to (and zeroed by) the stream's counter.
      let snapshotFailures = 0;
      let gapStalls = 0;
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
            gapStalls = 0;
            setState((current) => ({
              ...current,
              events: mergeManagedEvents(current.events, [event]),
              error: undefined,
            }));
          }
          if (gap) {
            try {
              const head = await snapshot(true);
              snapshotFailures = 0;
              if (head > lastEventId) {
                lastEventId = head;
                gapStalls = 0;
              } else {
                // A resync that cannot advance the cursor replays its
                // trigger identically: slow to the normal cadence, and
                // after a few stalls surface an error instead of spinning.
                // The resync's setState clears error each pass, so re-assert
                // on every stall — that keeps the banner up for the whole
                // stall and clears a transient error once resyncs succeed
                // again.
                gapStalls += 1;
                delayMs = BASE_RETRY_DELAY_MS;
                if (gapStalls >= 3)
                  fail(
                    new Error(
                      'Managed Agent event stream is not advancing; retrying',
                    ),
                  );
              }
            } catch (error) {
              // A definite-4xx snapshot is recorded but must not kill a
              // live stream: the gap simply re-detects and the read climbs
              // its own ladder.
              failed(error);
              delayMs = failureRetryDelayMs(snapshotFailures++);
            }
          } else if (!abort.signal.aborted) {
            // Same policy as the gap branch: a definite answer from a
            // routine summary read is recorded, never a kill for a stream
            // that is otherwise healthy.
            try {
              update({
                summary: await provider.getSession(sessionId, opts),
                stoppedReason: undefined,
              });
            } catch (error) {
              failed(error);
            }
            delayMs = BASE_RETRY_DELAY_MS;
          }
          failures = 0;
        } catch (error) {
          if (failed(error)) return;
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
          // A definite answer is recorded (sticky through fail/stop) but
          // keeps this loop alive on its ladder: the summary that froze a
          // genuinely dead session stays retired only while no read ever
          // succeeds again, and a daemon restart or proxy blip heals.
          failed(error);
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
        if (abort.signal.aborted) return;
        if (cursorRef.current !== cursor) {
          // The cursor moved mid-flight (a gap resync): retry once on the
          // new cursor rather than swallowing the click silently.
          const moved = cursorRef.current;
          if (moved !== undefined && allowRetry) return fetchPage(moved, false);
          return;
        }
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
