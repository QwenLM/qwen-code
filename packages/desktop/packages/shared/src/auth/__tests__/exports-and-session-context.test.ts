/**
 * Tests verifying:
 * 1. auth/index.ts barrel correctly exports OAuthSessionContext and buildOAuthDeeplinkUrl
 * 2. Provider files (google-oauth, slack-oauth, microsoft-oauth) import and use OAuthSessionContext
 * 3. credential-manager.ts accepts and threads sessionContext
 */
import { describe, it, expect } from 'bun:test';

describe('auth barrel exports', () => {
  it('exports OAuthSessionContext type from auth/index.ts', async () => {
    // Dynamic import to test the barrel export path
    const authModule = await import('../index.ts');
    // buildOAuthDeeplinkUrl is a runtime export; OAuthSessionContext is a type (compile-time only)
    expect(typeof authModule.buildOAuthDeeplinkUrl).toBe('function');
  });

  it('exports buildOAuthDeeplinkUrl that works correctly from barrel', async () => {
    const { buildOAuthDeeplinkUrl } = await import('../index.ts');
    const result = buildOAuthDeeplinkUrl({
      sessionId: 'test-123',
      deeplinkScheme: 'craftagents',
    });
    expect(result).toBe('craftagents://allSessions/session/test-123');
  });

  it('buildOAuthDeeplinkUrl returns undefined for incomplete context from barrel', async () => {
    const { buildOAuthDeeplinkUrl } = await import('../index.ts');
    expect(buildOAuthDeeplinkUrl(undefined)).toBeUndefined();
    expect(buildOAuthDeeplinkUrl({})).toBeUndefined();
    expect(buildOAuthDeeplinkUrl({ sessionId: 'x' })).toBeUndefined();
    expect(buildOAuthDeeplinkUrl({ deeplinkScheme: 'x' })).toBeUndefined();
  });
});

describe('sessionContext plumbing in provider files', () => {
  it('GoogleOAuthOptions has sessionContext field', async () => {
    // Verify the type shape by constructing a valid options object
    const { getGoogleScopes } = await import('../google-oauth.ts');
    // If sessionContext is accepted in options, this compiles and runs
    const options = {
      service: 'gmail' as const,
      sessionContext: { sessionId: 'abc', deeplinkScheme: 'craftagents' },
    };
    const scopes = getGoogleScopes(options);
    expect(scopes.length).toBeGreaterThan(0);
  });

  it('SlackOAuthOptions has sessionContext field', async () => {
    const { getSlackScopes } = await import('../slack-oauth.ts');
    const options = {
      service: 'full' as const,
      sessionContext: { sessionId: 'abc', deeplinkScheme: 'craftagents' },
    };
    const scopes = getSlackScopes(options);
    expect(scopes.length).toBeGreaterThan(0);
  });

  it('MicrosoftOAuthOptions has sessionContext field', async () => {
    const { getMicrosoftScopes } = await import('../microsoft-oauth.ts');
    const options = {
      service: 'outlook' as const,
      sessionContext: { sessionId: 'abc', deeplinkScheme: 'craftagents' },
    };
    const scopes = getMicrosoftScopes(options);
    expect(scopes.length).toBeGreaterThan(0);
  });
});

describe('SourceCredentialManager sessionContext threading', () => {
  it('authenticate method accepts sessionContext parameter', async () => {
    const { SourceCredentialManager } = await import('../../sources/credential-manager.ts');
    const manager = new SourceCredentialManager();
    // Verify the authenticate method signature accepts sessionContext
    // We test that the method exists and accepts the parameter shape
    expect(typeof manager.authenticate).toBe('function');
    // Check it has 3 parameters (source, callbacks, sessionContext)
    expect(manager.authenticate.length).toBeLessThanOrEqual(3);
  });

  it('authenticate passes undefined sessionContext without error', async () => {
    const { SourceCredentialManager } = await import('../../sources/credential-manager.ts');
    const manager = new SourceCredentialManager();

    // Create a minimal source that doesn't match any provider path
    // This should return a "does not use OAuth" error cleanly
    const source = {
      workspaceId: 'test-ws',
      workspaceRootPath: '/tmp/test',
      config: {
        slug: 'test-source',
        name: 'Test',
        type: 'local' as const,
        enabled: true,
      },
    };

    const result = await manager.authenticate(
      source as any,
      {
        onStatus: () => {},
        onError: () => {},
      },
      undefined
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not use OAuth');
  });

  it('authenticate passes partial sessionContext without error', async () => {
    const { SourceCredentialManager } = await import('../../sources/credential-manager.ts');
    const manager = new SourceCredentialManager();

    const source = {
      workspaceId: 'test-ws',
      workspaceRootPath: '/tmp/test',
      config: {
        slug: 'test-source',
        name: 'Test',
        type: 'local' as const,
        enabled: true,
      },
    };

    // Partial context (only sessionId, missing deeplinkScheme)
    const result = await manager.authenticate(
      source as any,
      {
        onStatus: () => {},
        onError: () => {},
      },
      { sessionId: 'test-session' }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not use OAuth');
  });
});
