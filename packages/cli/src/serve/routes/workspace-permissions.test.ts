/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { SessionNotFoundError } from '../acp-session-bridge.js';
import {
  MAX_PERMISSION_RULE_LENGTH,
  MAX_PERMISSION_RULES_COUNT,
  normalizePermissionRules,
} from '../../config/permission-settings.js';
import {
  type LoadedSettings,
  loadSettings,
  resetHomeEnvBootstrapForTesting,
  SettingScope,
  SETTINGS_DIRECTORY_NAME,
} from '../../config/settings.js';
import {
  resetTrustedFoldersForTesting,
  TRUSTED_FOLDERS_FILENAME,
  TrustLevel,
} from '../../config/trustedFolders.js';
import { registerWorkspacePermissionsRoutes } from './workspace-permissions.js';

interface Harness {
  app: express.Application;
  scratch: string;
  workspace: string;
  home: string;
  events: Array<{
    key: string;
    value: unknown;
    scope: string;
    clientId?: string;
  }>;
  invokeWorkspaceCommand: ReturnType<typeof vi.fn>;
  persistSetting: ReturnType<typeof vi.fn>;
}

const originalQwenHome = process.env['QWEN_HOME'];
const originalTrustedFoldersPath =
  process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];

function safeBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object'
    ? (req.body as Record<string, unknown>)
    : {};
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

async function makeHarness(opts?: {
  invokeWorkspaceCommand?: ReturnType<typeof vi.fn>;
  loadSettings?: (workspace: string) => LoadedSettings;
  persistSetting?: ReturnType<typeof vi.fn>;
  broadcastSettingsChanged?: (
    key: string,
    value: unknown,
    scope: string,
    clientId: string | undefined,
  ) => void;
}): Promise<Harness> {
  const scratch = await fsp.mkdtemp(
    path.join(
      os.tmpdir(),
      `qwen-permission-routes-${randomBytes(4).toString('hex')}-`,
    ),
  );
  const home = path.join(scratch, 'home');
  const workspace = path.join(scratch, 'workspace');
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(workspace, { recursive: true });
  process.env['QWEN_HOME'] = home;
  process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = path.join(
    home,
    TRUSTED_FOLDERS_FILENAME,
  );
  resetHomeEnvBootstrapForTesting();
  resetTrustedFoldersForTesting();

  const app = express();
  app.use(express.json());
  const events: Harness['events'] = [];
  const invokeWorkspaceCommand =
    opts?.invokeWorkspaceCommand ??
    vi.fn(async () => {
      throw new SessionNotFoundError('workspace-command:qwen/permissions');
    });
  const persistSetting =
    opts?.persistSetting ??
    vi.fn(
      async (
        targetWorkspace: string,
        scope: SettingScope,
        key: string,
        value: unknown,
      ) => {
        const settings = loadSettings(targetWorkspace);
        settings.setValue(scope, key, value);
        return settings;
      },
    );
  const broadcastSettingsChanged: (
    key: string,
    value: unknown,
    scope: string,
    clientId: string | undefined,
  ) => void =
    opts?.broadcastSettingsChanged ??
    ((key, value, scope, clientId) => {
      events.push({
        key,
        value,
        scope,
        ...(clientId !== undefined ? { clientId } : {}),
      });
    });

  registerWorkspacePermissionsRoutes(app, {
    boundWorkspace: workspace,
    mutate: () => (_req, _res, next) => next(),
    safeBody,
    persistSetting,
    ...(opts?.loadSettings ? { loadSettings: opts.loadSettings } : {}),
    invokeWorkspaceCommand,
    broadcastSettingsChanged,
    parseAndValidateClientId: (req: Request, res: Response) => {
      const clientId = req.get('X-Qwen-Client-Id');
      if (clientId === 'unknown-client') {
        res.status(400).json({
          error: 'Unknown client id',
          code: 'invalid_client_id',
        });
        return null;
      }
      return clientId;
    },
  });

  return {
    app,
    scratch,
    workspace,
    home,
    events,
    invokeWorkspaceCommand,
    persistSetting,
  };
}

async function teardown(h: Harness): Promise<void> {
  await fsp.rm(h.scratch, { recursive: true, force: true });
  if (originalQwenHome === undefined) {
    delete process.env['QWEN_HOME'];
  } else {
    process.env['QWEN_HOME'] = originalQwenHome;
  }
  if (originalTrustedFoldersPath === undefined) {
    delete process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
  } else {
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = originalTrustedFoldersPath;
  }
  resetHomeEnvBootstrapForTesting();
  resetTrustedFoldersForTesting();
}

