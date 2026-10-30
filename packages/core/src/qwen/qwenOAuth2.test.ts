/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { promises as fs } from 'node:fs';
import type { Config } from '../config/config.js';
import {
  clearQwenCredentials,
  CredentialsClearRequiredError,
  generateCodeChallenge,
  generateCodeVerifier,
  generatePKCEPair,
  getQwenOAuthClient,
  isDeviceAuthorizationSuccess,
  isDeviceTokenPending,
  isDeviceTokenSuccess,
  isErrorResponse,
  qwenOAuth2Events,
  QwenOAuth2Event,
  QwenOAuth2Client,
  showFallbackMessage,
  type DeviceTokenResponse,
  type ErrorData,
  type QwenCredentials,
} from './qwenOAuth2.js';
import { HYPERLINK_ENV_KEYS } from '../utils/osc8.js';
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

const mockOpenBrowserSecurely = vi.hoisted(() => vi.fn());

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

vi.mock('../utils/secure-browser-launcher.js', () => ({
  openBrowserSecurely: mockOpenBrowserSecurely,
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
    // PR #4255 round-11 #2 (gpt-5.5 review): atomic write uses
    // temp-file → chmod → rename. Tests need chmod + rename in the
    // mocked fs surface; both default to no-op success.
    chmod: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  },
}));

beforeEach(() => {
  mockOpenBrowserSecurely.mockReset();
  mockOpenBrowserSecurely.mockResolvedValue(undefined);
});

const SCOPE = 'openid profile email model.completion';
const REFRESH_EXPIRED =
  "Refresh token expired or invalid. Please use '/auth' to re-authenticate.";
const INVALID_PARAMS: ErrorData = {
  error: 'INVALID_REQUEST',
  error_description: 'The request parameters are invalid',
};
const INVALID_REQUEST = {
  error: 'invalid_request',
  error_description: 'Invalid request parameters',
};
// Fresh bodies per call, so a result can be compared with an independent copy.
const deviceAuth = (expires_in = 1800) => ({
  device_code: 'test-device-code',
  user_code: 'TEST123',
  verification_uri: 'https://chat.qwen.ai/device',
  verification_uri_complete: 'https://chat.qwen.ai/device?code=TEST123',
  expires_in,
});
const deviceToken = () => ({
  access_token: 'new-access-token',
  refresh_token: 'new-refresh-token',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: SCOPE,
});
const refreshed = (extra: Record<string, string> = {}) => ({
  access_token: 'new-access-token',
  token_type: 'Bearer',
  expires_in: 3600,
  ...extra,
});

// fetch Response stubs; each carries only the members its original literal had.
const okJson = (body: unknown) =>
  ({ ok: true, json: async () => body }) as Response;
