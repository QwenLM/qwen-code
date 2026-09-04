import { useCallback, useEffect, useState } from 'react';
import { getFolders, getModels, getStats, getTools, triggerSync } from './api.js';
import type { DashboardStats, FolderStats, ModelStats, TimeRange, ToolStatsSummary } from '../shared-types.js';

// ---------------------------------------------------------------------------
// Hash router
// ---------------------------------------------------------------------------

function useHashRoute(): [string, (r: string) => void] {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/overview');

  useEffect(() => {
    const onHash = () => setRoute(window.location.hash.slice(1) || '/overview');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = useCallback((r: string) => {
    window.location.hash = r;
  }, []);

  return [route, navigate];
}

// ---------------------------------------------------------------------------
// Range selector
// ---------------------------------------------------------------------------

const RANGES: { label: string; value: TimeRange }[] = [
  { label: '1h', value: '1h' },
  { label: '6h', value: '6h' },
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
  { label: '30d', value: '30d' },
  { label: 'All', value: 'all' },
];

function RangeSelector({ range, onChange }: { range: TimeRange; onChange: (r: TimeRange) => void }) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {RANGES.map((r) => (
        <button
          key={r.value}
          onClick={() => onChange(r.value)}
          style={{
            padding: '4px 10px',
            borderRadius: 4,
            border: range === r.value ? '1px solid #58a6ff' : '1px solid #30363d',
            background: range === r.value ? '#1f6feb33' : 'transparent',
            color: range === r.value ? '#58a6ff' : '#8b949e',
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div
      style={{
        background: '#161b22',
        border: '1px solid #30363d',
        borderRadius: 8,
        padding: '16px 20px',
        minWidth: 140,
      }}
    >
      <div style={{ color: '#8b949e', fontSize: 12, marginBottom: 4 }}>{label}</div>
      <div style={{ color: '#e6edf3', fontSize: 22, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ color: '#8b949e', fontSize: 11, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview page
// ---------------------------------------------------------------------------

function OverviewPage({ range }: { range: TimeRange }) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getStats(range)
      .then(setStats)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [range]);

  if (loading || !stats) return <div style={{ color: '#8b949e', padding: 40 }}>Loading...</div>;

  const o = stats.overview;
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
        <StatCard label="Total Requests" value={o.totalRequests.toLocaleString()} sub={`${o.successfulRequests} ok / ${o.failedRequests} err`} />
        <StatCard label="Input Tokens" value={o.totalInputTokens.toLocaleString()} />
        <StatCard label="Output Tokens" value={o.totalOutputTokens.toLocaleString()} />
        <StatCard label="Cache Read" value={o.totalCacheReadTokens.toLocaleString()} sub={`hit rate ${(o.cacheRate * 100).toFixed(1)}%`} />
        <StatCard label="Avg Duration" value={o.avgDuration != null ? `${(o.avgDuration / 1000).toFixed(1)}s` : '—'} />
        <StatCard label="Avg TTFT" value={o.avgTtft != null ? `${o.avgTtft.toFixed(0)}ms` : '—'} />
        <StatCard label="Avg TPS" value={o.avgTokensPerSecond != null ? o.avgTokensPerSecond.toFixed(1) : '—'} />
        <StatCard label="Error Rate" value={`${(o.errorRate * 100).toFixed(1)}%`} />
      </div>

      {/* Recent requests */}
      {stats.recentRequests.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h3 style={{ color: '#e6edf3', fontSize: 14, marginBottom: 12 }}>Recent Requests</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #30363d' }}>
                <th style={thStyle}>Time</th>
                <th style={thStyle}>Model</th>
                <th style={thStyle}>Duration</th>
                <th style={thStyle}>Tokens (in/out)</th>
                <th style={thStyle}>Status</th>
              </tr>
            </thead>
            <tbody>
              {stats.recentRequests.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid #21262d' }}>
                  <td style={tdStyle}>{new Date(r.timestamp).toLocaleTimeString()}</td>
                  <td style={tdStyle}>{r.model}</td>
                  <td style={tdStyle}>{r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}</td>
                  <td style={tdStyle}>{r.inputTokens}/{r.outputTokens}</td>
                  <td style={{ ...tdStyle, color: r.isError ? '#f85149' : '#3fb950' }}>{r.isError ? 'error' : 'ok'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Models page
// ---------------------------------------------------------------------------

function ModelsPage({ range }: { range: TimeRange }) {
  const [models, setModels] = useState<ModelStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getModels(range)
      .then(setModels)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [range]);

  if (loading) return <div style={{ color: '#8b949e', padding: 40 }}>Loading...</div>;

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid #30363d' }}>
          <th style={thStyle}>Model</th>
          <th style={thStyle}>Requests</th>
          <th style={thStyle}>Success</th>
          <th style={thStyle}>Input Tokens</th>
          <th style={thStyle}>Output Tokens</th>
          <th style={thStyle}>Cache Hit</th>
          <th style={thStyle}>Avg Duration</th>
          <th style={thStyle}>Avg TTFT</th>
        </tr>
      </thead>
      <tbody>
        {models.map((m) => (
          <tr key={m.model} style={{ borderBottom: '1px solid #21262d' }}>
            <td style={tdStyle}>{m.model}</td>
            <td style={tdStyle}>{m.totalRequests}</td>
            <td style={tdStyle}>{m.successfulRequests}</td>
            <td style={tdStyle}>{m.totalInputTokens.toLocaleString()}</td>
            <td style={tdStyle}>{m.totalOutputTokens.toLocaleString()}</td>
            <td style={tdStyle}>{(m.cacheRate * 100).toFixed(1)}%</td>
            <td style={tdStyle}>{m.avgDuration != null ? `${(m.avgDuration / 1000).toFixed(1)}s` : '—'}</td>
            <td style={tdStyle}>{m.avgTtft != null ? `${m.avgTtft.toFixed(0)}ms` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Folders page
// ---------------------------------------------------------------------------

function FoldersPage({ range }: { range: TimeRange }) {
  const [folders, setFolders] = useState<FolderStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getFolders(range)
      .then(setFolders)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [range]);

  if (loading) return <div style={{ color: '#8b949e', padding: 40 }}>Loading...</div>;

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid #30363d' }}>
          <th style={thStyle}>Folder</th>
          <th style={thStyle}>Requests</th>
          <th style={thStyle}>Success</th>
          <th style={thStyle}>Input Tokens</th>
          <th style={thStyle}>Output Tokens</th>
          <th style={thStyle}>Avg Duration</th>
        </tr>
      </thead>
      <tbody>
        {folders.map((f) => (
          <tr key={f.folder} style={{ borderBottom: '1px solid #21262d' }}>
            <td style={tdStyle}>{f.folder}</td>
            <td style={tdStyle}>{f.totalRequests}</td>
            <td style={tdStyle}>{f.successfulRequests}</td>
            <td style={tdStyle}>{f.totalInputTokens.toLocaleString()}</td>
            <td style={tdStyle}>{f.totalOutputTokens.toLocaleString()}</td>
            <td style={tdStyle}>{f.avgDuration != null ? `${(f.avgDuration / 1000).toFixed(1)}s` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Tools page
// ---------------------------------------------------------------------------

function ToolsPage({ range }: { range: TimeRange }) {
  const [tools, setTools] = useState<ToolStatsSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getTools(range)
      .then(setTools)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [range]);

  if (loading || !tools) return <div style={{ color: '#8b949e', padding: 40 }}>Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
        <StatCard label="Total Calls" value={tools.totalCalls.toLocaleString()} />
        <StatCard label="Success Rate" value={`${(tools.successRate * 100).toFixed(1)}%`} />
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #30363d' }}>
            <th style={thStyle}>Tool</th>
            <th style={thStyle}>Calls</th>
            <th style={thStyle}>Success Rate</th>
            <th style={thStyle}>Avg Duration</th>
          </tr>
        </thead>
        <tbody>
          {tools.byTool.map((t) => (
            <tr key={t.toolName} style={{ borderBottom: '1px solid #21262d' }}>
              <td style={tdStyle}>{t.toolName}</td>
              <td style={tdStyle}>{t.calls}</td>
              <td style={tdStyle}>{(t.successRate * 100).toFixed(1)}%</td>
              <td style={tdStyle}>{t.avgDurationMs != null ? `${(t.avgDurationMs / 1000).toFixed(1)}s` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table styles
// ---------------------------------------------------------------------------

const thStyle: React.CSSProperties = { padding: '8px 12px', color: '#888', fontWeight: 500, textAlign: 'left' };
const tdStyle: React.CSSProperties = { padding: '6px 12px', color: '#ddd' };

// ---------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------

const NAV_ITEMS = [
  { path: '/overview', label: 'Overview' },
  { path: '/models', label: 'Models' },
  { path: '/folders', label: 'Folders' },
  { path: '/tools', label: 'Tools' },
];

export function App() {
  const [route, navigate] = useHashRoute();
  const [range, setRange] = useState<TimeRange>('24h');
  const [syncing, setSyncing] = useState(false);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await triggerSync();
      // Force re-render by toggling range
      setRange((r) => r);
    } catch (err) {
      console.error('Sync failed:', err);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: '#0d1117', color: '#e6edf3', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif' }}>
      {/* Header */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 24px',
          borderBottom: '1px solid #30363d',
          background: '#161b22',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <h1 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Qwen Stats</h1>
          <nav style={{ display: 'flex', gap: 4 }}>
            {NAV_ITEMS.map((item) => (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                style={{
                  padding: '6px 12px',
                  borderRadius: 6,
                  border: 'none',
                  background: route === item.path ? '#30363d' : 'transparent',
                  color: route === item.path ? '#e6edf3' : '#8b949e',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 500,
                }}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <RangeSelector range={range} onChange={setRange} />
          <button
            onClick={handleSync}
            disabled={syncing}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid #30363d',
              background: syncing ? '#21262d' : '#238636',
              color: '#fff',
              cursor: syncing ? 'default' : 'pointer',
              fontSize: 13,
              opacity: syncing ? 0.6 : 1,
            }}
          >
            {syncing ? 'Syncing...' : 'Sync'}
          </button>
        </div>
      </header>

      {/* Content */}
      <main style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
        {route === '/overview' && <OverviewPage range={range} />}
        {route === '/models' && <ModelsPage range={range} />}
        {route === '/folders' && <FoldersPage range={range} />}
        {route === '/tools' && <ToolsPage range={range} />}
      </main>
    </div>
  );
}
