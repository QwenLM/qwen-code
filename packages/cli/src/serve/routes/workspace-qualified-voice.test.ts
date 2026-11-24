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
import { QwenSubscriptionSession } from '@qwen-code/qwen-code-core/qwen/subscription-session.js';
import {
  SettingScope,
  resetHomeEnvBootstrapForTesting,
} from '../../config/settings.js';
import { registerWorkspaceQualifiedVoiceRoutes } from './workspace-voice.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  WorkspaceVoiceCoordinator,
  type VoiceAdmissionResult,
} from '../voice/workspace-voice-coordinator.js';

const homes: string[] = [];

function runtime(
  workspaceId: string,
  workspaceCwd: string,
  opts: {
    primary?: boolean;
    trusted?: boolean;
    envMode?: 'parent-process' | 'runtime-overlay';
    effectiveEnv?: Readonly<Record<string, string | undefined>>;
    provenance?: 'live-conversation';
  } = {},
): WorkspaceRuntime {
  return {
    workspaceId,
    workspaceCwd,
    primary: opts.primary === true,
    trusted: opts.trusted !== false,
    env:
      opts.envMode === 'parent-process'
        ? { mode: 'parent-process', overlayKeys: [] }
        : {
            mode: 'runtime-overlay',
            overlayKeys: [],
            effectiveEnv: opts.effectiveEnv ?? {},
          },
    bridge: { publishWorkspaceEvent: vi.fn() },
    ...(opts.provenance ? { provenance: opts.provenance } : {}),
  } as unknown as WorkspaceRuntime;
}

async function createApp(
  opts: {
    acquireVoiceLease?: (runtime: WorkspaceRuntime) => VoiceAdmissionResult;
    transcribe?: ReturnType<typeof vi.fn>;
    secondaryEnvMode?: 'parent-process' | 'runtime-overlay';
  } = {},
): Promise<{
  app: express.Application;
  secondary: WorkspaceRuntime;
  untrusted: WorkspaceRuntime;
  registry: ReturnType<typeof createWorkspaceRegistry>;
  persistSetting: ReturnType<typeof vi.fn>;
  acquireVoiceLease: ReturnType<typeof vi.fn>;
  transcribe: ReturnType<typeof vi.fn>;
  invalidateServeFeaturesCache: ReturnType<typeof vi.fn>;
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

  const primary = runtime('primary-id', primaryCwd, { primary: true });
  const secondary = runtime('secondary-id', secondaryCwd, {
    envMode: opts.secondaryEnvMode,
    effectiveEnv: { SECONDARY_VOICE_KEY: 'secondary-secret' },
  });
  const untrusted = runtime('untrusted-id', untrustedCwd, { trusted: false });
  const registry = createWorkspaceRegistry([primary, secondary, untrusted]);
  const persistSetting = vi.fn(async () => undefined);
  const acquireVoiceLease = vi.fn(
    opts.acquireVoiceLease ??
      (() => ({
        kind: 'admitted' as const,
        lease: { signal: new AbortController().signal, release: () => {} },
      })),
  );
  const transcribe =
    opts.transcribe ??
    vi.fn(async () => ({
      text: 'secondary transcript',
      model: 'secondary-asr',
      transport: 'qwen-asr-chat' as const,
    }));
  const invalidateServeFeaturesCache = vi.fn();
  const app = express();
  app.use(express.json());
  registerWorkspaceQualifiedVoiceRoutes(app, {
    workspaceRegistry: registry,
    mutate: () => (_req, _res, next) => next(),
    safeBody: (req) => req.body as Record<string, unknown>,
    persistSetting,
    acquireVoiceLease: (target) => acquireVoiceLease(target),
    transcribe,
    parseAndValidateClientId: () => undefined,
    invalidateServeFeaturesCache,
  });
  return {
    app,
    secondary,
    untrusted,
    registry,
    persistSetting,
    acquireVoiceLease,
    transcribe,
    invalidateServeFeaturesCache,
  };
}

async function enableSecondaryVoice(runtime: WorkspaceRuntime): Promise<void> {
  await fsp.mkdir(path.join(runtime.workspaceCwd, '.qwen'), {
    recursive: true,
  });
  await fsp.writeFile(
    path.join(runtime.workspaceCwd, '.qwen', 'settings.json'),
    JSON.stringify({
      voiceModel: 'secondary-asr',
      general: { voice: { enabled: true } },
    }),
    'utf8',
  );
}