// Refresh bodies: the client reads text(); json() mirrors it.
const okJsonText = (body: unknown) =>
  ({
    ok: true,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as Response;
const httpError = (status: number, statusText: string, text: string) =>
  ({ ok: false, status, statusText, text: async () => text }) as Response;
// An RFC 8628 error body served through both text() and json().
const oauthError = (status: number, statusText: string, errorData: object) =>
  ({
    ...httpError(status, statusText, JSON.stringify(errorData)),
    json: async () => errorData,
  }) as Response;

// Answers fetch with each response once, then with the last one from there on.
function respond(...responses: Response[]) {
  const last = responses.pop() as Response;
  for (const response of responses) {
    vi.mocked(global.fetch).mockResolvedValueOnce(response);
  }
  vi.mocked(global.fetch).mockResolvedValue(last);
}

const requestAuth = (client: QwenOAuth2Client, scope = SCOPE) =>
  client.requestDeviceAuthorization({
    scope,
    code_challenge: 'test-challenge',
    code_challenge_method: 'S256',
  });
const poll = (
  client: QwenOAuth2Client,
  device_code = 'test-device-code',
  code_verifier = 'test-code-verifier',
) => client.pollDeviceToken({ device_code, code_verifier });
const refreshWith = (client: QwenOAuth2Client, body: unknown) => {
  respond(okJsonText(body));
  return client.refreshAccessToken();
};

// Makes SharedTokenManager.getInstance() return `manager`; returns the restore.
function stubManager(manager: object) {
  const originalGetInstance = SharedTokenManager.getInstance;
  SharedTokenManager.getInstance = vi.fn().mockReturnValue(manager);
  return () => {
    SharedTokenManager.getInstance = originalGetInstance;
  };
}
const failingManager = (message = 'No credentials') => ({
  getValidCredentials: vi.fn().mockRejectedValue(new Error(message)),
});
// Replaces a client's own token manager (set in its constructor).
function setClientManager(
  client: QwenOAuth2Client,
  getValidCredentials: () => Promise<QwenCredentials>,
) {
  (
    client as unknown as {
      sharedManager: { getValidCredentials: () => Promise<QwenCredentials> };
    }
  ).sharedManager = { getValidCredentials };
}

// Device-flow fallback: no cached file and a failing token manager, so
// getQwenOAuthClient goes to fetch, which answers with `responses`.
function startDeviceFlow(...responses: Response[]) {
  vi.mocked(fs.readFile).mockRejectedValue(new Error('No cached credentials'));
  const restore = stubManager(failingManager());
  respond(...responses);
  return restore;
}
async function expectDeviceFlowFailure(
  config: Config,
  message: string,
  ...responses: Response[]
) {
  const restore = startDeviceFlow(...responses);
  await expect(getQwenOAuthClient(config)).rejects.toThrow(message);
  restore();
}
async function completeDeviceFlow(config: Config) {
  const restore = startDeviceFlow(okJson(deviceAuth()), okJson(deviceToken()));
  const client = await getQwenOAuthClient(config);
  restore();
  return client;
}

// Per-case setup most suites share: a mocked global fetch (restored after
// each case), a fresh client and a Config stub that allows the browser launch
// in an interactive session.
function useSuite({ fakeTimers = false } = {}) {
  const suite = {} as { client: QwenOAuth2Client; config: Config };
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    suite.client = new QwenOAuth2Client();
    suite.config = {
      isBrowserLaunchSuppressed: vi.fn().mockReturnValue(false),
      isInteractive: vi.fn().mockReturnValue(true),
    } as unknown as Config;
    originalFetch = global.fetch;
    global.fetch = vi.fn();
    if (fakeTimers) vi.useFakeTimers(); // avoids real delays
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
    if (fakeTimers) vi.useRealTimers();
  });
  return suite;
}

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
  const PENDING: DeviceTokenResponse = { status: 'pending' };
  const DENIED: DeviceTokenResponse = {
    error: 'ACCESS_DENIED',
    error_description: 'User denied the authorization request',
  };
  const TOKEN: DeviceTokenResponse = {
    access_token: 'valid-access-token',
    refresh_token: 'valid-refresh-token',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: SCOPE,
  };

  describe('isDeviceAuthorizationSuccess', () => {
    it('should return true for successful authorization response', () => {
      const expectedBaseUrl = process.env['DEBUG']
        ? 'https://pre4-chat.qwen.ai'
        : 'https://chat.qwen.ai';
      const successResponse = {
        ...deviceAuth(),
        verification_uri: `${expectedBaseUrl}/device`,
        verification_uri_complete: `${expectedBaseUrl}/device?code=TEST123`,
      };
      expect(isDeviceAuthorizationSuccess(successResponse)).toBe(true);
    });

    it('should return false for error response', () => {
      expect(isDeviceAuthorizationSuccess(INVALID_PARAMS)).toBe(false);
    });
  });

  describe('isDeviceTokenPending', () => {
    it.each<[string, DeviceTokenResponse, boolean]>([
      ['should return true for pending response', PENDING, true],
      ['should return false for success response', TOKEN, false],
      ['should return false for error response', DENIED, false],
    ])('%s', (_title, response, expected) => {
      expect(isDeviceTokenPending(response)).toBe(expected);
    });
  });

  describe('isDeviceTokenSuccess', () => {
    it.each<[string, DeviceTokenResponse, boolean]>([
      ['should return true for successful token response', TOKEN, true],
      ['should return false for pending response', PENDING, false],
      ['should return false for error response', DENIED, false],
      [
        'should return false for null access token',
        { access_token: null, token_type: 'Bearer', expires_in: 3600 },
        false,
      ],
      [
        'should return false for empty access token',
        { access_token: '', token_type: 'Bearer', expires_in: 3600 },
        false,
      ],
    ])('%s', (_title, response, expected) => {
      expect(isDeviceTokenSuccess(response)).toBe(expected);
    });
  });

  describe('isErrorResponse', () => {
    it('should return true for error responses', () => {
      expect(isErrorResponse(INVALID_PARAMS)).toBe(true);
    });

    it('should return false for successful responses', () => {
      expect(isErrorResponse(deviceAuth())).toBe(false);
    });
  });
});

