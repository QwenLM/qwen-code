/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { type ChildProcess } from 'child_process';
import type { Config } from '../config/config.js';
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generatePKCEPair,
  isDeviceAuthorizationSuccess,
  isDeviceTokenPending,
  isDeviceTokenSuccess,
  isErrorResponse,
  QwenOAuth2Client,
  type DeviceAuthorizationResponse,
  type DeviceTokenResponse,
  type ErrorData,
} from './qwenOAuth2.js';

// Mock qrcode-terminal
vi.mock('qrcode-terminal', () => ({
  default: {
    generate: vi.fn(),
  },
}));

// Mock open
vi.mock('open', () => ({
  default: vi.fn(),
}));

// Mock process.stdout.write
vi.mock('process', () => ({
  stdout: {
    write: vi.fn(),
  },
}));

// Mock file system operations
vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('PKCE Code Generation', () => {
  describe('generateCodeVerifier', () => {
    it('should generate a code verifier with correct length', () => {
      const codeVerifier = generateCodeVerifier();
      expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('should generate different verifiers on subsequent calls', () => {
      const verifier1 = generateCodeVerifier();
      const verifier2 = generateCodeVerifier();
      expect(verifier1).not.toBe(verifier2);
    });
  });

  describe('generateCodeChallenge', () => {
    it('should generate code challenge from verifier', () => {
      const verifier = 'test-verifier-1234567890abcdefghijklmnopqrst';
      const challenge = generateCodeChallenge(verifier);

      // Should be base64url encoded
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(challenge).not.toBe(verifier);
    });
  });

  describe('generatePKCEPair', () => {
    it('should generate valid PKCE pair', () => {
      const { code_verifier, code_challenge } = generatePKCEPair();

      expect(code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(code_challenge).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(code_verifier).not.toBe(code_challenge);
    });
  });
});

describe('Type Guards', () => {
  describe('isDeviceAuthorizationSuccess', () => {
    it('should return true for successful authorization response', () => {
      const expectedBaseUrl = process.env.DEBUG
        ? 'https://pre4-chat.qwen.ai'
        : 'https://chat.qwen.ai';

      const successResponse: DeviceAuthorizationResponse = {
        device_code: 'test-device-code',
        user_code: 'TEST123',
        verification_uri: `${expectedBaseUrl}/device`,
        verification_uri_complete: `${expectedBaseUrl}/device?code=TEST123`,
        expires_in: 1800,
      };

      expect(isDeviceAuthorizationSuccess(successResponse)).toBe(true);
    });

    it('should return false for error response', () => {
      const errorResponse: DeviceAuthorizationResponse = {
        error: 'INVALID_REQUEST',
        error_description: 'The request parameters are invalid',
      };

      expect(isDeviceAuthorizationSuccess(errorResponse)).toBe(false);
    });
  });

  describe('isDeviceTokenPending', () => {
    it('should return true for pending response', () => {
      const pendingResponse: DeviceTokenResponse = {
        status: 'pending',
      };

      expect(isDeviceTokenPending(pendingResponse)).toBe(true);
    });

    it('should return false for success response', () => {
      const successResponse: DeviceTokenResponse = {
        access_token: 'valid-access-token',
        refresh_token: 'valid-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid profile email model.completion',
      };

      expect(isDeviceTokenPending(successResponse)).toBe(false);
    });

    it('should return false for error response', () => {
      const errorResponse: DeviceTokenResponse = {
        error: 'ACCESS_DENIED',
        error_description: 'User denied the authorization request',
      };

      expect(isDeviceTokenPending(errorResponse)).toBe(false);
    });
  });

  describe('isDeviceTokenSuccess', () => {
    it('should return true for successful token response', () => {
      const successResponse: DeviceTokenResponse = {
        access_token: 'valid-access-token',
        refresh_token: 'valid-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid profile email model.completion',
      };

      expect(isDeviceTokenSuccess(successResponse)).toBe(true);
    });

    it('should return false for pending response', () => {
      const pendingResponse: DeviceTokenResponse = {
        status: 'pending',
      };

      expect(isDeviceTokenSuccess(pendingResponse)).toBe(false);
    });

    it('should return false for error response', () => {
      const errorResponse: DeviceTokenResponse = {
        error: 'ACCESS_DENIED',
        error_description: 'User denied the authorization request',
      };

      expect(isDeviceTokenSuccess(errorResponse)).toBe(false);
    });

    it('should return false for null access token', () => {
      const nullTokenResponse: DeviceTokenResponse = {
        access_token: null,
        token_type: 'Bearer',
        expires_in: 3600,
      };

      expect(isDeviceTokenSuccess(nullTokenResponse)).toBe(false);
    });

    it('should return false for empty access token', () => {
      const emptyTokenResponse: DeviceTokenResponse = {
        access_token: '',
        token_type: 'Bearer',
        expires_in: 3600,
      };

      expect(isDeviceTokenSuccess(emptyTokenResponse)).toBe(false);
    });
  });

  describe('isErrorResponse', () => {
    it('should return true for error responses', () => {
      const errorResponse: ErrorData = {
        error: 'INVALID_REQUEST',
        error_description: 'The request parameters are invalid',
      };

      expect(isErrorResponse(errorResponse)).toBe(true);
    });

    it('should return false for successful responses', () => {
      const successResponse: DeviceAuthorizationResponse = {
        device_code: 'test-device-code',
        user_code: 'TEST123',
        verification_uri: 'https://chat.qwen.ai/device',
        verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
        expires_in: 1800,
      };

      expect(isErrorResponse(successResponse)).toBe(false);
    });
  });
});

describe('QwenOAuth2Client', () => {
  let client: QwenOAuth2Client;
  let _mockConfig: Config;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    // Setup mock config
    _mockConfig = {
      getQwenClientId: vi.fn().mockReturnValue('test-client-id'),
      isBrowserLaunchSuppressed: vi.fn().mockReturnValue(false),
      getProxy: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    // Create client instance
    client = new QwenOAuth2Client({ proxy: undefined });

    // Mock fetch
    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  describe('requestDeviceAuthorization', () => {
    it('should successfully request device authorization', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          device_code: 'test-device-code',
          user_code: 'TEST123',
          verification_uri: 'https://chat.qwen.ai/device',
          verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
          expires_in: 1800,
        }),
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      const result = await client.requestDeviceAuthorization({
        scope: 'openid profile email model.completion',
        code_challenge: 'test-challenge',
        code_challenge_method: 'S256',
      });

      expect(result).toEqual({
        device_code: 'test-device-code',
        user_code: 'TEST123',
        verification_uri: 'https://chat.qwen.ai/device',
        verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
        expires_in: 1800,
      });
    });

    it('should handle error response', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          error: 'INVALID_REQUEST',
          error_description: 'The request parameters are invalid',
        }),
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      await expect(
        client.requestDeviceAuthorization({
          scope: 'openid profile email model.completion',
          code_challenge: 'test-challenge',
          code_challenge_method: 'S256',
        }),
      ).rejects.toThrow(
        'Device authorization failed: INVALID_REQUEST - The request parameters are invalid',
      );
    });
  });

  describe('refreshAccessToken', () => {
    beforeEach(() => {
      // Set up client with credentials
      client.setCredentials({
        access_token: 'old-token',
        refresh_token: 'test-refresh-token',
        token_type: 'Bearer',
      });
    });

    it('should successfully refresh access token', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          resource_url: 'https://new-endpoint.com',
        }),
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      const result = await client.refreshAccessToken();

      expect(result).toEqual({
        access_token: 'new-access-token',
        token_type: 'Bearer',
        expires_in: 3600,
        resource_url: 'https://new-endpoint.com',
      });

      // Verify credentials were updated
      const credentials = client.getCredentials();
      expect(credentials.access_token).toBe('new-access-token');
    });

    it('should handle refresh error', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          error: 'INVALID_GRANT',
          error_description: 'The refresh token is invalid',
        }),
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      await expect(client.refreshAccessToken()).rejects.toThrow(
        'Token refresh failed: INVALID_GRANT - The refresh token is invalid',
      );
    });

    it('should cache credentials after successful refresh', async () => {
      const { promises: fs } = await import('node:fs');
      const mockWriteFile = vi.mocked(fs.writeFile);
      const mockMkdir = vi.mocked(fs.mkdir);

      const mockResponse = {
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          resource_url: 'https://new-endpoint.com',
        }),
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      await client.refreshAccessToken();

      // Verify that cacheQwenCredentials was called by checking if writeFile was called
      expect(mockMkdir).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalled();

      // Verify the cached credentials contain the new token data
      const writeCall = mockWriteFile.mock.calls[0];
      const cachedCredentials = JSON.parse(writeCall[1] as string);

      expect(cachedCredentials).toMatchObject({
        access_token: 'new-access-token',
        token_type: 'Bearer',
        refresh_token: 'test-refresh-token', // Should preserve existing refresh token
        resource_url: 'https://new-endpoint.com',
      });
      expect(cachedCredentials.expiry_date).toBeDefined();
    });

    it('should use new refresh token if provided in response', async () => {
      const { promises: fs } = await import('node:fs');
      const mockWriteFile = vi.mocked(fs.writeFile);

      const mockResponse = {
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'new-refresh-token', // New refresh token provided
          resource_url: 'https://new-endpoint.com',
        }),
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      await client.refreshAccessToken();

      // Verify the cached credentials contain the new refresh token
      const writeCall = mockWriteFile.mock.calls[0];
      const cachedCredentials = JSON.parse(writeCall[1] as string);

      expect(cachedCredentials.refresh_token).toBe('new-refresh-token');
    });
  });

  describe('getAccessToken', () => {
    it('should return access token if valid and not expired', async () => {
      // Set valid credentials
      client.setCredentials({
        access_token: 'valid-token',
        expiry_date: Date.now() + 60 * 60 * 1000, // 1 hour from now
      });

      const result = await client.getAccessToken();
      expect(result.token).toBe('valid-token');
    });

    it('should refresh token if access token is expired', async () => {
      // Set expired credentials with refresh token
      client.setCredentials({
        access_token: 'expired-token',
        refresh_token: 'valid-refresh-token',
        expiry_date: Date.now() - 1000, // 1 second ago
      });

      const mockRefreshResponse = {
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      };

      vi.mocked(global.fetch).mockResolvedValue(
        mockRefreshResponse as Response,
      );

      const result = await client.getAccessToken();
      expect(result.token).toBe('new-access-token');
    });

    it('should return undefined if no access token and no refresh token', async () => {
      client.setCredentials({});

      const result = await client.getAccessToken();
      expect(result.token).toBeUndefined();
    });
  });

  describe('pollDeviceToken', () => {
    it('should successfully poll for device token', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid profile email model.completion',
        }),
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      const result = await client.pollDeviceToken({
        device_code: 'test-device-code',
        code_verifier: 'test-code-verifier',
      });

      expect(result).toEqual({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid profile email model.completion',
      });
    });

    it('should return pending status when authorization is pending', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          status: 'pending',
        }),
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      const result = await client.pollDeviceToken({
        device_code: 'test-device-code',
        code_verifier: 'test-code-verifier',
      });

      expect(result).toEqual({
        status: 'pending',
      });
    });

    it('should handle HTTP error responses', async () => {
      const mockResponse = {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'Invalid device code',
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      await expect(
        client.pollDeviceToken({
          device_code: 'invalid-device-code',
          code_verifier: 'test-code-verifier',
        }),
      ).rejects.toThrow('Device token poll failed: 400 Bad Request');
    });

    it('should include status code in error for better handling', async () => {
      const mockResponse = {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: async () => 'Rate limited',
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      try {
        await client.pollDeviceToken({
          device_code: 'test-device-code',
          code_verifier: 'test-code-verifier',
        });
      } catch (error) {
        expect((error as Error & { status?: number }).status).toBe(429);
      }
    });

    it('should handle authorization_pending with HTTP 400 according to RFC 8628', async () => {
      const mockResponse = {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({
          error: 'authorization_pending',
          error_description: 'The authorization request is still pending',
        }),
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      const result = await client.pollDeviceToken({
        device_code: 'test-device-code',
        code_verifier: 'test-code-verifier',
      });

      expect(result).toEqual({
        status: 'pending',
      });
    });

    it('should handle slow_down with HTTP 429 according to RFC 8628', async () => {
      const mockResponse = {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({
          error: 'slow_down',
          error_description: 'The client is polling too frequently',
        }),
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      const result = await client.pollDeviceToken({
        device_code: 'test-device-code',
        code_verifier: 'test-code-verifier',
      });

      expect(result).toEqual({
        status: 'pending',
        slowDown: true,
      });
    });
  });

  describe('refreshAccessToken error handling', () => {
    beforeEach(() => {
      client.setCredentials({
        access_token: 'old-token',
        refresh_token: 'test-refresh-token',
        token_type: 'Bearer',
      });
    });

    it('should throw error if no refresh token available', async () => {
      client.setCredentials({ access_token: 'token' });

      await expect(client.refreshAccessToken()).rejects.toThrow(
        'No refresh token available',
      );
    });

    it('should handle 400 status as expired refresh token', async () => {
      const mockResponse = {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'Refresh token expired',
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      await expect(client.refreshAccessToken()).rejects.toThrow(
        "Refresh token expired or invalid. Please use '/auth' to re-authenticate.",
      );
    });

    it('should handle other HTTP error statuses', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Server error',
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      await expect(client.refreshAccessToken()).rejects.toThrow(
        'Token refresh failed: 500 Internal Server Error',
      );
    });
  });

  describe('credentials management', () => {
    it('should set and get credentials correctly', () => {
      const credentials = {
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        token_type: 'Bearer',
        expiry_date: Date.now() + 3600000,
      };

      client.setCredentials(credentials);
      expect(client.getCredentials()).toEqual(credentials);
    });

    it('should handle empty credentials', () => {
      client.setCredentials({});
      expect(client.getCredentials()).toEqual({});
    });
  });
});

