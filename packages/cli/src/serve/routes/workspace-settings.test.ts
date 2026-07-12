/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerWorkspaceSettingsRoutes } from './workspace-settings.js';

function makeApp() {
  const app = express();
  app.use(express.json());

  const persistSetting = vi.fn(async () => {});
  const broadcastSettingsChanged = vi.fn();

  registerWorkspaceSettingsRoutes(app, {
    boundWorkspace: '/workspace',
    mutate: () => (_req, _res, next) => next(),
    safeBody: (req) =>
      req.body && typeof req.body === 'object' ? req.body : {},
    persistSetting,
    broadcastSettingsChanged,
    parseAndValidateClientId: () => undefined,
  });

  return { app, persistSetting, broadcastSettingsChanged };
}

describe('POST /workspace/settings', () => {
  it('rejects negative general.cleanupPeriodDays values', async () => {
    const { app, persistSetting, broadcastSettingsChanged } = makeApp();

    for (const value of [-1, -5]) {
      const res = await request(app).post('/workspace/settings').send({
        scope: 'workspace',
        key: 'general.cleanupPeriodDays',
        value,
      });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid_value',
        error: 'Value must be >= 0',
      });
    }

    expect(persistSetting).not.toHaveBeenCalled();
    expect(broadcastSettingsChanged).not.toHaveBeenCalled();
  });

  it.each([0, 30])('accepts general.cleanupPeriodDays=%s', async (value) => {
    const { app, persistSetting, broadcastSettingsChanged } = makeApp();

    const res = await request(app).post('/workspace/settings').send({
      scope: 'workspace',
      key: 'general.cleanupPeriodDays',
      value,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      key: 'general.cleanupPeriodDays',
      scope: 'workspace',
      value,
      requiresRestart: true,
    });
    expect(persistSetting).toHaveBeenCalledWith(
      '/workspace',
      expect.any(String),
      'general.cleanupPeriodDays',
      value,
    );
    expect(broadcastSettingsChanged).toHaveBeenCalledWith(
      'general.cleanupPeriodDays',
      value,
      'workspace',
      undefined,
    );
  });

  it('persists to the user scope (~/.qwen/settings.json)', async () => {
    const { app, persistSetting, broadcastSettingsChanged } = makeApp();

    const res = await request(app).post('/workspace/settings').send({
      scope: 'user',
      key: 'general.cleanupPeriodDays',
      value: 7,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      key: 'general.cleanupPeriodDays',
      scope: 'user',
      value: 7,
    });
    // 'user' must map to SettingScope.User ('User') so the value lands in
    // ~/.qwen/settings.json rather than the workspace file.
    expect(persistSetting).toHaveBeenCalledWith(
      '/workspace',
      'User',
      'general.cleanupPeriodDays',
      7,
    );
    expect(broadcastSettingsChanged).toHaveBeenCalledWith(
      'general.cleanupPeriodDays',
      7,
      'user',
      undefined,
    );
  });

  it('rejects scopes other than workspace/user', async () => {
    const { app, persistSetting } = makeApp();

    const res = await request(app).post('/workspace/settings').send({
      scope: 'system',
      key: 'general.cleanupPeriodDays',
      value: 7,
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'invalid_scope' });
    expect(persistSetting).not.toHaveBeenCalled();
  });

  it('rejects non-positive general.sessionRecapAwayThresholdMinutes values', async () => {
    const { app, persistSetting, broadcastSettingsChanged } = makeApp();

    for (const value of [0, -1]) {
      const res = await request(app).post('/workspace/settings').send({
        scope: 'workspace',
        key: 'general.sessionRecapAwayThresholdMinutes',
        value,
      });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid_value',
        error: 'Value must be >= 1',
      });
    }

    expect(persistSetting).not.toHaveBeenCalled();
    expect(broadcastSettingsChanged).not.toHaveBeenCalled();
  });

  it.each([1, 5])(
    'accepts general.sessionRecapAwayThresholdMinutes=%s',
    async (value) => {
      const { app, persistSetting, broadcastSettingsChanged } = makeApp();

      const res = await request(app).post('/workspace/settings').send({
        scope: 'workspace',
        key: 'general.sessionRecapAwayThresholdMinutes',
        value,
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        key: 'general.sessionRecapAwayThresholdMinutes',
        scope: 'workspace',
        value,
        requiresRestart: false,
      });
      expect(persistSetting).toHaveBeenCalledWith(
        '/workspace',
        expect.any(String),
        'general.sessionRecapAwayThresholdMinutes',
        value,
      );
      expect(broadcastSettingsChanged).toHaveBeenCalledWith(
        'general.sessionRecapAwayThresholdMinutes',
        value,
        'workspace',
        undefined,
      );
    },
  );
});
