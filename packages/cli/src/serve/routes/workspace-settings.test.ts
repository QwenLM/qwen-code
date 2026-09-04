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
import { loadSettings, type SettingScope } from '../../config/settings.js';
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
    userSettings?: Record<string, unknown>;
    workspaceSettings?: Record<string, unknown>;
  } = {},
) {
  const app = express();
  app.use(express.json());

  // The route derives the live Session Workflow value from the post-write
  // merged settings, so tests that exercise it seed the scopes `loadSettings`
  // should report. Only applied when seeded, so tests that install their own
  // `loadSettings` mock after makeApp() keep control of it.
  if (overrides.userSettings || overrides.workspaceSettings) {
    const user = structuredClone(overrides.userSettings ?? {});
    const workspace = structuredClone(overrides.workspaceSettings ?? {});
    // Mirror the real precedence (workspace over user), merging one level deep
    // so sibling keys under `experimental` are not lost.
    const merged: Record<string, unknown> = { ...user };
    for (const [key, value] of Object.entries(workspace)) {
      const base = merged[key];
      merged[key] =
        base &&
        typeof base === 'object' &&
        !Array.isArray(base) &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value)
          ? { ...(base as object), ...(value as object) }
          : value;
    }
    vi.mocked(loadSettings).mockReturnValue({
      merged,
      user: { settings: user },
      workspace: { settings: workspace },
      forScope: vi.fn().mockReturnValue({ settings: {} }),
    } as never);
  }

  const persistSetting = vi.fn(async () => {
    overrides.afterPersist?.();
  });
  const updateSessionWorkflow = vi.fn().mockResolvedValue(undefined);
  const broadcastSettingsChanged = vi.fn();
  const updateSiblingSessionWorkflows = vi.fn().mockResolvedValue(undefined);

  registerWorkspaceSettingsRoutes(app, {
    boundWorkspace: '/workspace',
    mutate: () => (_req, _res, next) => next(),
    safeBody: (req) =>
      req.body && typeof req.body === 'object' ? req.body : {},
    persistSetting,
    updateSessionWorkflow,
    updateSiblingSessionWorkflows,
    broadcastSettingsChanged,
    parseAndValidateClientId: () => undefined,
    captureGenerationAssertion: overrides.captureGenerationAssertion,
    includeLiveVoice: true,
  });

  return {
    app,
    persistSetting,
    updateSessionWorkflow,
    updateSiblingSessionWorkflows,
    broadcastSettingsChanged,
  };
}

