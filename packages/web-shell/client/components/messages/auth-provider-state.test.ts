import { describe, expect, it } from 'vitest';
import type { DaemonAuthProviderDescriptor } from '@qwen-code/webui/daemon-react-sdk';
import {
  baseUrlOptionModelIds,
  selectedBaseUrlEnvKey,
  selectedBaseUrlModelIds,
} from './auth-provider-state';

const kimi: DaemonAuthProviderDescriptor = {
  id: 'kimi',
  label: 'Kimi',
  description: 'Kimi access',
  protocol: 'openai',
  envKey: 'KIMI_CODE_API_KEY',
  models: [{ id: 'k3-256k' }, { id: 'kimi-k3' }],
  baseUrl: [
    {
      id: 'coding-plan',
      label: 'Coding Plan',
      url: 'https://api.kimi.com/coding/v1',
      envKey: 'KIMI_CODE_API_KEY',
      models: [{ id: 'k3-256k' }],
    },
    {
      id: 'api',
      label: 'API',
      url: 'https://api.moonshot.ai/v1',
      envKey: 'MOONSHOT_API_KEY',
      models: [{ id: 'kimi-k3' }],
    },
  ],
  steps: ['baseUrl', 'apiKey', 'models'],
};

describe('auth provider endpoint state', () => {
  it('uses endpoint-specific environment keys and model defaults', () => {
    expect(
      selectedBaseUrlEnvKey(kimi, 'https://api.kimi.com/coding/v1', 'openai'),
    ).toBe('KIMI_CODE_API_KEY');
    expect(
      selectedBaseUrlEnvKey(kimi, 'https://api.moonshot.ai/v1', 'openai'),
    ).toBe('MOONSHOT_API_KEY');
    expect(selectedBaseUrlModelIds(kimi, 'https://api.moonshot.ai/v1')).toBe(
      'kimi-k3',
    );
  });

  it('replaces endpoint defaults while preserving custom model IDs', () => {
    const api = Array.isArray(kimi.baseUrl) ? kimi.baseUrl[1] : undefined;
    expect(api).toBeDefined();
    expect(baseUrlOptionModelIds(api!, kimi, 'k3-256k, custom-model')).toBe(
      'kimi-k3, custom-model',
    );
  });
});
