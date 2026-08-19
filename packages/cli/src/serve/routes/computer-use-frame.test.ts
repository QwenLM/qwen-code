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

function setup(frame: ComputerUseFrame | undefined) {
  const getComputerUseFrame = vi.fn(() => frame);
  const runtime = {
    bridge: { getComputerUseFrame },
    primary: true,
    trusted: true,
    workspaceCwd: '/workspace',
    workspaceId: 'workspace',
  } as unknown as WorkspaceRuntime;
  const workspaceRegistry = {
    listEntries: () => [{ state: 'active' }],
    primaryEntry: { state: 'active', current: { runtime } },
  } as unknown as WorkspaceRegistry;
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
  return { app, getComputerUseFrame, sendBridgeError };
}

describe('GET /session/:id/computer-use/frame', () => {
  it('requires the desktop runtime bearer token', async () => {
    const { app, getComputerUseFrame } = setup(undefined);

    const response = await request(app).get(
      '/session/session-1/computer-use/frame',
    );

    expect(response.status).toBe(401);
    expect(getComputerUseFrame).not.toHaveBeenCalled();
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
      data: 'aW1hZ2U=',
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
      data: 'aW1hZ2U=',
      mimeType: 'image/png',
      version: 7,
    });

    await request(app)
      .get('/session/session-1/computer-use/frame')
      .set('Authorization', 'Bearer secret')
      .set('If-None-Match', '"7"')
      .expect(304);
  });
});
