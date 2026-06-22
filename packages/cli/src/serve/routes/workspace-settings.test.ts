/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { SettingScope } from '../../config/settings.js';
import { registerWorkspaceSettingsRoutes } from './workspace-settings.js';

function makeApp() {
  const app = express();
  app.use(express.json());

  const persistSetting = vi.fn().mockResolvedValue(undefined);
  const broadcastSettingsChanged = vi.fn();

  registerWorkspaceSettingsRoutes(app, {
    boundWorkspace: '/tmp/qwen-workspace-settings-test',
    mutate: () => (_req, _res, next) => next(),
    safeBody: (req) =>
      req.body && typeof req.body === 'object' ? req.body : {},
    persistSetting,
    broadcastSettingsChanged,
    parseAndValidateClientId: () => undefined,
  });

  return { app, persistSetting, broadcastSettingsChanged };
}

function recapThresholdBody(value: number) {
  return {
    scope: 'workspace',
    key: 'general.sessionRecapAwayThresholdMinutes',
    value,
  };
}

describe('POST /workspace/settings', () => {
  it.each([0, -5])(
    'rejects non-positive session recap away threshold %s',
    async (value) => {
      const { app, persistSetting, broadcastSettingsChanged } = makeApp();

      const res = await request(app)
        .post('/workspace/settings')
        .send(recapThresholdBody(value));

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid_value',
        error: 'Value must be greater than 0',
      });
      expect(persistSetting).not.toHaveBeenCalled();
      expect(broadcastSettingsChanged).not.toHaveBeenCalled();
    },
  );

  it.each([0.1, 5])(
    'accepts positive session recap away threshold %s',
    async (value) => {
      const { app, persistSetting, broadcastSettingsChanged } = makeApp();

      const res = await request(app)
        .post('/workspace/settings')
        .send(recapThresholdBody(value));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        key: 'general.sessionRecapAwayThresholdMinutes',
        scope: 'workspace',
        value,
      });
      expect(persistSetting).toHaveBeenCalledWith(
        '/tmp/qwen-workspace-settings-test',
        SettingScope.Workspace,
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
