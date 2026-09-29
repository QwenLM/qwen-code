/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  issueA2AGrant,
  revokeA2AGrant,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/a2a-grants.js';
import {
  listThreads,
  updateWorkspaceAgents,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/store.js';
import { Storage } from '@qwen-code/qwen-code-core';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { registerA2ATransportRoutes } from './a2a.js';

const PROJECT_ROOT = '/a2a-route-test';
const headers = {
  authorization: '',
  'x-qwen-workspace-id': 'primary',
  'x-qwen-caller-id': 'share_1',
  'x-qwen-agent-id': 'ag_lead',
};

let runtimeDir: string;

beforeEach(async () => {
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-route-test-'));
  Storage.setRuntimeBaseDir(runtimeDir);
  await updateWorkspaceAgents(PROJECT_ROOT, () => [
    { id: 'ag_lead', name: 'lead', createdAt: 1 },
  ]);
});

afterEach(async () => {
  Storage.setRuntimeBaseDir(null);
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

function runtime(trusted: boolean): WorkspaceRuntime {
  return {
    workspaceId: 'primary',
    workspaceCwd: PROJECT_ROOT,
    primary: true,
    trusted,
  } as WorkspaceRuntime;
}

function appFor(trusted: boolean, checkRate: ReturnType<typeof vi.fn>) {
  const app = express();
  registerA2ATransportRoutes(app, createWorkspaceRegistry([runtime(trusted)]), {
    checkRate,
  });
  return app;
}

describe('A2A transport', () => {
  it('serves the task lifecycle and enforces isolation and revocation', async () => {
    const first = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
    });
    const second = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_2',
      agentId: 'ag_lead',
    });
    const app = appFor(
      true,
      vi.fn(() => true),
    );

    const card = await request(app).get('/.well-known/agent-card.json');
    expect(card.body).toMatchObject({
      name: 'Qwen Code workspace agents',
      supportedInterfaces: [
        expect.objectContaining({
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0',
        }),
      ],
      capabilities: { streaming: false, pushNotifications: false },
    });

    const call = (
      callerId: string,
      secret: string,
      method: string,
      params: unknown,
    ) =>
      request(app)
        .post('/a2a/v1')
        .set({
          ...headers,
          authorization: `Bearer ${secret}`,
          'x-qwen-caller-id': callerId,
          'A2A-Version': '1.0',
        })
        .send({ jsonrpc: '2.0', id: 1, method, params });

    const sent = await call('share_1', first.secret, 'SendMessage', {
      message: {
        role: 'ROLE_USER',
        messageId: 'msg-1',
        parts: [{ text: 'Inspect the cache.' }],
      },
    });
    expect(sent.body.error).toBeUndefined();
    const taskId = sent.body.result.task.id as string;

    const polled = await call('share_1', first.secret, 'GetTask', {
      id: taskId,
    });
    expect(polled.body.result).toMatchObject({ id: taskId });

    const listed = await call('share_1', first.secret, 'ListTasks', {});
    expect(listed.body.result).toMatchObject({
      tasks: [expect.objectContaining({ id: taskId })],
      totalSize: 1,
    });

    const privatePoll = await call('share_2', second.secret, 'GetTask', {
      id: taskId,
    });
    expect(privatePoll.body.error).toMatchObject({
      code: -32001,
      message: 'Task not found.',
    });

    const cancelled = await call('share_1', first.secret, 'CancelTask', {
      id: taskId,
    });
    expect(cancelled.body.result).toMatchObject({
      id: taskId,
      status: { state: 'TASK_STATE_CANCELED' },
    });

    await revokeA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
    });
    const revokedPoll = await call('share_1', first.secret, 'GetTask', {
      id: taskId,
    });
    expect(revokedPoll.body.error).toMatchObject({
      code: -32010,
      message: 'Request refused.',
    });
  });

  it('rejects an untrusted primary workspace', async () => {
    const checkRate = vi.fn(() => true);
    const response = await request(appFor(false, checkRate))
      .post('/a2a/v1')
      .set({ ...headers, authorization: `Bearer ${'a'.repeat(32)}` })
      .send({});

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'untrusted_workspace' });
  });

  it('rate limits both the source address and authenticated caller', async () => {
    const { secret } = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
    });
    const checkRate = vi
      .fn<(_: string, __: string) => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const response = await request(appFor(true, checkRate))
      .post('/a2a/v1')
      .set({ ...headers, authorization: `Bearer ${secret}` })
      .send({});

    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({ code: 'rate_limit_exceeded' });
    expect(checkRate).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^a2a:preauth:/),
      'mutation',
    );
    expect(checkRate).toHaveBeenNthCalledWith(
      2,
      'a2a:caller:share_1',
      'mutation',
    );
  });

  it('refuses task continuation instead of silently creating a new task', async () => {
    const { secret } = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
    });
    const response = await request(
      appFor(
        true,
        vi.fn(() => true),
      ),
    )
      .post('/a2a/v1')
      .set({ ...headers, authorization: `Bearer ${secret}` })
      .set('A2A-Version', '1.0')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: {
          message: {
            role: 'ROLE_USER',
            messageId: 'msg-2',
            taskId: 'existing-task',
            parts: [{ text: 'Continue.' }],
          },
        },
      });

    expect(response.body).toMatchObject({
      error: {
        message: 'Continuing an existing task or context is not supported.',
      },
    });
  });
});

it.each(['replaced', 'untrusted', 'disabled'] as const)(
  'refuses a request whose workspace becomes %s during authentication',
  async (change) => {
    const { secret } = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
    });
    let trusted = true;
    const selected = {
      ...runtime(true),
      get trusted() {
        return trusted;
      },
    };
    const registry = createWorkspaceRegistry([selected]);
    let enabled = true;
    const checkRate = vi.fn((key: string) => {
      if (key === 'a2a:caller:share_1') {
        if (change === 'replaced') {
          const entry = registry.primaryEntry;
          registry.beginReplacement(entry, 'new');
          registry.activateReplacement(entry, runtime(true), 'new');
        } else if (change === 'untrusted') trusted = false;
        else enabled = false;
      }
      return true;
    });
    const app = express();
    registerA2ATransportRoutes(app, registry, { checkRate }, () => enabled);
    const response = await request(app)
      .post('/a2a/v1')
      .set({
        ...headers,
        authorization: `Bearer ${secret}`,
        'A2A-Version': '1.0',
      })
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: {
          message: {
            role: 'ROLE_USER',
            messageId: 'msg-removed',
            parts: [{ text: 'Do not admit stale work.' }],
          },
        },
      });
    expect(response.body.error).toBeDefined();
    expect((await listThreads(PROJECT_ROOT)).threads).toEqual([]);
  },
);
