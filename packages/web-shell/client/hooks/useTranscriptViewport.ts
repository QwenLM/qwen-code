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
  const [view, setView] = useState<{ revision: number; rangeId: string }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const range =
    view?.revision === state.revision
      ? state.ranges.find((range) => range.id === view.rangeId)
      : undefined;
  const returnToLive = useCallback(() => {
    intent.current += 1;
    store.setViewportAnchor(viewportId);
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
      if (pageId) store.setViewportAnchor(viewportId, pageId);
    },
    [range?.pageIds, state.pages, store, viewportId],
  );

  const load = useCallback(
    async (direction: 'older' | 'newer') => {
      if (loading) return;
      const token = ++intent.current;
      const revision = state.revision;
      const boundary = store.captureLiveBoundary();
      const isCurrentIntent = () =>
        intent.current === token &&
        store.getViewportSnapshot().revision === revision;
      const request = {
        isCurrent: () =>
          isCurrentIntent() &&
          (range !== undefined || boundary.isCurrent()),
      };
      setLoading(true);
      setError(false);
      try {
        let rangeId = range?.id;
        if (!range) {
          if (!boundary.reachable || !boundary.beforeRecordId)
            throw new Error('History boundary unavailable');
          rangeId = await store.openBeforeLive(
            boundary.beforeRecordId,
            request,
          );
        } else {
          const edge = range[direction];
          if (edge.kind === 'cached') rangeId = edge.rangeId;
          else await store.loadViewportBoundary(range.id, direction, request);
        }
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
        setView({ revision, rangeId: admitted.id });
      } catch {
        if (isCurrentIntent()) setError(true);
      } finally {
        if (intent.current === token) setLoading(false);
      }
    },
    [loading, range, state.revision, store, viewportId],
  );

  const liveBoundary = store.captureLiveBoundary();
  const available =
    navigation.mode === 'ready' || navigation.mode === 'loading';
  return {
    messages: range ? messages : liveMessages,
    toolSources,
    historical: !!range,
    viewKey: range
      ? `${state.sessionId ?? ''}:${state.revision}:${range.id}`
      : `${state.sessionId ?? ''}:live`,
    range,
    loading,
    error,
    enabled: !!range || (available && !!liveBoundary.beforeRecordId),
    canOpen:
      available &&
      state.connected &&
      liveBoundary.reachable &&
      !!liveBoundary.beforeRecordId,
    connected: state.connected,
    canContinueLive:
      !!range &&
      'beforeRecordId' in range &&
      !store.hasLiveOverlap(range.id) &&
      liveBoundary.reachable &&
      liveBoundary.beforeRecordId !== range.beforeRecordId,
    pin,
    load,
    returnToLive,
  };
}
