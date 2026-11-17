import {
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { AnchorIcon, ChevronRightIcon, MoreHorizontalIcon } from 'lucide-react';
import {
  summarizeHookExecutions,
  type HookExecutionEntry,
  type HookLifecycleSummary,
  type HookTurnPage,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { useTrajectoryLiveSnapshot } from '../../trajectory/trajectory-live-context';
import { DialogShell } from '../dialogs/DialogShell';
import { Button } from '../ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  HookStatisticsContext,
  type HookStatisticsSource,
  type HookStatisticsTurn,
} from './hook-statistics-context';

const duration = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;

export const HookStatistics = memo(function HookStatistics({
  turn,
}: {
  turn: HookStatisticsTurn;
}) {
  const source = useContext(HookStatisticsContext);
  if (!source || source.sessionId !== turn.sessionId) return null;
  return <ResolvedHookStatistics source={source} turn={turn} />;
});

function ResolvedHookStatistics({
  source,
  turn,
}: {
  source: HookStatisticsSource;
  turn: HookStatisticsTurn;
}) {
  const navigation = useSyncExternalStore(
    source.navigation.subscribe,
    source.navigation.getSnapshot,
    source.navigation.getSnapshot,
  );
  const live = useTrajectoryLiveSnapshot();
  const indexed =
    navigation.sessionId === turn.sessionId
      ? [...navigation.indexPages.values()]
          .flatMap((page) => page.turns)
          .find((entry) =>
            turn.recordId
              ? entry.turnId === turn.recordId
              : turn.promptId && entry.promptId === turn.promptId,
          )
      : undefined;
  const promptId =
    indexed?.historyPromptId ??
    (live.sessionId === turn.sessionId && turn.promptId
      ? live.hookPromptIds.get(turn.promptId)
      : undefined);
  const entries = useMemo(
    () =>
      [...live.hooks.entries.values()].filter(
        (entry) =>
          entry.event.sessionId === turn.sessionId &&
          entry.event.promptId === promptId,
      ),
    [live.hooks, turn.sessionId, promptId],
  );
  if (!promptId) return null;
  return (
    <HookStatisticsEntry
      key={`${turn.sessionId}:${promptId}`}
      source={source}
      promptId={promptId}
      entries={entries}
      liveStatus={live.status}
    />
  );
}

function HookSummary({
  summary,
  partial,
}: {
  summary: HookLifecycleSummary;
  partial: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-1 text-xs">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4">
        <div className="flex items-baseline justify-between gap-1">
          <dt className="text-muted-foreground">{t('hooks.executions')}</dt>
          <dd className="font-medium">{summary.totalExecutions}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-1">
          <dt className="text-muted-foreground">{t('hooks.blocked')}</dt>
          <dd className="font-medium">{summary.counts.blocked}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-1">
          <dt className="text-muted-foreground">{t('hooks.unsuccessful')}</dt>
          <dd className="font-medium">
            {summary.counts.error + summary.counts.timeout}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-1">
          <dt className="text-muted-foreground">{t('hooks.duration')}</dt>
          <dd className="font-medium">{duration(summary.durationMs)}</dd>
        </div>
      </dl>
      {partial && <p className="text-muted-foreground">{t('hooks.partial')}</p>}
    </div>
  );
}

function HookStatisticsEntry({
  source,
  promptId,
  entries,
  liveStatus,
}: {
  source: HookStatisticsSource;
  promptId: string;
  entries: HookExecutionEntry[];
  liveStatus: string;
}) {
  const { t } = useI18n();
  const [page, setPage] = useState<HookTurnPage>();
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const revision = useRef({ entries, liveStatus });
  revision.current = { entries, liveStatus };
  useEffect(() => {
    let current = true;
    let pending = false;
    let requested: typeof revision.current | undefined;
    const update = () => {
      const latest = revision.current;
      if (
        pending ||
        (requested &&
          requested.liveStatus === latest.liveStatus &&
          requested.entries.length === latest.entries.length &&
          requested.entries.every(
            (entry, index) => entry === latest.entries[index],
          ))
      )
        return;
      pending = true;
      requested = latest;
      void source
        .readPage(promptId, { limit: 1 })
        .then((value) => {
          if (current) {
            setPage(value);
            setFailed(false);
          }
        })
        .catch(() => {
          if (current) setFailed(true);
        })
        .finally(() => {
          pending = false;
        });
    };
    update();
    const timer = setInterval(update, 250);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [source, promptId, refresh]);
  const liveSummary = useMemo(
    () => summarizeHookExecutions(entries),
    [entries],
  );
  const summary =
    liveStatus === 'live' &&
    !liveSummary.counts.unknown &&
    entries.length >= (page?.totalExecutions ?? 0)
      ? liveSummary
      : (page?.summary ?? liveSummary);
  if (!summary.totalExecutions && !open && !failed) return null;
  const showDialog = (mobile: boolean) => {
    setMobileOpen(mobile);
    setHover(false);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setRefresh((value) => value + 1);
    requestAnimationFrame(() =>
      (mobileOpen ? moreTrigger : trigger).current?.focus(),
    );
  };
  return (
    <>
      <span className="hidden sm:inline-flex">
        <TooltipProvider delayDuration={300} disableHoverableContent={false}>
          <Tooltip open={hover && !open} onOpenChange={setHover}>
            <TooltipTrigger asChild>
              <button
                ref={trigger}
                type="button"
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                aria-label={t('hooks.title')}
                onClick={() => showDialog(false)}
              >
                <AnchorIcon className="size-4" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="block max-w-xs p-2">
              <p className="font-medium">{t('hooks.title')}</p>
              {summary.totalExecutions > 0 ? (
                <p className="mt-1 text-muted-foreground">
                  {t('hooks.compactSummary', {
                    executions: summary.totalExecutions,
                    blocked: summary.counts.blocked,
                    unsuccessful: summary.counts.error + summary.counts.timeout,
                    duration: duration(summary.durationMs),
                  })}
                </p>
              ) : (
                failed && (
                  <p role="alert" className="mt-1">
                    {t('hooks.loadFailed')}
                  </p>
                )
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </span>
      <span className="inline-flex sm:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              ref={moreTrigger}
              type="button"
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
              aria-label={t('hooks.more')}
            >
              <MoreHorizontalIcon className="size-4" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            onCloseAutoFocus={(event) => {
              if (open) event.preventDefault();
            }}
          >
            <DropdownMenuItem onSelect={() => showDialog(true)}>
              <AnchorIcon className="size-4" />
              {t('hooks.title')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      {open && (
        <HookStatisticsDialog
          source={source}
          promptId={promptId}
          onClose={close}
        />
      )}
    </>
  );
}

function HookStatisticsDialog({
  source,
  promptId,
  onClose,
}: {
  source: HookStatisticsSource;
  promptId: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [page, setPage] = useState<HookTurnPage>();
  const [rows, setRows] = useState<HookExecutionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setLoading(true);
    setFailed(false);
    setPage(undefined);
    setRows([]);
    void source
      .readPage(promptId, { limit: 50 })
      .then((value) => {
        if (generation.current !== current) return;
        setPage(value);
        setRows(value.executions);
      })
      .catch(() => {
        if (generation.current === current) setFailed(true);
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      generation.current = current + 1;
    };
  }, [source, promptId]);
  const loadMore = async () => {
    if (!page || page.nextStart === undefined || loading) return;
    const current = generation.current;
    setLoading(true);
    setFailed(false);
    try {
      const next = await source.readPage(promptId, {
        snapshot: page.snapshot,
        start: page.nextStart,
        limit: 50,
      });
      if (generation.current !== current) return;
      setPage(next);
      setRows((previous) => [...previous, ...next.executions]);
    } catch {
      if (generation.current === current) setFailed(true);
    } finally {
      if (generation.current === current) setLoading(false);
    }
  };
  return (
    <DialogShell
      title={t('hooks.title')}
      subtitle={t('hooks.thisTurn')}
      size="md"
      onClose={onClose}
      aria-busy={loading}
    >
      <div className="flex min-h-0 flex-col gap-2">
        {page?.summary && (
          <HookSummary
            summary={page.summary}
            partial={page.coverage === 'partial'}
          />
        )}
        {loading && (
          <p role="status" className="text-xs text-muted-foreground">
            {t('hooks.loading')}
          </p>
        )}
        {failed && (
          <p role="alert" className="text-sm text-destructive">
            {t('hooks.loadFailed')}
          </p>
        )}
        {page && !page.totalExecutions && (
          <p>{t(`hooks.coverage.${page.coverage}`)}</p>
        )}
        <div className="max-h-[70vh] min-h-0 overflow-y-auto">
          {rows.map((entry) => (
            <HookExecutionRow key={entry.event.executionId} entry={entry} />
          ))}
          {page?.nextStart !== undefined && (
            <Button
              className="mt-2"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => void loadMore()}
            >
              {t(failed ? 'hooks.retry' : 'hooks.loadMore')}
            </Button>
          )}
        </div>
      </div>
    </DialogShell>
  );
}

function HookExecutionRow({ entry }: { entry: HookExecutionEntry }) {
  const { t, language } = useI18n();
  const { event } = entry;
  return (
    <Collapsible className="border-b">
      <CollapsibleTrigger className="group grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-1.5 rounded px-1 py-1.5 text-left text-xs hover:bg-accent">
        <ChevronRightIcon
          className="size-4 group-data-[state=open]:rotate-90"
          aria-hidden="true"
        />
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 break-words">
          <span className="font-medium">{event.name}</span>
          <span className="text-muted-foreground">
            {event.eventName} · {t(`hooks.source.${event.source}`)}
          </span>
        </span>
        <span className="flex max-w-40 flex-wrap items-baseline justify-end gap-x-2 text-right">
          <span>{t(`hooks.status.${entry.status}`)}</span>
          <span className="text-muted-foreground">
            {event.phase === 'ended' ? duration(event.durationMs) : '—'}
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-x-4 gap-y-1 break-words px-6 pb-2 text-xs text-muted-foreground sm:grid-cols-2">
        <p>
          {t('hooks.type')}: {event.hookType}
        </p>
        <p>
          {t('hooks.started')}:{' '}
          {new Date(event.startedAt).toLocaleString(language)}
        </p>
        {event.phase === 'ended' && (
          <>
            <p>
              {t('hooks.ended')}:{' '}
              {new Date(event.endedAt).toLocaleString(language)}
            </p>
            {event.exitCode !== undefined && (
              <p>
                {t('hooks.exitCode')}: {event.exitCode}
              </p>
            )}
          </>
        )}
        {event.phase === 'dispatched' && (
          <p className="sm:col-span-2">
            {t('hooks.dispatchDuration')}: {duration(event.dispatchDurationMs)}.{' '}
            {t('hooks.dispatchHelp')}
          </p>
        )}
        {entry.status === 'unknown' && (
          <p className="sm:col-span-2">{t('hooks.unknownHelp')}</p>
        )}
        {entry.conflicted && (
          <p className="sm:col-span-2">{t('hooks.partial')}</p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
