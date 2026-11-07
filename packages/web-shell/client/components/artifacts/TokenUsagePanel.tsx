import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  CircleAlertIcon,
  CircleCheckIcon,
  ChevronRightIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import type {
  DaemonSessionActions,
  DaemonSessionStatsModelMetrics,
  DaemonSessionStatsStatus,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { isTransientSessionReadError } from '../../utils/sessionErrors';
import { formatDuration } from '../messages/StatsMessage';
import {
  localizeAgentTypeName,
  localizeToolDisplayName,
} from '../messages/toolFormatting';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
import styles from './TokenUsagePanel.module.css';
import {
  SpeedSpread,
  TokenUsageTrend,
  sampleSpeed,
  type TrendSeries,
} from './TokenUsageTrend';

const POLL_INTERVAL_MS = 2_000;
/** Distinct series colors; later models share a neutral color. */
const MODEL_COLOR_COUNT = 6;

interface TokenUsagePanelProps {
  sessionActions?: DaemonSessionActions;
  sessionId?: string;
}

interface ModelEntry {
  key: string;
  label: string;
  metrics: DaemonSessionStatsModelMetrics;
  /** Color slot by first use, so a model keeps its color as ranks change. */
  color: string;
}

function inputTokens(tokens: DaemonSessionStatsModelMetrics['tokens']): number {
  return tokens.prompt > 0 ? tokens.prompt : tokens.cached;
}

function totalTokens(tokens: DaemonSessionStatsModelMetrics['tokens']): number {
  const input = inputTokens(tokens);
  return tokens.total > 0
    ? Math.max(tokens.total, input + tokens.candidates)
    : input + tokens.candidates + tokens.thoughts;
}

function outputTokens(
  tokens: DaemonSessionStatsModelMetrics['tokens'],
): number {
  return Math.max(0, totalTokens(tokens) - inputTokens(tokens));
}

function flattenModels(
  models: Record<string, DaemonSessionStatsModelMetrics>,
): ModelEntry[] {
  // The daemon serializes models in first-request order.
  return Object.entries(models)
    .filter(([, m]) => m.api.totalRequests > 0)
    .map(([key, metrics], index) => ({
      key,
      label: key,
      metrics,
      color: index < MODEL_COLOR_COUNT ? String(index) : 'other',
    }))
    .sort(
      (a, b) => totalTokens(b.metrics.tokens) - totalTokens(a.metrics.tokens),
    );
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** Compact token counts: 1,390,000 → "1.39M", 199,076 → "199.1K". */
function formatCompact(n: number): string {
  if (n >= 999_995_000) return trimZeros((n / 1_000_000_000).toFixed(2)) + 'B';
  if (n >= 999_950) return trimZeros((n / 1_000_000).toFixed(2)) + 'M';
  if (n >= 1_000) return trimZeros((n / 1_000).toFixed(1)) + 'K';
  return String(n);
}

function trimZeros(value: string): string {
  return value.replace(/\.?0+$/, '');
}

interface RequestOutcome {
  requests: number;
  failed: number;
}

function successRate({ requests, failed }: RequestOutcome): number {
  return requests > 0 ? ((requests - failed) / requests) * 100 : 100;
}

function formatRate(rate: number): string {
  return rate === 100 ? '100%' : `${Math.min(rate, 99.9).toFixed(1)}%`;
}

type OutcomeLevel = 'ok' | 'warning' | 'error';

function outcomeLevel(rate: number): OutcomeLevel {
  if (rate === 100) return 'ok';
  return rate >= 90 ? 'warning' : 'error';
}

const OUTCOME_ICONS = {
  ok: CircleCheckIcon,
  warning: TriangleAlertIcon,
  error: CircleAlertIcon,
} as const;

/** Output tokens per second over every timed generation window. */
function outputSpeed(
  generation: DaemonSessionStatsModelMetrics['generation'],
): number | undefined {
  return generation && generation.totalGenerationDurationMs > 0
    ? generation.totalThroughputOutputTokens /
        (generation.totalGenerationDurationMs / 1000)
    : undefined;
}

export function TokenUsagePanel({
  sessionActions,
  sessionId,
}: TokenUsagePanelProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<DaemonSessionStatsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionMismatch, setSessionMismatch] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number>(0);
  const refreshInFlightRef = useRef(false);
  const pollingPausedRef = useRef(false);
  const mountedRef = useRef(true);

  const refresh = useCallback(
    (manual = false) => {
      if (
        !sessionActions ||
        refreshInFlightRef.current ||
        (!manual && pollingPausedRef.current)
      )
        return;
      if (manual) pollingPausedRef.current = false;
      refreshInFlightRef.current = true;
      sessionActions
        .getStats()
        .then((snapshot) => {
          if (!mountedRef.current) return;
          if (sessionId && snapshot.sessionId !== sessionId) {
            setStatus(null);
            setSessionMismatch(true);
            setError(null);
            return;
          }
          setSessionMismatch(false);
          setStatus(snapshot);
          setLastUpdated(Date.now());
          setError(null);
        })
        .catch((loadError: unknown) => {
          if (!mountedRef.current) return;
          if (isTransientSessionReadError(loadError)) {
            setError(null);
            return;
          }
          pollingPausedRef.current = true;
          setError(
            loadError instanceof Error
              ? loadError.message
              : t('tokenUsage.loadError'),
          );
        })
        .finally(() => {
          refreshInFlightRef.current = false;
        });
    },
    [sessionActions, sessionId, t],
  );

  useEffect(() => {
    mountedRef.current = true;
    if (!sessionActions) {
      return () => {
        mountedRef.current = false;
      };
    }
    pollingPausedRef.current = false;
    setSessionMismatch(false);
    refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
    };
  }, [refresh, sessionActions]);

  const hasModels = status !== null && flattenModels(status.models).length > 0;

  return (
    <div className={styles.panel} data-testid="token-usage-panel">
      {error ? (
        <div className={styles.error} role="alert">
          <span>{error}</span>
          <button
            type="button"
            className={styles.retryButton}
            onClick={() => refresh(true)}
          >
            {t('tokenUsage.retry')}
          </button>
        </div>
      ) : !sessionActions || sessionMismatch ? (
        <div className={styles.empty}>{t('tokenUsage.unavailable')}</div>
      ) : status === null ? (
        <div className={styles.empty}>{t('common.loading')}</div>
      ) : !hasModels ? (
        <div className={styles.empty}>{t('tokenUsage.noData')}</div>
      ) : (
        <TokenUsageBody
          status={status!}
          lastUpdated={lastUpdated}
          onRefresh={() => refresh(true)}
        />
      )}
    </div>
  );
}

