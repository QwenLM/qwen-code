/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  SettingScope,
  resetHomeEnvBootstrapForTesting,
} from '../../config/settings.js';
import { registerWorkspaceQualifiedVoiceRoutes } from './workspace-voice.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';

const homes: string[] = [];

function runtime(
  workspaceId: string,
  workspaceCwd: string,
  opts: { primary?: boolean; trusted?: boolean } = {},
): WorkspaceRuntime {
  return {
    workspaceId,
    workspaceCwd,
    primary: opts.primary === true,
    trusted: opts.trusted !== false,
    env: { mode: 'runtime-overlay', overlayKeys: [], effectiveEnv: {} },
    bridge: { publishWorkspaceEvent: vi.fn() },
  } as unknown as WorkspaceRuntime;
}

async function createApp(): Promise<{
  app: express.Application;
  secondary: WorkspaceRuntime;
  untrusted: WorkspaceRuntime;
  persistSetting: ReturnType<typeof vi.fn>;
}> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-voice-home-'));
  homes.push(home);
  const primaryCwd = path.join(home, 'primary');
  const secondaryCwd = path.join(home, 'secondary');
  const untrustedCwd = path.join(home, 'untrusted');
  await Promise.all(
    [primaryCwd, secondaryCwd, untrustedCwd].map((cwd) =>
      fsp.mkdir(cwd, { recursive: true }),
    ),
  );
  process.env['QWEN_HOME'] = home;
  resetHomeEnvBootstrapForTesting();

  const secondary = runtime('secondary-id', secondaryCwd);
  const untrusted = runtime('untrusted-id', untrustedCwd, { trusted: false });
  const registry = createWorkspaceRegistry([
    runtime('primary-id', primaryCwd, { primary: true }),
    secondary,
    untrusted,
  ]);
  const persistSetting = vi.fn(async () => undefined);
  const app = express();
  app.use(express.json());
  registerWorkspaceQualifiedVoiceRoutes(app, {
    workspaceRegistry: registry,
    mutate: () => (_req, _res, next) => next(),
    safeBody: (req) => req.body as Record<string, unknown>,
    persistSetting,
    acquireVoiceLease: () => ({
      kind: 'admitted',
      lease: { signal: new AbortController().signal, release: () => {} },
    }),
    parseAndValidateClientId: () => undefined,
    invalidateServeFeaturesCache: vi.fn(),
  });
  return { app, secondary, untrusted, persistSetting };
}

describe('workspace-qualified Voice routes', () => {
  const originalQwenHome = process.env['QWEN_HOME'];

  afterEach(async () => {
    await Promise.all(
      homes
        .splice(0)
        .map((home) => fsp.rm(home, { recursive: true, force: true })),
    );
    if (originalQwenHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = originalQwenHome;
    resetHomeEnvBootstrapForTesting();
  });

  it('selects only the trusted target runtime and writes Voice settings in workspace scope', async () => {
    const { app, secondary, persistSetting } = await createApp();

    await expect(
      request(app).get('/workspaces/secondary-id/voice'),
    ).resolves.toMatchObject({
      status: 200,
      body: { workspaceCwd: secondary.workspaceCwd },
    });
    await expect(
      request(app)
        .post('/workspaces/secondary-id/voice')
        .send({ enabled: false }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      request(app).get(
        `/workspaces/${encodeURIComponent(secondary.workspaceCwd)}/voice`,
      ),
    ).resolves.toMatchObject({
      status: 200,
      body: { workspaceCwd: secondary.workspaceCwd },
    });

    expect(persistSetting).toHaveBeenCalledWith(
      secondary.workspaceCwd,
      SettingScope.Workspace,
      'general.voice.enabled',
      false,
    );
    expect(
      secondary.bridge.publishWorkspaceEvent as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalled();
  });

  it('rejects an unknown selector before reading settings and untrusted targets without fallback', async () => {
    const { app } = await createApp();

    await expect(
      request(app).get('/workspaces/missing/voice'),
    ).resolves.toMatchObject({
      status: 400,
      body: { code: 'workspace_mismatch' },
    });
    await expect(
      request(app).get('/workspaces/untrusted-id/voice'),
    ).resolves.toMatchObject({
      status: 403,
      body: { code: 'untrusted_workspace' },
    });
  });
});