describe('workspace-qualified Voice routes', () => {
  const originalQwenHome = process.env['QWEN_HOME'];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      homes
        .splice(0)
        .map((home) => fsp.rm(home, { recursive: true, force: true })),
    );
    if (originalQwenHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = originalQwenHome;
    resetHomeEnvBootstrapForTesting();
  });

  it.each(['failure', 'success'] as const)(
    'keeps the newest runtime voice directory after an older %s',
    async (outcome) => {
      const { app } = await createApp();
      vi.spyOn(
        QwenSubscriptionSession.prototype,
        'getIdentity',
      ).mockReturnValue('account');
      type Result = Awaited<ReturnType<QwenSubscriptionSession['getScenes']>>;
      let resolveOld!: (result: Result) => void;
      let rejectOld!: (error: Error) => void;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const pending = new Promise<Result>((resolve, reject) => {
        resolveOld = resolve;
        rejectOld = reject;
      });
      vi.spyOn(QwenSubscriptionSession.prototype, 'getScenes')
        .mockImplementationOnce(() => {
          markStarted();
          return pending;
        })
        .mockResolvedValueOnce({
          scenes: { voice: [{ id: 'new-asr' }] },
          cached: false,
        });
      const get = (query = '') =>
        request(app).get(`/workspaces/secondary-id/voice${query}`);
      const old = get('?refreshModels=true').then((response) => response);
      await started;
      const latest = await get('?refreshModels=true');
      expect(latest.status).toBe(200);
      if (outcome === 'failure') rejectOld(new Error('older failed'));
      else
        resolveOld({ scenes: { voice: [{ id: 'stale-asr' }] }, cached: false });
      await old;
      expect((await get()).body.availableVoiceModels).toEqual([
        expect.objectContaining({ id: 'qwen-subscription:new-asr' }),
      ]);
    },
  );

  it('refreshes only the selected runtime picker and never falls back for invalid targets', async () => {
    const { app, secondary, registry } = await createApp();
    vi.spyOn(QwenSubscriptionSession.prototype, 'getIdentity').mockReturnValue(
      'account-a',
    );
    const refresh = vi
      .spyOn(QwenSubscriptionSession.prototype, 'getScenes')
      .mockResolvedValue({ scenes: {}, cached: false });
    await request(app).get('/workspaces/secondary-id/voice');
    expect(refresh).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i++) {
      const response = await request(app).get(
        '/workspaces/secondary-id/voice?refreshModels=true',
      );
      expect(response.status).toBe(200);
      expect(response.body.workspaceCwd).toBe(secondary.workspaceCwd);
    }
    expect(refresh).toHaveBeenCalledTimes(2);
    for (const target of ['missing', 'untrusted-id']) {
      const response = await request(app).get(
        `/workspaces/${target}/voice?refreshModels=true`,
      );
      expect(response.status).toBe(target === 'missing' ? 400 : 403);
    }
    registry.beginDrain(secondary);
    const draining = await request(app).get(
      '/workspaces/secondary-id/voice?refreshModels=true',
    );
    expect(draining.status).toBe(503);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('keeps discovered voice models in their runtime and drops them after an account change', async () => {
    const { app } = await createApp();
    const identity = vi
      .spyOn(QwenSubscriptionSession.prototype, 'getIdentity')
      .mockReturnValue('account-a');
    const refresh = vi
      .spyOn(QwenSubscriptionSession.prototype, 'getScenes')
      .mockResolvedValue({
        scenes: { voice: [{ id: 'secondary-account-asr' }] },
        cached: false,
      });
    const discovered = await request(app).get(
      '/workspaces/secondary-id/voice?refreshModels=true',
    );
    expect(discovered.body.availableVoiceModels).toEqual([
      expect.objectContaining({
        id: 'qwen-subscription:secondary-account-asr',
      }),
    ]);
    expect(
      (await request(app).get('/workspaces/primary-id/voice')).body
        .availableVoiceModels,
    ).toEqual([]);
    expect(
      (await request(app).get('/workspaces/secondary-id/voice')).body
        .availableVoiceModels,
    ).toHaveLength(1);
    identity.mockReturnValue('account-b');
    expect(
      (await request(app).get('/workspaces/secondary-id/voice')).body
        .availableVoiceModels,
    ).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('selects only the trusted target runtime and writes Voice settings in workspace scope', async () => {
    const { app, secondary, persistSetting, invalidateServeFeaturesCache } =
      await createApp();

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
    expect(invalidateServeFeaturesCache).not.toHaveBeenCalled();
  });

  it('invalidates the primary-derived feature cache for primary Voice updates', async () => {
    const { app, invalidateServeFeaturesCache } = await createApp();

    await expect(
      request(app)
        .post('/workspaces/primary-id/voice')
        .send({ enabled: false }),
    ).resolves.toMatchObject({ status: 200 });

    expect(invalidateServeFeaturesCache).toHaveBeenCalledOnce();
  });

  it('rejects an unknown selector before reading settings and untrusted targets without fallback', async () => {
    const { app, acquireVoiceLease } = await createApp();

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
    expect(acquireVoiceLease).not.toHaveBeenCalled();
  });

  it('rejects the internal runtime by id and cwd without falling back', async () => {
    const { app, registry, acquireVoiceLease, transcribe } = await createApp();
    const liveCwd = path.join(homes.at(-1)!, 'conversations');
    await fsp.mkdir(liveCwd, { recursive: true });
    registry.add(
      runtime('live-id', liveCwd, { provenance: 'live-conversation' }),
    );

    for (const selector of ['live-id', encodeURIComponent(liveCwd)]) {
      await expect(
        request(app).get(`/workspaces/${selector}/voice`),
      ).resolves.toMatchObject({
        status: 400,
        body: { code: 'workspace_mismatch' },
      });
    }
    expect(acquireVoiceLease).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('transcribes with the selected runtime cwd and effective environment', async () => {
    const { app, secondary, transcribe } = await createApp();
    await enableSecondaryVoice(secondary);

    const response = await request(app)
      .post('/workspaces/secondary-id/voice/transcribe')
      .set('Content-Type', 'audio/wav')
      .send(Buffer.from([1, 2, 3]));

    expect(response.status).toBe(200);
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceCwd: secondary.workspaceCwd,
        env: secondary.env.effectiveEnv,
        voiceModel: 'secondary-asr',
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });

  it('inherits the parent process environment for parent-process runtimes', async () => {
    const { app, secondary, transcribe } = await createApp({
      secondaryEnvMode: 'parent-process',
    });
    await enableSecondaryVoice(secondary);

    const response = await request(app)
      .post('/workspaces/secondary-id/voice/transcribe')
      .set('Content-Type', 'audio/wav')
      .send(Buffer.from([1, 2, 3]));

    expect(response.status).toBe(200);
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ env: undefined }),
    );
  });

  it('rejects capacity before reading the audio body', async () => {
    const { app, secondary, transcribe, acquireVoiceLease } = await createApp({
      acquireVoiceLease: () => ({ kind: 'rejected', reason: 'capacity' }),
    });
    await enableSecondaryVoice(secondary);

    const response = await request(app)
      .post('/workspaces/secondary-id/voice/transcribe')
      .set('Content-Type', 'audio/wav')
      .send(Buffer.from([1, 2, 3]));

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.body.code).toBe('voice_capacity_exceeded');
    expect(acquireVoiceLease).toHaveBeenCalledOnce();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('reports workspace draining after the registry drain gate closes', async () => {
    const coordinator = new WorkspaceVoiceCoordinator();
    const { app, secondary, registry, transcribe, acquireVoiceLease } =
      await createApp({
        acquireVoiceLease: (runtime) => coordinator.acquire(runtime),
      });
    await enableSecondaryVoice(secondary);
    expect(registry.beginDrain(secondary)).toBe(true);
    coordinator.beginWorkspaceDrain(secondary);

    const response = await request(app)
      .post('/workspaces/secondary-id/voice/transcribe')
      .set('Content-Type', 'audio/wav')
      .send(Buffer.from([1, 2, 3]));

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.body.code).toBe('workspace_draining');
    expect(acquireVoiceLease).toHaveBeenCalledOnce();
    expect(transcribe).not.toHaveBeenCalled();
  });
});
