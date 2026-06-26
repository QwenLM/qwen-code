/**
 * Unit tests for multi-header authentication support
 *
 * Tests the ability to use multiple custom headers for authentication,
 * enabling APIs like Datadog (DD-API-KEY + DD-APPLICATION-KEY), Algolia,
 * and Cloudflare that require two or more authentication headers.
 */

import { describe, test, expect } from 'bun:test';

// Import actual implementations
import {
  type ApiCredential,
  type BasicAuthCredential,
  type MultiHeaderCredential,
  isMultiHeaderCredential,
} from '../credential-manager.ts';

import { buildHeaders } from '../api-tools.ts';

import type { ApiConfig } from '../types.ts';

describe('Multi-Header Type Guards', () => {
  test('isMultiHeaderCredential returns true for Record<string, string>', () => {
    const cred: MultiHeaderCredential = {
      'DD-API-KEY': 'api-key-123',
      'DD-APPLICATION-KEY': 'app-key-456',
    };

    expect(isMultiHeaderCredential(cred)).toBe(true);
  });

  test('isMultiHeaderCredential returns false for string credential', () => {
    expect(isMultiHeaderCredential('simple-api-key')).toBe(false);
  });

  test('isMultiHeaderCredential returns false for BasicAuthCredential', () => {
    const basicCred: BasicAuthCredential = { username: 'user', password: 'pass' };
    expect(isMultiHeaderCredential(basicCred)).toBe(false);
  });

  test('isMultiHeaderCredential returns true for empty object', () => {
    // Empty object is technically a valid MultiHeaderCredential (no headers)
    const emptyCred: MultiHeaderCredential = {};
    expect(isMultiHeaderCredential(emptyCred)).toBe(true);
  });

  test('isMultiHeaderCredential handles single header object', () => {
    const singleHeader: MultiHeaderCredential = {
      'X-API-Key': 'single-value',
    };
    expect(isMultiHeaderCredential(singleHeader)).toBe(true);
  });
});

describe('Multi-Header Credential Storage', () => {
  test('stores credentials as JSON with header names as keys', () => {
    const headers = {
      'DD-API-KEY': 'api-key-123',
      'DD-APPLICATION-KEY': 'app-key-456',
    };

    // Simulate how credentials are stored (JSON stringified)
    const storedValue = JSON.stringify(headers);

    expect(storedValue).toBeDefined();
    const parsed = JSON.parse(storedValue);
    expect(parsed['DD-API-KEY']).toBe('api-key-123');
    expect(parsed['DD-APPLICATION-KEY']).toBe('app-key-456');
  });

  test('parses stored JSON into MultiHeaderCredential', () => {
    const stored = JSON.stringify({
      'DD-API-KEY': 'api-key-123',
      'DD-APPLICATION-KEY': 'app-key-456',
    });

    const parsed = JSON.parse(stored) as MultiHeaderCredential;
    expect(isMultiHeaderCredential(parsed)).toBe(true);
    expect(parsed['DD-API-KEY']).toBe('api-key-123');
    expect(parsed['DD-APPLICATION-KEY']).toBe('app-key-456');
  });
});

