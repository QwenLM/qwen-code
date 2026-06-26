/**
 * Test that SourceServerBuilder.buildApiConfig correctly handles empty authScheme
 *
 * This complements authScheme-empty.test.ts by testing the server-builder layer
 * which transforms source configs before they reach buildAuthorizationHeader.
 */

import { describe, it, expect } from 'bun:test';
import { SourceServerBuilder } from '../server-builder.ts';
import type { LoadedSource } from '../types.ts';

describe('SourceServerBuilder.buildApiConfig', () => {
  const builder = new SourceServerBuilder();

  // Helper to create a minimal LoadedSource for testing
  function createMockSource(authType: string, authScheme?: string): LoadedSource {
    return {
      config: {
        id: 'test-source',
        name: 'Test Source',
        slug: 'test-source',
        type: 'api',
        enabled: true,
        provider: 'test',
        api: {
          baseUrl: 'https://api.example.com/',
          authType: authType as 'bearer' | 'header' | 'query' | 'basic' | 'none',
          authScheme,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      guide: null,
      folderPath: '/test/sources/test-source',
      workspaceRootPath: '/test',
      workspaceId: 'test-workspace',
    };
  }

  it('defaults to Bearer when authScheme is undefined', () => {
    const source = createMockSource('bearer', undefined);
    const config = builder.buildApiConfig(source);

    expect(config.auth).toEqual({ type: 'bearer', authScheme: 'Bearer' });
  });

  it('uses custom authScheme when provided', () => {
    const source = createMockSource('bearer', 'Token');
    const config = builder.buildApiConfig(source);

    expect(config.auth).toEqual({ type: 'bearer', authScheme: 'Token' });
  });

  it('preserves empty string authScheme for APIs without Bearer prefix', () => {
    // This is the critical case that was broken before the fix
    // APIs like Craft Admin expect raw JWT tokens without any prefix
    const source = createMockSource('bearer', '');
    const config = builder.buildApiConfig(source);

    // Empty string should be preserved, NOT converted to 'Bearer'
    expect(config.auth).toEqual({ type: 'bearer', authScheme: '' });
    expect((config.auth as { authScheme: string }).authScheme).toBe('');
    expect((config.auth as { authScheme: string }).authScheme).not.toBe('Bearer');
  });

  it('handles null by defaulting to Bearer (via nullish coalescing)', () => {
    // Test runtime behavior with null (TypeScript wouldn't allow this)
    const source = createMockSource('bearer', null as unknown as undefined);
    const config = builder.buildApiConfig(source);

    expect(config.auth).toEqual({ type: 'bearer', authScheme: 'Bearer' });
  });

  it('does not add authScheme for non-bearer auth types', () => {
    const headerSource = createMockSource('header');
    const headerConfig = builder.buildApiConfig(headerSource);
    expect(headerConfig.auth).toEqual({ type: 'header', headerName: 'x-api-key' });

    const querySource = createMockSource('query');
    const queryConfig = builder.buildApiConfig(querySource);
    expect(queryConfig.auth).toEqual({ type: 'query', queryParam: 'api_key' });

    const basicSource = createMockSource('basic');
    const basicConfig = builder.buildApiConfig(basicSource);
    expect(basicConfig.auth).toEqual({ type: 'basic' });

    const noneSource = createMockSource('none');
    const noneConfig = builder.buildApiConfig(noneSource);
    expect(noneConfig.auth).toEqual({ type: 'none' });
  });
});
