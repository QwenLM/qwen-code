/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerWorkspaceDirectoriesRoutes } from './workspace-directories.js';

let scratch: string;
let workspace: string;

beforeEach(async () => {
  // Canonicalize the temp root: macOS `os.tmpdir()` returns `/var/...` while
  // the route resolves entries through `realpath` (`/private/var/...`).
  scratch = await fsp.realpath(
    await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-ws-dirs-')),
  );
  workspace = path.join(scratch, 'ws');
  await fsp.mkdir(workspace);
});

afterEach(async () => {
  await fsp.rm(scratch, { recursive: true, force: true });
});

function makeApp(
  options: {
    trusted?: boolean;
    workspaceCwd?: string;
    invoke?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const invoke = options.invoke ?? vi.fn();
  const workspaceCwd = options.workspaceCwd ?? workspace;
  const runtime = {
    workspaceCwd,
    trusted: options.trusted ?? true,
    bridge: { invokeWorkspaceCommand: invoke },
  };
  const entry = {
    workspaceId: 'ws-1',
    workspaceCwd,
    state: 'active',
    current: { runtime },
    primary: true,
    removable: false,
    internal: false,
  };
  const registry = {
    getEntryByWorkspaceId: (id: string) =>
      id === 'ws-1' || id === workspaceCwd ? entry : undefined,
    getEntryByWorkspaceCwd: (cwd: string) =>
      cwd === workspaceCwd ? entry : undefined,
    listEntries: () => [entry],
  };
  const app = express();
  app.use(express.json());
  registerWorkspaceDirectoriesRoutes(app, {
    workspaceRegistry: registry as never,
    mutate: () => (_req, _res, next) => next(),
  });
  return { app, invoke };
}

async function writeWorkspaceSettings(directories: string[]): Promise<void> {
  await fsp.mkdir(path.join(workspace, '.qwen'), { recursive: true });
  await fsp.writeFile(
    path.join(workspace, '.qwen', 'settings.json'),
    JSON.stringify({ context: { includeDirectories: directories } }),
  );
}

describe('GET /workspaces/:workspace/directories', () => {
  it('lists the workspace-scope extra directories', async () => {
    const extra = path.join(scratch, 'extra');
    await fsp.mkdir(extra);
    await writeWorkspaceSettings([extra]);
    const { app } = makeApp();

    const res = await request(app).get('/workspaces/ws-1/directories');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      v: 1,
      primaryDirectory: workspace,
      directories: [extra],
    });
  });

  it('returns an empty list when the key is absent', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/workspaces/ws-1/directories');
    expect(res.status).toBe(200);
    expect(res.body.directories).toEqual([]);
  });

  it('resolves a relative persisted entry for display', async () => {
    const extra = path.join(scratch, 'extra');
    await fsp.mkdir(extra);
    await writeWorkspaceSettings([path.relative(workspace, extra)]);
    const { app } = makeApp();

    const res = await request(app).get('/workspaces/ws-1/directories');

    expect(res.status).toBe(200);
    expect(res.body.directories).toEqual([extra]);
  });

  it('refuses an untrusted workspace', async () => {
    const { app } = makeApp({ trusted: false });
    const res = await request(app).get('/workspaces/ws-1/directories');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('untrusted_workspace');
  });

  it('refuses an SSH workspace', async () => {
    const { app } = makeApp({ workspaceCwd: 'ssh://host/srv/ws' });
    const res = await request(app).get(
      '/workspaces/ssh%3A%2F%2Fhost%2Fsrv%2Fws/directories',
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('directory_management_unsupported');
  });
});

describe('POST /workspaces/:workspace/directories', () => {
  it('forwards an absolute path to the runtime', async () => {
    const extra = path.join(scratch, 'extra');
    const invoke = vi.fn().mockResolvedValue({
      primaryDirectory: workspace,
      directories: [extra],
      changed: true,
      warnings: [],
    });
    const { app } = makeApp({ invoke });

    const res = await request(app)
      .post('/workspaces/ws-1/directories')
      .send({ path: extra });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ directories: [extra], changed: true });
    expect(invoke).toHaveBeenCalledWith(
      expect.stringContaining('workspace/directories'),
      { action: 'add', path: extra },
    );
  });

  it('rejects a relative path before reaching the runtime', async () => {
    const invoke = vi.fn();
    const { app } = makeApp({ invoke });

    const res = await request(app)
      .post('/workspaces/ws-1/directories')
      .send({ path: 'extra' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_path');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('maps a primary-directory add to 400', async () => {
    const invoke = vi.fn().mockRejectedValue(
      Object.assign(
        new Error(
          'The primary workspace directory is already part of the workspace',
        ),
        {
          code: -32602,
          data: { errorKind: 'primary_directory' },
        },
      ),
    );
    const { app } = makeApp({ invoke });

    const res = await request(app)
      .post('/workspaces/ws-1/directories')
      .send({ path: workspace });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('primary_directory');
  });

  it('maps a missing directory to 404', async () => {
    const invoke = vi.fn().mockRejectedValue(
      Object.assign(new Error('Directory not found'), {
        code: -32002,
        data: { errorKind: 'directory_not_found' },
      }),
    );
    const { app } = makeApp({ invoke });

    const res = await request(app)
      .post('/workspaces/ws-1/directories')
      .send({ path: path.join(scratch, 'missing') });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('directory_not_found');
  });

  it('maps restrictive sandbox to 409', async () => {
    const invoke = vi.fn().mockRejectedValue(
      Object.assign(new Error('Restrictive sandbox mode active'), {
        code: -32003,
        data: { errorKind: 'restrictive_sandbox' },
      }),
    );
    const { app } = makeApp({ invoke });

    const res = await request(app)
      .post('/workspaces/ws-1/directories')
      .send({ path: path.join(scratch, 'extra') });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('restrictive_sandbox');
  });
});

describe('DELETE /workspaces/:workspace/directories', () => {
  it('forwards the remove action with the query path', async () => {
    const extra = path.join(scratch, 'extra');
    const invoke = vi.fn().mockResolvedValue({
      primaryDirectory: workspace,
      directories: [],
      changed: true,
      warnings: [],
    });
    const { app } = makeApp({ invoke });

    const res = await request(app)
      .delete('/workspaces/ws-1/directories')
      .query({ path: extra });

    expect(res.status).toBe(200);
    expect(res.body.directories).toEqual([]);
    expect(invoke).toHaveBeenCalledWith(
      expect.stringContaining('workspace/directories'),
      { action: 'remove', path: extra },
    );
  });

  it('forwards a relative removal path', async () => {
    const invoke = vi.fn().mockResolvedValue({
      primaryDirectory: workspace,
      directories: [],
      changed: true,
      warnings: [],
    });
    const { app } = makeApp({ invoke });

    const res = await request(app)
      .delete('/workspaces/ws-1/directories')
      .query({ path: '../extra' });

    expect(res.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith(
      expect.stringContaining('workspace/directories'),
      { action: 'remove', path: '../extra' },
    );
  });

  it('maps a primary-directory removal to 400', async () => {
    const invoke = vi.fn().mockRejectedValue(
      Object.assign(
        new Error('The primary workspace directory cannot be removed'),
        {
          code: -32602,
          data: { errorKind: 'initial_directory' },
        },
      ),
    );
    const { app } = makeApp({ invoke });

    const res = await request(app)
      .delete('/workspaces/ws-1/directories')
      .query({ path: workspace });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('initial_directory');
  });

  it('rejects a missing query path', async () => {
    const { app } = makeApp();
    const res = await request(app).delete('/workspaces/ws-1/directories');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_path');
  });
});
