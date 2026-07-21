/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  registerWorkspaceQualifiedSettingsRoutes,
  registerWorkspaceSettingsRoutes,
} from './workspace-settings.js';
import { loadSettings, SettingScope } from '../../config/settings.js';
import { sendBridgeError as sendBridgeErrorResponse } from '../server/error-response.js';
import { getWorkspaceRuntimeCoordinator } from '../workspace-runtime-coordinator.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';

const setValueMock = vi.fn();

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
    setValue: setValueMock,
  } as never);
  setValueMock.mockClear();
});

function makeApp(
  otherRuntimes: readonly WorkspaceRuntime[] = [],
  trusted = true,
) {
  const app = express();
  app.use(express.json());

  const persistSetting = vi.fn(async () => {});
  const broadcastSettingsChanged = vi.fn();
  const workspaceRuntime = {
    workspaceCwd: '/workspace',
    trusted,
    bridge: { isChannelLive: () => false },
  } as never as WorkspaceRuntime;

  registerWorkspaceSettingsRoutes(app, {
    boundWorkspace: '/workspace',
    workspaceRuntime,
    workspaceRegistry: {
      list: () => [workspaceRuntime, ...otherRuntimes],
      listManaged: () => [workspaceRuntime, ...otherRuntimes],
    } as never,
    mutate: () => (_req, _res, next) => next(),
    safeBody: (req) =>
      req.body && typeof req.body === 'object' ? req.body : {},
    persistSetting,
    broadcastSettingsChanged,
    parseAndValidateClientId: () => undefined,
    sendBridgeError: sendBridgeErrorResponse,
  });

  return {
    app,
    persistSetting,
    broadcastSettingsChanged,
    workspaceRuntime,
  };
}

function makeQualifiedApp() {
  const app = express();
  app.use(express.json());
  const persistSetting = vi.fn(async () => {});
  const workspaceRuntime = {
    workspaceId: 'workspace-id',
    workspaceCwd: '/workspace',
    trusted: true,
    bridge: {
      isChannelLive: () => false,
      publishWorkspaceEvent: vi.fn(),
    },
  } as never as WorkspaceRuntime;
  registerWorkspaceQualifiedSettingsRoutes(app, {
    workspaceRegistry: {
      getByWorkspaceId: (id: string) =>
        id === workspaceRuntime.workspaceId ? workspaceRuntime : undefined,
    } as never,
    mutate: () => (_req, _res, next) => next(),
    safeBody: (req) =>
      req.body && typeof req.body === 'object' ? req.body : {},
    persistSetting,
    invalidateServeFeaturesCache: vi.fn(),
    sendBridgeError: sendBridgeErrorResponse,
  });
  return { app, persistSetting, workspaceRuntime };
}

