/**
 * End-to-end integration tests for multi-header authentication
 *
 * These tests simulate the full flow from source config to HTTP request headers,
 * specifically targeting the failure scenarios we encountered:
 *
 * 1. authType: "none" + headerNames present → NO auth headers applied (our bug)
 * 2. headerNames missing → credential not parsed as JSON
 * 3. Malformed credential storage → graceful fallback
 */

import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { SourceServerBuilder } from '../server-builder.ts';
import { SourceCredentialManager, isMultiHeaderCredential } from '../credential-manager.ts';
import { buildHeaders } from '../api-tools.ts';
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
      isAuthenticated: true,
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

describe('Multi-header auth end-to-end', () => {
  let credManager: SourceCredentialManager;
  let serverBuilder: SourceServerBuilder;

  // Simulates the full Datadog-like source
  const datadogLikeSource = createMockSource({
    slug: 'test-datadog',
    api: {
      baseUrl: 'https://api.datadoghq.com/',
      authType: 'header',
      headerNames: ['DD-API-KEY', 'DD-APPLICATION-KEY'],
    },
  });

  beforeEach(() => {
    credManager = new SourceCredentialManager();
    serverBuilder = new SourceServerBuilder();
  });

  test('should send both auth headers in API request', async () => {
    // 1. Simulate stored credential (as JSON)
    const storedCredential = JSON.stringify({
      'DD-API-KEY': 'test-api-key',
      'DD-APPLICATION-KEY': 'test-app-key',
    });

    // Mock credential loading
    const loadSpy = spyOn(credManager, 'load').mockResolvedValue({
      value: storedCredential,
    });

    // 2. Load credential using getApiCredential
    const credential = await credManager.getApiCredential(datadogLikeSource);

    // 3. Verify it's parsed as MultiHeaderCredential
    expect(credential).not.toBeNull();
    expect(isMultiHeaderCredential(credential!)).toBe(true);

    // 4. Build API config
    const apiConfig = serverBuilder.buildApiConfig(datadogLikeSource);
    expect(apiConfig.auth?.type).toBe('header');

    // 5. Build headers and verify BOTH are present
    const headers = buildHeaders(apiConfig.auth, credential!);
    expect(headers['DD-API-KEY']).toBe('test-api-key');
    expect(headers['DD-APPLICATION-KEY']).toBe('test-app-key');
    expect(headers['Content-Type']).toBe('application/json');

    loadSpy.mockRestore();
  });

  test('should return null when credentials missing', async () => {
    // Source is authenticated but no stored credential
    const loadSpy = spyOn(credManager, 'load').mockResolvedValue(null);

    const cred = await credManager.getApiCredential(datadogLikeSource);
    expect(cred).toBeNull();

    loadSpy.mockRestore();
  });

  test('should NOT apply auth when authType is "none" but headerNames present (production bug)', async () => {
    // This was our exact production bug
    const brokenSource = createMockSource({
      slug: 'broken-datadog',
      api: {
        baseUrl: 'https://api.datadoghq.com/',
        authType: 'none', // BUG: should be 'header'
        headerNames: ['DD-API-KEY', 'DD-APPLICATION-KEY'],
      },
    });

    // Even with valid stored credentials...
    const storedCredential = JSON.stringify({
      'DD-API-KEY': 'test-api-key',
      'DD-APPLICATION-KEY': 'test-app-key',
    });

    const loadSpy = spyOn(credManager, 'load').mockResolvedValue({
      value: storedCredential,
    });

    // Credential manager will still parse it (since headerNames exists)
    const credential = await credManager.getApiCredential(brokenSource);
    expect(isMultiHeaderCredential(credential!)).toBe(true);

    // But when we build the API config...
    const apiConfig = serverBuilder.buildApiConfig(brokenSource);
    expect(apiConfig.auth?.type).toBe('none'); // The bug!

    // And build headers - NO auth headers will be applied
    const headers = buildHeaders(apiConfig.auth, credential!);
    expect(headers['DD-API-KEY']).toBeUndefined();
    expect(headers['DD-APPLICATION-KEY']).toBeUndefined();

    loadSpy.mockRestore();
  });

  test('should handle source without headerNames (single header auth)', async () => {
    const singleHeaderSource = createMockSource({
      api: {
        baseUrl: 'https://api.example.com/',
        authType: 'header',
        headerName: 'X-API-Key',
        // NO headerNames - single header auth
      },
    });

    const loadSpy = spyOn(credManager, 'load').mockResolvedValue({
      value: 'simple-api-key',
    });

    const credential = await credManager.getApiCredential(singleHeaderSource);
    expect(typeof credential).toBe('string');
    expect(credential).toBe('simple-api-key');

    const apiConfig = serverBuilder.buildApiConfig(singleHeaderSource);
    const headers = buildHeaders(apiConfig.auth, credential!);

    expect(headers['X-API-Key']).toBe('simple-api-key');

    loadSpy.mockRestore();
  });

  test('should handle malformed credential JSON gracefully', async () => {
    const loadSpy = spyOn(credManager, 'load').mockResolvedValue({
      value: 'not-valid-json{{{',
    });

    // Should fall through and return raw string (not crash)
    const credential = await credManager.getApiCredential(datadogLikeSource);
    expect(credential).toBe('not-valid-json{{{');

    loadSpy.mockRestore();
  });

  test('should handle partially complete credential (missing headers)', async () => {
    // Credential has only ONE of the required headers
    const storedCredential = JSON.stringify({
      'DD-API-KEY': 'test-api-key',
      // Missing DD-APPLICATION-KEY
    });

    const loadSpy = spyOn(credManager, 'load').mockResolvedValue({
      value: storedCredential,
    });

    const credential = await credManager.getApiCredential(datadogLikeSource);

    // Should return raw JSON string since not all required headers present
    expect(credential).toBe(storedCredential);
    expect(typeof credential).toBe('string');

    loadSpy.mockRestore();
  });
});

