import { describe, expect, it } from 'vitest';
import type { DaemonAuthProviderDescriptor } from '@qwen-code/webui/daemon-react-sdk';
import {
  apiKeyAfterBaseUrlChange,
  baseUrlOptionModelIds,
  normalizeModelIds,
  selectedBaseUrlDocumentationUrl,
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
  it('normalizes comma-separated model IDs', () => {
    expect(normalizeModelIds('a, b , a,,c')).toEqual(['a', 'b', 'c']);
  });

  it('uses endpoint-specific environment keys and model defaults', () => {
    expect(selectedBaseUrlEnvKey(kimi, 'https://api.kimi.com/coding/v1')).toBe(
      'KIMI_CODE_API_KEY',
    );
    expect(selectedBaseUrlEnvKey(kimi, 'https://api.moonshot.ai/v1')).toBe(
      'MOONSHOT_API_KEY',
    );
    expect(selectedBaseUrlModelIds(kimi, 'https://api.moonshot.ai/v1')).toBe(
      'kimi-k3',
    );
  });

  it('leaves the env key unknown when the catalog carries none', () => {
    // Mirrors the shipped custom-openai-compatible descriptor: the catalog
    // omits `models` entirely, so the ?? fallbacks are the live path.
    const custom: DaemonAuthProviderDescriptor = {
      id: 'custom-openai-compatible',
      label: 'Custom Provider',
      description: 'Manual endpoint',
      protocol: 'openai',
      steps: ['baseUrl', 'apiKey', 'models'],
    };

    expect(
      selectedBaseUrlModelIds(custom, 'https://llm.internal.example/v1'),
    ).toBe('');
    expect(
      baseUrlOptionModelIds(
        { id: 'opt', label: 'Opt', url: 'https://llm.internal.example/v1' },
        custom,
      ),
    ).toBe('');
    expect(
      selectedBaseUrlEnvKey(custom, 'https://llm.internal.example/v1'),
    ).toBeUndefined();
    expect(
      shouldResetApiKeyAfterBaseUrlChange(
        custom,
        'https://a.example/v1',
        'https://b.example/v1',
      ),
    ).toBe(false);

    const drafts = new Map<string, string>();
    expect(
      apiKeyAfterBaseUrlChange(
        custom,
        'https://a.example/v1',
        'https://b.example/v1',
        'typed-key',
        drafts,
      ),
    ).toBe('typed-key');
    expect(drafts.size).toBe(0);
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
        drafts,
      ),
    ).toBe('typed-key');
    expect(drafts.size).toBe(0);
  });

  it('restores a draft through a sibling endpoint in the same credential domain', () => {
    const cnUrl = 'https://api.moonshot.cn/v1';
    const globalUrl = 'https://api.moonshot.ai/v1';
    const codingUrl = 'https://api.kimi.com/coding/v1';
    const regionalKimi = {
      ...kimi,
      baseUrl: [
        {
          id: 'api-cn',
          label: 'API China',
          url: cnUrl,
          envKey: 'MOONSHOT_API_KEY',
        },
        {
          id: 'api-global',
          label: 'API Global',
          url: globalUrl,
          envKey: 'MOONSHOT_API_KEY',
        },
        ...(Array.isArray(kimi.baseUrl) ? kimi.baseUrl.slice(0, 1) : []),
      ],
    } satisfies DaemonAuthProviderDescriptor;
    const drafts = new Map<string, string>();

    // Leave the shared domain via the Coding Plan endpoint; the typed key is
    // stashed under the credential domain, not the China URL.
    expect(
      apiKeyAfterBaseUrlChange(
        regionalKimi,
        cnUrl,
        codingUrl,
        'typed-key',
        drafts,
      ),
    ).toBe('');

    // Restoring through the sibling URL in the same domain must find it.
    expect(
      apiKeyAfterBaseUrlChange(regionalKimi, codingUrl, globalUrl, '', drafts),
    ).toBe('typed-key');
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

    expect(drafts.get('MOONSHOT_API_KEY')).toBe('typed-api-key');

    expect(apiKeyAfterBaseUrlChange(kimi, codingUrl, apiUrl, '', drafts)).toBe(
      'typed-api-key',
    );
    // A cleared field overwrites the stored draft instead of reviving the
    // previous key on the next round trip.
    expect(drafts.get('KIMI_CODE_API_KEY')).toBe('');
  });

  it('keeps draft direction correct across three credential domains', () => {
    const urls = [
      'https://a.example/v1',
      'https://b.example/v1',
      'https://c.example/v1',
    ];
    const provider = {
      ...kimi,
      baseUrl: urls.map((url, index) => ({
        id: `domain-${index}`,
        label: `Domain ${index}`,
        url,
        envKey: `DOMAIN_${index}_API_KEY`,
      })),
    } satisfies DaemonAuthProviderDescriptor;
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
    // Re-entering a domain overwrites its stored draft with the new value.
    expect(drafts.get('DOMAIN_0_API_KEY')).toBe('key-a2');
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
    expect(selectedBaseUrlEnvKey(mimo, 'https://api.xiaomimimo.com/v1')).toBe(
      'MIMO_API_KEY',
    );
    expect(
      selectedBaseUrlEnvKey(mimo, 'https://token-plan-cn.xiaomimimo.com/v1'),
    ).toBe('MIMO_API_KEY');
  });

  it('resolves endpoint-specific documentation URLs', () => {
    const documented = {
      ...kimi,
      documentationUrl: 'https://www.kimi.com/code/docs/en/',
      baseUrl: [
        {
          id: 'coding-plan',
          label: 'Coding Plan',
          url: 'https://api.kimi.com/coding/v1',
          documentationUrl: 'https://www.kimi.com/code/docs/en/',
        },
        {
          id: 'api-cn',
          label: 'API Key (China)',
          url: 'https://api.moonshot.cn/v1',
          documentationUrl: 'https://platform.kimi.com/docs/api/overview',
        },
      ],
    } satisfies DaemonAuthProviderDescriptor;

    expect(
      selectedBaseUrlDocumentationUrl(documented, 'https://api.moonshot.cn/v1'),
    ).toBe('https://platform.kimi.com/docs/api/overview');
    expect(
      selectedBaseUrlDocumentationUrl(
        documented,
        'https://api.kimi.com/coding/v1',
      ),
    ).toBe('https://www.kimi.com/code/docs/en/');
    expect(
      selectedBaseUrlDocumentationUrl(documented, 'https://unknown.example/v1'),
    ).toBe('https://www.kimi.com/code/docs/en/');
  });

  it('falls back to the provider-level documentation URL for options without one', () => {
    const documented = {
      ...mimo,
      documentationUrl:
        'https://mimo.mi.com/docs/en-US/quick-start/summary/first-api-call',
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
          documentationUrl: 'https://mimo.mi.com/docs/tokenplan/subscription',
        },
      ],
    } satisfies DaemonAuthProviderDescriptor;

    expect(
      selectedBaseUrlDocumentationUrl(
        documented,
        'https://token-plan-cn.xiaomimimo.com/v1',
      ),
    ).toBe('https://mimo.mi.com/docs/tokenplan/subscription');
    expect(
      selectedBaseUrlDocumentationUrl(
        documented,
        'https://api.xiaomimimo.com/v1',
      ),
    ).toBe('https://mimo.mi.com/docs/en-US/quick-start/summary/first-api-call');
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
