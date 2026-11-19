import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import {
  useTurnNavigationState,
  useTurnNavigationStore,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../../i18n';
import type { OpenTurnCalls } from '../../turnCallsContext';
import { WEB_SHELL_TURN_INDEX_PAGE_SIZE } from '../../constants/sessions';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

const ROW_HEIGHT = 32;
const VISIBLE_ROWS = 8;

export function TurnCallPromptSelect({
  recordId,
  promptId,
  label,
  refreshKey,
  onSelect,
  onLoadError,
}: {
  recordId?: string;
  promptId?: string;
  label?: string;
  refreshKey: number;
  onSelect?: OpenTurnCalls;
  onLoadError: (failed: boolean) => void;
}) {
  const { t } = useI18n();
  const state = useTurnNavigationState();
  const store = useTurnNavigationStore();
  const id = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState(0);
  const [focus, setFocus] = useState(0);
  const [failed, setFailed] = useState(false);
  const refreshed = useRef(refreshKey);
  const choices = useMemo(() => {
    const entries = new Map<
      number,
      { turnId: string; recordId?: string; promptId?: string; label: string }
    >(
      [...state.indexPages.values()].flatMap((page) =>
        page.turns.map(
          (turn) =>
            [
              turn.ordinal,
              {
                turnId: turn.turnId,
                recordId: turn.turnId,
                promptId: turn.promptId,
                label: turn.label,
              },
            ] as const,
        ),
      ),
    );
    state.provisionalTurns.forEach((turn, index) => {
      entries.set(state.totalTurns + index, {
        turnId: turn.blockId ?? turn.provisionalId,
        recordId: undefined,
        promptId: turn.promptId,
        label: turn.label,
      });
    });
    return entries;
  }, [state.indexPages, state.provisionalTurns, state.totalTurns]);
  const selected = [...choices].find(([, choice]) =>
    recordId
      ? choice.recordId === recordId
      : promptId && choice.promptId === promptId,
  );
  const count = state.effectiveTurnCount;
  const start = Math.max(
    0,
    Math.min(count - 1, Math.floor(top / ROW_HEIGHT) - 2),
  );
  const end = Math.min(count, start + VISIBLE_ROWS + 4);
  const missing = new Set<number>();
  for (
    let ordinal = start;
    open && ordinal < Math.min(end, state.totalTurns);
    ordinal++
  ) {
    if (!choices.has(ordinal))
      missing.add(
        Math.floor(ordinal / WEB_SHELL_TURN_INDEX_PAGE_SIZE) *
          WEB_SHELL_TURN_INDEX_PAGE_SIZE,
      );
  }
  const missingPages = [...missing].join(',');
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
  }, [missingPages, store, refreshKey]);
  useEffect(() => {
    if (refreshed.current === refreshKey) return;
    refreshed.current = refreshKey;
    setFailed(false);
    void store.refreshHead();
  }, [refreshKey, store]);
  useEffect(() => {
    onLoadError(
      failed || state.error?.operation === 'index' || state.mode === 'degraded',
    );
  }, [failed, state.error, state.mode, onLoadError]);
  const choose = (ordinal: number) => {
    const choice = choices.get(ordinal);
    if (!choice) return;
    onSelect?.(choice.turnId, choice.recordId, choice.promptId, choice.label);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        if (value) {
          const ordinal = selected?.[0] ?? Math.max(0, count - 1);
          setFocus(ordinal);
          setTop(Math.max(0, ordinal - VISIBLE_ROWS + 1) * ROW_HEIGHT);
        }
        setOpen(value);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="min-w-0 max-w-64 text-foreground"
          role="combobox"
          aria-label={t('turnCalls.prompt')}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          title={selected?.[1].label ?? label}
        >
          <span className="truncate">
            {selected?.[1].label ?? label ?? t('turnCalls.prompt')}
          </span>
          <ChevronDownIcon size={14} aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] p-1"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          viewport.current?.focus();
        }}
      >
        {!count && (
          <span role="status">
            {state.mode === 'loading'
              ? t('common.loading')
              : (label ?? t('turnCalls.prompt'))}
          </span>
        )}
        <div
          ref={(element) => {
            viewport.current = element;
            if (element) element.scrollTop = top;
          }}
          id={id}
          role="listbox"
          aria-label={t('turnCalls.prompt')}
          tabIndex={0}
          aria-activedescendant={
            focus >= start && focus < end ? `${id}-${focus}` : undefined
          }
          className="overflow-y-auto overscroll-contain outline-none"
          style={{
            height: Math.min(count, VISIBLE_ROWS) * ROW_HEIGHT,
          }}
          onScroll={(event) => setTop(event.currentTarget.scrollTop)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              choose(focus);
              return;
            }
            const target =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? count - 1
                  : event.key === 'ArrowDown'
                    ? focus + 1
                    : event.key === 'ArrowUp'
                      ? focus - 1
                      : event.key === 'PageDown'
                        ? focus + VISIBLE_ROWS
                        : event.key === 'PageUp'
                          ? focus - VISIBLE_ROWS
                          : undefined;
            if (target === undefined || !count) return;
            event.preventDefault();
            const next = Math.max(0, Math.min(count - 1, target));
            setFocus(next);
            const element = event.currentTarget;
            if (next * ROW_HEIGHT < element.scrollTop)
              element.scrollTop = next * ROW_HEIGHT;
            else if (
              (next + 1) * ROW_HEIGHT >
              element.scrollTop + VISIBLE_ROWS * ROW_HEIGHT
            )
              element.scrollTop = (next + 1 - VISIBLE_ROWS) * ROW_HEIGHT;
            setTop(element.scrollTop);
          }}
        >
          <div className="relative" style={{ height: count * ROW_HEIGHT }}>
            {Array.from({ length: end - start }, (_, index) => {
              const ordinal = start + index;
              const choice = choices.get(ordinal);
              return (
                <div
                  key={ordinal}
                  id={`${id}-${ordinal}`}
                  role="option"
                  aria-selected={selected?.[0] === ordinal}
                  aria-disabled={!choice}
                  aria-posinset={ordinal + 1}
                  aria-setsize={count}
                  title={choice?.label}
                  className={`absolute flex w-full cursor-default items-center gap-2 rounded-sm px-2 text-sm ${focus === ordinal ? 'bg-accent text-accent-foreground' : ''}`}
                  style={{ top: ordinal * ROW_HEIGHT, height: ROW_HEIGHT }}
                  onMouseMove={() => setFocus(ordinal)}
                  onClick={() => choose(ordinal)}
                >
                  <span className="truncate">
                    {choice?.label ?? t('common.loading')}
                  </span>
                  {selected?.[0] === ordinal && (
                    <CheckIcon
                      size={14}
                      className="ml-auto shrink-0"
                      aria-hidden="true"
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
