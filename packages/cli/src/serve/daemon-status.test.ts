/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpHttpHandle } from './acp-http/index.js';
import type {
  AcpSessionBridge,
  BridgeDaemonStatusSnapshot,
} from './acp-session-bridge.js';
import { DeviceFlowRegistry } from './auth/device-flow.js';
import {
  buildDaemonStatusResponse,
  type BuildDaemonStatusOptions,
} from './daemon-status.js';
import type { RateLimiterInstance, RateLimitTier } from './rate-limit.js';
import type { DaemonWorkspaceService } from './workspace-service/index.js';

const BASE_WORKSPACE = '/work/status';

const BASE_BRIDGE_SNAPSHOT: BridgeDaemonStatusSnapshot = {
  limits: {
    maxSessions: 20,
    maxPendingPromptsPerSession: 5,
    eventRingSize: 8000,
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
});

interface MakeOptionsInput {
  bridgeSnapshot?: BridgeDaemonStatusSnapshot;
  acpSnapshot?: ReturnType<AcpHttpHandle['registry']['getSnapshot']>;
  rateLimitHits?: Record<RateLimitTier, number>;
  rateLimitEnabled?: boolean;
  mcpStatus?: unknown;
  toolsStatus?: unknown;
  hooksStatus?: unknown;
  extensionsStatus?: unknown;
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
