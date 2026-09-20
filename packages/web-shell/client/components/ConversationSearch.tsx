/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
  type ReactNode,
} from 'react';
import { ChevronDownIcon, ChevronUpIcon, SearchIcon } from 'lucide-react';
import { useTranscriptStore } from '../daemon-react-sdk';
import { useDaemonHistoryNavigationStore } from '../daemon/session/DaemonSessionProvider';
import {
  createConversationSearchSnippet,
  type ConversationSearchHit,
  type ConversationSearchResult,
} from '../daemon/session/turn-navigation-store';
import { transcriptBlocksToLocalizedMessages } from '../adapters/localizedMessages';
import { useConversationSearchI18n } from './conversation-search-i18n';
import type { MessageListHandle } from './MessageList';
import { DialogShell } from './dialogs/DialogShell';
import { Button } from './ui/button';
import { Input } from './ui/input';

interface SearchResult {
  key: string;
  role: 'user' | 'assistant';
  snippet: string;
  matchStart: number;
  matchEnd: number;
  messageId?: string;
  hit?: ConversationSearchHit;
}

interface ConversationSearchProps {
  children?: (trigger: ReactNode) => ReactNode;
  active?: boolean;
  onRestoreFocus?: () => void;
  threshold?: number;
  className?: string;
  messageListRef: RefObject<MessageListHandle | null>;
  registerInteractionBlocker?: () => () => void;
}

