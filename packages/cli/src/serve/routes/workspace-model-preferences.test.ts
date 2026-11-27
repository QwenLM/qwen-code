/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getModelPreferenceKey } from '@qwen-code/qwen-code-core/models/model-preferences.js';
import { readSettingsSnapshot } from '../../config/settings.js';
import { parseJsoncObject } from '../../utils/jsonc-editor.js';
import * as stdio from '../../utils/stdioHelpers.js';
import {
  createWorkspaceGenerationGuard,
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import type { WorkspaceSettingsWrites } from '../workspace-service/types.js';
import { registerWorkspaceModelPreferencesRoutes } from './workspace-model-preferences.js';

const route = '/workspace/model-preferences';
const endpoint = 'https://provider.example/v1';
const key = getModelPreferenceKey('openai', 'chat-a', endpoint);
const otherKey = getModelPreferenceKey('openai', 'chat-b', endpoint);
const modelProviders = {
  openai: [
    {
      id: 'chat-a',
      baseUrl: endpoint,
      generationConfig: { contextWindowSize: 200000 },
      capabilities: {
        reasoning: {
          profile: 'openai-effort',
          efforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
        },
      },
    },
    {
      id: 'chat-b',
      baseUrl: endpoint,
      generationConfig: { contextWindowSize: 200000 },
    },
  ],
};

let directory: string;
let workspace: string;
let userFile: string;
let workspaceFile: string;
let env: NodeJS.ProcessEnv;

function writeSettings(file: string, settings: Record<string, unknown>) {
  fs.writeFileSync(file, JSON.stringify({ $version: 4, ...settings }, null, 2));
}

function makeApp(writeError?: Error) {
  const app = express();
  app.use(express.json());
  const runtime = {
    workspaceId: 'local',
    workspaceCwd: workspace,
    primary: true,
    trusted: true,
    generationGuard: createWorkspaceGenerationGuard(),
    bridge: { knownClientIds: () => new Set(['browser']) },
    routeFileSystemFactory: {},
  } as unknown as WorkspaceRuntime;
  const broadcast = vi.fn();
  const mutate = vi.fn(
    (_options?: { strict?: boolean }): express.RequestHandler =>
      (_req, _res, next) =>
        next(),
  );
  const persistSettings = vi.fn(
    async (
      cwd: string,
      writes: WorkspaceSettingsWrites,
      assertOpen?: () => void,
      snapshotEnvironment?: Readonly<NodeJS.ProcessEnv>,
    ) => {
      assertOpen?.();
      const fresh = readSettingsSnapshot(cwd, {
        environment: snapshotEnvironment ?? env,
        workspaceTrusted: true,
      });
      if (writeError) throw writeError;
      fresh.setValues(
        typeof writes === 'function' ? writes(fresh) : writes,
        undefined,
        assertOpen,
      );
    },
  );
  registerWorkspaceModelPreferencesRoutes(app, {
    workspaceRegistry: createWorkspaceRegistry([runtime]),
    mutate,
    getEnv: () => env,
    persistSettings,
    broadcast,
  });
  return { app, broadcast, mutate, persistSettings };
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-model-preferences-'));
  workspace = path.join(directory, 'workspace');
  const home = path.join(directory, 'user');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
  userFile = path.join(home, 'settings.json');
  workspaceFile = path.join(workspace, '.qwen', 'settings.json');
  env = {
    QWEN_HOME: home,
    QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(directory, 'system.json'),
    QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(
      directory,
      'system-defaults.json',
    ),
    OPENAI_API_KEY: 'test-key',
  };
  writeSettings(userFile, {
    security: { auth: { selectedType: 'openai' } },
    model: { name: 'chat-a' },
    modelProviders,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('workspace model preferences', () => {
  it('reports effective and inherited fields by scope and rejects a policy-locked edit', async () => {
    writeSettings(env['QWEN_CODE_SYSTEM_DEFAULTS_PATH']!, {
      model: { preferences: { [key]: { contextWindow: 128000 } } },
    });
    writeSettings(env['QWEN_CODE_SYSTEM_SETTINGS_PATH']!, {
      model: { preferences: { [key]: { reasoning: { effort: 'high' } } } },
    });
    writeSettings(userFile, {
      modelProviders,
      model: {
        name: 'chat-a',
        preferences: { [key]: { reasoning: { enabled: true } } },
      },
    });
    writeSettings(workspaceFile, {
      model: { preferences: { [key]: { contextWindow: 96000 } } },
    });

    const { app, broadcast } = makeApp();
    const response = await request(app).get(
      '/workspaces/local/model-preferences',
    );
    expect(response.status).toBe(200);
    const model = response.body.models.find(
      (model: { key: string }) => model.key === key,
    );
    expect(model).toMatchObject({
      locked: ['effort'],
      values: {
        user: { reasoning: { enabled: true } },
        workspace: { contextWindow: 96000 },
        userEffective: {
          contextWindow: 128000,
          reasoning: { enabled: true, effort: 'high' },
        },
        effective: {
          contextWindow: 96000,
          reasoning: { enabled: true, effort: 'high' },
        },
        inherited: {
          user: { contextWindow: 128000 },
          workspace: { contextWindow: 128000 },
        },
      },
      sources: {
        contextWindow: 'workspace',
        enabled: 'user',
        effort: 'system',
      },
      inheritedSources: {
        user: { contextWindow: 'system', enabled: 'model', effort: 'system' },
        workspace: {
          contextWindow: 'system',
          enabled: 'user',
          effort: 'system',
        },
      },
    });

    const before = fs.readFileSync(workspaceFile, 'utf8');
    const result = await request(app)
      .patch(route)
      .send({
        scope: 'workspace',
        changes: [{ key, reasoning: { effort: null } }],
      });
    expect(result.status).toBe(403);
    expect(result.body.error).toBe(
      'This model preference is managed by policy',
    );
    expect(fs.readFileSync(workspaceFile, 'utf8')).toBe(before);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('removes individual fields and empty model entries from disk, preserving siblings', async () => {
    const user = parseJsoncObject(fs.readFileSync(userFile, 'utf8'));
    writeSettings(userFile, {
      ...user,
      model: {
        name: 'chat-a',
        preferences: { [key]: { contextWindow: 128000 } },
      },
    });
    fs.writeFileSync(
      workspaceFile,
      `{
  "$version": 4,
  // Retained setting
  "general": { "language": "en" },
  "model": {
    "name": "chat-a",
    "preferences": {
      "${key}": { "contextWindow": 96000, "reasoning": { "enabled": true, "effort": "high" } },
      "${otherKey}": { "contextWindow": 64000 },
      "openai/deleted-model": { "contextWindow": 48000 }
    }
  }
}
`,
    );

    const { app, broadcast, persistSettings, mutate } = makeApp();
    const result = await request(app)
      .patch(route)
      .set('X-Qwen-Client-Id', 'browser')
      .send({
        scope: 'workspace',
        changes: [
          { key, contextWindow: null, reasoning: { effort: null } },
          { key: otherKey, contextWindow: null },
        ],
      });
    expect(result.status).toBe(200);
    expect(mutate).toHaveBeenCalledWith({ strict: true });
    const saved = fs.readFileSync(workspaceFile, 'utf8');
    expect(saved).toContain('// Retained setting');
    expect(parseJsoncObject(saved)).toEqual({
      $version: 4,
      general: { language: 'en' },
      model: {
        name: 'chat-a',
        preferences: {
          [key]: { reasoning: { enabled: true } },
          'openai/deleted-model': { contextWindow: 48000 },
        },
      },
    });
    expect(persistSettings).toHaveBeenCalledWith(
      workspace,
      expect.any(Function),
      expect.any(Function),
      env,
    );
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: workspace }),
      'workspace',
      'browser',
    );

    const readback = await request(app).get(route);
    expect(readback.status).toBe(200);
    const model = readback.body.models.find(
      (model: { key: string }) => model.key === key,
    );
    expect(model.values.workspace).toEqual({ reasoning: { enabled: true } });
    expect(model.values.effective.contextWindow).toBe(128000);
    expect(model.sources.contextWindow).toBe('user');
    expect(
      readback.body.models.find(
        (model: { key: string }) => model.key === otherKey,
      ).values.workspace,
    ).toEqual({});
  });

  it.each([
    ['a missing scope', { changes: [{ key, contextWindow: 1000 }] }],
    ['an empty batch', { scope: 'user', changes: [] }],
    [
      'a duplicate key',
      {
        scope: 'user',
        changes: [
          { key, contextWindow: 1000 },
          { key, contextWindow: 2000 },
        ],
      },
    ],
    ['a zero limit', { scope: 'user', changes: [{ key, contextWindow: 0 }] }],
    [
      'a fractional limit',
      { scope: 'user', changes: [{ key, contextWindow: 1.5 }] },
    ],
    [
      'an unknown effort',
      { scope: 'user', changes: [{ key, reasoning: { effort: 'turbo' } }] },
    ],
    [
      'an unsupported effort',
      {
        scope: 'user',
        changes: [{ key: otherKey, reasoning: { effort: 'high' } }],
      },
    ],
  ] as const)('rejects %s', async (_name, payload) => {
    const { app, broadcast } = makeApp();
    const before = fs.readFileSync(userFile, 'utf8');
    const response = await request(app).patch(route).send(payload);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid_model_preferences');
    expect(fs.readFileSync(userFile, 'utf8')).toBe(before);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each([
    [400, { key: otherKey, contextWindow: 200001 }],
    [
      409,
      {
        key: getModelPreferenceKey(
          'openai',
          'chat-b',
          'https://old.example/v1',
        ),
        contextWindow: 64000,
      },
    ],
  ] as const)(
    'leaves the whole batch unchanged on %s',
    async (status, second) => {
      writeSettings(workspaceFile, {
        model: { preferences: { [key]: { contextWindow: 128000 } } },
      });
      const before = fs.readFileSync(workspaceFile, 'utf8');
      const { app, broadcast } = makeApp();
      const response = await request(app)
        .patch(route)
        .send({
          scope: 'workspace',
          changes: [{ key, contextWindow: 96000 }, second],
        });
      expect(response.status).toBe(status);
      expect(fs.readFileSync(workspaceFile, 'utf8')).toBe(before);
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it('accepts only the effective endpoint key for an implicit route', async () => {
    const proxy = 'https://proxy.example/v1';
    env['OPENAI_BASE_URL'] = proxy;
    writeSettings(userFile, {
      model: { name: 'chat-a' },
      modelProviders: {
        openai: [{ ...modelProviders.openai[0], baseUrl: undefined }],
      },
    });
    const { app } = makeApp();
    const oldKey = getModelPreferenceKey(
      'openai',
      'chat-a',
      'https://api.openai.com/v1',
    );
    const newKey = getModelPreferenceKey('openai', 'chat-a', proxy);
    const update = (key: string) =>
      request(app)
        .patch(route)
        .send({
          scope: 'user',
          changes: [{ key, contextWindow: 128000 }],
        });
    expect((await update(oldKey)).status).toBe(409);
    const updated = await update(newKey);
    expect(updated.status).toBe(200);
    expect(
      updated.body.models.find(
        (model: { key: string }) => model.key === newKey,
      ),
    ).toMatchObject({
      values: {
        user: { contextWindow: 128000 },
        effective: { contextWindow: 128000 },
      },
    });
  });

  it('reports malformed settings as a read failure and leaves them untouched', async () => {
    const content = '{invalid settings';
    fs.writeFileSync(workspaceFile, content);
    const stderr = vi
      .spyOn(stdio, 'writeStderrLine')
      .mockImplementation(() => {});
    const { app, broadcast } = makeApp();
    const response = await request(app).get(route);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: 'Unable to load model preferences',
    });
    expect(stderr.mock.calls[0]?.[0]).toContain('settings.json');
    const patch = await request(app)
      .patch(route)
      .send({
        scope: 'workspace',
        changes: [{ key, contextWindow: 128000 }],
      });
    expect(patch.status).toBe(500);
    expect(fs.readFileSync(workspaceFile, 'utf8')).toBe(content);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('writes a bounded, redacted write diagnostic without returning its details', async () => {
    const stderr = vi
      .spyOn(stdio, 'writeStderrLine')
      .mockImplementation(() => {});
    const message = `Write failed for https://user:credential@proxy.example/v1\u001b[31m Bearer example-secret\n ${'x'.repeat(1000)}`;
    const { app, broadcast } = makeApp(new Error(message));
    const response = await request(app)
      .patch(route)
      .send({
        scope: 'workspace',
        changes: [{ key, contextWindow: 128000 }],
      });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: 'Unable to update model preferences',
    });
    const diagnostic = stderr.mock.calls[0]?.[0] ?? '';
    expect(diagnostic).toContain('Write failed for');
    expect(diagnostic).toContain('proxy.example');
    expect(diagnostic).not.toMatch(/credential|example-secret|\n/);
    expect(diagnostic).not.toContain('\u001b');
    expect(diagnostic.length).toBeLessThan(600);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
