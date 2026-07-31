/**
 * Tests for SourceServerBuilder → API Tools credential flow
 *
 * Verifies that credentials flow correctly from:
 * 1. SourceServerBuilder.buildApiConfig() - creates correct auth config
 * 2. SourceServerBuilder.buildApiServer() - passes credential to createApiServer
 * 3. buildHeaders() - applies credentials to HTTP request headers
 */

import { describe, test, expect } from 'bun:test';
import { SourceServerBuilder } from '../server-builder.ts';
import { buildHeaders } from '../api-tools.ts';
import { isMultiHeaderCredential, type MultiHeaderCredential } from '../credential-manager.ts';
import type { LoadedSource, FolderSourceConfig, ApiConfig } from '../types.ts';

// Create a minimal mock LoadedSource for testing
function createMockSource(overrides: Partial<FolderSourceConfig> = {}): LoadedSource {
  return {
    config: {
      id: 'test-id',
      slug: 'test-source',
      name: 'Test Source',
      type: 'api',
      enabled: true,
      api: {
        baseUrl: 'https://api.example.com/',
        authType: 'header',
      },
      ...overrides,
    } as FolderSourceConfig,
    guide: null,
    folderPath: '/tmp/test/sources/test-source',
    workspaceRootPath: '/tmp/test',
    workspaceId: 'test-workspace',
  };
}

describe('SourceServerBuilder.buildApiConfig', () => {
  const builder = new SourceServerBuilder();

  test('should build correct ApiConfig.auth for header type', () => {
    const source = createMockSource({
      api: {
        baseUrl: 'https://api.example.com/',
        authType: 'header',
        headerName: 'X-API-Key',
      },
    });

    const config = builder.buildApiConfig(source);

    expect(config.auth?.type).toBe('header');
    expect(config.auth?.headerName).toBe('X-API-Key');
  });

  test('should build correct ApiConfig.auth for bearer type', () => {
    const source = createMockSource({
      api: {
        baseUrl: 'https://api.example.com/',
        authType: 'bearer',
      },
    });

    const config = builder.buildApiConfig(source);

    expect(config.auth?.type).toBe('bearer');
  });

  test('should build correct ApiConfig.auth for none type', () => {
    const source = createMockSource({
      api: {
        baseUrl: 'https://api.example.com/',
        authType: 'none',
      },
    });

    const config = builder.buildApiConfig(source);

    expect(config.auth?.type).toBe('none');
  });

  test('should use default headerName when not specified', () => {
    const source = createMockSource({
      api: {
        baseUrl: 'https://api.example.com/',
        authType: 'header',
        // No headerName specified
      },
    });

    const config = builder.buildApiConfig(source);

    expect(config.auth?.type).toBe('header');
    expect(config.auth?.headerName).toBe('x-api-key');
  });

  test('should include baseUrl in config', () => {
    const source = createMockSource({
      api: {
        baseUrl: 'https://api.datadoghq.com/',
        authType: 'header',
      },
    });

    const config = builder.buildApiConfig(source);

    expect(config.baseUrl).toBe('https://api.datadoghq.com/');
  });

  test('should include defaultHeaders if present', () => {
    const source = createMockSource({
      api: {
        baseUrl: 'https://api.example.com/',
        authType: 'header',
        defaultHeaders: {
          'X-Custom-Header': 'custom-value',
        },
      },
    });

    const config = builder.buildApiConfig(source);

    expect(config.defaultHeaders).toEqual({
      'X-Custom-Header': 'custom-value',
    });
  });
});

describe('buildHeaders with MultiHeaderCredential', () => {
  test('should apply all headers from MultiHeaderCredential', () => {
    const credential: MultiHeaderCredential = {
      'DD-API-KEY': 'test-api-key',
      'DD-APPLICATION-KEY': 'test-app-key',
    };

    const auth: ApiConfig['auth'] = {
      type: 'header',
    };

    const headers = buildHeaders(auth, credential);

    expect(headers['DD-API-KEY']).toBe('test-api-key');
    expect(headers['DD-APPLICATION-KEY']).toBe('test-app-key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  test('should NOT apply headers when auth type is "none"', () => {
    const credential: MultiHeaderCredential = {
      'DD-API-KEY': 'test-api-key',
      'DD-APPLICATION-KEY': 'test-app-key',
    };

    const auth: ApiConfig['auth'] = {
      type: 'none',
    };

    const headers = buildHeaders(auth, credential);

    // Headers should NOT be applied when auth type is 'none'
    expect(headers['DD-API-KEY']).toBeUndefined();
    expect(headers['DD-APPLICATION-KEY']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });

  test('isMultiHeaderCredential correctly identifies credential type', () => {
    const multiHeader: MultiHeaderCredential = {
      'DD-API-KEY': 'key',
      'DD-APPLICATION-KEY': 'app',
    };

    expect(isMultiHeaderCredential(multiHeader)).toBe(true);
    expect(isMultiHeaderCredential('string-credential')).toBe(false);
  });
});

describe('Full flow: Source config → ApiConfig → Headers', () => {
  const builder = new SourceServerBuilder();

  test('Datadog-like source produces correct headers', () => {
    // 1. Create source config
    const source = createMockSource({
      slug: 'datadog',
      api: {
        baseUrl: 'https://api.datadoghq.com/',
        authType: 'header',
        headerNames: ['DD-API-KEY', 'DD-APPLICATION-KEY'],
      },
    });

    // 2. Build API config
    const apiConfig = builder.buildApiConfig(source);
    expect(apiConfig.auth?.type).toBe('header');

    // 3. Simulate credential that would come from SourceCredentialManager
    const credential: MultiHeaderCredential = {
      'DD-API-KEY': 'my-api-key',
      'DD-APPLICATION-KEY': 'my-app-key',
    };

    // 4. Build headers
    const headers = buildHeaders(apiConfig.auth, credential);

    // 5. Verify both headers present
    expect(headers['DD-API-KEY']).toBe('my-api-key');
    expect(headers['DD-APPLICATION-KEY']).toBe('my-app-key');
  });

  test('BROKEN config (authType: none + headerNames) should NOT apply headers', () => {
    // This tests our exact production bug
    const brokenSource = createMockSource({
      slug: 'datadog',
      api: {
        baseUrl: 'https://api.datadoghq.com/',
        authType: 'none', // BUG: should be 'header'
        headerNames: ['DD-API-KEY', 'DD-APPLICATION-KEY'],
      },
    });

    // Build API config
    const apiConfig = builder.buildApiConfig(brokenSource);
    expect(apiConfig.auth?.type).toBe('none'); // This is the problem

    // Even with valid credentials...
    const credential: MultiHeaderCredential = {
      'DD-API-KEY': 'my-api-key',
      'DD-APPLICATION-KEY': 'my-app-key',
    };

    // Headers will NOT be applied because auth.type is 'none'
    const headers = buildHeaders(apiConfig.auth, credential);

    expect(headers['DD-API-KEY']).toBeUndefined();
    expect(headers['DD-APPLICATION-KEY']).toBeUndefined();
  });

  test('Single header source still works (backward compatibility)', () => {
    const source = createMockSource({
      api: {
        baseUrl: 'https://api.example.com/',
        authType: 'header',
        headerName: 'X-API-Key',
      },
    });

    const apiConfig = builder.buildApiConfig(source);
    const headers = buildHeaders(apiConfig.auth, 'my-simple-key');

    expect(headers['X-API-Key']).toBe('my-simple-key');
  });
});
