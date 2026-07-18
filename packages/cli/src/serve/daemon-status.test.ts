/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AcpHttpConnectionDiagnostic,
  AcpHttpHandle,
  AcpHttpSnapshot,
} from './acp-http/index.js';
import type {
  AcpSessionBridge,
  BridgeDaemonStatusSnapshot,
} from './acp-session-bridge.js';
import { DeviceFlowRegistry } from './auth/device-flow.js';
import {
  buildDaemonStatusResponse,
  type BuildDaemonStatusOptions,
  type DaemonMetricsBucket,
} from './daemon-status.js';
import type { ChannelWorkerSnapshot } from './channel-worker-supervisor.js';
import type { RateLimiterInstance, RateLimitTier } from './rate-limit.js';
import type { DaemonWorkspaceService } from './workspace-service/index.js';

const BASE_WORKSPACE = '/work/status';

const BASE_BRIDGE_SNAPSHOT: BridgeDaemonStatusSnapshot = {
  limits: {
    maxSessions: 20,
    maxPendingPromptsPerSession: 5,
    eventRingSize: 8000,
    compactedReplayMaxBytes: 4 * 1024 * 1024,
    channelIdleTimeoutMs: 0,
    sessionIdleTimeoutMs: 1_800_000,
  },
  sessionCount: 0,
  pendingPermissionCount: 0,
  channelLive: true,
  permissionPolicy: 'first-responder',
  sessions: [],
};

afterEach(() => {
  vi.useRealTimers();
});

