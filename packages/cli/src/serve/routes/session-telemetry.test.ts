/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import express, { type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionNotFoundError,
  type AcpSessionBridge,
} from '../acp-session-bridge.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';

const telemetryMocks = vi.hoisted(() => ({
  setDaemonTelemetryWorkspace: vi.fn(),
}));
const archiveMocks = vi.hoisted(() => ({
  assertSessionLoadable: vi.fn(),
}));

vi.mock('../server/telemetry.js', () => telemetryMocks);
vi.mock('../server/session-archive.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/session-archive.js')>()),
  assertSessionLoadable: archiveMocks.assertSessionLoadable,
}));

import { registerSessionRoutes } from './session.js';

function bridgeWithSessions(sessionIds: string[] = []): AcpSessionBridge {
  return {
    getSessionSummary: vi.fn((sessionId: string) => {
      if (!sessionIds.includes(sessionId)) {
        throw new SessionNotFoundError(sessionId);
      }
      return { sessionId };
    }),
    getSessionTranscriptPage: vi.fn(async () => ({ records: [] })),
  } as unknown as AcpSessionBridge;
}

function runtime(opts: {
  workspaceId: string;
  workspaceCwd: string;
  primary: boolean;
  bridge: AcpSessionBridge;
  trusted?: boolean;
}): WorkspaceRuntime {
  return {
    ...opts,
    trusted: opts.trusted !== false,
  } as WorkspaceRuntime;
}

function makeApp(runtimes: WorkspaceRuntime[]) {
  const app = express();
  app.use(express.json());
  const registry = createWorkspaceRegistry(runtimes);
  const primary = registry.primary;
  registerSessionRoutes(app, {
    boundWorkspace: primary.workspaceCwd,
    bridge: primary.bridge,
    workspaceRegistry: registry,
    archiveCoordinator: {
      runSharedMany: async (_sessionIds, fn) => await fn(),
    } as Parameters<typeof registerSessionRoutes>[1]['archiveCoordinator'],
    mutate: () => (_req, _res, next) => next(),
    sendBridgeError: (res: Response) => {
      res.status(500).json({ error: 'test bridge error' });
    },
    sessionShellCommandEnabled: true,
    languageCodes: ['en'],
  });
  return app;
}

