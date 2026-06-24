/**
 * @license
 * Copyright 2025 Qwen Team
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
import {
  resetHomeEnvBootstrapForTesting,
  SETTINGS_DIRECTORY_NAME,
} from '../../config/settings.js';
import {
  resetTrustedFoldersForTesting,
  TRUSTED_FOLDERS_FILENAME,
  TrustLevel,
} from '../../config/trustedFolders.js';
import { registerWorkspacePermissionsRoutes } from './workspace-permissions.js';
import type { DaemonWorkspaceService } from '../workspace-service/types.js';
import { WorkspacePermissionRulesSessionRequiredError } from '../workspace-service/types.js';

interface Harness {
  app: express.Application;
  scratch: string;
  workspace: string;
  home: string;
  setWorkspacePermissionRules: ReturnType<typeof vi.fn>;
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
  setWorkspacePermissionRules?: ReturnType<typeof vi.fn>;
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
  const setWorkspacePermissionRules =
    opts?.setWorkspacePermissionRules ??
    vi.fn(async () => {
      throw new WorkspacePermissionRulesSessionRequiredError();
    });
  const persistSetting = vi.fn();
  const workspaceService = {
    setWorkspacePermissionRules,
  } as unknown as DaemonWorkspaceService;

  registerWorkspacePermissionsRoutes(app, {
    boundWorkspace: workspace,
    mutate: () => (_req, _res, next) => next(),
    safeBody,
    workspace: workspaceService,
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
    setWorkspacePermissionRules,
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
        path: path.join(h.home, 'settings.json'),
        rules: {
          allow: ['Bash(git *)'],
          ask: [],
          deny: ['Read(.env)'],
        },
      },
      workspace: {
        path: path.join(h.workspace, SETTINGS_DIRECTORY_NAME, 'settings.json'),
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
  });

  it('GET remains available when settings persistence is unavailable', async () => {
    await teardown(h);
    h = await makeHarness();
    await writeJson(path.join(h.home, 'settings.json'), {
      permissions: {
        allow: ['Bash(git *)'],
      },
    });

    const res = await request(h.app).get('/workspace/permissions');

    expect(res.status).toBe(200);
    expect(res.body.user.rules.allow).toEqual(['Bash(git *)']);
  });

  it('POST can update through a live ACP child when settings persistence is unavailable', async () => {
    const acpResponse = {
      v: 1,
      user: {
        path: path.join(h.home, 'settings.json'),
        rules: { allow: ['Bash(git status)'], ask: [], deny: [] },
      },
      workspace: {
        path: path.join(h.workspace, SETTINGS_DIRECTORY_NAME, 'settings.json'),
        rules: { allow: [], ask: [], deny: [] },
      },
      merged: { allow: ['Bash(git status)'], ask: [], deny: [] },
      isTrusted: true,
    };
    const live = vi.fn(async () => acpResponse);
    await teardown(h);
    h = await makeHarness({ setWorkspacePermissionRules: live });

    const res = await request(h.app)
      .post('/workspace/permissions')
      .set('X-Qwen-Client-Id', 'client-1')
      .send({
        scope: 'user',
        ruleType: 'allow',
        rules: ['Bash(git status)'],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(acpResponse);
    expect(live).toHaveBeenCalledWith(
      {
        route: 'POST /workspace/permissions',
        workspaceCwd: h.workspace,
        originatorClientId: 'client-1',
      },
      {
        scope: 'user',
        ruleType: 'allow',
        rules: ['Bash(git status)'],
      },
    );
    expect(h.persistSetting).not.toHaveBeenCalled();
  });

  it('POST rejects invalid scope ruleType rules and malformed rule syntax', async () => {
    const invalidScope = await request(h.app)
      .post('/workspace/permissions')
      .send({ scope: 'system', ruleType: 'allow', rules: [] });
    expect(invalidScope.status).toBe(400);
    expect(invalidScope.body.code).toBe('invalid_scope');

    const invalidRuleType = await request(h.app)
      .post('/workspace/permissions')
      .send({ scope: 'user', ruleType: 'maybe', rules: [] });
    expect(invalidRuleType.status).toBe(400);
    expect(invalidRuleType.body.code).toBe('invalid_rule_type');

    const invalidRules = await request(h.app)
      .post('/workspace/permissions')
      .send({ scope: 'user', ruleType: 'allow', rules: 'Bash(git *)' });
    expect(invalidRules.status).toBe(400);
    expect(invalidRules.body.code).toBe('invalid_rules');

    const malformedRule = await request(h.app)
      .post('/workspace/permissions')
      .send({ scope: 'user', ruleType: 'allow', rules: ['Bash(git *'] });
    expect(malformedRule.status).toBe(400);
    expect(malformedRule.body.code).toBe('invalid_rule');
    expect(h.persistSetting).not.toHaveBeenCalled();
  });

  it('POST replaces one scoped rule list through a live ACP child and publishes settings_changed', async () => {
    const acpResponse = {
      v: 1,
      user: {
        path: path.join(h.home, 'settings.json'),
        rules: { allow: ['Bash(git status)'], ask: [], deny: [] },
      },
      workspace: {
        path: path.join(h.workspace, SETTINGS_DIRECTORY_NAME, 'settings.json'),
        rules: { allow: [], ask: [], deny: [] },
      },
      merged: { allow: ['Bash(git status)'], ask: [], deny: [] },
      isTrusted: true,
    };
    const live = vi.fn(async () => acpResponse);
    await teardown(h);
    h = await makeHarness({ setWorkspacePermissionRules: live });

    const res = await request(h.app)
      .post('/workspace/permissions')
      .set('X-Qwen-Client-Id', 'client-1')
      .send({
        scope: 'user',
        ruleType: 'allow',
        rules: [' Bash(git status) ', 'Bash(git status)'],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(acpResponse);
    expect(live).toHaveBeenCalledWith(
      {
        route: 'POST /workspace/permissions',
        workspaceCwd: h.workspace,
        originatorClientId: 'client-1',
      },
      {
        scope: 'user',
        ruleType: 'allow',
        rules: ['Bash(git status)'],
      },
    );
    expect(h.persistSetting).not.toHaveBeenCalled();
  });

  it('POST returns 409 when no ACP child is running', async () => {
    const res = await request(h.app)
      .post('/workspace/permissions')
      .send({
        scope: 'workspace',
        ruleType: 'deny',
        rules: [' Read(.env) ', 'Read(.env)', 'Bash(rm *)'],
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('permission_session_required');
    expect(h.setWorkspacePermissionRules).toHaveBeenCalled();
    expect(h.persistSetting).not.toHaveBeenCalled();
  });

  it('POST does not persist untrusted workspace rules without a live ACP child', async () => {
    await writeJson(path.join(h.home, 'settings.json'), {
      security: { folderTrust: { enabled: true } },
    });
    await writeJson(path.join(h.home, TRUSTED_FOLDERS_FILENAME), {
      [h.workspace]: TrustLevel.DO_NOT_TRUST,
    });
    resetTrustedFoldersForTesting();

    const res = await request(h.app)
      .post('/workspace/permissions')
      .send({
        scope: 'workspace',
        ruleType: 'deny',
        rules: ['Read(.env)'],
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('permission_session_required');
    expect(h.persistSetting).not.toHaveBeenCalled();
  });
});