describe('buildDaemonStatusResponse', () => {
  it('includes maxTotalSessions in daemon status limits', async () => {
    const options = makeOptions();
    options.opts.maxTotalSessions = 50;
    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.limits.maxTotalSessions).toBe(50);
  });

  it('warns when total session capacity is high and reports in-flight admission', async () => {
    const options = makeOptions({
      totalAdmissionInFlight: 1,
      bridgeSnapshot: {
        ...BASE_BRIDGE_SNAPSHOT,
        sessionCount: 7,
      },
    });
    options.opts.maxTotalSessions = 10;

    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.runtime.sessions).toMatchObject({
      active: 7,
      admissionInFlight: 1,
    });
    expect(response).toMatchObject({
      status: 'warning',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'total_session_capacity_high' }),
      ]),
    });
  });

  it('uses total admission live count for total session capacity warnings', async () => {
    const options = makeOptions({
      totalAdmissionLiveCount: 8,
      totalAdmissionInFlight: 1,
      bridgeSnapshot: {
        ...BASE_BRIDGE_SNAPSHOT,
        sessionCount: 1,
      },
    });
    options.opts.maxTotalSessions = 10;

    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.runtime.sessions).toMatchObject({
      active: 1,
      admissionInFlight: 1,
    });
    expect(response).toMatchObject({
      status: 'warning',
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'total_session_capacity_high',
          message: 'Total active and in-flight sessions are at 9/10.',
        }),
      ]),
    });
  });

  it('reuses the primary bridge snapshot when a workspace registry is installed', async () => {
    const primarySnapshot = vi.fn(() => ({
      ...BASE_BRIDGE_SNAPSHOT,
      sessionCount: 1,
    }));
    const secondarySnapshot = vi.fn(() => ({
      ...BASE_BRIDGE_SNAPSHOT,
      sessionCount: 2,
    }));
    const primaryBridge = {
      getDaemonStatusSnapshot: primarySnapshot,
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;
    const secondaryBridge = {
      getDaemonStatusSnapshot: secondarySnapshot,
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;
    const options = makeOptions();
    options.bridge = primaryBridge;
    options.workspaceRegistry = {
      primary: {
        workspaceId: 'primary',
        workspaceCwd: BASE_WORKSPACE,
        primary: true,
        trusted: true,
        bridge: primaryBridge,
      },
      list: () => [
        {
          workspaceId: 'primary',
          workspaceCwd: BASE_WORKSPACE,
          primary: true,
          trusted: true,
          bridge: primaryBridge,
        },
        {
          workspaceId: 'secondary',
          workspaceCwd: '/work/secondary',
          displayName: 'Secondary workspace',
          primary: false,
          trusted: true,
          bridge: secondaryBridge,
        },
      ],
    } as unknown as BuildDaemonStatusOptions['workspaceRegistry'];

    const response = await buildDaemonStatusResponse('summary', options);

    expect(primarySnapshot).toHaveBeenCalledTimes(1);
    expect(secondarySnapshot).toHaveBeenCalledTimes(1);
    expect(response.runtime.sessions.active).toBe(3);
    expect(response.workspaces).toEqual([
      {
        id: 'primary',
        cwd: BASE_WORKSPACE,
        primary: true,
        trusted: true,
      },
      {
        id: 'secondary',
        cwd: '/work/secondary',
        displayName: 'Secondary workspace',
        primary: false,
        trusted: true,
      },
    ]);
  });

  it('reports every runtime issue code from daemon counters', async () => {
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({
        bridgeSnapshot: {
          ...BASE_BRIDGE_SNAPSHOT,
          limits: { ...BASE_BRIDGE_SNAPSHOT.limits, maxSessions: 10 },
          sessionCount: 8,
          pendingPermissionCount: 2,
          channelLive: false,
        },
        acpSnapshot: {
          connectionCount: 8,
          connectionCap: 10,
          connectionStreams: 1,
          sessionStreams: 1,
          sseStreams: 1,
          wsStreams: 0,
          pendingClientRequests: 0,
          connections: [],
        },
        rateLimitHits: { prompt: 1, mutation: 2, read: 3 },
        rateLimitEnabled: true,
      }),
    );

    expect(response).toMatchObject({
      status: 'error',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'session_capacity_high' }),
        expect.objectContaining({ code: 'connection_capacity_high' }),
        expect.objectContaining({ code: 'pending_permissions' }),
        expect.objectContaining({ code: 'acp_channel_down' }),
        expect.objectContaining({ code: 'rate_limit_hits' }),
      ]),
    });
  });

  it('reports aggregate workspace-attributed ACP diagnostics in full status', async () => {
    const primaryDiagnostic = makeAcpDiagnostic(null, BASE_WORKSPACE, true);
    const secondaryDiagnostic = makeAcpDiagnostic(
      'secondary-id',
      '/work/secondary',
      false,
    );
    const primaryRegistrySnapshot = {
      connectionCount: 1,
      connectionCap: 10,
      connectionStreams: 1,
      sessionStreams: 0,
      sseStreams: 0,
      wsStreams: 1,
      pendingClientRequests: 0,
      connections: [primaryDiagnostic],
    };

    const response = await buildDaemonStatusResponse(
      'full',
      makeOptions({
        acpSnapshot: primaryRegistrySnapshot,
        acpAggregate: {
          connectionCount: 2,
          connectionStreams: 2,
          sessionStreams: 0,
          sseStreams: 0,
          wsStreams: 2,
          pendingClientRequests: 0,
          mounts: [],
          connections: [primaryDiagnostic, secondaryDiagnostic],
        },
      }),
    );

    expect(response.runtime.transport.acp.connections).toBe(2);
    expect(response.full?.acpConnections).toEqual([
      primaryDiagnostic,
      secondaryDiagnostic,
    ]);
  });

  it('embeds runtime.metrics.series when getMetricsSeries is provided, and omits it otherwise', async () => {
    const base = makeOptions({});
    const withSeries = await buildDaemonStatusResponse('summary', {
      ...base,
      getMetricsSeries: () => [{ t: 1 } as DaemonMetricsBucket],
    });
    expect(withSeries.runtime.metrics?.series).toHaveLength(1);

    // Omitting the provider leaves no `metrics` key — backward compatible with
    // older clients that don't expect it.
    const without = await buildDaemonStatusResponse('summary', base);
    expect(without.runtime.metrics).toBeUndefined();
  });

  it('reports permanently failed channel worker snapshots as errors', async () => {
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({
        channelWorkerSnapshot: {
          enabled: true,
          state: 'failed',
          channels: ['telegram'],
          pid: 1234,
          error: 'ipc failed',
          restartCount: 2,
          lastExitAt: '2026-07-01T01:00:00.000Z',
          lastRestartAt: '2026-07-01T01:00:05.000Z',
          lastHeartbeatAt: '2026-07-01T00:59:50.000Z',
        },
      }),
    );

    expect(response).toMatchObject({
      status: 'error',
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'channel_worker_exited',
          severity: 'error',
          message:
            'Channel worker is failed (pid=1234, restarts=2, lastExitAt=2026-07-01T01:00:00.000Z, lastRestartAt=2026-07-01T01:00:05.000Z, lastHeartbeatAt=2026-07-01T00:59:50.000Z): ipc failed.',
          section: 'runtime.channelWorker',
        }),
      ]),
      runtime: {
        channelWorker: {
          enabled: true,
          state: 'failed',
          channels: ['telegram'],
          pid: 1234,
          error: 'ipc failed',
          restartCount: 2,
          lastExitAt: '2026-07-01T01:00:00.000Z',
          lastRestartAt: '2026-07-01T01:00:05.000Z',
          lastHeartbeatAt: '2026-07-01T00:59:50.000Z',
        },
      },
    });
  });

  it('reports and diagnoses non-primary channel workers', async () => {
    const options = makeOptions({
      channelWorkerSnapshot: {
        enabled: false,
        state: 'disabled',
        channels: [],
      },
    });
    options.workspaceRegistry = {
      list: () => [
        {
          workspaceId: 'primary',
          workspaceCwd: BASE_WORKSPACE,
          primary: true,
          trusted: true,
          bridge: options.bridge,
        },
        {
          workspaceId: 'secondary',
          workspaceCwd: '/work/secondary',
          primary: false,
          trusted: true,
          bridge: options.bridge,
        },
      ],
    } as unknown as BuildDaemonStatusOptions['workspaceRegistry'];
    options.getChannelWorkerSnapshots = () => [
      {
        enabled: true,
        state: 'failed',
        channels: ['telegram'],
        error: 'secondary failed',
        workspaceId: 'secondary',
        workspaceCwd: '/work/secondary',
        primary: false,
      },
    ];

    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.runtime.channelWorkers).toEqual(
      options.getChannelWorkerSnapshots(),
    );
    expect(response).toMatchObject({
      status: 'error',
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'channel_worker_exited',
          severity: 'error',
          section: 'runtime.channelWorkers',
          message: expect.stringContaining('/work/secondary'),
        }),
      ]),
    });
  });

  it('preserves partial startup failures for multi-workspace workers', async () => {
    const options = makeOptions({
      channelWorkerSnapshot: {
        enabled: false,
        state: 'disabled',
        channels: [],
      },
    });
    options.workspaceRegistry = {
      list: () => [{ bridge: options.bridge }, { bridge: options.bridge }],
    } as unknown as BuildDaemonStatusOptions['workspaceRegistry'];
    const secondary = {
      enabled: true,
      state: 'running' as const,
      channels: ['telegram'],
      requestedChannels: ['telegram', 'feishu'],
      startupFailures: [
        {
          channel: 'feishu',
          phase: 'connect' as const,
          code: 'ECONNREFUSED',
          message: 'connection refused',
        },
      ],
      workspaceId: 'secondary',
      workspaceCwd: '/work/secondary',
      primary: false,
    };
    options.getChannelWorkerSnapshots = () => [secondary];

    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.runtime.channelWorkers).toEqual([secondary]);
    expect(response).toMatchObject({
      status: 'warning',
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'channel_worker_partial_connect',
          section: 'runtime.channelWorkers',
          message: expect.stringContaining('/work/secondary'),
        }),
      ]),
    });
  });

  it('omits channelWorkers for single-workspace and empty multi-workspace snapshots', async () => {
    const single = makeOptions();
    single.getChannelWorkerSnapshots = () => [
      {
        enabled: true,
        state: 'running',
        channels: ['telegram'],
        workspaceId: 'primary',
        workspaceCwd: BASE_WORKSPACE,
        primary: true,
      },
    ];
    expect(
      (await buildDaemonStatusResponse('summary', single)).runtime
        .channelWorkers,
    ).toBeUndefined();

    const multi = makeOptions();
    multi.workspaceRegistry = {
      list: () => [{ bridge: multi.bridge }, { bridge: multi.bridge }],
    } as unknown as BuildDaemonStatusOptions['workspaceRegistry'];
    multi.getChannelWorkerSnapshots = () => [];
    expect(
      (await buildDaemonStatusResponse('summary', multi)).runtime
        .channelWorkers,
    ).toBeUndefined();
  });

  it('warns for failed channel worker snapshots that still have a scheduled restart', async () => {
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({
        channelWorkerSnapshot: {
          enabled: true,
          state: 'failed',
          channels: ['telegram'],
          error: 'restart failed',
          restartCount: 1,
          nextRestartAt: '2026-07-01T01:01:00.000Z',
        },
      }),
    );

    expect(response).toMatchObject({
      status: 'warning',
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'channel_worker_exited',
          severity: 'warning',
          message:
            'Channel worker is failed (restarts=1, nextRestartAt=2026-07-01T01:01:00.000Z): restart failed.',
          section: 'runtime.channelWorker',
        }),
      ]),
    });
  });

  it('does not warn for a running channel worker that restarted successfully', async () => {
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({
        channelWorkerSnapshot: {
          enabled: true,
          state: 'running',
          channels: ['telegram'],
          requestedChannels: ['telegram'],
          pid: 2345,
          restartCount: 1,
          lastRestartAt: '2026-07-01T01:00:00.000Z',
          lastHeartbeatAt: '2026-07-01T01:00:10.000Z',
        },
      }),
    );

    expect(response).toMatchObject({
      status: 'ok',
      issues: [],
      runtime: {
        channelWorker: {
          enabled: true,
          state: 'running',
          pid: 2345,
          restartCount: 1,
          lastRestartAt: '2026-07-01T01:00:00.000Z',
          lastHeartbeatAt: '2026-07-01T01:00:10.000Z',
        },
      },
    });
  });

  it('warns when a running channel worker only connected part of its requested channels', async () => {
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({
        channelWorkerSnapshot: {
          enabled: true,
          state: 'running',
          channels: ['telegram'],
          requestedChannels: ['telegram', 'feishu', 'dingtalk'],
          startupFailures: [
            {
              channel: 'feishu',
              phase: 'connect',
              code: 'ECONNREFUSED',
              message: 'connection refused',
            },
          ],
          pid: 1234,
          restartCount: 1,
          lastHeartbeatAt: '2026-07-01T01:00:10.000Z',
        },
      }),
    );

    expect(response).toMatchObject({
      status: 'warning',
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'channel_worker_partial_connect',
          severity: 'warning',
          message:
            'Channel worker connected 1/3 channel(s). Failed: feishu, dingtalk.',
          section: 'runtime.channelWorker',
        }),
      ]),
      runtime: {
        channelWorker: {
          enabled: true,
          state: 'running',
          channels: ['telegram'],
          requestedChannels: ['telegram', 'feishu', 'dingtalk'],
          startupFailures: [
            {
              channel: 'feishu',
              phase: 'connect',
              code: 'ECONNREFUSED',
              message: 'connection refused',
            },
          ],
          pid: 1234,
        },
      },
    });
  });

  it('rolls up statuses inside tools, hooks, and extensions', async () => {
    const response = await buildDaemonStatusResponse(
      'full',
      makeOptions({
        toolsStatus: {
          v: 1,
          workspaceCwd: BASE_WORKSPACE,
          initialized: true,
          acpChannelLive: true,
          tools: [{ name: 'broken-tool', enabled: true, status: 'error' }],
        },
        hooksStatus: {
          v: 1,
          workspaceCwd: BASE_WORKSPACE,
          initialized: true,
          disabled: false,
          hooks: [{ kind: 'hook', eventName: 'Stop', status: 'warning' }],
          events: {},
        },
        extensionsStatus: {
          v: 1,
          workspaceCwd: BASE_WORKSPACE,
          initialized: true,
          extensions: [{ kind: 'extension', id: 'broken', status: 'error' }],
        },
      }),
    );

    expect(response).toMatchObject({
      full: {
        workspace: {
          tools: { status: 'error' },
          hooks: { status: 'warning' },
          extensions: { status: 'error' },
        },
      },
    });
  });

  it('reports MCP budget warning and exhausted issue codes', async () => {
    const warning = await buildDaemonStatusResponse(
      'full',
      makeOptions({
        mcpStatus: {
          v: 1,
          workspaceCwd: BASE_WORKSPACE,
          initialized: true,
          clientCount: 3,
          clientBudget: 4,
          servers: [],
        },
      }),
    );
    expect(warning).toMatchObject({
      status: 'warning',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'mcp_budget_warning' }),
      ]),
    });

    const exhausted = await buildDaemonStatusResponse(
      'full',
      makeOptions({
        mcpStatus: {
          v: 1,
          workspaceCwd: BASE_WORKSPACE,
          initialized: true,
          clientCount: 4,
          clientBudget: 4,
          servers: [],
        },
      }),
    );
    expect(exhausted).toMatchObject({
      status: 'error',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'mcp_budget_exhausted' }),
      ]),
    });
  });

  it('summarizes MCP server health in workspace.mcp.summary', async () => {
    const response = await buildDaemonStatusResponse(
      'full',
      makeOptions({
        mcpStatus: {
          v: 1,
          workspaceCwd: BASE_WORKSPACE,
          initialized: true,
          servers: [
            { name: 'a', mcpStatus: 'connected', disabled: false },
            { name: 'b', mcpStatus: 'connected', disabled: false },
            {
              name: 'c',
              mcpStatus: 'disconnected',
              status: 'error',
              disabled: false,
            },
            { name: 'd', disabled: true },
          ],
        },
      }),
    );
    const mcpSummary = response.full?.workspace?.['mcp']?.summary;
    expect(mcpSummary).toMatchObject({
      serversCount: 4,
      serversConnected: 2,
      serversErrored: 1,
      serversDisabled: 1,
    });
  });

  it('marks a timed-out full workspace section unavailable', async () => {
    vi.useFakeTimers();

    const pending = buildDaemonStatusResponse(
      'full',
      makeOptions({
        mcpStatus: new Promise(() => {}),
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toMatchObject({
      status: 'warning',
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'workspace_status_unavailable',
          section: 'mcp',
        }),
      ]),
      full: {
        workspace: {
          mcp: {
            status: 'unavailable',
            error: { kind: 'timeout' },
          },
        },
      },
    });
  });

  it('includes additive daemon startup timing when provided', async () => {
    const options = makeOptions() as BuildDaemonStatusOptions & {
      startup: {
        processStartedAt: string;
        listenerReadyAt?: string;
        processToListenMs?: number;
        runQwenServeToListenMs?: number;
        preheat: { status: string; durationMs?: number; error?: string };
      };
    };
    options.startup = {
      processStartedAt: '2026-06-23T08:00:00.000Z',
      listenerReadyAt: '2026-06-23T08:00:01.250Z',
      processToListenMs: 1250,
      runQwenServeToListenMs: 500,
      preheat: { status: 'succeeded', durationMs: 300 },
    };

    const response = await buildDaemonStatusResponse('summary', options);

    expect(response).toMatchObject({
      status: 'ok',
      daemon: {
        startup: {
          processStartedAt: '2026-06-23T08:00:00.000Z',
          listenerReadyAt: '2026-06-23T08:00:01.250Z',
          processToListenMs: 1250,
          runQwenServeToListenMs: 500,
          preheat: { status: 'succeeded', durationMs: 300 },
        },
      },
    });
  });

  it('includes additive daemon performance data when provided', async () => {
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({
        perfSnapshot: {
          eventLoop: { meanMs: 1, p50Ms: 2, p99Ms: 3, maxMs: 4 },
          promptQueueWait: { count: 2, meanMs: 15, maxMs: 25, lastMs: 5 },
          pipe: {
            inbound: { count: 5, totalBytes: 600, maxBytes: 300 },
            outbound: { count: 7, totalBytes: 800, maxBytes: 400 },
          },
        },
      }),
    );

    expect(response.runtime.perf).toEqual({
      eventLoop: { meanMs: 1, p50Ms: 2, p99Ms: 3, maxMs: 4 },
      promptQueueWait: { count: 2, meanMs: 15, maxMs: 25, lastMs: 5 },
      pipe: {
        inbound: { count: 5, totalBytes: 600, maxBytes: 300 },
        outbound: { count: 7, totalBytes: 800, maxBytes: 400 },
      },
    });
  });

  it('omits daemon performance data when no provider is injected', async () => {
    const response = await buildDaemonStatusResponse('summary', makeOptions());

    expect(response.runtime).not.toHaveProperty('perf');
  });

  it('includes activity fields in runtime', async () => {
    vi.useFakeTimers({ now: 1719990005000 });
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({
        activePromptCount: 3,
        lastActivityAt: 1719990000000,
      }),
    );
    expect(response.runtime.activity).toEqual({
      activePrompts: 3,
      pendingPrompts: 0,
      queuedPrompts: 0,
      lastActivityAt: '2024-07-03T07:00:00.000Z',
      idleSinceMs: 5000,
    });
  });

  it('summarizes pending and queued prompts across sessions without warning', async () => {
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({
        activePromptCount: 1,
        bridgeSnapshot: {
          ...BASE_BRIDGE_SNAPSHOT,
          sessionCount: 2,
          sessions: [
            {
              sessionId: 's1',
              workspaceCwd: BASE_WORKSPACE,
              createdAt: '2026-07-01T00:00:00.000Z',
              clientCount: 2,
              subscriberCount: 2,
              attachCount: 2,
              pendingPromptCount: 3,
              pendingPermissionCount: 0,
              hasActivePrompt: true,
              lastEventId: 10,
            },
            {
              sessionId: 's2',
              workspaceCwd: BASE_WORKSPACE,
              createdAt: '2026-07-01T00:01:00.000Z',
              clientCount: 1,
              subscriberCount: 1,
              attachCount: 1,
              pendingPromptCount: 0,
              pendingPermissionCount: 0,
              hasActivePrompt: false,
              lastEventId: 0,
            },
          ],
        },
      }),
    );

    expect(response.runtime.activity).toMatchObject({
      activePrompts: 1,
      pendingPrompts: 3,
      queuedPrompts: 2,
    });
    expect(response.status).toBe('ok');
  });

  it('uses bridge queued prompt total when available', async () => {
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({
        pendingPromptTotal: 0,
        bridgeSnapshot: {
          ...BASE_BRIDGE_SNAPSHOT,
          sessions: [
            {
              sessionId: 's1',
              workspaceCwd: BASE_WORKSPACE,
              createdAt: '2026-07-01T00:00:00.000Z',
              clientCount: 1,
              subscriberCount: 1,
              attachCount: 1,
              pendingPromptCount: 1,
              pendingPermissionCount: 0,
              hasActivePrompt: false,
              lastEventId: 1,
            },
          ],
        },
      }),
    );

    expect(response.runtime.activity).toMatchObject({
      pendingPrompts: 1,
      queuedPrompts: 0,
    });
  });

  it('derives queued prompts per runtime when pendingPromptTotal is unavailable', async () => {
    const primarySnapshot = {
      ...BASE_BRIDGE_SNAPSHOT,
      sessionCount: 1,
      sessions: [
        {
          sessionId: 'primary',
          workspaceCwd: BASE_WORKSPACE,
          createdAt: '2026-07-01T00:00:00.000Z',
          clientCount: 1,
          subscriberCount: 1,
          attachCount: 1,
          pendingPromptCount: 3,
          pendingPermissionCount: 0,
          hasActivePrompt: true,
          lastEventId: 1,
        },
      ],
    };
    const secondarySnapshot = {
      ...BASE_BRIDGE_SNAPSHOT,
      sessionCount: 1,
      sessions: [
        {
          sessionId: 'secondary',
          workspaceCwd: '/work/secondary',
          createdAt: '2026-07-01T00:00:00.000Z',
          clientCount: 1,
          subscriberCount: 1,
          attachCount: 1,
          pendingPromptCount: 2,
          pendingPermissionCount: 0,
          hasActivePrompt: false,
          lastEventId: 1,
        },
      ],
    };
    const primaryBridge = {
      getDaemonStatusSnapshot: () => primarySnapshot,
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;
    const secondaryBridge = {
      getDaemonStatusSnapshot: () => secondarySnapshot,
      lastActivityAt: null,
    } as unknown as AcpSessionBridge;
    const options = makeOptions();
    options.bridge = primaryBridge;
    options.workspaceRegistry = {
      primary: {
        workspaceId: 'primary',
        workspaceCwd: BASE_WORKSPACE,
        primary: true,
        trusted: true,
        bridge: primaryBridge,
      },
      list: () => [
        {
          workspaceId: 'primary',
          workspaceCwd: BASE_WORKSPACE,
          primary: true,
          trusted: true,
          bridge: primaryBridge,
        },
        {
          workspaceId: 'secondary',
          workspaceCwd: '/work/secondary',
          primary: false,
          trusted: true,
          bridge: secondaryBridge,
        },
      ],
    } as unknown as BuildDaemonStatusOptions['workspaceRegistry'];

    const response = await buildDaemonStatusResponse('summary', options);

    expect(response.runtime.activity).toMatchObject({
      pendingPrompts: 5,
      queuedPrompts: 4,
    });
  });

  it('does not report negative queued prompts from inconsistent snapshots', async () => {
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({
        activePromptCount: 1,
        bridgeSnapshot: {
          ...BASE_BRIDGE_SNAPSHOT,
          sessions: [
            {
              sessionId: 's1',
              workspaceCwd: BASE_WORKSPACE,
              createdAt: '2026-07-01T00:00:00.000Z',
              clientCount: 1,
              subscriberCount: 1,
              attachCount: 1,
              pendingPromptCount: 0,
              pendingPermissionCount: 0,
              hasActivePrompt: true,
              lastEventId: 1,
            },
          ],
        },
      }),
    );

    expect(response.runtime.activity).toMatchObject({
      pendingPrompts: 0,
      queuedPrompts: 0,
    });
  });

  it('reports null activity when daemon has never been active', async () => {
    const response = await buildDaemonStatusResponse(
      'summary',
      makeOptions({ activePromptCount: 0, lastActivityAt: null }),
    );
    expect(response.runtime.activity).toEqual({
      activePrompts: 0,
      pendingPrompts: 0,
      queuedPrompts: 0,
      lastActivityAt: null,
      idleSinceMs: null,
    });
  });
});

