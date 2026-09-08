import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadSettings } from '../config/settings.js';
import {
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
