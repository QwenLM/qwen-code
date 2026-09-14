import { describe, expect, it } from 'vitest';
import { parseAuthProviderInstallRequest } from './auth-provider-helpers.js';

const request = {
  providerId: 'custom-openai-compatible',
  protocol: 'openai',
  baseUrl: 'https://media.example/v1',
  apiKey: 'test-only',
  modelIds: ['qwen3-asr-flash'],
};
describe('custom service model purpose', () => {
  it('defaults an omitted voice protocol to OpenAI', () => {
    expect(
      parseAuthProviderInstallRequest({
        ...request,
        protocol: undefined,
        advancedConfig: { purpose: 'voice' },
      }),
    ).toMatchObject({ ok: true });
  });
  it.each(['voice', 'image'])(
    'accepts %s and preserves it in the setup inputs',
    (purpose) => {
      expect(
        parseAuthProviderInstallRequest({
          ...request,
          advancedConfig: { purpose },
        }),
      ).toMatchObject({ ok: true, value: { advancedConfig: { purpose } } });
    },
  );
  it.each([
    { modelIds: [], advancedConfig: { purpose: 'image' } },
    { modelIds: undefined, advancedConfig: { purpose: 'image' } },
    { advancedConfig: { purpose: 'unknown' } },
    { providerId: 'minimax', advancedConfig: { purpose: 'image' } },
    { protocol: 'anthropic', advancedConfig: { purpose: 'voice' } },
    { modelIds: ['chat-model'], advancedConfig: { purpose: 'voice' } },
    { baseUrl: undefined, advancedConfig: { purpose: 'voice' } },
    {
      baseUrl: 'https://media.example/v1?key=secret',
      advancedConfig: { purpose: 'image' },
    },
    {
      baseUrl: 'https://media.example/v1#secret',
      advancedConfig: { purpose: 'image' },
    },
    {
      baseUrl: 'http://media.example/v1',
      advancedConfig: { purpose: 'image' },
    },
  ])('rejects unsupported purpose configuration: %j', (override) => {
    expect(
      parseAuthProviderInstallRequest({ ...request, ...override }),
    ).toMatchObject({ ok: false });
  });
});

describe('advanced form replacement', () => {
  it.each([true, false, 'true', 1, null, undefined])(
    'requires an explicit true boolean for %j',
    (replaceExisting) => {
      const parsed = parseAuthProviderInstallRequest({
        ...request,
        advancedConfig: { replaceExisting, contextWindowSize: 32768 },
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('Request rejected');
      expect(parsed.value.advancedConfig).toEqual({
        ...(replaceExisting === true ? { replaceExisting: true } : {}),
        contextWindowSize: 32768,
      });
    },
  );
});