describe('QwenOAuth2Client', () => {
  const s = useSuite();
  const withRefreshToken = () => {
    s.client.setCredentials({
      access_token: 'old-token',
      refresh_token: 'test-refresh-token',
      token_type: 'Bearer',
    });
  };
  const NEW_ENDPOINT = { resource_url: 'https://new-endpoint.com' };

  describe('requestDeviceAuthorization', () => {
    it('should successfully request device authorization', async () => {
      respond(okJson(deviceAuth()));
      expect(await requestAuth(s.client)).toEqual(deviceAuth());
    });

    it('should handle error response', async () => {
      respond(okJson(INVALID_PARAMS));
      await expect(requestAuth(s.client)).rejects.toThrow(
        'Device authorization failed: INVALID_REQUEST - The request parameters are invalid',
      );
    });
  });

  describe('refreshAccessToken', () => {
    beforeEach(withRefreshToken);

    it('should successfully refresh access token', async () => {
      expect(await refreshWith(s.client, refreshed(NEW_ENDPOINT))).toEqual(
        refreshed(NEW_ENDPOINT),
      );
      // Credentials were updated.
      expect(s.client.getCredentials().access_token).toBe('new-access-token');
    });

    it('should handle refresh error', async () => {
      await expect(
        refreshWith(s.client, {
          error: 'INVALID_GRANT',
          error_description: 'The refresh token is invalid',
        }),
      ).rejects.toThrow(
        'Token refresh failed: INVALID_GRANT - The refresh token is invalid',
      );
    });

    it('should successfully refresh access token and update credentials', async () => {
      vi.clearAllMocks(); // clear any previous calls
      expect(
        await refreshWith(s.client, refreshed(NEW_ENDPOINT)),
      ).toMatchObject(refreshed(NEW_ENDPOINT));

      const credentials = s.client.getCredentials();
      expect(credentials).toMatchObject({
        access_token: 'new-access-token',
        token_type: 'Bearer',
        refresh_token: 'test-refresh-token', // the existing refresh token is kept
        resource_url: 'https://new-endpoint.com',
      });
      expect(credentials.expiry_date).toBeDefined();
    });

    it('should use new refresh token if provided in response', async () => {
      vi.clearAllMocks(); // clear any previous calls
      await refreshWith(
        s.client,
        refreshed({ refresh_token: 'new-refresh-token', ...NEW_ENDPOINT }),
      );
      expect(s.client.getCredentials().refresh_token).toBe('new-refresh-token');
    });
  });

  describe('getAccessToken', () => {
    it('should return access token if valid and not expired', async () => {
      s.client.setCredentials({
        access_token: 'valid-token',
        expiry_date: Date.now() + 60 * 60 * 1000, // 1 hour from now
      });
      expect((await s.client.getAccessToken()).token).toBe('valid-token');
    });

    it('should refresh token if access token is expired', async () => {
      s.client.setCredentials({
        access_token: 'expired-token',
        refresh_token: 'valid-refresh-token',
        expiry_date: Date.now() - 1000, // 1 second ago
      });
      setClientManager(
        s.client,
        vi.fn().mockResolvedValue({
          access_token: 'new-access-token',
          refresh_token: 'valid-refresh-token',
          token_type: 'Bearer',
          expiry_date: Date.now() + 3600000,
        }),
      );
      expect((await s.client.getAccessToken()).token).toBe('new-access-token');
    });

    it('should return undefined if no access token and no refresh token', async () => {
      s.client.setCredentials({});
      setClientManager(
        s.client,
        vi.fn().mockRejectedValue(new Error('No credentials available')),
      );
      expect((await s.client.getAccessToken()).token).toBeUndefined();
    });
  });

  describe('pollDeviceToken', () => {
    it('should successfully poll for device token', async () => {
      respond(okJson(deviceToken()));
      expect(await poll(s.client)).toEqual(deviceToken());
    });

    it('should return pending status when authorization is pending', async () => {
      respond(okJson({ status: 'pending' }));
      expect(await poll(s.client)).toEqual({ status: 'pending' });
    });

    it('should handle HTTP error responses', async () => {
      respond(httpError(400, 'Bad Request', 'Invalid device code'));
      await expect(poll(s.client, 'invalid-device-code')).rejects.toThrow(
        'Device token poll failed: 400 Bad Request',
      );
    });

    it('should include status code in error for better handling', async () => {
      respond(httpError(429, 'Too Many Requests', 'Rate limited'));
      try {
        await poll(s.client);
      } catch (error) {
        expect((error as Error & { status?: number }).status).toBe(429);
      }
    });

    it('should handle authorization_pending with HTTP 400 according to RFC 8628', async () => {
      respond(
        oauthError(400, 'Bad Request', {
          error: 'authorization_pending',
          error_description: 'The authorization request is still pending',
        }),
      );
      expect(await poll(s.client)).toEqual({ status: 'pending' });
    });

    it('should handle slow_down with HTTP 429 according to RFC 8628', async () => {
      respond(
        oauthError(429, 'Too Many Requests', {
          error: 'slow_down',
          error_description: 'The client is polling too frequently',
        }),
      );
      expect(await poll(s.client)).toEqual({
        status: 'pending',
        slowDown: true,
      });
    });
  });

  describe('refreshAccessToken error handling', () => {
    beforeEach(withRefreshToken);
    // Starts a refresh, runs out the 30s refresh timeout and returns the rejection.
    const errorAfterTimeout = async () => {
      const refreshError = s.client
        .refreshAccessToken()
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      return (await refreshError) as Error;
    };

    it('should throw error if no refresh token available', async () => {
      s.client.setCredentials({ access_token: 'token' });
      await expect(s.client.refreshAccessToken()).rejects.toThrow(
        'No refresh token available',
      );
    });

    it('should handle 400 status as expired refresh token', async () => {
      respond(httpError(400, 'Bad Request', 'Refresh token expired'));
      await expect(s.client.refreshAccessToken()).rejects.toThrow(
        REFRESH_EXPIRED,
      );
    });

    it('should handle other HTTP error statuses', async () => {
      respond(httpError(500, 'Internal Server Error', 'Server error'));
      await expect(s.client.refreshAccessToken()).rejects.toThrow(
        'Token refresh failed: 500 Internal Server Error',
      );
    });

    it('should time out hung refresh token requests', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(global.fetch).mockImplementation(
          (_url, init) =>
            new Promise<Response>((_, reject) => {
              const signal = (init as RequestInit).signal;
              if (!signal) {
                reject(new Error('missing abort signal'));
                return;
              }
              signal.addEventListener(
                'abort',
                () => {
                  reject(
                    Object.assign(
                      new DOMException(
                        'The operation was aborted',
                        'AbortError',
                      ),
                      { cause: signal.reason },
                    ),
                  );
                },
                { once: true },
              );
            }),
        );

        const error = await errorAfterTimeout();
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain(
          'Token refresh timeout: The operation was aborted (cause: Operation timed out)',
        );
        expect(error.cause).toBeInstanceOf(DOMException);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should keep the refresh timeout active while reading the response body', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(global.fetch).mockImplementation(async (_url, init) => {
          const signal = (init as RequestInit).signal;
          if (!signal) {
            throw new Error('missing abort signal');
          }
          return {
            ok: true,
            text: () =>
              new Promise<string>((_, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), {
                  once: true,
                });
              }),
          } as Response;
        });

        const error = await errorAfterTimeout();
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('Token refresh timeout:');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should preserve non-timeout network errors and show the token endpoint', async () => {
      const cause = Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      });
      const networkError = new TypeError('fetch failed', { cause });
      vi.mocked(global.fetch).mockRejectedValue(networkError);

      const error = (await s.client
        .refreshAccessToken()
        .catch((refreshError: unknown) => refreshError)) as Error;

      expect(error).toBeInstanceOf(Error);
      expect(error.cause).toBe(networkError);
      expect(error.message).toContain('Token refresh failed:');
      expect(error.message).toContain(
        'https://chat.qwen.ai/api/v1/oauth2/token',
      );
    });

    it('should NOT clear credentials on malformed 200 response (e.g. proxy HTML)', async () => {
      respond({
        ok: true,
        status: 200,
        text: async () => '<html><body>Proxy Error</body></html>',
      } as Response);

      // A retryable Error, NOT CredentialsClearRequiredError (which implies
      // the credentials were cleared).
      await expect(s.client.refreshAccessToken()).rejects.toBeInstanceOf(Error);
      await expect(s.client.refreshAccessToken()).rejects.not.toBeInstanceOf(
        CredentialsClearRequiredError,
      );
      await expect(s.client.refreshAccessToken()).rejects.toThrow(
        'Qwen OAuth refresh returned invalid JSON:',
      );
    });

    it('should clear credentials and throw CredentialsClearRequiredError on 401 response', async () => {
      respond(httpError(401, 'Unauthorized', 'Unauthorized'));
      await expect(s.client.refreshAccessToken()).rejects.toBeInstanceOf(
        CredentialsClearRequiredError,
      );
      await expect(s.client.refreshAccessToken()).rejects.toThrow(
        REFRESH_EXPIRED,
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

      s.client.setCredentials(credentials);
      expect(s.client.getCredentials()).toEqual(credentials);
    });

    it('should handle empty credentials', () => {
      s.client.setCredentials({});
      expect(s.client.getCredentials()).toEqual({});
    });
  });
});

