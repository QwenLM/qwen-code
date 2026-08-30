/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerUserLanguageRoutes } from './user-language.js';
import { SettingScope } from '../../config/settings.js';
import { SessionNotFoundError } from '../acp-session-bridge.js';
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
    bridge: {
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
    workspaceRegistry: { list: () => runtimes } as never,
    parseAndValidateClientId:
      overrides.parseAndValidateClientId ?? (() => undefined),
  });

  return { app, persistSetting, runtimes };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /language', () => {
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
    expect(persistSetting).toHaveBeenCalledWith(
      '/workspace',
      SettingScope.User,
      'general.outputLanguage',
      'Chinese',
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

  it('still returns 200 when the daemon i18n switch itself fails', async () => {
    vi.mocked(setLanguageAsync).mockRejectedValueOnce(new Error('boom'));
    vi.mocked(getCurrentLanguage).mockReturnValue('en');

    const { app } = makeApp();
    const res = await request(app).post('/language').send({ language: 'zh' });

    expect(res.status).toBe(200);
    expect(res.body.language).toBe('zh');
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
      runtimes: [refreshed, noChannel, broken, untrusted],
      parseAndValidateClientId: () => 'client-1',
    });

    const res = await request(app)
      .post('/language')
      .set('X-Qwen-Client-Id', 'client-1')
      .send({ language: 'zh', syncOutputLanguage: true });

    expect(res.status).toBe(200);
    expect(res.body.refresh).toEqual({ runtimes: 1, sessions: 2, failed: 2 });
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
        originatorClientId: 'client-1',
      }),
    );
  });
});
