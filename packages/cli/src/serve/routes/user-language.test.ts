/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerUserLanguageRoutes } from './user-language.js';
import { loadSettings, SettingScope } from '../../config/settings.js';
import { SessionNotFoundError } from '../acp-session-bridge.js';
import { WorkspaceGenerationClosedError } from '../workspace-registry.js';
import { setLanguageAsync, getCurrentLanguage } from '../../i18n/index.js';
import { updateOutputLanguageFile } from '../../i18n/languageUtils.js';

vi.mock('../../i18n/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../i18n/index.js')>();
  return {
    ...actual,
    setLanguageAsync: vi.fn(async () => undefined),
    getCurrentLanguage: vi.fn(() => 'zh'),
  };
});

vi.mock('../../i18n/languageUtils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../i18n/languageUtils.js')>();
  return {
    ...actual,
    resolveOutputLanguageOrPreserveAuto: vi.fn((value: string) =>
      value === 'zh' ? 'Chinese' : value,
    ),
    updateOutputLanguageFile: vi.fn(),
  };
});

const LANGUAGE_CODES = ['en', 'zh', 'auto'];

vi.mock('../../config/settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../config/settings.js')>();
  return {
    ...actual,
    loadSettings: vi.fn(() => ({ merged: { general: {} } })),
  };
});

function makeRuntime(overrides: {
  trusted: boolean;
  cwd: string;
  setUserLanguage?: (params: {
    language: string;
    syncOutputLanguage: boolean;
  }) => Promise<{ language: string; sessions: number; failed: number }>;
}) {
  return {
    trusted: overrides.trusted,
    workspaceCwd: overrides.cwd,
    generationGuard: { assertOpen: vi.fn() },
    bridge: {
      knownClientIds: vi.fn(() => new Set<string>()),
      setUserLanguage: vi.fn(
        overrides.setUserLanguage ??
          (async (params: { language: string }) => ({
            language: params.language,
            sessions: 0,
            failed: 0,
          })),
      ),
      publishWorkspaceEvent: vi.fn(),
    },
  };
}

function makeApp(
  overrides: {
    runtimes?: Array<ReturnType<typeof makeRuntime>>;
    persistSetting?: ReturnType<typeof vi.fn>;
    entryState?:
      | 'active'
      | 'draining'
      | 'transitioning'
      | 'blocked'
      | 'removed';
    parseAndValidateClientId?: (
      req: express.Request,
      res: express.Response,
    ) => string | undefined | null;
  } = {},
) {
  const app = express();
  app.use(express.json());

  const persistSetting =
    overrides.persistSetting ?? vi.fn(async () => undefined);
  const runtimes = overrides.runtimes ?? [];

  registerUserLanguageRoutes(app, {
    boundWorkspace: '/workspace',
    mutate: () => (_req, _res, next) => next(),
    safeBody: (req) =>
      req.body && typeof req.body === 'object' ? req.body : {},
    languageCodes: LANGUAGE_CODES,
    persistSetting,
    workspaceRegistry: {
      list: () => runtimes,
      getEntryByWorkspaceId: (id: string) => {
        const runtime = runtimes.find((r) => r.workspaceCwd === `/${id}`);
        return runtime
          ? { state: overrides.entryState ?? 'active', current: { runtime } }
          : undefined;
      },
    } as never,
    parseAndValidateClientId:
      overrides.parseAndValidateClientId ?? (() => undefined),
  });

  return { app, persistSetting, runtimes };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockReturnValue({
    merged: { general: {} },
  } as ReturnType<typeof loadSettings>);
  vi.mocked(setLanguageAsync).mockReset().mockResolvedValue(undefined);
  vi.mocked(getCurrentLanguage).mockReturnValue('zh');
});