describe('getQwenOAuthClient', () => {
  const s = useSuite();

  it('should load cached credentials if available', async () => {
    // The token manager serves cached credentials.
    const mockTokenManager = {
      getValidCredentials: vi.fn().mockResolvedValue({
        access_token: 'cached-token',
        refresh_token: 'cached-refresh',
        token_type: 'Bearer',
        expiry_date: Date.now() + 3600000,
      }),
    };
    const restore = stubManager(mockTokenManager);

    expect(await getQwenOAuthClient(s.config)).toBeInstanceOf(Object);
    expect(mockTokenManager.getValidCredentials).toHaveBeenCalled();
    restore();
  });

  it('should handle cached credentials refresh failure', async () => {
    const restore = stubManager(failingManager('Token refresh failed'));
    respond(okJson(INVALID_REQUEST)); // the device flow fails too

    // Invalid cached credentials end in the device-flow error.
    await expect(getQwenOAuthClient(s.config)).rejects.toThrow(
      'Device authorization flow failed',
    );
    restore();
  });

  it('should not start device flow when requireCachedCredentials is true', async () => {
    const restore = stubManager(failingManager()); // hit the fallback path
    // If requireCachedCredentials is honored, no device-flow request starts.
    respond({ ok: true } as Response);

    await expect(
      getQwenOAuthClient(s.config, { requireCachedCredentials: true }),
    ).rejects.toThrow(
      'Qwen OAuth credentials expired. Please use /auth to re-authenticate with qwen-oauth.',
    );
    expect(global.fetch).not.toHaveBeenCalled();
    restore();
  });

  it('should include troubleshooting hints when device auth fetch fails', async () => {
    // A failing token manager sends it down the device-flow path.
    const restore = stubManager(failingManager('Token refresh failed'));
    const tlsCause = Object.assign(
      new Error('unable to verify the first certificate'),
      { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
    );
    vi.mocked(global.fetch).mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { cause: tlsCause }),
    );
    const emitSpy = vi.spyOn(qwenOAuth2Events, 'emit');

    const thrownError = await getQwenOAuthClient(s.config).catch(
      (error: unknown) => error,
    );

    expect(thrownError).toBeInstanceOf(Error);
    const { message } = thrownError as Error;
    expect(message).toContain('Device authorization flow failed: fetch failed');
    expect(message).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(message).toContain('NODE_EXTRA_CA_CERTS');
    expect(message).toContain('--proxy');
    expect(emitSpy).toHaveBeenCalledWith(
      QwenOAuth2Event.AuthProgress,
      'error',
      expect.stringContaining('NODE_EXTRA_CA_CERTS'),
    );

    emitSpy.mockRestore();
    restore();
  });
});

