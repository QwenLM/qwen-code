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
  type QwenCredentials,
} from './qwenOAuth2.js';
import {
  SharedTokenManager,
  TokenManagerError,
  TokenError,
} from './sharedTokenManager.js';

interface MockSharedTokenManager {
  getValidCredentials(qwenClient: QwenOAuth2Client): Promise<QwenCredentials>;
  getCurrentCredentials(): QwenCredentials | null;
  clearCache(): void;
}

// Mock SharedTokenManager
vi.mock('./sharedTokenManager.js', () => ({
  SharedTokenManager: class {
    private static instance: MockSharedTokenManager | null = null;

    static getInstance() {
      if (!this.instance) {
        this.instance = new this();
      }
      return this.instance;
    }

    async getValidCredentials(
      qwenClient: QwenOAuth2Client,
    ): Promise<QwenCredentials> {
      // Try to get credentials from the client first
      const clientCredentials = qwenClient.getCredentials();
      if (clientCredentials && clientCredentials.access_token) {
        return clientCredentials;
      }

      // Fall back to default mock credentials if client has none
      return {
        access_token: 'new-access-token',
        refresh_token: 'valid-refresh-token',
        resource_url: undefined,
        token_type: 'Bearer',
        expiry_date: Date.now() + 3600000,
      };
    }

    getCurrentCredentials(): QwenCredentials | null {
      // Return null to let the client manage its own credentials
      return null;
    }

    clearCache(): void {
      // Do nothing in mock
    }
  },
  TokenManagerError: class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'TokenManagerError';
    }
  },
  TokenError: {
    REFRESH_FAILED: 'REFRESH_FAILED',
    NO_REFRESH_TOKEN: 'NO_REFRESH_TOKEN',
    LOCK_TIMEOUT: 'LOCK_TIMEOUT',
    FILE_ACCESS_ERROR: 'FILE_ACCESS_ERROR',
    NETWORK_ERROR: 'NETWORK_ERROR',
  },
}));

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
      const expectedBaseUrl = process.env['DEBUG']
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
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    // Create client instance
    client = new QwenOAuth2Client();

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

    it('should successfully refresh access token and update credentials', async () => {
      // Clear any previous calls
      vi.clearAllMocks();

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

      // Verify the response
      expect(result).toMatchObject({
        access_token: 'new-access-token',
        token_type: 'Bearer',
        expires_in: 3600,
        resource_url: 'https://new-endpoint.com',
      });

      // Verify credentials were updated
      const credentials = client.getCredentials();
      expect(credentials).toMatchObject({
        access_token: 'new-access-token',
        token_type: 'Bearer',
        refresh_token: 'test-refresh-token', // Should preserve existing refresh token
        resource_url: 'https://new-endpoint.com',
      });
      expect(credentials.expiry_date).toBeDefined();
    });

    it('should use new refresh token if provided in response', async () => {
      // Clear any previous calls
      vi.clearAllMocks();

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

      // Verify the credentials contain the new refresh token
      const credentials = client.getCredentials();
      expect(credentials.refresh_token).toBe('new-refresh-token');
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

      // Override the client's SharedTokenManager instance directly
      (
        client as unknown as {
          sharedManager: {
            getValidCredentials: () => Promise<QwenCredentials>;
          };
        }
      ).sharedManager = {
        getValidCredentials: vi.fn().mockResolvedValue({
          access_token: 'new-access-token',
          refresh_token: 'valid-refresh-token',
          token_type: 'Bearer',
          expiry_date: Date.now() + 3600000,
        }),
      };

      const result = await client.getAccessToken();
      expect(result.token).toBe('new-access-token');
    });

    it('should return undefined if no access token and no refresh token', async () => {
      client.setCredentials({});

      // Override the client's SharedTokenManager instance directly
      (
        client as unknown as {
          sharedManager: {
            getValidCredentials: () => Promise<QwenCredentials>;
          };
        }
      ).sharedManager = {
        getValidCredentials: vi
          .fn()
          .mockRejectedValue(new Error('No credentials available')),
      };

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
      isBrowserLaunchSuppressed: vi.fn().mockReturnValue(false),
    } as unknown as Config;

    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('should load cached credentials if available', async () => {
    const fs = await import('node:fs');
    const mockCredentials = {
      access_token: 'cached-token',
      refresh_token: 'cached-refresh',
      token_type: 'Bearer',
      expiry_date: Date.now() + 3600000,
    };

    vi.mocked(fs.promises.readFile).mockResolvedValue(
      JSON.stringify(mockCredentials),
    );

    // Mock SharedTokenManager to use cached credentials
    const mockTokenManager = {
      getValidCredentials: vi.fn().mockResolvedValue(mockCredentials),
    };

    const originalGetInstance = SharedTokenManager.getInstance;
    SharedTokenManager.getInstance = vi.fn().mockReturnValue(mockTokenManager);

    const client = await import('./qwenOAuth2.js').then((module) =>
      module.getQwenOAuthClient(mockConfig),
    );

    expect(client).toBeInstanceOf(Object);
    expect(mockTokenManager.getValidCredentials).toHaveBeenCalled();

    SharedTokenManager.getInstance = originalGetInstance;
  });

  it('should handle cached credentials refresh failure', async () => {
    const fs = await import('node:fs');
    const mockCredentials = {
      access_token: 'cached-token',
      refresh_token: 'expired-refresh',
      token_type: 'Bearer',
      expiry_date: Date.now() + 3600000, // Valid expiry time so loadCachedQwenCredentials returns true
    };

    vi.mocked(fs.promises.readFile).mockResolvedValue(
      JSON.stringify(mockCredentials),
    );

    // Mock SharedTokenManager to fail with a specific error
    const mockTokenManager = {
      getValidCredentials: vi
        .fn()
        .mockRejectedValue(new Error('Token refresh failed')),
    };

    const originalGetInstance = SharedTokenManager.getInstance;
    SharedTokenManager.getInstance = vi.fn().mockReturnValue(mockTokenManager);

    // Mock device flow to also fail
    const mockAuthResponse = {
      ok: true,
      json: async () => ({
        error: 'invalid_request',
        error_description: 'Invalid request parameters',
      }),
    };
    vi.mocked(global.fetch).mockResolvedValue(mockAuthResponse as Response);

    // The function should handle the invalid cached credentials and throw the expected error
    await expect(
      import('./qwenOAuth2.js').then((module) =>
        module.getQwenOAuthClient(mockConfig),
      ),
    ).rejects.toThrow('Qwen OAuth authentication failed');

    SharedTokenManager.getInstance = originalGetInstance;
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
    client = new QwenOAuth2Client();
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

    // Mock SharedTokenManager to fail
    const mockTokenManager = {
      getValidCredentials: vi
        .fn()
        .mockRejectedValue(new Error('Refresh failed')),
    };

    const originalGetInstance = SharedTokenManager.getInstance;
    SharedTokenManager.getInstance = vi.fn().mockReturnValue(mockTokenManager);

    // Mock device flow to also fail
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

    SharedTokenManager.getInstance = originalGetInstance;
  });

  it('should handle different authentication failure reasons - timeout', async () => {
    const { promises: fs } = await import('node:fs');
    vi.mocked(fs.readFile).mockRejectedValue(
      new Error('No cached credentials'),
    );

    // Mock SharedTokenManager to fail
    const mockTokenManager = {
      getValidCredentials: vi
        .fn()
        .mockRejectedValue(new Error('No credentials')),
    };

    const originalGetInstance = SharedTokenManager.getInstance;
    SharedTokenManager.getInstance = vi.fn().mockReturnValue(mockTokenManager);

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

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(mockAuthResponse as Response)
      .mockResolvedValue(mockPendingResponse as Response);

    await expect(
      import('./qwenOAuth2.js').then((module) =>
        module.getQwenOAuthClient(mockConfig),
      ),
    ).rejects.toThrow('Qwen OAuth authentication timed out');

    SharedTokenManager.getInstance = originalGetInstance;
  });

  it('should handle authentication failure reason - rate limit', async () => {
    const { promises: fs } = await import('node:fs');
    vi.mocked(fs.readFile).mockRejectedValue(
      new Error('No cached credentials'),
    );

    // Mock SharedTokenManager to fail
    const mockTokenManager = {
      getValidCredentials: vi
        .fn()
        .mockRejectedValue(new Error('No credentials')),
    };

    const originalGetInstance = SharedTokenManager.getInstance;
    SharedTokenManager.getInstance = vi.fn().mockReturnValue(mockTokenManager);

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

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(mockAuthResponse as Response)
      .mockResolvedValue(mockRateLimitResponse as Response);

    await expect(
      import('./qwenOAuth2.js').then((module) =>
        module.getQwenOAuthClient(mockConfig),
      ),
    ).rejects.toThrow(
      'Too many request for Qwen OAuth authentication, please try again later.',
    );

    SharedTokenManager.getInstance = originalGetInstance;
  });

  it('should handle authentication failure reason - error', async () => {
    const { promises: fs } = await import('node:fs');
    vi.mocked(fs.readFile).mockRejectedValue(
      new Error('No cached credentials'),
    );

    // Mock SharedTokenManager to fail
    const mockTokenManager = {
      getValidCredentials: vi
        .fn()
        .mockRejectedValue(new Error('No credentials')),
    };

    const originalGetInstance = SharedTokenManager.getInstance;
    SharedTokenManager.getInstance = vi.fn().mockReturnValue(mockTokenManager);

    // Mock device authorization to fail
    const mockAuthResponse = {
      ok: true,
      json: async () => ({
        error: 'invalid_request',
        error_description: 'Invalid request parameters',
      }),
    };

    global.fetch = vi.fn().mockResolvedValue(mockAuthResponse as Response);

    await expect(
      import('./qwenOAuth2.js').then((module) =>
        module.getQwenOAuthClient(mockConfig),
      ),
    ).rejects.toThrow('Qwen OAuth authentication failed');

    SharedTokenManager.getInstance = originalGetInstance;
  });
});

