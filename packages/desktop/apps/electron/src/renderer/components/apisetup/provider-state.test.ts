import { describe, expect, it } from 'bun:test';
import type { QwenProviderSummary } from '../../../shared/types';
import {
  defaultModelIds,
  initialModelIds,
  modelIdsAfterBaseUrlChange,
  shouldResetApiKeyAfterBaseUrlChange,
} from './provider-state';

const kimi: QwenProviderSummary = {
  id: 'kimi',
  label: 'Kimi',
  description: 'Kimi access',
  protocol: 'openai',
  protocolOptions: [],
  defaultModelIds: ['k3-256k'],
  models: [{ id: 'k3-256k' }, { id: 'kimi-k3' }],
  modelsEditable: true,
  showAdvancedConfig: false,
  uiGroup: 'third-party',
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
};

describe('provider endpoint state', () => {
  it('uses endpoint-specific defaults for initial state', () => {
    expect(defaultModelIds(kimi, 'https://api.moonshot.ai/v1')).toEqual([
      'kimi-k3',
    ]);
    expect(initialModelIds(kimi, 'https://api.kimi.com/coding/v1')).toEqual([
      'k3-256k',
    ]);
  });

  it('replaces endpoint defaults while preserving custom model IDs', () => {
    expect(
      modelIdsAfterBaseUrlChange(
        kimi,
        'https://api.moonshot.ai/v1',
        'k3-256k, custom-model',
      ),
    ).toEqual(['kimi-k3', 'custom-model']);
  });

  it('resets API keys only when the endpoint key domain changes', () => {
    const regionalKimi: QwenProviderSummary = {
      ...kimi,
      baseUrl: [
        {
          id: 'api-cn',
          label: 'API China',
          url: 'https://api.moonshot.cn/v1',
          envKey: 'MOONSHOT_API_KEY',
        },
        {
          id: 'api-global',
          label: 'API Global',
          url: 'https://api.moonshot.ai/v1',
          envKey: 'MOONSHOT_API_KEY',
        },
        ...(Array.isArray(kimi.baseUrl) ? kimi.baseUrl.slice(0, 1) : []),
      ],
    };

    expect(
      shouldResetApiKeyAfterBaseUrlChange(
        regionalKimi,
        'https://api.moonshot.cn/v1',
        'https://api.moonshot.ai/v1',
      ),
    ).toBe(false);
    expect(
      shouldResetApiKeyAfterBaseUrlChange(
        regionalKimi,
        'https://api.moonshot.ai/v1',
        'https://api.kimi.com/coding/v1',
      ),
    ).toBe(true);
  });
});
