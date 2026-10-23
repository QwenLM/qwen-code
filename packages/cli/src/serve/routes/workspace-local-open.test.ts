/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { clearAutoMemoryRootCache } from '@qwen-code/qwen-code-core/memory/paths.js';
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

type LocalOpenTestRuntime = Pick<
  WorkspaceRuntime,
  | 'workspaceId'
  | 'workspaceCwd'
  | 'sessionRuntimeBaseDir'
  | 'primary'
  | 'trusted'
>;

function makeRuntime(
  overrides: Partial<LocalOpenTestRuntime> = {},
): LocalOpenTestRuntime {
  return {
    workspaceId: 'primary-id',
    workspaceCwd: WS_CWD,
    sessionRuntimeBaseDir: path.join(os.tmpdir(), 'qwen-local-open-runtime'),
    primary: true,
    trusted: true,
    ...overrides,
  };
}

function createMockRegistry(
  runtimes: LocalOpenTestRuntime[],
): WorkspaceRegistry {
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
    runtimes?: LocalOpenTestRuntime[];
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

describe('POST /workspaces/:workspace/open (auto-memory target)', () => {
  let tmp: string;
  let cwd: string;
  let globalBase: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-serve-local-open-'));
    cwd = path.join(tmp, 'workspace');
    globalBase = path.join(tmp, 'global');
    await fs.mkdir(cwd, { recursive: true });
    process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = globalBase;
    clearAutoMemoryRootCache();
  });

  afterEach(async () => {
    delete process.env['QWEN_CODE_MEMORY_LOCAL'];
    delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
    clearAutoMemoryRootCache();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('opens the project auto-memory directory and reports the scope', async () => {
    const projectDir = path.join(cwd, '.qwen', 'memory');
    await fs.mkdir(projectDir, { recursive: true });
    const openPathLocally = vi.fn().mockResolvedValue(undefined);
    const app = createApp({
      runtimes: [makeRuntime({ workspaceCwd: cwd })],
      openPathLocally,
    });

    const res = await request(app)
      .post('/workspaces/primary-id/open')
      .send({ target: 'auto-memory' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      kind: 'workspace-local-open',
      opened: true,
      target: 'auto-memory',
      scope: 'project',
    });
    expect(openPathLocally).toHaveBeenCalledWith(projectDir);
  });

  it('opens the user auto-memory directory for scope=user', async () => {
    const userDir = path.join(globalBase, 'memories');
    await fs.mkdir(userDir, { recursive: true });
    const openPathLocally = vi.fn().mockResolvedValue(undefined);
    const app = createApp({
      runtimes: [makeRuntime({ workspaceCwd: cwd })],
      openPathLocally,
    });

    const res = await request(app)
      .post('/workspaces/primary-id/open')
      .send({ target: 'auto-memory', autoMemoryScope: 'user' });

    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('user');
    expect(openPathLocally).toHaveBeenCalledWith(userDir);
  });

  it('returns 404 when the auto-memory directory does not exist yet', async () => {
    const openPathLocally = vi.fn().mockResolvedValue(undefined);
    const app = createApp({
      runtimes: [makeRuntime({ workspaceCwd: cwd })],
      openPathLocally,
    });

    const res = await request(app)
      .post('/workspaces/primary-id/open')
      .send({ target: 'auto-memory' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('auto_memory_dir_not_found');
    expect(openPathLocally).not.toHaveBeenCalled();
  });

  it('returns 400 when the auto-memory path is not a directory', async () => {
    await fs.mkdir(path.join(cwd, '.qwen'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.qwen', 'memory'), 'not a dir\n');
    const openPathLocally = vi.fn().mockResolvedValue(undefined);
    const app = createApp({
      runtimes: [makeRuntime({ workspaceCwd: cwd })],
      openPathLocally,
    });

    const res = await request(app)
      .post('/workspaces/primary-id/open')
      .send({ target: 'auto-memory' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('auto_memory_dir_not_directory');
    expect(openPathLocally).not.toHaveBeenCalled();
  });

  it('answers 500 stat_failed when the root cannot be stat-ed', async () => {
    const stat = vi.spyOn(fs, 'stat').mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied, stat'), {
        code: 'EACCES',
      }),
    );

    const openPathLocally = vi.fn().mockResolvedValue(undefined);
    const app = createApp({
      runtimes: [makeRuntime({ workspaceCwd: cwd })],
      openPathLocally,
    });

    const res = await request(app)
      .post('/workspaces/primary-id/open')
      .send({ target: 'auto-memory' });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('auto_memory_dir_stat_failed');
    expect(res.body.scope).toBe('project');
    expect(res.body.errno).toBe('EACCES');
    expect(openPathLocally).not.toHaveBeenCalled();
    stat.mockRestore();
  });

  it('resolves the user root under the runtime session base dir, not the ambient one', async () => {
    // The memory-base env must stay unset: it pre-empts the runtime
    // storage context and would mask the very resolution under test.
    delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
    clearAutoMemoryRootCache();
    const runtimeBase = path.join(tmp, 'runtime-base');
    const runtimeMemories = path.join(runtimeBase, 'memories');
    await fs.mkdir(runtimeMemories, { recursive: true });
    const openPathLocally = vi.fn().mockResolvedValue(undefined);
    const app = createApp({
      runtimes: [
        makeRuntime({
          workspaceCwd: cwd,
          sessionRuntimeBaseDir: runtimeBase,
        }),
      ],
      openPathLocally,
    });

    const res = await request(app)
      .post('/workspaces/primary-id/open')
      .send({ target: 'auto-memory', autoMemoryScope: 'user' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      kind: 'workspace-local-open',
      opened: true,
      target: 'auto-memory',
      scope: 'user',
    });
    expect(openPathLocally).toHaveBeenCalledWith(runtimeMemories);
  });
});
