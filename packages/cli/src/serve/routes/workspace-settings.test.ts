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
    includeLiveVoice: true,
  });

  return { app, persistSetting, broadcastSettingsChanged };
}

/** Minimal registry for the workspace-qualified routes: one active, trusted entry. */
function makeQualifiedApp() {
  const app = express();
  app.use(express.json());
  const persistSetting = vi.fn(async () => {});
  const registry = {
    getEntryByWorkspaceId: (selector: string) =>
      selector === 'primary'
        ? {
            state: 'active',
            current: {
              runtime: {
                trusted: true,
                workspaceCwd: '/workspace',
                bridge: {},
                generationGuard: undefined,
              },
            },
          }
        : undefined,
  };

  registerWorkspaceQualifiedSettingsRoutes(app, {
    mutate: () => (_req, _res, next) => next(),
    safeBody: (req) =>
      req.body && typeof req.body === 'object' ? req.body : {},
    persistSetting,
    workspaceRegistry: registry as unknown as Parameters<
      typeof registerWorkspaceQualifiedSettingsRoutes
    >[1]['workspaceRegistry'],
    invalidateServeFeaturesCache: () => {},
  });

  return { app, persistSetting };
}

describe('POST /workspace/settings', () => {
  it('exposes the Live shortcut as user-global and rejects generic writes', async () => {
    vi.mocked(loadSettings).mockReturnValue({
      merged: { experimental: { liveVoice: { shortcut: 'Command+W' } } },
      user: {
        settings: {
          experimental: {
            liveVoice: { enabled: true, shortcut: 'Command+E' },
          },
        },
      },
      workspace: {
        settings: {
          experimental: { liveVoice: { shortcut: 'Command+W' } },
        },
      },
      forScope: vi.fn().mockReturnValue({ settings: {} }),
    } as never);
    const { app, persistSetting } = makeApp();

    const read = await request(app).get('/workspace/settings');
    const shortcut = read.body.settings.find(
      (setting: { key?: string }) =>
        setting.key === 'experimental.liveVoice.shortcut',
    );
    expect(shortcut).toMatchObject({
      requiresRestart: false,
      default: 'Command+E',
      values: { effective: 'Command+E', user: 'Command+E' },
    });
    expect(shortcut.values.workspace).toBeUndefined();

    for (const scope of ['user', 'workspace']) {
      const write = await request(app).post('/workspace/settings').send({
        scope,
        key: 'experimental.liveVoice.shortcut',
        value: 'Command+K',
      });
      expect(write.status).toBe(400);
      expect(write.body.code).toBe('live_managed_setting');
    }
    expect(persistSetting).not.toHaveBeenCalled();
  });

  it('exposes disabled Live setup settings on the supported WebShell surface', async () => {
    const { app } = makeApp();

    const read = await request(app).get('/workspace/settings');

    expect(
      read.body.settings.map((setting: { key?: string }) => setting.key),
    ).toEqual(
      expect.arrayContaining([
        'experimental.liveVoice.enabled',
        'experimental.liveVoice.shortcut',
      ]),
    );
  });

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

  // R8-1: `stripWorkspaceRestrictedSettings` drops these before every merge, so
  // a workspace-scope write persists a committable dead entry into the repo's
  // .qwen/settings.json and answers 200 + requiresRestart while the feature
  // never turns on. The TUI dialog already filters them; the API did not.
  it('rejects a workspace-restricted key at workspace scope', async () => {
    const { app, persistSetting } = makeApp();

    const res = await request(app).post('/workspace/settings').send({
      scope: 'workspace',
      key: 'tools.workflowsEnabled',
      value: true,
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'workspace_restricted_setting' });
    expect(persistSetting).not.toHaveBeenCalled();
  });

  it('still accepts the same key at user scope', async () => {
    // User scope honors the setting — the guard must not reach beyond
    // workspace scope, or this PR's whole enablement path dies with it.
    const { app, persistSetting } = makeApp();

    const res = await request(app).post('/workspace/settings').send({
      scope: 'user',
      key: 'tools.workflowsEnabled',
      value: true,
    });

    expect(res.status).toBe(200);
    expect(persistSetting).toHaveBeenCalled();
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

  it.each(['ui.mouseTracking', 'ui.showScrollbar', 'ui.showToolCallArgs'])(
    'rejects a TUI-only key (%s) that has no effect in the web shell',
    async (key) => {
      // These keys are read only inside the ink TUI (mouseTracking also
      // requires a TTY), so exposing them here would be dead toggles in serve
      // mode. They are filtered out via TUI_ONLY_SETTINGS even though they
      // declare showInDialog: true.
      const { app, persistSetting } = makeApp();

      const res = await request(app).post('/workspace/settings').send({
        scope: 'user',
        key,
        value: false,
      });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'disallowed_key' });
      expect(persistSetting).not.toHaveBeenCalled();
    },
  );

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

describe('POST /workspaces/:workspace/settings', () => {
  // R8-1, second call site: the qualified route accepts workspace scope only,
  // so without the guard it is the easier of the two paths to write a dead
  // entry through. Fixing the sibling route does not fix this one.
  it('rejects a workspace-restricted key', async () => {
    const { app, persistSetting } = makeQualifiedApp();

    const res = await request(app).post('/workspaces/primary/settings').send({
      scope: 'workspace',
      key: 'tools.workflowsEnabled',
      value: true,
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'workspace_restricted_setting' });
    expect(persistSetting).not.toHaveBeenCalled();
  });
});