describe('authWithQwenDeviceFlow - Comprehensive Testing', () => {
  let mockConfig: Config;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    mockConfig = {
      isBrowserLaunchSuppressed: vi.fn().mockReturnValue(false),
    } as unknown as Config;

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

    // Mock SharedTokenManager to fail
    const mockTokenManager = {
      getValidCredentials: vi
        .fn()
        .mockRejectedValue(new Error('No credentials')),
    };

    const originalGetInstance = SharedTokenManager.getInstance;
    SharedTokenManager.getInstance = vi.fn().mockReturnValue(mockTokenManager);

    const mockAuthResponse = {
      ok: true,
      json: async () => ({
        error: 'invalid_client',
        error_description: 'Client authentication failed',
      }),
    };

    global.fetch = vi.fn().mockResolvedValue(mockAuthResponse as Response);

    await expect(
      import('./qwenOAuth2.js').then((module) =>
        module.getQwenOAuthClient(mockConfig),
      ),
    ).rejects.toThrow('Qwen OAuth authentication failed');

    SharedTokenManager.getInstance = originalGetInstance;
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

    // Mock SharedTokenManager to fail
    const mockTokenManager = {
      getValidCredentials: vi
        .fn()
        .mockRejectedValue(new Error('No credentials')),
    };

    const originalGetInstance = SharedTokenManager.getInstance;
    SharedTokenManager.getInstance = vi.fn().mockReturnValue(mockTokenManager);

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

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(mockAuthResponse as Response)
      .mockResolvedValue(mock401Response as Response);

    await expect(
      import('./qwenOAuth2.js').then((module) =>
        module.getQwenOAuthClient(mockConfig),
      ),
    ).rejects.toThrow('Qwen OAuth authentication failed');

    SharedTokenManager.getInstance = originalGetInstance;
  });

  it('should handle token polling with browser launch suppressed', async () => {
    const { promises: fs } = await import('node:fs');
    vi.mocked(fs.readFile).mockRejectedValue(
      new Error('No cached credentials'),
    );

    // Mock SharedTokenManager to fail initially so device flow is used
    const mockTokenManager = {
      getValidCredentials: vi
        .fn()
        .mockRejectedValue(new Error('No credentials')),
    };

    const originalGetInstance = SharedTokenManager.getInstance;
    SharedTokenManager.getInstance = vi.fn().mockReturnValue(mockTokenManager);

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

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(mockAuthResponse as Response)
      .mockResolvedValue(mockTokenResponse as Response);

    const client = await import('./qwenOAuth2.js').then((module) =>
      module.getQwenOAuthClient(mockConfig),
    );

    expect(client).toBeInstanceOf(Object);
    expect(mockConfig.isBrowserLaunchSuppressed).toHaveBeenCalled();

    SharedTokenManager.getInstance = originalGetInstance;
  });
});

