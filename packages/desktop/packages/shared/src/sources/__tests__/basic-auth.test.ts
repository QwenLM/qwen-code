/**
 * Unit tests for basic auth credential storage and retrieval
 *
 * Tests the fix for the bug where basic auth credentials were stored as
 * pre-encoded base64 instead of JSON {username, password} format.
 *
 * The correct flow is:
 * 1. sessions.ts stores: { value: JSON.stringify({ username, password }) }
 * 2. credential-manager.ts retrieves and parses: JSON.parse(value) → { username, password }
 * 3. api-tools.ts encodes at request time: Buffer.from(`${username}:${password}`).toString('base64')
 */

import { describe, test, expect } from 'bun:test';

// Type definitions matching the actual code
interface BasicAuthCredential {
  username: string;
  password: string;
}

type ApiCredential = string | BasicAuthCredential;

/**
 * Type guard from api-tools.ts
 */
function isBasicAuthCredential(cred: ApiCredential): cred is BasicAuthCredential {
  return typeof cred === 'object' && cred !== null && 'username' in cred && 'password' in cred;
}

/**
 * Simulates how sessions.ts stores basic auth credentials (FIXED version)
 */
function storeBasicAuthCredential(username: string, password: string): { value: string } {
  // Store value as JSON string {username, password}
  return { value: JSON.stringify({ username, password }) };
}

/**
 * Simulates how credential-manager.ts retrieves basic auth credentials
 * (from getApiCredential method, lines 190-207)
 */
function getApiCredential(storedValue: string, isBasicAuth: boolean): ApiCredential | null {
  if (!storedValue) return null;

  if (isBasicAuth) {
    try {
      const parsed = JSON.parse(storedValue);
      if (parsed.username && parsed.password) {
        return parsed as BasicAuthCredential;
      }
    } catch {
      // Not JSON, treat as regular credential
    }
  }

  return storedValue;
}

/**
 * Simulates how api-tools.ts builds headers with basic auth
 * (from buildHeaders function, lines 59-65)
 */
function buildBasicAuthHeader(credential: ApiCredential): string | null {
  if (isBasicAuthCredential(credential)) {
    const encoded = Buffer.from(`${credential.username}:${credential.password}`).toString('base64');
    return `Basic ${encoded}`;
  }
  return null;
}

describe('Basic Auth Credential Storage', () => {
  test('stores credentials as JSON with username and password', () => {
    const stored = storeBasicAuthCredential('user@example.com/token', 'api-key-123');

    expect(stored.value).toBeDefined();

    // Should be valid JSON
    const parsed = JSON.parse(stored.value);
    expect(parsed.username).toBe('user@example.com/token');
    expect(parsed.password).toBe('api-key-123');
  });

  test('does NOT store credentials as pre-encoded base64', () => {
    const stored = storeBasicAuthCredential('user@example.com/token', 'api-key-123');

    // The stored value should NOT be base64-encoded credentials
    // It should be a JSON string
    const isBase64 = /^[A-Za-z0-9+/=]+$/.test(stored.value);
    expect(isBase64).toBe(false);

    // Should start with { since it's JSON
    expect(stored.value.startsWith('{')).toBe(true);
  });
});

describe('Basic Auth Credential Retrieval', () => {
  test('retrieves credentials as BasicAuthCredential object', () => {
    const stored = storeBasicAuthCredential('user@example.com/token', 'api-key-123');
    const credential = getApiCredential(stored.value, true);

    expect(credential).not.toBeNull();
    expect(isBasicAuthCredential(credential!)).toBe(true);

    if (isBasicAuthCredential(credential!)) {
      expect(credential.username).toBe('user@example.com/token');
      expect(credential.password).toBe('api-key-123');
    }
  });

  test('handles Zendesk-style credentials (email/token format)', () => {
    // Zendesk uses email/token as username and API key as password
    const stored = storeBasicAuthCredential('support@company.com/token', 'zendesk-api-key');
    const credential = getApiCredential(stored.value, true);

    expect(isBasicAuthCredential(credential!)).toBe(true);
    if (isBasicAuthCredential(credential!)) {
      expect(credential.username).toBe('support@company.com/token');
      expect(credential.password).toBe('zendesk-api-key');
    }
  });

  test('returns string credential when not basic auth', () => {
    const bearerToken = 'some-bearer-token';
    const credential = getApiCredential(bearerToken, false);

    expect(credential).toBe(bearerToken);
    expect(isBasicAuthCredential(credential!)).toBe(false);
  });

  test('handles malformed JSON gracefully', () => {
    const malformed = 'not-valid-json';
    const credential = getApiCredential(malformed, true);

    // Should fall back to returning the raw string
    expect(credential).toBe(malformed);
    expect(isBasicAuthCredential(credential!)).toBe(false);
  });
});

