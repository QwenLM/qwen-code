/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { WorkspaceGenerationClosedError } from '../workspace-registry.js';
import { installFinalErrorHandler } from './error-handlers.js';

describe('installFinalErrorHandler', () => {
  it('returns 500 for an unmarked URIError', async () => {
    const app = express();
    app.get('/error', () => {
      throw new URIError('unmarked');
    });
    installFinalErrorHandler(app);

    const res = await request(app).get('/error');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('returns 400 invalid_request for malformed route parameter encoding', async () => {
    const app = express();
    app.get('/workspaces/:workspace/acp', (_req, res) => res.sendStatus(204));
    installFinalErrorHandler(app);

    const res = await request(app).get('/workspaces/%ZZ/acp');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Malformed URL encoding',
      code: 'invalid_request',
    });
  });

  it('returns a retryable 503 when a workspace generation closes', async () => {
    const app = express();
    app.get('/error', () => {
      throw new WorkspaceGenerationClosedError();
    });
    installFinalErrorHandler(app);

    const res = await request(app).get('/error');

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.body).toEqual({
      error: 'Workspace runtime is not active.',
      code: 'workspace_runtime_unavailable',
    });
  });
});
