/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react';
import {
  MessageList,
  type MessageListHandle,
  type MessageListProps,
} from './MessageList';
import { Button } from './ui/button';
import { useTranscriptViewport } from '../hooks/useTranscriptViewport';
import { useI18n } from '../i18n';

interface ReadingAnchor {
  source: string;
  rowKey?: string;
  offset: number;
  callId?: string;
}

export const TranscriptViewport = forwardRef<
  MessageListHandle,
  MessageListProps
>(function TranscriptViewport(props, ref) {
  const { onCanScrollToBottomChange } = props;
  const { t } = useI18n();
  const viewport = useTranscriptViewport(props.messages, t);
  const {
    historical,
    loading,
    returnToLive,
    messages,
    viewKey,
    pin,
    toolSources,
  } = viewport;
  const unavailable =
    viewport.enabled &&
    !historical &&
    !viewport.canOpen &&
    !props.loadingTranscript &&
    (props.hasOlderHistory ||
      props.historyCapacityReached ||
      props.historyPaginationError);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<MessageListHandle>(null);
  const anchor = useRef<ReadingAnchor | undefined>(undefined);
  const entryDirection = useRef<'older' | 'newer'>('older');
  const lastView = useRef(viewport.viewKey);
  const scrollIntent = useRef(0);
  const restoring = useRef(false);
  useLayoutEffect(() => {
    if (historical) onCanScrollToBottomChange?.(false);
  }, [historical, onCanScrollToBottomChange]);
  const scroller = useCallback(
    () =>
      root.current?.querySelector<HTMLElement>('[data-web-shell-message-list]'),
    [],
  );
  const rows = useCallback(
    () => [
      ...(root.current?.querySelectorAll<HTMLElement>(
        '[data-source-block-ids]',
      ) ?? []),
    ],
    [],
  );
  const capture = useCallback(() => {
    const scroll = scroller();
    if (!scroll || !historical) return undefined;
    const top = scroll.getBoundingClientRect().top;
    let row = rows().find(
      (row) =>
        row.getBoundingClientRect().bottom > top &&
        row.getBoundingClientRect().top < top + scroll.clientHeight,
    );
    let source = row?.dataset.sourceBlockIds?.split(',')[0];
    const rowKey = row?.dataset.messageRowKey;
    let callId: string | undefined;
    if (row && row.getBoundingClientRect().top < top) {
      const child = [
        ...row.querySelectorAll<HTMLElement>('[data-transcript-tool-call-id]'),
      ].find((child) => {
        const rect = child.getBoundingClientRect();
        return (
          rect.height > 0 &&
          rect.bottom > top &&
          rect.top < top + scroll.clientHeight &&
          toolSources.has(child.dataset.transcriptToolCallId!)
        );
      });
      if (child) {
        row = child;
        callId = child.dataset.transcriptToolCallId;
        source = toolSources.get(callId!);
      }
    }
    if (!source || !row) return undefined;
    pin(source);
    return {
      source,
      rowKey,
      callId,
      offset: row.getBoundingClientRect().top - top,
    };
  }, [historical, pin, rows, scroller, toolSources]);
  useImperativeHandle(
    ref,
    () => ({
      scrollToMessage: (id, callId) =>
        list.current?.scrollToMessage(id, callId) ?? false,
      scrollToBottom: (behavior) => {
        if (historical || loading) returnToLive();
        else list.current?.scrollToBottom(behavior);
      },
    }),
    [historical, loading, returnToLive],
  );

  useLayoutEffect(() => {
    const changedView = lastView.current !== viewKey;
    lastView.current = viewKey;
    if (changedView) anchor.current = undefined;
    if (!historical) return;
    restoring.current = true;
    let frame = 0;
    let remaining = 8;
    const intent = scrollIntent.current;
    const restore = () => {
      if (intent !== scrollIntent.current) return;
      const scroll = scroller();
      if (!scroll) return;
      const saved = anchor.current;
      if (saved) {
        const child = saved.callId
          ? [
              ...(root.current?.querySelectorAll<HTMLElement>(
                '[data-transcript-tool-call-id]',
              ) ?? []),
            ].find(
              (child) =>
                child.dataset.transcriptToolCallId === saved.callId &&
                child.getBoundingClientRect().height > 0,
            )
          : undefined;
        const row =
          child ??
          (saved.rowKey
            ? rows().find((row) => row.dataset.messageRowKey === saved.rowKey)
            : undefined) ??
          rows().find((row) =>
            row.dataset.sourceBlockIds?.split(',').includes(saved.source),
          );
        if (row)
          scroll.scrollTop +=
            row.getBoundingClientRect().top -
            scroll.getBoundingClientRect().top -
            saved.offset;
        else {
          const message = messages.find((message) =>
            message.sourceBlockIds?.includes(saved.source),
          );
          if (message) list.current?.scrollToMessage(message.id, saved.callId);
        }
      } else if (changedView) {
        scroll.scrollTop =
          entryDirection.current === 'newer' ? 0 : scroll.scrollHeight;
      }
      capture();
      if (--remaining > 0) frame = requestAnimationFrame(restore);
      else {
        anchor.current = undefined;
        restoring.current = false;
      }
    };
    restore();
    return () => {
      cancelAnimationFrame(frame);
      restoring.current = false;
    };
  }, [messages, viewKey, historical, capture, rows, scroller]);

  const load = (direction: 'older' | 'newer') => {
    anchor.current = capture();
    entryDirection.current = direction;
    void viewport.load(direction);
  };
  const handleScrollIntent = () => {
    scrollIntent.current += 1;
    if (!loading) anchor.current = undefined;
    restoring.current = false;
  };
  const boundaryButton = (direction: 'older' | 'newer') => {
    const boundary = viewport.range?.[direction];
    if (!boundary || boundary.kind === 'end') return null;
    if (boundary.kind === 'live' && !viewport.canContinueLive) return null;
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled={
          viewport.loading ||
          !viewport.connected ||
          (boundary.kind === 'error' && !boundary.retryable)
        }
        onClick={() => load(direction)}
      >
        {t(direction === 'older' ? 'history.loadEarlier' : 'history.loadNewer')}
      </Button>
    );
  };

  return (
    <div
      ref={root}
      className="flex min-h-0 flex-1 flex-col"
      onWheelCapture={handleScrollIntent}
      onPointerDownCapture={handleScrollIntent}
      onKeyDownCapture={handleScrollIntent}
      onScrollCapture={() => {
        if (restoring.current) return;
        const current = capture();
        if (viewport.loading) anchor.current = current;
      }}
      data-history-viewport={viewport.historical ? 'historical' : 'live'}
    >
      {(viewport.historical ||
        viewport.canOpen ||
        viewport.loading ||
        viewport.error ||
        unavailable) && (
        <div className="flex flex-wrap items-center justify-center gap-2 border-b bg-background p-2 text-sm text-muted-foreground">
          {viewport.historical ? (
            <>
              <span>{t('history.snapshotView')}</span>
              {boundaryButton('older')}
              <Button
                variant="outline"
                size="sm"
                onClick={viewport.returnToLive}
              >
                {t('history.returnLatest')}
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={viewport.loading || !viewport.canOpen}
              onClick={() => load('older')}
            >
              {t('history.openEarlier')}
            </Button>
          )}
          {viewport.loading && (
            <span role="status">{t('history.loadingEarlier')}</span>
          )}
          {viewport.error && <span role="alert">{t('history.viewError')}</span>}
          {unavailable && (
            <span role="status">{t('history.viewUnavailable')}</span>
          )}
        </div>
      )}
      <MessageList
        {...props}
        key={viewport.viewKey}
        ref={list}
        messages={viewport.messages}
        {...(viewport.enabled
          ? {
              hasOlderHistory: false,
              onLoadOlderHistory: undefined,
              historyCapacityReached: false,
              historyPaginationError: false,
              loadingOlderHistory: false,
            }
          : {})}
        {...(viewport.historical
          ? {
              frozenViewport: true,
              onCanScrollToBottomChange: undefined,
              hideSessionTimeline: true,
              firstTurnMetrics: undefined,
              sessionKey: viewport.viewKey,
              pendingApproval: null,
              loadingTranscript: false,
              catchingUp: false,
              isResponding: false,
              transcriptActivity: undefined,
              onReloadTranscript: undefined,
              transcriptReloadPaused: true,
              onEditUserMessage: undefined,
              onShowContextDetail: undefined,
              onBranchSession: undefined,
              onRetryClick: undefined,
              onRetryFailedPrompt: undefined,
              showRetryHint: false,
              failedPromptMessageId: undefined,
              tailContent: undefined,
              welcomeHeader: undefined,
              activeTurnStartedAt: undefined,
              turnFileChanges: undefined,
              turnArtifacts: undefined,
              turnScheduledTasks: undefined,
              generateContent: undefined,
            }
          : {})}
      />
      {viewport.historical && (
        <div className="flex justify-center gap-2 border-t bg-background p-2">
          {boundaryButton('newer')}
          <Button variant="ghost" size="sm" onClick={viewport.returnToLive}>
            {t('history.returnLatest')}
          </Button>
        </div>
      )}
    </div>
  );
});
