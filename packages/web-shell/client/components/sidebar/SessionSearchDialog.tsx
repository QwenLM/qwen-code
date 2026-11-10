import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CornerDownLeftIcon,
  LoaderCircleIcon,
  MessageCircleIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { useSessionSearch } from './use-session-search';

type SearchOptions = Parameters<typeof useSessionSearch>[0];
type SearchEntry = ReturnType<typeof useSessionSearch>['entries'][number];

interface SessionSearchDialogProps extends Omit<SearchOptions, 'query'> {
  onClose: () => void;
  onSelect: (entry: SearchEntry) => void;
  restoreFocus: HTMLElement | null;
  customContent?: ReactNode;
  additionalContent?: ReactNode;
  onQueryChange: (query: string) => void;
}

function Match({ text, query }: { text: string; query: string }) {
  const start = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (start < 0) return text;
  return (
    <>
      {text.slice(0, start)}
      <mark className="bg-transparent font-semibold text-foreground">
        {text.slice(start, start + query.length)}
      </mark>
      {text.slice(start + query.length)}
    </>
  );
}

export function SessionSearchDialog({
  onClose,
  onSelect,
  restoreFocus,
  customContent,
  additionalContent,
  onQueryChange,
  ...options
}: SessionSearchDialogProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const { entries, loading, failed, retry } = useSessionSearch({
    ...options,
    client: customContent === undefined ? options.client : undefined,
    query,
  });
  const activeIndex = Math.min(selected, entries.length - 1);
  const activeId = activeIndex >= 0 ? `${id}-${activeIndex}` : undefined;
  const trimmed = query.trim();

  useEffect(() => {
    if (activeId)
      document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  const select = (entry: SearchEntry) => {
    onClose();
    onSelect(entry);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex w-[92vw] max-w-[48rem] flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-2xl sm:max-w-[48rem]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (restoreFocus?.isConnected) restoreFocus.focus();
        }}
      >
        <DialogTitle className="sr-only">{t('sidebar.search')}</DialogTitle>
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-border/60 px-5">
          <SearchIcon
            className="size-5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            ref={inputRef}
            value={query}
            placeholder={t('sidebar.searchPlaceholder')}
            aria-label={t('sidebar.search')}
            autoComplete="off"
            aria-controls={customContent === undefined ? id : undefined}
            aria-activedescendant={
              customContent === undefined ? activeId : undefined
            }
            className="h-full rounded-none border-0 bg-transparent px-0 text-base shadow-none focus-visible:border-transparent focus-visible:ring-0 md:text-base dark:bg-transparent"
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
              listRef.current?.scrollTo?.({ top: 0 });
              onQueryChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if (
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229 ||
                customContent !== undefined
              )
                return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setSelected(
                  Math.max(
                    0,
                    Math.min(
                      entries.length - 1,
                      activeIndex + (event.key === 'ArrowDown' ? 1 : -1),
                    ),
                  ),
                );
              } else if (event.key === 'Enter' && entries[activeIndex]) {
                event.preventDefault();
                select(entries[activeIndex]);
              }
            }}
          />
          {loading && customContent === undefined && (
            <LoaderCircleIcon
              aria-label={t('common.loading')}
              className="size-4 shrink-0 animate-spin text-muted-foreground"
            />
          )}
          <DialogClose
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={t('common.close')}
          >
            <XIcon className="size-4" />
          </DialogClose>
        </div>
        <div
          ref={listRef}
          className="h-[min(440px,60dvh)] overflow-y-auto overscroll-contain p-2"
        >
          {additionalContent}
          {customContent !== undefined ? (
            customContent
          ) : (
            <>
              <div className="px-3 pt-2 pb-3 text-xs font-medium text-muted-foreground">
                {trimmed
                  ? t('sidebar.searchResults')
                  : t('sidebar.recentSessions')}
              </div>
              {failed && (
                <div
                  role="status"
                  className="flex items-center justify-between gap-3 px-3 pb-3 text-xs text-muted-foreground"
                >
                  <span>{t('sidebar.searchPartialFailure')}</span>
                  <button
                    type="button"
                    onClick={retry}
                    className="shrink-0 rounded px-2 py-1 text-foreground hover:bg-accent"
                  >
                    {t('common.retry')}
                  </button>
                </div>
              )}
              <div
                id={id}
                role="listbox"
                aria-label={t('sidebar.searchResults')}
                aria-busy={loading}
              >
                {entries.map((entry, index) => {
                  const title =
                    entry.session.displayName?.trim() ||
                    t('sidebar.untitledSession');
                  const workspaceName = entry.workspaceCwd
                    ? options.workspaces.find(
                        (workspace) => workspace.cwd === entry.workspaceCwd,
                      )?.displayName ||
                      entry.workspaceCwd.split(/[\\/]/).filter(Boolean).pop() ||
                      entry.workspaceCwd
                    : t('sidebar.noWorkspace');
                  return (
                    <div
                      id={`${id}-${index}`}
                      key={JSON.stringify([
                        entry.workspaceCwd,
                        entry.session.sessionId,
                      ])}
                      role="option"
                      aria-selected={index === activeIndex}
                      className={`group flex cursor-pointer items-center gap-3 rounded-lg px-3 py-3 ${index === activeIndex ? 'bg-accent' : 'hover:bg-accent/60'}`}
                      onPointerMove={(event) => {
                        if (event.pointerType === 'mouse') setSelected(index);
                      }}
                      onClick={() => select(entry)}
                    >
                      <MessageCircleIcon
                        className="size-[18px] shrink-0 text-muted-foreground"
                        strokeWidth={1.5}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-foreground">
                          <Match text={title} query={trimmed} />
                        </div>
                        {entry.snippet && (
                          <div className="mt-1 truncate text-xs text-muted-foreground">
                            <Match text={entry.snippet} query={trimmed} />
                          </div>
                        )}
                      </div>
                      <span
                        title={entry.workspaceCwd}
                        className="max-w-24 truncate text-xs text-muted-foreground"
                      >
                        {workspaceName}
                      </span>
                      <CornerDownLeftIcon
                        className={`hidden size-3.5 shrink-0 text-muted-foreground sm:block ${index === activeIndex ? '' : 'invisible'}`}
                        aria-hidden="true"
                      />
                    </div>
                  );
                })}
              </div>
              {!entries.length && !failed && (
                <div
                  role="status"
                  className="flex h-60 flex-col items-center justify-center gap-3 px-6 text-center"
                >
                  <SearchIcon
                    className="size-7 text-muted-foreground/60"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                  <p className="text-sm text-muted-foreground">
                    {loading
                      ? t('sidebar.searchLoading')
                      : trimmed
                        ? t('sidebar.searchEmpty')
                        : t('sidebar.searchRecentEmpty')}
                  </p>
                  {!loading && trimmed && (
                    <p className="text-xs text-muted-foreground">
                      {t('sidebar.searchEmptyHint')}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <div className="flex min-h-10 shrink-0 items-center gap-4 border-t border-border/60 px-5 text-[11px] text-muted-foreground">
          {customContent === undefined && (
            <>
              <span className="flex items-center gap-1">
                <ArrowUpIcon className="size-3" />
                <ArrowDownIcon className="size-3" />
                {t('sidebar.searchNavigate')}
              </span>
              <span className="flex items-center gap-1">
                <CornerDownLeftIcon className="size-3" />
                {t('sidebar.searchOpen')}
              </span>
            </>
          )}
          <span className="ml-auto flex items-center gap-1.5">
            <kbd className="rounded border border-border px-1">Esc</kbd>
            {t('common.close')}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