describe('workspace permissions routes', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    await teardown(h);
  });

  it('GET returns scoped and merged permission rules', async () => {
    await writeJson(path.join(h.home, 'settings.json'), {
      permissions: {
        allow: ['Bash(git *)'],
        deny: ['Read(.env)'],
      },
    });
    await writeJson(
      path.join(h.workspace, SETTINGS_DIRECTORY_NAME, 'settings.json'),
      {
        permissions: {
          allow: ['Edit(src/**)'],
          ask: ['Bash(npm *)'],
        },
      },
    );

    const res = await request(h.app).get('/workspace/permissions');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      v: 1,
      user: {
        rules: {
          allow: ['Bash(git *)'],
          ask: [],
          deny: ['Read(.env)'],
        },
      },
      workspace: {
        rules: {
          allow: ['Edit(src/**)'],
          ask: ['Bash(npm *)'],
          deny: [],
        },
      },
      merged: {
        allow: ['Bash(git *)', 'Edit(src/**)'],
        ask: ['Bash(npm *)'],
        deny: ['Read(.env)'],
      },
      isTrusted: true,
    });
    expect(res.body.user).not.toHaveProperty('path');
    expect(res.body.workspace).not.toHaveProperty('path');
  });

  it('GET returns 500 when loading permission settings fails', async () => {
    await teardown(h);
    h = await makeHarness({
      loadSettings: () => {
        throw new Error('load failed');
      },
    });

    const res = await request(h.app).get('/workspace/permissions');

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      code: 'internal_error',
      error: 'Failed to load permission rules',
    });
  });

  it('POST rejects invalid scope ruleType rules and malformed rule syntax', async () => {
    const invalidScope = await request(h.app)
      .post('/workspace/permissions')
      .send({ scope: 'system', ruleType: 'allow', rules: [] });
    expect(invalidScope.status).toBe(400);
    expect(invalidScope.body.code).toBe('invalid_scope');

    const userScope = await request(h.app)
      .post('/workspace/permissions')
      .send({ scope: 'user', ruleType: 'allow', rules: [] });
    expect(userScope.status).toBe(400);
    expect(userScope.body).toMatchObject({
      code: 'invalid_scope',
      error: 'scope must be "workspace"',
    });

    const invalidRuleType = await request(h.app)
      .post('/workspace/permissions')
      .send({ scope: 'workspace', ruleType: 'maybe', rules: [] });
    expect(invalidRuleType.status).toBe(400);
    expect(invalidRuleType.body.code).toBe('invalid_rule_type');

    const invalidRules = await request(h.app)
      .post('/workspace/permissions')
      .send({ scope: 'workspace', ruleType: 'allow', rules: 'Bash(git *)' });
    expect(invalidRules.status).toBe(400);
    expect(invalidRules.body.code).toBe('invalid_rules');

    const nonStringRule = await request(h.app)
      .post('/workspace/permissions')
      .send({ scope: 'workspace', ruleType: 'allow', rules: [123] });
    expect(nonStringRule.status).toBe(400);
    expect(nonStringRule.body).toMatchObject({
      code: 'invalid_rules',
      error: 'rules must contain only non-empty strings',
    });

    const emptyRule = await request(h.app)
      .post('/workspace/permissions')
      .send({ scope: 'workspace', ruleType: 'allow', rules: ['   '] });
    expect(emptyRule.status).toBe(400);
    expect(emptyRule.body).toMatchObject({
      code: 'invalid_rules',
      error: 'rules must contain only non-empty strings',
    });

    const malformedRule = await request(h.app)
      .post('/workspace/permissions')
      .send({ scope: 'workspace', ruleType: 'allow', rules: ['Bash(git *'] });
    expect(malformedRule.status).toBe(400);
    expect(malformedRule.body.code).toBe('invalid_rules');

    const tooManyRules = await request(h.app)
      .post('/workspace/permissions')
      .send({
        scope: 'workspace',
        ruleType: 'allow',
        rules: Array.from(
          { length: MAX_PERMISSION_RULES_COUNT + 1 },
          (_, index) => `Bash(echo ${index})`,
        ),
      });
    expect(tooManyRules.status).toBe(400);
    expect(tooManyRules.body).toMatchObject({
      code: 'invalid_rules',
      error: `rules array exceeds ${MAX_PERMISSION_RULES_COUNT} entries`,
    });

    const tooLongRule = await request(h.app)
      .post('/workspace/permissions')
      .send({
        scope: 'workspace',
        ruleType: 'allow',
        rules: [`Bash(${'x'.repeat(MAX_PERMISSION_RULE_LENGTH + 1)})`],
      });
    expect(tooLongRule.status).toBe(400);
    expect(tooLongRule.body).toMatchObject({
      code: 'invalid_rules',
      error: `rule exceeds ${MAX_PERMISSION_RULE_LENGTH}-character limit`,
    });

    expect(h.persistSetting).not.toHaveBeenCalled();
  });

  it('POST returns 500 when loading existing rules fails', async () => {
    await teardown(h);
    h = await makeHarness({
      loadSettings: () => {
        throw new Error('load failed');
      },
    });

    const res = await request(h.app)
      .post('/workspace/permissions')
      .send({
        scope: 'workspace',
        ruleType: 'allow',
        rules: ['Bash(ls)'],
      });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      code: 'internal_error',
      error: 'Failed to load permission rules',
    });
    expect(h.persistSetting).not.toHaveBeenCalled();
  });

  it('POST preserves already-stored malformed rules while accepting valid updates', async () => {
    await writeJson(
      path.join(h.workspace, SETTINGS_DIRECTORY_NAME, 'settings.json'),
      {
        permissions: {
          allow: ['Bash(git log)', 'Bash(rm '],
        },
      },
    );

    const res = await request(h.app)
      .post('/workspace/permissions')
      .send({
        scope: 'workspace',
        ruleType: 'allow',
        rules: ['Bash(git log)', 'Bash(rm ', 'Bash(ls)'],
      });

    expect(res.status).toBe(200);
    expect(h.persistSetting).toHaveBeenCalledWith(
      h.workspace,
      SettingScope.Workspace,
      'permissions.allow',
      ['Bash(git log)', 'Bash(rm', 'Bash(ls)'],
    );
    expect(res.body.workspace.rules.allow).toEqual([
      'Bash(git log)',
      'Bash(rm',
      'Bash(ls)',
    ]);
  });

  it('POST rejects user-scope writes before invoking a live ACP child', async () => {
    const live = vi.fn(async () => ({}));
    await teardown(h);
    h = await makeHarness({ invokeWorkspaceCommand: live });

    const res = await request(h.app)
      .post('/workspace/permissions')
      .set('X-Qwen-Client-Id', 'client-1')
      .send({
        scope: 'user',
        ruleType: 'allow',
        rules: [' Bash(git status) ', 'Bash(git status)'],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_scope');
    expect(live).not.toHaveBeenCalled();
    expect(h.persistSetting).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it('POST replaces one workspace rule list through a live ACP child and publishes settings_changed', async () => {
    const live = vi.fn(
      async (_method: string, params: Record<string, unknown>) => {
        const settings = loadSettings(h.workspace);
        settings.setValue(
          SettingScope.Workspace,
          'permissions.allow',
          normalizePermissionRules(params['rules']),
        );
        return {};
      },
    );
    await teardown(h);
    h = await makeHarness({ invokeWorkspaceCommand: live });

    const res = await request(h.app)
      .post('/workspace/permissions')
      .set('X-Qwen-Client-Id', 'client-1')
      .send({
        scope: 'workspace',
        ruleType: 'allow',
        rules: [' Bash(git status) ', 'Bash(git status)'],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      v: 1,
      user: {
        rules: { allow: [], ask: [], deny: [] },
      },
      workspace: {
        rules: { allow: ['Bash(git status)'], ask: [], deny: [] },
      },
      merged: { allow: ['Bash(git status)'], ask: [], deny: [] },
      isTrusted: true,
      appliedVia: 'live-child',
    });
    expect(live).toHaveBeenCalledWith('qwen/permissions/setRules', {
      cwd: h.workspace,
      scope: 'workspace',
      ruleType: 'allow',
      rules: ['Bash(git status)', 'Bash(git status)'],
    });
    expect(h.persistSetting).not.toHaveBeenCalled();
    expect(h.events).toEqual([
      {
        key: 'permissions.allow',
        scope: 'workspace',
        value: ['Bash(git status)'],
        clientId: 'client-1',
      },
    ]);
  });

  it('POST still succeeds when live ACP broadcast throws', async () => {
    const live = vi.fn(
      async (_method: string, params: Record<string, unknown>) => {
        const settings = loadSettings(h.workspace);
        settings.setValue(
          SettingScope.Workspace,
          'permissions.allow',
          normalizePermissionRules(params['rules']),
        );
        return {};
      },
    );
    const broadcastSettingsChanged = vi.fn(() => {
      throw new Error('broadcast failed');
    });
    await teardown(h);
    h = await makeHarness({
      invokeWorkspaceCommand: live,
      broadcastSettingsChanged,
    });

    const res = await request(h.app)
      .post('/workspace/permissions')
      .send({
        scope: 'workspace',
        ruleType: 'allow',
        rules: ['Bash(git status)'],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      v: 1,
      user: {
        rules: { allow: [], ask: [], deny: [] },
      },
      workspace: {
        rules: { allow: ['Bash(git status)'], ask: [], deny: [] },
      },
      merged: { allow: ['Bash(git status)'], ask: [], deny: [] },
      isTrusted: true,
      appliedVia: 'live-child',
    });
    expect(broadcastSettingsChanged).toHaveBeenCalledWith(
      'permissions.allow',
      ['Bash(git status)'],
      'workspace',
      undefined,
    );
    expect(h.persistSetting).not.toHaveBeenCalled();
  });

  it('POST maps live ACP plain invalid params to invalid_rules', async () => {
    const err = {
      code: -32602,
      message: 'Invalid params: Malformed permission rule: Bash(git *',
    };
    const live = vi.fn(async () => {
      throw err;
    });
    await teardown(h);
    h = await makeHarness({ invokeWorkspaceCommand: live });

    const res = await request(h.app)
      .post('/workspace/permissions')
      .send({
        scope: 'workspace',
        ruleType: 'allow',
        rules: ['Bash(git *'],
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'invalid_rules',
      error: 'Malformed permission rule: Bash(git *',
    });
    expect(h.persistSetting).not.toHaveBeenCalled();
  });

  it('POST returns response_build_error when live response reload fails', async () => {
    const live = vi.fn(async () => ({}));
    const loadSettingsForRoute = vi.fn(() => {
      throw new Error('settings unreadable');
    });
    const broadcastSettingsChanged = vi.fn();
    await teardown(h);
    h = await makeHarness({
      invokeWorkspaceCommand: live,
      loadSettings: loadSettingsForRoute,
      broadcastSettingsChanged,
    });

    const res = await request(h.app)
      .post('/workspace/permissions')
      .send({
        scope: 'workspace',
        ruleType: 'allow',
        rules: ['Bash(git status)'],
      });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('response_build_error');
    expect(live).toHaveBeenCalledWith('qwen/permissions/setRules', {
      cwd: h.workspace,
      scope: 'workspace',
      ruleType: 'allow',
      rules: ['Bash(git status)'],
    });
    expect(broadcastSettingsChanged).not.toHaveBeenCalled();
    expect(h.persistSetting).not.toHaveBeenCalled();
  });

  it('POST falls back to daemon settings write when no ACP child is running', async () => {
    const res = await request(h.app)
      .post('/workspace/permissions')
      .send({
        scope: 'workspace',
        ruleType: 'deny',
        rules: [' Read(.env) ', 'Read(.env)', 'Bash(rm *)'],
      });

    expect(res.status).toBe(200);
    expect(h.invokeWorkspaceCommand).toHaveBeenCalled();
    expect(h.persistSetting).toHaveBeenCalledWith(
      h.workspace,
      SettingScope.Workspace,
      'permissions.deny',
      ['Read(.env)', 'Bash(rm *)'],
    );
    expect(res.body.workspace.rules.deny).toEqual(['Read(.env)', 'Bash(rm *)']);
    expect(res.body.merged.deny).toEqual(['Read(.env)', 'Bash(rm *)']);
    expect(res.body.appliedVia).toBe('persist-fallback');
    expect(h.events).toEqual([
      {
        key: 'permissions.deny',
        scope: 'workspace',
        value: ['Read(.env)', 'Bash(rm *)'],
      },
    ]);
  });

  it('POST reuses persisted settings for fallback response', async () => {
    const loadSettingsForRoute = vi.fn((workspace: string) =>
      loadSettings(workspace),
    );
    await teardown(h);
    h = await makeHarness({ loadSettings: loadSettingsForRoute });

    const res = await request(h.app)
      .post('/workspace/permissions')
      .send({
        scope: 'workspace',
        ruleType: 'deny',
        rules: ['Read(.env)'],
      });

    expect(res.status).toBe(200);
    expect(res.body.workspace.rules.deny).toEqual(['Read(.env)']);
    expect(loadSettingsForRoute).toHaveBeenCalledTimes(1);
  });

  it('POST returns response_build_error when fallback response reload fails', async () => {
    const loadSettingsForRoute = vi
      .fn()
      .mockImplementationOnce((workspace: string) => loadSettings(workspace))
      .mockImplementationOnce(() => {
        throw new Error('settings unreadable');
      });
    const persistSetting = vi.fn(
      async (
        targetWorkspace: string,
        scope: SettingScope,
        key: string,
        value: unknown,
      ) => {
        loadSettings(targetWorkspace).setValue(scope, key, value);
      },
    );
    const broadcastSettingsChanged = vi.fn();
    await teardown(h);
    h = await makeHarness({
      loadSettings: loadSettingsForRoute,
      persistSetting,
      broadcastSettingsChanged,
    });

    const res = await request(h.app)
      .post('/workspace/permissions')
      .send({
        scope: 'workspace',
        ruleType: 'deny',
        rules: ['Read(.env)'],
      });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('response_build_error');
    expect(persistSetting).toHaveBeenCalledWith(
      h.workspace,
      SettingScope.Workspace,
      'permissions.deny',
      ['Read(.env)'],
    );
    expect(loadSettingsForRoute).toHaveBeenCalledTimes(2);
    expect(broadcastSettingsChanged).not.toHaveBeenCalled();
  });

  it('POST still succeeds when fallback broadcast throws after persisting', async () => {
    const broadcastSettingsChanged = vi.fn(() => {
      throw new Error('broadcast failed');
    });
    await teardown(h);
    h = await makeHarness({ broadcastSettingsChanged });

    const res = await request(h.app)
      .post('/workspace/permissions')
      .send({
        scope: 'workspace',
        ruleType: 'deny',
        rules: ['Read(.env)'],
      });

    expect(res.status).toBe(200);
    expect(h.persistSetting).toHaveBeenCalledWith(
      h.workspace,
      SettingScope.Workspace,
      'permissions.deny',
      ['Read(.env)'],
    );
    expect(res.body.workspace.rules.deny).toEqual(['Read(.env)']);
    expect(broadcastSettingsChanged).toHaveBeenCalledWith(
      'permissions.deny',
      ['Read(.env)'],
      'workspace',
      undefined,
    );
  });

  it('POST returns 500 when ACP child throws non-SessionNotFoundError', async () => {
    await teardown(h);
    h = await makeHarness({
      invokeWorkspaceCommand: vi.fn(async () => {
        throw new Error('unexpected ACP failure');
      }),
    });

    const res = await request(h.app)
      .post('/workspace/permissions')
      .send({ scope: 'workspace', ruleType: 'allow', rules: ['Bash(git *)'] });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('permission_update_failed');
    expect(h.persistSetting).not.toHaveBeenCalled();
  });

  it('POST returns 500 when persistSetting throws', async () => {
    h.persistSetting.mockRejectedValueOnce(new Error('disk full'));

    const res = await request(h.app)
      .post('/workspace/permissions')
      .send({ scope: 'workspace', ruleType: 'allow', rules: ['Bash(git *)'] });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('persist_error');
  });

  it('POST rejects unknown client id', async () => {
    const res = await request(h.app)
      .post('/workspace/permissions')
      .set('X-Qwen-Client-Id', 'unknown-client')
      .send({ scope: 'workspace', ruleType: 'allow', rules: ['Bash(git *)'] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_client_id');
    expect(h.persistSetting).not.toHaveBeenCalled();
  });

  it('POST persists untrusted workspace rules without merging them into effective rules', async () => {
    await writeJson(path.join(h.home, 'settings.json'), {
      security: { folderTrust: { enabled: true } },
    });
    await writeJson(path.join(h.home, TRUSTED_FOLDERS_FILENAME), {
      [process.cwd()]: TrustLevel.DO_NOT_TRUST,
    });
    resetTrustedFoldersForTesting();

    const res = await request(h.app)
      .post('/workspace/permissions')
      .send({
        scope: 'workspace',
        ruleType: 'deny',
        rules: ['Read(.env)'],
      });

    expect(res.status).toBe(200);
    expect(res.body.isTrusted).toBe(false);
    expect(res.body.workspace.rules.deny).toEqual(['Read(.env)']);
    expect(res.body.merged.deny).toEqual([]);
    expect(h.persistSetting).toHaveBeenCalledWith(
      h.workspace,
      SettingScope.Workspace,
      'permissions.deny',
      ['Read(.env)'],
    );
  });
});