describe('Multi-Header Header Building', () => {
  test('adds all credential headers to request', () => {
    const credential: MultiHeaderCredential = {
      'DD-API-KEY': 'api-key-123',
      'DD-APPLICATION-KEY': 'app-key-456',
    };

    const auth: ApiConfig['auth'] = {
      type: 'header',
      headerNames: ['DD-API-KEY', 'DD-APPLICATION-KEY'],
    };

    const headers = buildHeaders(auth, credential);

    expect(headers['DD-API-KEY']).toBe('api-key-123');
    expect(headers['DD-APPLICATION-KEY']).toBe('app-key-456');
    expect(headers['Content-Type']).toBe('application/json');
  });

  test('single header auth still works (backward compatibility)', () => {
    const auth: ApiConfig['auth'] = {
      type: 'header',
      headerName: 'X-API-Key',
    };

    const headers = buildHeaders(auth, 'simple-api-key');

    expect(headers['X-API-Key']).toBe('simple-api-key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  test('uses default header name when not specified', () => {
    const auth: ApiConfig['auth'] = {
      type: 'header',
    };

    const headers = buildHeaders(auth, 'api-key');

    expect(headers['x-api-key']).toBe('api-key');
  });

  test('includes default headers alongside auth headers', () => {
    const credential: MultiHeaderCredential = {
      'DD-API-KEY': 'api-key-123',
    };

    const auth: ApiConfig['auth'] = {
      type: 'header',
    };

    const defaultHeaders = {
      'X-Custom-Header': 'custom-value',
    };

    const headers = buildHeaders(auth, credential, defaultHeaders);

    expect(headers['DD-API-KEY']).toBe('api-key-123');
    expect(headers['X-Custom-Header']).toBe('custom-value');
    expect(headers['Content-Type']).toBe('application/json');
  });
});

describe('End-to-End Datadog Flow', () => {
  test('full flow: store -> retrieve -> build headers', () => {
    // 1. Simulate stored Datadog credentials
    const storedValue = JSON.stringify({
      'DD-API-KEY': 'datadog-api-key',
      'DD-APPLICATION-KEY': 'datadog-app-key',
    });

    // 2. Parse as MultiHeaderCredential
    const credential = JSON.parse(storedValue) as MultiHeaderCredential;
    expect(isMultiHeaderCredential(credential)).toBe(true);

    // 3. Build headers for request
    const auth: ApiConfig['auth'] = {
      type: 'header',
      headerNames: ['DD-API-KEY', 'DD-APPLICATION-KEY'],
    };

    const headers = buildHeaders(auth, credential);

    // 4. Verify both headers are present
    expect(headers['DD-API-KEY']).toBe('datadog-api-key');
    expect(headers['DD-APPLICATION-KEY']).toBe('datadog-app-key');
  });

  test('Algolia-style dual header auth', () => {
    const credential: MultiHeaderCredential = {
      'X-Algolia-API-Key': 'algolia-api-key',
      'X-Algolia-Application-ID': 'app-id-123',
    };

    const auth: ApiConfig['auth'] = {
      type: 'header',
      headerNames: ['X-Algolia-API-Key', 'X-Algolia-Application-ID'],
    };

    const headers = buildHeaders(auth, credential);

    expect(headers['X-Algolia-API-Key']).toBe('algolia-api-key');
    expect(headers['X-Algolia-Application-ID']).toBe('app-id-123');
  });

  test('Cloudflare-style dual header auth', () => {
    const credential: MultiHeaderCredential = {
      'X-Auth-Key': 'cloudflare-api-key',
      'X-Auth-Email': 'user@example.com',
    };

    const auth: ApiConfig['auth'] = {
      type: 'header',
      headerNames: ['X-Auth-Key', 'X-Auth-Email'],
    };

    const headers = buildHeaders(auth, credential);

    expect(headers['X-Auth-Key']).toBe('cloudflare-api-key');
    expect(headers['X-Auth-Email']).toBe('user@example.com');
  });
});

describe('Backward Compatibility', () => {
  test('existing single-header sources continue to work', () => {
    const auth: ApiConfig['auth'] = {
      type: 'header',
      headerName: 'X-API-Key',
    };

    const headers = buildHeaders(auth, 'old-api-key');

    expect(headers['X-API-Key']).toBe('old-api-key');
  });

  test('bearer auth continues to work', () => {
    const auth: ApiConfig['auth'] = {
      type: 'bearer',
    };

    const headers = buildHeaders(auth, 'bearer-token');

    expect(headers['Authorization']).toBe('Bearer bearer-token');
  });

  test('basic auth continues to work', () => {
    const auth: ApiConfig['auth'] = {
      type: 'basic',
    };

    const basicCred: BasicAuthCredential = { username: 'user', password: 'pass' };
    const headers = buildHeaders(auth, basicCred);

    // Should produce Base64 encoded Authorization header
    const expectedBase64 = Buffer.from('user:pass').toString('base64');
    expect(headers['Authorization']).toBe(`Basic ${expectedBase64}`);
  });

  test('query auth continues to work (no header added)', () => {
    const auth: ApiConfig['auth'] = {
      type: 'query',
      queryParam: 'api_key',
    };

    // Query auth doesn't add headers, just query params (handled elsewhere)
    const headers = buildHeaders(auth, 'query-api-key');

    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });

  test('no auth continues to work', () => {
    const auth: ApiConfig['auth'] = {
      type: 'none',
    };

    const headers = buildHeaders(auth, '');

    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });
});

describe('Edge Cases', () => {
  test('handles empty credential object', () => {
    const auth: ApiConfig['auth'] = {
      type: 'header',
      headerNames: ['DD-API-KEY'],
    };

    const emptyCredential: MultiHeaderCredential = {};
    const headers = buildHeaders(auth, emptyCredential);

    // Should not add any auth headers, just default headers
    expect(headers['DD-API-KEY']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });

  test('handles credential with extra headers beyond configured', () => {
    const auth: ApiConfig['auth'] = {
      type: 'header',
      headerNames: ['DD-API-KEY'],
    };

    // Credential has more headers than configured - all should be added
    const credential: MultiHeaderCredential = {
      'DD-API-KEY': 'api-key',
      'DD-APPLICATION-KEY': 'app-key', // Extra, not in headerNames
    };

    const headers = buildHeaders(auth, credential);

    // Both headers should be present (we add all from credential)
    expect(headers['DD-API-KEY']).toBe('api-key');
    expect(headers['DD-APPLICATION-KEY']).toBe('app-key');
  });

  test('handles special characters in header values', () => {
    const auth: ApiConfig['auth'] = {
      type: 'header',
      headerNames: ['X-API-Key'],
    };

    const credential: MultiHeaderCredential = {
      'X-API-Key': 'key+with/special=chars',
    };

    const headers = buildHeaders(auth, credential);

    expect(headers['X-API-Key']).toBe('key+with/special=chars');
  });

  test('handles undefined auth gracefully', () => {
    const headers = buildHeaders(undefined, 'some-key');

    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBeUndefined();
  });

  test('handles empty string credential for single header', () => {
    const auth: ApiConfig['auth'] = {
      type: 'header',
      headerName: 'X-API-Key',
    };

    const headers = buildHeaders(auth, '');

    // Empty string should not add header
    expect(headers['X-API-Key']).toBeUndefined();
  });

  test('multi-header credential with single entry', () => {
    const credential: MultiHeaderCredential = {
      'X-Single-Header': 'single-value',
    };

    const auth: ApiConfig['auth'] = {
      type: 'header',
      headerNames: ['X-Single-Header'],
    };

    const headers = buildHeaders(auth, credential);

    expect(headers['X-Single-Header']).toBe('single-value');
  });

  test('preserves header name casing', () => {
    const credential: MultiHeaderCredential = {
      'X-Custom-Header': 'value1',
      'x-lowercase-header': 'value2',
      'X-UPPERCASE-HEADER': 'value3',
    };

    const auth: ApiConfig['auth'] = {
      type: 'header',
    };

    const headers = buildHeaders(auth, credential);

    expect(headers['X-Custom-Header']).toBe('value1');
    expect(headers['x-lowercase-header']).toBe('value2');
    expect(headers['X-UPPERCASE-HEADER']).toBe('value3');
  });
});
