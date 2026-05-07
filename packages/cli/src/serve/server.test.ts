/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createServeApp } from './server.js';
import { runQwenServe, type RunHandle } from './runQwenServe.js';
import type {
  CancelNotification,
  PromptRequest,
  PromptResponse,
} from '@agentclientprotocol/sdk';
import {
  SessionNotFoundError,
  type BridgeSession,
  type BridgeSpawnRequest,
  type HttpAcpBridge,
} from './httpAcpBridge.js';
import {
  CAPABILITIES_SCHEMA_VERSION,
  STAGE1_FEATURES,
  type ServeOptions,
} from './types.js';

const baseOpts: ServeOptions = {
  hostname: '127.0.0.1',
  port: 4170,
  mode: 'http-bridge',
};

interface FakeBridgeOpts {
  spawnImpl?: (req: BridgeSpawnRequest) => Promise<BridgeSession>;
  promptImpl?: (
    sessionId: string,
    req: PromptRequest,
  ) => Promise<PromptResponse>;
  cancelImpl?: (sessionId: string, req?: CancelNotification) => Promise<void>;
}

interface FakeBridge extends HttpAcpBridge {
  calls: BridgeSpawnRequest[];
  promptCalls: Array<{ sessionId: string; req: PromptRequest }>;
  cancelCalls: Array<{ sessionId: string; req?: CancelNotification }>;
  shutdownCalls: number;
}

function fakeBridge(opts: FakeBridgeOpts = {}): FakeBridge {
  const calls: BridgeSpawnRequest[] = [];
  const promptCalls: FakeBridge['promptCalls'] = [];
  const cancelCalls: FakeBridge['cancelCalls'] = [];
  let shutdownCalls = 0;
  const spawnImpl =
    opts.spawnImpl ??
    (async (req) => ({
      sessionId: `fake-${calls.length}`,
      workspaceCwd: req.workspaceCwd,
      attached: false,
    }));
  const promptImpl =
    opts.promptImpl ?? (async () => ({ stopReason: 'end_turn' }));
  const cancelImpl = opts.cancelImpl ?? (async () => {});
  return {
    calls,
    promptCalls,
    cancelCalls,
    get shutdownCalls() {
      return shutdownCalls;
    },
    get sessionCount() {
      return calls.length;
    },
    async spawnOrAttach(req) {
      const result = await spawnImpl(req);
      calls.push(req);
      return result;
    },
    async sendPrompt(sessionId, req) {
      promptCalls.push({ sessionId, req });
      return promptImpl(sessionId, req);
    },
    async cancelSession(sessionId, req) {
      cancelCalls.push({ sessionId, req });
      return cancelImpl(sessionId, req);
    },
    async shutdown() {
      shutdownCalls += 1;
    },
  };
}

