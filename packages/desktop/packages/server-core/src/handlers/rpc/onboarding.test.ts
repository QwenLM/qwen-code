import { describe, expect, it } from 'bun:test'
import { hasExistingProviderConfig } from './onboarding'

describe('hasExistingProviderConfig', () => {
  it('recognizes stored credentials and models without exposing the key', () => {
    expect(
      hasExistingProviderConfig({
        providers: [{ existingConfig: { hasApiKey: true } }],
      }),
    ).toBe(true)
    expect(
      hasExistingProviderConfig({
        providers: [{ existingConfig: { modelIds: ['model'] } }],
      }),
    ).toBe(true)
  })

  it('rejects empty or absent provider configuration', () => {
    expect(
      hasExistingProviderConfig({ providers: [{ existingConfig: {} }] }),
    ).toBe(false)
    expect(hasExistingProviderConfig({ providers: [{}] })).toBe(false)
    expect(hasExistingProviderConfig({ providers: [] })).toBe(false)
  })
})