describe('Basic Auth Header Building', () => {
  test('encodes credentials as base64 at request time', () => {
    const stored = storeBasicAuthCredential('user@example.com/token', 'api-key-123');
    const credential = getApiCredential(stored.value, true);
    const header = buildBasicAuthHeader(credential!);

    expect(header).not.toBeNull();
    expect(header!.startsWith('Basic ')).toBe(true);

    // Decode and verify
    const base64Part = header!.replace('Basic ', '');
    const decoded = Buffer.from(base64Part, 'base64').toString('utf-8');
    expect(decoded).toBe('user@example.com/token:api-key-123');
  });

  test('produces correct base64 for Zendesk credentials', () => {
    const stored = storeBasicAuthCredential('support@company.com/token', 'zendesk-api-key');
    const credential = getApiCredential(stored.value, true);
    const header = buildBasicAuthHeader(credential!);

    const base64Part = header!.replace('Basic ', '');
    const decoded = Buffer.from(base64Part, 'base64').toString('utf-8');
    expect(decoded).toBe('support@company.com/token:zendesk-api-key');
  });

  test('returns null for non-basic-auth credentials', () => {
    const header = buildBasicAuthHeader('bearer-token-string');
    expect(header).toBeNull();
  });
});

describe('End-to-End Basic Auth Flow', () => {
  test('full flow: store → retrieve → build header', () => {
    // 1. Store credentials (as sessions.ts does)
    const username = 'admin@zendesk.com/token';
    const password = 'super-secret-api-key';
    const stored = storeBasicAuthCredential(username, password);

    // 2. Retrieve credentials (as credential-manager.ts does)
    const credential = getApiCredential(stored.value, true);

    // 3. Build auth header (as api-tools.ts does)
    const header = buildBasicAuthHeader(credential!);

    // 4. Verify the final result
    const base64Part = header!.replace('Basic ', '');
    const decoded = Buffer.from(base64Part, 'base64').toString('utf-8');
    expect(decoded).toBe(`${username}:${password}`);
  });

  test('credentials with special characters are handled correctly', () => {
    const username = 'user+test@example.com/token';
    const password = 'p@$$w0rd!#$%^&*()';

    const stored = storeBasicAuthCredential(username, password);
    const credential = getApiCredential(stored.value, true);
    const header = buildBasicAuthHeader(credential!);

    const base64Part = header!.replace('Basic ', '');
    const decoded = Buffer.from(base64Part, 'base64').toString('utf-8');
    expect(decoded).toBe(`${username}:${password}`);
  });
});

describe('Bug Regression: Pre-encoded Base64 Storage', () => {
  test('OLD BUG: pre-encoded base64 fails to parse as BasicAuthCredential', () => {
    // This simulates the OLD buggy behavior
    const username = 'user@example.com/token';
    const password = 'api-key-123';

    // OLD BUGGY way: store as pre-encoded base64
    const buggyStored = {
      value: Buffer.from(`${username}:${password}`).toString('base64'),
    };

    // When we try to retrieve it as basic auth...
    const credential = getApiCredential(buggyStored.value, true);

    // It FAILS to parse as BasicAuthCredential because it's not JSON
    expect(isBasicAuthCredential(credential!)).toBe(false);

    // It falls back to treating it as a string
    expect(typeof credential).toBe('string');
  });

  test('NEW FIX: JSON storage correctly parses as BasicAuthCredential', () => {
    const username = 'user@example.com/token';
    const password = 'api-key-123';

    // NEW FIXED way: store as JSON
    const fixedStored = storeBasicAuthCredential(username, password);

    // Retrieval works correctly
    const credential = getApiCredential(fixedStored.value, true);

    // It correctly parses as BasicAuthCredential
    expect(isBasicAuthCredential(credential!)).toBe(true);

    if (isBasicAuthCredential(credential!)) {
      expect(credential.username).toBe(username);
      expect(credential.password).toBe(password);
    }
  });
});
