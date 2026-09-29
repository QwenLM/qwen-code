/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import { registerAgentHostTransportRoutes } from './agent-hosts.js';

const { pickup, heartbeat } = vi.hoisted(() => ({
  pickup: vi.fn<() => Promise<unknown>>(),
  heartbeat: vi.fn<() => Promise<unknown>>(),
}));

vi.mock(
  '@qwen-code/qwen-code-core/agents/workspace-agents/host-lease.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@qwen-code/qwen-code-core/agents/workspace-agents/host-lease.js')
    >()),
    pickupRunForHost: pickup,
  }),
);
vi.mock(
  '@qwen-code/qwen-code-core/agents/workspace-agents/store.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@qwen-code/qwen-code-core/agents/workspace-agents/store.js')
    >()),
    authenticateAgentHost: async () => true,
    heartbeatAgentHost: heartbeat,
  }),
);

beforeEach(() => {
  pickup.mockReset();
  heartbeat.mockReset();
});

function setup(initiallyEnabled = true) {
  const runtime = {
    workspaceId: 'workspace',
    workspaceCwd: '/work/selected',
    primary: false,
    trusted: true,
  } as WorkspaceRuntime;
  let active = true;
  let enabled = initiallyEnabled;
  const registry = {
    list: () => (active ? [runtime] : []),
  } as unknown as WorkspaceRegistry;
  const app = express();
  registerAgentHostTransportRoutes(app, registry, undefined, () => enabled);
  return {
    disable: () => {
      enabled = false;
    },
    remove: () => {
      active = false;
    },
    poll: () =>
      request(app)
        .post('/agent-hosts/workspace/host/pickup')
        .set('Authorization', `AgentHost ${'a'.repeat(32)}`)
        .send({ waitMs: 1_000 })
        .then((response) => response),
  };
}

it('does not expose host work for a collaboration-disabled workspace', async () => {
  const response = await setup(false).poll();

  expect(response.status).toBe(404);
  expect(pickup).not.toHaveBeenCalled();
});

it('stops polling when collaboration is disabled', async () => {
  const { poll, disable } = setup();
  pickup
    .mockResolvedValueOnce(undefined)
    .mockResolvedValue({ prompt: 'private' });
  const response = poll();
  await vi.waitFor(() => expect(pickup).toHaveBeenCalledOnce());
  disable();

  expect((await response).status).toBe(404);
  expect(pickup).toHaveBeenCalledOnce();
});

it('stops polling when the selected workspace becomes unavailable', async () => {
  const { poll, remove } = setup();
  pickup
    .mockResolvedValueOnce(undefined)
    .mockResolvedValue({ prompt: 'private' });
  const response = poll();
  await vi.waitFor(() => expect(pickup).toHaveBeenCalledOnce());
  remove();

  expect((await response).status).toBe(404);
  expect(pickup).toHaveBeenCalledOnce();
});

it.each([false, true])(
  'returns a claimed assignment only while its workspace remains active (removed: %s)',
  async (removed) => {
    const { poll, remove } = setup();
    pickup.mockImplementation(async () => {
      if (removed) remove();
      return { prompt: 'private' };
    });
    const response = await poll();

    expect(response.status).toBe(removed ? 404 : 200);
    expect(response.body).toEqual(
      removed
        ? { error: 'Workspace not found.' }
        : { assignment: { prompt: 'private' } },
    );
  },
);

it('refuses untrusted workspaces before reading settings on every transport route', async () => {
  const app = express();
  const settings = vi.fn(() => true);
  const registry = {
    list: () => [
      { workspaceId: 'workspace', workspaceCwd: '/untrusted', trusted: false },
    ],
  } as unknown as WorkspaceRegistry;
  registerAgentHostTransportRoutes(app, registry, undefined, settings);
  for (const operation of [
    'enroll',
    'host/heartbeat',
    'host/pickup',
    'host/progress',
    'host/result',
  ]) {
    const response = await request(app)
      .post(
        operation === 'enroll'
          ? '/agent-hosts/enroll'
          : `/agent-hosts/workspace/${operation}`,
      )
      .set('Authorization', `AgentHost ${'a'.repeat(32)}`)
      .send({
        workspaceId: 'workspace',
        token: 'token',
        name: 'remote',
        workspaceCwd: '/remote',
        providers: ['qwen'],
      });
    expect(response.status).toBe(403);
  }
  expect(settings).not.toHaveBeenCalled();
  expect(heartbeat).not.toHaveBeenCalled();
});

it('does not disclose paths when the host registry fails before authentication', async () => {
  const app = express();
  const registry = {
    list: () => [
      {
        workspaceId: 'workspace',
        workspaceCwd: '/private/project',
        trusted: true,
      },
    ],
  } as unknown as WorkspaceRegistry;
  registerAgentHostTransportRoutes(app, registry, undefined, () => true);
  heartbeat.mockRejectedValue(
    new Error('Malformed Agent Host registry in /private/project'),
  );
  const response = await request(app)
    .post('/agent-hosts/workspace/host/heartbeat')
    .set('Authorization', `AgentHost ${'a'.repeat(32)}`)
    .send({ workspaceCwd: '/remote', providers: ['qwen'] });
  expect(response.status).toBe(400);
  expect(response.body).toEqual({ error: 'Agent Host heartbeat refused.' });
});
