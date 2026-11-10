import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

/**
 * A one-shot "open this tool call" request, keyed by tool call id.
 *
 * The transcript is virtualized, so the tool group a caller wants to open may
 * not be mounted when the request is made: it mounts once the list scrolls to
 * it. The request therefore waits in this store until the group holding the
 * call consumes it, instead of being delivered to a DOM node that does not
 * exist yet.
 */
export interface ToolRevealStore {
  /** Ask the row for `callId` to expand. Replaces any earlier request. */
  request(callId: string): void;
  /** Drop a request that can no longer be served (e.g. the scroll failed). */
  cancel(callId: string): void;
  /**
   * The pending call id when `matches` accepts it; undefined otherwise. A
   * request keeps being served for a short grace period after the first
   * match, then clears.
   */
  consume(matches: (callId: string) => boolean): string | undefined;
  subscribe(listener: () => void): () => void;
  getVersion(): number;
}

/**
 * How long a request waits for its group to mount. The list scrolls to the
 * target right after the request; a group that shows up much later was
 * scrolled to by the user, who did not ask for it to open.
 */
const REVEAL_REQUEST_TTL_MS = 5_000;

/**
 * How long a served request keeps being served. Scrolling to a row can
 * unmount and remount it right after it first mounts (the virtualized list
 * re-measures), and the fresh instance must open too. A remount after this
 * is the user scrolling back, which keeps the row's own state.
 */
const REVEAL_REMOUNT_GRACE_MS = 1_000;

export function createToolRevealStore(
  now: () => number = Date.now,
): ToolRevealStore {
  let pending: string | undefined;
  let requestedAt = 0;
  let firstServedAt: number | undefined;
  let version = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    version += 1;
    for (const listener of listeners) listener();
  };
  return {
    request(callId) {
      pending = callId;
      requestedAt = now();
      firstServedAt = undefined;
      notify();
    },
    cancel(callId) {
      if (pending !== callId) return;
      pending = undefined;
      notify();
    },
    consume(matches) {
      const at = now();
      if (
        pending !== undefined &&
        (at - requestedAt > REVEAL_REQUEST_TTL_MS ||
          (firstServedAt !== undefined &&
            at - firstServedAt > REVEAL_REMOUNT_GRACE_MS))
      ) {
        pending = undefined;
      }
      if (pending === undefined || !matches(pending)) return undefined;
      firstServedAt ??= at;
      return pending;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getVersion: () => version,
  };
}

const ToolRevealContext = createContext<ToolRevealStore | undefined>(undefined);

export function ToolRevealProvider({
  store,
  children,
}: {
  store: ToolRevealStore;
  children: ReactNode;
}) {
  return (
    <ToolRevealContext.Provider value={store}>
      {children}
    </ToolRevealContext.Provider>
  );
}

const noopSubscribe = () => () => {};
const zeroVersion = () => 0;

/**
 * Calls `onReveal` with the requested call id when a reveal request names a
 * call `matches` accepts — right away when the consumer is already mounted,
 * or on mount when the request arrived first.
 */
export function useToolRevealRequest(
  matches: (callId: string) => boolean,
  onReveal: (callId: string) => void,
): void {
  const store = useContext(ToolRevealContext);
  const version = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getVersion ?? zeroVersion,
  );
  useEffect(() => {
    const callId = store?.consume(matches);
    if (callId !== undefined) onReveal(callId);
    // The callbacks are fresh closures every render; only a new request (or
    // a new store) is a reason to look again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, version]);
}
