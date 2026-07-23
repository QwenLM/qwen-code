/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
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

  it('rejects an empty prompt before starting the bridge', async () => {
    const bridge = {} as AcpSessionBridge;
    const res = await request(buildApp(bridge))
      .post('/workspace/generate')
      .send({ prompt: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_prompt');
  });
});