export function ConversationSearch({
  children,
  active = true,
  onRestoreFocus,
  threshold = 10,
  className,
  messageListRef,
  registerInteractionBlocker,
}: ConversationSearchProps) {
  const t = useConversationSearchI18n();
  const store = useTranscriptStore();
  const history = useDaemonHistoryNavigationStore();
  const transcript = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const navigation = useSyncExternalStore(
    history.subscribe,
    history.getSnapshot,
  );
  const viewportState = useSyncExternalStore(
    history.subscribe,
    history.getViewportSnapshot,
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [persisted, setPersisted] = useState<ConversationSearchResult>();
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string>();
  const resultListId = useId();
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState(false);
  const navigationIntent = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const needle = query.trim();
  const limit = Number.isFinite(threshold)
    ? Math.max(0, Math.floor(threshold))
    : 10;
  const blocks = transcript.blocks;
  const liveCount = useMemo(
    () =>
      blocks.filter(
        (block) => block.kind === 'user' || block.kind === 'assistant',
      ).length,
    [blocks],
  );

  useEffect(() => {
    if (!active) {
      navigationIntent.current += 1;
      setOpen(false);
      setQuery('');
    }
  }, [active]);

  useEffect(() => {
    const restoreFocus = wasOpen.current && !open;
    wasOpen.current = open;
    if (!restoreFocus || !active) return;
    const frame = requestAnimationFrame(() => {
      trigger.current?.focus({ preventScroll: true });
      if (!trigger.current || document.activeElement !== trigger.current)
        onRestoreFocus?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, open, onRestoreFocus]);

  useEffect(() => {
    if (active && open) return registerInteractionBlocker?.();
  }, [active, open, registerInteractionBlocker]);

  useEffect(() => setCount(0), [limit, viewportState.revision]);

  useEffect(() => {
    if (
      !active ||
      !viewportState.connected ||
      liveCount > limit ||
      navigation.mode !== 'ready'
    )
      return;
    let current = true;
    void history
      .scanConversation('', {
        isCurrent: () => current,
        stopAfterMessages: limit + 1,
      })
      .then((result) => {
        if (current && (result.complete || result.messageCount > limit))
          setCount(result.messageCount);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [
    active,
    history,
    liveCount,
    limit,
    navigation.mode,
    viewportState.revision,
    viewportState.connected,
  ]);

  useEffect(() => {
    navigationIntent.current += 1;
    setLocating(false);
    setLocateError(false);
    setSelectedKey(undefined);
    setPersisted(undefined);
    setError(false);
    if (
      !active ||
      !open ||
      !needle ||
      !viewportState.connected ||
      navigation.mode !== 'ready'
    ) {
      setLoading(false);
      return;
    }
    let current = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void history
        .scanConversation(needle, {
          isCurrent: () => current,
          onProgress: (result) => {
            if (current) setPersisted(result);
          },
        })
        .then((result) => {
          if (current) {
            setPersisted(result);
            if (result.complete) setCount(result.messageCount);
          }
        })
        .catch(() => {
          if (current) setError(true);
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [
    active,
    history,
    navigation.mode,
    needle,
    open,
    retry,
    viewportState.revision,
    viewportState.connected,
  ]);

  useEffect(
    () => () => {
      navigationIntent.current += 1;
    },
    [],
  );

  const results = useMemo(() => {
    if (!open || !needle) return [];
    const live: SearchResult[] = [];
    const liveRecords = new Set<string>();
    const recordsByBlock = new Map(
      blocks.map((block) => [block.id, block.sourceRecordIds ?? []]),
    );
    for (const message of transcriptBlocksToLocalizedMessages(blocks, t)) {
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      const match = createConversationSearchSnippet(message.content, needle);
      if (!match) continue;
      for (const blockId of message.sourceBlockIds ?? []) {
        for (const id of recordsByBlock.get(blockId) ?? []) liveRecords.add(id);
      }
      live.push({
        key: message.id,
        role: message.role,
        messageId: message.id,
        ...match,
      });
    }
    const older = (persisted?.hits ?? [])
      .filter((hit) => !liveRecords.has(hit.recordId))
      .map((hit): SearchResult => ({ ...hit, key: hit.recordId, hit }));
    return [...older, ...live].slice(0, 200);
  }, [blocks, needle, open, persisted, t]);

  useEffect(() => {
    setSelectedKey((current) =>
      results.some((result) => result.key === current)
        ? current
        : results[0]?.key,
    );
  }, [results]);
  const activeIndex = Math.max(
    0,
    results.findIndex((result) => result.key === selectedKey),
  );
  const searchFailed =
    error ||
    (!loading && navigation.mode === 'ready' && persisted?.complete === false);
  const choose = async (result: SearchResult) => {
    const intent = ++navigationIntent.current;
    setLocating(true);
    setLocateError(false);
    try {
      const list = messageListRef.current;
      const found = result.hit
        ? await list?.scrollToSearchHit?.(
            result.hit,
            () => intent === navigationIntent.current,
          )
        : result.messageId && list?.scrollToMessage(result.messageId);
      if (intent !== navigationIntent.current) return;
      if (found === true) setOpen(false);
      else if (found !== 'cancelled') setLocateError(true);
    } catch {
      if (intent === navigationIntent.current) setLocateError(true);
    } finally {
      if (intent === navigationIntent.current) setLocating(false);
    }
  };

  const button =
    active && (Math.max(liveCount, count) > limit || open) ? (
      <button
        ref={trigger}
        type="button"
        className={className}
        aria-label={t('chat.searchConversation')}
        title={t('chat.searchConversation')}
        onClick={() => setOpen(true)}
      >
        <SearchIcon
          width={14}
          height={14}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      </button>
    ) : undefined;

  return (
    <>
      {children ? children(button) : button}
      {active && open && (
        <DialogShell
          title={t('chat.searchConversation')}
          onClose={() => {
            navigationIntent.current += 1;
            setOpen(false);
          }}
        >
          <div
            className="flex h-[min(480px,60dvh)] min-h-0 flex-col gap-3 overflow-hidden"
            data-conversation-search
          >
            <Input
              autoFocus
              type="search"
              role="combobox"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-controls={resultListId}
              aria-activedescendant={
                results[activeIndex]
                  ? `${resultListId}-${activeIndex}`
                  : undefined
              }
              value={query}
              aria-label={t('chat.searchConversation')}
              placeholder={t('chat.searchConversationPlaceholder')}
              className="min-h-11 shrink-0"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229)
                  return;
                if (
                  event.metaKey ||
                  event.ctrlKey ||
                  event.altKey ||
                  event.shiftKey
                )
                  return;
                if (
                  event.key === 'Enter' &&
                  results[activeIndex] &&
                  !locating
                ) {
                  event.preventDefault();
                  void choose(results[activeIndex]);
                }
                if (
                  (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
                  results.length
                ) {
                  event.preventDefault();
                  setSelectedKey(
                    results[
                      (activeIndex +
                        (event.key === 'ArrowDown' ? 1 : results.length - 1)) %
                        results.length
                    ]!.key,
                  );
                }
              }}
            />
            {(navigation.mode !== 'ready' || !viewportState.connected) && (
              <p className="text-sm text-muted-foreground">
                {t('chat.searchLoadedOnly')}
              </p>
            )}
            <div className="flex min-h-11 shrink-0 items-center justify-between gap-2">
              <p
                role="status"
                className="min-w-0 text-sm text-muted-foreground"
              >
                {loading
                  ? t('chat.searchingConversation')
                  : !needle
                    ? t('chat.searchConversationHint')
                    : results.length
                      ? t('chat.searchResultPosition', {
                          current: activeIndex + 1,
                          total: results.length,
                        })
                      : (navigation.mode !== 'ready' ||
                            viewportState.connected) &&
                          !error &&
                          persisted?.complete !== false
                        ? t('chat.searchNoResults')
                        : ''}
              </p>
              {results.length > 0 && (
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="min-h-11 min-w-11"
                    aria-label={t('chat.searchPrevious')}
                    onClick={() =>
                      setSelectedKey(
                        results[
                          (activeIndex + results.length - 1) % results.length
                        ]!.key,
                      )
                    }
                  >
                    <ChevronUpIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="min-h-11 min-w-11"
                    aria-label={t('chat.searchNext')}
                    onClick={() =>
                      setSelectedKey(
                        results[(activeIndex + 1) % results.length]!.key,
                      )
                    }
                  >
                    <ChevronDownIcon />
                  </Button>
                </div>
              )}
            </div>
            {(persisted?.truncated || results.length === 200) && (
              <p className="text-sm text-muted-foreground">
                {t('chat.searchResultsLimited', { count: results.length })}
              </p>
            )}
            {searchFailed && (
              <div
                role="alert"
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span>{t('chat.searchFailed')}</span>
                <Button
                  variant="outline"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  {t('common.retry')}
                </Button>
              </div>
            )}
            {locateError && (
              <p role="alert" className="text-sm text-destructive">
                {t('chat.searchLocateFailed')}
              </p>
            )}
            <ol
              id={resultListId}
              role="listbox"
              className="min-h-0 flex-1 overflow-y-auto"
              aria-label={t('chat.searchResults')}
            >
              {results.map((result, index) => (
                <li key={result.key} role="none">
                  <button
                    id={`${resultListId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    disabled={locating}
                    aria-current={index === activeIndex ? 'true' : undefined}
                    className={`w-full min-w-0 rounded-lg p-3 text-left text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere] hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring ${index === activeIndex ? 'bg-muted' : ''}`}
                    ref={(node) => {
                      if (node && index === activeIndex)
                        node.scrollIntoView?.({ block: 'nearest' });
                    }}
                    onClick={() => {
                      setSelectedKey(result.key);
                      void choose(result);
                    }}
                  >
                    <span className="mb-1 block text-xs text-muted-foreground">
                      {t(
                        result.role === 'user'
                          ? 'chat.searchUser'
                          : 'chat.searchAssistant',
                      )}
                    </span>
                    {result.snippet.slice(0, result.matchStart)}
                    <mark className="rounded bg-primary/20 text-foreground">
                      {result.snippet.slice(result.matchStart, result.matchEnd)}
                    </mark>
                    {result.snippet.slice(result.matchEnd)}
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </DialogShell>
      )}
    </>
  );
}
