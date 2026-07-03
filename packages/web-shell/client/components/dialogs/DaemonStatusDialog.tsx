import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import {
  useDaemonStatus,
  type DaemonStatusReport,
  type DaemonStatusReportLevel,
  type DaemonStatusReportSection,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import styles from './DaemonStatusDialog.module.css';

// The cheap in-memory summary is polled continuously; the expensive detail
// (per-session, workspace diagnostics, auth — the daemon may spawn the ACP
// child and aggregate several diagnostic surfaces to build it) is fetched only
// on open and on an explicit refresh, so parking the dialog open never rehits
// that path. Both surface as one dashboard: the summary/full split is a daemon
// cost boundary, not something the operator should have to think about.
const REFRESH_INTERVAL_MS = 5000;

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
  if (ms >= 60_000) return formatUptime(ms);
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
  return `${ms}ms`;
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
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
  const summaryEntries = Object.entries(section.summary ?? {});
  return (
    <div className={styles.workspaceRow}>
      <div className={styles.workspaceRowHead}>
        <span className={`${styles.badge} ${levelClass(section.status)}`}>
          {section.status}
        </span>
        <span className={styles.workspaceName}>{name}</span>
        <span className={styles.workspaceDuration}>
          {formatDurationMs(section.durationMs)}
        </span>
      </div>
      {section.error && (
        <div className={styles.workspaceError}>{section.error.message}</div>
      )}
      {summaryEntries.length > 0 && (
        <div className={styles.workspaceSummary}>
          {summaryEntries.map(([key, value]) => (
            <span key={key} className={styles.summaryChip}>
              {key}: {String(value)}
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
        {workspaceEntries.map(([name, section]) => (
          <WorkspaceSectionRow key={name} name={name} section={section} />
        ))}
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

export function DaemonStatusDialog() {
  const { t } = useI18n();
  // Two independent fetches: the summary drives the always-live top cards and
  // rides the auto-refresh interval; the full report backs the detail sections
  // and is only pulled on open (autoLoad) and on manual refresh.
  const summary = useDaemonStatus({ autoLoad: true, detail: 'summary' });
  const full = useDaemonStatus({ autoLoad: true, detail: 'full' });
  // `reload` is a stable callback; depend on it (not the hook object, which is
  // a fresh spread each render) so the poll interval is installed once rather
  // than torn down and reinstalled on every data update.
  const summaryReload = summary.reload;
  const fullReload = full.reload;

  // Skip a tick if the previous poll is still outstanding: useDaemonResource
  // discards stale completions but does not abort, and the client timeout is
  // 30s, so a degraded daemon could otherwise accumulate overlapping calls.
  const summaryPollInFlightRef = useRef(false);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (summaryPollInFlightRef.current) return;
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
        <span className={`${styles.badge} ${levelClass(rollupReport.status)}`}>
          {t(`daemon.level.${rollupReport.status}`)}
        </span>
        <span className={styles.updatedAt}>
          {t('daemon.updatedAt', {
            time: new Date(report.generatedAt).toLocaleTimeString(),
          })}
        </span>
        {error && (
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
          <Row
            label={t('daemon.runtime.activeSessions')}
            value={runtime.sessions.active}
          />
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
              security.requireAuth ? t('common.enabled') : t('common.disabled')
            }
          />
          <Row
            label={t('daemon.security.loopback')}
            value={
              security.loopbackBind ? t('common.enabled') : t('common.disabled')
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
          title={`${t('daemon.capabilities.title')}${
            capabilities.features.length
              ? ` (${capabilities.features.length})`
              : ''
          }`}
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

      {fullReport?.full ? (
        <FullDetail report={fullReport} />
      ) : full.error ? (
        <div className={styles.empty}>{t('daemon.details.failed')}</div>
      ) : (
        <div className={styles.empty}>{t('daemon.details.loading')}</div>
      )}
    </div>
  );
}