describe('getQwenOAuthClient', () => {
  let mockConfig: Config;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    mockConfig = {
      getProxy: vi.fn().mockReturnValue(undefined),
      isBrowserLaunchSuppressed: vi.fn().mockReturnValue(false),
    } as unknown as Config;

    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('should create client with proxy configuration', async () => {
    const proxyUrl = 'http://proxy.example.com:8080';
    mockConfig.getProxy = vi.fn().mockReturnValue(proxyUrl);

    const { promises: fs } = await import('node:fs');
    vi.mocked(fs.readFile).mockRejectedValue(
      new Error('No cached credentials'),
    );

    // Mock device authorization flow to fail quickly for this test
    const mockAuthResponse = {
      ok: true,
      json: async () => ({
        error: 'test_error',
        error_description: 'Test error for quick failure',
      }),
    };
    vi.mocked(global.fetch).mockResolvedValue(mockAuthResponse as Response);

    try {
      await import('./qwenOAuth2.js').then((module) =>
        module.getQwenOAuthClient(mockConfig),
      );
    } catch {
      // Expected to fail due to mocked error
    }

    expect(mockConfig.getProxy).toHaveBeenCalled();
  });

  it('should load cached credentials if available', async () => {
    const { promises: fs } = await import('node:fs');
    const mockCredentials = {
      access_token: 'cached-token',
      refresh_token: 'cached-refresh',
      token_type: 'Bearer',
      expiry_date: Date.now() + 3600000,
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockCredentials));

    // Mock successful refresh
    const mockRefreshResponse = {
      ok: true,
      json: async () => ({
        access_token: 'refreshed-token',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    };
    vi.mocked(global.fetch).mockResolvedValue(mockRefreshResponse as Response);

    const client = await import('./qwenOAuth2.js').then((module) =>
      module.getQwenOAuthClient(mockConfig),
    );

    expect(client).toBeInstanceOf(Object);
    expect(fs.readFile).toHaveBeenCalled();
  });

  it('should handle cached credentials refresh failure', async () => {
    const { promises: fs } = await import('node:fs');
    const mockCredentials = {
      access_token: 'cached-token',
      refresh_token: 'expired-refresh',
      token_type: 'Bearer',
      expiry_date: Date.now() + 3600000, // Valid expiry time so loadCachedQwenCredentials returns true
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockCredentials));

    // Mock refresh failure with 400 status to trigger credential clearing
    const mockRefreshResponse = {
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => 'Refresh token expired or invalid',
    };
    vi.mocked(global.fetch).mockResolvedValue(mockRefreshResponse as Response);

    // The function should handle the invalid cached credentials and throw the expected error
    await expect(
      import('./qwenOAuth2.js').then((module) =>
        module.getQwenOAuthClient(mockConfig),
      ),
    ).rejects.toThrow('Cached Qwen credentials are invalid');
  });
});