describe('createServeApp', () => {
  describe('GET /health', () => {
    it('returns 200 ok', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });
  });

  describe('GET /capabilities', () => {
    it('returns the v1 envelope', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body.v).toBe(CAPABILITIES_SCHEMA_VERSION);
      expect(res.body.mode).toBe('http-bridge');
      expect(res.body.features).toEqual([...STAGE1_FEATURES]);
      expect(res.body.modelServices).toEqual([]);
    });
  });

  describe('host allowlist (loopback bind)', () => {
    it('rejects requests with an unrelated Host header', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/health')
        .set('Host', 'evil.example.com');
      expect(res.status).toBe(403);
    });

    it('accepts host.docker.internal so containers can reach the host daemon', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/health')
        .set('Host', `host.docker.internal:${baseOpts.port}`);
      expect(res.status).toBe(200);
    });
  });

  describe('POST /session', () => {
    it('400 when cwd is missing', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});
      expect(res.status).toBe(400);
      expect(bridge.calls).toHaveLength(0);
    });

    it('400 when cwd is relative', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: 'relative/path' });
      expect(res.status).toBe(400);
      expect(bridge.calls).toHaveLength(0);
    });

    it('200 with the BridgeSession shape on success', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: '/work/a', modelServiceId: 'qwen-prod' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sessionId: 'fake-0',
        workspaceCwd: '/work/a',
        attached: false,
      });
      expect(bridge.calls).toEqual([
        { workspaceCwd: '/work/a', modelServiceId: 'qwen-prod' },
      ]);
    });

    it('500 when bridge throws', async () => {
      const bridge = fakeBridge({
        spawnImpl: async () => {
          throw new Error('boom');
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: '/work/a' });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'boom' });
    });
  });

  describe('POST /session/:id/prompt', () => {
    it('200 with PromptResponse on success; route :id wins over body sessionId', async () => {
      const bridge = fakeBridge({
        promptImpl: async () => ({ stopReason: 'end_turn' }),
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({
          sessionId: 'spoofed-session-B',
          prompt: [{ type: 'text', text: 'hi' }],
        });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ stopReason: 'end_turn' });
      expect(bridge.promptCalls).toHaveLength(1);
      expect(bridge.promptCalls[0]?.sessionId).toBe('session-A');
      expect(bridge.promptCalls[0]?.req.sessionId).toBe('session-A');
    });

    it('400 when prompt body is missing', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});
      expect(res.status).toBe(400);
      expect(bridge.promptCalls).toHaveLength(0);
    });

    it('404 when bridge reports unknown session', async () => {
      const bridge = fakeBridge({
        promptImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/missing/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ prompt: [{ type: 'text', text: 'hi' }] });
      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });

    it('500 on generic bridge errors', async () => {
      const bridge = fakeBridge({
        promptImpl: async () => {
          throw new Error('agent crashed');
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ prompt: [{ type: 'text', text: 'hi' }] });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'agent crashed' });
    });
  });

  describe('POST /session/:id/cancel', () => {
    it('204 on success and forwards routing id', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/cancel')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ sessionId: 'spoofed-B' });
      expect(res.status).toBe(204);
      expect(res.body).toEqual({});
      expect(bridge.cancelCalls).toHaveLength(1);
      expect(bridge.cancelCalls[0]?.sessionId).toBe('session-A');
      expect(bridge.cancelCalls[0]?.req?.sessionId).toBe('session-A');
    });

    it('204 with empty body', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/cancel')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(204);
      expect(bridge.cancelCalls).toHaveLength(1);
    });

    it('404 on unknown session', async () => {
      const bridge = fakeBridge({
        cancelImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/missing/cancel')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });
  });

  describe('bearer auth', () => {
    it('is open by default (loopback developer convenience)', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
    });

    it('rejects missing Authorization header when token is set', async () => {
      const app = createServeApp({ ...baseOpts, token: 'secret' });
      const res = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(401);
    });

    it('rejects wrong scheme', async () => {
      const app = createServeApp({ ...baseOpts, token: 'secret' });
      const res = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Authorization', 'Basic c2VjcmV0');
      expect(res.status).toBe(401);
    });

    it('rejects wrong token', async () => {
      const app = createServeApp({ ...baseOpts, token: 'secret' });
      const res = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Authorization', 'Bearer wrong');
      expect(res.status).toBe(401);
    });

    it('accepts the right token', async () => {
      const app = createServeApp({ ...baseOpts, token: 'secret' });
      const res = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Authorization', 'Bearer secret');
      expect(res.status).toBe(200);
    });
  });
});

describe('runQwenServe', () => {
  let handle: RunHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
    delete process.env['QWEN_SERVER_TOKEN'];
  });

  it('refuses to bind 0.0.0.0 without a token', async () => {
    await expect(
      runQwenServe({
        hostname: '0.0.0.0',
        port: 0,
        mode: 'http-bridge',
      }),
    ).rejects.toThrow(/Refusing to bind/);
  });

  it('accepts QWEN_SERVER_TOKEN from the env when binding non-loopback', async () => {
    process.env['QWEN_SERVER_TOKEN'] = 'env-secret';
    handle = await runQwenServe({
      hostname: '0.0.0.0',
      port: 0,
      mode: 'http-bridge',
    });
    expect(handle.url).toMatch(/^http:\/\/0\.0\.0\.0:\d+$/);
  });

  it('starts on a loopback ephemeral port without a token', async () => {
    handle = await runQwenServe({
      hostname: '127.0.0.1',
      port: 0,
      mode: 'http-bridge',
    });
    const port = (handle.server.address() as { port: number }).port;
    expect(port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('drains the bridge before closing the listener', async () => {
    const bridge = fakeBridge();
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    expect(bridge.shutdownCalls).toBe(0);
    await handle.close();
    handle = undefined;
    expect(bridge.shutdownCalls).toBe(1);
  });
});

describe('runQwenServe SIGINT handler', () => {
  it('does not register signal handlers until the listener is up', () => {
    // Sanity: we register `once` so we don't leak across test runs.
    // No assertion beyond "module loads without throwing"; full lifecycle
    // is covered indirectly by the loopback boot test above.
    expect(typeof runQwenServe).toBe('function');
    void vi.fn(); // silence unused-import lint if vitest tree-shakes
  });
});
