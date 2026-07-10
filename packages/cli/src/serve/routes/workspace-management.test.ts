/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  registerWorkspaceManagementRoutes,
  type WorkspaceManagementRouteDeps,
} from './workspace-management.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStderrLine: vi.fn(),
}));

// Use the canonical tmpdir so the test path matches what
// realpathSync.native resolves (e.g. /tmp → /private/tmp on macOS).
const REAL_DIR = realpathSync.native(tmpdir());
function createMockRegistry(
  runtimes: WorkspaceRuntime[] = [],
): WorkspaceRegistry {
  const byCwd = new Map(runtimes.map((r) => [r.workspaceCwd, r]));
  return {
    primary: runtimes[0]!,
    list: () => Object.freeze([...runtimes]) as readonly WorkspaceRuntime[],
    getByWorkspaceCwd: (cwd) => byCwd.get(cwd),
    getByWorkspaceId: () => undefined,
    resolveWorkspaceCwd: () => undefined,
    resolveLiveSessionOwner: () => ({ kind: 'not_found' }),
    add: vi.fn(),
  } as unknown as WorkspaceRegistry;
}

function makeRuntime(cwd: string): WorkspaceRuntime {
  return {
    workspaceId: `id-${cwd}`,
    workspaceCwd: cwd,
    primary: false,
    trusted: true,
  } as unknown as WorkspaceRuntime;
}

function createApp(overrides?: Partial<WorkspaceManagementRouteDeps>) {
  const app = express();
  app.use(express.json());
  const deps: WorkspaceManagementRouteDeps = {
    workspaceRegistry: createMockRegistry([makeRuntime(REAL_DIR)]),
    mutate: () => (_req, _res, next) => next(),
    safeBody: (req) => (req.body ?? {}) as Record<string, unknown>,
    createWorkspaceRuntime: vi
      .fn()
      .mockImplementation((cwd: string) => Promise.resolve(makeRuntime(cwd))),
    ...overrides,
  };
  registerWorkspaceManagementRoutes(app, deps);
  return { app, deps };
}

describe('POST /workspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 501 when createWorkspaceRuntime is not provided', async () => {
    const { app } = createApp({ createWorkspaceRuntime: undefined });
    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: '/some/path' });
    expect(res.status).toBe(501);
    expect(res.body.code).toBe('not_implemented');
  });

  it('returns 400 for missing cwd', async () => {
    const { app } = createApp();
    const res = await request(app).post('/workspaces').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_path');
  });

  it('returns 400 for empty cwd', async () => {
    const { app } = createApp();
    const res = await request(app).post('/workspaces').send({ cwd: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_path');
  });

  it('returns 400 for relative path', async () => {
    const { app } = createApp();
    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: 'relative/path' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_path');
  });

  it('returns 400 for path exceeding max length', async () => {
    const { app } = createApp();
    const longPath = '/' + 'a'.repeat(5000);
    const res = await request(app).post('/workspaces').send({ cwd: longPath });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_path');
  });

  it('returns 400 when path does not exist', async () => {
    const { app } = createApp();
    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: '/nonexistent_path_abc123xyz' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_path');
  });

  it('returns 409 for duplicate workspace (same canonical path)', async () => {
    // Registry already has REAL_DIR; posting it again should 409.
    const { app } = createApp();
    const res = await request(app).post('/workspaces').send({ cwd: REAL_DIR });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('workspace_exists');
  });

  it('returns 201 on successful registration', async () => {
    // Use /tmp (exists, is a dir) but ensure it's NOT in the registry.
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([makeRuntime('/some-other-dir')]),
    });
    const res = await request(app).post('/workspaces').send({ cwd: REAL_DIR });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.any(String),
      cwd: expect.any(String),
      primary: false,
      trusted: true,
    });
  });

  it('does not echo resolved paths in 409 error messages', async () => {
    const { app } = createApp();
    const res = await request(app).post('/workspaces').send({ cwd: REAL_DIR });
    // Generic error message — does not reveal canonical/internal paths.
    expect(res.body.error).toBe('Workspace already registered');
  });
});
