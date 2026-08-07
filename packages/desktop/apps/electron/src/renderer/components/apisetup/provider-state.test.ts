import { describe, expect, it } from 'bun:test';
import type { QwenProviderSummary } from '../../../shared/types';
import {
  apiKeyAfterBaseUrlChange,
  defaultModelIds,
  initialApiKey,
  initialModelIds,
  modelIdsDifferFromDefaults,
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
        'https://api.kimi.com/coding/v1',
        'https://api.moonshot.ai/v1',
        'k3-256k, custom-model',
      ).modelIds,
    ).toEqual(['kimi-k3', 'custom-model']);
  });

  it('keeps seeded custom models across an endpoint round trip', () => {
    const codingUrl = 'https://api.kimi.com/coding/v1';
    const apiUrl = 'https://api.moonshot.ai/v1';
    // Seeded from existingConfig: k3-256k is a coding default, kimi-k3 is a
    // saved custom model whose id collides with the API endpoint built-in.
    const seeded = ['k3-256k', 'kimi-k3'];
    const seededDefaults = new Set(defaultModelIds(kimi, codingUrl));
    const customModelIds = seeded.filter((id) => !seededDefaults.has(id));

    const afterSwitchAway = modelIdsAfterBaseUrlChange(
      kimi,
      codingUrl,
      apiUrl,
      seeded.join(', '),
      customModelIds,
    );
    const afterRoundTrip = modelIdsAfterBaseUrlChange(
      kimi,
      apiUrl,
      codingUrl,
      afterSwitchAway.modelIds.join(', '),
      afterSwitchAway.customModelIds,
    );

    expect(afterRoundTrip.modelIds).toEqual(['k3-256k', 'kimi-k3']);
    expect(afterRoundTrip.customModelIds).toEqual(['kimi-k3']);
  });

  it('does not resurrect custom model IDs the user deleted before switching', () => {
    const { modelIds, customModelIds } = modelIdsAfterBaseUrlChange(
      kimi,
      'https://api.kimi.com/coding/v1',
      'https://api.moonshot.ai/v1',
      'k3-256k',
      ['custom-model'],
    );
    expect(modelIds).toEqual(['kimi-k3']);
    expect(customModelIds).toEqual([]);
  });

  it('treats persisted default trimming as an authoritative model edit', () => {
    const provider: QwenProviderSummary = {
      ...kimi,
      baseUrl: [
        {
          id: 'coding-plan',
          label: 'Coding Plan',
          url: 'https://api.kimi.com/coding/v1',
          models: [{ id: 'k3-256k' }, { id: 'k3' }],
        },
      ],
    };

    expect(
      modelIdsDifferFromDefaults(provider, 'https://api.kimi.com/coding/v1', [
        'k3-256k',
      ]),
    ).toBe(true);
    expect(
      modelIdsDifferFromDefaults(
        provider,
        'https://api.kimi.com/coding/v1',
        'k3-256k, k3',
      ),
    ).toBe(false);
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

  it('keeps a same-domain API key unchanged on endpoint switch', () => {
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
      ],
    };
    const drafts = new Map<string, string>();

    expect(
      apiKeyAfterBaseUrlChange(
        regionalKimi,
        'https://api.moonshot.cn/v1',
        'https://api.moonshot.ai/v1',
        'typed-key',
        drafts,
      ),
    ).toBe('typed-key');
    expect(drafts.size).toBe(0);
  });

  it('keeps the typed API key when the current base URL matches no endpoint option', () => {
    const drafts = new Map<string, string>();

    expect(
      apiKeyAfterBaseUrlChange(
        kimi,
        'https://corporate-proxy.example/v1',
        'https://api.kimi.com/coding/v1',
        'typed-key',
        drafts,
      ),
    ).toBe('typed-key');
    expect(drafts.size).toBe(0);
  });

  it('clears endpoint drafts when seeding a new provider form', () => {
    const drafts = new Map([['SHARED_API_KEY', 'draft-from-provider-a']]);

    expect(initialApiKey(kimi, drafts)).toBe('');
    expect(drafts.size).toBe(0);

    const withExistingKey: QwenProviderSummary = {
      ...kimi,
      existingConfig: { apiKey: 'sk-existing' },
    };
    drafts.set('SHARED_API_KEY', 'draft-from-provider-a');
    expect(initialApiKey(withExistingKey, drafts)).toBe('sk-existing');
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
        drafts,
      ),
    ).toBe('');

    expect(
      apiKeyAfterBaseUrlChange(
        kimi,
        apiUrl,
        codingUrl,
        'typed-api-key',
        drafts,
      ),
    ).toBe('typed-code-key');

    expect(apiKeyAfterBaseUrlChange(kimi, codingUrl, apiUrl, '', drafts)).toBe(
      'typed-api-key',
    );
  });

  it('keeps draft direction correct across three credential domains', () => {
    const urls = [
      'https://a.example/v1',
      'https://b.example/v1',
      'https://c.example/v1',
    ];
    const provider: QwenProviderSummary = {
      ...kimi,
      baseUrl: urls.map((url, index) => ({
        id: `domain-${index}`,
        label: `Domain ${index}`,
        url,
        envKey: `DOMAIN_${index}_API_KEY`,
      })),
    };
    const drafts = new Map<string, string>();

    expect(
      apiKeyAfterBaseUrlChange(provider, urls[0], urls[1], 'key-a', drafts),
    ).toBe('');
    expect(
      apiKeyAfterBaseUrlChange(provider, urls[1], urls[2], 'key-b', drafts),
    ).toBe('');
    expect(
      apiKeyAfterBaseUrlChange(provider, urls[2], urls[0], 'key-c', drafts),
    ).toBe('key-a');
    expect(
      apiKeyAfterBaseUrlChange(provider, urls[0], urls[1], 'key-a2', drafts),
    ).toBe('key-b');
  });
});
