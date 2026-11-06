import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/button';
import type {
  ManagedDiagnosticAgentTrace,
  ManagedDiagnosticStats,
  ManagedDiagnosticsProvider,
} from './managed-agent-provider';
import { useManagedDiagnosticsText } from './managed-diagnostics-messages';

type Invocation = ManagedDiagnosticAgentTrace['items'][number];
type Props = {
  provider: ManagedDiagnosticsProvider;
  sessionId: string;
  clientId: string;
  running: boolean;
  onOpenChild?(sessionId: string): void;
};

function treeBudget() {
  let active = 0;
  const waiting: Array<() => void> = [];
  const nodes = new Set<string>();
  const targets = new Map<string, string>();
  const run = <T,>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      const start = () => {
        if (signal.aborted) {
          reject(new Error('Aborted'));
          drain();
          return;
        }
        active++;
        void operation()
          .then(resolve, reject)
          .finally(() => {
            active--;
            drain();
          });
      };
      const drain = () => {
        while (active < 3 && waiting.length) waiting.shift()!();
      };
      waiting.push(start);
      drain();
    });
  return {
    run,
    admit(parent: string, items: Invocation[]) {
      return items.filter((item) => {
        const key = `${parent}:${item.taskId}`;
        if (nodes.has(key)) return true;
        if (nodes.size >= 200) return false;
        nodes.add(key);
        return true;
      });
    },
    target(child: string, key: string) {
      const previous = targets.get(child);
      if (previous && previous !== key) return false;
      targets.set(child, key);
      return true;
    },
  };
}

type Budget = ReturnType<typeof treeBudget>;

function Branch({
  provider,
  sessionId,
  clientId,
  running,
  onOpenChild,
  ancestors,
  budget,
  depth,
}: Props & { ancestors: string[]; budget: Budget; depth: number }) {
  const t = useManagedDiagnosticsText();
  const [cursor, setCursor] = useState<string>();
  const [page, setPage] = useState<ManagedDiagnosticAgentTrace>();
  const [error, setError] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    let inFlight = false;
    const read = async () => {
      if (inFlight || abort.signal.aborted) return;
      inFlight = true;
      try {
        const value = await budget.run(async () => {
          for (const parent of ancestors) {
            const permission = await provider.getStatistics(parent, {
              clientId,
              signal: abort.signal,
            });
            if (
              permission.sessionId !== parent ||
              permission.schemaVersion !== 1
            )
              throw new Error('Ancestor identity mismatch');
          }
          return provider.listAgentTrace(sessionId, {
            clientId,
            signal: abort.signal,
            cursor,
            limit: 20,
          });
        }, abort.signal);
        if (value.sessionId !== sessionId || value.schemaVersion !== 1)
          throw new Error('Trace identity mismatch');
        if (!abort.signal.aborted) {
          setPage(value);
          setError(false);
        }
      } catch {
        if (!abort.signal.aborted) {
          setPage(undefined);
          setError(true);
        }
      } finally {
        inFlight = false;
      }
    };
    void read();
    const visibleRead = () => {
      if (document.visibilityState === 'visible') void read();
    };
    const timer = window.setInterval(visibleRead, 5_000);
    document.addEventListener('visibilitychange', visibleRead);
    return () => {
      abort.abort();
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visibleRead);
    };
  }, [provider, sessionId, clientId, ancestors, budget, cursor, running]);
  const items = page ? budget.admit(sessionId, page.items) : [];
  return (
    <div className="ml-3 space-y-2 border-l pl-3">
      {error && <p role="alert">{t('childUnavailable')}</p>}
      {!page && !error && <p role="status">{t('loading')}</p>}
      {page?.availability === 'partial' && <p role="status">{t('partial')}</p>}
      {page && items.length === 0 && !page.hasMore && <p>{t('empty')}</p>}
      {items.map((item) => (
        <Node
          key={`${sessionId}:${item.taskId}:${item.childSessionId ?? ''}`}
          {...{
            provider,
            sessionId,
            clientId,
            running,
            onOpenChild,
            ancestors,
            budget,
            depth,
            item,
          }}
        />
      ))}
      {page && items.length < page.items.length && (
        <p role="status">{t('treeLimit')}</p>
      )}
      {page?.hasMore && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setPage(undefined);
            setCursor(page.nextCursor ?? undefined);
          }}
        >
          {t('next')}
        </Button>
      )}
    </div>
  );
}

