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
    // Real daemon rate-limit tiers (RateLimitTier = prompt | mutation | read).
    rateLimit: {
      enabled: true,
      rejectedSinceStart: { prompt: 37, mutation: 3, read: 1 },
    },
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
  // The daemon rolls workspace/preflight problems into status + issues only for
  // detail=full, so the full report is strictly more severe than the summary.
  status: 'error',
  issues: [
    ...summaryReport.issues,
    {
      code: 'preflight_error',
      severity: 'error',
      section: 'workspace.preflight',
      message: 'preflight failed: node version too old',
    },
  ],
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
  useStatusReport: (options: { detail?: string } = {}) => {
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

function mount(language: 'en' | 'zh-CN' = 'en') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider language={language}>
        <DaemonStatusDialog />
      </I18nProvider>,
    );
  });
}

// The toolbar status badge is the first span whose text is a level label; it
// renders before the issues card, so `find` returns the top badge.
function topBadgeText(): string | undefined {
  return Array.from(container!.querySelectorAll('span'))
    .map((s) => s.textContent?.trim() ?? '')
    .find(
      (label) => label === 'OK' || label === 'Warning' || label === 'Error',
    );
}

beforeEach(() => {
  summaryState = { report: summaryReport, loading: false, error: undefined };
  fullState = { report: fullReport, loading: false, error: undefined };
  seenDetails.length = 0;
  summaryReload.mockReset();
  summaryReload.mockImplementation(async () => undefined);
  fullReload.mockReset();
  fullReload.mockImplementation(async () => undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe('DaemonStatusDialog', () => {
  it('renders live summary counters with the full-detail rollup badge', () => {
    mount();
    const text = container!.textContent ?? '';
    // Live counters come from the summary response.
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
    // The badge + issues reflect the full rollup (error + preflight), not the
    // summary (warning) — otherwise the dialog would read "OK/Warning" while a
    // loaded full diagnostic is failing.
    expect(topBadgeText()).toBe('Error');
    expect(text).toContain('preflight failed: node version too old');
  });

  it('translates workspace section status badges, including "unavailable"', () => {
    fullState = {
      report: {
        ...fullReport,
        full: {
          ...fullReport.full,
          workspace: {
            preflight: {
              status: 'unavailable',
              durationMs: 5,
              error: { kind: 'timeout', message: 'timed out' },
            },
          },
        },
      },
      loading: false,
      error: undefined,
    };
    mount('zh-CN');
    const text = container!.textContent ?? '';
    // The section badge is translated ("不可用"), not the raw wire value.
    expect(text).toContain('不可用');
    expect(text).not.toContain('unavailable');
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
    // A healthy workspace section renders its name, translated status, and
    // summary chips.
    expect(text).toContain('mcp');
    expect(text).toContain('OK');
    expect(text).toContain('servers: 2');
  });

  it('auto-refresh reloads only the cheap summary, never the full report', async () => {
    vi.useFakeTimers();
    mount();
    expect(summaryReload).not.toHaveBeenCalled();
    // Advance one interval at a time, flushing the in-flight `.finally` between
    // ticks so the guard is clear for the next tick.
    for (let tick = 1; tick <= 3; tick++) {
      await act(async () => {
        vi.advanceTimersByTime(5_000);
        await Promise.resolve();
      });
      expect(summaryReload).toHaveBeenCalledTimes(tick);
    }
    // The expensive detail path is never hit by the interval.
    expect(fullReload).not.toHaveBeenCalled();
  });

  it('skips a poll tick while the previous summary reload is still in flight', async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    summaryReload.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    mount();
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(summaryReload).toHaveBeenCalledTimes(1); // first tick, still pending
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(summaryReload).toHaveBeenCalledTimes(1); // coalesced away while pending
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(summaryReload).toHaveBeenCalledTimes(2); // fires again once free
  });

  it('does not poll while the tab is backgrounded', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });
    mount();
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(summaryReload).not.toHaveBeenCalled();
    // Bring the tab back to the foreground; polling resumes.
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
    });
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(summaryReload).toHaveBeenCalledTimes(1);
    Reflect.deleteProperty(document, 'hidden');
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

  it('falls back to the summary rollup badge while diagnostics are still loading', () => {
    fullState = { report: undefined, loading: true, error: undefined };
    mount();
    const text = container!.textContent ?? '';
    // Top cards come from the summary and render right away...
    expect(text).toContain('4242');
    // ...while the detail sections show a loading placeholder.
    expect(text).toContain('Loading diagnostics');
    expect(text).not.toContain('Workspace Diagnostics');
    // Before the full report lands the badge reflects the summary rollup, and
    // the full-only preflight issue is not shown yet.
    expect(topBadgeText()).toBe('Warning');
    expect(text).not.toContain('preflight failed: node version too old');
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

  it('keeps the toolbar healthy when only the full fetch fails, and flags the detail section', () => {
    // Summary succeeds (cards + timestamp fresh); only the detail fetch fails.
    fullState = {
      report: undefined,
      loading: false,
      error: new Error('full boom'),
    };
    mount();
    const text = container!.textContent ?? '';
    // Live summary cards still render...
    expect(text).toContain('4242');
    expect(text).toContain('http-bridge');
    // ...the toolbar does NOT show the summary-failure banner...
    expect(text).not.toContain('Failed to load daemon status');
    // ...and the failure is confined to the diagnostics section.
    expect(text).toContain('Failed to load diagnostics');
    // With no full report, the badge falls back to the summary rollup.
    expect(topBadgeText()).toBe('Warning');
  });

  it('renders the ACP-disabled branch when the transport is off', () => {
    const acpOff = {
      ...summaryReport,
      runtime: {
        ...summaryReport.runtime,
        transport: {
          ...summaryReport.runtime.transport,
          acp: {
            ...summaryReport.runtime.transport.acp,
            enabled: false,
          },
        },
      },
    };
    summaryState = { report: acpOff, loading: false, error: undefined };
    fullState = { report: undefined, loading: true, error: undefined };
    mount();
    const text = container!.textContent ?? '';
    expect(text).toContain('ACP transport disabled');
    expect(text).not.toContain('ACP streams (session/SSE/WS)');
  });

  it('formats uptime, memory, and durations across unit boundaries', () => {
    const boundaries = {
      ...summaryReport,
      daemon: { ...summaryReport.daemon, uptimeMs: 90_061_000 }, // 1d 1h 1m
      limits: {
        ...summaryReport.limits,
        promptDeadlineMs: 1_500, // fractional seconds -> "1.5s"
        sessionIdleTimeoutMs: 500, // sub-second -> "500ms"
      },
      runtime: {
        ...summaryReport.runtime,
        process: {
          rss: 2 * 1024 * 1024 * 1024, // 2 GB
          heapTotal: 1024 * 1024 * 1024,
          heapUsed: 512 * 1024 * 1024, // 512.0 MB
        },
      },
    };
    summaryState = { report: boundaries, loading: false, error: undefined };
    fullState = { report: undefined, loading: true, error: undefined };
    mount();
    const text = container!.textContent ?? '';
    expect(text).toContain('1d 1h 1m'); // formatUptime day branch
    expect(text).toContain('2.00 GB'); // formatBytes GB branch
    expect(text).toContain('512.0 MB'); // formatBytes MB branch
    expect(text).toContain('1.5s'); // formatDurationMs fractional-second branch
    expect(text).toContain('500ms'); // formatDurationMs sub-second branch
  });

  it('surfaces runtime startup state and channel-worker diagnostics', () => {
    const degraded = {
      ...summaryReport,
      runtime: {
        ...summaryReport.runtime,
        loading: true,
        channel: { live: false },
        channelWorker: {
          enabled: true,
          state: 'exited',
          channels: ['alpha'],
          error: 'worker crashed on boot',
          restartCount: 3,
          exitCode: 1,
        },
      },
    };
    summaryState = { report: degraded, loading: false, error: undefined };
    fullState = { report: undefined, loading: true, error: undefined };
    mount();
    const text = container!.textContent ?? '';
    expect(text).toContain('Runtime is starting'); // runtime.loading cue
    expect(text).toContain('down'); // channel.live === false
    expect(text).toContain('exited (exit 1)'); // channelWorkerState()
    expect(text).toContain('worker crashed on boot'); // channelWorker.error
    expect(text).toContain('Worker restarts'); // restartCount > 0
    expect(text).toContain('3');
  });

  it('shows the runtime start-failure message', () => {
    const failed = {
      ...summaryReport,
      runtime: { ...summaryReport.runtime, error: 'bind EADDRINUSE :4170' },
    };
    summaryState = { report: failed, loading: false, error: undefined };
    fullState = { report: undefined, loading: true, error: undefined };
    mount();
    const text = container!.textContent ?? '';
    expect(text).toContain('Runtime failed to start');
    expect(text).toContain('bind EADDRINUSE :4170');
  });

  it('renders empty/disabled placeholders (sessions, rate limit, capabilities, ACP)', () => {
    const sparseSummary = {
      ...summaryReport,
      capabilities: { protocolVersions: { serve: 1 }, features: [] },
      runtime: {
        ...summaryReport.runtime,
        rateLimit: { enabled: false, rejectedSinceStart: {} },
        transport: {
          ...summaryReport.runtime.transport,
          acp: { ...summaryReport.runtime.transport.acp, enabled: false },
        },
      },
    };
    summaryState = { report: sparseSummary, loading: false, error: undefined };
    fullState = {
      report: { ...fullReport, full: { ...fullReport.full, sessions: [] } },
      loading: false,
      error: undefined,
    };
    mount();
    const text = container!.textContent ?? '';
    expect(text).toContain('No active sessions'); // empty sessions placeholder
    expect(text).toContain('ACP transport disabled'); // acp.enabled === false
    // rate-limit disabled and empty capabilities both render "disabled"/"none".
    expect(text).toContain('disabled');
    expect(text).toContain('none');
  });

  it('shows the toolbar failure banner when a poll fails but data is present', () => {
    // Distinct from the no-data early return: the summary has stale data plus
    // an error, so the cards render and the toolbar banner appears.
    summaryState = {
      report: summaryReport,
      loading: false,
      error: new Error('poll failed'),
    };
    mount();
    const text = container!.textContent ?? '';
    expect(text).toContain('4242'); // stale cards still render
    expect(text).toContain('Failed to load daemon status'); // toolbar banner
  });

  it('shows the pure loading state before any report arrives', () => {
    summaryState = { report: undefined, loading: true, error: undefined };
    fullState = { report: undefined, loading: true, error: undefined };
    mount();
    const text = container!.textContent ?? '';
    expect(text).toContain('Loading daemon status');
    expect(text).not.toContain('Failed to load daemon status');
  });

  it('renders the workspace empty-state when no sections are reported', () => {
    fullState = {
      report: { ...fullReport, full: { ...fullReport.full, workspace: {} } },
      loading: false,
      error: undefined,
    };
    mount();
    expect(container!.textContent ?? '').toContain(
      'No workspace diagnostics reported',
    );
  });

  it('contains a malformed daemon response and surfaces the render error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // channelWorker is required by the wire type, but an older daemon could
    // omit it; the inner render would throw on `.enabled` without the boundary.
    summaryState = {
      report: {
        ...summaryReport,
        runtime: { ...summaryReport.runtime, channelWorker: undefined },
      },
      loading: false,
      error: undefined,
    };
    fullState = { report: undefined, loading: false, error: undefined };
    mount();
    const text = container!.textContent ?? '';
    // The outer boundary fallback renders instead of the throw escaping, and
    // the function-form fallback surfaces the actual render error.
    expect(text).toContain('Failed to load daemon status');
    expect(text).toContain('enabled'); // the TypeError message is included
    errorSpy.mockRestore();
  });

  it('contains a detail-section crash without losing the summary cards', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A malformed detail=full payload (auth omitted) throws inside FullDetail.
    summaryState = { report: summaryReport, loading: false, error: undefined };
    fullState = {
      report: {
        ...fullReport,
        full: {
          sessions: [],
          workspace: {},
          acpConnections: [],
          auth: undefined,
        },
      },
      loading: false,
      error: undefined,
    };
    mount();
    const text = container!.textContent ?? '';
    // Summary cards stay live; only the detail region shows its own fallback.
    expect(text).toContain('4242');
    expect(text).toContain('Failed to load diagnostics');
    // The whole-dialog (outer) fallback did NOT trigger.
    expect(text).not.toContain('Failed to load daemon status');
    errorSpy.mockRestore();
  });

  it('shows a failed state when the full fetch resolves without a full section', () => {
    summaryState = { report: summaryReport, loading: false, error: undefined };
    // Fetch resolved (no error, not loading) but the daemon omitted `full`.
    fullState = {
      report: { ...summaryReport },
      loading: false,
      error: undefined,
    };
    mount();
    const text = container!.textContent ?? '';
    expect(text).toContain('Failed to load diagnostics');
    expect(text).not.toContain('Loading diagnostics');
  });

  it('renders runtime.activity counters when the daemon reports them', () => {
    summaryState = {
      report: {
        ...summaryReport,
        runtime: {
          ...summaryReport.runtime,
          activity: {
            activePrompts: 2,
            lastActivityAt: '2026-07-03T07:59:00.000Z',
            idleSinceMs: 65_000,
          },
        },
      },
      loading: false,
      error: undefined,
    };
    fullState = { report: undefined, loading: true, error: undefined };
    mount();
    const text = container!.textContent ?? '';
    expect(text).toContain('Active prompts');
    expect(text).toContain('2');
    expect(text).toContain('Idle for');
    expect(text).toContain('1m 5s'); // formatDurationMs(65000)
  });

  it('shows "no activity yet" when idleSinceMs is null', () => {
    summaryState = {
      report: {
        ...summaryReport,
        runtime: {
          ...summaryReport.runtime,
          activity: {
            activePrompts: 0,
            lastActivityAt: null,
            idleSinceMs: null,
          },
        },
      },
      loading: false,
      error: undefined,
    };
    fullState = { report: undefined, loading: true, error: undefined };
    mount();
    expect(container!.textContent ?? '').toContain('no activity yet');
  });

  it('omits the activity rows for a daemon that predates runtime.activity', () => {
    // The default fixture has no runtime.activity — the section must not render.
    mount();
    expect(container!.textContent ?? '').not.toContain('Active prompts');
  });

  it('falls back to the session id when a session has no display name', () => {
    fullState = {
      report: {
        ...fullReport,
        full: {
          ...fullReport.full,
          sessions: [
            {
              sessionId: 'sess-no-name-9',
              workspaceCwd: '/work/demo',
              createdAt: '2026-07-03T07:00:00.000Z',
              clientCount: 1,
              subscriberCount: 0,
              attachCount: 0,
              pendingPromptCount: 0,
              pendingPermissionCount: 0,
              hasActivePrompt: false,
              lastEventId: 1,
            },
          ],
        },
      },
      loading: false,
      error: undefined,
    };
    mount();
    expect(container!.textContent ?? '').toContain('sess-no-name-9');
  });

  it('names the individual warning/error cells behind a section status', () => {
    fullState = {
      report: {
        ...fullReport,
        full: {
          ...fullReport.full,
          workspace: {
            preflight: {
              status: 'warning',
              durationMs: 8,
              summary: { initialized: true, cellsCount: 3 },
              data: {
                cells: [
                  { kind: 'node_version', status: 'ok' },
                  {
                    kind: 'auth',
                    status: 'warning',
                    error: 'No auth method configured.',
                  },
                  { kind: 'egress', status: 'not_started', hint: 'not impl' },
                ],
              },
            },
          },
        },
      },
      loading: false,
      error: undefined,
    };
    mount();
    const text = container!.textContent ?? '';
    // The warning cell is named with its message...
    expect(text).toContain('auth');
    expect(text).toContain('No auth method configured.');
    // ...while ok / not_started cells are not surfaced as problems.
    expect(text).not.toContain('node_version');
    expect(text).not.toContain('not impl');
  });

  it('formats the channel-worker signal branch', () => {
    summaryState = {
      report: {
        ...summaryReport,
        runtime: {
          ...summaryReport.runtime,
          channel: { live: false },
          channelWorker: {
            enabled: true,
            state: 'exited',
            channels: [],
            signal: 'SIGTERM', // no exitCode -> signal branch
          },
        },
      },
      loading: false,
      error: undefined,
    };
    fullState = { report: undefined, loading: true, error: undefined };
    mount();
    expect(container!.textContent ?? '').toContain('exited (SIGTERM)');
  });

  it('suppresses the toolbar banner when the summary is absent but the full fallback provides data', () => {
    summaryState = {
      report: undefined,
      loading: false,
      error: new Error('summary poll down'),
    };
    fullState = { report: fullReport, loading: false, error: undefined };
    mount();
    const text = container!.textContent ?? '';
    // Cards render from the full fallback...
    expect(text).toContain('4242');
    // ...so the toolbar must not claim the dashboard failed to load.
    expect(text).not.toContain('Failed to load daemon status');
  });
});