describe('/workspace/config/mcp/servers', () => {
  it('reports runtime draining instead of a persistence failure', async () => {
    const { app, workspaceRuntime } = makeApp();
    getWorkspaceRuntimeCoordinator(workspaceRuntime).beginDrain();

    const response = await request(app).post(
      '/workspace/config/mcp/docs/disable',
    );

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      code: 'workspace_draining',
      workspaceCwd: '/workspace',
    });
    expect(setValueMock).not.toHaveBeenCalled();
  });

  it('keeps global config available when the primary workspace is untrusted', async () => {
    const { app, persistSetting } = makeApp([], false);

    const inventory = await request(app).get('/workspace/config/mcp/servers');
    const write = await request(app)
      .put('/workspace/config/mcp/servers/demo')
      .send({
        scope: 'user',
        config: { command: 'node', args: ['server.js'] },
      });
    const disable = await request(app).post(
      '/workspace/config/mcp/demo/disable',
    );

    expect(inventory.status).toBe(200);
    expect(write.status).toBe(200);
    expect(disable.status).toBe(200);
    expect(persistSetting).toHaveBeenCalledWith(
      '/workspace',
      'User',
      'mcpServers',
      { demo: { command: 'node', args: ['server.js'] } },
    );
  });

  it('persists enablement without starting a cold runtime', async () => {
    const { app, broadcastSettingsChanged } = makeApp();

    const response = await request(app).post(
      '/workspace/config/mcp/docs/disable',
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      serverName: 'docs',
      action: 'disable',
      activation: 'deferred',
    });
    expect(setValueMock).toHaveBeenCalledWith(
      expect.anything(),
      'mcp.excluded',
      ['docs'],
    );
    expect(broadcastSettingsChanged).toHaveBeenCalledWith(
      'mcp.excluded',
      ['docs'],
      'user',
      undefined,
    );
  });

  it('rejects enabling one server when a glob pattern still excludes it', async () => {
    vi.mocked(loadSettings).mockReturnValue({
      merged: {
        mcpServers: { docs: { command: 'docs-server' } },
        mcp: { excluded: ['*docs*'] },
      },
      user: {
        settings: {
          mcpServers: { docs: { command: 'docs-server' } },
          mcp: { excluded: ['*docs*'] },
        },
      },
      workspace: { settings: {} },
      forScope: vi.fn((scope: SettingScope) => ({
        settings:
          scope === SettingScope.User ? { mcp: { excluded: ['*docs*'] } } : {},
      })),
      setValue: setValueMock,
    } as never);
    const { app } = makeApp();

    const response = await request(app).post(
      '/workspace/config/mcp/docs/enable',
    );

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'mcp_excluded_by_pattern',
      patterns: ['*docs*'],
    });
    expect(setValueMock).not.toHaveBeenCalled();
  });

  it('rejects enabling a server excluded by a read-only scope', async () => {
    vi.mocked(loadSettings).mockReturnValue({
      merged: {
        mcpServers: { docs: { command: 'docs-server' } },
        mcp: { excluded: ['docs'] },
      },
      user: { settings: {} },
      workspace: {
        settings: {
          mcpServers: { docs: { command: 'docs-server' } },
          mcp: { excluded: ['docs'] },
        },
      },
      forScope: vi.fn((scope: SettingScope) => ({
        settings:
          scope === SettingScope.Workspace
            ? { mcp: { excluded: ['docs'] } }
            : {},
      })),
      setValue: setValueMock,
    } as never);
    const { app } = makeApp();

    const response = await request(app).post(
      '/workspace/config/mcp/docs/enable',
    );

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'mcp_excluded_by_pattern',
      patterns: ['docs'],
    });
    expect(setValueMock).not.toHaveBeenCalled();
  });

  it('ignores exclusions from an untrusted workspace settings file', async () => {
    vi.mocked(loadSettings).mockReturnValue({
      merged: { mcpServers: { docs: { command: 'docs-server' } } },
      user: {
        settings: { mcpServers: { docs: { command: 'docs-server' } } },
      },
      workspace: {
        settings: { mcp: { excluded: ['docs'] } },
      },
      isTrusted: false,
      workspaceSettingsActive: true,
      forScope: vi.fn((scope: SettingScope) => ({
        settings:
          scope === SettingScope.Workspace
            ? { mcp: { excluded: ['docs'] } }
            : {},
      })),
      setValue: setValueMock,
    } as never);
    const { app } = makeApp([], false);

    const response = await request(app).post(
      '/workspace/config/mcp/docs/enable',
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, changed: false });
    expect(setValueMock).not.toHaveBeenCalled();
  });

  it('persists one server without requiring a client id', async () => {
    const { app, persistSetting, broadcastSettingsChanged } = makeApp();

    const response = await request(app)
      .put('/workspace/config/mcp/servers/demo')
      .send({
        scope: 'user',
        config: {
          command: 'node',
          args: ['server.js'],
          env: { API_TOKEN: 'secret' },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      name: 'demo',
      scope: 'user',
      activation: 'deferred',
      config: { env: { API_TOKEN: '__redacted__' } },
    });
    expect(persistSetting).toHaveBeenCalledWith(
      '/workspace',
      'User',
      'mcpServers',
      {
        demo: {
          command: 'node',
          args: ['server.js'],
          env: { API_TOKEN: 'secret' },
        },
      },
    );
    expect(broadcastSettingsChanged).toHaveBeenCalledWith(
      'mcpServers',
      {
        demo: {
          command: 'node',
          args: ['server.js'],
          env: { API_TOKEN: '__redacted__' },
        },
      },
      'user',
      undefined,
    );
  });

  it('rejects workspace-scoped writes through the singular MCP route', async () => {
    const { app, persistSetting, broadcastSettingsChanged } = makeApp();

    const putResponse = await request(app)
      .put('/workspace/config/mcp/servers/demo')
      .send({
        scope: 'workspace',
        config: { command: 'node', args: ['server.js'] },
      });
    const deleteResponse = await request(app).delete(
      '/workspace/config/mcp/servers/demo?scope=workspace',
    );

    expect(putResponse.status).toBe(400);
    expect(putResponse.body).toMatchObject({ code: 'invalid_scope' });
    expect(deleteResponse.status).toBe(400);
    expect(deleteResponse.body).toMatchObject({ code: 'invalid_scope' });
    expect(persistSetting).not.toHaveBeenCalled();
    expect(broadcastSettingsChanged).not.toHaveBeenCalled();
  });

  it('does not turn a durable user write into a failure when activation throws', async () => {
    const managedRuntime = {
      workspaceCwd: '/removing',
      trusted: true,
      bridge: { isChannelLive: () => false },
    } as never as WorkspaceRuntime;
    vi.spyOn(
      getWorkspaceRuntimeCoordinator(managedRuntime),
      'reconcileMcpConfiguration',
    ).mockImplementation(() => {
      throw new Error('runtime removed');
    });
    const { app, persistSetting } = makeApp([managedRuntime]);

    const response = await request(app)
      .put('/workspace/config/mcp/servers/demo')
      .send({
        scope: 'user',
        config: { command: 'node', args: ['server.js'] },
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      name: 'demo',
      scope: 'user',
      activation: 'deferred',
    });
    expect(persistSetting).toHaveBeenCalledWith(
      '/workspace',
      'User',
      'mcpServers',
      { demo: { command: 'node', args: ['server.js'] } },
    );
  });

  it('returns scope-separated MCP configuration', async () => {
    vi.mocked(loadSettings).mockReturnValue({
      merged: {
        mcpServers: { effective: { command: 'effective' } },
        mcp: { excluded: ['user', 'work*'] },
      },
      user: {
        settings: {
          mcpServers: { user: { command: 'user' } },
          mcp: { excluded: ['user'] },
        },
      },
      workspace: {
        settings: {
          mcpServers: { workspace: { command: 'workspace' } },
          mcp: { excluded: ['work*'] },
        },
      },
      forScope: vi.fn().mockReturnValue({ settings: {} }),
    } as never);
    const { app } = makeApp();

    const response = await request(app).get('/workspace/config/mcp/servers');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      effective: { effective: { command: 'effective' } },
      user: { user: { command: 'user' } },
      workspace: { workspace: { command: 'workspace' } },
      disabledServers: ['user', 'workspace'],
      disabledServerScopes: {
        user: ['user'],
        workspace: ['workspace'],
      },
    });
  });
});

