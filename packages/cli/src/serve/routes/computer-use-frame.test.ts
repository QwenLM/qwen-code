/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ComputerUseFrame } from '@qwen-code/acp-bridge/bridgeTypes';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import { registerComputerUseFrameRoutes } from './computer-use-frame.js';

function createApp(workspaceRegistry: WorkspaceRegistry) {
  const requireToken: RequestHandler = (req, res, next) => {
    if (req.header('authorization') === 'Bearer secret') next();
    else res.status(401).json({ code: 'token_required' });
  };
  const sendBridgeError = vi.fn((res) => {
    res.status(404).json({ code: 'session_not_found' });
  });
  const app = express();
  registerComputerUseFrameRoutes(app, {
    workspaceRegistry,
    requireToken,
    sendBridgeError,
  });
  return app;
}

function setup(frame: ComputerUseFrame | undefined) {
  const readComputerUseFrame = vi.fn(async () => frame);
  const runtime = {
    bridge: { readComputerUseFrame },
    primary: true,
    trusted: true,
    workspaceCwd: '/workspace',
    workspaceId: 'workspace',
  } as unknown as WorkspaceRuntime;
  const workspaceRegistry = {
    listAllEntries: () => [{ state: 'active' }],
    primaryEntry: { state: 'active', current: { runtime } },
  } as unknown as WorkspaceRegistry;
  const app = createApp(workspaceRegistry);
  return { app, readComputerUseFrame };
}

describe('GET /session/:id/computer-use/frame', () => {
  it('requires the desktop runtime bearer token', async () => {
    const { app, readComputerUseFrame } = setup(undefined);

    const response = await request(app).get(
      '/session/session-1/computer-use/frame',
    );

    expect(response.status).toBe(401);
    expect(readComputerUseFrame).not.toHaveBeenCalled();
  });

  it('returns no content before the first driver frame', async () => {
    const { app } = setup(undefined);

    const response = await request(app)
      .get('/session/session-1/computer-use/frame')
      .set('Authorization', 'Bearer secret');

    expect(response.status).toBe(204);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('serves the raw image with a versioned no-store response', async () => {
    const { app } = setup({
      data: Buffer.from('image'),
      mimeType: 'image/png',
      version: 7,
    });

    const response = await request(app)
      .get('/session/session-1/computer-use/frame')
      .set('Authorization', 'Bearer secret');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^image\/png/);
    expect(response.headers['etag']).toBe('"7"');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.body).toEqual(Buffer.from('image'));
  });

  it('avoids retransmitting an unchanged frame', async () => {
    const { app } = setup({
      data: Buffer.from('image'),
      mimeType: 'image/png',
      version: 7,
    });

    await request(app)
      .get('/session/session-1/computer-use/frame')
      .set('Authorization', 'Bearer secret')
      .set('If-None-Match', '"7"')
      .expect(304);
  });

  it('reads from the live session owner instead of the primary runtime', async () => {
    const primaryRead = vi.fn();
    const ownerRead = vi.fn(async () => undefined);
    const primary = {
      bridge: { readComputerUseFrame: primaryRead },
      primary: true,
      trusted: true,
      workspaceCwd: '/workspace/primary',
      workspaceId: 'primary',
    } as unknown as WorkspaceRuntime;
    const owner = {
      bridge: { readComputerUseFrame: ownerRead },
      primary: false,
      trusted: true,
      workspaceCwd: '/workspace/owner',
      workspaceId: 'owner',
    } as unknown as WorkspaceRuntime;
    const workspaceRegistry = {
      listAllEntries: () => [{ state: 'active' }, { state: 'active' }],
      primaryEntry: { state: 'active', current: { runtime: primary } },
      resolveLiveSessionOwner: () => ({ kind: 'found', runtime: owner }),
    } as unknown as WorkspaceRegistry;

    await request(createApp(workspaceRegistry))
      .get('/session/session-owned/computer-use/frame')
      .set('Authorization', 'Bearer secret')
      .expect(204);

    expect(ownerRead).toHaveBeenCalledWith('session-owned');
    expect(primaryRead).not.toHaveBeenCalled();
  });
});
