/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { AUTHENTICATED_REQUEST } from '../auth.js';
import { tagListener } from '../local-control/listener-identity.js';
import {
  InvalidLocalControlTargetError,
  type LocalControlService,
} from '../local-control/service.js';
import { registerWorkspaceLocalControlRoutes } from './workspace-local-control.js';
import { writeStdoutLineSafe } from '../../utils/stdioHelpers.js';

vi.mock('../../utils/stdioHelpers.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/stdioHelpers.js')>();
  return { ...actual, writeStdoutLineSafe: vi.fn() };
});

/** Marks the request bearer-authenticated the way `bearerAuth` does after
 *  verifying a token — the routes key the pairing-secret redaction on it
 *  (#9106). */
const asAuthenticated: RequestHandler = (req, _res, next) => {
  (req as unknown as Record<symbol, true>)[AUTHENTICATED_REQUEST] = true;
  next();
};

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

  it('rejects runtime enable when the primary bind is not loopback', async () => {
    // The `--local-control` CLI flag refuses non-loopback binds for this
    // reason; the runtime enable route must enforce the same precondition
    // instead of 500ing with EADDRINUSE from the LAN listen.
    const app = express();
    const enable = vi.fn();
    registerWorkspaceLocalControlRoutes(app, {
      service: { enable } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
      primaryBindHostname: '0.0.0.0',
    });

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('local_control_non_loopback_bind');
    expect(enable).not.toHaveBeenCalled();
  });

  it('allows runtime enable on a loopback primary bind', async () => {
    const app = express();
    const enable = vi.fn(async () => ({ active: true }));
    registerWorkspaceLocalControlRoutes(app, {
      service: { enable } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
      primaryBindHostname: '127.0.0.1',
    });

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(200);
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
    app.use(asAuthenticated);
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
    app.use(asAuthenticated);
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
    expect(response.body.urlRedacted).toBeUndefined();
  });

  it('withholds the pairing secret when operator authority is omitted', async () => {
    // Isolated route mounts default trustedLoopbackMode to false. The pairing
    // token (in `url`'s fragment and encoded in `qrText`) must remain redacted
    // unless the mount explicitly supplies trusted authority or middleware
    // verifies a listener credential.
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
    expect(response.body.active).toBe(true);
    expect(response.body.url).toBeUndefined();
    expect(response.body.qrText).toBeUndefined();
    expect(response.body.urlRedacted).toBe(true);
  });

  it('returns the pairing secret to a trusted-loopback primary caller', async () => {
    const url = 'http://192.168.1.10:4170/#token=abc123';
    const app = express();
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        status: vi.fn(() => ({ active: true, url })),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
      trustedLoopbackMode: true,
    });

    const response = await request(app).get('/workspace/local-control');

    expect(response.status).toBe(200);
    expect(response.body.url).toBe(url);
    expect(typeof response.body.qrText).toBe('string');
    expect(response.body.urlRedacted).toBeUndefined();
  });

  it('still returns the full pairing payload to authenticated callers (#9106)', async () => {
    const url = 'http://192.168.1.10:4170/#token=abc123';
    const app = express();
    app.use(asAuthenticated);
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        status: vi.fn(() => ({ active: true, url })),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
    });

    const response = await request(app).get('/workspace/local-control');

    expect(response.status).toBe(200);
    expect(response.body.url).toBe(url);
    expect(response.body.urlRedacted).toBeUndefined();
  });

  it('redacts an unauthenticated enable response and prints the URL to the daemon terminal (#9106)', async () => {
    const url = 'http://192.168.1.10:4170/#token=abc123';
    const app = express();
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        enable: vi.fn(async () => ({ active: true, url })),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
      primaryBindHostname: '127.0.0.1',
    });
    vi.mocked(writeStdoutLineSafe).mockClear();

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(200);
    expect(response.body.active).toBe(true);
    expect(response.body.url).toBeUndefined();
    expect(response.body.qrText).toBeUndefined();
    expect(response.body.urlRedacted).toBe(true);
    // The operator still needs the URL to pair; the daemon terminal is the one
    // channel a local attacker cannot read over HTTP.
    expect(writeStdoutLineSafe).toHaveBeenCalledWith(
      expect.stringContaining(url),
    );
  });

  it('returns a trusted-loopback enable secret without duplicate terminal output', async () => {
    const url = 'http://192.168.1.10:4170/#token=abc123';
    const app = express();
    registerWorkspaceLocalControlRoutes(app, {
      service: {
        enable: vi.fn(async () => ({ active: true, url })),
      } as unknown as LocalControlService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: () => ({}),
      primaryBindHostname: '127.0.0.1',
      trustedLoopbackMode: true,
    });
    vi.mocked(writeStdoutLineSafe).mockClear();

    const response = await request(app).post('/workspace/local-control/enable');

    expect(response.status).toBe(200);
    expect(response.body.url).toBe(url);
    expect(typeof response.body.qrText).toBe('string');
    expect(writeStdoutLineSafe).not.toHaveBeenCalled();
  });
});
