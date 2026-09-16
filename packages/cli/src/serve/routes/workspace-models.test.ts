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
import type { WorkspaceSettingsWrite } from '../workspace-service/types.js';
import { registerWorkspaceModelsRoutes } from './workspace-models.js';
import { updateModelContextWindow } from '../model-configuration.js';
import { loadSettings, SettingScope } from '../../config/settings.js';
import { WorkspaceSettingsPartialPersistError } from '../workspace-service/types.js';
import { WorkspaceGenerationClosedError } from '../workspace-registry.js';
import * as jsoncEditor from '../../utils/jsonc-editor.js';

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
    captureGenerationAssertion?: () => (() => void) | undefined;
    afterPersist?: () => void;
    beforePersist?: () => Promise<void>;
    trusted?: boolean;
    syncModelProvidersRuntime?: () => Promise<{
      status: 'applied' | 'deferred' | 'failed';
    }>;
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
  const load = (ws: string) =>
    loadSettings(ws, {
      skipLoadEnvironment: true,
      workspaceTrusted: overrides.trusted ?? true,
      skipWorkspaceSettings: overrides.trusted === false,
    });
  const persistSettings = vi.fn(
    async (
      ws: string,
      writes: WorkspaceSettingsWrite[],
      assertOpen?: () => void,
    ) => {
      await overrides.beforePersist?.();
      assertOpen?.();
      const fresh = load(ws);
      fresh.setValues(writes, undefined, assertOpen);
      overrides.afterPersist?.();
    },
  );
  registerWorkspaceModelsRoutes(app, {
    boundWorkspace: workspace,
    isWorkspaceTrusted: () => overrides.trusted ?? true,
    mutate,
    safeBody: (req) =>
      req.body && typeof req.body === 'object' ? req.body : {},
    persistSettings,
    updateModelContextWindow: async (ws, key, size, assertOpen) =>
      updateModelContextWindow(load(ws), key, size, assertOpen),
    broadcastSettingsChanged,
    parseAndValidateClientId:
      overrides.parseAndValidateClientId ?? (() => undefined),
    captureGenerationAssertion: overrides.captureGenerationAssertion,
    ...(overrides.syncModelProvidersRuntime
      ? { syncModelProvidersRuntime: overrides.syncModelProvidersRuntime }
      : {}),
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
  it.each([
    ['QWEN_CODE_SYSTEM_SETTINGS_PATH', 'openai'],
    ['QWEN_CODE_SYSTEM_DEFAULTS_PATH', 'managed'],
  ])(
    'requires the saved key to delete an alias sharing a read-only route (%s)',
    async (variable, provider) => {
      const model = { id: 'shared', baseUrl: 'https://models.example/v1' };
      writeUserSettings({
        providerProtocol: { gateway: 'openai', managed: 'openai' },
        modelProviders: { openai: [], gateway: [model] },
        model: { name: model.id, baseUrl: model.baseUrl },
      });
      const systemFile = path.join(home, 'system-models.json');
      const system = JSON.stringify({
        $version: 4,
        modelProviders: { [provider]: [model] },
      });
      fs.writeFileSync(systemFile, system);
      vi.stubEnv(variable, systemFile);
      try {
        const { app, persistSettings } = makeApp();
        const listed = await request(app).get('/workspace/models');
        const target = listed.body.models[0];
        expect(listed.body.models).toHaveLength(1);
        expect(
          (
            await request(app).delete('/workspace/models').send({
              authType: 'openai',
              modelId: model.id,
              baseUrl: model.baseUrl,
            })
          ).status,
        ).toBe(409);
        expect(
          (
            await request(app).patch('/workspace/models').send({
              key: target.key,
              contextWindowSize: 65536,
            })
          ).status,
        ).toBe(409);
        expect(persistSettings).not.toHaveBeenCalled();
        expect(readUserSettings()['modelProviders']).toEqual({
          openai: [],
          gateway: [model],
        });
        const deleted = await request(app)
          .delete('/workspace/models')
          .send(target);
        expect(deleted.status).toBe(200);
        expect(deleted.body.clearedActiveModel).toBe(false);
        expect(readUserSettings()['modelProviders']).toEqual({
          openai: [],
          gateway: [],
        });
        expect(readUserSettings()['model']).toEqual({
          name: model.id,
          baseUrl: model.baseUrl,
        });
        expect(fs.readFileSync(systemFile, 'utf8')).toBe(system);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.each(
    ['imageOnly', 'voiceOnly', 'fastOnly', 'visionOnly'].flatMap(
      (purpose) =>
        [
          [purpose, false],
          [purpose, true],
        ] as const,
    ),
  )(
    'clears primary selection when the winning alias is %s (shadowed chat: %s)',
    async (purpose, shadowedChat) => {
      const model = { id: 'shared', baseUrl: 'https://models.example/v1' };
      writeUserSettings({
        providerProtocol: { service: 'openai', spare: 'openai' },
        modelProviders: {
          openai: [model, { id: 'fallback' }],
          service: [{ ...model, name: 'service-alias', [purpose]: true }],
          ...(shadowedChat
            ? { spare: [{ ...model, name: 'shadowed-chat' }] }
            : {}),
        },
        model: { name: model.id, baseUrl: model.baseUrl },
      });
      const { app } = makeApp();
      const listed = await request(app).get('/workspace/models');
      const target = listed.body.models.find(
        (entry: { modelId: string; name?: string }) =>
          entry.modelId === model.id && !entry.name,
      );
      const deleted = await request(app)
        .delete('/workspace/models')
        .send(target);
      expect(deleted.status).toBe(200);
      expect(deleted.body.clearedActiveModel).toBe(true);
      expect(readUserSettings()['model']).toEqual({ name: '', baseUrl: '' });
      expect(readUserSettings()['modelProviders']).toEqual({
        openai: [{ id: 'fallback' }],
        service: [{ ...model, name: 'service-alias', [purpose]: true }],
        ...(shadowedChat
          ? { spare: [{ ...model, name: 'shadowed-chat' }] }
          : {}),
      });
    },
  );

  it.each<{
    flags: Record<string, boolean | string>;
    keeps: string[];
  }>([
    {
      flags: {},
      keeps: [
        'imageModel',
        'advisorModel',
        'visionModel',
        'fastModel',
        'compactionModel',
      ],
    },
    { flags: { imageOnly: true }, keeps: ['imageModel'] },
    { flags: { voiceOnly: true }, keeps: [] },
    { flags: { fastOnly: true }, keeps: ['fastModel'] },
    { flags: { visionOnly: true }, keeps: ['imageModel', 'visionModel'] },
    {
      flags: { supportsImageGeneration: false },
      keeps: ['advisorModel', 'visionModel', 'fastModel', 'compactionModel'],
    },
    {
      flags: { envKey: '' },
      keeps: ['advisorModel', 'visionModel', 'fastModel', 'compactionModel'],
    },
  ])(
    'preserves only role-eligible survivors with $flags',
    async ({ flags, keeps }) => {
      const model = {
        id: 'shared',
        baseUrl: 'https://models.example/v1',
        envKey: 'MODEL_KEY',
        supportsImageGeneration: true,
      };
      const pins = {
        imageModel: `openai:${model.id}\0${model.baseUrl}`,
        advisorModel: `openai:${model.id}\0${model.baseUrl}`,
        visionModel: `openai:${model.id}\0${model.baseUrl}`,
        fastModel: `openai:${model.id}`,
        compactionModel: `openai:${model.id}`,
      };
      writeUserSettings({
        providerProtocol: { alternate: 'openai' },
        modelProviders: {
          openai: [model],
          alternate: [{ ...model, ...flags }],
        },
        ...pins,
        voiceModel: model.id,
        modelFallbacks: model.id,
      });
      const { app, persistSettings } = makeApp();
      const listed = await request(app).get('/workspace/models');
      const deleted = await request(app)
        .delete('/workspace/models')
        .send(listed.body.models[0]);
      expect(deleted.status).toBe(200);
      expect(readUserSettings()).toMatchObject({
        modelProviders: { openai: [], alternate: [{ ...model, ...flags }] },
        voiceModel: model.id,
        modelFallbacks: model.id,
        ...Object.fromEntries(
          Object.entries(pins).map(([key, value]) => [
            key,
            keeps.includes(key) ? value : '',
          ]),
        ),
      });
      const cleared = persistSettings.mock.calls[0]![1].filter(
        (write) => write.key !== 'modelProviders',
      ).map((write) => write.key);
      expect(cleared).toEqual(
        Object.keys(pins).filter((key) => !keeps.includes(key)),
      );
    },
  );

  it.each([false, true])(
    'uses the first registered survivor for role cleanup (eligible first: %s)',
    async (eligibleFirst) => {
      const model = {
        id: 'shared',
        baseUrl: 'https://models.example/v1',
        envKey: 'MODEL_KEY',
        supportsImageGeneration: true,
      };
      const voice = { ...model, voiceOnly: true };
      const survivors = eligibleFirst ? [model, voice] : [voice, model];
      const pins = {
        imageModel: `openai:${model.id}\0${model.baseUrl}`,
        advisorModel: `openai:${model.id}\0${model.baseUrl}`,
        visionModel: `openai:${model.id}\0${model.baseUrl}`,
        fastModel: `openai:${model.id}`,
        compactionModel: `openai:${model.id}`,
      };
      writeUserSettings({
        providerProtocol: { first: 'openai', second: 'openai' },
        modelProviders: {
          openai: [model],
          first: [survivors[0]],
          second: [survivors[1]],
        },
        model: { name: model.id, baseUrl: model.baseUrl },
        ...pins,
      });
      const { app } = makeApp();
      const listed = await request(app).get('/workspace/models');
      const deleted = await request(app)
        .delete('/workspace/models')
        .send(listed.body.models[0]);
      expect(deleted.status).toBe(200);
      expect(deleted.body.clearedActiveModel).toBe(!eligibleFirst);
      expect(readUserSettings()).toMatchObject({
        model: eligibleFirst
          ? { name: model.id, baseUrl: model.baseUrl }
          : { name: '', baseUrl: '' },
        ...Object.fromEntries(
          Object.entries(pins).map(([key, value]) => [
            key,
            eligibleFirst ? value : '',
          ]),
        ),
      });
    },
  );

  it.each(['sanitized URLs', 'provider keys'])(
    'deletes only the selected configuration despite same-id collisions (%s)',
    async (collision) => {
      const separateProviders = collision === 'provider keys';
      const first = {
        id: 'shared',
        baseUrl: separateProviders
          ? 'https://api.example/v1'
          : 'https://one:secret@api.example/v1?token=one',
      };
      const second = {
        id: 'shared',
        baseUrl: separateProviders
          ? first.baseUrl
          : 'https://two:secret@api.example/v1?token=two',
      };
      writeUserSettings({
        providerProtocol: { alternate: 'openai' },
        modelProviders: separateProviders
          ? { openai: [first], alternate: [second] }
          : { openai: [first, second] },
      });
      const { app } = makeApp();
      const listed = await request(app).get('/workspace/models');
      expect(listed.status).toBe(200);
      const [keep, target] = listed.body.models;
      expect(target.key).not.toBe(keep.key);
      expect(target.baseUrl).toBe(keep.baseUrl);
      const before = fs.readFileSync(path.join(home, 'settings.json'), 'utf8');
      const keyless = {
        authType: target.authType,
        modelId: target.modelId,
        baseUrl: target.baseUrl,
      };
      expect(
        (await request(app).delete('/workspace/models').send(keyless)).status,
      ).toBe(409);
      expect(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).toBe(
        before,
      );
      const result = await request(app)
        .delete('/workspace/models')
        .send(target);
      expect(result.status).toBe(200);
      expect(readUserSettings()['modelProviders']).toEqual(
        separateProviders
          ? { openai: [first], alternate: [] }
          : { openai: [first] },
      );
      const remaining = await request(app).get('/workspace/models');
      expect(remaining.body.models).toHaveLength(1);
      expect(remaining.body.models[0].key).toBe(keep.key);
    },
  );

  it('rejects a stale deletion after another client saves a context window', async () => {
    writeUserSettings({
      modelProviders: {
        openai: [
          { id: 'keep', generationConfig: { contextWindowSize: 8192 } },
          { id: 'remove' },
        ],
      },
    });
    let release!: () => void;
    let reached!: () => void;
    const parked = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app, broadcastSettingsChanged } = makeApp({
      beforePersist: async () => {
        reached();
        await barrier;
      },
    });
    const listed = await request(app).get('/workspace/models');
    const [keep, target] = listed.body.models;
    const deletion = request(app)
      .delete('/workspace/models')
      .send(target)
      .then((response) => response);
    await parked;
    try {
      const patch = await request(app)
        .patch('/workspace/models')
        .send({ key: keep.key, contextWindowSize: 65536 });
      expect(patch.status).toBe(200);
    } finally {
      release();
    }
    expect((await deletion).status).toBe(409);
    expect(readUserSettings()['modelProviders']).toEqual({
      openai: [
        { id: 'keep', generationConfig: { contextWindowSize: 65536 } },
        { id: 'remove' },
      ],
    });
    expect(broadcastSettingsChanged).toHaveBeenCalledTimes(1);
  });

  it('keeps raw placeholders when deleting another model', async () => {
    vi.stubEnv('MODEL_DELETE_TEST_SECRET', 'resolved-test-secret');
    try {
      const sibling = { id: 'keep', apiKey: '${MODEL_DELETE_TEST_SECRET}' };
      writeUserSettings({
        modelProviders: { openai: [sibling, { id: 'remove' }] },
      });
      const { app } = makeApp();
      const listed = await request(app).get('/workspace/models');
      const response = await request(app)
        .delete('/workspace/models')
        .send(listed.body.models[1]);
      expect(response.status).toBe(200);
      expect(readUserSettings()['modelProviders']).toEqual({
        openai: [sibling],
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('uses the configuration key for raw IDs that resemble display suffixes', async () => {
    writeUserSettings({
      modelProviders: { openai: [{ id: 'custom(openai)' }] },
    });
    const { app } = makeApp();
    const listed = await request(app).get('/workspace/models');
    const response = await request(app)
      .delete('/workspace/models')
      .send({ ...listed.body.models[0], modelId: 'custom' });
    expect(response.status).toBe(200);
    expect(readUserSettings()['modelProviders']).toEqual({ openai: [] });
  });

  it('clears deleted exact role selections across scopes but preserves another endpoint and bare IDs', async () => {
    const first = { id: 'shared', baseUrl: 'https://first.example/v1' };
    const second = { id: 'shared', baseUrl: 'https://second.example/v1' };
    writeUserSettings({
      modelProviders: { openai: [first, second] },
      imageModel: 'openai:shared\0https://first.example/v1',
      advisorModel: 'openai:shared\0https://second.example/v1',
      voiceModel: 'shared',
      visionModel: 'openai:shared\0https://first.example/v1',
      fastModel: 'shared',
      compactionModel: 'openai:shared',
    });
    writeWorkspaceSettings({
      modelProviders: { gemini: [{ id: 'gem' }] },
      advisorModel: 'openai:shared\0https://first.example/v1',
      visionModel: 'openai:shared\0https://second.example/v1',
      fastModel: 'shared',
      compactionModel: 'openai:shared',
    });
    const { app } = makeApp();
    const listed = await request(app).get('/workspace/models');
    const target = listed.body.models.find(
      (model: { baseUrl?: string }) => model.baseUrl === first.baseUrl,
    );
    expect(
      (await request(app).delete('/workspace/models').send(target)).status,
    ).toBe(200);
    expect(readUserSettings()).toMatchObject({
      imageModel: '',
      advisorModel: 'openai:shared\0https://second.example/v1',
      voiceModel: 'shared',
      visionModel: '',
      fastModel: 'shared',
      compactionModel: 'openai:shared',
      modelProviders: { openai: [second] },
    });
    expect(readWorkspaceSettings()).toMatchObject({
      advisorModel: '',
      visionModel: 'openai:shared\0https://second.example/v1',
      fastModel: 'shared',
      compactionModel: 'openai:shared',
      modelProviders: { gemini: [{ id: 'gem' }] },
    });
    const remaining = await request(app).get('/workspace/models');
    const last = remaining.body.models.find(
      (model: { modelId: string }) => model.modelId === 'shared',
    );
    expect(
      (await request(app).delete('/workspace/models').send(last)).status,
    ).toBe(200);
    expect(readUserSettings()).toMatchObject({
      advisorModel: '',
      voiceModel: '',
      fastModel: '',
      compactionModel: '',
    });
    expect(readWorkspaceSettings()).toMatchObject({
      visionModel: '',
      fastModel: '',
      compactionModel: '',
    });
  });

  it.each([
    { selector: 'openai:shared', removed: 'openai:shared', clears: false },
    { selector: 'openai:shared', removed: 'shared', clears: true },
    {
      selector: 'openai:openai:shared',
      removed: 'openai:shared',
      clears: true,
    },
    { selector: 'openai:openai:shared', removed: 'shared', clears: false },
    { selector: 'shared:online', removed: 'shared:online', clears: true },
    { selector: 'openai:', removed: 'shared', clears: false },
    { selector: 'inherit', removed: 'inherit', clears: false },
    { selector: 'fast', removed: 'fast', clears: false },
  ])(
    'uses runtime selector semantics when deleting $removed with pin $selector',
    async ({ selector, removed, clears }) => {
      const roles = [
        'imageModel',
        'advisorModel',
        'visionModel',
        'fastModel',
        'compactionModel',
      ];
      const pins = Object.fromEntries(roles.map((key) => [key, selector]));
      writeUserSettings({
        modelProviders: {
          openai: [
            'shared',
            'openai:shared',
            'shared:online',
            'inherit',
            'fast',
          ].map((id) => ({ id })),
        },
        ...pins,
      });
      const { app } = makeApp();
      const listed = await request(app).get('/workspace/models');
      const target = listed.body.models.find(
        (model: { modelId: string }) => model.modelId === removed,
      );
      expect(target).toBeDefined();
      const deleted = await request(app)
        .delete('/workspace/models')
        .send(target);
      expect(deleted.status).toBe(200);
      expect(readUserSettings()).toMatchObject(
        Object.fromEntries(roles.map((key) => [key, clears ? '' : selector])),
      );
      expect(
        (await request(app).get('/workspace/models')).body.models.some(
          (model: { modelId: string }) => model.modelId === removed,
        ),
      ).toBe(false);
    },
  );

  it.each([undefined, 'invalid-protocol', 'qwen-oauth', 'openai'])(
    'only preserves deleted bare references for a routable provider alias (%s)',
    async (protocol) => {
      const model = {
        id: 'shared',
        baseUrl: 'https://models.example/v1',
        envKey: 'MODEL_KEY',
        supportsImageGeneration: true,
      };
      writeUserSettings({
        ...(protocol ? { providerProtocol: { alternate: protocol } } : {}),
        modelProviders: {
          openai: [model, { id: 'other' }],
          alternate: [model],
        },
        advisorModel: model.id,
        imageModel: model.id,
        voiceModel: model.id,
        visionModel: model.id,
        fastModel: model.id,
        compactionModel: model.id,
        modelFallbacks: 'shared,other',
      });
      const { app } = makeApp();
      const listed = await request(app).get('/workspace/models');
      expect(listed.status).toBe(200);
      const target = listed.body.models[0];
      expect(target.modelId).toBe(model.id);
      const deleted = await request(app)
        .delete('/workspace/models')
        .send(target);
      expect(deleted.status).toBe(200);
      const stillConfigured = protocol === 'openai';
      expect(readUserSettings()).toMatchObject({
        modelProviders: {
          openai: [{ id: 'other' }],
          alternate: [model],
        },
        advisorModel: stillConfigured ? model.id : '',
        imageModel: stillConfigured ? model.id : '',
        voiceModel: stillConfigured ? model.id : '',
        visionModel: stillConfigured ? model.id : '',
        fastModel: stillConfigured ? model.id : '',
        compactionModel: stillConfigured ? model.id : '',
        modelFallbacks: stillConfigured ? 'shared,other' : 'other',
      });
      const remaining = await request(app).get('/workspace/models');
      expect(remaining.status).toBe(200);
      expect(
        remaining.body.models.map(
          (entry: { modelId: string }) => entry.modelId,
        ),
      ).toEqual(stillConfigured ? ['other', 'shared'] : ['other']);
    },
  );

  it('does not expose or edit untrusted workspace model settings', async () => {
    writeUserSettings({ modelProviders: { openai: [{ id: 'user' }] } });
    writeWorkspaceSettings({
      modelProviders: { openai: [{ id: 'untrusted' }] },
    });
    const before = readWorkspaceSettings();
    const { app } = makeApp({ trusted: false });
    const listed = await request(app).get('/workspace/models');
    expect(
      listed.body.models.map((model: { modelId: string }) => model.modelId),
    ).toEqual(['user']);
    expect(
      (
        await request(app)
          .patch('/workspace/models')
          .send({ key: listed.body.models[0].key, contextWindowSize: 32768 })
      ).status,
    ).toBe(200);
    expect(readWorkspaceSettings()).toEqual(before);
  });

  it('returns 503 without broadcasting when the runtime closes after persist', async () => {
    writeUserSettings({ modelProviders: { openai: [{ id: 'gpt-4o' }] } });
    let generationOpen = true;
    const { app, broadcastSettingsChanged } = makeApp({
      captureGenerationAssertion: () => () => {
        if (!generationOpen) throw new WorkspaceGenerationClosedError();
      },
      afterPersist: () => {
        generationOpen = false;
      },
    });

    const res = await request(app)
      .delete('/workspace/models')
      .send({ authType: 'openai', modelId: 'gpt-4o' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('workspace_runtime_unavailable');
    expect(broadcastSettingsChanged).not.toHaveBeenCalled();
  });

  it('returns 503 when the generation is already closed at route entry', async () => {
    writeUserSettings({ modelProviders: { openai: [{ id: 'gpt-4o' }] } });
    const { app, persistSettings, broadcastSettingsChanged } = makeApp({
      captureGenerationAssertion: () => () => {
        throw new WorkspaceGenerationClosedError();
      },
    });

    const res = await request(app)
      .delete('/workspace/models')
      .send({ authType: 'openai', modelId: 'gpt-4o' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('workspace_runtime_unavailable');
    expect(res.headers['retry-after']).toBe('1');
    expect(persistSettings).not.toHaveBeenCalled();
    expect(broadcastSettingsChanged).not.toHaveBeenCalled();
  });

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

  it('reports degraded runtime sync after the model removal is persisted', async () => {
    writeUserSettings({ modelProviders: { openai: [{ id: 'gpt-4o' }] } });
    let modelProvidersAtSync: unknown;
    const syncModelProvidersRuntime = vi.fn(async () => {
      modelProvidersAtSync = readUserSettings()['modelProviders'];
      return { status: 'failed' as const };
    });
    const { app, broadcastSettingsChanged } = makeApp({
      syncModelProvidersRuntime,
    });

    const res = await request(app)
      .delete('/workspace/models')
      .send({ authType: 'openai', modelId: 'gpt-4o' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      removed: true,
      runtimeSync: { status: 'failed' },
    });
    expect(syncModelProvidersRuntime).toHaveBeenCalledOnce();
    expect(syncModelProvidersRuntime).toHaveBeenCalledWith(
      SettingScope.User,
      'DELETE',
    );
    expect(modelProvidersAtSync).toEqual({ openai: [] });
    expect(broadcastSettingsChanged.mock.invocationCallOrder[0]).toBeLessThan(
      syncModelProvidersRuntime.mock.invocationCallOrder[0]!,
    );
  });

  it('writes to the workspace scope when the workspace owns modelProviders', async () => {
    writeWorkspaceSettings({
      modelProviders: { openai: [{ id: 'gpt-4o' }, { id: 'deepseek-v4' }] },
    });
    const syncModelProvidersRuntime = vi
      .fn()
      .mockResolvedValue({ status: 'applied' });
    const { app, broadcastSettingsChanged } = makeApp({
      syncModelProvidersRuntime,
    });

    const res = await request(app)
      .delete('/workspace/models')
      .send({ authType: 'openai', modelId: 'gpt-4o' });

    expect(res.status).toBe(200);
    expect(syncModelProvidersRuntime).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'DELETE',
    );
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
    // A too-long baseUrl reports invalid_base_url (not the misleading
    // "must be a string") — length and type are validated separately.
    [
      { authType: 'openai', modelId: 'gpt-4o', baseUrl: 'a'.repeat(2000) },
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
    const syncModelProvidersRuntime = vi
      .fn()
      .mockResolvedValue({ status: 'applied' as const });
    const { app, persistSettings, broadcastSettingsChanged } = makeApp({
      syncModelProvidersRuntime,
    });
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
    expect(syncModelProvidersRuntime).toHaveBeenCalledExactlyOnceWith(
      SettingScope.User,
      'DELETE',
    );
  });

  it.each(['success', 'user-uncommitted'] as const)(
    'synchronizes the actual committed scopes after a mixed-scope deletion (%s)',
    async (scenario) => {
      writeWorkspaceSettings({
        modelProviders: { openai: [{ id: 'removed' }] },
        imageModel: 'removed',
      });
      writeUserSettings({ voiceModel: 'removed' });
      const syncModelProvidersRuntime = vi
        .fn()
        .mockResolvedValue({ status: 'applied' as const });
      const { app, persistSettings } = makeApp({ syncModelProvidersRuntime });
      if (scenario !== 'success') {
        const persist = persistSettings.getMockImplementation()!;
        persistSettings.mockImplementationOnce(
          async (ws, writes, assertOpen) => {
            const committed = writes.filter(
              (write) => write.scope === SettingScope.Workspace,
            );
            await persist(ws, committed, assertOpen);
            throw new WorkspaceSettingsPartialPersistError(
              'partial',
              committed,
              new Error('disk full'),
            );
          },
        );
      }
      const res = await request(app).delete('/workspace/models').send({
        authType: 'openai',
        modelId: 'removed',
      });
      expect(res.status).toBe(scenario === 'success' ? 200 : 500);
      expect(readWorkspaceSettings()).toMatchObject({
        modelProviders: { openai: [] },
        imageModel: '',
      });
      expect(readUserSettings()['voiceModel']).toBe(
        scenario === 'user-uncommitted' ? 'removed' : '',
      );
      expect(syncModelProvidersRuntime).toHaveBeenCalledExactlyOnceWith(
        scenario === 'user-uncommitted'
          ? SettingScope.Workspace
          : SettingScope.User,
        'DELETE',
      );
    },
  );

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

describe('model configuration routes', () => {
  it.each(['patch', 'delete'] as const)(
    'forwards the user write scope for %s beside an unrelated workspace bucket',
    async (method) => {
      writeUserSettings({ modelProviders: { openai: [{ id: 'user' }] } });
      writeWorkspaceSettings({
        modelProviders: { gemini: [{ id: 'workspace' }] },
      });
      const sync = vi.fn(async () => ({ status: 'applied' as const }));
      const { app } = makeApp({ syncModelProvidersRuntime: sync });
      const listed = await request(app).get('/workspace/models');
      const target = listed.body.models.find(
        (model: { modelId: string }) => model.modelId === 'user',
      );
      const response = await request(app)
        [method]('/workspace/models')
        .send({
          ...target,
          contextWindowSize: 65536,
        });
      expect(response.status).toBe(200);
      expect(sync).toHaveBeenCalledExactlyOnceWith(
        SettingScope.User,
        method.toUpperCase(),
      );
      expect(readWorkspaceSettings()['modelProviders']).toEqual({
        gemini: [{ id: 'workspace' }],
      });
    },
  );

  it.each([
    { voiceModel: ' qwen3-asr-flash ', expected: '' },
    { voiceModel: 'qwen3-asr-flash\n', expected: '' },
    { voiceModel: 5, expected: 5 },
    { voiceModel: false, expected: false },
  ])(
    'removes a model using voice runtime parsing ($voiceModel)',
    async ({ voiceModel, expected }) => {
      writeUserSettings({
        modelProviders: {
          openai: [
            {
              id: 'qwen3-asr-flash',
              baseUrl: 'https://voice.example/v1',
              envKey: 'VOICE_KEY',
              voiceOnly: true,
            },
          ],
        },
        voiceModel,
      });
      const { app } = makeApp();
      const listed = await request(app).get('/workspace/models');
      const response = await request(app)
        .delete('/workspace/models')
        .send(listed.body.models[0]);
      expect(response.status).toBe(200);
      expect(readUserSettings()['voiceModel']).toBe(expected);
    },
  );

  it.each([
    { key: 'imageModel', value: 5 },
    { key: 'imageModel', value: { id: 'model' } },
    { key: 'advisorModel', value: 5 },
    { key: 'advisorModel', value: { id: 'model' } },
    { key: 'visionModel', value: 5 },
    { key: 'fastModel', value: { id: 'model' } },
    { key: 'compactionModel', value: 5 },
  ])(
    'removes a model without rewriting a non-string $key ($value)',
    async ({ key, value }) => {
      writeUserSettings({
        modelProviders: { openai: [{ id: 'model' }] },
        [key]: value,
      });
      const { app } = makeApp();
      const listed = await request(app).get('/workspace/models');
      expect(listed.status).toBe(200);
      const response = await request(app)
        .delete('/workspace/models')
        .send(listed.body.models[0]);
      expect(response.status).toBe(200);
      expect(response.body.removed).toBe(true);
      const saved = readUserSettings();
      expect(saved[key]).toEqual(value);
      expect(saved['modelProviders']).toEqual({ openai: [] });
    },
  );

  it('persists a workspace-owned window and reports runtime sync failure without touching user settings', async () => {
    writeUserSettings({
      $version: 4,
      modelProviders: { openai: [{ id: 'user' }] },
    });
    writeWorkspaceSettings({
      $version: 4,
      modelProviders: {
        openai: [{ id: 'workspace', envKey: 'WORKSPACE_KEY' }],
      },
    });
    const before = fs.readFileSync(path.join(home, 'settings.json'), 'utf8');
    const sync = vi.fn(async () => ({ status: 'failed' as const }));
    const { app, broadcastSettingsChanged } = makeApp({
      syncModelProvidersRuntime: sync,
    });
    const listed = await request(app).get('/workspace/models');
    const target = listed.body.models.find(
      (model: { modelId: string }) => model.modelId === 'workspace',
    );
    const response = await request(app)
      .patch('/workspace/models')
      .send({ key: target.key, contextWindowSize: 65536 });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      updated: true,
      requiresRestart: true,
      runtimeSync: { status: 'failed' },
    });
    expect(sync).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledWith(SettingScope.Workspace, 'PATCH');
    expect(readWorkspaceSettings()).toMatchObject({
      modelProviders: {
        openai: [
          {
            id: 'workspace',
            envKey: 'WORKSPACE_KEY',
            generationConfig: { contextWindowSize: 65536 },
          },
        ],
      },
    });
    expect(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).toBe(
      before,
    );
    expect(broadcastSettingsChanged).toHaveBeenCalledWith(
      'modelProviders',
      undefined,
      'workspace',
      undefined,
    );
  });
  it('returns 500 without broadcasting when the settings writer refuses a save', async () => {
    writeUserSettings({ modelProviders: { openai: [{ id: 'model' }] } });
    const { app, broadcastSettingsChanged } = makeApp();
    const listed = await request(app).get('/workspace/models');
    const before = fs.readFileSync(path.join(home, 'settings.json'), 'utf8');
    const writer = vi
      .spyOn(jsoncEditor, 'updateSettingsFilePreservingFormat')
      .mockReturnValue(false);
    try {
      const result = await request(app)
        .patch('/workspace/models')
        .send({ key: listed.body.models[0].key, contextWindowSize: 32768 });
      expect(result.status).toBe(500);
      expect(writer).toHaveBeenCalled();
      expect(broadcastSettingsChanged).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).toBe(
        before,
      );
    } finally {
      writer.mockRestore();
    }
  });

  it.each(['stale', 'ambiguous'])(
    'rejects a %s configuration key without writing or broadcasting',
    async (shape) => {
      const model = { id: 'shared', baseUrl: 'https://original.example/v1' };
      writeUserSettings({ modelProviders: { openai: [model] } });
      const { app, broadcastSettingsChanged } = makeApp();
      const listed = await request(app).get('/workspace/models');
      const target = listed.body.models[0];
      writeUserSettings({
        $version: 4,
        modelProviders: {
          openai:
            shape === 'stale'
              ? [{ ...model, baseUrl: 'https://replacement.example/v1' }]
              : [model, model],
        },
      });
      const before = fs.readFileSync(path.join(home, 'settings.json'), 'utf8');
      const patched = await request(app)
        .patch('/workspace/models')
        .send({ key: target.key, contextWindowSize: 32768 });
      const deleted = await request(app)
        .delete('/workspace/models')
        .send(target);
      expect(patched.status).toBe(409);
      expect(deleted.status).toBe(409);
      expect(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).toBe(
        before,
      );
      expect(broadcastSettingsChanged).not.toHaveBeenCalled();
    },
  );

  it('reads service models and saves a context override with safe invalidation', async () => {
    writeUserSettings({
      modelProviders: {
        openai: [
          {
            id: 'asr',
            voiceOnly: true,
            apiKey: 'private',
            generationConfig: { contextWindowSize: 1024 },
          },
        ],
      },
    });
    const { app, broadcastSettingsChanged } = makeApp();
    const response = await request(app).get('/workspace/models');
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('private');
    const key = response.body.models[0].key;
    const update = await request(app)
      .patch('/workspace/models')
      .send({ key, contextWindowSize: 65536 });
    expect(update.status).toBe(200);
    expect(update.body).toEqual({ updated: true, requiresRestart: true });
    expect(broadcastSettingsChanged).toHaveBeenCalledWith(
      'modelProviders',
      undefined,
      'user',
      undefined,
    );
    const configs = await request(app).get('/workspace/models');
    expect(configs.body.models[0].contextWindowSize).toBe(65536);
    const reset = await request(app)
      .patch('/workspace/models')
      .send({ key, contextWindowSize: null });
    expect(reset.status).toBe(200);
    expect(
      (await request(app).get('/workspace/models')).body.models[0]
        .contextWindowSize,
    ).toBeUndefined();
  });
  it.each([0, -1, 1.5, '100', 10000001, undefined])(
    'rejects invalid context window %s',
    async (contextWindowSize) => {
      const { app, broadcastSettingsChanged } = makeApp();
      const result = await request(app)
        .patch('/workspace/models')
        .send({ key: 'a'.repeat(64), contextWindowSize });
      expect(result.status).toBe(400);
      expect(broadcastSettingsChanged).not.toHaveBeenCalled();
    },
  );
  it('rejects stale targets and closed generations', async () => {
    const { app } = makeApp();
    expect(
      (
        await request(app)
          .patch('/workspace/models')
          .send({ key: 'a'.repeat(64), contextWindowSize: 1 })
      ).status,
    ).toBe(409);
    const { app: closed } = makeApp({
      captureGenerationAssertion: () => () => {
        throw new WorkspaceGenerationClosedError('closed');
      },
    });
    expect((await request(closed).get('/workspace/models')).status).toBe(503);
    expect(
      (
        await request(closed)
          .patch('/workspace/models')
          .send({ key: 'a'.repeat(64), contextWindowSize: 1 })
      ).status,
    ).toBe(503);
  });
});
