/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real-scenario pin for the disconnect Critical (R1-1): the real route wired to
 * the real connections store over a real temporary filesystem. Only the Agent
 * Host client (which needs a live coordinator) and the program probe are
 * substituted; the read/lock/remove path and the unreadable-vs-absent decision
 * run for real.
 */

import express from 'express';
import request from 'supertest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createWorkspaceGenerationGuard,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { registerAgentHostRuntimeRoutes } from './agent-host-connection.js';
import {
  agentHostConnectionsPath,
  saveAgentHostConnection,
} from '../agent-host-connections.js';

const { stopConnection, startConnection } = vi.hoisted(() => ({
  stopConnection: vi.fn(),
  startConnection: vi.fn(),
}));
vi.mock('../agent-host-client.js', () => ({
  normalizeServerUrl: (value: string) => value.replace(/\/$/, ''),
  stopAgentHostConnection: stopConnection,
  startAgentHostConnection: startConnection,
}));
vi.mock('../agent-host-programs.js', () => ({
  getHostProgramProbe: async () => [{ program: 'qwen', available: true }],
  availablePrograms: (probes: Array<{ program: string; available: boolean }>) =>
    probes.filter((probe) => probe.available).map((probe) => probe.program),
}));
vi.mock('../../utils/stdioHelpers.js', () => ({ writeStderrLine: vi.fn() }));
vi.mock('@qwen-code/qwen-code-core/agents/workspace-agents/store.js', () => ({
  issueAgentHostEnrollment: vi.fn(),
}));

let home: string;
const record = {
  serverUrl: 'https://coordinator.example',
  workspaceId: 'ws_1',
  workspaceCwd: '/selected',
  allowHttp: false,
};

function disconnect() {
  const runtime = {
    workspaceId: 'ws_1',
    workspaceCwd: '/selected',
    generationGuard: createWorkspaceGenerationGuard(),
  } as unknown as WorkspaceRuntime;
  const app = express();
  app.use(express.json());
  registerAgentHostRuntimeRoutes(
    app,
    '/agent',
    () => runtime,
    () => (_req, _res, next) => next(),
  );
  return request(app)
    .delete('/agent/hosts/connect')
    .send({ serverUrl: 'https://coordinator.example', workspaceId: 'ws_1' });
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'host-conn-int-'));
  vi.stubEnv('QWEN_HOME', home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

it('forgets and stops a connection whose record is readable', async () => {
  await saveAgentHostConnection(record);
  stopConnection.mockReturnValue(true);

  const response = await disconnect();

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ disconnected: true });
  expect(stopConnection).toHaveBeenCalledTimes(1);
});

it('refuses the disconnect when the connections file is unreadable', async () => {
  // The record exists, but the file becomes unreadable — a directory stands in
  // for a transient EMFILE/EIO or a mode change. Removal cannot complete and
  // the lookup cannot confirm the record is gone, so the route must refuse
  // rather than stop: stopping would abort the turns and the restore loop
  // would reconnect the record still on disk, undoing the disconnect.
  await saveAgentHostConnection(record);
  await fs.rm(agentHostConnectionsPath(), { force: true });
  await fs.mkdir(agentHostConnectionsPath());

  const response = await disconnect();

  expect(response.status).toBe(400);
  expect(response.body).toEqual({
    error:
      'Could not read the saved Agent Host connections, so nothing was stopped. Retry the request.',
  });
  expect(stopConnection).not.toHaveBeenCalled();
});
