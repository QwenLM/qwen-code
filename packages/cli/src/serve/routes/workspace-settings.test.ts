/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerWorkspaceSettingsRoutes } from './workspace-settings.js';
import { loadSettings } from '../../config/settings.js';
import { WorkspaceGenerationClosedError } from '../workspace-registry.js';

vi.mock('../../config/settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../config/settings.js')>();
  return { ...actual, loadSettings: vi.fn() };
});

beforeEach(() => {
  vi.mocked(loadSettings).mockReturnValue({
    merged: {},
    user: { settings: {} },
    workspace: { settings: {} },
    forScope: vi.fn().mockReturnValue({ settings: {} }),
  } as never);
});

function makeApp(
  overrides: {
    captureGenerationAssertion?: () => (() => void) | undefined;
    afterPersist?: () => void;
  } = {},
) {
  const app = express();
  app.use(express.json());

  const persistSetting = vi.fn(async () => {
    overrides.afterPersist?.();
  });
  const broadcastSettingsChanged = vi.fn();

  registerWorkspaceSettingsRoutes(app, {
    boundWorkspace: '/workspace',
    mutate: () => (_req, _res, next) => next(),
    safeBody: (req) =>
      req.body && typeof req.body === 'object' ? req.body : {},
    persistSetting,
    broadcastSettingsChanged,
    parseAndValidateClientId: () => undefined,
    captureGenerationAssertion: overrides.captureGenerationAssertion,
  });

  return { app, persistSetting, broadcastSettingsChanged };
}

describe('POST /workspace/settings', () => {
  it('returns 503 without broadcasting when the runtime closes after persist', async () => {
    let generationOpen = true;
    const { app, broadcastSettingsChanged } = makeApp({
      captureGenerationAssertion: () => () => {
        if (!generationOpen) throw new WorkspaceGenerationClosedError();
      },
      afterPersist: () => {
        generationOpen = false;
      },
    });

    const res = await request(app).post('/workspace/settings').send({
      scope: 'user',
      key: 'general.cleanupPeriodDays',
      value: 7,
    });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('workspace_runtime_unavailable');
    expect(broadcastSettingsChanged).not.toHaveBeenCalled();
  });

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

  it('rejects a security-sensitive key even at user scope', async () => {
    // Enabling user-scope writes must not expose SECURITY_SENSITIVE_SETTINGS
    // (e.g. tools.approvalMode) — getAllowedKeys() filters them out regardless
    // of scope. Guards against a future allowlist change leaking them.
    const { app, persistSetting } = makeApp();

    const res = await request(app).post('/workspace/settings').send({
      scope: 'user',
      key: 'tools.approvalMode',
      value: 'yolo',
    });

    expect(res.status).toBe(400);
    // 'disallowed_key' (recognized but blocked), not 'invalid_key' (unknown).
    expect(res.body).toMatchObject({ code: 'disallowed_key' });
    expect(persistSetting).not.toHaveBeenCalled();
  });

  it.each(['workspace', 'user'] as const)(
    'accepts %s mcpServers for the MCP manager',
    async (scope) => {
      const { app, persistSetting, broadcastSettingsChanged } = makeApp();
      const value = {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
        },
      };

      const res = await request(app).post('/workspace/settings').send({
        scope,
        key: 'mcpServers',
        value,
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        key: 'mcpServers',
        scope,
        value,
        requiresRestart: false,
      });
      expect(persistSetting).toHaveBeenCalledWith(
        '/workspace',
        expect.any(String),
        'mcpServers',
        value,
      );
      expect(broadcastSettingsChanged).toHaveBeenCalledWith(
        'mcpServers',
        value,
        scope,
        undefined,
      );
    },
  );

  it('atomically adds one MCP server without replacing existing servers', async () => {
    const existing = { docs: { command: 'docs-server' } };
    vi.mocked(loadSettings).mockReturnValue({
      merged: { mcpServers: existing },
      user: { settings: {} },
      workspace: { settings: { mcpServers: existing } },
      forScope: vi.fn().mockReturnValue({
        settings: { mcpServers: existing },
      }),
    } as never);
    const { app, persistSetting } = makeApp();

    const res = await request(app)
      .post('/workspace/settings')
      .send({
        scope: 'workspace',
        key: 'mcpServers',
        value: { command: 'new-server' },
        mcpServerMutation: { operation: 'set', name: 'new' },
      });

    expect(res.status).toBe(200);
    expect(persistSetting).toHaveBeenCalledWith(
      '/workspace',
      expect.any(String),
      'mcpServers',
      {
        docs: { command: 'docs-server' },
        new: { command: 'new-server' },
      },
    );
  });

  it('atomically removes only the named MCP server', async () => {
    const existing = {
      docs: { command: 'docs-server' },
      keep: { command: 'keep-server' },
    };
    vi.mocked(loadSettings).mockReturnValue({
      merged: { mcpServers: existing },
      user: { settings: {} },
      workspace: { settings: { mcpServers: existing } },
      forScope: vi.fn().mockReturnValue({
        settings: { mcpServers: existing },
      }),
    } as never);
    const { app, persistSetting } = makeApp();

    const res = await request(app)
      .post('/workspace/settings')
      .send({
        scope: 'workspace',
        key: 'mcpServers',
        value: {},
        mcpServerMutation: { operation: 'remove', name: 'docs' },
      });

    expect(res.status).toBe(200);
    expect(persistSetting).toHaveBeenCalledWith(
      '/workspace',
      expect.any(String),
      'mcpServers',
      { keep: { command: 'keep-server' } },
    );
  });

  it('redacts MCP secrets in reads and restores them on writes', async () => {
    const existing = {
      secure: {
        command: 'node',
        env: { API_TOKEN: 'env-secret' },
        headers: { Authorization: 'Bearer header-secret' },
        oauth: { clientId: 'client', clientSecret: 'oauth-secret' },
      },
    };
    vi.mocked(loadSettings).mockReturnValue({
      merged: { mcpServers: existing },
      user: { settings: {} },
      workspace: { settings: { mcpServers: existing } },
      forScope: vi.fn().mockReturnValue({
        settings: { mcpServers: existing },
      }),
    } as never);
    const { app, persistSetting, broadcastSettingsChanged } = makeApp();

    const read = await request(app).get('/workspace/settings');
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain('env-secret');
    expect(JSON.stringify(read.body)).not.toContain('header-secret');
    expect(JSON.stringify(read.body)).not.toContain('oauth-secret');
    expect(JSON.stringify(read.body)).toContain('__redacted__');

    const redacted = read.body.settings.find(
      (setting: { key?: string }) => setting.key === 'mcpServers',
    ).values.workspace;
    const write = await request(app).post('/workspace/settings').send({
      scope: 'workspace',
      key: 'mcpServers',
      value: redacted,
    });

    expect(write.status).toBe(200);
    expect(JSON.stringify(write.body)).not.toContain('env-secret');
    expect(persistSetting).toHaveBeenCalledWith(
      '/workspace',
      'Workspace',
      'mcpServers',
      existing,
    );
    expect(JSON.stringify(broadcastSettingsChanged.mock.calls)).not.toContain(
      'env-secret',
    );
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
