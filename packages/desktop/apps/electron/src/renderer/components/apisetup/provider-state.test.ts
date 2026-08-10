import { describe, expect, it } from 'bun:test';
import type { QwenProviderSummary } from '../../../shared/types';
import {
  apiKeyAfterBaseUrlChange,
  customModelIdsAfterEdit,
  defaultBaseUrl,
  defaultModelIds,
  initialApiKey,
  initialModelIds,
  modelIdsAfterBaseUrlChange,
  parseModelIds,
  resetTrimmedDefaultModelIds,
  shouldResetApiKeyAfterBaseUrlChange,
  trimmedDefaultModelIds,
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
  it('parses newline- and comma-separated model lists with dedup', () => {
    expect(parseModelIds('a\nb, c')).toEqual(['a', 'b', 'c']);
    expect(parseModelIds('kimi-k3\nkimi-k2.6, kimi-k3')).toEqual([
      'kimi-k3',
      'kimi-k2.6',
    ]);
  });

  it('resolves the default base URL for each provider shape', () => {
    expect(defaultBaseUrl(kimi)).toBe('https://api.kimi.com/coding/v1');
    expect(
      defaultBaseUrl({ ...kimi, baseUrl: 'https://single.example/v1' }),
    ).toBe('https://single.example/v1');
    expect(
      defaultBaseUrl({
        ...kimi,
        baseUrl: undefined,
        baseUrlPlaceholder: 'https://placeholder.example/v1',
      }),
    ).toBe('https://placeholder.example/v1');
  });

  it('seeds the saved model ids of a configured provider', () => {
    expect(
      initialModelIds(
        {
          ...kimi,
          existingConfig: { modelIds: ['k3-256k', 'saved-custom'] },
        },
        'https://api.kimi.com/coding/v1',
      ),
    ).toEqual(['k3-256k', 'saved-custom']);
  });

  it('falls back to provider-level default model ids', () => {
    // String baseUrl presets (no option array) and saved baseUrls that match
    // no current option both take the provider-level fallback.
    expect(
      defaultModelIds(
        { ...kimi, baseUrl: 'https://single.example/v1' },
        'https://single.example/v1',
      ),
    ).toEqual(['k3-256k']);
    expect(
      defaultModelIds(kimi, 'https://no-longer-shipped.example/v1'),
    ).toEqual(['k3-256k']);
  });

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

  it('keeps seeded custom provenance through a destination-endpoint edit', () => {
    expect(
      customModelIdsAfterEdit(
        ['kimi-k3', 'api-default'],
        ['kimi-k3'],
        ['kimi-k3', 'api-default'],
      ),
    ).toEqual(['kimi-k3']);
  });

  it('keeps persisted default trims across an endpoint round trip', () => {
    const codingUrl = 'https://api.kimi.com/coding/v1';
    const apiUrl = 'https://api.moonshot.ai/v1';
    const provider: QwenProviderSummary = {
      ...kimi,
      baseUrl: [
        {
          id: 'coding-plan',
          label: 'Coding Plan',
          url: codingUrl,
          models: [{ id: 'k3-256k' }, { id: 'k3' }],
        },
        {
          id: 'api',
          label: 'API',
          url: apiUrl,
          models: [{ id: 'kimi-k3' }],
        },
      ],
    };
    const seeded = ['k3-256k', 'kimi-k3'];
    const codingTrims = trimmedDefaultModelIds(provider, codingUrl, seeded);
    const customsAfterNetZeroEdit = customModelIdsAfterEdit(
      defaultModelIds(provider, codingUrl),
      ['kimi-k3'],
      seeded,
    );
    const afterSwitchAway = modelIdsAfterBaseUrlChange(
      provider,
      codingUrl,
      apiUrl,
      seeded.join(', '),
      customsAfterNetZeroEdit,
    );
    const afterRoundTrip = modelIdsAfterBaseUrlChange(
      provider,
      apiUrl,
      codingUrl,
      afterSwitchAway.modelIds.join(', '),
      afterSwitchAway.customModelIds,
      codingTrims,
    );

    expect(codingTrims).toEqual(['k3']);
    expect(afterSwitchAway.modelIds).toEqual(['kimi-k3']);
    expect(afterRoundTrip.modelIds).toEqual(['k3-256k', 'kimi-k3']);
  });

  it('keeps custom provenance when the id leaves the field as an endpoint built-in', () => {
    // kimi-k3 is seeded as a Coding Plan custom and collides with the API
    // endpoint built-in; removing it from the field on the API endpoint means
    // "do not install this built-in here", not "delete my saved custom".
    expect(
      customModelIdsAfterEdit(['kimi-k3', 'api-default'], ['kimi-k3'], [
        'api-default',
      ]),
    ).toEqual(['kimi-k3']);
  });

  it('keeps a saved custom through deselection at its colliding endpoint', () => {
    const codingUrl = 'https://api.kimi.com/coding/v1';
    const apiUrl = 'https://api.moonshot.ai/v1';
    // Saved custom [Kimi Code] kimi-k3 on Coding Plan; the form opens there.
    const seeded = ['k3-256k', 'kimi-k3'];
    const seededDefaults = new Set(defaultModelIds(kimi, codingUrl));
    const customModelIds = seeded.filter((id) => !seededDefaults.has(id));

    const afterSwitchToApi = modelIdsAfterBaseUrlChange(
      kimi,
      codingUrl,
      apiUrl,
      seeded.join(', '),
      customModelIds,
    );
    // The user removes kimi-k3 from the API field (it is this endpoint's
    // built-in, so the form shows it as a recommendation).
    const afterDeselect = customModelIdsAfterEdit(
      defaultModelIds(kimi, apiUrl),
      afterSwitchToApi.customModelIds,
      [],
    );
    expect(afterDeselect).toEqual(['kimi-k3']);

    const afterSwitchBack = modelIdsAfterBaseUrlChange(
      kimi,
      apiUrl,
      codingUrl,
      '',
      afterDeselect,
    );
    expect(afterSwitchBack.customModelIds).toEqual(['kimi-k3']);
    expect(afterSwitchBack.modelIds).toEqual(['k3-256k', 'kimi-k3']);
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

  it('resets persisted trims when seeding a different provider', () => {
    const codingUrl = 'https://api.kimi.com/coding/v1';
    const provider: QwenProviderSummary = {
      ...kimi,
      baseUrl: [
        {
          id: 'coding-plan',
          label: 'Coding Plan',
          url: codingUrl,
          models: [{ id: 'k3-256k' }, { id: 'k3' }],
        },
      ],
    };
    const trims = new Map([['https://stale.example/v1', ['stale-default']]]);

    // A saved subset that omits a default must store the non-empty trim —
    // selectProvider restores exactly this value for a configured provider.
    resetTrimmedDefaultModelIds(trims, provider, codingUrl, ['k3-256k']);

    expect([...trims.entries()]).toEqual([[codingUrl, ['k3']]]);
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

  it('clears endpoint drafts and starts empty when seeding a new provider form', () => {
    const drafts = new Map([['SHARED_API_KEY', 'draft-from-provider-a']]);
    expect(initialApiKey(drafts)).toBe('');
    expect(drafts.size).toBe(0);
  });

  it('restores a draft through a sibling endpoint in the same credential domain', () => {
    const cnUrl = 'https://api.moonshot.cn/v1';
    const globalUrl = 'https://api.moonshot.ai/v1';
    const codingUrl = 'https://api.kimi.com/coding/v1';
    const regionalKimi: QwenProviderSummary = {
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
    };
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
