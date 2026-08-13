/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { tagListener } from '../local-control/listener-identity.js';
import type { LocalControlService } from '../local-control/service.js';
import { registerWorkspaceLocalControlRoutes } from './workspace-local-control.js';

describe('Local Control routes', () => {
  it('flushes a LAN disable response before closing its connection', async () => {
    const app = express();
    const server = createServer(app);
    const disable = vi.fn(async () => {
      server.closeAllConnections();
      return { active: false };
    });
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        disable,
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as AddressInfo).port;
    tagListener(server, {
      kind: 'local-control',
      authority: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
    });

    try {
      const response = await request(server)
        .post('/workspace/local-control/disable')
        .set('Host', `127.0.0.1:${port}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ active: false });
      expect(disable).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