describe('clearQwenCredentials', () => {
  it('should successfully clear credentials file', async () => {
    const { promises: fs } = await import('node:fs');
    const { clearQwenCredentials } = await import('./qwenOAuth2.js');

    vi.mocked(fs.unlink).mockResolvedValue(undefined);

    await expect(clearQwenCredentials()).resolves.not.toThrow();
    expect(fs.unlink).toHaveBeenCalled();
  });

  it('should handle file not found error gracefully', async () => {
    const { promises: fs } = await import('node:fs');
    const { clearQwenCredentials } = await import('./qwenOAuth2.js');

    const notFoundError = new Error('File not found');
    (notFoundError as Error & { code: string }).code = 'ENOENT';
    vi.mocked(fs.unlink).mockRejectedValue(notFoundError);

    await expect(clearQwenCredentials()).resolves.not.toThrow();
  });

  it('should handle other file system errors gracefully', async () => {
    const { promises: fs } = await import('node:fs');
    const { clearQwenCredentials } = await import('./qwenOAuth2.js');

    const permissionError = new Error('Permission denied');
    vi.mocked(fs.unlink).mockRejectedValue(permissionError);

    // Should not throw but may log warning
    await expect(clearQwenCredentials()).resolves.not.toThrow();
  });
});

describe('QwenOAuth2Client - Additional Error Scenarios', () => {
  let client: QwenOAuth2Client;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    client = new QwenOAuth2Client({ proxy: undefined });
    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  describe('requestDeviceAuthorization HTTP errors', () => {
    it('should handle HTTP error response with non-ok status', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Server error occurred',
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      await expect(
        client.requestDeviceAuthorization({
          scope: 'openid profile email model.completion',
          code_challenge: 'test-challenge',
          code_challenge_method: 'S256',
        }),
      ).rejects.toThrow(
        'Device authorization failed: 500 Internal Server Error. Response: Server error occurred',
      );
    });
  });

  describe('isTokenValid edge cases', () => {
    it('should return false when expiry_date is undefined', () => {
      client.setCredentials({
        access_token: 'token',
        // expiry_date is undefined
      });

      // Access private method for testing
      const isValid = (
        client as unknown as { isTokenValid(): boolean }
      ).isTokenValid();
      expect(isValid).toBe(false);
    });
  });
});

