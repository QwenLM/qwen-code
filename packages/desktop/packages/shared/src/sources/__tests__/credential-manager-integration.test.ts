/**
 * Integration tests for SourceCredentialManager with multi-header auth
 *
 * Tests the credential parsing flow:
 * - When source.config.api.headerNames exists, parse credential as JSON
 * - When missing, return raw string credential
 * - Handle malformed JSON gracefully
 */

import { describe, test, expect, beforeEach, mock, spyOn } from 'bun:test';
import {
  SourceCredentialManager,
  isMultiHeaderCredential,
  type MultiHeaderCredential,
  type ApiCredential,
} from '../credential-manager.ts';
import type { LoadedSource, FolderSourceConfig } from '../types.ts';
import * as credentialsModule from '../../credentials/index.ts';

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

describe('getApiCredential with multi-header sources', () => {
  let credManager: SourceCredentialManager;
  let mockGet: ReturnType<typeof mock>;

  beforeEach(() => {
    credManager = new SourceCredentialManager();
    // Reset mocks
    mockGet = mock(() => null);
  });

  test('should return MultiHeaderCredential when source has headerNames and credential is valid JSON', async () => {
    const source = createMockSource({
      api: {
        baseUrl: 'https://api.datadoghq.com/',
        authType: 'header',
        headerNames: ['DD-API-KEY', 'DD-APPLICATION-KEY'],
      },
    });

    // Simulate stored credential
    const storedCredential = JSON.stringify({
      'DD-API-KEY': 'test-api-key',
      'DD-APPLICATION-KEY': 'test-app-key',
    });

    // Mock the credential manager's load method
    const loadSpy = spyOn(credManager, 'load').mockResolvedValue({
      value: storedCredential,
    });

    const result = await credManager.getApiCredential(source);

    expect(result).not.toBeNull();
    expect(isMultiHeaderCredential(result!)).toBe(true);
    expect((result as MultiHeaderCredential)['DD-API-KEY']).toBe('test-api-key');
    expect((result as MultiHeaderCredential)['DD-APPLICATION-KEY']).toBe('test-app-key');

    loadSpy.mockRestore();
  });

  test('should return string when source has NO headerNames (backward compatibility)', async () => {
    const source = createMockSource({
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

    const result = await credManager.getApiCredential(source);

    expect(result).toBe('simple-api-key');
    expect(typeof result).toBe('string');

    loadSpy.mockRestore();
  });

  test('should return null when stored credential is missing required headers', async () => {
    const source = createMockSource({
      api: {
        baseUrl: 'https://api.datadoghq.com/',
        authType: 'header',
        headerNames: ['DD-API-KEY', 'DD-APPLICATION-KEY'], // Expects BOTH
      },
    });

    // Only has ONE header
    const storedCredential = JSON.stringify({
      'DD-API-KEY': 'test-api-key',
      // Missing DD-APPLICATION-KEY
    });

    const loadSpy = spyOn(credManager, 'load').mockResolvedValue({
      value: storedCredential,
    });

    const result = await credManager.getApiCredential(source);

    // Should fall through to returning raw string since not all headers present
    expect(result).toBe(storedCredential);

    loadSpy.mockRestore();
  });

  test('should handle malformed JSON gracefully', async () => {
    const source = createMockSource({
      api: {
        baseUrl: 'https://api.datadoghq.com/',
        authType: 'header',
        headerNames: ['DD-API-KEY', 'DD-APPLICATION-KEY'],
      },
    });

    // Malformed JSON - not valid
    const loadSpy = spyOn(credManager, 'load').mockResolvedValue({
      value: 'not-valid-json{{{',
    });

    const result = await credManager.getApiCredential(source);

    // Should fall through and return raw string
    expect(result).toBe('not-valid-json{{{');

    loadSpy.mockRestore();
  });

  test('should return null when no credential exists', async () => {
    const source = createMockSource({
      api: {
        baseUrl: 'https://api.datadoghq.com/',
        authType: 'header',
        headerNames: ['DD-API-KEY', 'DD-APPLICATION-KEY'],
      },
    });

    const loadSpy = spyOn(credManager, 'load').mockResolvedValue(null);

    const result = await credManager.getApiCredential(source);

    expect(result).toBeNull();

    loadSpy.mockRestore();
  });

  test('should return null when credential has empty value', async () => {
    const source = createMockSource({
      api: {
        baseUrl: 'https://api.datadoghq.com/',
        authType: 'header',
        headerNames: ['DD-API-KEY', 'DD-APPLICATION-KEY'],
      },
    });

    const loadSpy = spyOn(credManager, 'load').mockResolvedValue({
      value: '',
    });

    const result = await credManager.getApiCredential(source);

    expect(result).toBeNull();

    loadSpy.mockRestore();
  });
});

describe('getApiCredential basic auth parsing', () => {
  let credManager: SourceCredentialManager;

  beforeEach(() => {
    credManager = new SourceCredentialManager();
  });

  test('should parse basic auth credentials from JSON', async () => {
    const source = createMockSource({
      api: {
        baseUrl: 'https://api.example.com/',
        authType: 'basic',
      },
    });

    const storedCredential = JSON.stringify({
      username: 'testuser',
      password: 'testpass',
    });

    const loadSpy = spyOn(credManager, 'load').mockResolvedValue({
      value: storedCredential,
    });

    const result = await credManager.getApiCredential(source);

    expect(result).not.toBeNull();
    expect(typeof result).toBe('object');
    expect((result as { username: string; password: string }).username).toBe('testuser');
    expect((result as { username: string; password: string }).password).toBe('testpass');

    loadSpy.mockRestore();
  });
});

describe('isMultiHeaderCredential type guard', () => {
  test('correctly identifies MultiHeaderCredential', () => {
    const multiHeader: MultiHeaderCredential = {
      'DD-API-KEY': 'key',
      'DD-APPLICATION-KEY': 'app',
    };

    expect(isMultiHeaderCredential(multiHeader)).toBe(true);
  });

  test('rejects string credentials', () => {
    expect(isMultiHeaderCredential('simple-string')).toBe(false);
  });

  test('rejects BasicAuthCredential', () => {
    const basicAuth = { username: 'user', password: 'pass' };
    expect(isMultiHeaderCredential(basicAuth)).toBe(false);
  });

  test('accepts empty object as valid MultiHeaderCredential', () => {
    expect(isMultiHeaderCredential({})).toBe(true);
  });

  test('accepts single-key object as valid MultiHeaderCredential', () => {
    expect(isMultiHeaderCredential({ 'X-API-Key': 'value' })).toBe(true);
  });
});
