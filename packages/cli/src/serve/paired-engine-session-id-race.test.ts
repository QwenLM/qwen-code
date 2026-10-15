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
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
} from '@agentclientprotocol/sdk';
import type { AcpChannel } from '@qwen-code/acp-bridge/channel';
import { createInMemoryChannel } from '@qwen-code/acp-bridge/inMemoryChannel';
import {
  SESSION_EXECUTION_ENGINE_META_KEY,
  type BridgeExecutionEngine,
} from '@qwen-code/acp-bridge/bridgeOptions';
import { REQUESTED_SESSION_ID_META_KEY } from '@qwen-code/acp-bridge/bridgeTypes';
import { SERVE_CONTROL_EXT_METHODS } from '@qwen-code/acp-bridge/status';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import {
  createAcpSessionBridge,
  type AcpSessionBridge,
} from './acp-session-bridge.js';
import { createServeApp } from './server.js';
import type { ServeOptions } from './types.js';

const SESSION_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';

class EngineAgent {
  readonly newSessionCalls: NewSessionRequest[] = [];
  readonly promptCalls: PromptRequest[] = [];

  constructor(private readonly engine: BridgeExecutionEngine) {}

  async initialize(): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: `${this.engine}-agent`, version: '0' },
      authMethods: [],
      agentCapabilities: {},
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.newSessionCalls.push(params);
    const requested = params._meta?.[REQUESTED_SESSION_ID_META_KEY];
    return {
      sessionId:
        typeof requested === 'string'
          ? requested
          : `${this.engine}-${this.newSessionCalls.length}`,
      _meta: { [SESSION_EXECUTION_ENGINE_META_KEY]: this.engine },
    };
  }

  async authenticate(): Promise<void> {}

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    this.promptCalls.push(params);
    return { stopReason: 'end_turn' };
  }

  async cancel(): Promise<void> {}

  async extMethod(method: string): Promise<Record<string, unknown>> {
    if (method === SERVE_CONTROL_EXT_METHODS.sessionClose) {
      return { closed: true };
    }
    if (method === SERVE_CONTROL_EXT_METHODS.sessionSource) {
      return { persisted: true };
    }
    return {};
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('paired Bridge requested-ID rejection through the session route', () => {
  let root: string;
  let workspaceCwd: string;
  let previousRuntimeDir: string | undefined;
  let bridge: AcpSessionBridge | undefined;

  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'qwen-paired-race-')),
    );
    workspaceCwd = root;
    previousRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = path.join(root, '.runtime');
  });

  afterEach(async () => {
    await bridge?.shutdown();
    bridge = undefined;
    vi.restoreAllMocks();
    if (previousRuntimeDir === undefined) {
      delete process.env['QWEN_RUNTIME_DIR'];
    } else {
      process.env['QWEN_RUNTIME_DIR'] = previousRuntimeDir;
    }
    await rm(root, { recursive: true, force: true });
  });

  function harness() {
    const legacy = new EngineAgent('legacy');
    const managed = new EngineAgent('managed');
    bridge = createAcpSessionBridge({
      boundWorkspace: workspaceCwd,
      sessionScope: 'thread',
      executionEngines: {
        legacy: async () => engineChannel(legacy),
        managed: async () => engineChannel(managed),
        select: () => 'managed',
      },
    });
    const opts: ServeOptions = {
      hostname: '127.0.0.1',
      port: 4170,
      mode: 'http-bridge',
      workspace: workspaceCwd,
    };
    const app = createServeApp(opts, undefined, { bridge });
    const post = (body: Record<string, unknown>) =>
      request(app)
        .post('/session')
        .set('Host', '127.0.0.1:4170')
        .send({ cwd: workspaceCwd, ...body });
    const dispatches = () =>
      legacy.newSessionCalls.length + managed.newSessionCalls.length;
    return { bridge, managed, post, dispatches };
  }

  it('reports a direct creator that wins the admission race as a 409 conflict', async () => {
    const { bridge, managed, post, dispatches } = harness();
    const scanStarted = deferred<void>();
    const scanResult = deferred<string | undefined>();
    vi.spyOn(
      SessionService.prototype,
      'findSessionIdIgnoringCase',
    ).mockImplementationOnce(() => {
      scanStarted.resolve();
      return scanResult.promise;
    });

    const routed = post({ sessionId: SESSION_ID }).then((res) => res);
    await scanStarted.promise;
    const direct = await bridge.spawnOrAttach({
      workspaceCwd,
      sessionScope: 'thread',
      sessionId: SESSION_ID,
      sourceType: 'managed-gateway',
      sourceId: SESSION_ID,
    });
    scanResult.resolve(undefined);
    const res = await routed;

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: `Invalid params: Session ${SESSION_ID} is already live`,
      code: 'session_id_conflict',
      sessionId: SESSION_ID,
      conflict: 'live',
    });
    expect(dispatches()).toBe(1);
    expect(managed.newSessionCalls[0]!._meta).toMatchObject({
      [REQUESTED_SESSION_ID_META_KEY]: SESSION_ID,
      [SESSION_EXECUTION_ENGINE_META_KEY]: 'managed',
    });

    await expect(
      bridge.sendPrompt(direct.sessionId, {
        sessionId: direct.sessionId,
        prompt: [{ type: 'text', text: 'still usable' }],
      }),
    ).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(managed.promptCalls.map((call) => call.sessionId)).toEqual([
      SESSION_ID,
    ]);
    expect(bridge.sessionCount).toBe(1);
  });

  it('keeps invalid input and ordinary shared admission in front of the Bridge', async () => {
    const { bridge, post, dispatches } = harness();

    const invalid = await post({ sessionId: 'not-a-uuid' });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ code: 'invalid_session_id' });

    await bridge.spawnOrAttach({
      workspaceCwd,
      sessionScope: 'thread',
      sessionId: SESSION_ID,
    });
    const live = await post({ sessionId: SESSION_ID });
    expect(live.status).toBe(409);
    // Shared admission's own answer, not the Bridge rejection.
    expect(live.body).toEqual({
      error: `Session "${SESSION_ID}" already exists or is being created.`,
      code: 'session_id_conflict',
      sessionId: SESSION_ID,
      conflict: 'live',
      liveWorkspaceCwd: workspaceCwd,
    });
    expect(dispatches()).toBe(1);
  });
});
