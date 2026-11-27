/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsService } from '@qwen-code/resource';
import type { CustomClient } from '../../client/customClient.js';
import { parseCustomProviderSettings } from '../custom/parser.js';
import type { ModelProvider } from '../modelProvider.js';
import type { ModelStreamRequest } from '../modelStreamRequest.js';
import type { ModelTransport } from '../transport/modelTransport.js';
import { ModelTransportManager } from '../transport/modelTransportManager.js';
import { CustomModelProvider } from './customModelProvider.js';
import { registerCustomProviderComposer } from './customProviderComposers.js';
import {
  createCustomModelProviders,
  customProviderConfigFromRuntime,
} from './customModelProviderFactory.js';

const transportManager = {
  resolve: () => ({}),
} as unknown as ModelTransportManager;
const settingsService = {} as SettingsService;

afterEach(() => {
  registerCustomProviderComposer('reserved', undefined);
});

describe('createCustomModelProviders', () => {
  it('composes a reserved id before the generic parser', () => {
    const composed = { providerId: 'reserved' } as unknown as ModelProvider;
    const compose = vi.fn(() => composed);
    registerCustomProviderComposer('reserved', compose);

    const providers = createCustomModelProviders(
      {
        reserved: { anything: true },
        normal: {
          baseUrl: 'https://gateway.example/v1',
          apiKey: 'secret',
          model: 'model-1',
        },
      },
      transportManager,
      settingsService,
      'user',
    );

    expect(compose).toHaveBeenCalledTimes(1);
    expect(providers.map((provider) => provider.providerId)).toEqual([
      'reserved',
      'normal',
    ]);
  });

  it('drops the reserved id when the composer declines', () => {
    registerCustomProviderComposer('reserved', () => undefined);

    const providers = createCustomModelProviders(
      { reserved: { anything: true } },
      transportManager,
      settingsService,
      'user',
    );

    expect(providers).toEqual([]);
  });
});

function configOf(settings: Record<string, unknown>) {
  const { providers, issues } = parseCustomProviderSettings({ p: settings });
  expect(issues).toEqual([]);
  return customProviderConfigFromRuntime(providers[0]);
}

const base = { baseUrl: 'https://gateway.example/v1', apiKey: '' };
const anthropic = { ...base, protocol: 'anthropic', model: 'a' };

describe('customProviderConfigFromRuntime promptCache', () => {
  it('anthropic 默认 auto/5m 对全部模型开启且不落 ttl，1h 落 ttl，off 关闭', () => {
    expect(configOf(anthropic).promptCache).toEqual(
      new Map([['p/a', { type: 'ephemeral' }]]),
    );
    expect(
      configOf({ ...anthropic, anthropic: { cache: { ttl: '1h' } } })
        .promptCache.get('p/a'),
    ).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(
      configOf({ ...anthropic, anthropic: { cache: { mode: 'off' } } })
        .promptCache.size,
    ).toBe(0);
  });

  it('OpenAI 系按模型 cacheControl 能力开启', () => {
    const config = configOf({
      ...base,
      model: 'on',
      models: [
        { model: 'on', capabilities: { cacheControl: true } },
        { model: 'off' },
      ],
    });
    expect([...config.promptCache.keys()]).toEqual(['p/on']);
  });
});

describe('CustomModelProvider prompt cache policy', () => {
  it('按所选模型的策略改写 prompt 后交给 transport', async () => {
    const config = configOf(anthropic);
    const seen: ModelStreamRequest[] = [];
    const transport: ModelTransport = {
      protocol: config.protocol,
      stream: vi.fn((_client, request: ModelStreamRequest) => {
        seen.push(request);
        return (async function* () {})();
      }),
    };
    const provider = new CustomModelProvider({
      transportManager: new ModelTransportManager([transport]),
      config,
      client: {} as CustomClient,
      settingsService: new SettingsService(),
      scope: 'user',
    });
    const response = await provider.inference({
      resolution: { model: config.models[0], config: {} },
      prompt: {
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'sys' }] },
          { role: 'user', content: 'q' },
        ],
      },
      cacheKey: 'session-1',
    });
    response.cancel?.();
    await response.completed.catch(() => undefined);
    expect(seen[0]?.cacheKey).toBe('session-1');
    expect(seen[0]?.prompt.messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'sys', cacheControl: { type: 'ephemeral' } }],
    });
  });
});
