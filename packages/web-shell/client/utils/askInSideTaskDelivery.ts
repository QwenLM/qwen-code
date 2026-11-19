/**
 * Race-free handoff of an "Ask in side task" quote between two independent
 * effects:
 *
 * - the side-task pane's dispatch effect requests the quote once the child
 *   session is connected and its transcript settled empty;
 * - the pane's chat surface registers its composer quote insertion once the
 *   editor is mounted.
 *
 * The two run in no guaranteed order, so each side parks its half of the
 * pair per session and the first side to arrive settles it. A session that
 * already settled (or was requested) never fires a second chip, so pane
 * remounts and effect re-runs cannot duplicate the quote.
 */

interface AskInSideTaskPending {
  insert?: (text: string) => void;
  quote?: string;
}

const pendingBySession = new Map<string, AskInSideTaskPending>();
const deliveredSessions = new Set<string>();

function settle(sessionId: string, entry: AskInSideTaskPending): boolean {
  const { insert, quote } = entry;
  if (!insert || !quote) return false;
  pendingBySession.delete(sessionId);
  insert(quote);
  return true;
}

/** The pane's composer can accept a quote chip for `sessionId`. */
export function registerAskInSideTaskInsert(
  sessionId: string,
  insert: (text: string) => void,
): void {
  if (!sessionId) return;
  let entry = pendingBySession.get(sessionId);
  if (!entry) {
    entry = {};
    pendingBySession.set(sessionId, entry);
  }
  entry.insert = insert;
  settle(sessionId, entry);
}

/**
 * The pane is ready to receive the quote. Marks the session delivered up
 * front, so a later re-run (or a remounted effect) never re-requests it.
 */
export function requestAskInSideTaskQuote(
  sessionId: string,
  quote: string,
): void {
  if (!sessionId || deliveredSessions.has(sessionId)) return;
  deliveredSessions.add(sessionId);
  let entry = pendingBySession.get(sessionId);
  if (!entry) {
    entry = {};
    pendingBySession.set(sessionId, entry);
  }
  entry.quote = quote;
  settle(sessionId, entry);
}

/** Test-only: forgets every parked half and delivered marker. */
export function resetAskInSideTaskDeliveryForTests(): void {
  pendingBySession.clear();
  deliveredSessions.clear();
}