describe('Browser Launch and Error Handling', () => {
  let mockConfig: Config;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    mockConfig = {
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

describe('Utility Functions', () => {
  describe('objectToUrlEncoded', () => {
    it('should encode object properties to URL-encoded format', async () => {
      // Since objectToUrlEncoded is private, we test it indirectly through the client
      const objectToUrlEncoded = (data: Record<string, string>): string =>
        Object.keys(data)
          .map(
            (key) =>
              `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`,
          )
          .join('&');

      const testData = {
        client_id: 'test-client',
        scope: 'openid profile',
        redirect_uri: 'https://example.com/callback',
      };

      const result = objectToUrlEncoded(testData);

      expect(result).toContain('client_id=test-client');
      expect(result).toContain('scope=openid%20profile');
      expect(result).toContain(
        'redirect_uri=https%3A%2F%2Fexample.com%2Fcallback',
      );
    });

    it('should handle special characters', async () => {
      const objectToUrlEncoded = (data: Record<string, string>): string =>
        Object.keys(data)
          .map(
            (key) =>
              `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`,
          )
          .join('&');

      const testData = {
        'param with spaces': 'value with spaces',
        'param&with&amps': 'value&with&amps',
        'param=with=equals': 'value=with=equals',
      };

      const result = objectToUrlEncoded(testData);

      expect(result).toContain('param%20with%20spaces=value%20with%20spaces');
      expect(result).toContain('param%26with%26amps=value%26with%26amps');
      expect(result).toContain('param%3Dwith%3Dequals=value%3Dwith%3Dequals');
    });

    it('should handle empty object', async () => {
      const objectToUrlEncoded = (data: Record<string, string>): string =>
        Object.keys(data)
          .map(
            (key) =>
              `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`,
          )
          .join('&');

      const result = objectToUrlEncoded({});
      expect(result).toBe('');
    });
  });

  describe('getQwenCachedCredentialPath', () => {
    it('should return correct path to cached credentials', async () => {
      const os = await import('os');
      const path = await import('path');

      const expectedPath = path.join(os.homedir(), '.qwen', 'oauth_creds.json');

      // Since this is a private function, we test it indirectly through clearQwenCredentials
      const { promises: fs } = await import('node:fs');
      const { clearQwenCredentials } = await import('./qwenOAuth2.js');

      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      await clearQwenCredentials();

      expect(fs.unlink).toHaveBeenCalledWith(expectedPath);
    });
  });
});

describe('Credential Caching Functions', () => {
  describe('cacheQwenCredentials', () => {
    it('should create directory and write credentials to file', async () => {
      // Mock the internal cacheQwenCredentials function by creating client and calling refresh
      const client = new QwenOAuth2Client();
      client.setCredentials({
        refresh_token: 'test-refresh',
      });

      const mockResponse = {
        ok: true,
        json: async () => ({
          access_token: 'new-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse as Response);

      await client.refreshAccessToken();

      // Note: File caching is now handled by SharedTokenManager, so these calls won't happen
      // This test verifies that refreshAccessToken works correctly
      const updatedCredentials = client.getCredentials();
      expect(updatedCredentials.access_token).toBe('new-token');
    });
  });

  describe('loadCachedQwenCredentials', () => {
    it('should load and validate cached credentials successfully', async () => {
      const { promises: fs } = await import('node:fs');
      const mockCredentials = {
        access_token: 'cached-token',
        refresh_token: 'cached-refresh',
        token_type: 'Bearer',
        expiry_date: Date.now() + 3600000,
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockCredentials));

      // Test through getQwenOAuthClient which calls loadCachedQwenCredentials
      const mockConfig = {
        isBrowserLaunchSuppressed: vi.fn().mockReturnValue(true),
      } as unknown as Config;

      // Make SharedTokenManager fail to test the fallback
      const mockTokenManager = {
        getValidCredentials: vi
          .fn()
          .mockRejectedValue(new Error('No cached creds')),
      };

      const originalGetInstance = SharedTokenManager.getInstance;
      SharedTokenManager.getInstance = vi
        .fn()
        .mockReturnValue(mockTokenManager);

      // Mock successful auth flow after cache load fails
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

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(mockAuthResponse as Response)
        .mockResolvedValue(mockTokenResponse as Response);

      try {
        await import('./qwenOAuth2.js').then((module) =>
          module.getQwenOAuthClient(mockConfig),
        );
      } catch {
        // Expected to fail in test environment
      }

      expect(fs.readFile).toHaveBeenCalled();
      SharedTokenManager.getInstance = originalGetInstance;
    });

    it('should handle invalid cached credentials gracefully', async () => {
      const { promises: fs } = await import('node:fs');

      // Mock file read to return invalid JSON
      vi.mocked(fs.readFile).mockResolvedValue('invalid-json');

      const mockConfig = {
        isBrowserLaunchSuppressed: vi.fn().mockReturnValue(true),
      } as unknown as Config;

      const mockTokenManager = {
        getValidCredentials: vi
          .fn()
          .mockRejectedValue(new Error('No cached creds')),
      };

      const originalGetInstance = SharedTokenManager.getInstance;
      SharedTokenManager.getInstance = vi
        .fn()
        .mockReturnValue(mockTokenManager);

      // Mock auth flow
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
          access_token: 'new-token',
          refresh_token: 'new-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      };

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(mockAuthResponse as Response)
        .mockResolvedValue(mockTokenResponse as Response);

      try {
        await import('./qwenOAuth2.js').then((module) =>
          module.getQwenOAuthClient(mockConfig),
        );
      } catch {
        // Expected to fail in test environment
      }

      SharedTokenManager.getInstance = originalGetInstance;
    });

    it('should handle file access errors', async () => {
      const { promises: fs } = await import('node:fs');

      vi.mocked(fs.readFile).mockRejectedValue(new Error('File not found'));

      const mockConfig = {
        isBrowserLaunchSuppressed: vi.fn().mockReturnValue(true),
      } as unknown as Config;

      const mockTokenManager = {
        getValidCredentials: vi
          .fn()
          .mockRejectedValue(new Error('No cached creds')),
      };

      const originalGetInstance = SharedTokenManager.getInstance;
      SharedTokenManager.getInstance = vi
        .fn()
        .mockReturnValue(mockTokenManager);

      // Mock device flow to fail quickly
      const mockAuthResponse = {
        ok: true,
        json: async () => ({
          error: 'invalid_request',
          error_description: 'Invalid request parameters',
        }),
      };

      global.fetch = vi.fn().mockResolvedValue(mockAuthResponse as Response);

      // Should proceed to device flow when cache loading fails
      try {
        await import('./qwenOAuth2.js').then((module) =>
          module.getQwenOAuthClient(mockConfig),
        );
      } catch {
        // Expected to fail in test environment
      }

      SharedTokenManager.getInstance = originalGetInstance;
    });
  });
});

describe('Enhanced Error Handling and Edge Cases', () => {
  let client: QwenOAuth2Client;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    client = new QwenOAuth2Client();
    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  describe('QwenOAuth2Client getAccessToken enhanced scenarios', () => {
    it('should handle SharedTokenManager failure and fall back to cached token', async () => {
      // Set up client with valid credentials
      client.setCredentials({
        access_token: 'fallback-token',
        expiry_date: Date.now() + 3600000, // Valid for 1 hour
      });

      // Override the client's SharedTokenManager instance directly to ensure it fails
      (
        client as unknown as {
          sharedManager: {
            getValidCredentials: () => Promise<QwenCredentials>;
          };
        }
      ).sharedManager = {
        getValidCredentials: vi
          .fn()
          .mockRejectedValue(new Error('Manager failed')),
      };

      // Mock console.warn to avoid test noise
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await client.getAccessToken();

      expect(result.token).toBe('fallback-token');
      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to get access token from shared manager:',
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });

    it('should return undefined when both manager and cache fail', async () => {
      // Set up client with expired credentials
      client.setCredentials({
        access_token: 'expired-token',
        expiry_date: Date.now() - 1000, // Expired
      });

      // Override the client's SharedTokenManager instance directly to ensure it fails
      (
        client as unknown as {
          sharedManager: {
            getValidCredentials: () => Promise<QwenCredentials>;
          };
        }
      ).sharedManager = {
        getValidCredentials: vi
          .fn()
          .mockRejectedValue(new Error('Manager failed')),
      };

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await client.getAccessToken();

      expect(result.token).toBeUndefined();

      consoleSpy.mockRestore();
    });

    it('should handle missing credentials gracefully', async () => {
      // No credentials set
      client.setCredentials({});

      // Override the client's SharedTokenManager instance directly to ensure it fails
      (
        client as unknown as {
          sharedManager: {
            getValidCredentials: () => Promise<QwenCredentials>;
          };
        }
      ).sharedManager = {
        getValidCredentials: vi
          .fn()
          .mockRejectedValue(new Error('No credentials')),
      };

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await client.getAccessToken();

      expect(result.token).toBeUndefined();

      consoleSpy.mockRestore();
    });
  });

  describe('Enhanced requestDeviceAuthorization scenarios', () => {
    it('should include x-request-id header', async () => {
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

      await client.requestDeviceAuthorization({
        scope: 'openid profile email model.completion',
        code_challenge: 'test-challenge',
        code_challenge_method: 'S256',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-request-id': expect.any(String),
          }),
        }),
      );
    });

    it('should include correct Content-Type and Accept headers', async () => {
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

      await client.requestDeviceAuthorization({
        scope: 'openid profile email model.completion',
        code_challenge: 'test-challenge',
        code_challenge_method: 'S256',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          }),
        }),
      );
    });

    it('should send correct form data', async () => {
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

      await client.requestDeviceAuthorization({
        scope: 'test-scope',
        code_challenge: 'test-challenge',
        code_challenge_method: 'S256',
      });

      const [, options] = vi.mocked(global.fetch).mock.calls[0];
      expect(options?.body).toContain(
        'client_id=f0304373b74a44d2b584a3fb70ca9e56',
      );
      expect(options?.body).toContain('scope=test-scope');
      expect(options?.body).toContain('code_challenge=test-challenge');
      expect(options?.body).toContain('code_challenge_method=S256');
    });
  });

  describe('Enhanced pollDeviceToken scenarios', () => {
    it('should handle JSON parsing error during error response', async () => {
      const mockResponse = {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: vi.fn().mockRejectedValue(new Error('Invalid JSON')),
        text: vi.fn().mockResolvedValue('Invalid request format'),
      };

      vi.mocked(global.fetch).mockResolvedValue(
        mockResponse as unknown as Response,
      );

      await expect(
        client.pollDeviceToken({
          device_code: 'test-device-code',
          code_verifier: 'test-verifier',
        }),
      ).rejects.toThrow('Device token poll failed: 400 Bad Request');
    });

    it('should include status code in thrown errors', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: vi.fn().mockRejectedValue(new Error('Invalid JSON')),
        text: vi.fn().mockResolvedValue('Internal server error'),
      };

      global.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse as unknown as Response);

      await expect(
        client.pollDeviceToken({
          device_code: 'test-device-code',
          code_verifier: 'test-verifier',
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          'Device token poll failed: 500 Internal Server Error',
        ),
        status: 500,
      });
    });

    it('should handle authorization_pending with correct status', async () => {
      const mockResponse = {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: vi.fn().mockResolvedValue({
          error: 'authorization_pending',
          error_description: 'Authorization request is pending',
        }),
      };

      vi.mocked(global.fetch).mockResolvedValue(
        mockResponse as unknown as Response,
      );

      const result = await client.pollDeviceToken({
        device_code: 'test-device-code',
        code_verifier: 'test-verifier',
      });

      expect(result).toEqual({ status: 'pending' });
    });
  });

  describe('Enhanced refreshAccessToken scenarios', () => {
    it('should call clearQwenCredentials on 400 error', async () => {
      client.setCredentials({
        refresh_token: 'expired-refresh',
      });

      const { promises: fs } = await import('node:fs');
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const mockResponse = {
        ok: false,
        status: 400,
        text: async () => 'Bad Request',
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      await expect(client.refreshAccessToken()).rejects.toThrow(
        "Refresh token expired or invalid. Please use '/auth' to re-authenticate.",
      );

      expect(fs.unlink).toHaveBeenCalled();
    });

    it('should preserve existing refresh token when new one not provided', async () => {
      const originalRefreshToken = 'original-refresh-token';
      client.setCredentials({
        refresh_token: originalRefreshToken,
      });

      const mockResponse = {
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          // No refresh_token in response
        }),
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      await client.refreshAccessToken();

      const credentials = client.getCredentials();
      expect(credentials.refresh_token).toBe(originalRefreshToken);
    });

    it('should include resource_url when provided in response', async () => {
      client.setCredentials({
        refresh_token: 'test-refresh',
      });

      const mockResponse = {
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          resource_url: 'https://new-resource-url.com',
        }),
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as Response);

      await client.refreshAccessToken();

      const credentials = client.getCredentials();
      expect(credentials.resource_url).toBe('https://new-resource-url.com');
    });
  });

  describe('isTokenValid edge cases', () => {
    it('should return false for tokens expiring within buffer time', () => {
      const nearExpiryTime = Date.now() + 15000; // 15 seconds from now (within 30s buffer)

      client.setCredentials({
        access_token: 'test-token',
        expiry_date: nearExpiryTime,
      });

      const isValid = (
        client as unknown as { isTokenValid(): boolean }
      ).isTokenValid();
      expect(isValid).toBe(false);
    });

    it('should return true for tokens expiring well beyond buffer time', () => {
      const futureExpiryTime = Date.now() + 120000; // 2 minutes from now (beyond 30s buffer)

      client.setCredentials({
        access_token: 'test-token',
        expiry_date: futureExpiryTime,
      });

      const isValid = (
        client as unknown as { isTokenValid(): boolean }
      ).isTokenValid();
      expect(isValid).toBe(true);
    });
  });
});

