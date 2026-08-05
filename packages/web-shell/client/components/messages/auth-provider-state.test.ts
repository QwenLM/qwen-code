import { describe, expect, it } from 'vitest';
import type { DaemonAuthProviderDescriptor } from '@qwen-code/webui/daemon-react-sdk';
import {
  apiKeyAfterBaseUrlChange,
  baseUrlOptionModelIds,
  selectedBaseUrlEnvKey,
  selectedBaseUrlModelIds,
  selectedBaseUrlOptionIndex,
  shouldResetApiKeyAfterBaseUrlChange,
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

const mimo: DaemonAuthProviderDescriptor = {
  id: 'xiaomi-mimo',
  label: 'Xiaomi MiMo API Key',
  description: 'Pay-as-you-go API or Token Plan access to Xiaomi MiMo',
  protocol: 'openai',
  envKey: 'MIMO_API_KEY',
  models: [{ id: 'mimo-v2.5-pro' }, { id: 'mimo-v2.5' }],
  baseUrl: [
    {
      id: 'pay-as-you-go',
      label: 'Pay-as-you-go API',
      url: 'https://api.xiaomimimo.com/v1',
    },
    {
      id: 'token-plan-china',
      label: 'Token Plan (China)',
      url: 'https://token-plan-cn.xiaomimimo.com/v1',
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

  it('returns the destination endpoint defaults', () => {
    const api = Array.isArray(kimi.baseUrl) ? kimi.baseUrl[1] : undefined;
    expect(api).toBeDefined();
    expect(baseUrlOptionModelIds(api!, kimi)).toBe('kimi-k3');
  });

  it('resets API keys only when the endpoint key domain changes', () => {
    const regionalKimi = {
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
    } satisfies DaemonAuthProviderDescriptor;

    expect(
      shouldResetApiKeyAfterBaseUrlChange(
        regionalKimi,
        'https://api.moonshot.cn/v1',
        'https://api.moonshot.ai/v1',
        'openai',
      ),
    ).toBe(false);
    expect(
      shouldResetApiKeyAfterBaseUrlChange(
        regionalKimi,
        'https://api.moonshot.ai/v1',
        'https://api.kimi.com/coding/v1',
        'openai',
      ),
    ).toBe(true);
  });

  it('keeps a same-domain API key unchanged on endpoint switch', () => {
    const regionalKimi = {
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
      ],
    } satisfies DaemonAuthProviderDescriptor;
    const drafts = new Map<string, string>();

    expect(
      apiKeyAfterBaseUrlChange(
        regionalKimi,
        'https://api.moonshot.cn/v1',
        'https://api.moonshot.ai/v1',
        'typed-key',
        'openai',
        drafts,
      ),
    ).toBe('typed-key');
    expect(drafts.size).toBe(0);
  });

  it('restores API key drafts across a cross-domain endpoint round trip', () => {
    const drafts = new Map<string, string>();
    const codingUrl = 'https://api.kimi.com/coding/v1';
    const apiUrl = 'https://api.moonshot.ai/v1';

    expect(
      apiKeyAfterBaseUrlChange(
        kimi,
        codingUrl,
        apiUrl,
        'typed-code-key',
        'openai',
        drafts,
      ),
    ).toBe('');

    expect(
      apiKeyAfterBaseUrlChange(
        kimi,
        apiUrl,
        codingUrl,
        'typed-api-key',
        'openai',
        drafts,
      ),
    ).toBe('typed-code-key');

    expect(
      apiKeyAfterBaseUrlChange(kimi, codingUrl, apiUrl, '', 'openai', drafts),
    ).toBe('typed-api-key');
  });

  it('falls back to provider-level models for options without endpoint models', () => {
    const option = Array.isArray(mimo.baseUrl) ? mimo.baseUrl[0] : undefined;
    expect(option).toBeDefined();
    expect(selectedBaseUrlModelIds(mimo, 'https://api.xiaomimimo.com/v1')).toBe(
      'mimo-v2.5-pro, mimo-v2.5',
    );
    expect(baseUrlOptionModelIds(option!, mimo)).toBe(
      'mimo-v2.5-pro, mimo-v2.5',
    );
  });

  it('falls back to the provider-level env key for options without one', () => {
    expect(
      selectedBaseUrlEnvKey(mimo, 'https://api.xiaomimimo.com/v1', 'openai'),
    ).toBe('MIMO_API_KEY');
    expect(
      selectedBaseUrlEnvKey(
        mimo,
        'https://token-plan-cn.xiaomimimo.com/v1',
        'openai',
      ),
    ).toBe('MIMO_API_KEY');
  });

  it('restores the highlighted endpoint from the selected base URL', () => {
    expect(selectedBaseUrlOptionIndex(kimi, 'https://api.moonshot.ai/v1')).toBe(
      1,
    );
    expect(selectedBaseUrlOptionIndex(kimi, 'https://unknown.example/v1')).toBe(
      0,
    );
  });
});
