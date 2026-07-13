/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import { registerWorkspaceModelsRoutes } from './workspace-models.js';
import { loadSettings } from '../../config/settings.js';
import { WorkspaceSettingsPartialPersistError } from '../workspace-service/types.js';

let home: string;
let workspace: string;
let prevHome: string | undefined;

function writeUserSettings(settings: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(home, 'settings.json'),
    JSON.stringify(settings, null, 2),
  );
}

function readUserSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
}

function writeWorkspaceSettings(settings: Record<string, unknown>): void {
  const dir = path.join(workspace, '.qwen');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify(settings, null, 2),
  );
}

function readWorkspaceSettings(): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(workspace, '.qwen', 'settings.json'), 'utf8'),
  );
}

function makeApp(
  overrides: {
    parseAndValidateClientId?: (
      req: express.Request,
      res: express.Response,
    ) => string | undefined | null;
  } = {},
) {
  const app = express();
  app.use(express.json());
  const broadcastSettingsChanged = vi.fn();
  // Spy on the mutation wrapper so tests can assert the route requests strict
  // mutation gating (a regression that dropped `{ strict: true }` would
  // otherwise pass unnoticed with an unconditional pass-through).
  const mutate = vi.fn(
    (_opts?: { strict?: boolean }) =>
      (_req: express.Request, _res: express.Response, next: () => void) =>
        next(),
  );
  // Real persistence: mirrors the daemon's batch persist (setValues).
  const persistSettings = vi.fn(async (ws: string, writes) => {
    const fresh = loadSettings(ws);
    fresh.setValues(writes);
  });
  registerWorkspaceModelsRoutes(app, {
    boundWorkspace: workspace,
    mutate,
    safeBody: (req) =>
      req.body && typeof req.body === 'object' ? req.body : {},
    persistSettings,
    broadcastSettingsChanged,
    parseAndValidateClientId:
      overrides.parseAndValidateClientId ?? (() => undefined),
  });
  return { app, mutate, persistSettings, broadcastSettingsChanged };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-models-home-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-models-ws-'));
  prevHome = process.env['QWEN_HOME'];
  process.env['QWEN_HOME'] = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env['QWEN_HOME'];
  else process.env['QWEN_HOME'] = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('DELETE /workspace/models', () => {
  it('removes a model from ~/.qwen/settings.json and keeps siblings', async () => {
    writeUserSettings({
      modelProviders: {
        openai: [{ id: 'gpt-4o' }, { id: 'deepseek-v4' }],
      },
    });
    const { app, persistSettings, broadcastSettingsChanged } = makeApp();

    const res = await request(app)
      .delete('/workspace/models')
      .send({ authType: 'openai', modelId: 'gpt-4o' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      removed: true,
      clearedActiveModel: false,
    });
    expect(persistSettings).toHaveBeenCalledTimes(1);
    expect(broadcastSettingsChanged).toHaveBeenCalledWith(
      'modelProviders',
      { openai: [{ id: 'deepseek-v4' }] },
      'user',
      undefined,
    );
    const saved = readUserSettings();
    expect(saved['modelProviders']).toEqual({
      openai: [{ id: 'deepseek-v4' }],
    });
  });

  it('writes to the workspace scope when the workspace owns modelProviders', async () => {
    writeWorkspaceSettings({
      modelProviders: { openai: [{ id: 'gpt-4o' }, { id: 'deepseek-v4' }] },
    });
    const { app, broadcastSettingsChanged } = makeApp();

    const res = await request(app)
      .delete('/workspace/models')
      .send({ authType: 'openai', modelId: 'gpt-4o' });

    expect(res.status).toBe(200);
    expect(broadcastSettingsChanged).toHaveBeenCalledWith(
      'modelProviders',
      { openai: [{ id: 'deepseek-v4' }] },
      'workspace',
      undefined,
    );
    expect(readWorkspaceSettings()['modelProviders']).toEqual({
      openai: [{ id: 'deepseek-v4' }],
    });
  });

  it('clears the active model when the deleted model was selected', async () => {
    writeUserSettings({
      modelProviders: { openai: [{ id: 'gpt-4o' }] },
      model: { name: 'gpt-4o' },
    });
    const { app } = makeApp();

    const res = await request(app)
      .delete('/workspace/models')
      .send({ authType: 'openai', modelId: 'gpt-4o' });

    expect(res.status).toBe(200);
    expect(res.body.clearedActiveModel).toBe(true);
    const saved = readUserSettings();
    expect((saved['model'] as { name?: string }).name).toBe('');
    expect(saved['modelProviders']).toEqual({ openai: [] });
  });

  it('registers the route behind strict mutation gating', async () => {
    writeUserSettings({ modelProviders: { openai: [{ id: 'gpt-4o' }] } });
    const { app, mutate } = makeApp();
    // Force registration to run the handler at least once.
    await request(app)
      .delete('/workspace/models')
      .send({ authType: 'openai', modelId: 'gpt-4o' });
    expect(mutate).toHaveBeenCalledWith({ strict: true });
  });

  it('aborts without persisting when client-id validation rejects', async () => {
    writeUserSettings({ modelProviders: { openai: [{ id: 'gpt-4o' }] } });
    const { app, persistSettings, broadcastSettingsChanged } = makeApp({
      // Emulate the daemon writing a 4xx and returning null to signal "handled".
      parseAndValidateClientId: (_req, res) => {
        res.status(400).json({ error: 'bad client id' });
        return null;
      },
    });

    const res = await request(app)
      .delete('/workspace/models')
      .send({ authType: 'openai', modelId: 'gpt-4o' });

    expect(res.status).toBe(400);
    expect(persistSettings).not.toHaveBeenCalled();
    expect(broadcastSettingsChanged).not.toHaveBeenCalled();
  });

  it('forwards the validated client id to broadcasts so the origin is skipped', async () => {
    writeUserSettings({ modelProviders: { openai: [{ id: 'gpt-4o' }] } });
    const { app, broadcastSettingsChanged } = makeApp({
      parseAndValidateClientId: () => 'client-123',
    });

    const res = await request(app)
      .delete('/workspace/models')
      .send({ authType: 'openai', modelId: 'gpt-4o' });

    expect(res.status).toBe(200);
    expect(broadcastSettingsChanged).toHaveBeenCalledWith(
      'modelProviders',
      { openai: [] },
      'user',
      'client-123',
    );
  });

  it('returns 404 when the model is not configured', async () => {
    writeUserSettings({ modelProviders: { openai: [{ id: 'gpt-4o' }] } });
    const { app, persistSettings } = makeApp();

    const res = await request(app)
      .delete('/workspace/models')
      .send({ authType: 'openai', modelId: 'missing' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'model_not_found' });
    expect(persistSettings).not.toHaveBeenCalled();
  });

  it('clears the active model by base id even when a baseUrl is pinned', async () => {
    writeUserSettings({
      modelProviders: {
        openai: [{ id: 'gpt-4o', baseUrl: 'https://api.openai.com' }],
      },
      model: { name: 'gpt-4o', baseUrl: 'https://api.openai.com' },
    });
    const { app } = makeApp();

    const res = await request(app).delete('/workspace/models').send({
      authType: 'openai',
      modelId: 'gpt-4o',
      baseUrl: 'https://api.openai.com',
    });

    expect(res.status).toBe(200);
    expect(res.body.clearedActiveModel).toBe(true);
    const saved = readUserSettings();
    const model = saved['model'] as { name?: string; baseUrl?: string };
    expect(model.name).toBe('');
    expect(model.baseUrl).toBe('');
  });

  it('rejects a request missing modelId', async () => {
    writeUserSettings({ modelProviders: { openai: [{ id: 'gpt-4o' }] } });
    const { app, persistSettings } = makeApp();

    const res = await request(app)
      .delete('/workspace/models')
      .send({ authType: 'openai' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'invalid_model_id' });
    expect(persistSettings).not.toHaveBeenCalled();
  });

  const invalidCases: Array<[Record<string, unknown>, string]> = [
    [{ modelId: 'gpt-4o' }, 'invalid_auth_type'],
    [
      { authType: 'openai', modelId: 'gpt-4o', baseUrl: 42 },
      'invalid_base_url',
    ],
    [{ authType: 'a'.repeat(2000), modelId: 'gpt-4o' }, 'invalid_field'],
  ];
  it.each(invalidCases)('rejects invalid input (%o)', async (payload, code) => {
    writeUserSettings({ modelProviders: { openai: [{ id: 'gpt-4o' }] } });
    const { app, persistSettings } = makeApp();

    const res = await request(app).delete('/workspace/models').send(payload);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code });
    expect(persistSettings).not.toHaveBeenCalled();
  });

  it('returns 500 when persistence fails', async () => {
    writeUserSettings({ modelProviders: { openai: [{ id: 'gpt-4o' }] } });
    const { app, persistSettings, broadcastSettingsChanged } = makeApp();
    persistSettings.mockRejectedValueOnce(new Error('disk full'));

    const res = await request(app)
      .delete('/workspace/models')
      .send({ authType: 'openai', modelId: 'gpt-4o' });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'internal_error' });
    expect(broadcastSettingsChanged).not.toHaveBeenCalled();
  });

  it('broadcasts committed writes on a partial persistence failure', async () => {
    writeUserSettings({
      modelProviders: { openai: [{ id: 'gpt-4o' }] },
      model: { name: 'gpt-4o' },
    });
    const { app, persistSettings, broadcastSettingsChanged } = makeApp();
    persistSettings.mockImplementationOnce(async (_ws, writes) => {
      // modelProviders committed, model.name/baseUrl did not.
      throw new WorkspaceSettingsPartialPersistError(
        'partial',
        [writes[0]],
        new Error('disk full'),
      );
    });

    const res = await request(app)
      .delete('/workspace/models')
      .send({ authType: 'openai', modelId: 'gpt-4o' });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      code: 'partial_persist_error',
      committedKeys: ['modelProviders'],
    });
    // The committed modelProviders write is broadcast; the uncommitted ones are not.
    expect(broadcastSettingsChanged).toHaveBeenCalledTimes(1);
    expect(broadcastSettingsChanged).toHaveBeenCalledWith(
      'modelProviders',
      { openai: [] },
      'user',
      undefined,
    );
  });

  it('trims whitespace-padded fields before matching', async () => {
    writeUserSettings({
      modelProviders: { openai: [{ id: 'gpt-4o' }, { id: 'deepseek-v4' }] },
    });
    const { app } = makeApp();

    const res = await request(app)
      .delete('/workspace/models')
      .send({ authType: '  openai ', modelId: ' gpt-4o  ' });

    expect(res.status).toBe(200);
    expect(readUserSettings()['modelProviders']).toEqual({
      openai: [{ id: 'deepseek-v4' }],
    });
  });

  it('scrubs the deleted model from modelFallbacks', async () => {
    writeUserSettings({
      modelProviders: { openai: [{ id: 'gpt-4o' }, { id: 'deepseek-v4' }] },
      modelFallbacks: 'gpt-4o,deepseek-v4',
    });
    const { app, broadcastSettingsChanged } = makeApp();

    const res = await request(app)
      .delete('/workspace/models')
      .send({ authType: 'openai', modelId: 'gpt-4o' });

    expect(res.status).toBe(200);
    // modelFallbacks requiresRestart, so the response flags it.
    expect(res.body.requiresRestart).toBe(true);
    expect(readUserSettings()['modelFallbacks']).toBe('deepseek-v4');
    expect(broadcastSettingsChanged).toHaveBeenCalledWith(
      'modelFallbacks',
      'deepseek-v4',
      'user',
      undefined,
    );
  });

  it('clears a workspace-scoped active selection when providers are user-owned', async () => {
    // modelProviders live in user scope, but the active model selection lives in
    // workspace scope. Clearing must target the workspace scope, since a
    // user-scope tombstone wouldn't override the higher-precedence workspace
    // value.
    writeUserSettings({ modelProviders: { openai: [{ id: 'gpt-4o' }] } });
    writeWorkspaceSettings({ model: { name: 'gpt-4o' } });
    const { app, broadcastSettingsChanged } = makeApp();

    const res = await request(app)
      .delete('/workspace/models')
      .send({ authType: 'openai', modelId: 'gpt-4o' });

    expect(res.status).toBe(200);
    expect(res.body.clearedActiveModel).toBe(true);
    // Providers emptied in user scope; active selection cleared in workspace.
    expect(readUserSettings()['modelProviders']).toEqual({ openai: [] });
    expect((readWorkspaceSettings()['model'] as { name?: string }).name).toBe(
      '',
    );
    expect(broadcastSettingsChanged).toHaveBeenCalledWith(
      'model.name',
      '',
      'workspace',
      undefined,
    );
  });

  it('clears the active model when the stored baseUrl carries credentials the request sanitized', async () => {
    // The providers status sanitizes credential-bearing URLs, so the delete
    // target's baseUrl differs from the stored one. Removal still succeeds via
    // the id-only fallback, and the active clear must compare against the stored
    // (raw) baseUrl — not the sanitized request — to recognize the selection.
    writeUserSettings({
      modelProviders: {
        openai: [{ id: 'gpt-4o', baseUrl: 'https://key@api.example.com' }],
      },
      model: { name: 'gpt-4o', baseUrl: 'https://key@api.example.com' },
    });
    const { app } = makeApp();

    const res = await request(app).delete('/workspace/models').send({
      authType: 'openai',
      modelId: 'gpt-4o',
      baseUrl: 'https://api.example.com',
    });

    expect(res.status).toBe(200);
    expect(res.body.clearedActiveModel).toBe(true);
    const model = readUserSettings()['model'] as {
      name?: string;
      baseUrl?: string;
    };
    expect(model.name).toBe('');
    expect(model.baseUrl).toBe('');
  });

  it('scrubs modelFallbacks in its own owning scope, not the providers scope', async () => {
    // Providers are user-owned but modelFallbacks lives in workspace scope; the
    // scrub must read and rewrite the workspace value.
    writeUserSettings({
      modelProviders: { openai: [{ id: 'gpt-4o' }, { id: 'deepseek-v4' }] },
    });
    writeWorkspaceSettings({ modelFallbacks: 'gpt-4o,deepseek-v4' });
    const { app, broadcastSettingsChanged } = makeApp();

    const res = await request(app)
      .delete('/workspace/models')
      .send({ authType: 'openai', modelId: 'gpt-4o' });

    expect(res.status).toBe(200);
    expect(readWorkspaceSettings()['modelFallbacks']).toBe('deepseek-v4');
    // The user scope never carried modelFallbacks, so it isn't written there.
    expect(readUserSettings()['modelFallbacks']).toBeUndefined();
    expect(broadcastSettingsChanged).toHaveBeenCalledWith(
      'modelFallbacks',
      'deepseek-v4',
      'workspace',
      undefined,
    );
  });

  it('keeps a fallback when another provider still has the same base id', async () => {
    writeUserSettings({
      modelProviders: {
        openai: [
          { id: 'gpt-4o', baseUrl: 'https://api.openai.com' },
          { id: 'gpt-4o', baseUrl: 'https://azure.example' },
        ],
      },
      modelFallbacks: 'gpt-4o,deepseek-v4',
    });
    const { app, broadcastSettingsChanged } = makeApp();

    const res = await request(app).delete('/workspace/models').send({
      authType: 'openai',
      modelId: 'gpt-4o',
      baseUrl: 'https://api.openai.com',
    });

    expect(res.status).toBe(200);
    // The other gpt-4o variant remains, so the bare-id fallback is kept.
    expect(readUserSettings()['modelFallbacks']).toBe('gpt-4o,deepseek-v4');
    expect(res.body.requiresRestart).toBe(false);
    expect(broadcastSettingsChanged).not.toHaveBeenCalledWith(
      'modelFallbacks',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});
