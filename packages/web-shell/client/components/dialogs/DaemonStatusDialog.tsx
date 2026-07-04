import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  useStatusReport,
  type DaemonMetricsSeriesBucket,
  type DaemonStatusReport,
  type DaemonStatusReportLevel,
  type DaemonStatusReportSection,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { ErrorBoundary } from '../ErrorBoundary';
import { SvgLineChart, type ChartSeries } from './SvgLineChart';
import styles from './DaemonStatusDialog.module.css';

// The cheap in-memory summary is polled continuously; the expensive detail
// (per-session, workspace diagnostics, auth — the daemon may spawn the ACP
// child and aggregate several diagnostic surfaces to build it) is fetched only
// on open and on an explicit refresh, so parking the dialog open never rehits
// that path. Both surface as one dashboard: the summary/full split is a daemon
// cost boundary, not something the operator should have to think about.
const REFRESH_INTERVAL_MS = 5000;

// The dashboard splits into tabs once it carries live charts: monitoring
// (charts you watch), configuration (static cards you glance at), and
// diagnostics (sessions/workspace you open when something is wrong) are
// different intents — and 6 cards + 7 charts + diagnostics overflow one 70vh
// scroll. Status badge / refresh / issues stay global above the tabs.
type DaemonTab = 'overview' | 'metrics' | 'diagnostics';
const DAEMON_TABS: ReadonlyArray<{ id: DaemonTab; labelKey: string }> = [
  { id: 'overview', labelKey: 'daemon.tab.overview' },
  { id: 'metrics', labelKey: 'daemon.tab.metrics' },
  { id: 'diagnostics', labelKey: 'daemon.tab.diagnostics' },
];

function formatUptime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatDurationMs(ms: number): string {
  ms = Math.max(0, ms); // clamp clock-skew negatives to a "0ms" contract
  if (ms >= 60_000) return formatUptime(ms);
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
  return `${ms}ms`;
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

// Compact counts for chart peaks/current values: thousands collapse to "12.3k"
// so token burn and request counts stay legible in the narrow legend.
function formatCount(value: number): string {
  const n = Math.round(value);
  if (n >= 10_000) {
    return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  }
  return n.toLocaleString();
}

function channelWorkerState(
  worker: DaemonStatusReport['runtime']['channelWorker'],
): string {
  if (worker.exitCode != null) {
    return `${worker.state} (exit ${worker.exitCode})`;
  }
  if (worker.signal) return `${worker.state} (${worker.signal})`;
  return worker.state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface WorkspaceProblemCell {
  label: string;
  status: 'warning' | 'error';
  message?: string;
}

// A section's status is the worst of its individual checks, but the summary
// chips only carry counts — so a "warning preflight" reads as opaque. Pull the
// individual warning/error entries out of the raw section data so the dashboard
// can say *what* is wrong (e.g. "auth: No auth method configured"). Section
// payloads differ but consistently carry status cells under these keys.
const SECTION_CELL_KEYS = [
  'cells',
  'servers',
  'errors',
  'skills',
  'tools',
  'providers',
  'hooks',
  'extensions',
  'budgets',
] as const;

function extractProblemCells(data: unknown): WorkspaceProblemCell[] {
  if (!isRecord(data)) return [];
  const problems: WorkspaceProblemCell[] = [];
  for (const key of SECTION_CELL_KEYS) {
    const arr = data[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!isRecord(item)) continue;
      const status = item['status'];
      if (status !== 'warning' && status !== 'error') continue;
      const label = String(
        item['kind'] ?? item['name'] ?? item['serverName'] ?? key,
      );
      const message =
        typeof item['error'] === 'string'
          ? item['error']
          : typeof item['hint'] === 'string'
            ? item['hint']
            : undefined;
      problems.push({ label, status, message });
    }
  }
  return problems;
}

function levelClass(
  level: DaemonStatusReportLevel | 'unavailable',
): string | undefined {
  switch (level) {
    case 'ok':
      return styles.levelOk;
    case 'warning':
      return styles.levelWarning;
    case 'error':
      return styles.levelError;
    default:
      return styles.levelUnavailable;
  }
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{value}</span>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.card}>
      <h3 className={styles.cardTitle}>{title}</h3>
      {children}
    </section>
  );
}