function Node({
  item,
  budget,
  ancestors,
  depth,
  ...props
}: Props & {
  item: Invocation;
  budget: Budget;
  ancestors: string[];
  depth: number;
}) {
  const t = useManagedDiagnosticsText();
  const [expansion, setExpansion] = useState<{
    budget: Budget;
    open: boolean;
  }>();
  const expanded = expansion?.budget === budget && expansion.open;
  const [usage, setUsage] = useState<ManagedDiagnosticStats>();
  const [usageSelection, setUsageSelection] = useState<{
    budget: Budget;
    open: boolean;
  }>();
  const usageOpen = usageSelection?.budget === budget && usageSelection.open;
  const [usageError, setUsageError] = useState(false);
  const child = item.childSessionId;
  const nodeRunning =
    props.running ||
    ![
      'completed',
      'failed',
      'cancelled',
      'settled',
      'success',
      'error',
    ].includes(item.state);
  const path = useMemo(
    () => [...ancestors, props.sessionId],
    [ancestors, props.sessionId],
  );
  const expandable =
    child &&
    depth < 8 &&
    !path.includes(child) &&
    budget.target(child, `${props.sessionId}:${item.taskId}`);
  useEffect(() => {
    if (!usageOpen || !child) return;
    const abort = new AbortController();
    setUsage(undefined);
    setUsageError(false);
    let inFlight = false;
    const read = async () => {
      if (inFlight || abort.signal.aborted) return;
      inFlight = true;
      await budget
        .run(async () => {
          for (const parent of path) {
            const permission = await props.provider.getStatistics(parent, {
              clientId: props.clientId,
              signal: abort.signal,
            });
            if (permission.sessionId !== parent)
              throw new Error('Ancestor identity mismatch');
          }
          return props.provider.getStatistics(child, {
            clientId: props.clientId,
            signal: abort.signal,
          });
        }, abort.signal)
        .then((value) => {
          if (!abort.signal.aborted) {
            if (value.sessionId !== child || value.schemaVersion !== 1)
              throw new Error('Usage identity mismatch');
            setUsage(value);
            setUsageError(false);
          }
        })
        .catch(() => {
          if (!abort.signal.aborted) {
            setUsage(undefined);
            setUsageError(true);
          }
        })
        .finally(() => {
          inFlight = false;
        });
    };
    void read();
    const visibleRead = () => {
      if (document.visibilityState === 'visible') void read();
    };
    const timer = window.setInterval(visibleRead, 5_000);
    document.addEventListener('visibilitychange', visibleRead);
    return () => {
      abort.abort();
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visibleRead);
    };
  }, [
    usageOpen,
    child,
    path,
    budget,
    props.provider,
    props.clientId,
    nodeRunning,
  ]);
  return (
    <div
      role="treeitem"
      aria-level={depth}
      aria-expanded={expandable ? expanded : undefined}
      className="space-y-2 rounded-md border p-3 text-sm"
    >
      <p className="break-words font-medium">
        {item.description ?? item.taskId}
      </p>
      <p>
        {t('state')} · {item.state} ·{' '}
        {new Date(item.createdAt).toLocaleString()}
      </p>
      {item.predecessorTaskId && (
        <p className="text-muted-foreground">
          {t('continuation')} · {item.predecessorTaskId}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {expandable && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setExpansion({ budget, open: !expanded })}
          >
            {t(expanded ? 'collapse' : 'expand')}
          </Button>
        )}
        {child && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setUsageSelection({ budget, open: !usageOpen })}
          >
            {t('ownUsage')}
          </Button>
        )}
        {child && props.onOpenChild && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => props.onOpenChild?.(child)}
          >
            {t('openChild')}
          </Button>
        )}
      </div>
      {!child && (
        <p className="text-muted-foreground">{t('childUnavailable')}</p>
      )}
      {child && !expandable && <p role="status">{t('treeLimit')}</p>}
      {usageOpen && child && (
        <div className="space-y-2">
          <p>{t('ownOnly')}</p>
          {usageError ? (
            <p role="alert">{t('failed')}</p>
          ) : !usage ? (
            <p role="status">{t('loading')}</p>
          ) : usage.statistics ? (
            <p>
              {t('requests')}: {usage.statistics.totals.requests.total} ·{' '}
              {t('totalTokens')}:{' '}
              {usage.statistics.totals.requests.total > 0 &&
              usage.statistics.totals.usageKnown.total === 0
                ? t('unknown')
                : usage.statistics.totals.tokens.total}
            </p>
          ) : (
            <p>{t('not_recorded')}</p>
          )}
        </div>
      )}
      {expanded && expandable && child && (
        <Branch
          {...props}
          sessionId={child}
          ancestors={path}
          budget={budget}
          depth={depth + 1}
          running={nodeRunning}
        />
      )}
    </div>
  );
}

export function ManagedInvocationTree({
  items,
  ...props
}: Props & { items: Invocation[] }) {
  const t = useManagedDiagnosticsText();
  const budget = useMemo(treeBudget, [
    props.provider,
    props.sessionId,
    props.clientId,
  ]);
  const ancestors = useMemo<string[]>(() => [], []);
  const admitted = budget.admit(props.sessionId, items);
  return (
    <div role="tree" aria-label="Agent invocations" className="space-y-3">
      {admitted.map((item) => (
        <Node
          key={`${props.sessionId}:${item.taskId}:${item.childSessionId ?? ''}`}
          {...props}
          item={item}
          budget={budget}
          ancestors={ancestors}
          depth={1}
        />
      ))}
      {admitted.length < items.length && <p role="status">{t('treeLimit')}</p>}
    </div>
  );
}