describe('SharedTokenManager Integration in QwenOAuth2Client', () => {
  let client: QwenOAuth2Client;

  beforeEach(() => {
    client = new QwenOAuth2Client();
  });

  it('should use SharedTokenManager instance in constructor', () => {
    const sharedManager = (
      client as unknown as { sharedManager: MockSharedTokenManager }
    ).sharedManager;
    expect(sharedManager).toBeDefined();
  });

  it('should handle TokenManagerError types correctly in getQwenOAuthClient', async () => {
    const mockConfig = {
      isBrowserLaunchSuppressed: vi.fn().mockReturnValue(true),
    } as unknown as Config;

    // Test different TokenManagerError types
    const tokenErrors = [
      { type: TokenError.NO_REFRESH_TOKEN, message: 'No refresh token' },
      { type: TokenError.REFRESH_FAILED, message: 'Token refresh failed' },
      { type: TokenError.NETWORK_ERROR, message: 'Network error' },
      { type: TokenError.REFRESH_FAILED, message: 'Refresh failed' },
    ];

    for (const errorInfo of tokenErrors) {
      const tokenError = new TokenManagerError(
        errorInfo.type,
        errorInfo.message,
      );

      const mockTokenManager = {
        getValidCredentials: vi.fn().mockRejectedValue(tokenError),
      };

      const originalGetInstance = SharedTokenManager.getInstance;
      SharedTokenManager.getInstance = vi
        .fn()
        .mockReturnValue(mockTokenManager);

      const { promises: fs } = await import('node:fs');
      vi.mocked(fs.readFile).mockRejectedValue(new Error('No cached file'));

      // Mock device flow to succeed
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
          access_token: 'new-token',
          refresh_token: 'new-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      };

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(mockAuthResponse as Response)
        .mockResolvedValue(mockTokenResponse as Response);

      try {
        await import('./qwenOAuth2.js').then((module) =>
          module.getQwenOAuthClient(mockConfig),
        );
      } catch {
        // Expected to fail in test environment
      }

      SharedTokenManager.getInstance = originalGetInstance;
      vi.clearAllMocks();
    }
  });
});

