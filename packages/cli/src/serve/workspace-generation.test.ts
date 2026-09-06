/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import { createMutationGate } from './auth.js';
import { mountWorkspaceGenerationRoutes } from './workspace-generation.js';

function buildApp(bridge: AcpSessionBridge) {
  const app = express();
  app.use(express.json());
  mountWorkspaceGenerationRoutes(app, {
    bridge,
    mutate: createMutationGate({ tokenConfigured: true, requireAuth: false }),
    parseClientId: () => undefined,
    safeBody: (req) => req.body as Record<string, unknown>,
  });
  return app;
}

describe('workspace generation route', () => {
  it('streams the session-compatible generation envelope', async () => {
    const bridge = {
      async *generateWorkspaceContent() {
        yield {
          type: 'started',
          requestId: 'request-1',
          model: 'qwen-plus',
          modelSource: 'fast',
        };
        yield {
          type: 'delta',
          requestId: 'request-1',
          seq: 0,
          text: 'hello',
        };
        yield {
          type: 'done',
          requestId: 'request-1',
          model: 'qwen-plus',
          modelSource: 'fast',
          inputTokens: 2,
          outputTokens: 1,
        };
      },
    } as unknown as AcpSessionBridge;

    const res = await request(buildApp(bridge))
      .post('/workspace/generate')
      .send({ prompt: 'Say hello' });

    expect(res.status).toBe(200);
    expect(res.type).toBe('text/event-stream');
    expect(res.text).toContain(': connected\n\n');
    expect(res.text).toContain(
      'event: started\ndata: {"v":1,"type":"started","requestId":"request-1","model":"qwen-plus","modelSource":"fast"}',
    );
    expect(res.text).toContain(
      'event: delta\ndata: {"v":1,"type":"delta","requestId":"request-1","seq":0,"text":"hello"}',
    );
    expect(res.text).toContain('event: done');
  });

  it('returns 501 when the bridge does not support generation', async () => {
    const bridge = {} as AcpSessionBridge;
    const res = await request(buildApp(bridge))
      .post('/workspace/generate')
      .send({ prompt: 'Say hello' });

    expect(res.status).toBe(501);
    expect(res.body.code).toBe('generation_not_supported');
  });

  it('streams an error event when generation fails', async () => {
    const bridge = {
      async *generateWorkspaceContent() {
        yield {
          type: 'started',
          requestId: 'request-1',
          model: 'qwen-plus',
          modelSource: 'fast',
        };
        throw new Error('upstream failed');
      },
    } as unknown as AcpSessionBridge;

    const res = await request(buildApp(bridge))
      .post('/workspace/generate')
      .send({ prompt: 'Say hello' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('event: started');
    expect(res.text).toContain('event: error');
    expect(res.text).toContain('"type":"error"');
    expect(res.text).toContain('"code":"generation_failed"');
  });

  it.each([
    { prompt: '' },
    { prompt: '   ' },
    { prompt: 42 },
    { prompt: 'x'.repeat(32 * 1024 + 1) },
  ])('rejects invalid prompts before starting the bridge', async (body) => {
    const generateWorkspaceContent = vi.fn();
    const bridge = {
      generateWorkspaceContent,
    } as unknown as AcpSessionBridge;
    const res = await request(buildApp(bridge))
      .post('/workspace/generate')
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_prompt');
    expect(generateWorkspaceContent).not.toHaveBeenCalled();
  });
});
