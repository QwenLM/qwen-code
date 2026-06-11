import type {
  DaemonSessionStatsStatus,
  DaemonSessionStatsModelMetrics,
  DaemonSessionStatsToolByName,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import styles from './StatsMessage.module.css';

const SENTINEL = 'web-shell:session-stats:v1:';

export type StatsView = 'overview' | 'model' | 'tools';

interface ParsedStats {
  view: StatsView;
  status: DaemonSessionStatsStatus;
}

export function serializeStatsMessage(
  status: DaemonSessionStatsStatus,
  view: StatsView = 'overview',
): string {
  return `${SENTINEL}${JSON.stringify({ _view: view, ...status })}`;
}

export function parseStatsMessage(content: string): ParsedStats | null {
  if (!content.startsWith(SENTINEL)) return null;
  try {
    const parsed = JSON.parse(content.slice(SENTINEL.length));
    if (!parsed || typeof parsed.durationMs !== 'number') return null;
    const view: StatsView = parsed._view ?? 'overview';
    delete parsed._view;
    return { view, status: parsed as DaemonSessionStatsStatus };
  } catch {
    return null;
  }
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(' ') || '0s';
}

// ── Shared layout components ──────────────────────────────────────

function KvRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.kvRow}>
      <span className={styles.kvLabel}>{label}</span>
      <span className={styles.kvValue}>{children}</span>
    </div>
  );
}

function KvSubRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.kvSubRow}>
      <span className={styles.secondary}>
        {'»'} {label}
      </span>
      <span className={styles.kvValue}>{children}</span>
    </div>
  );
}

// ── Pivoted table components (for /stats model) ───────────────────

interface ModelEntry {
  key: string;
  label: string;
  metrics: DaemonSessionStatsModelMetrics;
}

function flattenModels(
  models: Record<string, DaemonSessionStatsModelMetrics>,
): ModelEntry[] {
  return Object.entries(models)
    .filter(([, m]) => m.api.totalRequests > 0)
    .map(([key, metrics]) => {
      const parts = key.split('::');
      const modelName = parts[0]!;
      const source = parts[1];
      const label = source ? `${modelName} (${source})` : modelName;
      return { key, label, metrics };
    });
}

function calculateErrorRate(m: DaemonSessionStatsModelMetrics): number {
  return m.api.totalRequests === 0
    ? 0
    : (m.api.totalErrors / m.api.totalRequests) * 100;
}

function calculateAvgLatency(m: DaemonSessionStatsModelMetrics): number {
  return m.api.totalRequests === 0
    ? 0
    : m.api.totalLatencyMs / m.api.totalRequests;
}

function calculateCacheHitRate(m: DaemonSessionStatsModelMetrics): number {
  return m.tokens.prompt === 0 ? 0 : (m.tokens.cached / m.tokens.prompt) * 100;
}

function PivotRow({
  metric,
  values,
  variant = 'normal',
}: {
  metric: string;
  values: React.ReactNode[];
  variant?: 'normal' | 'section' | 'sub';
}) {
  const cellClass =
    variant === 'section'
      ? styles.metricCellSection
      : variant === 'sub'
        ? styles.metricCellSub
        : styles.metricCell;
  return (
    <div className={styles.pivotRow}>
      <span className={cellClass}>
        {variant === 'sub' ? `↳ ${metric}` : metric}
      </span>
      {values.map((v, i) => (
        <span key={i} className={styles.modelCell}>
          {v}
        </span>
      ))}
    </div>
  );
}

// ── /stats (overview) ─────────────────────────────────────────────

