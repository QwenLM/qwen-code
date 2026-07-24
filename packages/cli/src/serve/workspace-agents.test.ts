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
import { QWEN_DIR, Storage } from '@qwen-code/qwen-code-core';
import { createMutationGate } from './auth.js';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import { mountWorkspaceAgentsRoutes } from './workspace-agents.js';

type RecordedEvent = Omit<BridgeEvent, 'id' | 'v'>;

function buildBridgeStub(
  opts: { knownIds?: Iterable<string> } = {},
): AcpSessionBridge & {
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
    killSession: async () => true,
    detachClient: async () => {},
    sessionCount: 0,
    pendingPermissionCount: 0,
    killAllSync: () => {},
    shutdown: async () => {},
    preheat: async () => {},
  } as unknown as AcpSessionBridge & { events: RecordedEvent[] };
}

function buildApp(opts: {
  bridge: AcpSessionBridge;
  boundWorkspace: string;
  strictNoToken?: boolean;
}) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const mutate = createMutationGate({
    tokenConfigured: opts.strictNoToken !== true,
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
  let getGlobalQwenDirSpy: MockInstance<typeof Storage.getGlobalQwenDir>;

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

  function missingAgentName(prefix = 'missing-agent') {
    return `${prefix}-${path.basename(tmp)}`;
  }

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

  it('round-trips complete frontmatter metadata through create, list, and detail', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const config = {
      name: 'complete-agent',
      description: 'Exercises the complete daemon Agent contract',
      systemPrompt: 'You are a complete test agent.',
      scope: 'workspace',
      tools: ['read_file', 'mcp__github__search'],
      disallowedTools: ['run_shell_command', 'mcp__slack'],
      model: 'fast',
      approvalMode: 'bubble',
      maxTurns: 12,
      color: 'cyan',
      mcpServers: {
        filesystem: { type: 'stdio', command: 'node', args: ['server.js'] },
      },
      hooks: {
        PreToolUse: [
          {
            matcher: 'run_shell_command',
            hooks: [{ type: 'command', command: 'echo checking' }],
          },
        ],
      },
    };

    const create = await request(app).post('/workspace/agents').send(config);
    expect(create.status).toBe(201);
    const { scope: _scope, ...persistedConfig } = config;
    expect(create.body.agent).toMatchObject({
      ...persistedConfig,
      level: 'project',
    });

    const list = await request(app).get('/workspace/agents');
    const summary = list.body.agents.find(
      (agent: { name: string }) => agent.name === config.name,
    );
    expect(summary).toMatchObject({
      name: config.name,
      tools: config.tools,
      disallowedTools: config.disallowedTools,
      model: config.model,
      approvalMode: config.approvalMode,
      maxTurns: config.maxTurns,
      color: config.color,
      mcpServerNames: ['filesystem'],
      hookEvents: ['PreToolUse'],
    });
    expect(summary.systemPrompt).toBeUndefined();

    const detail = await request(app).get(`/workspace/agents/${config.name}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      ...persistedConfig,
      level: 'project',
    });
  });

  it('restores selected MCP server secrets before writing an agent', async () => {
    const settingsDir = path.join(workspace, QWEN_DIR);
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        mcpServers: {
          private: {
            command: 'private-server',
            env: { PRIVATE_TOKEN: 'secret-value' },
          },
        },
      }),
      'utf8',
    );
    const app = buildApp({
      bridge: buildBridgeStub(),
      boundWorkspace: workspace,
    });

    const create = await request(app)
      .post('/workspace/agents')
      .send({
        name: 'private-agent',
        description: 'Uses a selected private MCP server',
        systemPrompt: 'Use the private MCP server.',
        scope: 'workspace',
        mcpServers: {
          private: {
            command: 'private-server',
            env: { PRIVATE_TOKEN: '__redacted__' },
          },
        },
      });

    expect(create.status).toBe(201);
    expect(create.body.agent.mcpServers.private.env).toEqual({
      PRIVATE_TOKEN: '__redacted__',
    });
    const onDisk = await fs.readFile(
      path.join(workspace, QWEN_DIR, 'agents', 'private-agent.md'),
      'utf8',
    );
    expect(onDisk).toContain('PRIVATE_TOKEN: secret-value');
    expect(onDisk).not.toContain('__redacted__');
  });

  it('keeps the existing structured agent generation route unchanged', async () => {
    const bridge = buildBridgeStub();
    const generateWorkspaceAgent = vi.fn().mockResolvedValue({
      name: 'generated-agent',
      description: 'generated description',
      systemPrompt: 'generated prompt',
    });
    bridge.generateWorkspaceAgent = generateWorkspaceAgent;
    const app = buildApp({ bridge, boundWorkspace: workspace });

    const res = await request(app)
      .post('/workspace/agents/generate')
      .send({ description: 'generate an agent' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: 'generated-agent',
      description: 'generated description',
      systemPrompt: 'generated prompt',
    });
    expect(generateWorkspaceAgent).toHaveBeenCalledWith(
      'generate an agent',
      undefined,
    );
  });

  it('updates advanced agent metadata', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    await request(app).post('/workspace/agents').send({
      name: 'editable-agent',
      description: 'before',
      systemPrompt: 'before prompt',
      scope: 'workspace',
    });

    const update = await request(app)
      .post('/workspace/agents/editable-agent')
      .send({
        description: 'after',
        systemPrompt: 'after prompt',
        tools: ['read_file', 'mcp__github__search'],
        disallowedTools: ['run_shell_command'],
        model: 'fast',
        approvalMode: 'bubble',
        maxTurns: 8,
        color: 'purple',
        mcpServers: { github: { type: 'http', url: 'https://example.com' } },
        hooks: { PreToolUse: [] },
      });

    expect(update.status).toBe(200);
    expect(update.body.agent).toMatchObject({
      description: 'after',
      systemPrompt: 'after prompt',
      tools: ['read_file', 'mcp__github__search'],
      disallowedTools: ['run_shell_command'],
      model: 'fast',
      approvalMode: 'bubble',
      maxTurns: 8,
      color: 'purple',
      mcpServers: { github: { type: 'http', url: 'https://example.com' } },
      hooks: { PreToolUse: [] },
    });

    const clear = await request(app)
      .post('/workspace/agents/editable-agent')
      .send({
        model: null,
        approvalMode: null,
        maxTurns: null,
        color: null,
        tools: [],
        disallowedTools: [],
        mcpServers: {},
        hooks: {},
      });
    expect(clear.status).toBe(200);
    expect(clear.body.agent).not.toHaveProperty('model');
    expect(clear.body.agent).not.toHaveProperty('approvalMode');
    expect(clear.body.agent).not.toHaveProperty('maxTurns');
    expect(clear.body.agent).not.toHaveProperty('color');
    expect(clear.body.agent).not.toHaveProperty('mcpServers');
    expect(clear.body.agent).not.toHaveProperty('hooks');
  });

  it('GET /workspace/agents reflects out-of-band agent file changes', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });

    // First call populates SubagentManager's cache.
    let res = await request(app).get('/workspace/agents');
    expect(res.status).toBe(200);
    const before = (res.body.agents as Array<{ name: string }>).map(
      (a) => a.name,
    );
    expect(before).not.toContain('fresh-out-of-band');

    // Out-of-band: a developer / IDE adapter writes a new agent file
    // directly to disk, bypassing the daemon's POST route. Without
    // `force: true` on the LIST handler, `listSubagents()` would
    // serve the stale cache from the first call and silently miss
    // the new entry — diverging from the detail route, which always
    // re-reads disk.
    const projectAgentsDir = path.join(workspace, QWEN_DIR, 'agents');
    await fs.mkdir(projectAgentsDir, { recursive: true });
    await fs.writeFile(
      path.join(projectAgentsDir, 'fresh-out-of-band.md'),
      `---\nname: fresh-out-of-band\ndescription: out-of-band agent description\n---\nyou are the fresh out-of-band agent\n`,
      'utf8',
    );

    res = await request(app).get('/workspace/agents');
    expect(res.status).toBe(200);
    const after = (res.body.agents as Array<{ name: string }>).map(
      (a) => a.name,
    );
    expect(after).toContain('fresh-out-of-band');
  });

  it('returns the full detail (with systemPrompt) on GET /workspace/agents/:agentType', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const create = await request(app).post('/workspace/agents').send({
      name: 'detail-agent',
      description: 'detail agent description',
      systemPrompt: 'you are the detail agent',
      scope: 'workspace',
    });
    expect(create.status).toBe(201);

    const res = await request(app).get('/workspace/agents/detail-agent');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('detail-agent');
    expect(res.body.systemPrompt).toBe('you are the detail agent');
    expect(res.body.isBuiltin).toBe(false);
    expect(res.body.level).toBe('project');
  });

  it('returns a shadowed user agent when GET specifies global scope', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    await request(app).post('/workspace/agents').send({
      name: 'shadowed-agent',
      description: 'project description',
      systemPrompt: 'project prompt',
      scope: 'workspace',
    });
    await request(app).post('/workspace/agents').send({
      name: 'shadowed-agent',
      description: 'user description',
      systemPrompt: 'user prompt',
      scope: 'global',
    });

    const res = await request(app).get(
      '/workspace/agents/shadowed-agent?scope=global',
    );

    expect(res.status).toBe(200);
    expect(res.body.level).toBe('user');
    expect(res.body.systemPrompt).toBe('user prompt');
  });

  it('returns 404 agent_not_found for unknown agent', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const name = missingAgentName();
    const res = await request(app).get(`/workspace/agents/${name}`);
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

  it.each(['general-purpose', 'explore'])(
    'rejects 422 invalid_config when create uses builtin agent name %s',
    async (name) => {
      const bridge = buildBridgeStub();
      const app = buildApp({ bridge, boundWorkspace: workspace });
      const res = await request(app).post('/workspace/agents').send({
        name,
        description: 'a description longer than ten chars',
        systemPrompt: 'this is a system prompt',
        scope: 'workspace',
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('invalid_config');
      expect(res.body.error).toMatch(/built-in/i);
    },
  );

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
    const name = missingAgentName();
    const res = await request(app)
      .post(`/workspace/agents/${name}`)
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
    const name = missingAgentName();
    const res = await request(app).delete(`/workspace/agents/${name}`);
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

  it('trims leading/trailing whitespace on the agent name', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const res = await request(app).post('/workspace/agents').send({
      name: '  trimmed-name  ',
      description: 'a description longer than ten chars',
      systemPrompt: 'you are a trimmed name agent',
      scope: 'workspace',
    });
    expect(res.status).toBe(201);
    expect(res.body.agent.name).toBe('trimmed-name');
    // File on disk uses the trimmed name; the original-with-spaces
    // version must NOT exist (would otherwise be unfindable via
    // case-insensitive lookup).
    const onDisk = await fs.readFile(
      path.join(workspace, QWEN_DIR, 'agents', 'trimmed-name.md'),
      'utf8',
    );
    expect(onDisk).toContain('name: trimmed-name');
  });

  it('returns 422 invalid_config when scalar field has wrong type on create', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const res = await request(app).post('/workspace/agents').send({
      name: 'wrong-type',
      description: 'a description longer than ten chars',
      systemPrompt: 'you are a wrong-type test agent',
      scope: 'workspace',
      model: 123,
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_config');
    expect(res.body.error).toMatch(/model.*string/);
  });

  it('returns 422 invalid_config for unknown approvalMode', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const res = await request(app).post('/workspace/agents').send({
      name: 'bad-mode',
      description: 'a description longer than ten chars',
      systemPrompt: 'you are a bad-mode test agent',
      scope: 'workspace',
      approvalMode: 'rampage',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_config');
    expect(res.body.error).toMatch(/approvalMode/);
  });

  it('returns 422 invalid_config for unknown permissionMode', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const res = await request(app).post('/workspace/agents').send({
      name: 'bad-permission-mode',
      description: 'a description longer than ten chars',
      systemPrompt: 'you are a bad permission mode test agent',
      scope: 'workspace',
      permissionMode: 'invalid',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_config');
    expect(res.body.error).toMatch(/permissionMode/);
  });

  it('round-trips and clears permissionMode without approvalMode', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const create = await request(app).post('/workspace/agents').send({
      name: 'permission-mode-agent',
      description: 'an agent using the compatibility permission mode',
      systemPrompt: 'you are a permission mode test agent',
      scope: 'workspace',
      permissionMode: 'plan',
    });

    expect(create.status).toBe(201);
    expect(create.body.agent.permissionMode).toBe('plan');

    const clear = await request(app)
      .post('/workspace/agents/permission-mode-agent')
      .send({ permissionMode: null });

    expect(clear.status).toBe(200);
    expect(clear.body.agent).not.toHaveProperty('permissionMode');
  });

  it('strips unknown runConfig keys and rejects malformed values', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    // Unknown keys are silently dropped, valid known keys preserved.
    const res = await request(app)
      .post('/workspace/agents')
      .send({
        name: 'run-config',
        description: 'a description longer than ten chars',
        systemPrompt: 'you are a run-config test agent',
        scope: 'workspace',
        runConfig: { max_turns: 5, mystery_field: 'oops' },
      });
    expect(res.status).toBe(201);
    expect(res.body.agent.runConfig).toEqual({ max_turns: 5 });

    // Malformed known field fails closed.
    const res2 = await request(app)
      .post('/workspace/agents')
      .send({
        name: 'run-config-bad',
        description: 'a description longer than ten chars',
        systemPrompt: 'you are a run-config bad agent',
        scope: 'workspace',
        runConfig: { max_turns: -1 },
      });
    expect(res2.status).toBe(422);
    expect(res2.body.code).toBe('invalid_config');
  });

  it('rejects 400 invalid_scope on repeated ?scope= query', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    // Express parses repeated query params as an array; we should
    // fail-closed rather than treating it as absent.
    const res = await request(app).delete(
      '/workspace/agents/some-name?scope=workspace&scope=global',
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_scope');
  });

  it('rejects 400 invalid_config for empty update body', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    await request(app).post('/workspace/agents').send({
      name: 'has-fields',
      description: 'a description longer than ten chars',
      systemPrompt: 'you are a has-fields test agent',
      scope: 'workspace',
    });
    const res = await request(app)
      .post('/workspace/agents/has-fields')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_config');
  });

  it('stamps originatorClientId on agent_changed for known clients (create / update / delete)', async () => {
    const bridge = buildBridgeStub({ knownIds: ['client_audit'] });
    const app = buildApp({ bridge, boundWorkspace: workspace });

    // Create with a stamped client id.
    const createRes = await request(app)
      .post('/workspace/agents')
      .set('X-Qwen-Client-Id', 'client_audit')
      .send({
        name: 'audited',
        description: 'a description longer than ten chars',
        systemPrompt: 'you are an audited agent',
        scope: 'workspace',
      });
    expect(createRes.status).toBe(201);

    // Update with the same client id.
    const updateRes = await request(app)
      .post('/workspace/agents/audited')
      .set('X-Qwen-Client-Id', 'client_audit')
      .send({ description: 'a NEW description longer than ten chars' });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.changed).toBe(true);

    // Delete with the same client id.
    const deleteRes = await request(app)
      .delete('/workspace/agents/audited')
      .set('X-Qwen-Client-Id', 'client_audit');
    expect(deleteRes.status).toBe(204);

    const events = (bridge as unknown as { events: RecordedEvent[] }).events;
    const agentEvents = events.filter((e) => e.type === 'agent_changed');
    expect(agentEvents).toHaveLength(3);
    // All three must be stamped with the originator id so audit /
    // echo-suppression on the SDK side can attribute them.
    for (const evt of agentEvents) {
      expect(evt.originatorClientId).toBe('client_audit');
    }
    // Sequence: created → updated → deleted.
    expect(
      agentEvents.map((e) => (e.data as { change: string }).change),
    ).toEqual(['created', 'updated', 'deleted']);
  });

  it('returns 400 invalid_agent_type for path-traversal-shaped agentType', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    // The readdir-based scan in `findSubagentByNameAtLevel` already
    // protects against path traversal (filenames are matched, not
    // joined-and-resolved), but the route-level regex check fails
    // fast at the boundary so unsafe-shaped names never reach
    // SubagentManager.
    const res = await request(app).get('/workspace/agents/..%2Fetc%2Fpasswd');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_agent_type');
  });

  it('rejects 400 invalid_agent_type for over-long agentType', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const longName = 'a'.repeat(65);
    const res = await request(app).delete(`/workspace/agents/${longName}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_agent_type');
  });

  it('returns 500 agent_delete_partial when one level unlink silently fails', async () => {
    // Windows ignores Unix-style permission bits passed to
    // `fs.chmod` — the user-agents directory stays writable, the
    // unlink succeeds, and the partial-delete path this test
    // exercises is unreachable. SubagentManager's `unlink` import
    // (`import * as fs from 'fs/promises'`) creates a sealed
    // namespace object that vitest can't `spyOn`, so a per-platform
    // mock is also off-limits. The route logic itself is
    // platform-agnostic; the Ubuntu + macOS runs cover it. Mirrors
    // the `process.platform === 'win32'` early-return idiom used in
    // `customBanner.test.ts:232`.
    if (process.platform === 'win32') return;

    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });

    // Set up a project-level agent.
    await request(app).post('/workspace/agents').send({
      name: 'partial-target',
      description: 'a description longer than ten chars',
      systemPrompt: 'you are a partial-target agent',
      scope: 'workspace',
    });
    // Set up a user-level shadow with the same name.
    await request(app).post('/workspace/agents').send({
      name: 'partial-target',
      description: 'a description longer than ten chars',
      systemPrompt: 'you are a partial-target user agent',
      scope: 'global',
    });

    // Lock the user-level agent's containing directory so the unlink
    // raises EACCES — `SubagentManager.deleteSubagent` swallows the
    // error and returns "success" because the project-level unlink
    // worked. Without this PR's per-level `fs.access` verification,
    // the route would 204 and publish a misleading `agent_changed`
    // event for the user-level file that's still on disk.
    const userAgentsDir = path.join(globalDir, 'agents');
    const userPath = path.join(userAgentsDir, 'partial-target.md');
    const originalMode = (await fs.stat(userAgentsDir)).mode;
    await fs.chmod(userAgentsDir, 0o555); // r-x: blocks unlink
    try {
      const res = await request(app).delete('/workspace/agents/partial-target');
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('agent_delete_partial');
      expect(res.body.removedLevels).toEqual(['project']);
      expect(res.body.remainingLevels).toEqual(['user']);

      // Event fan-out: only one event for the level that actually
      // disappeared. The remaining level (still on disk) must NOT
      // emit a misleading deleted event.
      const events = (bridge as unknown as { events: RecordedEvent[] }).events;
      const deletedEvents = events.filter(
        (e) =>
          e.type === 'agent_changed' &&
          (e.data as { change: string }).change === 'deleted',
      );
      expect(deletedEvents).toHaveLength(1);
      expect((deletedEvents[0]?.data as { level: string }).level).toBe(
        'project',
      );

      // Verify the user-level file is still on disk.
      await expect(fs.access(userPath)).resolves.toBeUndefined();
    } finally {
      // Restore permissions so afterEach's rmdir succeeds.
      await fs.chmod(userAgentsDir, originalMode);
    }
  });

  it('DELETE /workspace/agents/:agentType?scope=workspace removes only the project shadow', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    await request(app).post('/workspace/agents').send({
      name: 'scoped-delete',
      description: 'a description longer than ten chars',
      systemPrompt: 'you are a scoped-delete project agent',
      scope: 'workspace',
    });
    await request(app).post('/workspace/agents').send({
      name: 'scoped-delete',
      description: 'a description longer than ten chars',
      systemPrompt: 'you are a scoped-delete user agent',
      scope: 'global',
    });

    const res = await request(app).delete(
      '/workspace/agents/scoped-delete?scope=workspace',
    );
    expect(res.status).toBe(204);

    // Project file gone; user file still exists.
    await expect(
      fs.access(path.join(workspace, QWEN_DIR, 'agents', 'scoped-delete.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.access(path.join(globalDir, 'agents', 'scoped-delete.md')),
    ).resolves.toBeUndefined();

    // Exactly one agent_changed event, at project level.
    const events = (bridge as unknown as { events: RecordedEvent[] }).events;
    const deleteEvents = events.filter(
      (e) =>
        e.type === 'agent_changed' &&
        (e.data as { change: string }).change === 'deleted',
    );
    expect(deleteEvents).toHaveLength(1);
    expect((deleteEvents[0]?.data as { level: string }).level).toBe('project');
  });

  it('POST /workspace/agents/:agentType?scope=global updates the user shadow', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    await request(app).post('/workspace/agents').send({
      name: 'scoped-update',
      description: 'a description longer than ten chars',
      systemPrompt: 'you are a scoped-update project agent',
      scope: 'workspace',
    });
    await request(app).post('/workspace/agents').send({
      name: 'scoped-update',
      description: 'a description longer than ten chars',
      systemPrompt: 'you are a scoped-update user agent',
      scope: 'global',
    });

    const res = await request(app)
      .post('/workspace/agents/scoped-update?scope=global')
      .send({ description: 'NEW user-level description (longer than ten)' });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.agent.level).toBe('user');
    expect(res.body.agent.description).toBe(
      'NEW user-level description (longer than ten)',
    );

    // Project-level definition is untouched.
    const projectFile = await fs.readFile(
      path.join(workspace, QWEN_DIR, 'agents', 'scoped-update.md'),
      'utf8',
    );
    expect(projectFile).toContain('a description longer than ten chars');
  });

  it('rejects 422 when create has whitespace-only systemPrompt', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const res = await request(app).post('/workspace/agents').send({
      name: 'whitespace-prompt',
      description: 'a description longer than ten chars',
      systemPrompt: '   \n  \t  ',
      scope: 'workspace',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_config');
    expect(res.body.error).toMatch(/systemPrompt.*non-empty/);
  });

  it('rejects 422 when update has whitespace-only systemPrompt', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    await request(app).post('/workspace/agents').send({
      name: 'prompt-target',
      description: 'a description longer than ten chars',
      systemPrompt: 'you are a prompt-target agent',
      scope: 'workspace',
    });
    const res = await request(app)
      .post('/workspace/agents/prompt-target')
      .send({ systemPrompt: '\n\n  \t' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_config');
  });

  it('toDetail.runConfig only emits the documented fields', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    await request(app)
      .post('/workspace/agents')
      .send({
        name: 'detail-pick',
        description: 'a description longer than ten chars',
        systemPrompt: 'you are a detail-pick agent',
        scope: 'workspace',
        runConfig: { max_time_minutes: 5, max_turns: 7 },
      });
    const res = await request(app).get('/workspace/agents/detail-pick');
    expect(res.status).toBe(200);
    // Detail must contain ONLY the whitelisted runConfig keys; if
    // `SubagentConfig.runConfig` ever gains a new field in core, this
    // assertion fails until the route schema is updated explicitly.
    expect(Object.keys(res.body.runConfig).sort()).toEqual([
      'max_time_minutes',
      'max_turns',
    ]);
  });

  it('rejects 422 when update body has whitespace-only description', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    await request(app).post('/workspace/agents').send({
      name: 'whitespace-target',
      description: 'a description longer than ten chars',
      systemPrompt: 'you are a whitespace target agent',
      scope: 'workspace',
    });
    // Update path used to silently accept "   " and overwrite the
    // description with blank — divergent from create which 422s.
    const res = await request(app)
      .post('/workspace/agents/whitespace-target')
      .send({ description: '   ' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_config');
    expect(res.body.error).toMatch(/non-empty/);
  });

  it('detects no-op partial runConfig update (preserves omitted keys)', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    await request(app)
      .post('/workspace/agents')
      .send({
        name: 'runconfig-noop',
        description: 'a description longer than ten chars',
        systemPrompt: 'you are a runconfig-noop agent',
        scope: 'workspace',
        runConfig: { max_time_minutes: 30, max_turns: 10 },
      });
    const eventsBefore = (bridge as unknown as { events: RecordedEvent[] })
      .events.length;

    // Partial update with the SAME max_time_minutes value. Without the
    // fix, isNoOpUpdate compared `undefined !== existing.max_turns` →
    // true and re-wrote the file + emitted agent_changed.
    const res = await request(app)
      .post('/workspace/agents/runconfig-noop')
      .send({ runConfig: { max_time_minutes: 30 } });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);

    const events = (bridge as unknown as { events: RecordedEvent[] }).events;
    expect(events.length).toBe(eventsBefore);
  });

  it('detects real partial runConfig change and writes', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    await request(app)
      .post('/workspace/agents')
      .send({
        name: 'runconfig-real',
        description: 'a description longer than ten chars',
        systemPrompt: 'you are a runconfig-real agent',
        scope: 'workspace',
        runConfig: { max_time_minutes: 30, max_turns: 10 },
      });
    const res = await request(app)
      .post('/workspace/agents/runconfig-real')
      .send({ runConfig: { max_time_minutes: 45 } });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    // Merged result preserves max_turns from existing.
    expect(res.body.agent.runConfig).toEqual({
      max_time_minutes: 45,
      max_turns: 10,
    });
  });

  it('detects unchanged MCP servers and hooks as a no-op', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    const mcpServers = {
      filesystem: { type: 'stdio', command: 'node', args: ['server.js'] },
    };
    const hooks = {
      PreToolUse: [{ matcher: 'read_file', hooks: [] }],
    };
    await request(app).post('/workspace/agents').send({
      name: 'record-noop',
      description: 'a description longer than ten chars',
      systemPrompt: 'you are a record-noop agent',
      scope: 'workspace',
      mcpServers,
      hooks,
    });
    const eventsBefore = (bridge as unknown as { events: RecordedEvent[] })
      .events.length;

    const res = await request(app)
      .post('/workspace/agents/record-noop')
      .send({ mcpServers, hooks });

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    const events = (bridge as unknown as { events: RecordedEvent[] }).events;
    expect(events.length).toBe(eventsBefore);
  });

  it('short-circuits no-op updates with changed: false and no event', async () => {
    const bridge = buildBridgeStub();
    const app = buildApp({ bridge, boundWorkspace: workspace });
    await request(app).post('/workspace/agents').send({
      name: 'noop-target',
      description: 'a description longer than ten chars',
      systemPrompt: 'you are a noop-target agent',
      scope: 'workspace',
    });
    const eventsBefore = (bridge as unknown as { events: RecordedEvent[] })
      .events.length;

    const res = await request(app)
      .post('/workspace/agents/noop-target')
      .send({ description: 'a description longer than ten chars' });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);

    // No new agent_changed event for the no-op update.
    const events = (bridge as unknown as { events: RecordedEvent[] }).events;
    expect(events.length).toBe(eventsBefore);
  });
});