describe('POST /language', () => {
  it.each(['draining', 'transitioning', 'blocked', 'removed'] as const)(
    'rejects a %s workspace without side effects',
    async (entryState) => {
      const runtime = makeRuntime({ trusted: true, cwd: '/secondary' });
      const { app, persistSetting } = makeApp({
        runtimes: [runtime],
        entryState,
      });
      const res = await request(app)
        .post('/workspaces/secondary/language')
        .send({ language: 'zh' });
      expect(res.status).toBe(503);
      expect(persistSetting).not.toHaveBeenCalled();
      expect(runtime.bridge.setUserLanguage).not.toHaveBeenCalled();
    },
  );

  it('rejects a closed runtime generation before writing settings', async () => {
    const runtime = makeRuntime({ trusted: true, cwd: '/secondary' });
    runtime.generationGuard.assertOpen.mockImplementation(() => {
      throw new WorkspaceGenerationClosedError();
    });
    const { app, persistSetting } = makeApp({ runtimes: [runtime] });
    const res = await request(app)
      .post('/workspaces/secondary/language')
      .send({ language: 'zh' });
    expect(res.status).toBe(503);
    expect(persistSetting).not.toHaveBeenCalled();
    expect(runtime.bridge.setUserLanguage).not.toHaveBeenCalled();
  });

  it('does not sync a replaced generation after persistence', async () => {
    const runtime = makeRuntime({ trusted: true, cwd: '/secondary' });
    const persistSetting = vi.fn(async () => {
      runtime.generationGuard.assertOpen.mockImplementation(() => {
        throw new WorkspaceGenerationClosedError();
      });
    });
    const { app } = makeApp({ runtimes: [runtime], persistSetting });
    expect(
      (
        await request(app)
          .post('/workspaces/secondary/language')
          .send({ language: 'zh' })
      ).status,
    ).toBe(503);
    expect(runtime.bridge.setUserLanguage).not.toHaveBeenCalled();
    expect(runtime.bridge.publishWorkspaceEvent).not.toHaveBeenCalled();
  });

  it('validates client ownership against the selected workspace', async () => {
    const runtime = makeRuntime({ trusted: true, cwd: '/secondary' });
    const { app, persistSetting } = makeApp({ runtimes: [runtime] });
    const res = await request(app)
      .post('/workspaces/secondary/language')
      .set('x-qwen-client-id', 'foreign-client')
      .send({ language: 'zh' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_client_id');
    expect(persistSetting).not.toHaveBeenCalled();
  });

  it('uses the effective workspace locale after a higher-priority override', async () => {
    vi.mocked(loadSettings).mockReturnValue({
      merged: { general: { language: 'en' } },
    } as ReturnType<typeof loadSettings>);
    const runtime = makeRuntime({ trusted: true, cwd: '/secondary' });
    const { app } = makeApp({ runtimes: [runtime] });
    const res = await request(app)
      .post('/workspaces/secondary/language')
      .send({ language: 'zh' });
    expect(res.status).toBe(200);
    expect(res.body.language).toBe('en');
    expect(runtime.bridge.setUserLanguage).toHaveBeenCalledWith({
      language: 'en',
      syncOutputLanguage: false,
      scope: 'workspace',
    });
  });

  it('does not report a persisted write as failed when event delivery fails', async () => {
    const runtime = makeRuntime({ trusted: true, cwd: '/secondary' });
    runtime.bridge.publishWorkspaceEvent.mockImplementation(() => {
      throw new Error('closed listener');
    });
    const { app } = makeApp({ runtimes: [runtime] });
    expect(
      (
        await request(app)
          .post('/workspaces/secondary/language')
          .send({ language: 'zh' })
      ).status,
    ).toBe(200);
  });

  it('does not synchronize a locale when persistence fails', async () => {
    const runtime = makeRuntime({ trusted: true, cwd: '/secondary' });
    const { app } = makeApp({
      runtimes: [runtime],
      persistSetting: vi.fn().mockRejectedValue(new Error('disk full')),
    });
    expect(
      (
        await request(app)
          .post('/workspaces/secondary/language')
          .send({ language: 'zh' })
      ).status,
    ).toBe(500);
    expect(runtime.bridge.setUserLanguage).not.toHaveBeenCalled();
    expect(runtime.bridge.publishWorkspaceEvent).not.toHaveBeenCalled();
  });

  it('persists a secondary workspace UI language without touching user settings or siblings', async () => {
    const primary = makeRuntime({ trusted: true, cwd: '/primary' });
    const secondary = makeRuntime({ trusted: true, cwd: '/secondary' });
    const { app, persistSetting } = makeApp({ runtimes: [primary, secondary] });
    const res = await request(app)
      .post('/workspaces/secondary/language')
      .send({ language: 'zh' });
    expect(res.status).toBe(200);
    expect(persistSetting).toHaveBeenCalledExactlyOnceWith(
      '/secondary',
      SettingScope.Workspace,
      'general.language',
      'zh',
      expect.any(Function),
    );
    expect(secondary.bridge.setUserLanguage).toHaveBeenCalledWith({
      language: 'zh',
      syncOutputLanguage: false,
      scope: 'workspace',
    });
    expect(primary.bridge.setUserLanguage).not.toHaveBeenCalled();
    expect(primary.bridge.publishWorkspaceEvent).not.toHaveBeenCalled();
    expect(updateOutputLanguageFile).not.toHaveBeenCalled();
    expect(setLanguageAsync).not.toHaveBeenCalled();
  });

  it('accepts a cold workspace without starting an ACP channel', async () => {
    const runtime = makeRuntime({
      trusted: true,
      cwd: '/secondary',
      setUserLanguage: async () => {
        throw new SessionNotFoundError('user-language');
      },
    });
    const { app, persistSetting } = makeApp({ runtimes: [runtime] });
    const res = await request(app)
      .post('/workspaces/secondary/language')
      .send({ language: 'en' });
    expect(res.status).toBe(200);
    expect(res.body.refresh).toEqual({ runtimes: 0, sessions: 0, failed: 0 });
    expect(persistSetting).toHaveBeenCalledOnce();
  });

  it('rejects untrusted workspace writes', async () => {
    const { app, persistSetting } = makeApp({
      runtimes: [makeRuntime({ trusted: false, cwd: '/secondary' })],
    });
    expect(
      (
        await request(app)
          .post('/workspaces/secondary/language')
          .send({ language: 'en' })
      ).status,
    ).toBe(403);
    expect(persistSetting).not.toHaveBeenCalled();
  });

  it('rejects an unknown workspace instead of writing primary settings', async () => {
    const { app, persistSetting } = makeApp();
    expect(
      (
        await request(app)
          .post('/workspaces/missing/language')
          .send({ language: 'en' })
      ).status,
    ).toBe(400);
    expect(persistSetting).not.toHaveBeenCalled();
  });

  it('does not let a workspace UI-language request change output language', async () => {
    const { app, persistSetting } = makeApp({
      runtimes: [makeRuntime({ trusted: true, cwd: '/secondary' })],
    });
    expect(
      (
        await request(app)
          .post('/workspaces/secondary/language')
          .send({ language: 'en', syncOutputLanguage: true })
      ).status,
    ).toBe(400);
    expect(persistSetting).not.toHaveBeenCalled();
  });
  it('rejects an unknown language code without persisting', async () => {
    const { app, persistSetting } = makeApp();

    const res = await request(app).post('/language').send({ language: 'xx' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_language');
    expect(res.body.allowed).toEqual(LANGUAGE_CODES);
    expect(persistSetting).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean syncOutputLanguage', async () => {
    const { app, persistSetting } = makeApp();

    const res = await request(app)
      .post('/language')
      .send({ language: 'zh', syncOutputLanguage: 'yes' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_sync_flag');
    expect(persistSetting).not.toHaveBeenCalled();
  });

  it('respects the client-id validation rejection', async () => {
    const { app, persistSetting } = makeApp({
      // Matches the real parseAndValidateWorkspaceClientId contract: it
      // writes the 400 response itself and returns null.
      parseAndValidateClientId: (_req, res) => {
        res
          .status(400)
          .json({ error: 'unknown client', code: 'invalid_client_id' });
        return null;
      },
    });

    const res = await request(app)
      .post('/language')
      .set('X-Qwen-Client-Id', 'unknown-client')
      .send({ language: 'zh' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_client_id');
    expect(persistSetting).not.toHaveBeenCalled();
  });

  it('succeeds with zero runtimes and persists only the UI language by default', async () => {
    const { app, persistSetting } = makeApp();

    const res = await request(app).post('/language').send({ language: 'zh' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      language: 'zh',
      outputLanguage: null,
      refresh: { runtimes: 0, sessions: 0, failed: 0 },
    });
    expect(persistSetting).toHaveBeenCalledTimes(1);
    expect(persistSetting).toHaveBeenCalledWith(
      '/workspace',
      SettingScope.User,
      'general.language',
      'zh',
    );
    expect(vi.mocked(setLanguageAsync)).toHaveBeenCalledWith('zh');
    expect(vi.mocked(updateOutputLanguageFile)).not.toHaveBeenCalled();
  });

  it('persists the resolved output language and writes the global file when syncing', async () => {
    const { app, persistSetting } = makeApp();

    const res = await request(app)
      .post('/language')
      .send({ language: 'zh', syncOutputLanguage: true });

    expect(res.status).toBe(200);
    expect(res.body.outputLanguage).toBe('Chinese');
    expect(vi.mocked(updateOutputLanguageFile)).toHaveBeenCalledWith('Chinese');
    expect(persistSetting).toHaveBeenCalledTimes(2);
    expect(persistSetting).toHaveBeenCalledWith(
      '/workspace',
      SettingScope.User,
      'general.language',
      'zh',
    );
    expect(persistSetting).toHaveBeenCalledWith(
      '/workspace',
      SettingScope.User,
      'general.outputLanguage',
      'Chinese',
    );
  });

  it('accepts auto and preserves it when output language is synced', async () => {
    const runtime = makeRuntime({ trusted: true, cwd: '/auto' });
    const { app, persistSetting } = makeApp({ runtimes: [runtime] });

    const res = await request(app)
      .post('/language')
      .send({ language: 'auto', syncOutputLanguage: true });

    expect(res.status).toBe(200);
    expect(res.body.language).toBe('zh');
    expect(res.body.outputLanguage).toBe('auto');
    expect(vi.mocked(updateOutputLanguageFile)).toHaveBeenCalledWith('auto');
    expect(persistSetting).toHaveBeenCalledTimes(2);
    expect(persistSetting).toHaveBeenCalledWith(
      '/workspace',
      SettingScope.User,
      'general.language',
      'auto',
    );
    expect(persistSetting).toHaveBeenCalledWith(
      '/workspace',
      SettingScope.User,
      'general.outputLanguage',
      'auto',
    );
    expect(vi.mocked(setLanguageAsync)).toHaveBeenCalledWith('auto');
    expect(runtime.bridge.setUserLanguage).toHaveBeenCalledWith({
      language: 'auto',
      syncOutputLanguage: true,
    });
    expect(runtime.bridge.publishWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'language_changed',
        data: expect.objectContaining({
          language: 'zh',
          outputLanguage: 'auto',
          userLevel: true,
        }),
      }),
    );
  });

  it('returns 500 persist_error without side effects when persistence fails', async () => {
    const runtime = makeRuntime({ trusted: true, cwd: '/a' });
    const { app } = makeApp({
      runtimes: [runtime],
      persistSetting: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });

    const res = await request(app).post('/language').send({ language: 'zh' });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('persist_error');
    expect(runtime.bridge.setUserLanguage).not.toHaveBeenCalled();
    expect(runtime.bridge.publishWorkspaceEvent).not.toHaveBeenCalled();
    expect(vi.mocked(setLanguageAsync)).not.toHaveBeenCalled();
  });

  it('returns 500 persist_error when the output-language file write fails', async () => {
    vi.mocked(updateOutputLanguageFile).mockImplementationOnce(() => {
      throw new Error('read-only file system');
    });
    const runtime = makeRuntime({ trusted: true, cwd: '/a' });
    const { app, persistSetting } = makeApp({ runtimes: [runtime] });

    const res = await request(app)
      .post('/language')
      .send({ language: 'zh', syncOutputLanguage: true });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('persist_error');
    expect(persistSetting).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateOutputLanguageFile)).toHaveBeenCalledWith('Chinese');
    expect(runtime.bridge.setUserLanguage).not.toHaveBeenCalled();
    expect(runtime.bridge.publishWorkspaceEvent).not.toHaveBeenCalled();
    expect(vi.mocked(setLanguageAsync)).not.toHaveBeenCalled();
  });

  it('returns 500 persist_error when the output-language setting write fails', async () => {
    const persistSetting = vi.fn(
      async (
        _workspace: string,
        _scope: SettingScope,
        key: string,
      ): Promise<void> => {
        if (key === 'general.outputLanguage') {
          throw new Error('disk full');
        }
      },
    );
    const runtime = makeRuntime({ trusted: true, cwd: '/a' });
    const { app } = makeApp({ runtimes: [runtime], persistSetting });

    const res = await request(app)
      .post('/language')
      .send({ language: 'zh', syncOutputLanguage: true });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('persist_error');
    expect(persistSetting).toHaveBeenCalledTimes(2);
    expect(vi.mocked(updateOutputLanguageFile)).toHaveBeenCalledWith('Chinese');
    expect(runtime.bridge.setUserLanguage).not.toHaveBeenCalled();
    expect(runtime.bridge.publishWorkspaceEvent).not.toHaveBeenCalled();
    expect(vi.mocked(setLanguageAsync)).not.toHaveBeenCalled();
  });

  it('still fans out and publishes without output sync when daemon i18n fails', async () => {
    vi.mocked(setLanguageAsync).mockRejectedValueOnce(new Error('boom'));
    const runtime = makeRuntime({ trusted: true, cwd: '/a' });

    const { app } = makeApp({ runtimes: [runtime] });
    const res = await request(app).post('/language').send({ language: 'auto' });

    expect(res.status).toBe(200);
    expect(res.body.language).toBe('zh');
    expect(runtime.bridge.setUserLanguage).toHaveBeenCalledWith({
      language: 'auto',
      syncOutputLanguage: false,
    });
    expect(runtime.bridge.publishWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'language_changed',
        data: { language: 'zh', outputLanguage: null, userLevel: true },
      }),
    );
  });

  it('fans out to trusted runtimes, skipping untrusted and channel-less ones', async () => {
    const refreshed = makeRuntime({
      trusted: true,
      cwd: '/refreshed',
      setUserLanguage: async (params) => ({
        language: params.language,
        sessions: 2,
        failed: 1,
      }),
    });
    const refreshedSecond = makeRuntime({
      trusted: true,
      cwd: '/refreshed-second',
      setUserLanguage: async (params) => ({
        language: params.language,
        sessions: 3,
        failed: 2,
      }),
    });
    const noChannel = makeRuntime({
      trusted: true,
      cwd: '/no-channel',
      setUserLanguage: async () => {
        throw new SessionNotFoundError('user-language');
      },
    });
    const broken = makeRuntime({
      trusted: true,
      cwd: '/broken',
      setUserLanguage: async () => {
        throw new Error('transport closed');
      },
    });
    const untrusted = makeRuntime({ trusted: false, cwd: '/untrusted' });
    const { app } = makeApp({
      runtimes: [refreshed, refreshedSecond, noChannel, broken, untrusted],
      parseAndValidateClientId: () => 'client-1',
    });

    const res = await request(app)
      .post('/language')
      .set('X-Qwen-Client-Id', 'client-1')
      .send({ language: 'zh', syncOutputLanguage: true });

    expect(res.status).toBe(200);
    expect(res.body.refresh).toEqual({ runtimes: 2, sessions: 5, failed: 4 });
    expect(refreshed.bridge.setUserLanguage).toHaveBeenCalledWith({
      language: 'zh',
      syncOutputLanguage: true,
    });
    expect(refreshedSecond.bridge.setUserLanguage).toHaveBeenCalledWith({
      language: 'zh',
      syncOutputLanguage: true,
    });
    expect(untrusted.bridge.setUserLanguage).not.toHaveBeenCalled();
    expect(untrusted.bridge.publishWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'language_changed',
        data: expect.objectContaining({ userLevel: true }),
      }),
    );
    expect(refreshed.bridge.publishWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'language_changed',
        data: expect.objectContaining({
          language: 'zh',
          outputLanguage: 'Chinese',
          userLevel: true,
        }),
        originatorClientId: 'client-1',
      }),
    );
    expect(noChannel.bridge.publishWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'language_changed' }),
    );
    expect(broken.bridge.publishWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'language_changed' }),
    );
  });

  it('isolates workspace event publication failures', async () => {
    const brokenPublisher = makeRuntime({ trusted: true, cwd: '/broken' });
    brokenPublisher.bridge.publishWorkspaceEvent.mockImplementationOnce(() => {
      throw new Error('event bus closed');
    });
    const laterRuntime = makeRuntime({ trusted: true, cwd: '/later' });
    const { app } = makeApp({
      runtimes: [brokenPublisher, laterRuntime],
    });

    const res = await request(app).post('/language').send({ language: 'zh' });

    expect(res.status).toBe(200);
    expect(res.body.refresh).toEqual({ runtimes: 2, sessions: 0, failed: 0 });
    expect(laterRuntime.bridge.publishWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'language_changed' }),
    );
  });
});
