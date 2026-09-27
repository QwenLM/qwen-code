/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  type Agent,
  type InitializeResponse,
  type NewSessionResponse,
} from '@agentclientprotocol/sdk';
import type { AcpChannel } from '@qwen-code/acp-bridge/channel';
import { createInMemoryChannel } from '@qwen-code/acp-bridge/inMemoryChannel';
import {
  SESSION_EXECUTION_ENGINE_META_KEY,
  type BridgeExecutionEngine,
} from '@qwen-code/acp-bridge/bridgeOptions';
import { SERVE_CONTROL_EXT_METHODS } from '@qwen-code/acp-bridge/status';
import { SessionNotFoundError } from '@qwen-code/acp-bridge/bridgeErrors';
import {
  createAcpSessionBridge,
  type AcpSessionBridge,
} from './acp-session-bridge.js';
import { createServeApp } from './server.js';
import type { ServeOptions } from './types.js';

const TOKEN = 'paired-change-token';

class EngineAgent {
  private sessions = 0;
  readonly changes: Array<Record<string, unknown>> = [];
  readonly prompts: string[] = [];

  constructor(
    private readonly engine: BridgeExecutionEngine,
    private readonly acknowledge: () => boolean,
  ) {}

  async initialize(): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: `${this.engine}-agent`, version: '0' },
      authMethods: [],
      agentCapabilities: {},
    };
  }

  async newSession(): Promise<NewSessionResponse> {
    this.sessions += 1;
    return {
      sessionId: `${this.engine}-${this.sessions}`,
      _meta: { [SESSION_EXECUTION_ENGINE_META_KEY]: this.engine },
    };
  }

  async authenticate(): Promise<void> {}

  async prompt(params: { sessionId: string }) {
    this.prompts.push(params.sessionId);
    return { stopReason: 'end_turn' as const };
  }

  async cancel(): Promise<void> {}

  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (method) {
      case SERVE_CONTROL_EXT_METHODS.sessionClose:
        return { closed: true };
      case 'qwen/permissions/setRules':
        return { allow: [], ask: [], deny: params['rules'] };
      case SERVE_CONTROL_EXT_METHODS.workspaceReload:
        return {
          env: { updatedKeys: [], removedKeys: [] },
          changedKeys: ['permissions'],
          sessionsRefreshed: ['legacy-1'],
          sessionsSkipped: [],
        };
      case SERVE_CONTROL_EXT_METHODS.workspaceChange:
        this.changes.push(params);
        if (!this.acknowledge()) throw new Error('change not applied');
        return { v: 1, revision: params['revision'], acknowledged: true };
      default:
        return {};
    }
  }
}

function engineChannel(agent: EngineAgent): AcpChannel {
  const { clientStream, agentStream, abort } = createInMemoryChannel();
  new AgentSideConnection(() => agent as unknown as Agent, agentStream);
  let exit!: () => void;
  const exited = new Promise<undefined>((resolve) => {
    exit = () => resolve(undefined);
  });
  const stop = () => {
    abort();
    exit();
  };
  return {
    stream: clientStream,
    exited,
    kill: async () => stop(),
    killSync: stop,
  };
}

describe('paired Bridge workspace changes through the workspace routes', () => {
  let workspaceCwd: string;
  let bridge: AcpSessionBridge | undefined;

  beforeEach(async () => {
    workspaceCwd = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'qwen-paired-change-')),
    );
  });

  afterEach(async () => {
    await bridge?.shutdown();
    bridge = undefined;
    vi.restoreAllMocks();
    await rm(workspaceCwd, { recursive: true, force: true });
  });

  async function harness(managedAcknowledges: boolean) {
    const legacy = new EngineAgent('legacy', () => true);
    const managed = new EngineAgent('managed', () => managedAcknowledges);
    let selected: BridgeExecutionEngine = 'managed';
    const paired = createAcpSessionBridge({
      boundWorkspace: workspaceCwd,
      sessionScope: 'thread',
      executionEngines: {
        legacy: async () => engineChannel(legacy),
        managed: async () => engineChannel(managed),
        select: () => selected,
      },
    });
    bridge = paired;
    const opts: ServeOptions = {
      hostname: '127.0.0.1',
      port: 4170,
      mode: 'http-bridge',
      workspace: workspaceCwd,
      token: TOKEN,
    };
    const app = createServeApp(opts, undefined, {
      bridge: paired,
      primaryWorkspaceTrusted: true,
    });
    const post = (route: string, body: Record<string, unknown>) =>
      request(app)
        .post(route)
        .set('Host', '127.0.0.1:4170')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send(body);
    const managedSession = await paired.spawnOrAttach({
      workspaceCwd,
      sessionScope: 'thread',
    });
    selected = 'legacy';
    await paired.spawnOrAttach({ workspaceCwd, sessionScope: 'thread' });
    const prompt = (sessionId: string) =>
      post(`/session/${sessionId}/prompt`, {
        prompt: [{ type: 'text', text: 'hello' }],
      });
    return { paired, legacy, managed, managedSession, post, prompt };
  }

  it('delivers a new deny rule to live Managed sessions', async () => {
    const { managed, managedSession, post, prompt } = await harness(true);

    const res = await post('/workspace/permissions', {
      scope: 'workspace',
      ruleType: 'deny',
      rules: ['Bash'],
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deny: ['Bash'] });
    expect(managed.changes).toEqual([
      {
        v: 1,
        revision: 1,
        kind: 'permissions',
        tightening: true,
        cwd: workspaceCwd,
      },
    ]);
    expect((await prompt(managedSession.sessionId)).status).toBe(202);
  });

  it('quarantines Managed when it does not acknowledge a new deny rule', async () => {
    const { paired, legacy, managed, managedSession, post, prompt } =
      await harness(false);
    const published = vi.spyOn(paired, 'publishWorkspaceEvent');

    const res = await post('/workspace/permissions', {
      scope: 'workspace',
      ruleType: 'deny',
      rules: ['Bash'],
    });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'permission_update_failed' });
    expect(managed.changes).toHaveLength(1);
    expect(published).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'settings_changed',
        data: expect.objectContaining({ key: 'permissions.deny' }),
      }),
    );
    // The idle Managed session is closed by the quarantine drain.
    await vi.waitFor(() =>
      expect(() => paired.getSessionSummary(managedSession.sessionId)).toThrow(
        SessionNotFoundError,
      ),
    );
    expect((await prompt(managedSession.sessionId)).status).toBe(404);
    expect(managed.prompts).toEqual([]);
    expect((await prompt('legacy-1')).status).toBe(202);
    await vi.waitFor(() => expect(legacy.prompts).toEqual(['legacy-1']));
  });

  it('reports the Legacy reload when Managed does not acknowledge it', async () => {
    const { managed, post } = await harness(false);

    const res = await post('/workspace/reload', {});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      childReloaded: true,
      changedKeys: ['permissions'],
      sessionsRefreshed: ['legacy-1'],
      childError: expect.stringContaining('not acknowledged'),
    });
    expect(managed.changes).toMatchObject([
      { kind: 'settings', tightening: true },
    ]);
  });
});
