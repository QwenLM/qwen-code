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

type SignalLeg = 'session' | 'transcript' | 'stream';

interface SignalEntry {
  readonly message: string;
  readonly final: boolean;
  readonly seq: number;
  readonly leg: SignalLeg;
  readonly stall?: boolean;
}

class SnapshotLegError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(
    readonly leg: 'session' | 'transcript',
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    const forwarded = cause as { status?: unknown; code?: unknown };
    this.status =
      typeof forwarded.status === 'number' ? forwarded.status : undefined;
    this.code = typeof forwarded.code === 'string' ? forwarded.code : undefined;
  }
}

// The "stream is not advancing" warning: the one stream record an
// error-free answer may not expire. A connection that stays open but never
// delivers is exactly the condition it describes, so only an advancing
// stream (retire) clears it.
class StreamStallError extends Error {}

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
  // One signal per answer authority. A failure writes into its own leg's
  // slot; only a later success by that same leg clears it — a live stream
  // cannot certify history and a summary read cannot certify the event log.
  signals?: Partial<Record<SignalLeg, SignalEntry>>;
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
  // Whether any loop ended terminally on a session-leg answer; a later
  // session-leg success re-arms the whole effect instead of leaving a
  // silent dead loop next to a live summary.
  const endedRef = useRef(false);
  const seqRef = useRef(0);
  // Synchronous mirror of the stream leg's standing terminal verdict: the
  // proof-of-life timer reads it at fire time, which a state updater (run
  // at React's flush) could miss when the attempt fails right after the
  // expiry.
  const streamVerdictMessageRef = useRef<string | undefined>(undefined);
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
    endedRef.current = false;
    seqRef.current = 0;
    streamVerdictMessageRef.current = undefined;
    setLoadingOlder(false);
    setState({ sessionId, events: [], loading: Boolean(sessionId) });
    if (!sessionId) return () => abort.abort();
    const opts = { clientId, signal: abort.signal };
    const update = (change: Partial<ManagedSessionState>) => {
      if (!abort.signal.aborted)
        setState((current) => ({ ...current, ...change }));
    };
    const record = (leg: SignalLeg, error: unknown, final: boolean) => {
      if (abort.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      if (leg === 'stream' && final) streamVerdictMessageRef.current = message;
      setState((current) => {
        const previous = current.signals?.[leg];
        // A standing terminal verdict leaves only through retire(): a
        // weaker later failure on the same leg must not downgrade it.
        if (previous?.final && !final) return current;
        return {
          ...current,
          // Every recorded failure is also the end of any in-flight read;
          // the success paths clear the flag on theirs.
          loading: false,
          signals: {
            ...(current.signals ?? {}),
            [leg]: {
              leg,
              message,
              final,
              seq: ++seqRef.current,
              stall: error instanceof StreamStallError,
            },
          },
        };
      });
    };
    const fail = (leg: SignalLeg, error: unknown) => record(leg, error, false);
    const stop = (leg: SignalLeg, error: unknown) => record(leg, error, true);
    // A terminal (definite 4xx) answer: record it transiently, and as a
    // final verdict when it is one — never terminal because a different
    // endpoint also failed.
    const failed = (error: unknown, leg: SignalLeg): boolean => {
      fail(leg, error);
      if (isAuthFailure(error) || !isNonRetryableClientError(error))
        return false;
      stop(leg, error);
      return true;
    };
    // A successful read retires its own leg's records; a session-leg
    // success also restarts loops that ended terminally.
    const retire = (leg: SignalLeg) => {
      if (abort.signal.aborted) return;
      if (leg === 'stream') streamVerdictMessageRef.current = undefined;
      setState((current) => {
        if (!current.signals?.[leg]) return current;
        const signals = { ...current.signals };
        delete signals[leg];
        return { ...current, signals };
      });
      if (leg === 'session' && endedRef.current) {
        endedRef.current = false;
        setRevision((value) => value + 1);
      }
    };
    // A terminal record expires only on its own leg's success evidence;
    // transient records on that leg are left alone.
    const expireFinal = (leg: SignalLeg) => {
      if (abort.signal.aborted) return;
      if (leg === 'stream') streamVerdictMessageRef.current = undefined;
      setState((current) => {
        if (!current.signals?.[leg]?.final) return current;
        const signals = { ...current.signals };
        delete signals[leg];
        return { ...current, signals };
      });
    };
    // An error-free answer is the leg's own success evidence and expires
    // whatever the leg had standing, terminal or transient — except the
    // stall warning, which describes exactly that condition and so leaves
    // only through an advancing stream (retire).
    const expireAnswered = (leg: SignalLeg) => {
      if (abort.signal.aborted) return;
      if (leg === 'stream') streamVerdictMessageRef.current = undefined;
      setState((current) => {
        const entry = current.signals?.[leg];
        if (!entry || entry.stall) return current;
        const signals = { ...current.signals };
        delete signals[leg];
        return { ...current, signals };
      });
    };
    const snapshot = async (preserveLoadedPages: boolean) => {
      // Settle both legs first, then classify the session leg's own answer
      // before the transcript leg's: whether the bootstrap terminates for a
      // gone session is decided by the answer, not by response ordering.
      const [sessionRead, transcriptRead] = await Promise.allSettled([
        provider.getSession(sessionId, opts),
        provider.getTranscript(sessionId, { ...opts, limit: 100 }),
      ]);
      if (sessionRead.status === 'rejected') {
        // A fulfilled transcript read is that leg's own success evidence:
        // retire its stale verdict before the throw discards the read.
        if (transcriptRead.status === 'fulfilled') retire('transcript');
        throw new SnapshotLegError('session', sessionRead.reason);
      }
      if (transcriptRead.status === 'rejected')
        throw new SnapshotLegError('transcript', transcriptRead.reason);
      const summary = sessionRead.value;
      const transcript = transcriptRead.value;
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
          };
        });
        retire('session');
        retire('transcript');
      } else {
        cursorRef.current = transcript.olderCursor;
        update({
          summary,
          events: transcript.events,
          olderCursor: transcript.olderCursor,
          loading: false,
        });
        retire('session');
        retire('transcript');
      }
      return transcript.lastEventId;
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
          if (error instanceof SnapshotLegError && error.leg === 'transcript') {
            fail('transcript', error);
            if (!isAuthFailure(error) && isNonRetryableClientError(error))
              stop('transcript', error);
          } else if (failed(error, 'session')) {
            endedRef.current = true;
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
      let gapStalls = 0;
      while (!abort.signal.aborted) {
        let gap = false;
        let delayMs = 0;
        let delivered = false;
        // Set when the proof-of-life timer below expires a terminal verdict
        // while this attempt is still in flight: the removal stands only if
        // the attempt goes on to answer error-free, so a throw restores it.
        let expiredVerdictMessage: string | undefined;
        const connectedAt = Date.now();
        // The same duration that certifies a connection for the backoff
        // ladder below (a throw before it stretches the rung) also
        // certifies the stream leg itself: an answer that stays error-free
        // this long retires the leg's records — even when no new frame ever
        // arrives to retire them. A failed attempt is no such answer: the
        // catch below restores a verdict this removed.
        const proofOfLife = setTimeout(() => {
          // Capture from the mirror synchronously: the state update runs
          // at React's flush, which an attempt failing right after the
          // expiry would beat to the catch.
          expiredVerdictMessage = streamVerdictMessageRef.current;
          expireAnswered('stream');
        }, BASE_RETRY_DELAY_MS);
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
            // A genuinely new frame is the stream certifying itself: it
            // retires the stream leg's records, and the live delivery
            // refutes whatever the transcript leg had standing. Replays and
            // gap frames do not count — only data the loop had not seen
            // before does.
            expiredVerdictMessage = undefined;
            retire('stream');
            retire('transcript');
            setState((current) => ({
              ...current,
              events: mergeManagedEvents(current.events, [event]),
            }));
          }
          if (gap) {
            try {
              const head = await snapshot(true);
              snapshotFailures = 0;
              if (head > lastEventId) {
                lastEventId = head;
                gapStalls = 0;
                retire('stream');
              } else {
                // A resync that cannot advance the cursor replays its
                // trigger identically: slow to the normal cadence, and
                // after a few stalls surface an error instead of spinning.
                // The stream answered and the durable read fulfilled, so a
                // terminal stream verdict cannot survive it — expire it
                // first, or the monotonicity guard would block the stall
                // warning below too. The stall record lives in the stream
                // leg's own slot, so re-asserting on every stall keeps the
                // banner up for the whole stall, and a resync that advances
                // the cursor retires it.
                expireFinal('stream');
                gapStalls += 1;
                delayMs = BASE_RETRY_DELAY_MS;
                if (gapStalls >= 3)
                  failed(
                    new StreamStallError(
                      'Managed Agent event stream is not advancing; retrying',
                    ),
                    'stream',
                  );
              }
            } catch (error) {
              // A definite-4xx snapshot is recorded but must not kill a
              // live stream: the gap simply re-detects and the read climbs
              // its own ladder.
              failed(
                error,
                error instanceof SnapshotLegError ? error.leg : 'session',
              );
              delayMs = failureRetryDelayMs(snapshotFailures++);
            }
          } else if (!abort.signal.aborted) {
            // An error-free completion is the stream leg's own success
            // evidence even when it carried nothing new: a standing
            // verdict or a transient failure on the leg cannot survive it.
            expireAnswered('stream');
            // Same policy as the gap branch: a definite answer from a
            // routine summary read is recorded, never a kill for a stream
            // that is otherwise healthy; its success retires session-leg
            // verdicts.
            try {
              update({ summary: await provider.getSession(sessionId, opts) });
              retire('session');
            } catch (error) {
              failed(error, 'session');
            }
            delayMs = BASE_RETRY_DELAY_MS;
          }
          failures = 0;
        } catch (error) {
          // A failed attempt is not the success the proof-of-life timer
          // credited: restore a terminal verdict it removed while the
          // attempt was still failing, so the weaker write below meets the
          // monotonicity guard and cannot permanently replace it.
          if (expiredVerdictMessage !== undefined) {
            stop('stream', expiredVerdictMessage);
            expiredVerdictMessage = undefined;
          }
          // The event log's own answer is a stream-leg verdict and is
          // recorded rather than killing the loop outright: reconnects keep
          // coming on the ladder, and an advancing resync retires it.
          failed(error, 'stream');
          // Any delivered frame, or a connection that simply lived long
          // enough, proves the path healthy; only back-to-back failures
          // with nothing delivered should stretch the ladder.
          if (delivered || Date.now() - connectedAt >= BASE_RETRY_DELAY_MS)
            failures = 0;
          delayMs = failureRetryDelayMs(failures++);
        } finally {
          clearTimeout(proofOfLife);
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
          retire('session');
          failures = 0;
        } catch (error) {
          // A definite answer is recorded (sticky through fail/stop) but
          // keeps this loop alive on its ladder: the summary that froze a
          // genuinely dead session stays retired only while no read ever
          // succeeds again, and a daemon restart or proxy blip heals.
          failed(error, 'session');
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
          ...(current.signals?.transcript
            ? {
                signals: (() => {
                  const rest = { ...current.signals };
                  delete rest.transcript;
                  return rest;
                })(),
              }
            : {}),
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
        // A failed click is a transcript-leg read failing; record it on
        // that leg with the monotonicity guard the effect's record()
        // applies (this callback lives outside the effect closure, so it
        // mirrors the guarded write rather than calling it). A click stays
        // transient even on a definite 4xx: it is one-off evidence with no
        // ladder asking again to confirm terminality — a genuinely gone
        // session is certified by the poll loop, while a failover 404 on a
        // live session must not stick as a terminal verdict. The guard
        // still keeps anything weaker from downgrading a standing one, and
        // the next page or resync success retires it.
        const message = error instanceof Error ? error.message : String(error);
        setState((current) => {
          if (current.signals?.transcript?.final) return current;
          return {
            ...current,
            signals: {
              ...(current.signals ?? {}),
              transcript: {
                leg: 'transcript',
                message,
                final: false,
                seq: ++seqRef.current,
              },
            },
          };
        });
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
  const entries = Object.values(visible.signals ?? {});
  // The displayed sticky is the standing verdict of the most specific
  // authority that currently has one: a blip on a less specific leg never
  // displaces it — it leaves only when its own leg heals (or a more
  // specific authority also goes terminal).
  const standing = (['stream', 'transcript', 'session'] as const)
    .map((leg) => entries.find((entry) => entry.final && entry.leg === leg))
    .find((entry) => entry !== undefined);
  const newest = entries.sort((a, b) => b.seq - a.seq)[0];
  return {
    ...visible,
    stoppedReason: standing?.message,
    stoppedLeg: standing?.leg,
    error: newest?.final ? undefined : newest?.message,
    loadingOlder,
    loadOlder,
    reload,
  };
}
