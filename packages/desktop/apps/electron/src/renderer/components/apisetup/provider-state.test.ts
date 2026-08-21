import { describe, expect, it } from 'bun:test';
import type { QwenProviderSummary } from '../../../shared/types';
import {
  apiKeyAfterBaseUrlChange,
  baseUrlAfterProtocolChange,
  canonicalBaseUrl,
  customModelIdsAfterEdit,
  defaultBaseUrl,
  defaultModelIds,
  initialApiKey,
  initialModelIds,
  modelIdsAfterBaseUrlChange,
  parseModelIds,
  protocolBaseUrl,
  resetTrimmedDefaultModelIds,
  seedProtocolModelState,
  seedProviderModelState,
  switchEndpointModelState,
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

  it('canonicalizes a saved endpoint with a trailing slash', () => {
    expect(
      canonicalBaseUrl(kimi, 'https://api.moonshot.ai/v1/'),
    ).toBe('https://api.moonshot.ai/v1');
    expect(
      defaultModelIds(kimi, 'https://api.moonshot.ai/v1/'),
    ).toEqual(['kimi-k3']);
    expect(
      initialModelIds(
        {
          ...kimi,
          existingConfig: {
            modelIdsByBaseUrl: {
              'https://api.moonshot.ai/v1/': ['kimi-k3', 'saved-custom'],
            },
          },
        },
        'https://api.moonshot.ai/v1',
      ),
    ).toEqual(['kimi-k3', 'saved-custom']);
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

  it('seeds saved models and trims for every configured endpoint', () => {
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
          models: [
            { id: 'kimi-k3' },
            { id: 'kimi-k2.7-code' },
            { id: 'kimi-k2.7-code-highspeed' },
            { id: 'kimi-k2.6' },
          ],
        },
      ],
      existingConfig: {
        baseUrl: codingUrl,
        modelIds: ['k3-256k'],
        modelIdsByBaseUrl: {
          [codingUrl]: ['k3-256k'],
          [apiUrl]: ['kimi-k3', 'my-api-model'],
        },
      },
    };

    const seeded = seedProviderModelState(provider, codingUrl);

    expect(seeded.modelIds).toEqual(['k3-256k']);
    expect(seeded.customModelIds).toEqual(['my-api-model']);
    expect(seeded.customModelIdsByBaseUrl.get(codingUrl)).toEqual([]);
    expect(seeded.customModelIdsByBaseUrl.get(apiUrl)).toEqual([
      'my-api-model',
    ]);
    expect(seeded.trimmedDefaultModelIds.get(codingUrl)).toEqual(['k3']);
    expect(seeded.trimmedDefaultModelIds.get(apiUrl)).toEqual([
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
    ]);

    expect(
      modelIdsAfterBaseUrlChange(
        provider,
        codingUrl,
        apiUrl,
        seeded.modelIds.join(', '),
        seeded.customModelIds,
        seeded.trimmedDefaultModelIds.get(apiUrl),
        seeded.customModelIdsByBaseUrl.get(apiUrl),
      ).modelIds,
    ).toEqual(['kimi-k3', 'my-api-model']);
  });

  it('restores each saved endpoint custom set without cross-endpoint union', () => {
    const codingUrl = 'https://api.kimi.com/coding/v1';
    const apiUrl = 'https://api.moonshot.ai/v1';
    const savedCustoms = new Map([
      [codingUrl, []],
      [apiUrl, ['my-api-model']],
    ]);

    const atApi = modelIdsAfterBaseUrlChange(
      kimi,
      codingUrl,
      apiUrl,
      'k3-256k, coding-custom',
      ['coding-custom'],
      [],
      savedCustoms.get(apiUrl),
    );
    expect(atApi).toEqual({
      modelIds: ['kimi-k3', 'my-api-model'],
      customModelIds: ['my-api-model'],
    });

    const backAtCoding = modelIdsAfterBaseUrlChange(
      kimi,
      apiUrl,
      codingUrl,
      atApi.modelIds.join(', '),
      atApi.customModelIds,
      [],
      savedCustoms.get(codingUrl),
    );
    expect(backAtCoding).toEqual({
      modelIds: ['k3-256k'],
      customModelIds: [],
    });
  });

  it('persists unseen endpoint custom drafts across a saved-endpoint detour', () => {
    const codingUrl = 'https://api.kimi.com/coding/v1';
    const apiUrl = 'https://api.moonshot.ai/v1';
    const unseenUrl = 'https://preview.example/v1';
    const provider: QwenProviderSummary = {
      ...kimi,
      baseUrl: [
        ...(Array.isArray(kimi.baseUrl) ? kimi.baseUrl : []),
        {
          id: 'preview',
          label: 'Preview',
          url: unseenUrl,
          models: [{ id: 'preview-default' }],
        },
      ],
    };
    const drafts = new Map<string, string[]>([
      [codingUrl, ['coding-custom']],
      [apiUrl, ['api-custom']],
    ]);
    const trims = new Map<string, string[]>();

    const atPreview = switchEndpointModelState(
      provider,
      codingUrl,
      unseenUrl,
      'k3-256k, coding-custom',
      ['coding-custom'],
      drafts,
      trims,
    );
    expect(atPreview.modelIds).toEqual([
      'preview-default',
      'coding-custom',
    ]);

    const atApi = switchEndpointModelState(
      provider,
      unseenUrl,
      apiUrl,
      atPreview.modelIds.join(', '),
      atPreview.customModelIds,
      drafts,
      trims,
    );
    expect(atApi.modelIds).toEqual(['kimi-k3', 'api-custom']);

    const backAtPreview = switchEndpointModelState(
      provider,
      apiUrl,
      unseenUrl,
      atApi.modelIds.join(', '),
      atApi.customModelIds,
      drafts,
      trims,
    );
    expect(backAtPreview.modelIds).toEqual([
      'preview-default',
      'coding-custom',
    ]);
  });

  it('does not resurrect a saved custom id trimmed at the destination', () => {
    expect(
      modelIdsAfterBaseUrlChange(
        kimi,
        'https://api.moonshot.ai/v1',
        'https://api.kimi.com/coding/v1',
        'kimi-k3',
        [],
        ['k3'],
        ['k3'],
      ),
    ).toEqual({
      modelIds: ['k3-256k'],
      customModelIds: ['k3'],
    });
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

describe('protocol-axis model seeding (R35-12)', () => {
  const proxyUrl = 'https://proxy.example/v1';
  const custom: QwenProviderSummary = {
    ...kimi,
    id: 'custom-openai-compatible',
    protocol: 'openai',
    protocolOptions: ['openai', 'anthropic', 'gemini'],
    baseUrl: undefined,
    defaultModelIds: [],
    models: [],
    baseUrlPlaceholder: 'https://api.example.com/v1',
  };

  it('protocolBaseUrl returns the saved baseUrl for a connected protocol', () => {
    const provider: QwenProviderSummary = {
      ...custom,
      existingConfig: {
        baseUrlByProtocol: {
          openai: proxyUrl,
          anthropic: proxyUrl,
        },
      },
    };
    expect(protocolBaseUrl(provider, 'openai')).toBe(proxyUrl);
    expect(protocolBaseUrl(provider, 'anthropic')).toBe(proxyUrl);
    expect(protocolBaseUrl(provider, 'gemini')).toBeUndefined();
  });

  it('seeds the model field from the selected protocol bucket, not the first', () => {
    const provider: QwenProviderSummary = {
      ...custom,
      existingConfig: {
        protocol: 'openai',
        baseUrl: proxyUrl,
        modelIds: ['m1', 'm2'],
        modelIdsByBaseUrl: { [proxyUrl]: ['m1', 'm2'] },
        modelIdsByBaseUrlByProtocol: {
          openai: { [proxyUrl]: ['m1', 'm2'] },
          anthropic: { [proxyUrl]: ['a1', 'a2'] },
        },
        baseUrlByProtocol: {
          openai: proxyUrl,
          anthropic: proxyUrl,
        },
      },
    };

    // Default seed shows the first bucket's models (m1, m2).
    const openaiSeed = seedProtocolModelState(provider, 'openai', proxyUrl);
    expect(openaiSeed.modelIds).toEqual(['m1', 'm2']);

    // Flipping to anthropic must re-seed with that bucket's own models,
    // not keep m1/m2 (which would delete a1/a2 on submit).
    const anthropicSeed = seedProtocolModelState(
      provider,
      'anthropic',
      proxyUrl,
    );
    expect(anthropicSeed.modelIds).toEqual(['a1', 'a2']);
    expect(anthropicSeed.customModelIds).toEqual(['a1', 'a2']);
    expect(anthropicSeed.customModelIdsByBaseUrl.get(proxyUrl)).toEqual([
      'a1',
      'a2',
    ]);
  });

  it('falls back to defaults for a protocol with no saved state', () => {
    const provider: QwenProviderSummary = {
      ...custom,
      defaultModelIds: ['default-model'],
      existingConfig: {
        modelIdsByBaseUrlByProtocol: { openai: { [proxyUrl]: ['m1'] } },
        baseUrlByProtocol: { openai: proxyUrl },
      },
    };
    const geminiSeed = seedProtocolModelState(provider, 'gemini', proxyUrl);
    expect(geminiSeed.modelIds).toEqual(['default-model']);
    expect(geminiSeed.customModelIds).toEqual([]);
  });
});

describe('round-37 regressions', () => {
  const codingUrl = 'https://api.kimi.com/coding/v1';
  const chinaUrl = 'https://api.moonshot.cn/v1';
  const intlUrl = 'https://api.moonshot.ai/v1';

  const freeForm: QwenProviderSummary = {
    ...kimi,
    id: 'custom-openai-compatible',
    protocolOptions: ['openai', 'anthropic', 'gemini'],
    baseUrl: undefined,
    defaultModelIds: [],
    models: [],
    baseUrlPlaceholder: 'https://api.openai.com/v1',
  };

  it('canonicalizes free-form endpoint URLs like the producer keys', () => {
    // The ACP producer slash-strips the per-endpoint map keys
    // (normalizeBaseUrlForMatching); free-form lookups must normalize the
    // form-state URL the same way or a trailing-slash spelling misses the
    // destination's saved state.
    expect(canonicalBaseUrl(freeForm, 'https://b.example/v1/')).toBe(
      'https://b.example/v1',
    );
    expect(canonicalBaseUrl(freeForm, '  https://b.example/v1  ')).toBe(
      'https://b.example/v1',
    );
    // Preset endpoints keep canonicalizing to the option URL.
    expect(canonicalBaseUrl(kimi, 'https://api.moonshot.ai/v1/')).toBe(intlUrl);
  });

  it('restores a free-form destination saved state when the typed URL adds a trailing slash', () => {
    const provider: QwenProviderSummary = {
      ...freeForm,
      existingConfig: {
        protocol: 'openai',
        baseUrl: 'https://a.example/v1',
        modelIds: ['m1'],
        modelIdsByBaseUrl: {
          'https://a.example/v1': ['m1'],
          'https://b.example/v1': ['m2'],
        },
      },
    };
    const seeded = seedProviderModelState(provider, 'https://a.example/v1');
    expect(seeded.modelIds).toEqual(['m1']);

    // The user types the destination with a trailing slash; the lookup must
    // still hit the producer's slash-stripped key and restore m2 instead of
    // treating the destination as unseen and re-homing the previous
    // endpoint's m1 onto it (which the server-side merge would then pay for
    // by deleting m2).
    const next = switchEndpointModelState(
      provider,
      'https://a.example/v1',
      'https://b.example/v1/',
      seeded.modelIds.join(', '),
      seeded.customModelIds,
      seeded.customModelIdsByBaseUrl,
      seeded.trimmedDefaultModelIds,
    );
    expect(next.modelIds).toEqual(['m2']);
    expect(next.customModelIds).toEqual(['m2']);
  });

  it('keeps the typed endpoint when switching to a protocol without a saved bucket', () => {
    const provider: QwenProviderSummary = {
      ...freeForm,
      existingConfig: {
        baseUrlByProtocol: { openai: 'https://proxy.example/v1/' },
      },
    };
    // A connected protocol restores its saved bucket's canonical endpoint.
    expect(baseUrlAfterProtocolChange(provider, 'openai')).toBe(
      'https://proxy.example/v1',
    );
    // An unsaved bucket yields undefined — the form keeps the user's typed
    // endpoint and model state; it must never fall back to the DEFAULT
    // protocol's placeholder (baseUrlPlaceholder).
    expect(
      baseUrlAfterProtocolChange(provider, 'anthropic'),
    ).toBeUndefined();
    expect(baseUrlAfterProtocolChange(provider, 'gemini')).toBeUndefined();
  });

  it('keeps sibling-provenance ids through a net-zero edit at the colliding endpoint', () => {
    const provider: QwenProviderSummary = {
      ...kimi,
      baseUrl: [
        {
          id: 'coding-plan',
          label: 'Coding Plan',
          url: codingUrl,
          envKey: 'KIMI_CODE_API_KEY',
          models: [{ id: 'k3-256k' }],
        },
        {
          id: 'api-china',
          label: 'API Key (China)',
          url: chinaUrl,
          envKey: 'MOONSHOT_API_KEY',
          models: [{ id: 'kimi-k3' }],
        },
        {
          id: 'api-international',
          label: 'API Key (International)',
          url: intlUrl,
          envKey: 'MOONSHOT_API_KEY',
          models: [{ id: 'kimi-k3' }],
        },
      ],
      existingConfig: {
        protocol: 'openai',
        baseUrl: intlUrl,
        modelIds: ['kimi-k3', 'k3-256k'],
        modelIdsByBaseUrl: { [intlUrl]: ['kimi-k3', 'k3-256k'] },
      },
    };

    const seeded = seedProviderModelState(provider, intlUrl);
    expect(seeded.modelIds).toEqual(['kimi-k3', 'k3-256k']);
    // k3-256k is tracked as a custom of the API endpoint (sibling
    // provenance: it is Coding Plan's built-in).
    expect(seeded.customModelIdsByBaseUrl.get(intlUrl)).toEqual(['k3-256k']);

    // Switch to Coding Plan: the carried id lands in that endpoint's entry.
    const atCoding = switchEndpointModelState(
      provider,
      intlUrl,
      codingUrl,
      seeded.modelIds.join(', '),
      seeded.customModelIds,
      seeded.customModelIdsByBaseUrl,
      seeded.trimmedDefaultModelIds,
    );
    expect(atCoding.modelIds).toEqual(['k3-256k']);
    expect(seeded.customModelIdsByBaseUrl.get(codingUrl)).toEqual(['k3-256k']);

    // A net-zero edit of the models field at Coding Plan must write the
    // per-endpoint entry with the same provenance-preserving computation
    // the switch path uses; a bare `field − defaults` would erase k3-256k
    // here because it is Coding Plan's own built-in.
    const edited = customModelIdsAfterEdit(
      defaultModelIds(provider, codingUrl),
      seeded.customModelIdsByBaseUrl.get(codingUrl) ?? [],
      parseModelIds(atCoding.modelIds.join(', ')),
    );
    seeded.customModelIdsByBaseUrl.set(codingUrl, edited);
    expect(edited).toEqual(['k3-256k']);

    // Switch to the unseen China endpoint: k3-256k must be carried through
    // instead of silently dropping out of the form and the next connect.
    const atChina = switchEndpointModelState(
      provider,
      codingUrl,
      chinaUrl,
      atCoding.modelIds.join(', '),
      atCoding.customModelIds,
      seeded.customModelIdsByBaseUrl,
      seeded.trimmedDefaultModelIds,
    );
    expect(atChina.modelIds).toEqual(['kimi-k3', 'k3-256k']);
  });
});