/** Minimal registry for the workspace-qualified routes: one active, trusted entry. */
function makeQualifiedApp(
  overrides: {
    invokeWorkspaceCommand?: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
  } = {},
) {
  const app = express();
  app.use(express.json());
  const persistSetting = vi.fn(async () => {});
  const invokeWorkspaceCommand =
    overrides.invokeWorkspaceCommand ?? vi.fn().mockResolvedValue(undefined);
  const publishWorkspaceEvent = vi.fn();
  const invalidateServeFeaturesCache = vi.fn();
  const registry = {
    getEntryByWorkspaceId: (selector: string) =>
      selector === 'primary'
        ? {
            state: 'active',
            current: {
              runtime: {
                trusted: true,
                workspaceCwd: '/workspace',
                bridge: {
                  invokeWorkspaceCommand,
                  publishWorkspaceEvent,
                },
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
    invalidateServeFeaturesCache,
  });

  return {
    app,
    persistSetting,
    invokeWorkspaceCommand,
    publishWorkspaceEvent,
    invalidateServeFeaturesCache,
  };
}

describe('POST /workspace/settings', () => {
  it('updates live sessions when Session Workflow changes', async () => {
    // Seeded as the post-write state: the route reads back the effective value.
    const { app, updateSessionWorkflow } = makeApp({
      workspaceSettings: { experimental: { sessionWorkflow: true } },
    });

    const res = await request(app).post('/workspace/settings').send({
      scope: 'workspace',
      key: 'experimental.sessionWorkflow',
      value: true,
    });

    expect(res.status).toBe(200);
    expect(updateSessionWorkflow).toHaveBeenCalledWith(true);
  });

  it('still broadcasts when the live Session Workflow push fails after persist', async () => {
    // The persist succeeded (the file now carries the new value) but the
    // push to live sessions failed with a generic transport error (bridge
    // channel closed, push timeout — anything that is not
    // SessionNotFoundError). The requester gets the 500, but every other
    // observer must still hear about the disk change instead of staying
    // stale until the next write or daemon restart.
    const {
      app,
      updateSessionWorkflow,
      broadcastSettingsChanged,
      persistSetting,
    } = makeApp({
      workspaceSettings: { experimental: { sessionWorkflow: true } },
    });
    updateSessionWorkflow.mockRejectedValueOnce(new Error('channel closed'));

    const res = await request(app).post('/workspace/settings').send({
      scope: 'workspace',
      key: 'experimental.sessionWorkflow',
      value: true,
    });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'runtime_update_error' });
    expect(persistSetting).toHaveBeenCalledTimes(1);
    expect(updateSessionWorkflow).toHaveBeenCalledWith(true);
    expect(broadcastSettingsChanged).toHaveBeenCalledWith(
      'experimental.sessionWorkflow',
      true,
      'workspace',
      undefined,
    );
  });

  it('still fans out a user write when the primary live push fails', async () => {
    const { app, updateSessionWorkflow, updateSiblingSessionWorkflows } =
      makeApp({
        workspaceSettings: { experimental: { sessionWorkflow: true } },
      });
    updateSessionWorkflow.mockRejectedValueOnce(new Error('channel closed'));

    const res = await request(app).post('/workspace/settings').send({
      scope: 'user',
      key: 'experimental.sessionWorkflow',
      value: true,
    });

    expect(res.status).toBe(500);
    expect(updateSiblingSessionWorkflows).toHaveBeenCalledOnce();
  });

  it('applies the effective value when a user write is shadowed by workspace', async () => {
    // A user-scoped write persists to the user file but stays shadowed by the
    // workspace value, so live sessions must keep following the merged value.
    const { app, updateSessionWorkflow, persistSetting } = makeApp({
      workspaceSettings: { experimental: { sessionWorkflow: true } },
    });

    const res = await request(app).post('/workspace/settings').send({
      scope: 'user',
      key: 'experimental.sessionWorkflow',
      value: false,
    });

    expect(res.status).toBe(200);
    expect(persistSetting).toHaveBeenCalled();
    expect(updateSessionWorkflow).toHaveBeenCalledWith(true);
    expect(updateSessionWorkflow).not.toHaveBeenCalledWith(false);
  });

  it('fans a user-scope Session Workflow write out to sibling workspaces', async () => {
    // A user-scope write lands in the global user file and flips the gate
    // for every workspace; the route must fan the re-derivation out to the
    // non-primary runtimes after the primary push succeeds.
    const { app, updateSiblingSessionWorkflows } = makeApp({
      workspaceSettings: { experimental: { sessionWorkflow: true } },
    });

    const res = await request(app).post('/workspace/settings').send({
      scope: 'user',
      key: 'experimental.sessionWorkflow',
      value: true,
    });

    expect(res.status).toBe(200);
    expect(updateSiblingSessionWorkflows).toHaveBeenCalledTimes(1);
  });

  it('does not fan out a workspace-scope Session Workflow write', async () => {
    // A workspace-scope write only touches this workspace's file; siblings
    // keep their own value, so no fan-out may fire.
    const { app, updateSiblingSessionWorkflows } = makeApp({
      workspaceSettings: { experimental: { sessionWorkflow: true } },
    });

    const res = await request(app).post('/workspace/settings').send({
      scope: 'workspace',
      key: 'experimental.sessionWorkflow',
      value: true,
    });

    expect(res.status).toBe(200);
    expect(updateSiblingSessionWorkflows).not.toHaveBeenCalled();
  });

  it('holds a second Session Workflow write until the first write finished its live push', async () => {
    // The daemon-side settings lock only covers the persist; the readback +
    // live push happen after it. The route must serialize the whole
    // persist → readback → push critical section per workspace, otherwise a
    // second write's persist + push can overtake the first write's push and
    // live sessions end on a value that contradicts the file.
    const app = express();
    app.use(express.json());

    let diskValue = false;
    vi.mocked(loadSettings).mockImplementation(
      () =>
        ({
          get merged() {
            return { experimental: { sessionWorkflow: diskValue } };
          },
          user: { settings: {} },
          workspace: { settings: {} },
          forScope: vi.fn().mockReturnValue({ settings: {} }),
        }) as never,
    );

    let releaseFirstPush: (() => void) | undefined;
    const firstPushBlocked = new Promise<void>((resolve) => {
      releaseFirstPush = resolve;
    });
    const persistedValues: boolean[] = [];
    const persistSetting = vi.fn(
      async (
        _workspace: string,
        _scope: SettingScope,
        _key: string,
        value: unknown,
      ) => {
        persistedValues.push(value === true);
        diskValue = value === true;
      },
    );
    const pushedValues: boolean[] = [];
    const updateSessionWorkflow = vi.fn(async (enabled: boolean) => {
      if (pushedValues.length === 0) {
        // Hold the first live push; the second write must not be able to
        // start its persist while this push is still in flight.
        await firstPushBlocked;
      }
      pushedValues.push(enabled);
    });

    registerWorkspaceSettingsRoutes(app, {
      boundWorkspace: '/workspace',
      mutate: () => (_req, _res, next) => next(),
      safeBody: (req) =>
        req.body && typeof req.body === 'object' ? req.body : {},
      persistSetting,
      updateSessionWorkflow,
      broadcastSettingsChanged: vi.fn(),
      parseAndValidateClientId: () => undefined,
    });

    // supertest requests are lazy until consumed; `.then()` both starts the
    // request and yields a plain promise we can await later.
    const first = request(app)
      .post('/workspace/settings')
      .send({
        scope: 'workspace',
        key: 'experimental.sessionWorkflow',
        value: false,
      })
      .then((res) => res);
    await vi.waitFor(() =>
      expect(updateSessionWorkflow).toHaveBeenCalledTimes(1),
    );

    const second = request(app)
      .post('/workspace/settings')
      .send({
        scope: 'workspace',
        key: 'experimental.sessionWorkflow',
        value: true,
      })
      .then((res) => res);
    // Give the second request time to reach the route handler. Without the
    // write-chain it would persist (and push) right here, overtaking the
    // first write's in-flight push.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(persistSetting).toHaveBeenCalledTimes(1);

    releaseFirstPush!();
    const [firstRes, secondRes] = await Promise.all([first, second]);
    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);

    // Persists, readbacks, and pushes all serialized in request order: each
    // push carries its own post-write effective value and the final disk
    // state (true) is the final pushed state.
    expect(persistedValues).toEqual([false, true]);
    expect(pushedValues).toEqual([false, true]);
    expect(diskValue).toBe(true);
  });

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

  it.each(['ui.mouseTracking', 'ui.showScrollbar'])(
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

  it('still publishes settings_changed when the live Session Workflow push fails after persist', async () => {
    // Same contract as the legacy route: the on-disk value changed, so the
    // qualified route must invalidate the serve-features cache and publish
    // settings_changed even though the requester got the push-failure 500.
    vi.mocked(loadSettings).mockReturnValue({
      merged: { experimental: { sessionWorkflow: true } },
      user: { settings: {} },
      workspace: { settings: {} },
      forScope: vi.fn().mockReturnValue({ settings: {} }),
    } as never);
    const {
      app,
      persistSetting,
      invokeWorkspaceCommand,
      publishWorkspaceEvent,
      invalidateServeFeaturesCache,
    } = makeQualifiedApp({
      invokeWorkspaceCommand: vi
        .fn()
        .mockRejectedValue(new Error('bridge channel closed')),
    });

    const res = await request(app).post('/workspaces/primary/settings').send({
      scope: 'workspace',
      key: 'experimental.sessionWorkflow',
      value: true,
    });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'runtime_update_error' });
    expect(persistSetting).toHaveBeenCalledTimes(1);
    expect(invokeWorkspaceCommand).toHaveBeenCalledWith(
      'qwen/control/workspace/session-workflow',
      { enabled: true },
    );
    expect(invalidateServeFeaturesCache).toHaveBeenCalledTimes(1);
    expect(publishWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'settings_changed',
        data: {
          key: 'experimental.sessionWorkflow',
          value: true,
          scope: 'workspace',
        },
      }),
    );
  });
});