describe('getQwenOAuthClient - Enhanced Error Scenarios', () => {
  let mockConfig: Config;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    mockConfig = {
      getProxy: vi.fn().mockReturnValue(undefined),
      isBrowserLaunchSuppressed: vi.fn().mockReturnValue(false),
    } as unknown as Config;

    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('should handle generic refresh token errors', async () => {
    const { promises: fs } = await import('node:fs');
    const mockCredentials = {
      access_token: 'cached-token',
      refresh_token: 'some-refresh-token',
      token_type: 'Bearer',
      expiry_date: Date.now() + 3600000,
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockCredentials));

    // Mock generic refresh failure (not 400 status)
    const mockRefreshResponse = {
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'Internal server error',
    };
    vi.mocked(global.fetch).mockResolvedValue(mockRefreshResponse as Response);

    await expect(
      import('./qwenOAuth2.js').then((module) =>
        module.getQwenOAuthClient(mockConfig),
      ),
    ).rejects.toThrow(
      'Qwen token refresh failed: Token refresh failed: 500 Internal Server Error',
    );
  });

  it('should handle different authentication failure reasons - timeout', async () => {
    const { promises: fs } = await import('node:fs');
    vi.mocked(fs.readFile).mockRejectedValue(
      new Error('No cached credentials'),
    );

    // Mock device authorization to succeed but polling to timeout
    const mockAuthResponse = {
      ok: true,
      json: async () => ({
        device_code: 'test-device-code',
        user_code: 'TEST123',
        verification_uri: 'https://chat.qwen.ai/device',
        verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
        expires_in: 0.1, // Very short timeout for testing
      }),
    };

    const mockPendingResponse = {
      ok: true,
      json: async () => ({
        status: 'pending',
      }),
    };

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(mockAuthResponse as Response)
      .mockResolvedValue(mockPendingResponse as Response);

    await expect(
      import('./qwenOAuth2.js').then((module) =>
        module.getQwenOAuthClient(mockConfig),
      ),
    ).rejects.toThrow('Qwen OAuth authentication timed out');
  });

  it('should handle authentication failure reason - rate limit', async () => {
    const { promises: fs } = await import('node:fs');
    vi.mocked(fs.readFile).mockRejectedValue(
      new Error('No cached credentials'),
    );

    // Mock device authorization to succeed but polling to get rate limited
    const mockAuthResponse = {
      ok: true,
      json: async () => ({
        device_code: 'test-device-code',
        user_code: 'TEST123',
        verification_uri: 'https://chat.qwen.ai/device',
        verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
        expires_in: 1800,
      }),
    };

    const mockRateLimitResponse = {
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: async () => 'Rate limited',
    };

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(mockAuthResponse as Response)
      .mockResolvedValue(mockRateLimitResponse as Response);

    await expect(
      import('./qwenOAuth2.js').then((module) =>
        module.getQwenOAuthClient(mockConfig),
      ),
    ).rejects.toThrow(
      'Too many request for Qwen OAuth authentication, please try again later.',
    );
  });

  it('should handle authentication failure reason - error', async () => {
    const { promises: fs } = await import('node:fs');
    vi.mocked(fs.readFile).mockRejectedValue(
      new Error('No cached credentials'),
    );

    // Mock device authorization to fail
    const mockAuthResponse = {
      ok: true,
      json: async () => ({
        error: 'invalid_request',
        error_description: 'Invalid request parameters',
      }),
    };

    vi.mocked(global.fetch).mockResolvedValue(mockAuthResponse as Response);

    await expect(
      import('./qwenOAuth2.js').then((module) =>
        module.getQwenOAuthClient(mockConfig),
      ),
    ).rejects.toThrow('Qwen OAuth authentication failed');
  });
});

