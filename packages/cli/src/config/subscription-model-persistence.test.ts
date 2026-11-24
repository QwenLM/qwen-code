/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AvailableModel, Config } from '@qwen-code/qwen-code-core';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { QWEN_SUBSCRIPTION_BASE_URL } from '@qwen-code/qwen-code-core/qwen/oauth-config.js';
import { SettingScope, loadSettings, type LoadedSettings } from './settings.js';
import {
  getSubscriptionModelConfig,
  persistSubscriptionModel,
  prepareSubscriptionModelPersistence,
} from './subscription-model-persistence.js';

const image: AvailableModel = {
  id: 'image',
  label: 'Image',
  authType: AuthType.QWEN_SUBSCRIPTION,
  baseUrl: QWEN_SUBSCRIPTION_BASE_URL,
  subscriptionScenes: ['image'],
  subscriptionChatModel: false,
  imageOnly: true,
  supportsImageGeneration: true,
  modalities: { image: true },
  contextWindowSize: 8192,
  thinkingStrength: [{ level: 'low', budget_tokens: 1024 }],
};

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture(
  user: Record<string, unknown> = {},
  project: Record<string, unknown> = {},
  defaults: Record<string, unknown> = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-save-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
  vi.stubEnv('QWEN_HOME', home);
  vi.stubEnv('QWEN_CODE_SYSTEM_SETTINGS_PATH', path.join(root, 'system.json'));
  vi.stubEnv(
    'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
    path.join(root, 'defaults.json'),
  );
  const userFile = path.join(home, 'settings.json');
  const projectFile = path.join(workspace, '.qwen', 'settings.json');
  fs.writeFileSync(
    path.join(root, 'defaults.json'),
    JSON.stringify({ $version: 4, ...defaults }),
  );
  fs.writeFileSync(userFile, JSON.stringify({ $version: 4, ...user }));
  fs.writeFileSync(projectFile, JSON.stringify({ $version: 4, ...project }));
  const settings = loadSettings(workspace, {
    skipLoadEnvironment: true,
    workspaceTrusted: true,
  });
  const config = { getAllConfiguredModels: () => [image] } as unknown as Config;
  return { settings, config, userFile, projectFile };
}

