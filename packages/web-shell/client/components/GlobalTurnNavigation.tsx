/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  DaemonTurnNavigationSnapshot,
  DaemonTurnNavigationStore,
} from '../daemon/session/turn-navigation-store';
import { WEB_SHELL_TURN_INDEX_PAGE_SIZE } from '../constants/sessions';
import { useI18n } from '../i18n';
import { Button } from './ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip';
import timelineStyles from './MessageList.module.css';

const ROW_HEIGHT = 16;
const OVERSCAN = 4;

export function GlobalTurnNavigation({
  state,
  store,
  onSelect,
}: {
  state: DaemonTurnNavigationSnapshot;
  store: DaemonTurnNavigationStore;
  onSelect: (ordinal: number) => void;
}) {
  const { t } = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(360);
  const [focus, setFocus] = useState<number>();
  const pendingFocus = useRef(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const count = state.effectiveTurnCount;
  const start = Math.max(
    0,
    Math.min(count - 1, Math.floor(top / ROW_HEIGHT) - OVERSCAN),
  );
  const end = Math.min(
    count,
    start + Math.ceil(height / ROW_HEIGHT) + 2 * OVERSCAN,
  );
  const entries = new Map(
    [...state.indexPages.values()].flatMap((page) =>
      page.turns.map((entry) => [entry.ordinal, entry] as const),
    ),
  );

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setHeight(element.clientHeight || 360);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const [initializedSession, setInitializedSession] = useState<string>();
  useLayoutEffect(() => {
    if (!count || initializedSession === state.sessionId) return;
    const element = viewport.current;
    if (!element) return;
    element.scrollTop = Math.max(0, count * ROW_HEIGHT - height);
    setTop(element.scrollTop);
    setFocus(count - 1);
    setInitializedSession(state.sessionId);
  }, [count, state.sessionId, height, initializedSession]);

  const missing = new Set<number>();
  for (
    let ordinal = start;
    initializedSession === state.sessionId &&
    ordinal < Math.min(end, state.totalTurns);
    ordinal++
  ) {
    if (!entries.has(ordinal))
      missing.add(
        Math.floor(ordinal / WEB_SHELL_TURN_INDEX_PAGE_SIZE) *
          WEB_SHELL_TURN_INDEX_PAGE_SIZE,
      );
  }
  const missingPages = [...missing].join(',');
  const focusOrdinal = Math.max(start, Math.min(focus ?? count - 1, end - 1));
  useEffect(() => {
    if (!missingPages) return;
    let current = true;
    setFailed(false);
    void Promise.all(
      missingPages
        .split(',')
        .map((ordinal) => store.loadOrdinal(Number(ordinal))),
    ).catch(() => {
      if (current) setFailed(true);
    });
    return () => {
      current = false;
    };
  }, [missingPages, store, retry]);

  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const button = viewport.current?.querySelector<HTMLButtonElement>(
      `[data-turn-ordinal="${focus}"]`,
    );
    if (button) {
      button.focus({ preventScroll: true });
      pendingFocus.current = false;
    }
  }, [focus, start, end]);

  return (
    <TooltipProvider disableHoverableContent>
      <nav
        aria-label={t('timeline.sessionTimeline')}
        className="pointer-events-none flex h-full min-h-0 w-full shrink-0 flex-col justify-center px-[min(12px,25%)] py-4 text-muted-foreground"
        data-global-turn-navigation
      >
        <span className="sr-only">
          {t('timeline.sessionTimeline')} · {count}
        </span>
        {/* Allow hover ticks to expand past the gutter without covering message hit targets. */}
        <div
          ref={viewport}
          className="-mr-8 min-h-0 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{ height: Math.min(count * ROW_HEIGHT, 360) }}
          onScroll={(event) => setTop(event.currentTarget.scrollTop)}
        >
          <ol
            className="relative my-0 mr-8 ml-0 list-none p-0"
            style={{ height: count * ROW_HEIGHT }}
          >
            {Array.from({ length: end - start }, (_, index) => {
              const ordinal = start + index;
              const entry = entries.get(ordinal);
              const label =
                entry?.label ??
                state.provisionalTurns[ordinal - state.totalTurns]?.label;
              const title = `${t('timeline.turnPrefix', { index: ordinal + 1 })}${label ? ` · ${label}` : ''}`;
              return (
                <li
                  key={ordinal}
                  aria-posinset={ordinal + 1}
                  aria-setsize={count}
                  className={`${timelineStyles.sessionTimelineItem} left-0 right-0`}
                  style={{
                    position: 'absolute',
                    top: ordinal * ROW_HEIGHT,
                    height: ROW_HEIGHT,
                  }}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className={`${timelineStyles.sessionTimelineButton} pointer-events-auto ${state.selected?.ordinal === ordinal ? timelineStyles.sessionTimelineButtonCurrent : ''}`}
                        style={{ top: 0, width: '100%' }}
                        aria-label={title}
                        aria-current={
                          state.selected?.ordinal === ordinal
                            ? 'location'
                            : undefined
                        }
                        data-turn-ordinal={ordinal}
                        tabIndex={focusOrdinal === ordinal ? 0 : -1}
                        onFocus={() => setFocus(ordinal)}
                        onClick={() => onSelect(ordinal)}
                        onKeyDown={(event) => {
                          const step = Math.max(
                            1,
                            Math.floor(height / ROW_HEIGHT),
                          );
                          const next =
                            event.key === 'Home'
                              ? 0
                              : event.key === 'End'
                                ? count - 1
                                : event.key === 'ArrowDown'
                                  ? ordinal + 1
                                  : event.key === 'ArrowUp'
                                    ? ordinal - 1
                                    : event.key === 'PageDown'
                                      ? ordinal + step
                                      : event.key === 'PageUp'
                                        ? ordinal - step
                                        : undefined;
                          if (next === undefined) return;
                          event.preventDefault();
                          const target = Math.max(0, Math.min(count - 1, next));
                          const element = viewport.current!;
                          if (target * ROW_HEIGHT < element.scrollTop)
                            element.scrollTop = target * ROW_HEIGHT;
                          else if (
                            (target + 1) * ROW_HEIGHT >
                            element.scrollTop + height
                          )
                            element.scrollTop =
                              (target + 1) * ROW_HEIGHT - height;
                          setTop(element.scrollTop);
                          pendingFocus.current = true;
                          setFocus(target);
                        }}
                      >
                        <span
                          className={timelineStyles.sessionTimelineTick}
                          aria-hidden="true"
                        />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent
                      side="right"
                      sideOffset={8}
                      collisionPadding={12}
                      className={`${timelineStyles.sessionTimelinePreview} !animate-none max-w-none ring-0 [&_[data-slot=tooltip-arrow]]:hidden!`}
                    >
                      <span className="line-clamp-2 text-sm font-semibold">
                        {label ??
                          t('timeline.turnPrefix', { index: ordinal + 1 })}
                      </span>
                      {entry?.detail && (
                        <span className="line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">
                          {entry.detail}
                        </span>
                      )}
                    </TooltipContent>
                  </Tooltip>
                </li>
              );
            })}
          </ol>
        </div>
        {failed && (
          <Button
            variant="ghost"
            size="sm"
            className="pointer-events-auto"
            onClick={() => setRetry((value) => value + 1)}
          >
            {t('history.retry')}
          </Button>
        )}
      </nav>
    </TooltipProvider>
  );
}
