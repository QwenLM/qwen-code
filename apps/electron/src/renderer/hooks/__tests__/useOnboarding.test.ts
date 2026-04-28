import { describe, it, expect } from 'bun:test'
import {
  resolveSlugForMethod,
  apiSetupMethodToConnectionSetup,
  BASE_SLUG_FOR_METHOD,
} from '../useOnboarding'
import type { ApiSetupMethod } from '@/components/onboarding'

// ============================================================
// resolveSlugForMethod
// ============================================================

describe('resolveSlugForMethod', () => {
  it('returns the base slug when it is available', () => {
    const slug = resolveSlugForMethod('anthropic_api_key', null, new Set())
    expect(slug).toBe('anthropic-api')
  })

  it('reuses editingSlug when editing an existing connection', () => {
    const slug = resolveSlugForMethod('anthropic_api_key', 'my-custom-slug', new Set(['anthropic-api']))
    expect(slug).toBe('my-custom-slug')
  })

  it('appends -2 when base slug is taken', () => {
    const slug = resolveSlugForMethod('anthropic_api_key', null, new Set(['anthropic-api']))
    expect(slug).toBe('anthropic-api-2')
  })

  it('appends -3 when both base and -2 are taken', () => {
    const slug = resolveSlugForMethod('anthropic_api_key', null, new Set(['anthropic-api', 'anthropic-api-2']))
    expect(slug).toBe('anthropic-api-3')
  })

  it('works for all setup methods', () => {
    const methods: ApiSetupMethod[] = [
      'anthropic_api_key', 'claude_oauth',
      'pi_chatgpt_oauth', 'pi_copilot_oauth', 'pi_api_key', 'qwen_code',
    ]
    for (const method of methods) {
      const slug = resolveSlugForMethod(method, null, new Set())
      expect(slug).toBe(BASE_SLUG_FOR_METHOD[method])
    }
  })
})

// ============================================================
// apiSetupMethodToConnectionSetup
// ============================================================

describe('apiSetupMethodToConnectionSetup', () => {
  it('anthropic_api_key includes credential, baseUrl, defaultModel, models', () => {
    const setup = apiSetupMethodToConnectionSetup(
      'anthropic_api_key',
      { credential: 'sk-ant-test', baseUrl: 'https://custom.api', connectionDefaultModel: 'claude-sonnet-4-6', models: ['model-a'] },
      null,
      new Set(),
    )
    expect(setup.slug).toBe('anthropic-api')
    expect(setup.credential).toBe('sk-ant-test')
    expect(setup.baseUrl).toBe('https://custom.api')
    expect(setup.defaultModel).toBe('claude-sonnet-4-6')
    expect(setup.models).toEqual(['model-a'])
  })

  it('claude_oauth includes only credential', () => {
    const setup = apiSetupMethodToConnectionSetup(
      'claude_oauth',
      { credential: 'oauth-token-123' },
      null,
      new Set(),
    )
    expect(setup.slug).toBe('claude-max')
    expect(setup.credential).toBe('oauth-token-123')
    expect(setup.baseUrl).toBeUndefined()
  })

  it('pi_chatgpt_oauth maps to chatgpt-plus slug', () => {
    const setup = apiSetupMethodToConnectionSetup('pi_chatgpt_oauth', {}, null, new Set())
    expect(setup.slug).toBe('chatgpt-plus')
  })

  it('pi_copilot_oauth maps to github-copilot slug', () => {
    const setup = apiSetupMethodToConnectionSetup('pi_copilot_oauth', {}, null, new Set())
    expect(setup.slug).toBe('github-copilot')
  })

  it('pi_api_key includes piAuthProvider and modelSelectionMode', () => {
    const setup = apiSetupMethodToConnectionSetup(
      'pi_api_key',
      {
        credential: 'sk-pi',
        piAuthProvider: 'anthropic',
        modelSelectionMode: 'userDefined3Tier',
      },
      null,
      new Set(),
    )
    expect(setup.slug).toBe('pi-api-key')
    expect(setup.credential).toBe('sk-pi')
    expect(setup.piAuthProvider).toBe('anthropic')
    expect(setup.modelSelectionMode).toBe('userDefined3Tier')
  })

  it('qwen_code maps to qwen-code slug without credentials', () => {
    const setup = apiSetupMethodToConnectionSetup('qwen_code', {}, null, new Set())
    expect(setup.slug).toBe('qwen-code')
    expect(setup.credential).toBeUndefined()
  })

  it('uses editingSlug when editing', () => {
    const setup = apiSetupMethodToConnectionSetup(
      'anthropic_api_key',
      { credential: 'sk-ant' },
      'existing-connection',
      new Set(['anthropic-api']),
    )
    expect(setup.slug).toBe('existing-connection')
  })

  it('generates unique slug when base is taken', () => {
    const setup = apiSetupMethodToConnectionSetup(
      'claude_oauth',
      {},
      null,
      new Set(['claude-max']),
    )
    expect(setup.slug).toBe('claude-max-2')
  })
})

// ============================================================
// Reauth slug regression tests
// ============================================================

describe('reauth slug resolution', () => {
  it('slug override wins over null editingSlug (stale closure scenario)', () => {
    // Simulates the reauth bug: editingSlug is null (stale closure),
    // but connectionSlugOverride provides the correct slug.
    const existingSlugs = new Set(['chatgpt-plus'])

    // Without override: generates -2 (the bug)
    const wrongSlug = resolveSlugForMethod('pi_chatgpt_oauth', null, existingSlugs)
    expect(wrongSlug).toBe('chatgpt-plus-2')

    // With override: reuses existing slug (the fix)
    const correctSlug = resolveSlugForMethod('pi_chatgpt_oauth', 'chatgpt-plus', existingSlugs)
    expect(correctSlug).toBe('chatgpt-plus')
  })

  it('apiSetupMethodToConnectionSetup uses override slug for reauth', () => {
    const existingSlugs = new Set(['chatgpt-plus'])
    const setup = apiSetupMethodToConnectionSetup(
      'pi_chatgpt_oauth',
      {},
      'chatgpt-plus',  // override slug (reauth)
      existingSlugs,
    )
    expect(setup.slug).toBe('chatgpt-plus')
  })

  it('new connection flow still generates unique slugs when base is taken', () => {
    const existingSlugs = new Set(['chatgpt-plus'])
    const setup = apiSetupMethodToConnectionSetup(
      'pi_chatgpt_oauth',
      {},
      null,  // no editing slug (new connection)
      existingSlugs,
    )
    expect(setup.slug).toBe('chatgpt-plus-2')
  })

  it('copilot reauth uses override slug', () => {
    const existingSlugs = new Set(['github-copilot'])
    const slug = resolveSlugForMethod('pi_copilot_oauth', 'github-copilot', existingSlugs)
    expect(slug).toBe('github-copilot')
  })
})