describe('special session resolver telemetry publication', () => {
  const primaryCwd = path.resolve('/workspace/telemetry-primary');
  const secondaryCwd = path.resolve('/workspace/telemetry-secondary');

  beforeEach(() => {
    vi.clearAllMocks();
    archiveMocks.assertSessionLoadable.mockResolvedValue(undefined);
  });

  it('publishes the runtime root for creation before later validation', async () => {
    const primary = runtime({
      workspaceId: 'primary',
      workspaceCwd: primaryCwd,
      primary: true,
      bridge: bridgeWithSessions(),
    });

    const res = await request(makeApp([primary]))
      .post('/session')
      .send({ sessionScope: 'invalid' });

    expect(res.status).toBe(400);
    expect(telemetryMocks.setDaemonTelemetryWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      primaryCwd,
    );
  });

  it('publishes the secondary runtime selected for creation', async () => {
    const primary = runtime({
      workspaceId: 'primary',
      workspaceCwd: primaryCwd,
      primary: true,
      bridge: bridgeWithSessions(),
    });
    const secondary = runtime({
      workspaceId: 'secondary',
      workspaceCwd: secondaryCwd,
      primary: false,
      bridge: bridgeWithSessions(),
    });

    const res = await request(makeApp([primary, secondary]))
      .post('/session')
      .send({ cwd: secondaryCwd, sessionScope: 'invalid' });

    expect(res.status).toBe(400);
    expect(telemetryMocks.setDaemonTelemetryWorkspace).toHaveBeenCalledTimes(1);
    expect(telemetryMocks.setDaemonTelemetryWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      secondaryCwd,
    );
  });

  it('publishes the restore target before later validation', async () => {
    const primary = runtime({
      workspaceId: 'primary',
      workspaceCwd: primaryCwd,
      primary: true,
      bridge: bridgeWithSessions(),
    });

    const res = await request(makeApp([primary]))
      .post('/session/persisted/load')
      .send({ approvalMode: 'invalid' });

    expect(res.status).toBe(400);
    expect(telemetryMocks.setDaemonTelemetryWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      primaryCwd,
    );
  });

  it('retains the selected restore target on a live-owner conflict', async () => {
    const primary = runtime({
      workspaceId: 'primary',
      workspaceCwd: primaryCwd,
      primary: true,
      bridge: bridgeWithSessions(['shared-session']),
    });
    const secondary = runtime({
      workspaceId: 'secondary',
      workspaceCwd: secondaryCwd,
      primary: false,
      bridge: bridgeWithSessions(),
    });

    const res = await request(makeApp([primary, secondary]))
      .post('/session/shared-session/load')
      .send({ cwd: secondaryCwd });

    expect(res.status).toBe(409);
    expect(telemetryMocks.setDaemonTelemetryWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      secondaryCwd,
    );
  });

  it('publishes the single transcript runtime before storage lookup', async () => {
    const primary = runtime({
      workspaceId: 'primary',
      workspaceCwd: primaryCwd,
      primary: true,
      bridge: bridgeWithSessions(),
    });

    const res = await request(makeApp([primary])).get(
      '/session/missing/transcript',
    );

    expect(res.status).toBe(500);
    expect(telemetryMocks.setDaemonTelemetryWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      primaryCwd,
    );
  });

  it('publishes the live transcript owner in a multi-workspace daemon', async () => {
    archiveMocks.assertSessionLoadable.mockResolvedValue('active');
    const primary = runtime({
      workspaceId: 'primary',
      workspaceCwd: primaryCwd,
      primary: true,
      bridge: bridgeWithSessions(),
    });
    const secondary = runtime({
      workspaceId: 'secondary',
      workspaceCwd: secondaryCwd,
      primary: false,
      bridge: bridgeWithSessions(['secondary-session']),
    });

    const res = await request(makeApp([primary, secondary])).get(
      '/session/secondary-session/transcript',
    );

    expect(res.status).toBe(200);
    expect(archiveMocks.assertSessionLoadable).toHaveBeenCalledTimes(1);
    expect(archiveMocks.assertSessionLoadable).toHaveBeenCalledWith(
      secondaryCwd,
      'secondary-session',
    );
    expect(telemetryMocks.setDaemonTelemetryWorkspace).toHaveBeenCalledTimes(1);
    expect(telemetryMocks.setDaemonTelemetryWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      secondaryCwd,
    );
  });

  it('publishes the sole active transcript runtime after storage lookup', async () => {
    archiveMocks.assertSessionLoadable.mockImplementation(
      async (workspaceCwd: string) =>
        workspaceCwd === secondaryCwd ? 'active' : undefined,
    );
    const primary = runtime({
      workspaceId: 'primary',
      workspaceCwd: primaryCwd,
      primary: true,
      bridge: bridgeWithSessions(),
    });
    const secondary = runtime({
      workspaceId: 'secondary',
      workspaceCwd: secondaryCwd,
      primary: false,
      bridge: bridgeWithSessions(),
    });

    const res = await request(makeApp([primary, secondary])).get(
      '/session/stored-secondary/transcript',
    );

    expect(res.status).toBe(200);
    expect(archiveMocks.assertSessionLoadable).toHaveBeenCalledTimes(2);
    expect(archiveMocks.assertSessionLoadable).toHaveBeenCalledWith(
      primaryCwd,
      'stored-secondary',
    );
    expect(archiveMocks.assertSessionLoadable).toHaveBeenCalledWith(
      secondaryCwd,
      'stored-secondary',
    );
    expect(telemetryMocks.setDaemonTelemetryWorkspace).toHaveBeenCalledTimes(1);
    expect(telemetryMocks.setDaemonTelemetryWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      secondaryCwd,
    );
  });

  it('does not publish a workspace for a creation workspace mismatch', async () => {
    const primary = runtime({
      workspaceId: 'primary',
      workspaceCwd: primaryCwd,
      primary: true,
      bridge: bridgeWithSessions(),
    });
    const secondary = runtime({
      workspaceId: 'secondary',
      workspaceCwd: secondaryCwd,
      primary: false,
      bridge: bridgeWithSessions(),
    });

    const res = await request(makeApp([primary, secondary]))
      .post('/session')
      .send({ cwd: '/workspace/not-registered' });

    expect(res.status).toBe(400);
    expect(telemetryMocks.setDaemonTelemetryWorkspace).not.toHaveBeenCalled();
  });
});
