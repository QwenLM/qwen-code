/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { registerWorkspaceLocalOpenRoutes } from './workspace-local-open.js';
import { LocalPathOpenUnavailableError } from '../local-path-open.js';
import type {
  WorkspaceEntry,
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStderrLine: vi.fn(),
}));

const WS_CWD = '/workspace/primary';

function makeRuntime(
  overrides: Partial<WorkspaceRuntime> = {},
): WorkspaceRuntime {
  return {
    workspaceId: 'primary-id',
    workspaceCwd: WS_CWD,
    primary: true,
    trusted: true,
    ...overrides,
  } as WorkspaceRuntime;
}

function createMockRegistry(runtimes: WorkspaceRuntime[]): WorkspaceRegistry {
  const entries = runtimes.map(
    (runtime) =>
      ({
        workspaceId: runtime.workspaceId,
        workspaceCwd: runtime.workspaceCwd,
        state: 'active',
        current: { runtime },
      }) as unknown as WorkspaceEntry,
  );
  return {
    getEntryByWorkspaceId: (id: string) =>
      entries.find((entry) => entry.workspaceId === id),
    getEntryByWorkspaceCwd: (cwd: string) =>
      entries.find((entry) => entry.workspaceCwd === cwd),
    listEntries: () => entries,
  } as unknown as WorkspaceRegistry;
}

function createApp(
  deps: {
    runtimes?: WorkspaceRuntime[];
    mutate?: (opts?: { strict?: boolean }) => RequestHandler;
    openPathLocally?: (path: string) => Promise<void>;
    openTerminalLocally?: (path: string) => Promise<void>;
  } = {},
) {
  const app = express();
  app.use(express.json());
  registerWorkspaceLocalOpenRoutes(app, {
    workspaceRegistry: createMockRegistry(deps.runtimes ?? [makeRuntime()]),
    mutate:
      deps.mutate ??
      (() => (_req, _res, next) => {
        next();
      }),
    ...(deps.openPathLocally ? { openPathLocally: deps.openPathLocally } : {}),
    ...(deps.openTerminalLocally
      ? { openTerminalLocally: deps.openTerminalLocally }
      : {}),
  });
  return app;
}

describe('POST /workspaces/:workspace/open', () => {
  it('opens the resolved workspace cwd and reports opened=true', async () => {
    const openPathLocally = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ openPathLocally });

    const res = await request(app).post('/workspaces/primary-id/open');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      kind: 'workspace-local-open',
      opened: true,
      target: 'folder',
    });
    expect(openPathLocally).toHaveBeenCalledWith(WS_CWD);
  });

  it('resolves the workspace by absolute cwd too', async () => {
    const openPathLocally = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ openPathLocally });

    const res = await request(app).post(
      `/workspaces/${encodeURIComponent(WS_CWD)}/open`,
    );

    expect(res.status).toBe(200);
    expect(openPathLocally).toHaveBeenCalledWith(WS_CWD);
  });

  it('returns 501 when the host cannot open a GUI', async () => {
    const app = createApp({
      openPathLocally: vi
        .fn()
        .mockRejectedValue(new LocalPathOpenUnavailableError('no display')),
    });

    const res = await request(app).post('/workspaces/primary-id/open');

    expect(res.status).toBe(501);
    expect(res.body).toEqual({
      error: 'Local path open is unavailable',
      code: 'local_path_open_unavailable',
    });
    expect(writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('local path open unavailable: no display'),
    );
  });

  it('returns 500 when the handoff fails unexpectedly', async () => {
    const app = createApp({
      openPathLocally: vi.fn().mockRejectedValue(new Error('boom')),
    });

    const res = await request(app).post('/workspaces/primary-id/open');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('local_path_open_failed');
    expect(writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('local path open failed: boom'),
    );
  });

  it('rejects an unknown workspace with workspace_mismatch', async () => {
    const openPathLocally = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ openPathLocally });

    const res = await request(app).post('/workspaces/unknown-id/open');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('workspace_mismatch');
    expect(openPathLocally).not.toHaveBeenCalled();
  });

  it('rejects an untrusted workspace without opening anything', async () => {
    const openPathLocally = vi.fn().mockResolvedValue(undefined);
    const app = createApp({
      runtimes: [makeRuntime({ trusted: false })],
      openPathLocally,
    });

    const res = await request(app).post('/workspaces/primary-id/open');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('untrusted_workspace');
    expect(openPathLocally).not.toHaveBeenCalled();
  });

  it('applies the mutate middleware', async () => {
    const openPathLocally = vi.fn().mockResolvedValue(undefined);
    const app = createApp({
      openPathLocally,
      mutate: () => (_req, res) => {
        res.status(401).json({ code: 'token_required' });
      },
    });

    const res = await request(app).post('/workspaces/primary-id/open');

    expect(res.status).toBe(401);
    expect(openPathLocally).not.toHaveBeenCalled();
  });

  it('dispatches target=terminal to the terminal handoff', async () => {
    const openPathLocally = vi.fn().mockResolvedValue(undefined);
    const openTerminalLocally = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ openPathLocally, openTerminalLocally });

    const res = await request(app)
      .post('/workspaces/primary-id/open')
      .send({ target: 'terminal' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      kind: 'workspace-local-open',
      opened: true,
      target: 'terminal',
    });
    expect(openTerminalLocally).toHaveBeenCalledWith(WS_CWD);
    expect(openPathLocally).not.toHaveBeenCalled();
  });

  it('treats an absent or unrecognized target as folder', async () => {
    const openPathLocally = vi.fn().mockResolvedValue(undefined);
    const openTerminalLocally = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ openPathLocally, openTerminalLocally });

    const empty = await request(app)
      .post('/workspaces/primary-id/open')
      .send({});
    const other = await request(app)
      .post('/workspaces/primary-id/open')
      .send({ target: 'files' });

    expect(empty.body.target).toBe('folder');
    expect(other.body.target).toBe('folder');
    expect(openPathLocally).toHaveBeenCalledTimes(2);
    expect(openTerminalLocally).not.toHaveBeenCalled();
  });

  it('returns 501 when the host cannot open a terminal', async () => {
    const app = createApp({
      openTerminalLocally: vi
        .fn()
        .mockRejectedValue(
          new LocalPathOpenUnavailableError('no terminal emulator'),
        ),
    });

    const res = await request(app)
      .post('/workspaces/primary-id/open')
      .send({ target: 'terminal' });

    expect(res.status).toBe(501);
    expect(res.body).toEqual({
      error: 'Local path open is unavailable',
      code: 'local_path_open_unavailable',
    });
    expect(writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'local path open unavailable: no terminal emulator',
      ),
    );
  });

  it('returns 500 when the terminal handoff fails unexpectedly', async () => {
    const app = createApp({
      openTerminalLocally: vi.fn().mockRejectedValue(new Error('boom')),
    });

    const res = await request(app)
      .post('/workspaces/primary-id/open')
      .send({ target: 'terminal' });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('local_path_open_failed');
  });
});
