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
import {
  InvalidLocalControlTargetError,
  type LocalControlService,
} from '../local-control/service.js';
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

  it('allows tokenless loopback enable through the route listener gate', async () => {
    const app = express();
    const enable = vi.fn(async () => ({ active: true }));
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        enable,
      } as unknown as LocalControlService,
      mutate: (opts) => (_req, res, next) => {
        if (opts?.strict) {
          res.status(401).json({ code: 'token_required' });
          return;
        }
        next();
      },
      safeBody: () => ({}),
    });

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(200);
    expect(response.body.active).toBe(true);
    expect(enable).toHaveBeenCalledOnce();
  });

  it('rejects enable when the Web Shell is unavailable', async () => {
    const app = express();
    const enable = vi.fn();
    registerWorkspaceLocalControlRoutes(app, {
      service: { enable } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
      webShellAvailable: false,
    });

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('local_control_web_shell_unavailable');
    expect(enable).not.toHaveBeenCalled();
  });

  it('maps malformed Local Control targets to input errors', async () => {
    const app = express();
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        enable: vi.fn(async () => {
          throw new InvalidLocalControlTargetError();
        }),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({ target: 'http://%' }),
    });

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid_local_control_target');
  });

  it('keeps serving status when the pairing URL exceeds the QR capacity', async () => {
    // The pairing URL is caller-influenced (`target` deep-links) and can grow
    // past the QR encoder's limit. The QR block is best-effort: the request
    // must stay 200 with the raw URL intact instead of 500ing for as long as
    // Local Control is active (which would wedge the card with no way to
    // disable).
    const oversizedUrl = `http://192.168.1.10:4170/?t=${'a'.repeat(2000)}`;
    const app = express();
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        status: vi.fn(() => ({ active: true, url: oversizedUrl })),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
    });

    const response = await request(app).get('/workspace/local-control');

    expect(response.status).toBe(200);
    expect(response.body.active).toBe(true);
    expect(response.body.url).toBe(oversizedUrl);
    expect(response.body.qrText).toBeUndefined();
  });

  it('renders the QR block for an in-capacity pairing URL', async () => {
    // Happy path must stay covered: the QR block is the primary phone-pairing
    // affordance, and a regression that silently stops assigning `qrText`
    // (encoder upgrade, refactor) should not ship with green tests.
    const url = 'http://192.168.1.10:4170/#token=abc123';
    const app = express();
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        status: vi.fn(() => ({ active: true, url })),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
    });

    const response = await request(app).get('/workspace/local-control');

    expect(response.status).toBe(200);
    expect(typeof response.body.qrText).toBe('string');
    expect(response.body.qrText.length).toBeGreaterThan(0);
  });
});