function TokenUsageBody({
  status,
  lastUpdated,
  onRefresh,
}: {
  status: DaemonSessionStatsStatus;
  lastUpdated: number;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const entries = flattenModels(status.models);
  const totals = entries.reduce(
    (acc, e) => {
      acc.prompt += inputTokens(e.metrics.tokens);
      acc.cached += e.metrics.tokens.cached;
      acc.output += outputTokens(e.metrics.tokens);
      acc.thoughts += e.metrics.tokens.thoughts;
      acc.total += totalTokens(e.metrics.tokens);
      acc.requests += e.metrics.api.totalRequests;
      acc.failed += e.metrics.api.totalErrors;
      const g = e.metrics.generation;
      if (g) {
        acc.generation.timedRequests += g.timedRequests;
        acc.generation.totalTtftMs += g.totalTtftMs;
        acc.generation.totalGenerationDurationMs += g.totalGenerationDurationMs;
        acc.generation.totalThroughputOutputTokens +=
          g.totalThroughputOutputTokens;
      }
      return acc;
    },
    {
      prompt: 0,
      cached: 0,
      output: 0,
      thoughts: 0,
      total: 0,
      requests: 0,
      failed: 0,
      generation: {
        timedRequests: 0,
        totalTtftMs: 0,
        totalGenerationDurationMs: 0,
        totalThroughputOutputTokens: 0,
      },
    },
  );
  const grandTotal = totals.total;
  const trendSeries: TrendSeries[] = entries
    .map((entry) => ({
      key: entry.key,
      label: entry.label,
      color: entry.color,
      samples: entry.metrics.timingSamples ?? [],
      failures: entry.metrics.failures?.recent ?? [],
    }))
    .filter((s) => s.samples.length > 0 || s.failures.length > 0);
  // One scale for every card's spread so their positions compare directly.
  const speedScaleMax = Math.max(
    0,
    ...trendSeries.flatMap((s) =>
      s.samples.map((sample) => sampleSpeed(sample) ?? 0),
    ),
  );
  // Keep legacy daemon responses correctly ordered when total is omitted.
  const subagentEntries = [...(status.sources ?? [])].sort(
    (a, b) => totalTokens(b.tokens) - totalTokens(a.tokens),
  );
  const mainRemainder = subagentEntries.reduce(
    (remaining, { tokens }) => ({
      prompt: Math.max(0, remaining.prompt - inputTokens(tokens)),
      total: Math.max(0, remaining.total - totalTokens(tokens)),
      cached: Math.max(0, remaining.cached - tokens.cached),
      thoughts: Math.max(0, remaining.thoughts - tokens.thoughts),
    }),
    {
      prompt: totals.prompt,
      total: grandTotal,
      cached: totals.cached,
      thoughts: totals.thoughts,
    },
  );
  const mainInput = Math.min(mainRemainder.prompt, mainRemainder.total);
  const mainOutput = mainRemainder.total - mainInput;
  const mainTokens = {
    prompt: mainInput,
    // Normalized output keeps the legacy fallback from adding reasoning again.
    candidates: mainOutput,
    total: mainRemainder.total,
    cached: Math.min(mainRemainder.cached, mainInput),
    thoughts: Math.min(mainRemainder.thoughts, mainOutput),
  };

  return (
    <TooltipProvider delayDuration={300} disableHoverableContent>
      <div className={styles.hero}>
        <div className={styles.heroHeader}>
          <div className={styles.heroValue}>
            {formatCompact(grandTotal)}
            <span className={styles.heroLabel}>{t('tokenUsage.total')}</span>
          </div>
          <span className={styles.heroMeta}>
            <button
              type="button"
              className={styles.refreshButton}
              aria-label={t('tokenUsage.refresh')}
              title={t('tokenUsage.refresh')}
              onClick={onRefresh}
            >
              <RefreshCwIcon size={14} aria-hidden="true" />
            </button>
            {lastUpdated > 0 && (
              <span className={styles.updatedAt}>
                {t('tokenUsage.updatedAt', {
                  time: new Date(lastUpdated).toLocaleTimeString(),
                })}
              </span>
            )}
          </span>
        </div>
        <TokenSummary
          input={totals.prompt}
          output={totals.output}
          cached={totals.cached}
          thoughts={totals.thoughts}
          outcome={{ requests: totals.requests, failed: totals.failed }}
          generation={totals.generation}
        />
      </div>

      {trendSeries.length > 0 && (
        <section className={`${styles.section} ${styles.modelSection}`}>
          <TokenUsageTrend series={trendSeries} />
        </section>
      )}

      <section className={`${styles.section} ${styles.modelSection}`}>
        <h3 className={styles.sectionTitle}>{t('tokenUsage.models')}</h3>
        {entries.length > 1 && (
          <ModelShares entries={entries} grandTotal={grandTotal} />
        )}
        <div className={styles.modelList}>
          {entries.map((entry) => (
            <ModelCard
              key={entry.key}
              entry={entry}
              grandTotal={grandTotal}
              speedScaleMax={speedScaleMax}
            />
          ))}
        </div>
      </section>

      {status.sources !== undefined && (
        <details className={`${styles.section} ${styles.detailSection}`}>
          <summary className={styles.collapsibleSummary}>
            <h3 className={styles.sectionTitle}>{t('tokenUsage.agents')}</h3>
            <ChevronRightIcon
              className={styles.collapseIcon}
              size={14}
              aria-hidden="true"
            />
          </summary>
          <div className={styles.subagentList}>
            <AgentCard
              name={t('tokenUsage.mainAgent')}
              tokens={mainTokens}
              grandTotal={grandTotal}
            />
            {subagentEntries.map((source) => (
              <AgentCard
                key={source.id}
                sourceId={source.id}
                name={source.name}
                type={source.type}
                tokens={source.tokens}
                grandTotal={grandTotal}
              />
            ))}
          </div>
        </details>
      )}

      {status.tools.byName !== undefined && (
        <details className={`${styles.section} ${styles.detailSection}`}>
          <summary className={styles.collapsibleSummary}>
            <h3 className={styles.sectionTitle}>{t('tokenUsage.tools')}</h3>
            <ChevronRightIcon
              className={styles.collapseIcon}
              size={14}
              aria-hidden="true"
            />
          </summary>
          <ToolList status={status} />
        </details>
      )}
    </TooltipProvider>
  );
}

function ModelShares({
  entries,
  grandTotal,
}: {
  entries: ModelEntry[];
  grandTotal: number;
}) {
  const { t } = useI18n();
  const shares = entries.map((entry) => ({
    entry,
    share:
      grandTotal > 0
        ? (totalTokens(entry.metrics.tokens) / grandTotal) * 100
        : 0,
  }));
  return (
    <div className={styles.modelShares} data-testid="token-usage-model-shares">
      <div
        className={styles.shareStack}
        role="img"
        aria-label={t('tokenUsage.modelSharesLabel')}
      >
        {shares.map(({ entry, share }) =>
          share > 0 ? (
            <div
              key={entry.key}
              className={styles.shareSegment}
              data-share-color={entry.color}
              style={{ flexGrow: share }}
            />
          ) : null,
        )}
      </div>
      <ul className={styles.shareLegend}>
        {shares.map(({ entry, share }) => (
          <li key={entry.key} data-share-color={entry.color}>
            <span className={styles.shareSwatch} aria-hidden="true" />
            <span className={styles.shareLegendName} title={entry.key}>
              {entry.label}
            </span>
            <span className={styles.shareLegendValue}>{share.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Success rate, or `detail` in its place, behind a status icon. */
function SuccessRateValue({
  outcome,
  detail,
}: {
  outcome: RequestOutcome;
  detail?: string;
}) {
  const { t } = useI18n();
  const rate = successRate(outcome);
  const level = outcomeLevel(rate);
  const Icon = OUTCOME_ICONS[level];
  return (
    <span
      className={styles.outcome}
      data-level={level}
      title={
        detail ??
        t('tokenUsage.successDetail', {
          failed: formatCount(outcome.failed),
          requests: formatCount(outcome.requests),
        })
      }
    >
      <Icon size={12} aria-hidden="true" />
      {detail ?? formatRate(rate)}
    </span>
  );
}

function ModelCard({
  entry,
  grandTotal,
  speedScaleMax,
}: {
  entry: ModelEntry;
  grandTotal: number;
  speedScaleMax: number;
}) {
  const { t } = useI18n();
  const m = entry.metrics;
  const total = totalTokens(m.tokens);
  const share = grandTotal > 0 ? (total / grandTotal) * 100 : 0;
  const avgLatency =
    m.api.totalRequests > 0 ? m.api.totalLatencyMs / m.api.totalRequests : 0;
  const { generation } = m;
  const timing =
    generation && generation.timedRequests > 0
      ? {
          ttft: generation.totalTtftMs / generation.timedRequests,
          // Averaged over the same requests as TTFT so the two add up to
          // their latency; Avg latency also counts failed, internal
          // and non-streamed requests.
          generation:
            generation.totalGenerationDurationMs / generation.timedRequests,
          speed: outputSpeed(generation),
        }
      : undefined;
  const stats: Array<{ label: string; value: string; node?: ReactNode }> = [
    ...(timing
      ? [
          {
            label: t('tokenUsage.firstToken'),
            value: formatDuration(timing.ttft),
          },
          ...(timing.speed !== undefined
            ? [
                {
                  label: t('tokenUsage.outputSpeed'),
                  value: t('tokenUsage.tokensPerSecond', {
                    rate: timing.speed.toFixed(1),
                  }),
                },
                {
                  label: t('tokenUsage.generation'),
                  value: formatDuration(timing.generation),
                },
              ]
            : []),
        ]
      : []),
    {
      label: t('tokenUsage.requests'),
      value: formatCount(m.api.totalRequests),
    },
    {
      label: t('tokenUsage.successRate'),
      value: formatRate(
        successRate({
          requests: m.api.totalRequests,
          failed: m.api.totalErrors,
        }),
      ),
      node: (
        <SuccessRateValue
          outcome={{ requests: m.api.totalRequests, failed: m.api.totalErrors }}
        />
      ),
    },
    { label: t('tokenUsage.avgLatency'), value: formatDuration(avgLatency) },
  ];
  return (
    <div className={styles.modelCard} data-color={entry.color}>
      <div className={styles.modelHeader}>
        <div className={styles.modelName} title={entry.key}>
          {entry.label}
        </div>
      </div>
      <dl className={styles.modelStats}>
        {stats.map(({ label, value, node }) => (
          <div key={label}>
            <dt title={label}>{label}</dt>
            <dd title={value}>{node ?? value}</dd>
          </div>
        ))}
      </dl>
      {m.timingSamples && (
        <SpeedSpread samples={m.timingSamples} scaleMax={speedScaleMax} />
      )}
      {m.failures && Object.keys(m.failures.byKind).length > 0 && (
        <FailureKinds byKind={m.failures.byKind} />
      )}
      <TokenDetails tokens={m.tokens} />
      <ShareBar share={share} />
    </div>
  );
}

function FailureKinds({ byKind }: { byKind: Record<string, number> }) {
  const { t } = useI18n();
  const text = t('tokenUsage.failuresByKind', {
    kinds: Object.entries(byKind)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([kind, count]) => `${kind} ×${formatCount(count)}`)
      .join(' · '),
  });
  return (
    <div className={styles.failureKinds} title={text}>
      {text}
    </div>
  );
}

function ShareBar({ share }: { share: number }) {
  const { t } = useI18n();
  const [shareOpen, setShareOpen] = useState(false);
  const label = t('tokenUsage.shareTooltip', { percent: share.toFixed(1) });
  return (
    <div className={styles.shareRow}>
      <Tooltip open={shareOpen} onOpenChange={setShareOpen}>
        <TooltipTrigger asChild>
          <div
            className={styles.shareTrack}
            role="img"
            aria-label={label}
            tabIndex={0}
            onClick={(event) => {
              event.preventDefault();
              setShareOpen(true);
            }}
          >
            <div className={styles.shareFill} style={{ width: `${share}%` }} />
          </div>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          sideOffset={6}
          style={{ pointerEvents: 'none' }}
        >
          {label}
        </TooltipContent>
      </Tooltip>
      <span className={styles.modelShare}>{share.toFixed(1)}%</span>
    </div>
  );
}

function TokenSummary({
  input,
  output,
  cached,
  thoughts,
  outcome,
  generation,
}: {
  input: number;
  output: number;
  cached: number;
  thoughts: number;
  outcome: RequestOutcome;
  generation: NonNullable<DaemonSessionStatsModelMetrics['generation']>;
}) {
  const { t } = useI18n();
  const speed = outputSpeed(generation);
  return (
    <dl className={styles.overview}>
      <div className={styles.summaryMetric}>
        <dt className={styles.inputLabel}>{t('tokenUsage.input')}</dt>
        <dd>
          <strong className={styles.summaryValue}>
            {formatCompact(input)}
          </strong>
          <span className={styles.summaryCaption}>
            {t('tokenUsage.cachedDetail', {
              count: formatCompact(cached),
              percent: input > 0 ? ((cached / input) * 100).toFixed(1) : '0.0',
            })}
          </span>
        </dd>
      </div>
      <div className={styles.summaryMetric}>
        <dt className={styles.outputLabel}>{t('tokenUsage.output')}</dt>
        <dd>
          <strong className={styles.summaryValue}>
            {formatCompact(output)}
          </strong>
          <span className={styles.summaryCaption}>
            {t('tokenUsage.thoughtsDetail', { count: formatCompact(thoughts) })}
          </span>
        </dd>
      </div>
      <div className={styles.summaryMetric}>
        <dt
          className={styles.summaryLabel}
          title={t('tokenUsage.successRateHint')}
        >
          {t('tokenUsage.successRate')}
        </dt>
        <dd>
          <strong className={styles.summaryValue}>
            {formatRate(successRate(outcome))}
          </strong>
          <span className={styles.summaryCaption}>
            <SuccessRateValue
              outcome={outcome}
              detail={t('tokenUsage.successDetail', {
                failed: formatCount(outcome.failed),
                requests: formatCount(outcome.requests),
              })}
            />
          </span>
        </dd>
      </div>
      {speed !== undefined && (
        <div className={styles.summaryMetric}>
          <dt className={styles.summaryLabel}>{t('tokenUsage.outputSpeed')}</dt>
          <dd>
            <strong className={styles.summaryValue}>
              {speed.toFixed(1)}
              <span className={styles.summaryUnit}> tok/s</span>
            </strong>
            <span className={styles.summaryCaption}>
              {t('tokenUsage.firstTokenDetail', {
                duration: formatDuration(
                  generation.totalTtftMs / generation.timedRequests,
                ),
              })}
            </span>
          </dd>
        </div>
      )}
    </dl>
  );
}

function TokenDetails({
  tokens,
}: {
  tokens: DaemonSessionStatsModelMetrics['tokens'];
}) {
  const { t } = useI18n();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const input = inputTokens(tokens);
  const output = outputTokens(tokens);
  const { cached, thoughts } = tokens;
  const cacheRate = input > 0 ? ((cached / input) * 100).toFixed(1) : '0.0';
  const metrics = [
    { label: t('tokenUsage.input'), value: formatCompact(input) },
    {
      label: t('tokenUsage.cached'),
      value: t('tokenUsage.valueWithRate', {
        count: formatCompact(cached),
        percent: cacheRate,
      }),
    },
    { label: t('tokenUsage.output'), value: formatCompact(output) },
    { label: t('tokenUsage.thoughts'), value: formatCompact(thoughts) },
  ];

  return (
    <Tooltip open={detailsOpen} onOpenChange={setDetailsOpen}>
      <TooltipTrigger asChild>
        <dl
          className={styles.tokenDetails}
          tabIndex={0}
          onClick={(event) => {
            event.preventDefault();
            setDetailsOpen(true);
          }}
        >
          <div>
            <dt>{t('tokenUsage.input')}</dt>
            <dd>
              {t('tokenUsage.inputWithCacheRate', {
                count: formatCompact(input),
                percent: cacheRate,
              })}
            </dd>
          </div>
          <div>
            <dt>{t('tokenUsage.output')}</dt>
            <dd>{formatCompact(output)}</dd>
          </div>
        </dl>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        <dl className={styles.tokenDetailsTooltip}>
          {metrics.map(({ label, value }) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </TooltipContent>
    </Tooltip>
  );
}

function AgentCard({
  sourceId,
  name,
  type,
  tokens,
  grandTotal,
}: {
  sourceId?: string;
  name: string;
  type?: string;
  tokens: DaemonSessionStatsModelMetrics['tokens'];
  grandTotal: number;
}) {
  const { t } = useI18n();
  const typeName = type ? localizeAgentTypeName(type, t) : '';
  const total = totalTokens(tokens);
  const share = grandTotal > 0 ? (total / grandTotal) * 100 : 0;
  return (
    <div
      className={styles.subagentCard}
      data-source-id={sourceId}
      data-main-agent={sourceId === undefined ? true : undefined}
      title={sourceId}
    >
      <div className={styles.subagentHeader}>
        <span className={styles.subagentName} title={name}>
          {name}
        </span>
        {typeName && typeName.toLowerCase() !== name.toLowerCase() && (
          <span className={styles.subagentType} title={typeName}>
            {typeName}
          </span>
        )}
      </div>
      <TokenDetails tokens={tokens} />
      <ShareBar share={share} />
    </div>
  );
}

function ToolList({ status }: { status: DaemonSessionStatsStatus }) {
  const { t } = useI18n();
  const { tools } = status;
  const entries = Object.entries(tools.byName ?? {})
    .filter(([, s]) => s.count > 0)
    .sort((a, b) => b[1].count - a[1].count);
  if (entries.length === 0) {
    return <div className={styles.empty}>{t('tokenUsage.noTools')}</div>;
  }
  return (
    <div className={styles.toolList}>
      {entries.map(([name, s]) => {
        const rate = (s.success / s.count) * 100;
        const avg = s.durationMs / s.count;
        const displayName = localizeToolDisplayName(name, t);
        return (
          <div key={name} className={styles.toolCard}>
            <div className={styles.toolHeader}>
              <span className={styles.toolName} title={name}>
                {displayName}
                {displayName !== name && (
                  <span className={styles.toolWireName}>({name})</span>
                )}
              </span>
              <span className={styles.toolMeta}>
                {t('tokenUsage.toolRow', {
                  count: formatCount(s.count),
                  rate: rate.toFixed(0),
                  duration: formatDuration(avg),
                })}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
