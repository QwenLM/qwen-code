/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useDaemonHistoryNavigationStore } from '../daemon/session/DaemonSessionProvider';
import {
  transcriptBlocksToLocalizedMessages,
  type Translator,
} from '../adapters/localizedMessages';
import type { Message } from '../adapters/types';

export function useTranscriptViewport(liveMessages: Message[], t: Translator) {
  const store = useDaemonHistoryNavigationStore();
  const state = useSyncExternalStore(
    store.subscribe,
    store.getViewportSnapshot,
    store.getViewportSnapshot,
  );
  const navigation = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const viewportId = useId();
  const intent = useRef(0);
  const [view, setView] = useState<{
    revision: number;
    rangeId: string;
    liveBoundary?: string;
  }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const selecting = useRef(false);
  const boundaryLoading = useRef(false);
  const retryAction = useRef<
    { ordinal: number } | { direction: 'older' | 'newer' } | undefined
  >(undefined);
  const [target, setTarget] = useState<{ blockId: string; token: number }>();
  const pinnedPage = useRef<string | undefined>(undefined);
  const range =
    view?.revision === state.revision
      ? state.ranges.find((range) => range.id === view.rangeId)
      : undefined;
  const returnToLive = useCallback(() => {
    intent.current += 1;
    store.setViewportAnchor(viewportId);
    pinnedPage.current = undefined;
    selecting.current = false;
    boundaryLoading.current = false;
    setTarget(undefined);
    setView(undefined);
    setLoading(false);
    setError(false);
  }, [store, viewportId]);
  useEffect(() => {
    returnToLive();
    return () => {
      intent.current += 1;
      store.setViewportAnchor(viewportId);
    };
  }, [state.revision, store, viewportId, returnToLive]);

  const blocks = useMemo(
    () =>
      range?.pageIds.flatMap((id) => state.pages.get(id)?.blocks ?? []) ?? [],
    [range?.pageIds, state.pages],
  );
  const messages = useMemo(
    () =>
      transcriptBlocksToLocalizedMessages(blocks, t).map((message) => {
        if ('isStreaming' in message) return { ...message, isStreaming: false };
        return message;
      }),
    [blocks, t],
  );
  const toolSources = useMemo(() => {
    const sources = new Map<string, string>();
    for (const block of blocks) {
      if (block.kind === 'tool' && !sources.has(block.toolCallId))
        sources.set(block.toolCallId, block.id);
    }
    return sources;
  }, [blocks]);
  const pin = useCallback(
    (sourceBlockId?: string) => {
      const pageId = range?.pageIds.find((id) =>
        state.pages.get(id)?.blocks.some((block) => block.id === sourceBlockId),
      );
      if (pageId) {
        pinnedPage.current = pageId;
        store.setViewportAnchor(viewportId, pageId);
      }
    },
    [range?.pageIds, state.pages, store, viewportId],
  );

  const cancelSelection = useCallback(() => {
    setTarget(undefined);
    if (!selecting.current) return;
    intent.current += 1;
    selecting.current = false;
    setLoading(false);
    store.setViewportAnchor(viewportId, pinnedPage.current);
  }, [store, viewportId]);

  const selectOrdinal = useCallback(
    async (ordinal: number) => {
      retryAction.current = { ordinal };
      const token = ++intent.current;
      boundaryLoading.current = false;
      const revision = state.revision;
      const request = {
        isCurrent: () =>
          intent.current === token &&
          store.getViewportSnapshot().revision === revision,
      };
      selecting.current = true;
      setTarget(undefined);
      setLoading(true);
      setError(false);
      try {
        const provisional =
          navigation.provisionalTurns[ordinal - navigation.totalTurns];
        const location = provisional?.blockId
          ? { blockId: provisional.blockId, view: 'live' as const }
          : await store.locateViewportOrdinal(ordinal, request, () =>
              store.setViewportAnchor(viewportId),
            );
        if (!request.isCurrent()) return;
        if (location.view === 'historical') {
          if (
            !location.rangeId ||
            !store
              .getViewportSnapshot()
              .ranges.some((item) => item.id === location.rangeId)
          )
            throw new Error('History view expired');
          pinnedPage.current = location.pageId;
          store.setViewportAnchor(viewportId, location.pageId);
          setView({ revision, rangeId: location.rangeId });
        } else {
          pinnedPage.current = undefined;
          store.setViewportAnchor(viewportId);
          setView(undefined);
        }
        setTarget({ blockId: location.blockId, token });
      } catch {
        if (request.isCurrent()) {
          store.setViewportAnchor(viewportId, pinnedPage.current);
          setError(true);
        }
      } finally {
        if (request.isCurrent()) {
          selecting.current = false;
          setLoading(false);
        }
      }
    },
    [
      navigation.provisionalTurns,
      navigation.totalTurns,
      state.revision,
      store,
      viewportId,
    ],
  );

  const continueLive = useCallback(
    (blockId?: string) => {
      returnToLive();
      if (blockId) setTarget({ blockId, token: intent.current });
    },
    [returnToLive],
  );

  const load = useCallback(
    async (direction: 'older' | 'newer') => {
      if (loading || boundaryLoading.current || selecting.current || !range)
        return;
      boundaryLoading.current = true;
      retryAction.current = { direction };
      const token = ++intent.current;
      const liveBoundary = store.captureLiveBoundary();
      const revision = state.revision;
      const isCurrentIntent = () =>
        intent.current === token &&
        store.getViewportSnapshot().revision === revision;
      const request = { isCurrent: isCurrentIntent };
      setLoading(true);
      setError(false);
      try {
        let rangeId = range.id;
        const edge = range[direction];
        if (edge.kind === 'cached') rangeId = edge.rangeId;
        else await store.loadViewportBoundary(range.id, direction, request);
        if (!request.isCurrent()) throw new Error('History view changed');
        const admitted = store
          .getViewportSnapshot()
          .ranges.find((range) => range.id === rangeId);
        if (!admitted) throw new Error('History view expired');
        if (range?.id !== admitted.id) {
          store.setViewportAnchor(
            viewportId,
            direction === 'older'
              ? admitted.pageIds.at(-1)
              : admitted.pageIds[0],
          );
        }
        setView((previous) => ({
          revision,
          rangeId: admitted.id,
          liveBoundary:
            direction === 'newer' && admitted.newer.kind === 'live'
              ? liveBoundary.beforeRecordId
              : previous?.liveBoundary,
        }));
      } catch {
        if (isCurrentIntent()) setError(true);
      } finally {
        if (intent.current === token) {
          boundaryLoading.current = false;
          setLoading(false);
        }
      }
    },
    [loading, range, state.revision, store, viewportId],
  );

  const liveBoundary = store.captureLiveBoundary();
  return {
    navigation,
    store,
    target,
    selectOrdinal,
    cancelSelection,
    continueLive,
    messages: range ? messages : liveMessages,
    toolSources,
    historical: !!range,
    viewKey: range
      ? `${state.sessionId ?? ''}:${state.revision}:${range.id}`
      : `${state.sessionId ?? ''}:live`,
    range,
    loading,
    error,
    connected: state.connected,
    canContinueLive:
      !!range &&
      liveBoundary.reachable &&
      !!liveBoundary.beforeRecordId &&
      (store.hasLiveOverlap(range.id) ||
        liveBoundary.beforeRecordId === view?.liveBoundary),
    retry: () => {
      const action = retryAction.current;
      if (action)
        void ('ordinal' in action
          ? selectOrdinal(action.ordinal)
          : load(action.direction));
    },
    pin,
    load,
    returnToLive,
  };
}
