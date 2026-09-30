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
import {
  SERVE_CONTROL_EXT_METHODS,
  SERVE_STATUS_EXT_METHODS,
} from '@qwen-code/acp-bridge/status';
import {
  createAcpSessionBridge,
  type AcpSessionBridge,
} from './acp-session-bridge.js';
import { createServeApp } from './server.js';
import type { ServeOptions } from './types.js';

class EngineAgent {
  private sessions = 0;

  constructor(
    private readonly engine: BridgeExecutionEngine,
    private readonly workspaceCwd: string,
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

  async prompt() {
    return { stopReason: 'end_turn' as const };
  }

  async cancel(): Promise<void> {}

  async extMethod(method: string): Promise<Record<string, unknown>> {
    switch (method) {
      case SERVE_CONTROL_EXT_METHODS.sessionClose:
        return { closed: true };
      case SERVE_CONTROL_EXT_METHODS.workspaceSkillsRefresh:
        return { configsRefreshed: 1, configsFailed: 0 };
      case SERVE_STATUS_EXT_METHODS.workspaceSkills:
        return {
          v: 1,
          workspaceCwd: this.workspaceCwd,
          initialized: true,
          skills: [],
        };
      case SERVE_STATUS_EXT_METHODS.workspaceMcp:
        return {
          v: 1,
          workspaceCwd: this.workspaceCwd,
          initialized: true,
          discoveryState: 'completed',
          servers: [],
        };
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

describe('paired Bridge workspace runtime through the workspace routes', () => {
  let workspaceCwd: string;
  let bridge: AcpSessionBridge | undefined;

  beforeEach(async () => {
    workspaceCwd = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'qwen-paired-runtime-')),
    );
  });

  afterEach(async () => {
    await bridge?.shutdown();
    bridge = undefined;
    vi.restoreAllMocks();
    await rm(workspaceCwd, { recursive: true, force: true });
  });

  function harness(options: { failLegacyStart?: boolean } = {}) {
    const started: Record<BridgeExecutionEngine, AcpChannel[]> = {
      legacy: [],
      managed: [],
    };
    const start = (engine: BridgeExecutionEngine) => async () => {
      if (engine === 'legacy' && options.failLegacyStart) {
        throw new Error('Legacy child failed to start');
      }
      const channel = engineChannel(new EngineAgent(engine, workspaceCwd));
      started[engine].push(channel);
      return channel;
    };
    const paired = createAcpSessionBridge({
      boundWorkspace: workspaceCwd,
      sessionScope: 'thread',
      channelIdleTimeoutMs: 0,
      executionEngines: {
        legacy: start('legacy'),
        managed: start('managed'),
        select: () => 'managed',
      },
    });
    bridge = paired;
    const opts: ServeOptions = {
      hostname: '127.0.0.1',
      port: 4170,
      mode: 'http-bridge',
      workspace: workspaceCwd,
    };
    const app = createServeApp(opts, undefined, {
      bridge: paired,
      primaryWorkspaceTrusted: true,
    });
    const call = (method: 'get' | 'post', route: string) =>
      request(app)[method](route).set('Host', '127.0.0.1:4170');
    const spawnManaged = () =>
      paired.spawnOrAttach({ workspaceCwd, sessionScope: 'thread' });
    return { bridge: paired, started, call, spawnManaged };
  }

  it('keeps prepared Legacy capabilities ready while Managed restarts', async () => {
    const { bridge, started, call, spawnManaged } = harness();
    const managed = await spawnManaged();

    expect((await call('get', '/workspace/acp/status')).body).toEqual({
      channelLive: false,
    });
    const cold = await call('get', '/workspace/runtime/status');
    expect(cold.body).toMatchObject({ state: 'cold', runtimeLive: false });

    const ready = await call('post', '/workspace/runtime/ensure');
    expect(ready.status).toBe(200);
    const legacyEpoch = ready.body.runtimeEpoch;
    expect(ready.body).toMatchObject({
      runtimeLive: true,
      capabilities: {
        skills: { state: 'ready', runtimeEpoch: legacyEpoch },
        mcp: { state: 'ready', runtimeEpoch: legacyEpoch },
      },
    });
    expect(started.legacy).toHaveLength(1);

    await bridge.closeSession(managed.sessionId);
    await spawnManaged();
    expect(started.managed).toHaveLength(2);

    const after = await call('get', '/workspace/runtime/status');
    expect(after.body).toMatchObject({
      runtimeLive: true,
      runtimeEpoch: legacyEpoch,
      capabilities: {
        skills: { state: 'ready', runtimeEpoch: legacyEpoch },
        mcp: { state: 'ready', runtimeEpoch: legacyEpoch },
      },
    });
    expect(started.legacy).toHaveLength(1);
  });

  it('stales Legacy capabilities when Legacy exits while Managed stays live', async () => {
    const { bridge, started, call, spawnManaged } = harness();
    await spawnManaged();
    const ready = await call('post', '/workspace/runtime/ensure');
    const legacyEpoch = ready.body.runtimeEpoch;
    expect(ready.body.capabilities.skills).toMatchObject({
      state: 'ready',
      runtimeEpoch: legacyEpoch,
    });

    started.legacy[0].killSync();
    await vi.waitFor(async () =>
      expect(
        (await call('get', '/workspace/runtime/status')).body,
      ).toMatchObject({
        runtimeLive: false,
        capabilities: {
          skills: { state: 'stale', runtimeEpoch: legacyEpoch },
          mcp: { state: 'stale', runtimeEpoch: legacyEpoch },
        },
      }),
    );
    expect(bridge.isChannelLive()).toBe(true);

    const restarted = await call('post', '/workspace/runtime/ensure');
    expect(started.legacy).toHaveLength(2);
    expect(restarted.body.runtimeEpoch).toBeGreaterThan(legacyEpoch);
    expect(restarted.body.capabilities).toMatchObject({
      skills: { state: 'ready', runtimeEpoch: restarted.body.runtimeEpoch },
      mcp: { state: 'ready', runtimeEpoch: restarted.body.runtimeEpoch },
    });
  });

  it('does not report a failed Legacy preheat as live while Managed is live', async () => {
    const { call, spawnManaged } = harness({ failLegacyStart: true });
    await spawnManaged();

    const res = await call('post', '/workspace/acp/preheat');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ready: false,
      channelLive: false,
      reason: 'error',
    });
  });
});
