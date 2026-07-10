/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { installFinalErrorHandler } from './error-handlers.js';

describe('installFinalErrorHandler', () => {
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
});