describe('authWithQwenDeviceFlow - Comprehensive Testing', () => {
  let mockConfig: Config;
  let originalFetch: typeof global.fetch;
  let _client: QwenOAuth2Client;

  beforeEach(() => {
    mockConfig = {
      getProxy: vi.fn().mockReturnValue(undefined),
      isBrowserLaunchSuppressed: vi.fn().mockReturnValue(false),
    } as unknown as Config;

    _client = new QwenOAuth2Client({ proxy: undefined });
    originalFetch = global.fetch;
    global.fetch = vi.fn();

    // Mock setTimeout to avoid real delays in tests
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('should handle device authorization error response', async () => {
    const { promises: fs } = await import('node:fs');
    vi.mocked(fs.readFile).mockRejectedValue(
      new Error('No cached credentials'),
    );

    const mockAuthResponse = {
      ok: true,
      json: async () => ({
        error: 'invalid_client',
        error_description: 'Client authentication failed',
      }),
    };

    vi.mocked(global.fetch).mockResolvedValue(mockAuthResponse as Response);

    await expect(
      import('./qwenOAuth2.js').then((module) =>
        module.getQwenOAuthClient(mockConfig),
      ),
    ).rejects.toThrow('Qwen OAuth authentication failed');
  });

  it('should handle successful authentication flow', async () => {
    const { promises: fs } = await import('node:fs');
    vi.mocked(fs.readFile).mockRejectedValue(
      new Error('No cached credentials'),
    );

    const mockAuthResponse = {
      ok: true,
      json: async () => ({
        device_code: 'test-device-code',
        user_code: 'TEST123',
        verification_uri: 'https://chat.qwen.ai/device',
        verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
        expires_in: 1800,
      }),
    };

    const mockTokenResponse = {
      ok: true,
      json: async () => ({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid profile email model.completion',
      }),
    };

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(mockAuthResponse as Response)
      .mockResolvedValue(mockTokenResponse as Response);

    const client = await import('./qwenOAuth2.js').then((module) =>
      module.getQwenOAuthClient(mockConfig),
    );

    expect(client).toBeInstanceOf(Object);
  });

  it('should handle 401 error during token polling', async () => {
    const { promises: fs } = await import('node:fs');
    vi.mocked(fs.readFile).mockRejectedValue(
      new Error('No cached credentials'),
    );

    const mockAuthResponse = {
      ok: true,
      json: async () => ({
        device_code: 'test-device-code',
        user_code: 'TEST123',
        verification_uri: 'https://chat.qwen.ai/device',
        verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
        expires_in: 1800,
      }),
    };

    const mock401Response = {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Device code expired',
    };

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(mockAuthResponse as Response)
      .mockResolvedValue(mock401Response as Response);

    await expect(
      import('./qwenOAuth2.js').then((module) =>
        module.getQwenOAuthClient(mockConfig),
      ),
    ).rejects.toThrow('Qwen OAuth authentication failed');
  });

  it('should handle token polling with browser launch suppressed', async () => {
    const { promises: fs } = await import('node:fs');
    vi.mocked(fs.readFile).mockRejectedValue(
      new Error('No cached credentials'),
    );

    // Mock browser launch as suppressed
    mockConfig.isBrowserLaunchSuppressed = vi.fn().mockReturnValue(true);

    const mockAuthResponse = {
      ok: true,
      json: async () => ({
        device_code: 'test-device-code',
        user_code: 'TEST123',
        verification_uri: 'https://chat.qwen.ai/device',
        verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
        expires_in: 1800,
      }),
    };

    const mockTokenResponse = {
      ok: true,
      json: async () => ({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid profile email model.completion',
      }),
    };

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(mockAuthResponse as Response)
      .mockResolvedValue(mockTokenResponse as Response);

    const client = await import('./qwenOAuth2.js').then((module) =>
      module.getQwenOAuthClient(mockConfig),
    );

    expect(client).toBeInstanceOf(Object);
    expect(mockConfig.isBrowserLaunchSuppressed).toHaveBeenCalled();
  });
});

describe('Browser Launch and Error Handling', () => {
  let mockConfig: Config;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    mockConfig = {
      getProxy: vi.fn().mockReturnValue(undefined),
      isBrowserLaunchSuppressed: vi.fn().mockReturnValue(false),
    } as unknown as Config;

    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('should handle browser launch failure gracefully', async () => {
    const { promises: fs } = await import('node:fs');
    vi.mocked(fs.readFile).mockRejectedValue(
      new Error('No cached credentials'),
    );

    // Mock open to throw error
    const open = await import('open');
    vi.mocked(open.default).mockRejectedValue(
      new Error('Browser launch failed'),
    );

    const mockAuthResponse = {
      ok: true,
      json: async () => ({
        device_code: 'test-device-code',
        user_code: 'TEST123',
        verification_uri: 'https://chat.qwen.ai/device',
        verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
        expires_in: 1800,
      }),
    };

    const mockTokenResponse = {
      ok: true,
      json: async () => ({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid profile email model.completion',
      }),
    };

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(mockAuthResponse as Response)
      .mockResolvedValue(mockTokenResponse as Response);

    const client = await import('./qwenOAuth2.js').then((module) =>
      module.getQwenOAuthClient(mockConfig),
    );

    expect(client).toBeInstanceOf(Object);
  });

  it('should handle browser child process error gracefully', async () => {
    const { promises: fs } = await import('node:fs');
    vi.mocked(fs.readFile).mockRejectedValue(
      new Error('No cached credentials'),
    );

    // Mock open to return a child process that will emit error
    const open = await import('open');
    const mockChildProcess = {
      on: vi.fn((event: string, callback: (error: Error) => void) => {
        if (event === 'error') {
          // Call the error handler immediately for testing
          setTimeout(() => callback(new Error('Process spawn failed')), 0);
        }
      }),
    };
    vi.mocked(open.default).mockResolvedValue(
      mockChildProcess as unknown as ChildProcess,
    );

    const mockAuthResponse = {
      ok: true,
      json: async () => ({
        device_code: 'test-device-code',
        user_code: 'TEST123',
        verification_uri: 'https://chat.qwen.ai/device',
        verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
        expires_in: 1800,
      }),
    };

    const mockTokenResponse = {
      ok: true,
      json: async () => ({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid profile email model.completion',
      }),
    };

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(mockAuthResponse as Response)
      .mockResolvedValue(mockTokenResponse as Response);

    const client = await import('./qwenOAuth2.js').then((module) =>
      module.getQwenOAuthClient(mockConfig),
    );

    expect(client).toBeInstanceOf(Object);
  });
});

describe('Event Emitter Integration', () => {
  it('should export qwenOAuth2Events as EventEmitter', async () => {
    const { qwenOAuth2Events } = await import('./qwenOAuth2.js');
    expect(qwenOAuth2Events).toBeInstanceOf(EventEmitter);
  });

  it('should define correct event enum values', async () => {
    const { QwenOAuth2Event } = await import('./qwenOAuth2.js');
    expect(QwenOAuth2Event.AuthUri).toBe('auth-uri');
    expect(QwenOAuth2Event.AuthProgress).toBe('auth-progress');
    expect(QwenOAuth2Event.AuthCancel).toBe('auth-cancel');
  });
});
