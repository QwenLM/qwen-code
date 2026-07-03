import { useCallback, useEffect, useRef, useState } from 'react';
import { getDaemonAuthHeaders, getDaemonBaseUrl } from '../../config/daemon';
import { useI18n } from '../../i18n';
import styles from './DashboardDialog.module.css';

interface DaemonStatusResponse {
  v: number;
  detail: string;
  generatedAt: string;
  status: string;
  issues: Array<{
    code: string;
    severity: string;
    message: string;
    section?: string;
  }>;
  daemon: Record<string, unknown> & {
    pid: number;
    uptimeMs: number;
    mode: string;
    workspaceCwd: string;
  };
  security: Record<string, unknown>;
  limits: Record<string, unknown>;
  capabilities: {
    protocolVersions: { current: string };
    features: string[];
  };
  runtime: {
    loading?: boolean;
    error?: string;
    sessions: { active: number };
    permissions: { pending: number; policy: string };
    channel: { live: boolean };
    channelWorker: Record<string, unknown>;
    transport: {
      restSseActive: number;
      acp: Record<string, unknown> & {
        enabled: boolean;
        connections: number;
        connectionStreams: number;
        sessionStreams: number;
        sseStreams: number;
        wsStreams: number;
        pendingClientRequests: number;
      };
    };
    rateLimit: {
      enabled: boolean;
      rejectedSinceStart: Record<string, number>;
    };
    process: {
      rss: number;
      heapUsed: number;
      heapTotal: number;
    };
  };
  full?: {
    sessions: Array<Record<string, unknown>>;
    acpConnections: Array<Record<string, unknown>>;
    workspace: Record<
      string,
      {
        status: string;
        durationMs: number;
        summary?: Record<string, unknown>;
        data?: unknown;
        error?: { kind: string; message: string };
      }
    >;
    auth: {
      supportedDeviceFlowProviders: string[];
      pendingDeviceFlowCount: number;
    };
  };
}

type Detail = 'summary' | 'full';

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function dotClass(status: string): string {
  if (status === 'ok') return styles.dotOk;
  if (status === 'warning') return styles.dotWarn;
  if (status === 'error') return styles.dotErr;
  return styles.dotGray;
}

function chipClass(status: string | boolean): string {
  if (status === 'ok' || status === true) return styles.chipOk;
  if (status === 'warning') return styles.chipWarn;
  if (status === 'error' || status === 'unavailable') return styles.chipErr;
  return styles.chipOff;
}

