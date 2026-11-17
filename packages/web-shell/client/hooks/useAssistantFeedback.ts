import { useCallback, useEffect, useRef, useState } from 'react';
import {
  readAssistantFeedbackStore,
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
  // Hydrating is not an edit, so the first render must not write back.
  const hydratedStore = useRef(store);
  const storeRef = useRef(store);
  storeRef.current = store;

  const rate = useCallback(
    (turnId: string, rating: AssistantFeedbackRating | null) => {
      if (!sessionId || !turnId) return;
      setStore((current) =>
        setAssistantFeedbackRating(current, sessionId, turnId, rating),
      );
    },
    [sessionId],
  );

  const ratingForTurn = useCallback(
    (turnId: string | undefined) =>
      sessionId && turnId ? storeRef.current[sessionId]?.[turnId] : undefined,
    [sessionId],
  );

  useEffect(() => {
    if (store === hydratedStore.current) return;
    writeAssistantFeedbackStore(store);
  }, [store]);

  return {
    ratings: (sessionId && store[sessionId]) || NO_RATINGS,
    rate,
    ratingForTurn,
  };
}