describe('workspace-qualified configuration draining', () => {
  it('maps MCP server writes to the standard draining response', async () => {
    const { app, persistSetting, workspaceRuntime } = makeQualifiedApp();
    getWorkspaceRuntimeCoordinator(workspaceRuntime).beginDrain();

    const response = await request(app)
      .put('/workspaces/workspace-id/config/mcp/servers/docs')
      .send({ scope: 'workspace', config: { command: 'docs-server' } });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'workspace_draining' });
    expect(persistSetting).not.toHaveBeenCalled();
  });

  it('maps settings writes to the standard draining response', async () => {
    const { app, persistSetting, workspaceRuntime } = makeQualifiedApp();
    getWorkspaceRuntimeCoordinator(workspaceRuntime).beginDrain();

    const response = await request(app)
      .post('/workspaces/workspace-id/settings')
      .send({
        scope: 'workspace',
        key: 'general.cleanupPeriodDays',
        value: 7,
      });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'workspace_draining' });
    expect(persistSetting).not.toHaveBeenCalled();
  });
});

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

  it.each([
    { scope: 'workspace' as const, reconcilesSecondary: false },
    { scope: 'user' as const, reconcilesSecondary: true },
  ])(
    'reconciles affected runtimes after an atomic $scope MCP mutation',
    async ({ scope, reconcilesSecondary }) => {
      const secondary = {
        workspaceCwd: '/secondary',
        trusted: true,
        bridge: { isChannelLive: () => false },
      } as never as WorkspaceRuntime;
      const { app, workspaceRuntime } = makeApp([secondary]);
      const primaryReconcile = vi
        .spyOn(
          getWorkspaceRuntimeCoordinator(workspaceRuntime),
          'reconcileMcpConfiguration',
        )
        .mockReturnValue('deferred');
      const secondaryReconcile = vi
        .spyOn(
          getWorkspaceRuntimeCoordinator(secondary),
          'reconcileMcpConfiguration',
        )
        .mockReturnValue('deferred');

      const response = await request(app)
        .post('/workspace/settings')
        .send({
          scope,
          key: 'mcpServers',
          value: { command: 'new-server' },
          mcpServerMutation: { operation: 'set', name: 'new' },
        });

      expect(response.status).toBe(200);
      expect(response.body.activation).toBe('deferred');
      expect(primaryReconcile).toHaveBeenCalledOnce();
      if (reconcilesSecondary) {
        expect(secondaryReconcile).toHaveBeenCalledOnce();
      } else {
        expect(secondaryReconcile).not.toHaveBeenCalled();
      }
    },
  );

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
