// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const summaryReport = {
  v: 1,
  detail: 'summary',
  generatedAt: '2026-07-03T08:00:00.000Z',
  status: 'warning',
  issues: [
    {
      code: 'pending_permissions',
      severity: 'warning',
      message: '2 permission requests are waiting for a client response',
    },
  ],
  daemon: {
    pid: 4242,
    uptimeMs: 3_723_000,
    mode: 'http-bridge',
    workspaceCwd: '/work/demo',
    qwenCodeVersion: '0.9.0',
  },
  security: {
    tokenConfigured: true,
    requireAuth: false,
    loopbackBind: true,
    allowOriginConfigured: false,
    allowOriginMode: 'default',
    sessionShellCommandEnabled: false,
  },
  limits: {
    maxSessions: 8,
    maxPendingPromptsPerSession: 5,
    listenerMaxConnections: null,
    eventRingSize: 1024,
    promptDeadlineMs: 120_000,
    writerIdleTimeoutMs: null,
    channelIdleTimeoutMs: 60_000,
    sessionIdleTimeoutMs: 300_000,
    acpConnectionCap: null,
  },
  capabilities: {
    protocolVersions: { serve: 1 },
    features: ['daemon_status', 'session_events'],
  },
  runtime: {
    sessions: { active: 3 },
    permissions: { pending: 2, policy: 'vote' },
    channel: { live: true },
    channelWorker: { enabled: false, state: 'disabled', channels: [] },
    transport: {
      restSseActive: 1,
      acp: {
        enabled: true,
        connections: 2,
        connectionStreams: 2,
        sessionStreams: 1,
        sseStreams: 1,
        wsStreams: 0,
        pendingClientRequests: 0,
      },
    },
    rateLimit: { enabled: true, rejectedSinceStart: { normal: 37, strict: 4 } },
    process: {
      rss: 200 * 1024 * 1024,
      heapTotal: 80 * 1024 * 1024,
      heapUsed: 50 * 1024 * 1024,
    },
  },
};

const fullReport = {
  ...summaryReport,
  detail: 'full',
  full: {
    sessions: [
      {
        sessionId: 'sess-1',
        workspaceCwd: '/work/demo',
        createdAt: '2026-07-03T07:00:00.000Z',
        displayName: 'My session',
        clientCount: 2,
        subscriberCount: 1,
        attachCount: 1,
        pendingPromptCount: 1,
        pendingPermissionCount: 2,
        hasActivePrompt: true,
        lastEventId: 42,
      },
    ],
    acpConnections: [{ connectionId: 'conn-1' }],
    workspace: {
      mcp: {
        status: 'ok',
        durationMs: 12,
        summary: { servers: 2, connected: 2 },
      },
      preflight: {
        status: 'error',
        durationMs: 30,
        error: { kind: 'error', message: 'preflight exploded' },
      },
    },
    auth: {
      supportedDeviceFlowProviders: ['qwen'],
      pendingDeviceFlowCount: 0,
    },
  },
};

type HookState = {
  report: unknown;
  loading: boolean;
  error: Error | undefined;
};

const summaryReload = vi.fn(async () => undefined);
const fullReload = vi.fn(async () => undefined);
let summaryState: HookState = {
  report: summaryReport,
  loading: false,
  error: undefined,
};
let fullState: HookState = {
  report: fullReport,
  loading: false,
  error: undefined,
};
const seenDetails: Array<string | undefined> = [];

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useDaemonStatus: (options: { detail?: string } = {}) => {
    seenDetails.push(options.detail);
    if (options.detail === 'full') {
      return { ...fullState, data: fullState.report, reload: fullReload };
    }
    return {
      ...summaryState,
      data: summaryState.report,
      reload: summaryReload,
    };
  },
}));

const { DaemonStatusDialog } = await import('./DaemonStatusDialog');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <DaemonStatusDialog />
      </I18nProvider>,
    );
  });
}

beforeEach(() => {
  summaryState = { report: summaryReport, loading: false, error: undefined };
  fullState = { report: fullReport, loading: false, error: undefined };
  seenDetails.length = 0;
  summaryReload.mockClear();
  fullReload.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe('DaemonStatusDialog', () => {
  it('renders the summary report with status badge, issues, and counters', () => {
    mount();
    const text = container!.textContent ?? '';
    expect(text).toContain('Warning');
    expect(text).toContain(
      '2 permission requests are waiting for a client response',
    );
    expect(text).toContain('0.9.0');
    expect(text).toContain('4242');
    expect(text).toContain('/work/demo');
    expect(text).toContain('1h 2m 3s');
    expect(text).toContain('daemon_status');
    // rate-limit rejects are summed across tiers (37 + 4)
    expect(text).toContain('41');
  });

  it('fetches both summary and full detail and renders diagnostics with no toggle', () => {
    mount();
    // Both detail levels are requested up front; there is no user-facing
    // summary/full switch to reason about.
    expect(seenDetails).toContain('summary');
    expect(seenDetails).toContain('full');
    const buttonLabels = Array.from(container!.querySelectorAll('button')).map(
      (el) => el.textContent,
    );
    expect(buttonLabels).not.toContain('Summary');
    expect(buttonLabels).not.toContain('Full');
    // Detail sections render immediately alongside the summary cards.
    const text = container!.textContent ?? '';
    expect(text).toContain('My session');
    expect(text).toContain('preflight exploded');
    expect(text).toContain('Workspace Diagnostics');
  });

  it('auto-refresh reloads only the cheap summary, never the full report', () => {
    vi.useFakeTimers();
    mount();
    expect(summaryReload).not.toHaveBeenCalled();
    expect(fullReload).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(summaryReload).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(summaryReload).toHaveBeenCalledTimes(3);
    // The expensive detail path is never hit by the interval.
    expect(fullReload).not.toHaveBeenCalled();
  });

  it('manual refresh reloads both summary and full', () => {
    mount();
    const refreshButton = Array.from(
      container!.querySelectorAll('button'),
    ).find((el) => el.textContent === 'Refresh');
    expect(refreshButton).toBeDefined();
    act(() => {
      refreshButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(summaryReload).toHaveBeenCalledTimes(1);
    expect(fullReload).toHaveBeenCalledTimes(1);
  });

  it('stops refreshing after unmount', () => {
    vi.useFakeTimers();
    mount();
    act(() => root!.unmount());
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(summaryReload).not.toHaveBeenCalled();
    expect(fullReload).not.toHaveBeenCalled();
  });

  it('renders summary cards while the diagnostics are still loading', () => {
    fullState = { report: undefined, loading: true, error: undefined };
    mount();
    const text = container!.textContent ?? '';
    // Top cards come from the summary and render right away...
    expect(text).toContain('4242');
    // ...while the detail sections show a loading placeholder.
    expect(text).toContain('Loading diagnostics');
    expect(text).not.toContain('Workspace Diagnostics');
  });

  it('shows the load error when no report is available', () => {
    summaryState = {
      report: undefined,
      loading: false,
      error: new Error('connection refused'),
    };
    fullState = { report: undefined, loading: false, error: undefined };
    mount();
    const text = container!.textContent ?? '';
    expect(text).toContain('Failed to load daemon status');
    expect(text).toContain('connection refused');
  });
});
