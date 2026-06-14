/**
 * Unit tests for SourceCredentialManager token expiry methods
 *
 * These methods are used by the MCP OAuth token refresh logic in sessions.ts
 * to determine which tokens need to be refreshed before agent.chat() calls.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { SourceCredentialManager } from '../credential-manager.ts';
import type { StoredCredential } from '../../credentials/index.ts';

describe('SourceCredentialManager.isExpired', () => {
  let credManager: SourceCredentialManager;

  beforeEach(() => {
    credManager = new SourceCredentialManager();
  });

  test('returns false when credential has no expiresAt', () => {
    const credential: StoredCredential = {
      value: 'test-token',
    };

    expect(credManager.isExpired(credential)).toBe(false);
  });

  test('returns false when credential expires in the future', () => {
    const credential: StoredCredential = {
      value: 'test-token',
      expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
    };

    expect(credManager.isExpired(credential)).toBe(false);
  });

  test('returns true when credential has already expired', () => {
    const credential: StoredCredential = {
      value: 'test-token',
      expiresAt: Date.now() - 1000, // 1 second ago
    };

    expect(credManager.isExpired(credential)).toBe(true);
  });

  test('returns true when credential expired exactly now', () => {
    const now = Date.now();
    const credential: StoredCredential = {
      value: 'test-token',
      expiresAt: now - 1, // Just before now (since Date.now() may advance)
    };

    expect(credManager.isExpired(credential)).toBe(true);
  });
});

describe('SourceCredentialManager.needsRefresh', () => {
  let credManager: SourceCredentialManager;
  const FIVE_MINUTES = 5 * 60 * 1000;

  beforeEach(() => {
    credManager = new SourceCredentialManager();
  });

  test('returns false when credential has no expiresAt', () => {
    const credential: StoredCredential = {
      value: 'test-token',
    };

    expect(credManager.needsRefresh(credential)).toBe(false);
  });

  test('returns false when credential expires more than 5 minutes in the future', () => {
    const credential: StoredCredential = {
      value: 'test-token',
      expiresAt: Date.now() + FIVE_MINUTES + 60 * 1000, // 6 minutes from now
    };

    expect(credManager.needsRefresh(credential)).toBe(false);
  });

  test('returns true when credential expires within 5 minutes', () => {
    const credential: StoredCredential = {
      value: 'test-token',
      expiresAt: Date.now() + FIVE_MINUTES - 1000, // 4 minutes 59 seconds from now
    };

    expect(credManager.needsRefresh(credential)).toBe(true);
  });

  test('returns true when credential expires exactly at 5 minute threshold', () => {
    const credential: StoredCredential = {
      value: 'test-token',
      expiresAt: Date.now() + FIVE_MINUTES - 1, // Just under 5 minutes
    };

    expect(credManager.needsRefresh(credential)).toBe(true);
  });

  test('returns true when credential has already expired', () => {
    const credential: StoredCredential = {
      value: 'test-token',
      expiresAt: Date.now() - 1000, // 1 second ago
    };

    expect(credManager.needsRefresh(credential)).toBe(true);
  });

  test('returns true when credential expires in 1 minute', () => {
    const credential: StoredCredential = {
      value: 'test-token',
      expiresAt: Date.now() + 60 * 1000, // 1 minute from now
    };

    expect(credManager.needsRefresh(credential)).toBe(true);
  });
});

describe('SourceCredentialManager expiry edge cases', () => {
  let credManager: SourceCredentialManager;

  beforeEach(() => {
    credManager = new SourceCredentialManager();
  });

  test('isExpired handles credential with refreshToken', () => {
    const credential: StoredCredential = {
      value: 'test-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Date.now() - 1000, // Expired
    };

    // Token is expired even if it has a refresh token
    // (refresh is handled separately)
    expect(credManager.isExpired(credential)).toBe(true);
  });

  test('needsRefresh handles credential with refreshToken', () => {
    const credential: StoredCredential = {
      value: 'test-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 60 * 1000, // 1 minute from now
    };

    // Should need refresh regardless of whether refresh token exists
    expect(credManager.needsRefresh(credential)).toBe(true);
  });

  test('credential with far future expiry does not need refresh', () => {
    const credential: StoredCredential = {
      value: 'test-token',
      expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours from now
    };

    expect(credManager.isExpired(credential)).toBe(false);
    expect(credManager.needsRefresh(credential)).toBe(false);
  });
});
