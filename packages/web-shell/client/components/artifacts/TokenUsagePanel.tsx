import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRightIcon, RefreshCwIcon } from 'lucide-react';
import type {
  DaemonSessionActions,
  DaemonSessionStatsModelMetrics,
  DaemonSessionStatsSource,
  DaemonSessionStatsStatus,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { isSessionDisconnectedError } from '../../utils/sessionErrors';
import { formatDuration } from '../messages/StatsMessage';
import { localizeToolDisplayName } from '../messages/toolFormatting';
import styles from './TokenUsagePanel.module.css';

const POLL_INTERVAL_MS = 2_000;

interface TokenUsagePanelProps {
  sessionActions?: DaemonSessionActions;
  sessionId?: string;
}

type SegmentKey = 'input' | 'cached' | 'output' | 'thoughts';

interface Segment {
  key: SegmentKey;
  value: number;
}

interface ModelEntry {
  key: string;
  label: string;
  metrics: DaemonSessionStatsModelMetrics;
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

// Inline (not CSS Modules) so legend dots survive environments where the
// compiled local class names are lowercased and `styles['segmentInput']`
// resolves to undefined. Input/cache stay in one green family; output and
// thoughts get their own soft hues.
const SEGMENT_COLORS: Record<SegmentKey, string> = {
  input: 'var(--success-color)',
  cached: 'color-mix(in srgb, var(--success-color) 70%, var(--foreground))',
  output: 'var(--primary)',
  thoughts: 'var(--warning-color)',
};

function flattenModels(
  models: Record<string, DaemonSessionStatsModelMetrics>,
): ModelEntry[] {
  return Object.entries(models)
    .filter(([, m]) => m.api.totalRequests > 0)
    .map(([key, metrics]) => ({ key, label: key, metrics }))
    .sort(
      (a, b) => totalTokens(b.metrics.tokens) - totalTokens(a.metrics.tokens),
    );
}

function segmentsOf(m: {
  tokens: DaemonSessionStatsModelMetrics['tokens'];
}): Segment[] {
  const { thoughts, cached } = m.tokens;
  const raw: Segment[] = [
    { key: 'input', value: inputTokens(m.tokens) },
    { key: 'cached', value: cached },
    { key: 'output', value: outputTokens(m.tokens) },
    { key: 'thoughts', value: thoughts },
  ];
  return raw.filter((s) => s.value > 0);
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
          if (
            isSessionDisconnectedError(loadError) ||
            (loadError instanceof Error &&
              (loadError.name === 'DaemonTransportClosedError' ||
                /(?:fetch failed|failed to fetch|networkerror|load failed)/i.test(
                  loadError.message,
                )))
          ) {
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
    <div className={styles.panel}>
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
      return acc;
    },
    { prompt: 0, cached: 0, output: 0, thoughts: 0, total: 0 },
  );
  const grandTotal = totals.total;
  // Keep legacy daemon responses correctly ordered when total is omitted.
  const subagentEntries = [...(status.sources ?? [])].sort(
    (a, b) => totalTokens(b.tokens) - totalTokens(a.tokens),
  );

  return (
    <>
      <div className={styles.hero}>
        <div className={styles.heroHeader}>
          <div className={styles.heroValue}>{formatCompact(grandTotal)}</div>
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
        <div className={styles.legend}>
          <LegendEntry
            label={t('tokenUsage.input')}
            value={totals.prompt}
            color={SEGMENT_COLORS.input}
          />
          <LegendEntry
            label={t('tokenUsage.cached')}
            value={totals.cached}
            color={SEGMENT_COLORS.cached}
            percent={
              totals.cached > 0 && totals.prompt > 0
                ? `${((totals.cached / totals.prompt) * 100).toFixed(1)}%`
                : undefined
            }
          />
          <LegendEntry
            label={t('tokenUsage.output')}
            value={totals.output}
            color={SEGMENT_COLORS.output}
          />
          <LegendEntry
            label={t('tokenUsage.thoughts')}
            value={totals.thoughts}
            color={SEGMENT_COLORS.thoughts}
          />
        </div>
      </div>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{t('tokenUsage.models')}</h3>
        <div className={styles.modelList}>
          {entries.map((entry) => (
            <ModelCard key={entry.key} entry={entry} />
          ))}
        </div>
      </section>

      <details className={styles.section}>
        <summary className={styles.collapsibleSummary}>
          <h3 className={styles.sectionTitle}>{t('tokenUsage.subagents')}</h3>
          <ChevronRightIcon
            className={styles.collapseIcon}
            size={14}
            aria-hidden="true"
          />
        </summary>
        {subagentEntries.length > 0 ? (
          <div className={styles.subagentList}>
            {subagentEntries.map((source) => (
              <SubagentCard key={source.id} source={source} />
            ))}
          </div>
        ) : (
          <div className={styles.empty}>{t('tokenUsage.noSubagents')}</div>
        )}
      </details>

      <details className={styles.section}>
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
    </>
  );
}

function LegendEntry({
  label,
  value,
  color,
  percent,
}: {
  label: string;
  value: number;
  color?: string;
  percent?: string;
}) {
  if (value <= 0) return null;
  return (
    <span className={styles.legendEntry}>
      {color && (
        <span
          className={styles.legendSwatch}
          style={{ background: color }}
          aria-hidden="true"
        />
      )}
      <span className={styles.legendLabel}>{label}</span>
      <span className={styles.legendValue}>{formatCompact(value)}</span>
      {percent && <span className={styles.legendPercent}>{percent}</span>}
    </span>
  );
}

function ModelCard({ entry }: { entry: ModelEntry }) {
  const { t } = useI18n();
  const m = entry.metrics;
  const input = inputTokens(m.tokens);
  const avgLatency =
    m.api.totalRequests > 0 ? m.api.totalLatencyMs / m.api.totalRequests : 0;
  return (
    <div className={styles.modelCard}>
      <div className={styles.modelHeader}>
        <span className={styles.modelName} title={entry.key}>
          {entry.label}
        </span>
        <span className={styles.modelMeta}>
          {t('tokenUsage.requests')} {formatCount(m.api.totalRequests)}
          {m.api.totalRequests > 0 && (
            <>
              {' · '}
              {t('tokenUsage.avgLatency')} {formatDuration(avgLatency)}
            </>
          )}
        </span>
      </div>
      <div className={styles.modelBreakdown}>
        {segmentsOf(m).map((s) => (
          <LegendEntry
            key={s.key}
            label={t(`tokenUsage.${s.key}`)}
            value={s.value}
            color={SEGMENT_COLORS[s.key]}
            percent={
              s.key === 'cached' && input > 0
                ? `${((m.tokens.cached / input) * 100).toFixed(1)}%`
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}

function SubagentCard({ source }: { source: DaemonSessionStatsSource }) {
  const { t } = useI18n();
  const { tokens } = source;
  const input = inputTokens(tokens);
  return (
    <div className={styles.subagentCard}>
      <div className={styles.subagentHeader}>
        <span className={styles.subagentName} title={source.name}>
          {source.name}
        </span>
        {source.type && (
          <span className={styles.subagentType}>{source.type}</span>
        )}
      </div>
      <div className={styles.subagentBreakdown}>
        <LegendEntry
          label={t('tokenUsage.input')}
          value={input}
          color={SEGMENT_COLORS.input}
        />
        <LegendEntry
          label={t('tokenUsage.cached')}
          value={tokens.cached}
          color={SEGMENT_COLORS.cached}
          percent={
            input > 0
              ? `${((tokens.cached / input) * 100).toFixed(1)}%`
              : undefined
          }
        />
        <LegendEntry
          label={t('tokenUsage.output')}
          value={outputTokens(tokens)}
          color={SEGMENT_COLORS.output}
        />
        <LegendEntry
          label={t('tokenUsage.thoughts')}
          value={tokens.thoughts}
          color={SEGMENT_COLORS.thoughts}
        />
      </div>
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