function WorkspaceSectionRow({
  name,
  section,
}: {
  name: string;
  section: DaemonStatusReportSection;
}) {
  const { t } = useI18n();
  const summaryEntries = Object.entries(section.summary ?? {});
  const problemCells = extractProblemCells(section.data);
  return (
    <div className={styles.workspaceRow}>
      <div className={styles.workspaceRowHead}>
        <span className={`${styles.badge} ${levelClass(section.status)}`}>
          {t(`daemon.level.${section.status}`)}
        </span>
        <span className={styles.workspaceName}>{name}</span>
        <span className={styles.workspaceDuration}>
          {formatDurationMs(section.durationMs)}
        </span>
      </div>
      {section.error && (
        <div className={styles.workspaceError}>{section.error.message}</div>
      )}
      {/* Name the individual checks that pushed this section to warning/error,
          so the badge is self-explanatory. */}
      {problemCells.map((cell, index) => (
        <div key={`${cell.label}-${index}`} className={styles.workspaceCell}>
          <span className={`${styles.badge} ${levelClass(cell.status)}`}>
            {t(`daemon.level.${cell.status}`)}
          </span>
          <span className={styles.workspaceCellLabel}>{cell.label}</span>
          {cell.message && (
            <span className={styles.workspaceCellMessage}>{cell.message}</span>
          )}
        </div>
      ))}
      {summaryEntries.length > 0 && (
        <div className={styles.workspaceSummary}>
          {summaryEntries.map(([key, value]) => (
            <span key={key} className={styles.summaryChip}>
              {key}: {value === null ? 'N/A' : String(value)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function FullDetail({ report }: { report: DaemonStatusReport }) {
  const { t } = useI18n();
  const full = report.full;
  if (!full) return null;
  const workspaceEntries = Object.entries(full.workspace).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return (
    <>
      <Card title={t('daemon.full.sessions.title')}>
        {full.sessions.length === 0 ? (
          <div className={styles.empty}>{t('daemon.full.sessions.empty')}</div>
        ) : (
          full.sessions.map((session) => (
            <div key={session.sessionId} className={styles.sessionRow}>
              <div className={styles.sessionName}>
                {session.displayName || session.sessionId}
              </div>
              <div className={styles.sessionMeta}>
                <span>
                  {t('common.clients', { count: session.clientCount })}
                </span>
                <span>
                  {t('daemon.full.session.pendingPrompts', {
                    count: session.pendingPromptCount,
                  })}
                </span>
                <span>
                  {t('daemon.full.session.pendingPermissions', {
                    count: session.pendingPermissionCount,
                  })}
                </span>
                {session.hasActivePrompt && (
                  <span className={styles.activePrompt}>
                    {t('daemon.full.session.prompting')}
                  </span>
                )}
              </div>
            </div>
          ))
        )}
      </Card>
      <Card title={t('daemon.full.workspace.title')}>
        {workspaceEntries.length === 0 ? (
          <div className={styles.empty}>{t('daemon.full.workspace.empty')}</div>
        ) : (
          workspaceEntries.map(([name, section]) => (
            <WorkspaceSectionRow key={name} name={name} section={section} />
          ))
        )}
      </Card>
      <Card title={t('daemon.full.auth.title')}>
        <Row
          label={t('daemon.full.auth.providers')}
          value={
            full.auth.supportedDeviceFlowProviders.join(', ') ||
            t('daemon.none')
          }
        />
        <Row
          label={t('daemon.full.auth.pending')}
          value={full.auth.pendingDeviceFlowCount}
        />
        <Row
          label={t('daemon.full.acp.title')}
          value={full.acpConnections.length}
        />
      </Card>
    </>
  );
}

// Bottleneck-analysis dashboard: the daemon samples load, throughput, latency,
// resource pressure, and token burn into one time-bucketed series, so these
// charts share an x-axis. Lining up "N tasks running at once" (concurrency)
// against event-loop lag, queue wait, memory, and API latency shows *where* a
// busy daemon is actually stalling.
function MetricsCharts({ series }: { series: DaemonMetricsSeriesBucket[] }) {
  const { t } = useI18n();
  if (series.length === 0) {
    return (
      <Card title={t('daemon.charts.title')}>
        <div className={styles.empty}>{t('daemon.charts.empty')}</div>
      </Card>
    );
  }
  const col = (pick: (b: DaemonMetricsSeriesBucket) => number): number[] =>
    series.map(pick);
  // Bucket timestamps drive the hover tooltip's time header.
  const times = series.map((b) => b.t);
  const chart = (
    titleKey: string,
    format: (v: number) => string,
    lines: ChartSeries[],
  ): ReactNode => (
    <Card title={t(titleKey)}>
      <SvgLineChart
        series={lines}
        timestamps={times}
        format={format}
        ariaLabel={t(titleKey)}
      />
    </Card>
  );
  return (
    <div className={styles.grid}>
      {chart('daemon.charts.concurrency', formatCount, [
        {
          label: t('daemon.charts.activePrompts'),
          values: col((b) => b.activePrompts),
          color: 'var(--primary)',
        },
        {
          label: t('daemon.charts.activeSessions'),
          values: col((b) => b.activeSessions),
          color: 'var(--muted-foreground)',
        },
      ])}
      {chart('daemon.charts.requests', formatCount, [
        {
          label: t('daemon.charts.reqTotal'),
          values: col((b) => b.requests),
          color: 'var(--success-color)',
        },
        {
          label: t('daemon.charts.reqErrors'),
          values: col((b) => b.errors),
          color: 'var(--error-color)',
        },
      ])}
      {chart('daemon.charts.apiLatency', formatDurationMs, [
        {
          label: 'p50',
          values: col((b) => b.latencyP50Ms),
          color: 'var(--agent-blue-400)',
        },
        {
          label: 'p95',
          values: col((b) => b.latencyP95Ms),
          color: 'var(--warning-color)',
        },
      ])}
      {chart('daemon.charts.promptLatency', formatDurationMs, [
        {
          label: t('daemon.charts.queueWait'),
          values: col((b) => b.promptQueueWaitP95Ms),
          color: 'var(--warning-color)',
        },
        {
          label: t('daemon.charts.promptDuration'),
          values: col((b) => b.promptDurationP95Ms),
          color: 'var(--primary)',
        },
      ])}
      {chart('daemon.charts.eventLoop', formatDurationMs, [
        {
          label: t('daemon.charts.eventLoopLag'),
          values: col((b) => b.eventLoopLagP99Ms),
          color: 'var(--error-color)',
        },
      ])}
      {chart('daemon.charts.memory', formatBytes, [
        {
          label: 'RSS',
          values: col((b) => b.rssBytes),
          color: 'var(--primary)',
        },
        {
          label: t('daemon.charts.heap'),
          values: col((b) => b.heapUsedBytes),
          color: 'var(--agent-blue-400)',
        },
      ])}
      {chart('daemon.charts.tokens', formatCount, [
        {
          label: t('daemon.charts.tokensIn'),
          values: col((b) => b.tokensIn),
          color: 'var(--agent-blue-400)',
        },
        {
          label: t('daemon.charts.tokensOut'),
          values: col((b) => b.tokensOut),
          color: 'var(--success-color)',
        },
      ])}
    </div>
  );
}

function DaemonStatusDialogInner() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<DaemonTab>('overview');
  // Two independent fetches: the summary drives the always-live top cards and
  // rides the auto-refresh interval; the full report backs the detail sections
  // and is only pulled on open (autoLoad) and on manual refresh.
  const summary = useStatusReport({ autoLoad: true, detail: 'summary' });
  const full = useStatusReport({ autoLoad: true, detail: 'full' });
  // `reload` is a stable callback; depend on it (not the hook object, which is
  // a fresh spread each render) so the poll interval is installed once rather
  // than torn down and reinstalled on every data update.
  const summaryReload = summary.reload;
  const fullReload = full.reload;

  // Skip a tick when the tab is backgrounded (matching the sidebar poll) or
  // when the previous poll is still outstanding: useDaemonResource discards
  // stale completions but does not abort, and the client timeout is 30s, so a
  // degraded daemon could otherwise accumulate overlapping calls.
  const summaryPollInFlightRef = useRef(false);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden || summaryPollInFlightRef.current) return;
      summaryPollInFlightRef.current = true;
      void summaryReload().finally(() => {
        summaryPollInFlightRef.current = false;
      });
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [summaryReload]);

  const refreshAll = useCallback(() => {
    void summaryReload();
    void fullReload();
  }, [summaryReload, fullReload]);

  // Prefer the continuously-refreshed summary for the top cards; fall back to
  // the full report so the dashboard still renders if only that has landed.
  const report = summary.report ?? full.report;
  const fullReport = full.report;
  const loading = summary.loading || full.loading;
  const error = summary.error ?? full.error;

  if (!report) {
    return (
      <div className={styles.dialog}>
        <div className={styles.empty}>
          {error
            ? `${t('daemon.loadFailed')}: ${error.message}`
            : t('daemon.loading')}
        </div>
      </div>
    );
  }

  // The daemon only appends workspace/preflight/MCP issues (and rolls them into
  // `status`) for detail=full, so the summary can read "ok" with an empty issue
  // list while a loaded full report is failing. Drive the badge and issue list
  // off the full report whenever it is available; keep the live counters on the
  // summary. The rollup then refreshes on open/manual rather than every 5s,
  // which only ever over-reports (safe) between full fetches.
  const rollupReport = fullReport ?? report;

  const { daemon, runtime, security, limits, capabilities } = report;
  const acp = runtime.transport.acp;
  const rateRejected = Object.values(
    runtime.rateLimit.rejectedSinceStart,
  ).reduce((sum, count) => sum + count, 0);
  const limitValue = (value: number | null) =>
    value === null ? t('daemon.limits.unlimited') : value;

  return (
    <div className={styles.dialog}>
      <div className={styles.toolbar}>
        <span
          role="status"
          aria-label={`${t('daemon.title')}: ${t(
            `daemon.level.${rollupReport.status}`,
          )}`}
          className={`${styles.badge} ${levelClass(rollupReport.status)}`}
        >
          {t(`daemon.level.${rollupReport.status}`)}
        </span>
        <span className={styles.updatedAt}>
          {t('daemon.updatedAt', {
            time: new Date(report.generatedAt).toLocaleTimeString(),
          })}
        </span>
        {/* Flag the toolbar only when the summary that owns the visible
            counters/timestamp is the failing, stale source: it errored AND
            still has (now-stale) data on screen. When the summary never loaded
            and the cards are rendering from the full fallback, or when only the
            full fetch failed (surfaced in the diagnostics section), the banner
            would misrepresent an otherwise-usable dashboard. */}
        {summary.error && summary.report && (
          <span className={styles.refreshError}>{t('daemon.loadFailed')}</span>
        )}
        <div className={styles.toolbarActions}>
          <button
            type="button"
            className={styles.refreshButton}
            onClick={refreshAll}
            disabled={loading}
          >
            {t('daemon.refresh')}
          </button>
        </div>
      </div>

      {rollupReport.issues.length > 0 && (
        <Card title={t('daemon.issues.title')}>
          {rollupReport.issues.map((issue, index) => (
            <div key={`${issue.code}-${index}`} className={styles.issueRow}>
              <span
                className={`${styles.badge} ${
                  issue.severity === 'error'
                    ? styles.levelError
                    : styles.levelWarning
                }`}
              >
                {issue.severity === 'error'
                  ? t('daemon.level.error')
                  : t('daemon.level.warning')}
              </span>
              <span className={styles.issueMessage}>{issue.message}</span>
            </div>
          ))}
        </Card>
      )}

      <div
        className={styles.tabs}
        role="tablist"
        aria-label={t('daemon.title')}
      >
        {DAEMON_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeTab}
            className={`${styles.tab} ${
              tab.id === activeTab ? styles.tabActive : ''
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className={styles.grid}>
          <Card title={t('daemon.overview.title')}>
            {daemon.qwenCodeVersion && (
              <Row
                label={t('daemon.overview.version')}
                value={daemon.qwenCodeVersion}
              />
            )}
            <Row label={t('daemon.overview.pid')} value={daemon.pid} />
            <Row label={t('daemon.overview.mode')} value={daemon.mode} />
            <Row
              label={t('daemon.overview.uptime')}
              value={formatUptime(daemon.uptimeMs)}
            />
            {/* The workspace path is long; give it its own full-width row and
              keep it to a single line — front-truncated so the meaningful tail
              (…/parent/workspace) stays visible, full path on hover. */}
            <div className={styles.pathRow}>
              <span className={styles.rowLabel}>
                {t('daemon.overview.workspace')}
              </span>
              <span
                className={styles.pathValue}
                title={daemon.workspaceCwd}
                // Front-truncate (ellipsis at the start) via CSS `direction:rtl`
                // so the meaningful tail stays visible; `bdi` keeps the path's
                // own characters in logical order despite the rtl context.
              >
                <bdi>{daemon.workspaceCwd}</bdi>
              </span>
            </div>
          </Card>

          <Card title={t('daemon.runtime.title')}>
            {/* The counters below read as plausible zeros while the daemon
              runtime is still coming up or has failed; call that out so they
              are not mistaken for a healthy idle daemon. */}
            {runtime.error ? (
              <div className={styles.workspaceError}>
                {t('daemon.runtime.startFailed')}: {runtime.error}
              </div>
            ) : runtime.loading ? (
              <div className={styles.empty}>
                {t('daemon.runtime.startingUp')}
              </div>
            ) : null}
            <Row
              label={t('daemon.runtime.activeSessions')}
              value={runtime.sessions.active}
            />
            {/* Activity counters (daemons predating this omit the sub-object). */}
            {runtime.activity && (
              <>
                <Row
                  label={t('daemon.runtime.activePrompts')}
                  value={runtime.activity.activePrompts}
                />
                <Row
                  label={t('daemon.runtime.idle')}
                  value={
                    runtime.activity.idleSinceMs === null
                      ? t('daemon.runtime.noActivity')
                      : formatDurationMs(runtime.activity.idleSinceMs)
                  }
                />
              </>
            )}
            <Row
              label={t('daemon.runtime.pendingPermissions')}
              value={runtime.permissions.pending}
            />
            <Row
              label={t('daemon.runtime.permissionPolicy')}
              value={runtime.permissions.policy}
            />
            <Row
              label={t('daemon.runtime.channel')}
              value={
                runtime.channel.live
                  ? t('daemon.runtime.channelLive')
                  : t('daemon.runtime.channelDown')
              }
            />
            {/* Surface why a channel worker is unhealthy instead of leaving the
              operator with a bare "down" — these fields are already fetched. */}
            {runtime.channelWorker.enabled && (
              <>
                <Row
                  label={t('daemon.runtime.channelWorker')}
                  value={channelWorkerState(runtime.channelWorker)}
                />
                {runtime.channelWorker.error && (
                  <div className={styles.workspaceError}>
                    {runtime.channelWorker.error}
                  </div>
                )}
                {(runtime.channelWorker.restartCount ?? 0) > 0 && (
                  <Row
                    label={t('daemon.runtime.channelWorkerRestarts')}
                    value={runtime.channelWorker.restartCount}
                  />
                )}
              </>
            )}
            <Row
              label={t('daemon.runtime.memory')}
              value={`${formatBytes(runtime.process.rss)} / ${formatBytes(
                runtime.process.heapUsed,
              )}`}
            />
          </Card>

          <Card title={t('daemon.transport.title')}>
            <Row
              label={t('daemon.transport.restSse')}
              value={runtime.transport.restSseActive}
            />
            {acp.enabled ? (
              <>
                <Row
                  label={t('daemon.transport.acpConnections')}
                  value={acp.connections}
                />
                <Row
                  label={t('daemon.transport.acpStreams')}
                  value={`${acp.sessionStreams} / ${acp.sseStreams} / ${acp.wsStreams}`}
                />
                <Row
                  label={t('daemon.transport.pendingRequests')}
                  value={acp.pendingClientRequests}
                />
              </>
            ) : (
              <div className={styles.empty}>
                {t('daemon.transport.acpDisabled')}
              </div>
            )}
            <Row
              label={t('daemon.transport.rateLimitRejected')}
              value={
                runtime.rateLimit.enabled ? rateRejected : t('common.disabled')
              }
            />
          </Card>

          <Card title={t('daemon.security.title')}>
            <Row
              label={t('daemon.security.token')}
              value={
                security.tokenConfigured
                  ? t('daemon.security.configured')
                  : t('daemon.security.notConfigured')
              }
            />
            <Row
              label={t('daemon.security.requireAuth')}
              value={
                security.requireAuth
                  ? t('common.enabled')
                  : t('common.disabled')
              }
            />
            <Row
              label={t('daemon.security.loopback')}
              value={
                security.loopbackBind
                  ? t('common.enabled')
                  : t('common.disabled')
              }
            />
            <Row
              label={t('daemon.security.allowOrigin')}
              value={security.allowOriginMode}
            />
            <Row
              label={t('daemon.security.shell')}
              value={
                security.sessionShellCommandEnabled
                  ? t('common.enabled')
                  : t('common.disabled')
              }
            />
          </Card>

          <Card title={t('daemon.limits.title')}>
            <Row
              label={t('daemon.limits.maxSessions')}
              value={limitValue(limits.maxSessions)}
            />
            <Row
              label={t('daemon.limits.maxPendingPrompts')}
              value={limitValue(limits.maxPendingPromptsPerSession)}
            />
            <Row
              label={t('daemon.limits.maxConnections')}
              value={limitValue(limits.listenerMaxConnections)}
            />
            <Row
              label={t('daemon.limits.eventRing')}
              value={limits.eventRingSize}
            />
            <Row
              label={t('daemon.limits.promptDeadline')}
              value={
                limits.promptDeadlineMs === null
                  ? t('daemon.limits.unlimited')
                  : formatDurationMs(limits.promptDeadlineMs)
              }
            />
            <Row
              label={t('daemon.limits.sessionIdle')}
              value={formatDurationMs(limits.sessionIdleTimeoutMs)}
            />
          </Card>

          <Card
            title={
              capabilities.features.length
                ? t('daemon.capabilities.titleCount', {
                    count: capabilities.features.length,
                  })
                : t('daemon.capabilities.title')
            }
          >
            {capabilities.features.length === 0 ? (
              <span className={styles.empty}>{t('daemon.none')}</span>
            ) : (
              <div className={styles.featureChips}>
                {[...capabilities.features].sort().map((feature) => (
                  <span key={feature} className={styles.featureChip}>
                    {feature}
                  </span>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Time-series charts for bottleneck analysis. Driven by the
          continuously-refreshed summary report so the curves advance on every
          poll; the daemon retains the history, so it survives dialog close. */}
      {activeTab === 'metrics' && (
        <MetricsCharts series={report.runtime.metrics?.series ?? []} />
      )}

      {/* Contain a crash in the detail sections (e.g. a partial detail=full
          payload) to this region so the healthy summary cards above stay live,
          rather than letting the outer boundary replace the whole dialog. */}
      {activeTab === 'diagnostics' && (
        <ErrorBoundary
          label="daemon-status-detail"
          fallback={
            <div className={styles.empty}>{t('daemon.details.failed')}</div>
          }
        >
          {fullReport?.full ? (
            <FullDetail report={fullReport} />
          ) : full.loading ? (
            <div className={styles.empty}>{t('daemon.details.loading')}</div>
          ) : full.error ? (
            <div className={styles.empty}>
              {t('daemon.details.failed')}: {full.error.message}
            </div>
          ) : (
            // Fetch resolved but the daemon omitted the `full` section — don't
            // hang on the loading placeholder forever.
            <div className={styles.empty}>{t('daemon.details.failed')}</div>
          )}
        </ErrorBoundary>
      )}
    </div>
  );
}

// A malformed or partial daemon response — most likely exactly when the daemon
// is sick and this dashboard is most needed — must not white-screen the whole
// web shell. Contain any render throw to the dialog; the function-form fallback
// surfaces the actual render error (distinct from a network failure). Because
// the parent only mounts the dialog while open, closing and re-opening remounts
// the boundary, so a transient bad payload recovers on the next open.
export function DaemonStatusDialog() {
  const { t } = useI18n();
  return (
    <ErrorBoundary
      label="daemon-status"
      fallback={(error) => (
        <div className={styles.dialog}>
          <div className={styles.empty}>
            {t('daemon.loadFailed')}: {error.message}
          </div>
        </div>
      )}
    >
      <DaemonStatusDialogInner />
    </ErrorBoundary>
  );
}