function makeAcpDiagnostic(
  workspaceId: string | null,
  workspaceCwd: string,
  primary: boolean,
): AcpHttpConnectionDiagnostic {
  return {
    connectionIdPrefix: primary ? 'primary' : 'secondary',
    fromLoopback: true,
    destroyed: false,
    lastActiveMs: 0,
    ownedSessionCount: 0,
    sessionBindingCount: 0,
    closingSessionCount: 0,
    pendingClientRequests: 0,
    connectionStreamOpen: true,
    sessionStreams: 0,
    sseStreams: 0,
    wsStreams: 1,
    bufferedConnectionFrames: 0,
    bufferedSessionFrames: 0,
    workspaceId,
    workspaceCwd,
    primary,
  };
}

interface MakeOptionsInput {
  bridgeSnapshot?: BridgeDaemonStatusSnapshot;
  acpSnapshot?: ReturnType<AcpHttpHandle['registry']['getSnapshot']>;
  acpAggregate?: AcpHttpSnapshot;
  rateLimitHits?: Record<RateLimitTier, number>;
  rateLimitEnabled?: boolean;
  mcpStatus?: unknown;
  toolsStatus?: unknown;
  hooksStatus?: unknown;
  extensionsStatus?: unknown;
  channelWorkerSnapshot?: ChannelWorkerSnapshot;
  perfSnapshot?: {
    eventLoop: { meanMs: number; p50Ms: number; p99Ms: number; maxMs: number };
    promptQueueWait: {
      count: number;
      meanMs: number;
      maxMs: number;
      lastMs: number | null;
    };
    pipe: {
      inbound: { count: number; totalBytes: number; maxBytes: number };
      outbound: { count: number; totalBytes: number; maxBytes: number };
    };
  };
  activePromptCount?: number;
  pendingPromptTotal?: number;
  lastActivityAt?: number | null;
  totalAdmissionLiveCount?: number;
  totalAdmissionInFlight?: number;
}

