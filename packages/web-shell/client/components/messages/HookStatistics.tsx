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
    <div className="grid gap-2 text-xs">
      <dl className="grid grid-cols-2 gap-x-5 gap-y-2">
        <dt>{t('hooks.executions')}</dt>
        <dd>{summary.totalExecutions}</dd>
        <dt>{t('hooks.blocked')}</dt>
        <dd>{summary.counts.blocked}</dd>
        <dt>{t('hooks.unsuccessful')}</dt>
        <dd>{summary.counts.error + summary.counts.timeout}</dd>
        <dt>{t('hooks.duration')}</dt>
        <dd>{duration(summary.durationMs)}</dd>
      </dl>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
        {(['success', 'running', 'cancelled', 'dispatched', 'unknown'] as const)
          .filter((status) => summary.counts[status] > 0)
          .map((status) => (
            <span key={status}>
              {t(`hooks.status.${status}`)}: {summary.counts[status]}
            </span>
          ))}
      </p>
      {!summary.durationComplete && (
        <p className="text-muted-foreground">{t('hooks.incompleteDuration')}</p>
      )}
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
  const [recent, setRecent] = useState<HookExecutionEntry[]>();
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
            setRecent(undefined);
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
  useEffect(() => {
    if (!hover || !page || !page.totalExecutions) return;
    let current = true;
    void source
      .readPage(promptId, {
        snapshot: page.snapshot,
        start: Math.max(0, page.totalExecutions - 5),
        limit: 5,
      })
      .then((value) => {
        if (current) setRecent([...value.executions].reverse());
      })
      .catch(() => {
        if (current) setRecent(undefined);
      });
    return () => {
      current = false;
    };
  }, [hover, page, source, promptId]);
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
  const latest =
    recent ??
    [...entries]
      .sort((a, b) => b.event.startedAt - a.event.startedAt)
      .slice(0, 5);
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
            <TooltipContent side="top" className="block max-w-xs p-3">
              <p className="mb-2 font-medium">{t('hooks.title')}</p>
              {failed && <p role="alert">{t('hooks.loadFailed')}</p>}
              {summary.totalExecutions > 0 && (
                <HookSummary
                  summary={summary}
                  partial={!page || page.coverage === 'partial'}
                />
              )}
              <ul className="mt-3 grid gap-2 border-t pt-2">
                {latest.map((entry) => (
                  <li key={entry.event.executionId} className="grid gap-0.5">
                    <span className="break-words">{entry.event.name}</span>
                    <span className="text-muted-foreground">
                      {t(`hooks.status.${entry.status}`)} ·{' '}
                      {entry.event.phase === 'ended'
                        ? duration(entry.event.durationMs)
                        : '—'}
                    </span>
                  </li>
                ))}
              </ul>
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
  const [refresh, setRefresh] = useState(0);
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
  }, [source, promptId, refresh]);
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
      size="lg"
      onClose={onClose}
      aria-busy={loading}
    >
      <div className="flex min-h-0 flex-col gap-4">
        {page?.summary && (
          <HookSummary
            summary={page.summary}
            partial={page.coverage === 'partial'}
          />
        )}
        <p className="text-xs text-muted-foreground">
          {t('hooks.durationHelp')}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {t('hooks.refresh')}
          </Button>
          {loading && (
            <span role="status" className="text-xs">
              {t('hooks.loading')}
            </span>
          )}
        </div>
        {failed && (
          <p role="alert" className="text-sm text-destructive">
            {t('hooks.loadFailed')}
          </p>
        )}
        {page && !page.totalExecutions && (
          <p>{t(`hooks.coverage.${page.coverage}`)}</p>
        )}
        <div className="min-h-0 overflow-y-auto" style={{ maxHeight: '50vh' }}>
          {rows.map((entry) => (
            <HookExecutionRow key={entry.event.executionId} entry={entry} />
          ))}
          {page?.nextStart !== undefined && (
            <Button
              className="mt-3"
              variant="outline"
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
    <Collapsible className="border-b py-2">
      <CollapsibleTrigger className="group grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-2 rounded px-1 py-2 text-left text-xs hover:bg-accent">
        <ChevronRightIcon
          className="size-4 group-data-[state=open]:rotate-90"
          aria-hidden="true"
        />
        <span className="grid min-w-0 gap-1 break-words">
          <span className="font-medium">{event.name}</span>
          <span className="text-muted-foreground">
            {event.eventName} · {t(`hooks.source.${event.source}`)}
          </span>
        </span>
        <span className="grid max-w-28 gap-1 text-right">
          <span>{t(`hooks.status.${entry.status}`)}</span>
          <span className="text-muted-foreground">
            {event.phase === 'ended' ? duration(event.durationMs) : '—'}
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 break-words px-7 pb-2 text-xs text-muted-foreground">
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
          <p>
            {t('hooks.dispatchDuration')}: {duration(event.dispatchDurationMs)}.{' '}
            {t('hooks.dispatchHelp')}
          </p>
        )}
        {entry.status === 'unknown' && <p>{t('hooks.unknownHelp')}</p>}
        {entry.conflicted && <p>{t('hooks.partial')}</p>}
      </CollapsibleContent>
    </Collapsible>
  );
}