function StatsOverview({ status }: { status: DaemonSessionStatsStatus }) {
  const { t } = useI18n();
  const { models, tools, files } = status;

  const totalApiTime = Object.values(models).reduce(
    (acc, m) => acc + m.api.totalLatencyMs,
    0,
  );
  const totalToolTime = tools.totalDurationMs;
  const agentActiveTime = totalApiTime + totalToolTime;
  const apiPercent =
    agentActiveTime > 0 ? (totalApiTime / agentActiveTime) * 100 : 0;
  const toolPercent =
    agentActiveTime > 0 ? (totalToolTime / agentActiveTime) * 100 : 0;
  const successRate =
    tools.totalCalls > 0 ? (tools.totalSuccess / tools.totalCalls) * 100 : 0;

  const entries = flattenModels(models);
  const totalCached = entries.reduce(
    (acc, e) => acc + e.metrics.tokens.cached,
    0,
  );
  const totalPromptTokens = entries.reduce(
    (acc, e) => acc + e.metrics.tokens.prompt,
    0,
  );
  const cacheEfficiency =
    totalPromptTokens > 0 ? (totalCached / totalPromptTokens) * 100 : 0;

  return (
    <div className={styles.panel}>
      <div className={styles.title}>{t('stats.title')}</div>

      <div className={styles.sectionTitle}>{t('stats.overview')}</div>
      <KvRow label={t('stats.duration')}>
        {formatDuration(status.durationMs)}
      </KvRow>
      <KvRow label={t('stats.prompts')}>{status.promptCount}</KvRow>
      <KvRow label={t('stats.toolCalls')}>
        <span>
          {tools.totalCalls} <span className={styles.secondary}>(</span>
          <span className={styles.success}>
            {'✓'}
            {tools.totalSuccess}
          </span>{' '}
          <span className={styles.error}>
            {'✗'}
            {tools.totalFail}
          </span>
          <span className={styles.secondary}>)</span>
        </span>
      </KvRow>
      <KvRow label={t('stats.successRate')}>
        <span
          className={
            successRate >= 90
              ? styles.success
              : successRate >= 70
                ? styles.warning
                : styles.error
          }
        >
          {successRate.toFixed(1)}%
        </span>
      </KvRow>
      {(files.totalLinesAdded > 0 || files.totalLinesRemoved > 0) && (
        <KvRow label={t('stats.codeChanges')}>
          <span>
            <span className={styles.success}>+{files.totalLinesAdded}</span>{' '}
            <span className={styles.error}>-{files.totalLinesRemoved}</span>
          </span>
        </KvRow>
      )}

      <div className={styles.spacer} />
      <div className={styles.sectionTitle}>{t('stats.performance')}</div>
      <KvSubRow label={t('stats.apiTime')}>
        {formatDuration(totalApiTime)}{' '}
        <span className={styles.secondary}>({apiPercent.toFixed(1)}%)</span>
      </KvSubRow>
      <KvSubRow label={t('stats.toolTime')}>
        {formatDuration(totalToolTime)}{' '}
        <span className={styles.secondary}>({toolPercent.toFixed(1)}%)</span>
      </KvSubRow>

      {/* Simple model usage table */}
      {entries.length > 0 && (
        <>
          <div className={styles.spacer} />
          <div className={styles.sectionTitle}>{t('stats.modelUsage')}</div>
          <div className={styles.spacer} />

          {/* Header */}
          <div className={styles.tableRow}>
            <span className={styles.tableNameCol}>{t('stats.modelUsage')}</span>
            <span className={styles.tableNumCol}>{t('stats.reqs')}</span>
            <span className={styles.tableNumCol}>{t('stats.inputTokens')}</span>
            <span className={styles.tableNumCol}>
              {t('stats.outputTokens')}
            </span>
          </div>
          <div className={styles.divider} />

          {/* Rows */}
          {entries.map((e) => (
            <div key={e.key} className={styles.tableRow}>
              <span className={styles.tableNameCol}>{e.label}</span>
              <span className={styles.tableNumCol}>
                {e.metrics.api.totalRequests}
              </span>
              <span className={`${styles.tableNumCol} ${styles.warning}`}>
                {e.metrics.tokens.prompt.toLocaleString()}
              </span>
              <span className={`${styles.tableNumCol} ${styles.warning}`}>
                {e.metrics.tokens.candidates.toLocaleString()}
              </span>
            </div>
          ))}

          {cacheEfficiency > 0 && (
            <>
              <div className={styles.spacer} />
              <div>
                <span className={styles.success}>
                  {t('stats.savingsHighlight')}
                </span>{' '}
                {totalCached.toLocaleString()} ({cacheEfficiency.toFixed(1)}%){' '}
                {t('stats.cacheDesc')}
              </div>
              <div className={styles.secondary}>
                {'»'} {t('stats.modelTip')}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ── /stats model (pivoted model table) ────────────────────────────

function ModelStatsCard({ status }: { status: DaemonSessionStatsStatus }) {
  const { t } = useI18n();
  const entries = flattenModels(status.models);

  if (entries.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.title}>{t('stats.modelStats')}</div>
        <div>{t('stats.noApiCalls')}</div>
      </div>
    );
  }

  const hasCached = entries.some((e) => e.metrics.tokens.cached > 0);
  const hasThoughts = entries.some((e) => e.metrics.tokens.thoughts > 0);

  const vals = (fn: (m: DaemonSessionStatsModelMetrics) => React.ReactNode) =>
    entries.map((e) => fn(e.metrics));

  return (
    <div className={styles.panel}>
      <div className={styles.title}>{t('stats.modelStats')}</div>
      <div className={styles.spacer} />

      {/* Header row */}
      <div className={styles.pivotRow}>
        <span className={styles.metricCellSection}>{t('stats.metric')}</span>
        {entries.map((e) => (
          <span key={e.key} className={styles.modelCellHeader}>
            {e.label}
          </span>
        ))}
      </div>
      <div className={styles.divider} />

      {/* API section */}
      <PivotRow metric={t('stats.api')} values={[]} variant="section" />
      <PivotRow
        metric={t('stats.requests')}
        values={vals((m) => m.api.totalRequests.toLocaleString())}
      />
      <PivotRow
        metric={t('stats.errors')}
        values={vals((m) => {
          const rate = calculateErrorRate(m);
          return (
            <span className={m.api.totalErrors > 0 ? styles.error : undefined}>
              {m.api.totalErrors.toLocaleString()} ({rate.toFixed(1)}%)
            </span>
          );
        })}
      />
      <PivotRow
        metric={t('stats.avgLatency')}
        values={vals((m) => formatDuration(calculateAvgLatency(m)))}
      />

      <div className={styles.spacer} />

      {/* Tokens section */}
      <PivotRow metric={t('stats.tokens')} values={[]} variant="section" />
      <PivotRow
        metric={t('stats.total')}
        values={vals((m) => (
          <span className={styles.warning}>
            {m.tokens.total.toLocaleString()}
          </span>
        ))}
      />
      <PivotRow
        metric={t('stats.prompt')}
        values={vals((m) => m.tokens.prompt.toLocaleString())}
        variant="sub"
      />
      {hasCached && (
        <PivotRow
          metric={t('stats.cached')}
          values={vals((m) => (
            <span className={styles.success}>
              {m.tokens.cached.toLocaleString()} (
              {calculateCacheHitRate(m).toFixed(1)}%)
            </span>
          ))}
          variant="sub"
        />
      )}
      {hasThoughts && (
        <PivotRow
          metric={t('stats.thoughts')}
          values={vals((m) => m.tokens.thoughts.toLocaleString())}
          variant="sub"
        />
      )}
      <PivotRow
        metric={t('stats.output')}
        values={vals((m) => m.tokens.candidates.toLocaleString())}
        variant="sub"
      />
    </div>
  );
}

// ── /stats tools (per-tool table) ─────────────────────────────────

interface ToolEntry {
  name: string;
  stats: DaemonSessionStatsToolByName;
}

function flattenTools(
  byName: Record<string, DaemonSessionStatsToolByName>,
): ToolEntry[] {
  return Object.entries(byName)
    .filter(([, s]) => s.count > 0)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, stats]) => ({ name, stats }));
}

function ToolStatsCard({ status }: { status: DaemonSessionStatsStatus }) {
  const { t } = useI18n();
  const entries = flattenTools(status.tools.byName);

  if (entries.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.title}>{t('stats.toolStats')}</div>
        <div>{t('stats.noToolCalls')}</div>
      </div>
    );
  }

  const totalDecisions = Object.values(status.tools.byName).reduce(
    (acc, tool) => {
      acc.accept += tool.decisions?.accept ?? 0;
      acc.reject += tool.decisions?.reject ?? 0;
      acc.modify += tool.decisions?.modify ?? 0;
      return acc;
    },
    { accept: 0, reject: 0, modify: 0 },
  );
  const totalReviewed =
    totalDecisions.accept + totalDecisions.reject + totalDecisions.modify;
  const agreementRate =
    totalReviewed > 0 ? (totalDecisions.accept / totalReviewed) * 100 : 0;

  return (
    <div className={styles.panel}>
      <div className={styles.title}>{t('stats.toolStats')}</div>
      <div className={styles.spacer} />

      {/* Header */}
      <div className={styles.tableRow}>
        <span className={styles.tableToolCol}>{t('stats.toolName')}</span>
        <span className={styles.tableNumCol}>{t('stats.calls')}</span>
        <span className={styles.tableNumCol}>{t('stats.successRate')}</span>
        <span className={styles.tableNumCol}>{t('stats.avgDuration')}</span>
      </div>
      <div className={styles.divider} />

      {/* Tool rows */}
      {entries.map((e) => {
        const rate =
          e.stats.count > 0 ? (e.stats.success / e.stats.count) * 100 : 0;
        const avgDur =
          e.stats.count > 0 ? e.stats.durationMs / e.stats.count : 0;
        return (
          <div key={e.name} className={styles.tableRow}>
            <span className={`${styles.tableToolCol} ${styles.metricCell}`}>
              {e.name}
            </span>
            <span className={styles.tableNumCol}>{e.stats.count}</span>
            <span
              className={`${styles.tableNumCol} ${
                rate >= 90
                  ? styles.success
                  : rate >= 70
                    ? styles.warning
                    : styles.error
              }`}
            >
              {rate.toFixed(1)}%
            </span>
            <span className={styles.tableNumCol}>{formatDuration(avgDur)}</span>
          </div>
        );
      })}

      <div className={styles.spacer} />

      {/* User Decision Summary */}
      <div className={styles.sectionTitle}>{t('stats.decisionSummary')}</div>
      <KvRow label={t('stats.totalReviewed')}>{totalReviewed}</KvRow>
      <KvSubRow label={t('stats.accepted')}>
        <span className={styles.success}>{totalDecisions.accept}</span>
      </KvSubRow>
      <KvSubRow label={t('stats.rejected')}>
        <span className={styles.error}>{totalDecisions.reject}</span>
      </KvSubRow>
      <KvSubRow label={t('stats.modified')}>
        <span className={styles.warning}>{totalDecisions.modify}</span>
      </KvSubRow>
      <div className={styles.divider} />
      <KvRow label={t('stats.agreementRate')}>
        <span
          className={
            totalReviewed > 0
              ? agreementRate >= 90
                ? styles.success
                : agreementRate >= 70
                  ? styles.warning
                  : styles.error
              : undefined
          }
        >
          {totalReviewed > 0 ? `${agreementRate.toFixed(1)}%` : '--'}
        </span>
      </KvRow>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────

export function StatsMessage({
  view,
  status,
}: {
  view: StatsView;
  status: DaemonSessionStatsStatus;
}) {
  switch (view) {
    case 'model':
      return <ModelStatsCard status={status} />;
    case 'tools':
      return <ToolStatsCard status={status} />;
    default:
      return <StatsOverview status={status} />;
  }
}
