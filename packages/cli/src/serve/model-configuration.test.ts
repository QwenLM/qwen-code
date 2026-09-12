import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModelsConfig } from '@qwen-code/qwen-code-core';
import { loadSettings } from '../config/settings.js';
import {
  getModelConfigurationKey,
  findModelConfiguration,
  findModelConfigurationForDeletion,
  listModelConfigurations,
  updateModelContextWindow,
} from './model-configuration.js';

let temp: string;
let previousHome: string | undefined;
const models = [
  {
    id: 'shared',
    baseUrl: 'https://one.example/v1',
    envKey: 'ONE',
    apiKey: 'secret-one',
    generationConfig: {
      contextWindowSize: 8192,
      samplingParams: { max_tokens: 4000 },
      customHeaders: { 'X-Secret': 'private' },
    },
  },
  {
    id: 'shared',
    baseUrl: 'https://two.example/v1',
    envKey: 'TWO',
    voiceOnly: true,
  },
  {
    id: 'image-01',
    baseUrl: 'https://images.example/v1',
    envKey: 'IMAGE',
    imageOnly: true,
  },
];
function load(trusted = true) {
  return loadSettings(temp, {
    skipLoadEnvironment: true,
    skipWorkspaceSettings: !trusted,
    workspaceTrusted: trusted,
  });
}
function read() {
  return JSON.parse(fs.readFileSync(path.join(temp, 'settings.json'), 'utf8'));
}
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-config-'));
  previousHome = process.env['QWEN_HOME'];
  process.env['QWEN_HOME'] = temp;
  fs.writeFileSync(
    path.join(temp, 'settings.json'),
    JSON.stringify({
      modelProviders: { openai: models },
      env: { ONE: 'env-secret' },
    }),
  );
});
afterEach(() => {
  if (previousHome === undefined) delete process.env['QWEN_HOME'];
  else process.env['QWEN_HOME'] = previousHome;
  fs.rmSync(temp, { recursive: true, force: true });
});
describe('persisted model configuration', () => {
  it.each([0, -1, '128000', 1.5])(
    'omits invalid stored context window %s from the wire',
    (size) => {
      fs.writeFileSync(
        path.join(temp, 'settings.json'),
        JSON.stringify({
          modelProviders: {
            openai: [
              { id: 'custom', generationConfig: { contextWindowSize: size } },
            ],
          },
        }),
      );
      expect(
        listModelConfigurations(load())[0]?.contextWindowSize,
      ).toBeUndefined();
    },
  );

  it('does not offer ambiguous routes or fast/voice-only entries as image choices', () => {
    const image = {
      id: 'image',
      baseUrl: 'https://media.example/v1',
      supportsImageGeneration: true,
      envKey: 'IMAGE_KEY',
    };
    fs.writeFileSync(
      path.join(temp, 'settings.json'),
      JSON.stringify({
        providerProtocol: { gateway: 'openai' },
        modelProviders: {
          openai: [
            image,
            { ...image, id: 'fast', fastOnly: true },
            { ...image, id: 'voice', voiceOnly: true },
            { ...image, id: 'no-key', envKey: undefined },
            { ...image, id: 'blank-key', envKey: ' ' },
            { ...image, id: 'numeric-key', envKey: 5 },
          ],
          gateway: [image],
        },
      }),
    );
    const configs = listModelConfigurations(load());
    expect(configs).toHaveLength(7);
    expect(
      configs.find((config) => config.modelId === 'numeric-key')?.envKey,
    ).toBeUndefined();
    expect(configs.every((config) => config.imageModel === undefined)).toBe(
      true,
    );
    expect(
      configs
        .filter((config) => config.modelId === 'image')
        .every((config) => config.advisorModel === undefined),
    ).toBe(true);
  });
  it.each([{ openai: 'gpt-4o' }, { openai: [null] }])(
    'keeps valid models readable and editable beside malformed providers ($openai)',
    ({ openai }) => {
      fs.writeFileSync(
        path.join(temp, 'settings.json'),
        JSON.stringify({
          modelProviders: { openai, gemini: [{ id: 'g' }] },
        }),
      );
      const configs = listModelConfigurations(load());
      expect(
        configs.map(({ authType, modelId }) => ({ authType, modelId })),
      ).toEqual([{ authType: 'gemini', modelId: 'g' }]);
      expect(updateModelContextWindow(load(), configs[0]!.key, 32768)).toBe(
        'user',
      );
      expect(read().modelProviders).toEqual({
        openai,
        gemini: [{ id: 'g', generationConfig: { contextWindowSize: 32768 } }],
      });
    },
  );

  it('projects service models and explicit windows without credentials', () => {
    const configs = listModelConfigurations(load());
    expect(configs).toHaveLength(3);
    expect(configs[0]?.contextWindowSize).toBe(8192);
    expect(configs[1]).toMatchObject({
      purpose: 'voice',
      contextWindowSize: undefined,
    });
    expect(configs[2]).toMatchObject({
      purpose: 'image',
      imageModel: 'openai:image-01\0https://images.example/v1',
    });
    expect(JSON.stringify(configs)).not.toMatch(
      /secret-one|env-secret|X-Secret|private/,
    );
  });
  it('does not expose credential-bearing URL query or fragment values', () => {
    fs.writeFileSync(
      path.join(temp, 'settings.json'),
      JSON.stringify({
        modelProviders: {
          openai: [
            {
              id: 'image',
              baseUrl:
                'https://user:password@api.example/v1?api_key=secret#private',
              imageOnly: true,
              envKey: 'IMAGE',
            },
          ],
        },
      }),
    );
    const configs = listModelConfigurations(load());
    expect(configs[0]?.baseUrl).toBe('https://api.example/v1');
    expect(configs[0]?.imageModel).toBeUndefined();
    expect(JSON.stringify(configs)).not.toMatch(
      /password|api_key|secret|private/,
    );
  });
  it.each([
    ['QWEN_CODE_SYSTEM_SETTINGS_PATH', false],
    ['QWEN_CODE_SYSTEM_DEFAULTS_PATH', true],
  ] as const)(
    'only edits user entries when not overridden by %s',
    (variable, editable) => {
      const filename = path.join(temp, 'system-models.json');
      fs.writeFileSync(
        filename,
        JSON.stringify({
          $version: 4,
          modelProviders: {
            openai: [
              { ...models[0], generationConfig: { contextWindowSize: 65536 } },
            ],
          },
        }),
      );
      vi.stubEnv(variable, filename);
      try {
        const loaded = load();
        expect(
          loaded.merged.modelProviders?.['openai']?.[0]?.generationConfig
            ?.contextWindowSize,
        ).toBe(editable ? 8192 : 65536);
        expect(listModelConfigurations(loaded)).toHaveLength(editable ? 3 : 0);
        expect(
          Boolean(
            getModelConfigurationKey(
              loaded,
              'openai',
              'shared',
              models[0]!.baseUrl,
            ),
          ),
        ).toBe(editable);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.each([
    ['QWEN_CODE_SYSTEM_SETTINGS_PATH', 'openai'],
    ['QWEN_CODE_SYSTEM_DEFAULTS_PATH', 'managed'],
  ] as const)(
    'does not pair a writable alias with a read-only route from %s',
    (variable, provider) => {
      const model = { ...models[0], supportsImageGeneration: true };
      fs.writeFileSync(
        path.join(temp, 'settings.json'),
        JSON.stringify({
          providerProtocol: { gateway: 'openai', managed: 'openai' },
          modelProviders: { openai: [], gateway: [model] },
        }),
      );
      const filename = path.join(temp, 'system-models.json');
      fs.writeFileSync(
        filename,
        JSON.stringify({
          $version: 4,
          modelProviders: {
            [provider]: [
              { ...model, generationConfig: { contextWindowSize: 32768 } },
            ],
          },
        }),
      );
      vi.stubEnv(variable, filename);
      try {
        const loaded = load();
        const registry = new ModelsConfig({
          modelProvidersConfig: loaded.merged.modelProviders,
          providerProtocolConfig: loaded.merged.providerProtocol,
        });
        const configured = registry
          .getAllConfiguredModels()
          .filter((entry) => entry.id === model.id);
        expect(configured).toHaveLength(1);
        expect(configured[0]?.contextWindowSize).toBe(32768);
        expect(
          getModelConfigurationKey(loaded, 'openai', model.id, model.baseUrl),
        ).toBeUndefined();
        const configs = listModelConfigurations(loaded);
        expect(configs).toHaveLength(1);
        expect(configs[0]?.contextWindowSize).toBe(8192);
        expect(configs[0]?.advisorModel).toBeUndefined();
        expect(configs[0]?.imageModel).toBeUndefined();
        expect(configs[0]?.canEditContextWindow).toBe(false);
        const before = fs.readFileSync(
          path.join(temp, 'settings.json'),
          'utf8',
        );
        expect(
          updateModelContextWindow(loaded, configs[0]!.key, 65536),
        ).toBeUndefined();
        expect(fs.readFileSync(path.join(temp, 'settings.json'), 'utf8')).toBe(
          before,
        );
        expect(findModelConfiguration(loaded, configs[0]!.key)?.provider).toBe(
          'gateway',
        );
        expect(
          findModelConfigurationForDeletion(loaded, {
            authType: 'openai',
            modelId: model.id,
            baseUrl: model.baseUrl,
          }),
        ).toBe('ambiguous');
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.each([{}, { gemini: [{ id: 'gem' }] }])(
    'edits inherited provider buckets in their own scope (%j)',
    (workspaceProviders) => {
      fs.mkdirSync(path.join(temp, '.qwen'));
      const filename = path.join(temp, '.qwen/settings.json');
      fs.writeFileSync(
        filename,
        JSON.stringify({ modelProviders: workspaceProviders }),
      );
      load();
      const before = fs.readFileSync(filename, 'utf8');
      const configs = listModelConfigurations(load());
      const key = getModelConfigurationKey(
        load(),
        'openai',
        'shared',
        models[0]!.baseUrl,
      );
      expect(key).toBe(
        configs.find((model) => model.baseUrl === models[0]!.baseUrl)?.key,
      );
      expect(key).toBeDefined();
      expect(updateModelContextWindow(load(), key!, 65536)).toBe('user');
      expect(
        read().modelProviders.openai[0].generationConfig.contextWindowSize,
      ).toBe(65536);
      expect(fs.readFileSync(filename, 'utf8')).toBe(before);
    },
  );

  it.each(['user', 'workspace'])(
    'preserves raw environment placeholders when editing %s settings',
    (scope) => {
      process.env['MODEL_CONFIG_TEST_SECRET'] = 'resolved-test-secret';
      const filename =
        scope === 'user'
          ? path.join(temp, 'settings.json')
          : path.join(temp, '.qwen/settings.json');
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      const model = {
        id: 'private',
        apiKey: '${MODEL_CONFIG_TEST_SECRET}',
        generationConfig: {
          customHeaders: { Authorization: '$MODEL_CONFIG_TEST_SECRET' },
        },
      };
      fs.writeFileSync(
        filename,
        JSON.stringify({
          modelProviders: { openai: [model, { ...model, id: 'sibling' }] },
        }),
      );
      try {
        const key = listModelConfigurations(load())[0]!.key;
        expect(updateModelContextWindow(load(), key, 65536)).toBe(scope);
        const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
        expect(saved.modelProviders.openai).toEqual([
          {
            ...model,
            generationConfig: {
              ...model.generationConfig,
              contextWindowSize: 65536,
            },
          },
          { ...model, id: 'sibling' },
        ]);
        expect(JSON.stringify(saved)).not.toContain('resolved-test-secret');
      } finally {
        delete process.env['MODEL_CONFIG_TEST_SECRET'];
      }
    },
  );

  it('offers exact advisor routes while excluding service and vision-only roles', () => {
    fs.writeFileSync(
      path.join(temp, 'settings.json'),
      JSON.stringify({
        modelProviders: {
          openai: [
            { id: 'implicit' },
            { id: 'explicit', baseUrl: 'https://chat.example/v1' },
            { id: 'vision', visionOnly: true },
            { id: 'voice', voiceOnly: true },
            {
              id: 'image',
              imageOnly: true,
              baseUrl: 'http://image.example/v1',
              envKey: 'IMAGE',
            },
            { id: 'fast', fastOnly: true },
          ],
        },
      }),
    );
    const configs = listModelConfigurations(load());
    expect(configs.map((model) => model.advisorModel)).toEqual([
      'openai:implicit\0',
      'openai:explicit\0https://chat.example/v1',
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(
      configs.find((model) => model.modelId === 'image')?.imageModel,
    ).toBeUndefined();
  });

  it('edits the exact endpoint and resets only the window field', () => {
    const key = listModelConfigurations(load())[0]!.key;
    expect(updateModelContextWindow(load(), key, 65536)).toBe('user');
    expect(read().modelProviders.openai[0]).toEqual({
      ...models[0],
      generationConfig: {
        ...models[0]!.generationConfig,
        contextWindowSize: 65536,
      },
    });
    expect(read().modelProviders.openai.slice(1)).toEqual(models.slice(1));
    expect(read().env).toEqual({ ONE: 'env-secret' });
    updateModelContextWindow(load(), key, null);
    expect(read().modelProviders.openai[0].generationConfig).toEqual({
      samplingParams: { max_tokens: 4000 },
      customHeaders: { 'X-Secret': 'private' },
    });
  });
  it('rejects stale scope and duplicate identities without writes', () => {
    const key = listModelConfigurations(load())[0]!.key;
    fs.mkdirSync(path.join(temp, '.qwen'));
    const filename = path.join(temp, '.qwen/settings.json');
    fs.writeFileSync(
      filename,
      JSON.stringify({ modelProviders: { openai: [models[0], models[0]] } }),
    );
    load();
    const before = fs.readFileSync(filename, 'utf8');
    expect(updateModelContextWindow(load(), key, 1)).toBeUndefined();
    const duplicatedKey = listModelConfigurations(load())[0]!.key;
    expect(updateModelContextWindow(load(), duplicatedKey, 1)).toBeUndefined();
    expect(fs.readFileSync(filename, 'utf8')).toBe(before);
  });
  it('does not load untrusted workspace providers or write after generation closes', () => {
    fs.mkdirSync(path.join(temp, '.qwen'));
    fs.writeFileSync(
      path.join(temp, '.qwen/settings.json'),
      JSON.stringify({ modelProviders: { openai: [{ id: 'untrusted' }] } }),
    );
    const configs = listModelConfigurations(load(false));
    expect(configs.map((model) => model.modelId)).not.toContain('untrusted');
    const before = read();
    expect(() =>
      updateModelContextWindow(load(false), configs[0]!.key, 10, () => {
        throw new Error('closed');
      }),
    ).toThrow('closed');
    expect(read()).toEqual(before);
  });
});