describe('Real-world API scenarios', () => {
  const serverBuilder = new SourceServerBuilder();

  test('Algolia dual header auth', () => {
    const algoliaSource = createMockSource({
      slug: 'algolia',
      api: {
        baseUrl: 'https://api.algolia.com/',
        authType: 'header',
        headerNames: ['X-Algolia-API-Key', 'X-Algolia-Application-ID'],
      },
    });

    const credential = {
      'X-Algolia-API-Key': 'algolia-api-key',
      'X-Algolia-Application-ID': 'app-id-123',
    };

    const apiConfig = serverBuilder.buildApiConfig(algoliaSource);
    const headers = buildHeaders(apiConfig.auth, credential);

    expect(headers['X-Algolia-API-Key']).toBe('algolia-api-key');
    expect(headers['X-Algolia-Application-ID']).toBe('app-id-123');
  });

  test('Cloudflare dual header auth', () => {
    const cloudflareSource = createMockSource({
      slug: 'cloudflare',
      api: {
        baseUrl: 'https://api.cloudflare.com/client/v4/',
        authType: 'header',
        headerNames: ['X-Auth-Key', 'X-Auth-Email'],
      },
    });

    const credential = {
      'X-Auth-Key': 'cloudflare-api-key',
      'X-Auth-Email': 'user@example.com',
    };

    const apiConfig = serverBuilder.buildApiConfig(cloudflareSource);
    const headers = buildHeaders(apiConfig.auth, credential);

    expect(headers['X-Auth-Key']).toBe('cloudflare-api-key');
    expect(headers['X-Auth-Email']).toBe('user@example.com');
  });

  test('New Relic dual header auth', () => {
    const newRelicSource = createMockSource({
      slug: 'new-relic',
      api: {
        baseUrl: 'https://api.newrelic.com/v2/',
        authType: 'header',
        headerNames: ['Api-Key', 'X-Account-Id'],
      },
    });

    const credential = {
      'Api-Key': 'new-relic-api-key',
      'X-Account-Id': '12345',
    };

    const apiConfig = serverBuilder.buildApiConfig(newRelicSource);
    const headers = buildHeaders(apiConfig.auth, credential);

    expect(headers['Api-Key']).toBe('new-relic-api-key');
    expect(headers['X-Account-Id']).toBe('12345');
  });
});

describe('Auth type verification', () => {
  const serverBuilder = new SourceServerBuilder();

  test.each<['bearer' | 'header' | 'query' | 'basic' | 'none', 'bearer' | 'header' | 'query' | 'basic' | 'none']>([
    ['bearer', 'bearer'],
    ['header', 'header'],
    ['query', 'query'],
    ['basic', 'basic'],
    ['none', 'none'],
  ])('source authType "%s" produces ApiConfig.auth.type "%s"', (sourceAuthType, expectedAuthType) => {
    const source = createMockSource({
      api: {
        baseUrl: 'https://api.example.com/',
        authType: sourceAuthType,
      },
    });

    const apiConfig = serverBuilder.buildApiConfig(source);
    expect(apiConfig.auth?.type).toBe(expectedAuthType);
  });
});