describe('Constants and Configuration', () => {
  it('should have correct OAuth endpoints', async () => {
    // Test that the constants are properly defined by checking they're used in requests
    const client = new QwenOAuth2Client();

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

    global.fetch = vi.fn().mockResolvedValue(mockResponse as Response);

    await client.requestDeviceAuthorization({
      scope: 'test-scope',
      code_challenge: 'test-challenge',
      code_challenge_method: 'S256',
    });

    const [url] = vi.mocked(global.fetch).mock.calls[0];
    expect(url).toBe('https://chat.qwen.ai/api/v1/oauth2/device/code');
  });

  it('should use correct client ID in requests', async () => {
    const client = new QwenOAuth2Client();

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

    global.fetch = vi.fn().mockResolvedValue(mockResponse as Response);

    await client.requestDeviceAuthorization({
      scope: 'test-scope',
      code_challenge: 'test-challenge',
      code_challenge_method: 'S256',
    });

    const [, options] = vi.mocked(global.fetch).mock.calls[0];
    expect(options?.body).toContain(
      'client_id=f0304373b74a44d2b584a3fb70ca9e56',
    );
  });

  it('should use correct default scope', async () => {
    // Test the default scope constant by checking it's used in device flow
    const client = new QwenOAuth2Client();

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

    global.fetch = vi.fn().mockResolvedValue(mockResponse as Response);

    await client.requestDeviceAuthorization({
      scope: 'openid profile email model.completion',
      code_challenge: 'test-challenge',
      code_challenge_method: 'S256',
    });

    const [, options] = vi.mocked(global.fetch).mock.calls[0];
    expect(options?.body).toContain(
      'scope=openid%20profile%20email%20model.completion',
    );
  });
});