function makeOptions(input: MakeOptionsInput = {}): BuildDaemonStatusOptions {
  const registry = new DeviceFlowRegistry({
    events: { publish: () => {} },
    resolveProvider: () => undefined,
    scheduleInterval: () => fakeInterval(),
    clearScheduledInterval: () => {},
  });
  const bridge = {
    getDaemonStatusSnapshot: () => input.bridgeSnapshot ?? BASE_BRIDGE_SNAPSHOT,
    getWorkspaceToolsStatus: async () =>
      input.toolsStatus ?? okStatus({ tools: [] }),
    activePromptCount: input.activePromptCount ?? 0,
    pendingPromptTotal: input.pendingPromptTotal,
    lastActivityAt: input.lastActivityAt ?? null,
  } as unknown as AcpSessionBridge;
  const workspace = {
    getWorkspaceMcpStatus: async () =>
      input.mcpStatus ?? okStatus({ servers: [] }),
    getWorkspaceSkillsStatus: async () => okStatus({ skills: [] }),
    getWorkspaceProvidersStatus: async () => okStatus({ providers: [] }),
    getWorkspaceEnvStatus: async () => okStatus({ cells: [] }),
    getWorkspacePreflightStatus: async () => okStatus({ cells: [] }),
    getWorkspaceHooksStatus: async () =>
      input.hooksStatus ?? okStatus({ hooks: [], events: {} }),
    getWorkspaceExtensionsStatus: async () =>
      input.extensionsStatus ?? okStatus({ extensions: [] }),
  } as unknown as DaemonWorkspaceService;

  return {
    opts: {
      hostname: '127.0.0.1',
      port: 4170,
      mode: 'http-bridge',
      rateLimit: input.rateLimitEnabled,
    },
    boundWorkspace: BASE_WORKSPACE,
    bridge,
    workspace,
    qwenCodeVersion: 'test',
    ...(input.acpSnapshot
      ? {
          acpHandle: {
            registry: { getSnapshot: () => input.acpSnapshot },
            getSnapshot: () =>
              input.acpAggregate ?? {
                connectionCount: input.acpSnapshot!.connectionCount,
                connectionStreams: input.acpSnapshot!.connectionStreams,
                sessionStreams: input.acpSnapshot!.sessionStreams,
                sseStreams: input.acpSnapshot!.sseStreams,
                wsStreams: input.acpSnapshot!.wsStreams,
                pendingClientRequests: input.acpSnapshot!.pendingClientRequests,
                mounts: [
                  {
                    workspaceId: null,
                    primary: true,
                    connectionCount: input.acpSnapshot!.connectionCount,
                    wsStreams: input.acpSnapshot!.wsStreams,
                  },
                ],
                connections: [],
              },
          } as unknown as AcpHttpHandle,
        }
      : {}),
    ...(input.rateLimitHits
      ? { rateLimiter: makeRateLimiter(input.rateLimitHits) }
      : {}),
    getRestSseActive: () => 0,
    features: ['health', 'daemon_status'],
    protocolVersions: { current: 'v1', supported: ['v1'] },
    supportedDeviceFlowProviders: ['qwen-oauth'],
    deviceFlowRegistry: registry,
    sessionShellCommandEnabled: false,
    ...(input.channelWorkerSnapshot
      ? { getChannelWorkerSnapshot: () => input.channelWorkerSnapshot! }
      : {}),
    ...(input.perfSnapshot
      ? { getPerfSnapshot: () => input.perfSnapshot! }
      : {}),
    ...(input.totalAdmissionInFlight === undefined
      ? {}
      : {
          getTotalSessionAdmissionSnapshot: () => ({
            liveCount:
              input.totalAdmissionLiveCount ??
              (input.bridgeSnapshot ?? BASE_BRIDGE_SNAPSHOT).sessionCount,
            inFlight: input.totalAdmissionInFlight!,
          }),
        }),
  };
}

function okStatus(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    v: 1,
    workspaceCwd: BASE_WORKSPACE,
    initialized: true,
    ...extra,
  };
}

function makeRateLimiter(
  hits: Record<RateLimitTier, number>,
): RateLimiterInstance {
  const middleware: RequestHandler = (_req, _res, next) => next();
  return {
    middleware,
    checkRate: () => true,
    reset: () => {},
    setDraining: () => {},
    dispose: () => {},
    getHitCounts: () => hits,
  };
}

function fakeInterval(): ReturnType<typeof setInterval> {
  return {
    ref: () => {},
    unref: () => {},
  } as unknown as ReturnType<typeof setInterval>;
}
