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
import { issueA2AGrant } from '@qwen-code/qwen-code-core/agents/workspace-agents/a2a-grants.js';
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

describe('A2A transport admission', () => {
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