describe('CredentialsClearRequiredError', () => {
  it('should create error with correct name and message', () => {
    const message = 'Test error message';
    const originalError = { status: 400, response: 'Bad Request' };
    const error = new CredentialsClearRequiredError(message, originalError);

    expect(error.name).toBe('CredentialsClearRequiredError');
    expect(error.message).toBe(message);
    expect(error.originalError).toBe(originalError);
    expect(error instanceof Error).toBe(true);
  });

  it('should work without originalError', () => {
    const message = 'Test error message';
    const error = new CredentialsClearRequiredError(message);

    expect(error.name).toBe('CredentialsClearRequiredError');
    expect(error.message).toBe(message);
    expect(error.originalError).toBeUndefined();
  });
});

describe('clearQwenCredentials', () => {
  it('should successfully clear credentials file', async () => {
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
    await expect(clearQwenCredentials()).resolves.not.toThrow();
    expect(fs.unlink).toHaveBeenCalled();
  });

  it('should handle file not found error gracefully', async () => {
    vi.mocked(fs.unlink).mockRejectedValue(
      Object.assign(new Error('File not found'), { code: 'ENOENT' }),
    );
    await expect(clearQwenCredentials()).resolves.not.toThrow();
  });

  it('should handle other file system errors gracefully', async () => {
    vi.mocked(fs.unlink).mockRejectedValue(new Error('Permission denied'));
    // Should not throw but may log warning
    await expect(clearQwenCredentials()).resolves.not.toThrow();
  });
});

describe('QwenOAuth2Client - Additional Error Scenarios', () => {
  const s = useSuite();

  describe('requestDeviceAuthorization HTTP errors', () => {
    it('should handle HTTP error response with non-ok status', async () => {
      respond(httpError(500, 'Internal Server Error', 'Server error occurred'));
      await expect(requestAuth(s.client)).rejects.toThrow(
        'Device authorization failed: 500 Internal Server Error. Response: Server error occurred',
      );
    });
  });
});

