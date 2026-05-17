/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { Storage, QWEN_DIR } from '@qwen-code/qwen-code-core';
import { createMutationGate } from './auth.js';
import type { HttpAcpBridge } from './httpAcpBridge.js';
import type { BridgeEvent } from './eventBus.js';
import { mountWorkspaceAgentsRoutes } from './workspaceAgents.js';

type RecordedEvent = Omit<BridgeEvent, 'id' | 'v'>;

function buildBridgeStub(
  opts: { knownIds?: Iterable<string> } = {},
): HttpAcpBridge & {
  events: RecordedEvent[];
} {
  const events: RecordedEvent[] = [];
  const known = new Set<string>(opts.knownIds ?? []);
  return {
    events,
    publishWorkspaceEvent(event: RecordedEvent) {
      events.push(event);
    },
    knownClientIds() {
      return new Set(known);
    },
    spawnOrAttach: () => {
      throw new Error('not implemented');
    },
    loadSession: () => {
      throw new Error('not implemented');
    },
    resumeSession: () => {
      throw new Error('not implemented');
    },
    sendPrompt: () => {
      throw new Error('not implemented');
    },
    cancelSession: () => {
      throw new Error('not implemented');
    },
    subscribeEvents: () => {
      throw new Error('not implemented');
    },
    closeSession: () => {
      throw new Error('not implemented');
    },
    updateSessionMetadata: () => {
      throw new Error('not implemented');
    },
    respondToPermission: () => {
      throw new Error('not implemented');
    },
    respondToSessionPermission: () => {
      throw new Error('not implemented');
    },
    listWorkspaceSessions: () => {
      throw new Error('not implemented');
    },
    recordHeartbeat: () => {
      throw new Error('not implemented');
    },
    getHeartbeatState: () => undefined,
    getWorkspaceMcpStatus: async () => {
      throw new Error('not implemented');
    },
    getWorkspaceSkillsStatus: async () => {
      throw new Error('not implemented');
    },
    getWorkspaceProvidersStatus: async () => {
      throw new Error('not implemented');
    },
    getSessionContextStatus: async () => {
      throw new Error('not implemented');
    },
    getSessionSupportedCommandsStatus: async () => {
      throw new Error('not implemented');
    },
    setSessionModel: async () => {
      throw new Error('not implemented');
    },
    killSession: async () => {},
    detachClient: async () => {},
    sessionCount: 0,
    pendingPermissionCount: 0,
    killAllSync: () => {},
    shutdown: async () => {},
  } as unknown as HttpAcpBridge & { events: RecordedEvent[] };
}

function buildApp(opts: {
  bridge: HttpAcpBridge;
  boundWorkspace: string;
  strictNoToken?: boolean;
}) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const mutate = createMutationGate({
    tokenConfigured: !opts.strictNoToken,
    requireAuth: false,
  });
  mountWorkspaceAgentsRoutes(app, {
    bridge: opts.bridge,
    boundWorkspace: opts.boundWorkspace,
    mutate,
    parseClientId: (req, res) => {
      const raw = req.get('x-qwen-client-id');
      if (raw === undefined || raw === '') return undefined;
      if (raw.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(raw)) {
        res.status(400).json({
          error: '`X-Qwen-Client-Id` must be a non-empty token',
          code: 'invalid_client_id',
        });
        return null;
      }
      return raw;
    },
    safeBody: (req) => {
      const raw = req.body;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return Object.create(null) as Record<string, unknown>;
      }
      const out = Object.create(null) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
          continue;
        }
        out[k] = v;
      }
      return out;
    },
  });
  return app;
}