describe('persistSubscriptionModel', () => {
  it('stores only the selected route and preserves previously selected routes', () => {
    const { settings } = fixture({
      modelProviders: {
        'qwen-subscription': [
          { id: 'voice', voiceOnly: true, baseUrl: QWEN_SUBSCRIPTION_BASE_URL },
          { id: 'image', name: 'Old', baseUrl: QWEN_SUBSCRIPTION_BASE_URL },
        ],
      },
    });
    const setValue = vi.spyOn(settings, 'setValue');
    const config = {
      getAllConfiguredModels: () => [
        image,
        { ...image, isRuntimeModel: true },
        { ...image, id: 'not-selected' },
      ],
    } as unknown as Config;
    persistSubscriptionModel(
      settings,
      config,
      'qwen-subscription:image',
      SettingScope.Workspace,
    );
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'modelProviders.qwen-subscription',
      [
        { id: 'voice', voiceOnly: true, baseUrl: QWEN_SUBSCRIPTION_BASE_URL },
        expect.objectContaining({
          id: 'image',
          name: 'Image',
          baseUrl: QWEN_SUBSCRIPTION_BASE_URL,
          subscriptionScenes: ['image'],
          subscriptionChatModel: false,
          imageOnly: true,
          supportsImageGeneration: true,
          generationConfig: {
            modalities: { image: true },
            contextWindowSize: 8192,
          },
          thinkingStrength: [{ level: 'low', budget_tokens: 1024 }],
        }),
      ],
    );
    expect(JSON.stringify(setValue.mock.calls[0][2])).not.toContain(
      'not-selected',
    );
  });

  it('does not save API Key models or infer a route for an ambiguous bare ID', () => {
    const setValue = vi.fn();
    const settings = { merged: {}, setValue } as unknown as LoadedSettings;
    const config = {
      getAllConfiguredModels: () => [
        image,
        { ...image, authType: AuthType.USE_OPENAI },
      ],
    } as unknown as Config;
    persistSubscriptionModel(
      settings,
      config,
      'openai:image',
      SettingScope.User,
    );
    persistSubscriptionModel(settings, config, 'image', SettingScope.User);
    expect(setValue).not.toHaveBeenCalled();
  });

  it('rejects a global save shadowed by project models without changing either file', () => {
    const { settings, config, userFile, projectFile } = fixture(
      {
        voiceModel: 'qwen-subscription:user-asr',
        modelProviders: {
          'qwen-subscription': [
            {
              id: 'user-asr',
              baseUrl: QWEN_SUBSCRIPTION_BASE_URL,
              voiceOnly: true,
            },
          ],
        },
      },
      {
        modelProviders: {
          'qwen-subscription': [
            {
              id: 'project-asr',
              baseUrl: QWEN_SUBSCRIPTION_BASE_URL,
              voiceOnly: true,
            },
          ],
        },
      },
    );
    const before = [
      fs.readFileSync(userFile, 'utf8'),
      fs.readFileSync(projectFile, 'utf8'),
    ];
    expect(() =>
      persistSubscriptionModel(
        settings,
        config,
        'qwen-subscription:image',
        SettingScope.User,
      ),
    ).toThrow('higher-precedence');
    expect([
      fs.readFileSync(userFile, 'utf8'),
      fs.readFileSync(projectFile, 'utf8'),
    ]).toEqual(before);
    expect(settings.user.settings.voiceModel).toBe(
      'qwen-subscription:user-asr',
    );
  });

  it.each([SettingScope.User, SettingScope.Workspace])(
    'preserves inherited routes and raw placeholders when saving %s',
    (scope) => {
      vi.stubEnv('SUBSCRIPTION_SAVE_SECRET', 'expanded-private-value');
      const { settings, config, userFile, projectFile } = fixture({
        modelProviders: {
          'qwen-subscription': [
            {
              id: 'main',
              baseUrl: QWEN_SUBSCRIPTION_BASE_URL,
              subscriptionChatModel: true,
              generationConfig: {
                customHeaders: { 'X-Private': '${SUBSCRIPTION_SAVE_SECRET}' },
              },
            },
          ],
        },
      });
      const userBefore = fs.readFileSync(userFile, 'utf8');
      expect(
        settings.merged.modelProviders?.['qwen-subscription']?.[0]
          ?.generationConfig?.customHeaders?.['X-Private'],
      ).toBe('expanded-private-value');
      persistSubscriptionModel(
        settings,
        config,
        'qwen-subscription:image',
        scope,
      );
      const raw = fs.readFileSync(
        scope === SettingScope.User ? userFile : projectFile,
        'utf8',
      );
      expect(raw).toContain('${SUBSCRIPTION_SAVE_SECRET}');
      expect(raw).not.toContain('expanded-private-value');
      expect(
        settings.merged.modelProviders?.['qwen-subscription']?.map(
          (model) => model.id,
        ),
      ).toEqual(['main', 'image']);
      expect(
        settings.merged.modelProviders?.['qwen-subscription']?.[0]
          ?.generationConfig?.customHeaders?.['X-Private'],
      ).toBe('expanded-private-value');
      if (scope === SettingScope.Workspace)
        expect(fs.readFileSync(userFile, 'utf8')).toBe(userBefore);
    },
  );

  it('allows an identical higher-scope definition without copying unrelated project entries', () => {
    vi.stubEnv('SELECTED_IMAGE_NAME', 'Image');
    const snapshot = getSubscriptionModelConfig(image)!;
    const projectImage = { ...snapshot, name: '${SELECTED_IMAGE_NAME}' };
    const inherited = {
      id: 'inherited-main',
      baseUrl: QWEN_SUBSCRIPTION_BASE_URL,
      subscriptionChatModel: true,
    };
    const { settings, config, userFile, projectFile } = fixture(
      {},
      {
        modelProviders: {
          'qwen-subscription': [
            projectImage,
            { id: 'project-only', baseUrl: QWEN_SUBSCRIPTION_BASE_URL },
          ],
        },
      },
      { modelProviders: { 'qwen-subscription': [inherited] } },
    );
    const before = fs.readFileSync(projectFile, 'utf8');
    persistSubscriptionModel(
      settings,
      config,
      'qwen-subscription:image',
      SettingScope.User,
    );
    const saved = JSON.parse(fs.readFileSync(userFile, 'utf8'));
    expect(
      saved.modelProviders['qwen-subscription'].map(
        (model: { id: string }) => model.id,
      ),
    ).toEqual(['inherited-main', 'image']);
    expect(saved.modelProviders['qwen-subscription'][1].name).toBe(
      '${SELECTED_IMAGE_NAME}',
    );
    expect(fs.readFileSync(projectFile, 'utf8')).toBe(before);
  });

  it('keeps the target scope reference when a higher scope uses a different variable for the same model', () => {
    vi.stubEnv('USER_SUBSCRIPTION_MODEL', 'image');
    vi.stubEnv('PROJECT_SUBSCRIPTION_MODEL', 'image');
    const snapshot = getSubscriptionModelConfig(image)!;
    const { settings, config, userFile, projectFile } = fixture(
      {
        modelProviders: {
          'qwen-subscription': [
            { ...snapshot, id: '${USER_SUBSCRIPTION_MODEL}' },
          ],
        },
      },
      {
        modelProviders: {
          'qwen-subscription': [
            { ...snapshot, id: '${PROJECT_SUBSCRIPTION_MODEL}' },
          ],
        },
      },
    );
    persistSubscriptionModel(
      settings,
      config,
      'qwen-subscription:image',
      SettingScope.User,
    );
    const saved = JSON.parse(fs.readFileSync(userFile, 'utf8'));
    expect(saved.modelProviders['qwen-subscription'][0].id).toBe(
      '${USER_SUBSCRIPTION_MODEL}',
    );
    fs.rmSync(projectFile);
    delete process.env['PROJECT_SUBSCRIPTION_MODEL'];
    const reloaded = loadSettings(path.dirname(path.dirname(projectFile)), {
      skipLoadEnvironment: true,
      workspaceTrusted: true,
    });
    expect(reloaded.merged.modelProviders?.['qwen-subscription']?.[0]?.id).toBe(
      'image',
    );
  });

  it('rejects different metadata for a higher-scope route before any write', () => {
    const snapshot = getSubscriptionModelConfig(image)!;
    const { settings, config, userFile } = fixture(
      {
        modelProviders: {
          'qwen-subscription': [
            { id: 'user-main', baseUrl: QWEN_SUBSCRIPTION_BASE_URL },
          ],
        },
      },
      {
        modelProviders: {
          'qwen-subscription': [
            { ...snapshot, name: 'Different project definition' },
          ],
        },
      },
    );
    const before = fs.readFileSync(userFile, 'utf8');
    expect(() =>
      persistSubscriptionModel(
        settings,
        config,
        'qwen-subscription:image',
        SettingScope.User,
      ),
    ).toThrow('higher-precedence');
    expect(fs.readFileSync(userFile, 'utf8')).toBe(before);
  });

  it('prepares a selection without writing either settings file', () => {
    const { settings, config, userFile, projectFile } = fixture();
    const before = [
      fs.readFileSync(userFile, 'utf8'),
      fs.readFileSync(projectFile, 'utf8'),
    ];
    expect(
      prepareSubscriptionModelPersistence(
        settings,
        config,
        'qwen-subscription:image',
        SettingScope.User,
      ),
    ).toEqual([expect.objectContaining({ id: 'image' })]);
    expect([
      fs.readFileSync(userFile, 'utf8'),
      fs.readFileSync(projectFile, 'utf8'),
    ]).toEqual(before);
  });

  it('only serializes advertised model metadata and the trusted gateway endpoint', () => {
    const untrusted = {
      ...image,
      baseUrl: 'https://other.example',
      envKey: 'SECRET',
      access_token: 'secret',
      generationConfig: { customHeaders: { Authorization: 'secret' } },
    };
    const selected = getSubscriptionModelConfig(untrusted);
    expect(selected?.baseUrl).toBe(QWEN_SUBSCRIPTION_BASE_URL);
    expect(JSON.stringify(selected)).not.toContain('secret');
    expect(selected).not.toHaveProperty('envKey');
  });
});