describe('getQwenOAuthClient - Enhanced Error Scenarios', () => {
  const s = useSuite();

  it('should handle generic refresh token errors', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify({
        access_token: 'cached-token',
        refresh_token: 'some-refresh-token',
        token_type: 'Bearer',
        expiry_date: Date.now() + 3600000,
      }),
    );
    const restore = stubManager(failingManager('Refresh failed'));
    respond(okJson(INVALID_REQUEST)); // the device flow fails too

    await expect(getQwenOAuthClient(s.config)).rejects.toThrow(
      'Device authorization flow failed',
    );
    restore();
  });

  it('should handle different authentication failure reasons - timeout', async () => {
    // Device authorization succeeds with a very short lifetime; polling times out.
    await expectDeviceFlowFailure(
      s.config,
      'Authorization timeout, please restart the process.',
      okJson(deviceAuth(0.1)),
      okJson({ status: 'pending' }),
    );
  });

  it('should handle authentication failure reason - rate limit', async () => {
    // Device authorization succeeds but polling is rate limited.
    await expectDeviceFlowFailure(
      s.config,
      'Too many requests. The server is rate limiting our requests. Please select a different authentication method or try again later.',
      okJson(deviceAuth()),
      httpError(429, 'Too Many Requests', 'Rate limited'),
    );
  });

  it('should handle authentication failure reason - error', async () => {
    await expectDeviceFlowFailure(
      s.config,
      'Device authorization flow failed',
      okJson(INVALID_REQUEST),
    );
  });
});

describe('authWithQwenDeviceFlow - Comprehensive Testing', () => {
  const s = useSuite({ fakeTimers: true });

  it('should handle device authorization error response', async () => {
    await expectDeviceFlowFailure(
      s.config,
      'Device authorization flow failed',
      okJson({
        error: 'invalid_client',
        error_description: 'Client authentication failed',
      }),
    );
  });

  it('should handle successful authentication flow', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(
      new Error('No cached credentials'),
    );
    respond(okJson(deviceAuth()), okJson(deviceToken()));

    expect(await getQwenOAuthClient(s.config)).toBeInstanceOf(Object);
  });

  it('should handle 401 error during token polling', async () => {
    await expectDeviceFlowFailure(
      s.config,
      'Device code expired or invalid, please restart the authorization process.',
      okJson(deviceAuth()),
      httpError(401, 'Unauthorized', 'Device code expired'),
    );
  });

  it('should handle token polling with browser launch suppressed', async () => {
    s.config.isBrowserLaunchSuppressed = vi.fn().mockReturnValue(true);

    expect(await completeDeviceFlow(s.config)).toBeInstanceOf(Object);
    expect(s.config.isBrowserLaunchSuppressed).toHaveBeenCalled();
    expect(mockOpenBrowserSecurely).not.toHaveBeenCalled();
  });
});

describe('Browser Launch and Error Handling', () => {
  const s = useSuite();

  it('should handle browser launch failure gracefully', async () => {
    mockOpenBrowserSecurely.mockRejectedValue(
      new Error('Browser launch failed'),
    );

    expect(await completeDeviceFlow(s.config)).toBeInstanceOf(Object);
    expect(mockOpenBrowserSecurely).toHaveBeenCalledWith(
      'https://chat.qwen.ai/device?code=TEST123',
    );
  });

  it('should launch the device flow URL through the shared browser helper', async () => {
    expect(await completeDeviceFlow(s.config)).toBeInstanceOf(Object);
    expect(mockOpenBrowserSecurely).toHaveBeenCalledWith(
      'https://chat.qwen.ai/device?code=TEST123',
    );
  });
});

describe('Event Emitter Integration', () => {
  it('should export qwenOAuth2Events as EventEmitter', () => {
    expect(qwenOAuth2Events).toBeInstanceOf(EventEmitter);
  });

  it('should define correct event enum values', () => {
    expect(QwenOAuth2Event.AuthUri).toBe('auth-uri');
    expect(QwenOAuth2Event.AuthProgress).toBe('auth-progress');
    expect(QwenOAuth2Event.AuthCancel).toBe('auth-cancel');
  });
});

describe('Utility Functions', () => {
  describe('objectToUrlEncoded', () => {
    // objectToUrlEncoded is private, so these cases use a local copy of it.
    const objectToUrlEncoded = (data: Record<string, string>): string =>
      Object.keys(data)
        .map(
          (key) =>
            `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`,
        )
        .join('&');

    it('should encode object properties to URL-encoded format', () => {
      const result = objectToUrlEncoded({
        client_id: 'test-client',
        scope: 'openid profile',
        redirect_uri: 'https://example.com/callback',
      });

      expect(result).toContain('client_id=test-client');
      expect(result).toContain('scope=openid%20profile');
      expect(result).toContain(
        'redirect_uri=https%3A%2F%2Fexample.com%2Fcallback',
      );
    });

    it('should handle special characters', () => {
      const result = objectToUrlEncoded({
        'param with spaces': 'value with spaces',
        'param&with&amps': 'value&with&amps',
        'param=with=equals': 'value=with=equals',
      });

      expect(result).toContain('param%20with%20spaces=value%20with%20spaces');
      expect(result).toContain('param%26with%26amps=value%26with%26amps');
      expect(result).toContain('param%3Dwith%3Dequals=value%3Dwith%3Dequals');
    });

    it('should handle empty object', () => {
      expect(objectToUrlEncoded({})).toBe('');
    });
  });

  describe('getQwenCachedCredentialPath', () => {
    it('should return correct path to cached credentials', async () => {
      const os = await import('os');
      const path = await import('path');
      const expectedPath = path.join(os.homedir(), '.qwen', 'oauth_creds.json');

      // The path helper is private, so it is tested through clearQwenCredentials.
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      await clearQwenCredentials();
      expect(fs.unlink).toHaveBeenCalledWith(expectedPath);
    });
  });
});

