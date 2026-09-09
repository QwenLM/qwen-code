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
import { GlobalTurnNavigation } from './GlobalTurnNavigation';
import styles from './TranscriptViewport.module.css';
import { useTranscriptViewport } from '../hooks/useTranscriptViewport';
import { useChatNavigationVisible } from '../hooks/useChatNavigationVisible';
import { useI18n } from '../i18n';
import { SESSION_TIMELINE_MIN_VISIBLE_ENTRIES } from '../constants/sessions';

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
  const globalNavigation =
    !props.hideSessionTimeline &&
    (viewport.navigation.mode === 'ready' ||
      viewport.navigation.mode === 'loading') &&
    viewport.navigation.effectiveTurnCount >=
      SESSION_TIMELINE_MIN_VISIBLE_ENTRIES;
  const root = useRef<HTMLDivElement>(null);
  const navigationVisible = useChatNavigationVisible(root, globalNavigation);
  const list = useRef<MessageListHandle>(null);
  const anchor = useRef<ReadingAnchor | undefined>(undefined);
  const entryDirection = useRef<'older' | 'newer'>('older');
  const lastView = useRef(viewport.viewKey);
  const lastMessages = useRef(messages);
  const appliedTarget = useRef<number | undefined>(undefined);
  const scrollIntent = useRef(0);
  const restoring = useRef(false);
  const loadFrame = useRef<number | undefined>(undefined);
  useLayoutEffect(
    () => () => {
      if (loadFrame.current !== undefined)
        cancelAnimationFrame(loadFrame.current);
      loadFrame.current = undefined;
    },
    [viewKey],
  );
  useLayoutEffect(() => {
    if (historical || loading) onCanScrollToBottomChange?.(true);
  }, [historical, loading, onCanScrollToBottomChange]);
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
        if (!historical) list.current?.scrollToBottom(behavior);
      },
    }),
    [historical, loading, returnToLive],
  );

  useLayoutEffect(() => {
    const changedView = lastView.current !== viewKey;
    const changedMessages = lastMessages.current !== messages;
    lastMessages.current = messages;
    lastView.current = viewKey;
    const targetBlockId =
      viewport.target?.token !== appliedTarget.current
        ? viewport.target?.blockId
        : undefined;
    appliedTarget.current = viewport.target?.token;
    if (!changedView && !changedMessages && !targetBlockId) return;
    if (changedView) anchor.current = undefined;
    if (!historical && !targetBlockId) return;
    restoring.current = true;
    let frame = 0;
    let remaining = 8;
    const intent = scrollIntent.current;
    const restore = () => {
      if (intent !== scrollIntent.current) return;
      const scroll = scroller();
      if (!scroll) return;
      const saved = anchor.current;
      const target =
        targetBlockId &&
        messages.find((message) =>
          message.sourceBlockIds?.includes(targetBlockId),
        );
      if (target) {
        list.current?.scrollToMessage(target.id);
      } else if (saved) {
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
  }, [messages, viewKey, historical, viewport.target, capture, rows, scroller]);

  const load = (direction: 'older' | 'newer') => {
    if (loadFrame.current !== undefined) return;
    const intent = scrollIntent.current;
    let remaining = 8;
    const loadWhenVisible = () => {
      loadFrame.current = undefined;
      if (intent !== scrollIntent.current) return;
      const saved = capture();
      // A scroll event can arrive before the virtualized rows mount. Loading
      // without an anchor would leave no reading position to restore.
      if (!saved) {
        if (--remaining > 0)
          loadFrame.current = requestAnimationFrame(loadWhenVisible);
        return;
      }
      anchor.current = saved;
      entryDirection.current = direction;
      void viewport.load(direction);
    };
    loadWhenVisible();
  };
  const handleScrollIntent = () => {
    scrollIntent.current += 1;
    if (loadFrame.current !== undefined)
      cancelAnimationFrame(loadFrame.current);
    loadFrame.current = undefined;
    viewport.cancelSelection();
    if (!loading) anchor.current = undefined;
    restoring.current = false;
  };
  const loadAtEdge = (direction?: 'older' | 'newer') => {
    const scroll = scroller();
    if (
      !historical ||
      !viewport.connected ||
      !scroll ||
      loading ||
      viewport.error ||
      restoring.current
    )
      return;
    const edge = direction ?? (scroll.scrollTop < 200 ? 'older' : 'newer');
    if (
      edge === 'older'
        ? scroll.scrollTop >= 200
        : scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop >= 200
    )
      return;
    const boundary = viewport.range?.[edge];
    if (boundary?.kind === 'live' && !viewport.canContinueLive) {
      load('newer');
    } else if (boundary?.kind === 'live') {
      const source = capture()?.source;
      const overlap =
        source &&
        props.messages.some((message) =>
          message.sourceBlockIds?.includes(source),
        );
      viewport.continueLive(
        overlap ? source : props.messages[0]?.sourceBlockIds?.[0],
      );
    } else if (boundary?.kind === 'loadable' || boundary?.kind === 'cached')
      load(edge);
  };

  return (
    <div
      ref={root}
      className={`${styles.root} relative flex min-h-0 flex-1`}
      data-history-viewport={historical ? 'historical' : 'live'}
    >
      {globalNavigation && (
        <div className={styles.navigation} hidden={!navigationVisible}>
          <GlobalTurnNavigation
            state={viewport.navigation}
            store={viewport.store}
            onSelect={(ordinal) => {
              handleScrollIntent();
              anchor.current = undefined;
              void viewport.selectOrdinal(ordinal);
            }}
          />
        </div>
      )}
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        onWheelCapture={(event) => {
          handleScrollIntent();
          loadAtEdge(event.deltaY < 0 ? 'older' : 'newer');
        }}
        onPointerDownCapture={handleScrollIntent}
        onKeyDownCapture={(event) => {
          if (
            [
              'ArrowUp',
              'ArrowDown',
              'PageUp',
              'PageDown',
              'Home',
              'End',
              ' ',
            ].includes(event.key)
          )
            handleScrollIntent();
        }}
        onScrollCapture={(event) => {
          if (event.target !== scroller() || restoring.current) return;
          const current = capture();
          if (loading) anchor.current = current;
          loadAtEdge();
        }}
      >
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {(loading || viewport.error) && (
            <div className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-lg border bg-background px-3 py-1 text-xs text-muted-foreground">
              {loading && (
                <span role="status">{t('history.loadingEarlier')}</span>
              )}
              {viewport.error && (
                <span role="alert">
                  {t('history.viewError')}{' '}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      anchor.current = capture();
                      viewport.retry();
                    }}
                  >
                    {t('history.retry')}
                  </Button>
                </span>
              )}
            </div>
          )}
          <MessageList
            {...props}
            key={viewport.viewKey}
            ref={list}
            messages={viewport.messages}
            hideSessionTimeline={
              historical || globalNavigation || props.hideSessionTimeline
            }
            {...(viewport.historical
              ? {
                  frozenViewport: true,
                  hasOlderHistory: false,
                  onLoadOlderHistory: undefined,
                  historyCapacityReached: false,
                  historyPaginationError: false,
                  loadingOlderHistory: false,
                  onCanScrollToBottomChange: undefined,
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
          {historical && !onCanScrollToBottomChange && (
            <Button
              className="absolute bottom-3 left-1/2 -translate-x-1/2"
              variant="outline"
              size="sm"
              onClick={returnToLive}
            >
              {t('history.returnLatest')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
});
