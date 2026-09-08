/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { apiProfileGate } from './api-profile.js';

describe('API profile gate', () => {
  it('leaves full routing unchanged', () => {
    expect(apiProfileGate()).toBeUndefined();
    expect(apiProfileGate('full')).toBeUndefined();
  });

  it('matches Express paths without allowing administrative subroutes', async () => {
    const app = express();
    app.use(apiProfileGate('minimal')!);
    app.post('/session/:id/prompt', (_req, res) => res.sendStatus(204));
    app.post('/workspace/trust', (_req, res) => res.sendStatus(204));
    for (const path of ['/session/abc/prompt', '/Session/abc/Prompt/']) {
      await request(app).post(path).expect(204);
    }
    for (const path of [
      '/workspace/trust',
      '/session/abc/prompt/extra',
      '/file/write',
    ]) {
      const res = await request(app).post(path).expect(403);
      expect(res.body.code).toBe('api_profile_disabled');
    }
  });
});