describe('workspace agents routes', () => {
  let tmp: string;
  let workspace: string;
  let globalDir: string;
  let getGlobalQwenDirSpy: MockInstance<() => string>;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-serve-agents-'));
    workspace = path.join(tmp, 'workspace');
    globalDir = path.join(tmp, 'global');
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(globalDir, { recursive: true });
    getGlobalQwenDirSpy = vi
      .spyOn(Storage, 'getGlobalQwenDir')
      .mockReturnValue(globalDir);
  });

  afterEach(async () => {
    getGlobalQwenDirSpy.mockRestore();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('lists built-in agents alongside on-disk project agents', async () => {
    const projectAgentsDir = path.join(workspace, QWEN_DIR, 'agents');
    await fs.mkdir(projectAgentsDir, { recursive: true });
    await fs.writeFile(
      path.join(projectAgentsDir, 'reviewer.md'),
      `---\nname: reviewer\ndescription: reviews PRs\n---\nyou are a reviewer agent\n`,
      'utf8',
    );

    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const res = await request(app).get('/workspace/agents');

    expect(res.status).toBe(200);
    const names = (res.body.agents as Array<{ name: string }>).map(
      (a) => a.name,
    );
    expect(names).toContain('reviewer');
    expect(names).toContain('general-purpose');
    const reviewerEntry = (
      res.body.agents as Array<{
        name: string;
        level: string;
        systemPrompt?: string;
      }>
    ).find((a) => a.name === 'reviewer');
    expect(reviewerEntry?.level).toBe('project');
    // Listings exclude the systemPrompt for bounded payload.
    expect(reviewerEntry?.systemPrompt).toBeUndefined();
  });

  it('returns the full detail (with systemPrompt) on GET /workspace/agents/:agentType', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const res = await request(app).get('/workspace/agents/general-purpose');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('general-purpose');
    expect(typeof res.body.systemPrompt).toBe('string');
    expect(res.body.isBuiltin).toBe(true);
    expect(res.body.level).toBe('builtin');
  });

  it('returns 404 agent_not_found for unknown agent', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const res = await request(app).get('/workspace/agents/no-such-agent');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('agent_not_found');
  });

  it('matches frontmatter name case-insensitively', async () => {
    const projectAgentsDir = path.join(workspace, QWEN_DIR, 'agents');
    await fs.mkdir(projectAgentsDir, { recursive: true });
    await fs.writeFile(
      path.join(projectAgentsDir, 'casey.md'),
      `---\nname: CaseInsensitive-Agent\ndescription: case insensitive lookup test\n---\nyou are a test agent\n`,
      'utf8',
    );

    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const res = await request(app).get(
      '/workspace/agents/caseinsensitive-agent',
    );
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('CaseInsensitive-Agent');
  });

  it('creates a project-level agent and emits agent_changed', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const res = await request(app).post('/workspace/agents').send({
      name: 'tester',
      description: 'runs tests in the project',
      systemPrompt: 'you are a tester agent',
      scope: 'workspace',
    });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.agent.name).toBe('tester');
    expect(res.body.agent.level).toBe('project');

    const events = (bridge as unknown as { events: RecordedEvent[] }).events;
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('agent_changed');
    expect(events[0]?.data).toMatchObject({
      change: 'created',
      name: 'tester',
      level: 'project',
    });

    // File was actually written.
    const onDisk = await fs.readFile(
      path.join(workspace, QWEN_DIR, 'agents', 'tester.md'),
      'utf8',
    );
    expect(onDisk).toContain('name: tester');
  });

  it('creates a user-level agent when scope=global', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const res = await request(app).post('/workspace/agents').send({
      name: 'global-helper',
      description: 'cross-workspace helper',
      systemPrompt: 'you are a helper agent',
      scope: 'global',
    });
    expect(res.status).toBe(201);
    expect(res.body.agent.level).toBe('user');
    const onDisk = await fs.readFile(
      path.join(globalDir, 'agents', 'global-helper.md'),
      'utf8',
    );
    expect(onDisk).toContain('name: global-helper');
  });

  it('returns 409 agent_already_exists when name collides at the same level', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const body = {
      name: 'duplicate',
      description: 'first description',
      systemPrompt: 'you are the duplicate agent',
      scope: 'workspace' as const,
    };
    const first = await request(app).post('/workspace/agents').send(body);
    expect(first.status).toBe(201);
    const second = await request(app).post('/workspace/agents').send(body);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('agent_already_exists');
  });

  it('returns 422 invalid_config for missing required fields', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const res = await request(app)
      .post('/workspace/agents')
      .send({ scope: 'workspace' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_config');
  });

  it('returns 400 invalid_scope for bad scope value', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const res = await request(app).post('/workspace/agents').send({
      name: 'a-name',
      description: 'a description longer than ten chars',
      systemPrompt: 'this is the system prompt',
      scope: 'project',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_scope');
  });

  it('updates an existing project-level agent and emits agent_changed', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    await request(app).post('/workspace/agents').send({
      name: 'updatable',
      description: 'old description',
      systemPrompt: 'you are an updatable agent',
      scope: 'workspace',
    });
    const res = await request(app)
      .post('/workspace/agents/updatable')
      .send({ description: 'new description' });
    expect(res.status).toBe(200);
    expect(res.body.agent.description).toBe('new description');
    const events = (bridge as unknown as { events: RecordedEvent[] }).events;
    const changeEvents = events.filter((e) => e.type === 'agent_changed');
    expect(changeEvents).toHaveLength(2);
    expect(changeEvents[1]?.data).toMatchObject({
      change: 'updated',
      name: 'updatable',
      level: 'project',
    });
  });

  it('returns 404 agent_not_found when updating an unknown agent', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const res = await request(app)
      .post('/workspace/agents/no-such-agent')
      .send({ description: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('agent_not_found');
  });

  it('returns 403 agent_readonly when updating a built-in agent', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const res = await request(app)
      .post('/workspace/agents/general-purpose')
      .send({ description: 'rewritten' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('agent_readonly');
  });

  it('deletes a project-level agent and emits agent_changed', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    await request(app).post('/workspace/agents').send({
      name: 'temporary',
      description: 'temp description',
      systemPrompt: 'you are a temp agent',
      scope: 'workspace',
    });
    const res = await request(app).delete('/workspace/agents/temporary');
    expect(res.status).toBe(204);
    const events = (bridge as unknown as { events: RecordedEvent[] }).events;
    const changeEvents = events.filter((e) => e.type === 'agent_changed');
    expect(changeEvents.at(-1)?.data).toMatchObject({
      change: 'deleted',
      name: 'temporary',
      level: 'project',
    });
  });

  it('returns 403 agent_readonly when deleting a built-in agent', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const res = await request(app).delete('/workspace/agents/general-purpose');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('agent_readonly');
  });

  it('returns 404 when deleting a missing agent', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const res = await request(app).delete('/workspace/agents/no-such-agent');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('agent_not_found');
  });

  it('refuses POST with 401 token_required on no-token loopback strict mode', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({
      bridge,
      boundWorkspace: workspace,
      strictNoToken: true,
    });
    const res = await request(app).post('/workspace/agents').send({
      name: 'a-name',
      description: 'a description longer than ten chars',
      systemPrompt: 'this is the system prompt',
      scope: 'workspace',
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('token_required');
  });

  it('rejects 400 invalid_client_id for unknown X-Qwen-Client-Id', async () => {
    const bridge = buildBridgeStub({ knownIds: ['client_known'] });
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const res = await request(app)
      .post('/workspace/agents')
      .set('X-Qwen-Client-Id', 'client_stranger')
      .send({
        name: 'a-name',
        description: 'a description longer than ten chars',
        systemPrompt: 'this is the system prompt',
        scope: 'workspace',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_client_id');
  });
});
