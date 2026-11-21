import { useCallback, useRef, useState } from 'react';
import {
  forgetAssistantFeedbackSessionPruned,
  readAssistantFeedbackStore,
  readPrunedAssistantFeedbackSession,
  setAssistantFeedbackRating,
  writeAssistantFeedbackStore,
  type AssistantFeedbackRating,
  type AssistantFeedbackStore,
} from '../utils/assistantFeedback';

const NO_RATINGS: Record<string, AssistantFeedbackRating> = {};

export interface UseAssistantFeedbackResult {
  /** Marks for the current session, keyed by turn prompt id. */
  ratings: Readonly<Record<string, AssistantFeedbackRating>>;
  /** Marks `promptId` with `rating`, or clears it when `rating` is null. */
  rate(promptId: string, rating: AssistantFeedbackRating | null): void;
  /** Current mark for a turn, for the host payload's `previousRating`. */
  ratingForTurn(
    promptId: string | undefined,
  ): AssistantFeedbackRating | undefined;
}

/**
 * Owns the satisfied / not-satisfied marks for one transcript.
 *
 * State lives here rather than in a message row because the transcript
 * virtualizes: a row that scrolls out is unmounted and rebuilt.
 */
export function useAssistantFeedback(
  sessionId: string | undefined,
): UseAssistantFeedbackResult {
  const [store, setStore] = useState<AssistantFeedbackStore>(
    readAssistantFeedbackStore,
  );
  const pendingChanges = useRef<
    Array<{
      sessionId: string;
      turnId: string;
      rating: AssistantFeedbackRating | null;
      base: AssistantFeedbackRating | undefined;
    }>
  >([]);
  const storeRef = useRef(store);
  storeRef.current = store;

  const rate = useCallback(
    (turnId: string, rating: AssistantFeedbackRating | null) => {
      if (!sessionId || !turnId) return;
      setStore((current) =>
        setAssistantFeedbackRating(current, sessionId, turnId, rating),
      );
      let next = readAssistantFeedbackStore();
      pendingChanges.current = pendingChanges.current.filter(
        (change) => change.sessionId !== sessionId || change.turnId !== turnId,
      );
      pendingChanges.current.push({
        sessionId,
        turnId,
        rating,
        base: next[sessionId]?.[turnId],
      });
      // Replay this pane's uncommitted edits on the latest storage. Restore
      // the ratings only when a successful write actually pruned the session.
      const persisted = next;
      const pruned = readPrunedAssistantFeedbackSession(sessionId);
      if (pruned && !next[sessionId]) {
        next = { ...next, [sessionId]: { ...pruned } };
      }
      for (const change of pendingChanges.current) {
        if (persisted[change.sessionId]?.[change.turnId] !== change.base) {
          continue;
        }
        next = setAssistantFeedbackRating(
          next,
          change.sessionId,
          change.turnId,
          change.rating,
        );
      }
      if (writeAssistantFeedbackStore(next)) {
        pendingChanges.current = [];
        if (!next[sessionId]) forgetAssistantFeedbackSessionPruned(sessionId);
        setStore(next);
      }
    },
    [sessionId],
  );

  const ratingForTurn = useCallback(
    (turnId: string | undefined) =>
      sessionId && turnId ? storeRef.current[sessionId]?.[turnId] : undefined,
    [sessionId],
  );

  return {
    ratings: (sessionId && store[sessionId]) || NO_RATINGS,
    rate,
    ratingForTurn,
  };
}