function KV({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  return (
    <>
      <dt className={styles.kvLabel}>{label}</dt>
      <dd className={styles.kvValue}>{value ?? 'unlimited'}</dd>
    </>
  );
}

function BoolChip({ val, label }: { val: boolean; label: string }) {
  return (
    <span className={`${styles.chip} ${val ? styles.chipOk : styles.chipOff}`}>
      {label}: {val ? 'yes' : 'no'}
    </span>
  );
}

function CapacityBar({
  current,
  max,
}: {
  current: number;
  max: number | null | undefined;
}) {
  if (max === null || max === undefined || max <= 0) return null;
  const pct = Math.min(100, (current / max) * 100);
  const color =
    pct >= 90
      ? 'var(--error-color)'
      : pct >= 75
        ? 'var(--warning-color)'
        : 'var(--success-color)';
  return (
    <div className={styles.capBar}>
      <div
        className={styles.capFill}
        style={{ width: `${pct.toFixed(1)}%`, background: color }}
      />
    </div>
  );
}

function WorkspaceSection({
  name,
  section,
}: {
  name: string;
  section: {
    status: string;
    durationMs: number;
    summary?: Record<string, unknown>;
    data?: unknown;
    error?: { kind: string; message: string };
  };
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={styles.sectionToggle}
        onClick={() => setOpen(!open)}
      >
        <span className={`${styles.dot} ${dotClass(section.status)}`} />
        {name} ({section.durationMs}ms)
        {section.error && (
          <span className={`${styles.chip} ${styles.chipErr}`}>
            {section.error.kind}
          </span>
        )}
      </button>
      {open && (
        <div className={styles.sectionBody}>
          {section.summary && Object.keys(section.summary).length > 0 && (
            <dl className={styles.kv}>
              {Object.entries(section.summary).map(([k, v]) => (
                <KV key={k} label={k} value={String(v)} />
              ))}
            </dl>
          )}
          {section.data != null && (
            <pre>{JSON.stringify(section.data, null, 2)}</pre>
          )}
          {section.error && (
            <div
              className={`${styles.chip} ${styles.chipErr}`}
              style={{ marginTop: 8 }}
            >
              {section.error.message}
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function DashboardDialog() {
  const { t } = useI18n();
  const [detail, setDetail] = useState<Detail>(
    () =>
      (typeof sessionStorage !== 'undefined'
        ? (sessionStorage.getItem('dashboard_detail') as Detail)
        : null) || 'summary',
  );
  const [interval, setIntervalMs] = useState(() =>
    typeof sessionStorage !== 'undefined'
      ? parseInt(sessionStorage.getItem('dashboard_interval') || '10000', 10)
      : 10000,
  );
  const [data, setData] = useState<DaemonStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchingRef = useRef(false);

  const fetchStatus = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const base = getDaemonBaseUrl();
      const headers = getDaemonAuthHeaders();
      const res = await fetch(
        `${base}/daemon/status?detail=${detail}`,
        headers ? { headers } : undefined,
      );
      if (!res.ok) {
        const text = await res.text();
        setError(`HTTP ${res.status}: ${text}`);
        setData(null);
        return;
      }
      const json = (await res.json()) as DaemonStatusResponse;
      setData(json);
      setError(null);
      setLastUpdate(
        new Date().toLocaleTimeString('en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      );
    } catch (err) {
      setError(
        `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      setData(null);
    } finally {
      fetchingRef.current = false;
      setLoading(false);
    }
  }, [detail]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    const schedule = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (interval <= 0) return;
      timerRef.current = setTimeout(() => {
        void fetchStatus().then(schedule);
      }, interval);
    };
    schedule();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [fetchStatus, interval]);

  const handleDetailChange = (d: Detail) => {
    setDetail(d);
    sessionStorage.setItem('dashboard_detail', d);
  };

  const handleIntervalChange = (ms: number) => {
    setIntervalMs(ms);
    sessionStorage.setItem('dashboard_interval', String(ms));
  };

  if (loading && !data) {
    return (
      <div className={styles.root}>
        <div className={styles.loading}>{t('dashboard.loading')}</div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {/* Controls */}
      <div className={styles.controls}>
        <div className={styles.toggle}>
          <button
            type="button"
            className={`${styles.toggleBtn} ${detail === 'summary' ? styles.active : ''}`}
            onClick={() => handleDetailChange('summary')}
          >
            Summary
          </button>
          <button
            type="button"
            className={`${styles.toggleBtn} ${detail === 'full' ? styles.active : ''}`}
            onClick={() => handleDetailChange('full')}
          >
            Full
          </button>
        </div>
        <select
          className={styles.refreshSelect}
          value={interval}
          onChange={(e) => handleIntervalChange(parseInt(e.target.value, 10))}
        >
          <option value="0">Off</option>
          <option value="5000">5s</option>
          <option value="10000">10s</option>
          <option value="30000">30s</option>
        </select>
        <button
          type="button"
          className={styles.refreshBtn}
          onClick={() => void fetchStatus()}
        >
          {t('dashboard.refresh')}
        </button>
        {lastUpdate && (
          <span className={styles.lastUpdated}>
            {t('dashboard.updated')} {lastUpdate}
          </span>
        )}
      </div>

      {error && <div className={styles.errBanner}>{error}</div>}

      {data && (
        <>
          {/* Issues */}
          {data.issues.length > 0 && (
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                Issues ({data.issues.length})
              </div>
              <div className={styles.cardBody}>
                {data.issues.map((issue) => (
                  <div key={issue.code} className={styles.issue}>
                    <span
                      className={`${styles.issueCode} ${styles.chip} ${
                        issue.severity === 'error'
                          ? styles.chipErr
                          : styles.chipWarn
                      }`}
                    >
                      {issue.code}
                    </span>
                    <span>{issue.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Daemon */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={`${styles.dot} ${dotClass(data.status)}`} />
              Daemon
            </div>
            <div className={styles.cardBody}>
              <dl className={styles.kv}>
                <KV label="PID" value={data.daemon.pid} />
                <KV label="Uptime" value={fmtUptime(data.daemon.uptimeMs)} />
                <KV label="Mode" value={data.daemon.mode} />
                <KV label="Workspace" value={data.daemon.workspaceCwd} />
                {typeof data.daemon.qwenCodeVersion === 'string' && (
                  <KV label="Version" value={data.daemon.qwenCodeVersion} />
                )}
                {typeof data.daemon.daemonId === 'string' && (
                  <KV label="Daemon ID" value={data.daemon.daemonId} />
                )}
                {(data.daemon.startup as
                  | Record<string, unknown>
                  | undefined) && (
                  <>
                    <KV
                      label="Started at"
                      value={fmtTime(
                        (data.daemon.startup as Record<string, unknown>)
                          .processStartedAt as string,
                      )}
                    />
                    {(data.daemon.startup as Record<string, unknown>)
                      .processToListenMs !== undefined && (
                      <KV
                        label="Startup time"
                        value={`${(data.daemon.startup as Record<string, unknown>).processToListenMs}ms`}
                      />
                    )}
                  </>
                )}
              </dl>
            </div>
          </div>

          {/* Runtime */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>Runtime</div>
            <div className={styles.cardBody}>
              <dl className={styles.kv}>
                <KV
                  label="Sessions"
                  value={`${data.runtime.sessions.active}${(data.limits.maxSessions as number | null) ? ` / ${data.limits.maxSessions}` : ''}`}
                />
              </dl>
              <CapacityBar
                current={data.runtime.sessions.active}
                max={data.limits.maxSessions as number | null}
              />
              <dl className={styles.kv} style={{ marginTop: 8 }}>
                <KV
                  label="Permissions pending"
                  value={data.runtime.permissions.pending}
                />
                <KV
                  label="Permission policy"
                  value={data.runtime.permissions.policy}
                />
                <dt className={styles.kvLabel}>Channel</dt>
                <dd className={styles.kvValue}>
                  <span
                    className={`${styles.dot} ${data.runtime.channel.live ? styles.dotOk : styles.dotErr}`}
                  />{' '}
                  {data.runtime.channel.live ? 'live' : 'down'}
                </dd>
              </dl>

              {/* Transport */}
              <div className={styles.subSection}>
                <div className={styles.subTitle}>Transport</div>
                <dl className={styles.kv}>
                  <KV
                    label="REST SSE active"
                    value={data.runtime.transport.restSseActive}
                  />
                  {data.runtime.transport.acp.enabled ? (
                    <>
                      <KV
                        label="ACP connections"
                        value={data.runtime.transport.acp.connections}
                      />
                      <KV
                        label="ACP streams"
                        value={`conn=${data.runtime.transport.acp.connectionStreams} sess=${data.runtime.transport.acp.sessionStreams} sse=${data.runtime.transport.acp.sseStreams} ws=${data.runtime.transport.acp.wsStreams}`}
                      />
                    </>
                  ) : (
                    <KV label="ACP" value="disabled" />
                  )}
                </dl>
                {data.runtime.transport.acp.enabled && (
                  <CapacityBar
                    current={data.runtime.transport.acp.connections}
                    max={data.limits.acpConnectionCap as number | null}
                  />
                )}
              </div>

              {/* Rate limit */}
              <div className={styles.subSection}>
                <div className={styles.subTitle}>Rate Limiting</div>
                <dl className={styles.kv}>
                  <KV
                    label="Enabled"
                    value={data.runtime.rateLimit.enabled ? 'yes' : 'no'}
                  />
                  {data.runtime.rateLimit.enabled && (
                    <KV
                      label="Rejected"
                      value={`prompt=${data.runtime.rateLimit.rejectedSinceStart.prompt || 0} mutation=${data.runtime.rateLimit.rejectedSinceStart.mutation || 0} read=${data.runtime.rateLimit.rejectedSinceStart.read || 0}`}
                    />
                  )}
                </dl>
              </div>

              {/* Memory */}
              <div className={styles.subSection}>
                <div className={styles.subTitle}>Process Memory</div>
                <dl className={styles.kv}>
                  <KV label="RSS" value={fmtBytes(data.runtime.process.rss)} />
                  <KV
                    label="Heap used"
                    value={fmtBytes(data.runtime.process.heapUsed)}
                  />
                  <KV
                    label="Heap total"
                    value={fmtBytes(data.runtime.process.heapTotal)}
                  />
                </dl>
              </div>
            </div>
          </div>

          {/* Security */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>Security</div>
            <div className={styles.cardBody}>
              <BoolChip
                val={data.security.tokenConfigured as boolean}
                label="token"
              />
              <BoolChip
                val={data.security.requireAuth as boolean}
                label="requireAuth"
              />
              <BoolChip
                val={data.security.loopbackBind as boolean}
                label="loopback"
              />
              <BoolChip
                val={data.security.sessionShellCommandEnabled as boolean}
                label="shell"
              />
              <br />
              <span className={`${styles.chip} ${styles.chipOff}`}>
                allowOrigin: {data.security.allowOriginMode as string}
              </span>
            </div>
          </div>

          {/* Limits */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>Limits</div>
            <div className={styles.cardBody}>
              <dl className={styles.kv}>
                {Object.entries(data.limits).map(([key, val]) => (
                  <KV
                    key={key}
                    label={key}
                    value={
                      val !== null && val !== undefined
                        ? typeof val === 'number' && key.endsWith('Ms')
                          ? `${val}ms`
                          : String(val)
                        : 'unlimited'
                    }
                  />
                ))}
              </dl>
            </div>
          </div>

          {/* Capabilities */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>Capabilities</div>
            <div className={styles.cardBody}>
              <dl className={styles.kv}>
                <KV
                  label="Protocol"
                  value={data.capabilities.protocolVersions.current}
                />
              </dl>
              {data.capabilities.features.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {data.capabilities.features.map((f) => (
                    <span key={f} className={styles.featTag}>
                      {f}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Full mode sections */}
          {data.full && (
            <>
              {/* Sessions */}
              <div className={styles.card}>
                <div className={styles.cardHeader}>
                  Sessions ({data.full.sessions.length})
                </div>
                <div className={styles.cardBody}>
                  {data.full.sessions.length === 0 ? (
                    <span style={{ color: 'var(--muted-foreground)' }}>
                      No active sessions
                    </span>
                  ) : (
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>Session ID</th>
                          <th>Name</th>
                          <th>Clients</th>
                          <th>Prompts</th>
                          <th>Active</th>
                          <th>Model</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.full.sessions.map((s) => {
                          const sid = s.sessionId as string;
                          return (
                            <tr key={sid}>
                              <td title={sid}>
                                {sid.length > 12
                                  ? `${sid.slice(0, 12)}...`
                                  : sid}
                              </td>
                              <td>{(s.displayName as string) || '-'}</td>
                              <td>{s.clientCount as number}</td>
                              <td>{s.pendingPromptCount as number}</td>
                              <td>
                                <span
                                  className={`${styles.chip} ${chipClass(s.hasActivePrompt as boolean)}`}
                                >
                                  {(s.hasActivePrompt as boolean)
                                    ? 'yes'
                                    : 'no'}
                                </span>
                              </td>
                              <td>{(s.currentModelId as string) || '-'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              {/* Workspace sections */}
              {data.full.workspace && (
                <div className={styles.card}>
                  <div className={styles.cardHeader}>Workspace Status</div>
                  {Object.entries(data.full.workspace).map(
                    ([name, section]) => (
                      <WorkspaceSection
                        key={name}
                        name={name}
                        section={section}
                      />
                    ),
                  )}
                </div>
              )}

              {/* ACP Connections */}
              <div className={styles.card}>
                <div className={styles.cardHeader}>
                  ACP Connections ({data.full.acpConnections.length})
                </div>
                <div className={styles.cardBody}>
                  {data.full.acpConnections.length === 0 ? (
                    <span style={{ color: 'var(--muted-foreground)' }}>
                      No active connections
                    </span>
                  ) : (
                    <pre>
                      {JSON.stringify(data.full.acpConnections, null, 2)}
                    </pre>
                  )}
                </div>
              </div>

              {/* Auth */}
              <div className={styles.card}>
                <div className={styles.cardHeader}>Auth</div>
                <div className={styles.cardBody}>
                  <dl className={styles.kv}>
                    <KV
                      label="Device flow providers"
                      value={
                        data.full.auth.supportedDeviceFlowProviders.join(
                          ', ',
                        ) || 'none'
                      }
                    />
                    <KV
                      label="Pending device flows"
                      value={data.full.auth.pendingDeviceFlowCount}
                    />
                  </dl>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