describe('Credential Caching Functions', () => {
  describe('cacheQwenCredentials', () => {
    it('should create directory and write credentials to file', async () => {
      // Exercised through a refresh on a new client.
      const client = new QwenOAuth2Client();
      client.setCredentials({ refresh_token: 'test-refresh' });
      global.fetch = vi.fn().mockResolvedValue(
        okJsonText({
          access_token: 'new-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );

      await client.refreshAccessToken();

      // File caching now lives in SharedTokenManager, so no file calls happen
      // here; this checks that refreshAccessToken works.
      expect(client.getCredentials().access_token).toBe('new-token');
    });
  });
});

describe('Enhanced Error Handling and Edge Cases', () => {
  const s = useSuite();

  describe('QwenOAuth2Client getAccessToken enhanced scenarios', () => {
    // The client's own token manager fails. Since the race-condition fix there
    // is no fallback to local credentials, even valid ones: SharedTokenManager
    // is the single source of truth.
    it.each<[string, QwenCredentials, string]>([
      [
        'should return undefined when SharedTokenManager fails (no fallback)',
        { access_token: 'fallback-token', expiry_date: Date.now() + 3600000 },
        'Manager failed',
      ],
      [
        'should return undefined when both manager and cache fail',
        { access_token: 'expired-token', expiry_date: Date.now() - 1000 },
        'Manager failed',
      ],
      ['should handle missing credentials gracefully', {}, 'No credentials'],
    ])('%s', async (_title, credentials, message) => {
      s.client.setCredentials(credentials);
      setClientManager(s.client, vi.fn().mockRejectedValue(new Error(message)));
      expect((await s.client.getAccessToken()).token).toBeUndefined();
    });
  });

  describe('Enhanced requestDeviceAuthorization scenarios', () => {
    beforeEach(() => {
      respond(okJson(deviceAuth()));
    });

    it('should include x-request-id header', async () => {
      await requestAuth(s.client);
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
      await requestAuth(s.client);
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
      await requestAuth(s.client, 'test-scope');

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
    const jsonFails = () => ({
      json: vi.fn().mockRejectedValue(new Error('Invalid JSON')),
    });

    it('should handle JSON parsing error during error response', async () => {
      respond({
        ...httpError(400, 'Bad Request', 'Invalid request format'),
        ...jsonFails(),
      } as Response);
      await expect(
        poll(s.client, 'test-device-code', 'test-verifier'),
      ).rejects.toThrow('Device token poll failed: 400 Bad Request');
    });

    it('should include status code in thrown errors', async () => {
      respond({
        ...httpError(500, 'Internal Server Error', 'Internal server error'),
        ...jsonFails(),
      } as Response);
      await expect(
        poll(s.client, 'test-device-code', 'test-verifier'),
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          'Device token poll failed: 500 Internal Server Error',
        ),
        status: 500,
      });
    });

    it('should handle authorization_pending with correct status', async () => {
      respond(
        oauthError(400, 'Bad Request', {
          error: 'authorization_pending',
          error_description: 'Authorization request is pending',
        }),
      );
      expect(await poll(s.client, 'test-device-code', 'test-verifier')).toEqual(
        { status: 'pending' },
      );
    });
  });

  describe('Enhanced refreshAccessToken scenarios', () => {
    // An expired refresh token that the token endpoint rejects with a 400.
    const rejectExpiredRefresh = () => {
      s.client.setCredentials({ refresh_token: 'expired-refresh' });
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      respond({
        ok: false,
        status: 400,
        text: async () => 'Bad Request',
      } as Response);
    };

    it('should call clearQwenCredentials on 400 error', async () => {
      rejectExpiredRefresh();
      await expect(s.client.refreshAccessToken()).rejects.toThrow(
        REFRESH_EXPIRED,
      );
      expect(fs.unlink).toHaveBeenCalled();
    });

    it('should throw CredentialsClearRequiredError on 400 error', async () => {
      rejectExpiredRefresh();
      await expect(s.client.refreshAccessToken()).rejects.toThrow(
        CredentialsClearRequiredError,
      );

      try {
        await s.client.refreshAccessToken();
      } catch (error) {
        expect(error).toBeInstanceOf(CredentialsClearRequiredError);
        if (error instanceof CredentialsClearRequiredError) {
          expect(error.originalError).toEqual({
            status: 400,
            response: 'Bad Request',
          });
        }
      }

      expect(fs.unlink).toHaveBeenCalled();
    });

    it('should preserve existing refresh token when new one not provided', async () => {
      s.client.setCredentials({ refresh_token: 'original-refresh-token' });
      await refreshWith(s.client, refreshed()); // no refresh_token in the response
      expect(s.client.getCredentials().refresh_token).toBe(
        'original-refresh-token',
      );
    });

    it('should include resource_url when provided in response', async () => {
      s.client.setCredentials({ refresh_token: 'test-refresh' });
      await refreshWith(
        s.client,
        refreshed({ resource_url: 'https://new-resource-url.com' }),
      );
      expect(s.client.getCredentials().resource_url).toBe(
        'https://new-resource-url.com',
      );
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
      isInteractive: vi.fn().mockReturnValue(true),
    } as unknown as Config;

    // Test different TokenManagerError types
    for (const [type, message] of [
      [TokenError.NO_REFRESH_TOKEN, 'No refresh token'],
      [TokenError.REFRESH_FAILED, 'Token refresh failed'],
      [TokenError.NETWORK_ERROR, 'Network error'],
      [TokenError.REFRESH_FAILED, 'Refresh failed'],
    ] as const) {
      const restore = stubManager({
        getValidCredentials: vi
          .fn()
          .mockRejectedValue(new TokenManagerError(type, message)),
      });
      vi.mocked(fs.readFile).mockRejectedValue(new Error('No cached file'));
      // Mock device flow to succeed
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(okJson(deviceAuth()))
        .mockResolvedValue(
          okJson({
            access_token: 'new-token',
            refresh_token: 'new-refresh',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        );

      try {
        await getQwenOAuthClient(mockConfig);
      } catch {
        // Expected to fail in test environment
      }

      restore();
      vi.clearAllMocks();
    }
  });
});

describe('Constants and Configuration', () => {
  // Requests device authorization from a new client through a fresh fetch
  // mock (left installed) and returns that fetch call.
  const requestFromNewClient = async (scope: string) => {
    const client = new QwenOAuth2Client();
    global.fetch = vi.fn().mockResolvedValue(okJson(deviceAuth()));
    await requestAuth(client, scope);
    return vi.mocked(global.fetch).mock.calls[0];
  };

  it('should have correct OAuth endpoints', async () => {
    // The endpoint constants show up in the request.
    const [url] = await requestFromNewClient('test-scope');
    expect(url).toBe('https://chat.qwen.ai/api/v1/oauth2/device/code');
  });

  it('should use correct client ID in requests', async () => {
    const [, options] = await requestFromNewClient('test-scope');
    expect(options?.body).toContain(
      'client_id=f0304373b74a44d2b584a3fb70ca9e56',
    );
  });

  it('should use correct default scope', async () => {
    // The default scope constant, as the device flow sends it.
    const [, options] = await requestFromNewClient(SCOPE);
    expect(options?.body).toContain(
      'scope=openid%20profile%20email%20model.completion',
    );
  });
});

describe('showFallbackMessage', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const url = 'https://chat.qwen.ai/authorize?user_code=WDJB-MJHT';

  beforeEach(() => {
    for (const key of HYPERLINK_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of HYPERLINK_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  const capture = (isTTY: boolean) => {
    const chunks: string[] = [];
    const out = {
      isTTY,
      write: (chunk: string) => {
        chunks.push(String(chunk));
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    return { out, text: () => chunks.join('') };
  };

  it('emits the URL as a single OSC 8 hyperlink when the terminal supports it', () => {
    process.env['FORCE_HYPERLINK'] = '1';
    const { out, text } = capture(true);

    showFallbackMessage(url, out);

    const output = text();
    // OSC 8 envelope: ESC ] 8 ; ; <url> BEL <label> ESC ] 8 ; ; BEL
    expect(output).toContain(`\x1b]8;;${url}\x07${url}\x1b]8;;\x07`);
    // The ASCII box is not drawn on the hyperlink path.
    expect(output).not.toContain('+--');
  });

  it('falls back to the ASCII box when hyperlinks are disabled', () => {
    process.env['QWEN_DISABLE_HYPERLINKS'] = '1';
    const { out, text } = capture(true);

    showFallbackMessage(url, out);

    const output = text();
    expect(output).not.toContain('\x1b]8;;');
    expect(output).toContain('Qwen OAuth Device Authorization');
    expect(output).toContain('+'); // box border
  });

  it('falls back to the ASCII box for a non-TTY stream even with FORCE_HYPERLINK', () => {
    process.env['FORCE_HYPERLINK'] = '1';
    const { out, text } = capture(false);

    showFallbackMessage(url, out);

    const output = text();
    expect(output).not.toContain('\x1b]8;;');
    expect(output).toContain('+');
  });
});
