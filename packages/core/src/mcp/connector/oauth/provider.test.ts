/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../../../test-utils/mock-undici-fetch-with-global.js';

// Mock dependencies AT THE TOP
const mockOpenBrowserSecurely = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/secure-browser-launcher.js', () => ({
  openBrowserSecurely: mockOpenBrowserSecurely,
}));
vi.mock('node:crypto');
// Refresh locks belong in the user's config dir; tests must not touch it.
const refreshLock = vi.hoisted(() => ({ busy: false }));
vi.mock('../../oauthFileLock.js', () => ({
  lockMcpOAuthCredential: async () => {
    if (refreshLock.busy) throw new Error('lock busy');
    return { release: async () => {}, assertHeld: () => {} };
  },
}));
vi.mock('../../oauth-token-storage.js', () => {
  const mockSaveToken = vi.fn();
  const mockSaveRefreshedToken = vi.fn();
  const mockGetCredentials = vi.fn();
  const mockIsTokenExpired = vi.fn();
  const mockdeleteCredentials = vi.fn();
  const mockDeleteInvalidToken = vi.fn();

  return {
    MCPOAuthTokenStorage: vi.fn(() => ({
      saveToken: mockSaveToken,
      saveRefreshedToken: mockSaveRefreshedToken,
      getCredentials: mockGetCredentials,
      isTokenExpired: mockIsTokenExpired,
      deleteCredentials: mockdeleteCredentials,
      deleteInvalidToken: mockDeleteInvalidToken,
      credentialKey: (serverName: string) => serverName,
    })),
  };
});
vi.mock('../../../utils/events.js', () => ({
  coreEvents: {
    emitFeedback: vi.fn(),
    emitConsoleLog: vi.fn(),
  },
}));
vi.mock('../../../utils/authConsent.js', () => ({
  getConsentForOauth: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../../../utils/headless.js', () => ({
  isHeadlessMode: vi.fn(() => false),
}));
vi.mock('node:readline', () => ({
  default: {
    createInterface: vi.fn(() => ({
      question: vi.fn((_query, callback) => callback('')),
      close: vi.fn(),
      on: vi.fn(),
    })),
  },
  createInterface: vi.fn(() => ({
    question: vi.fn((_query, callback) => callback('')),
    close: vi.fn(),
    on: vi.fn(),
  })),
}));

const mockSdkDiscoverPRM = vi.hoisted(() => vi.fn());
const mockSdkDiscoverAS = vi.hoisted(() => vi.fn());
vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  discoverOAuthProtectedResourceMetadata: mockSdkDiscoverPRM,
  discoverAuthorizationServerMetadata: mockSdkDiscoverAS,
}));
vi.mock('@modelcontextprotocol/sdk/shared/auth-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/sdk/shared/auth-utils.js')>();
  return {
    checkResourceAllowed: actual.checkResourceAllowed,
    resourceUrlFromServerUrl: actual.resourceUrlFromServerUrl,
  };
});

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import {
  MCPOAuthProvider,
  type MCPOAuthConfig,
  type OAuthTokenResponse,
  type OAuthClientRegistrationResponse,
} from './provider.js';
import { getConsentForOauth } from '../../../utils/authConsent.js';
import type { OAuthToken } from '../../token-storage/types.js';
import { MCPOAuthTokenStorage } from '../../oauth-token-storage.js';
import {
  OAuthUtils,
  type OAuthAuthorizationServerMetadata,
  type OAuthProtectedResourceMetadata,
} from './utils.js';
import { coreEvents } from '../../../utils/events.js';
import { FatalCancellationError } from '../../../utils/errors.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Helper function to create mock fetch responses with proper headers
const createMockResponse = (options: {
  ok: boolean;
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
  text?: string | (() => Promise<string>);
  json?: unknown | (() => Promise<unknown>);
}) => {
  const response: {
    ok: boolean;
    status?: number;
    headers: Headers;
    text?: () => Promise<string>;
    json?: () => Promise<unknown>;
  } = {
    ok: options.ok,
    headers: new Headers({
      ...(options.contentType ? { 'content-type': options.contentType } : {}),
      ...options.headers,
    }),
  };

  if (options.status !== undefined) {
    response.status = options.status;
  }

  if (options.text !== undefined) {
    response.text =
      typeof options.text === 'string'
        ? () => Promise.resolve(options.text as string)
        : (options.text as () => Promise<string>);
  }

  if (options.json !== undefined) {
    response.json =
      typeof options.json === 'function'
        ? (options.json as () => Promise<unknown>)
        : () => Promise.resolve(options.json);
  }

  return response;
};

// Define a reusable mock server with .listen, .close, .on, and .address methods
const mockHttpServer = {
  listen: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  address: vi.fn(() => ({ address: 'localhost', family: 'IPv4', port: 7777 })),
};
vi.mock('node:http', () => ({
  createServer: vi.fn(() => mockHttpServer),
}));

describe('MCPOAuthProvider', () => {
  const mockConfig: MCPOAuthConfig = {
    enabled: true,
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    authorizationUrl: 'https://auth.example.com/authorize',
    issuer: 'https://auth.example.com',
    tokenUrl: 'https://auth.example.com/token',
    scopes: ['read', 'write'],
    redirectUri: 'http://localhost:7777/oauth/callback',
    audiences: ['https://api.example.com'],
  };

  const mockToken: OAuthToken = {
    accessToken: 'access_token_123',
    refreshToken: 'refresh_token_456',
    tokenType: 'Bearer',
    scope: 'read write',
    expiresAt: Date.now() + 3600000,
  };

  const mockTokenResponse: OAuthTokenResponse = {
    access_token: 'access_token_123',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'refresh_token_456',
    scope: 'read write',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenBrowserSecurely.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Default SDK mocks: no PRM available, no AS metadata
    mockSdkDiscoverPRM.mockRejectedValue(new Error('No PRM'));
    mockSdkDiscoverAS.mockResolvedValue(undefined);

    // Mock crypto functions
    vi.mocked(crypto.randomBytes).mockImplementation((size: number) => {
      if (size === 32) return Buffer.from('code_verifier_mock_32_bytes_long');
      if (size === 16) return Buffer.from('state_mock_16_by');
      return Buffer.alloc(size);
    });

    vi.mocked(crypto.createHash).mockReturnValue({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn().mockReturnValue('code_challenge_mock'),
    } as unknown as crypto.Hash);

    // Mock randomBytes to return predictable values for state
    vi.mocked(crypto.randomBytes).mockImplementation((size) => {
      if (size === 32) {
        return Buffer.from('mock_code_verifier_32_bytes_long_string');
      } else if (size === 16) {
        return Buffer.from('mock_state_16_bytes');
      }
      return Buffer.alloc(size);
    });

    // Mock token storage
    const tokenStorage = new MCPOAuthTokenStorage();
    vi.mocked(tokenStorage.saveToken).mockResolvedValue(undefined);
    vi.mocked(tokenStorage.saveRefreshedToken).mockResolvedValue(true);
    vi.mocked(tokenStorage.getCredentials).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('authenticate', () => {
    it('should perform complete OAuth flow with PKCE', async () => {
      // Mock HTTP server callback
      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        // Simulate OAuth callback
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code_123&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      // Mock token exchange
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const authProvider = new MCPOAuthProvider();
      const result = await authProvider.authenticate('test-server', mockConfig);

      expect(result).toEqual({
        accessToken: 'access_token_123',
        refreshToken: 'refresh_token_456',
        tokenType: 'Bearer',
        scope: 'read write',
        expiresAt: expect.any(Number),
      });

      expect(mockOpenBrowserSecurely).toHaveBeenCalledWith(
        expect.stringContaining('authorize'),
      );
      const tokenStorage = new MCPOAuthTokenStorage();
      expect(tokenStorage.saveToken).toHaveBeenCalledWith(
        'test-server',
        expect.objectContaining({ accessToken: 'access_token_123' }),
        'test-client-id',
        'https://auth.example.com/token',
        undefined,
        undefined,
      );
    });

    it('should handle OAuth discovery when no authorization URL provided', async () => {
      // Use a mutable config object
      const configWithoutAuth: MCPOAuthConfig = {
        ...mockConfig,
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      };
      delete configWithoutAuth.authorizationUrl;
      delete configWithoutAuth.tokenUrl;

      const mockResourceMetadata = {
        resource: 'https://api.example.com/',
        authorization_servers: ['https://discovered.auth.com'],
      };

      const mockAuthServerMetadata = {
        issuer: 'https://discovered.auth.com',
        authorization_endpoint: 'https://discovered.auth.com/authorize',
        token_endpoint: 'https://discovered.auth.com/token',
        response_types_supported: ['code'],
        scopes_supported: ['read', 'write'],
      };

      // Mock HEAD request for WWW-Authenticate check (returns 200, no header)
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          status: 200,
        }),
      );

      // SDK mocks for discoverOAuthConfig fallback
      mockSdkDiscoverPRM.mockResolvedValueOnce(mockResourceMetadata);
      mockSdkDiscoverAS.mockResolvedValueOnce(mockAuthServerMetadata);

      // Setup callback handler
      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code_123&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      // Mock token exchange with discovered endpoint
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const authProvider = new MCPOAuthProvider();
      const result = await authProvider.authenticate(
        'test-server',
        configWithoutAuth,
        'https://api.example.com',
      );

      expect(result).toBeDefined();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://discovered.auth.com/token',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/x-www-form-urlencoded',
          }),
        }),
      );
    });

    it('should perform dynamic client registration when no client ID is provided but registration URL is provided', async () => {
      const configWithoutClient: MCPOAuthConfig = {
        ...mockConfig,
        registrationUrl: 'https://auth.example.com/register',
      };
      delete configWithoutClient.clientId;

      const mockRegistrationResponse: OAuthClientRegistrationResponse = {
        client_id: 'dynamic_client_id',
        client_secret: 'dynamic_client_secret',
        redirect_uris: ['http://localhost:7777/oauth/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockRegistrationResponse),
          json: mockRegistrationResponse,
        }),
      );

      // Setup callback handler
      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code_123&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      // Mock token exchange
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const authProvider = new MCPOAuthProvider();
      const result = await authProvider.authenticate(
        'test-server',
        configWithoutClient,
      );

      expect(result).toBeDefined();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://auth.example.com/register',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    it('should perform OAuth discovery and dynamic client registration when no client ID or registration URL provided', async () => {
      const configWithoutClient: MCPOAuthConfig = { ...mockConfig };
      delete configWithoutClient.clientId;

      const mockRegistrationResponse: OAuthClientRegistrationResponse = {
        client_id: 'dynamic_client_id',
        client_secret: 'dynamic_client_secret',
        redirect_uris: ['http://localhost:7777/oauth/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };

      const mockAuthServerMetadata: OAuthAuthorizationServerMetadata = {
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        registration_endpoint: 'https://auth.example.com/register',
      };

      // SDK mock for AS metadata discovery (used by discoverAuthServerMetadataForRegistration)
      mockSdkDiscoverAS.mockResolvedValueOnce({
        ...mockAuthServerMetadata,
        response_types_supported: ['code'],
      });

      mockFetch
        .mockResolvedValueOnce(
          createMockResponse({
            ok: true,
            contentType: 'application/json',
            text: JSON.stringify(mockRegistrationResponse),
            json: mockRegistrationResponse,
          }),
        );

      // Setup callback handler
      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code_123&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      // Mock token exchange
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const authProvider = new MCPOAuthProvider();
      const result = await authProvider.authenticate(
        'test-server',
        configWithoutClient,
      );

      expect(result).toBeDefined();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://auth.example.com/register',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    it('should perform OAuth discovery once and dynamic client registration when no client ID, authorization URL or registration URL provided', async () => {
      const configWithoutClientAndAuthorizationUrl: MCPOAuthConfig = {
        ...mockConfig,
      };
      delete configWithoutClientAndAuthorizationUrl.clientId;
      delete configWithoutClientAndAuthorizationUrl.authorizationUrl;

      const mockResourceMetadata: OAuthProtectedResourceMetadata = {
        resource: 'https://api.example.com/',
        authorization_servers: ['https://auth.example.com'],
      };

      const mockAuthServerMetadata: OAuthAuthorizationServerMetadata = {
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        registration_endpoint: 'https://auth.example.com/register',
      };

      const mockRegistrationResponse: OAuthClientRegistrationResponse = {
        client_id: 'dynamic_client_id',
        client_secret: 'dynamic_client_secret',
        redirect_uris: ['http://localhost:7777/oauth/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };

      mockFetch
        .mockResolvedValueOnce(
          createMockResponse({
            ok: true,
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          createMockResponse({
            ok: true,
            contentType: 'application/json',
            text: JSON.stringify(mockRegistrationResponse),
            json: mockRegistrationResponse,
          }),
        );

      // SDK mocks for discovery
      mockSdkDiscoverPRM.mockResolvedValueOnce(mockResourceMetadata);
      mockSdkDiscoverAS.mockResolvedValue({
        ...mockAuthServerMetadata,
        response_types_supported: ['code'],
      });

      // Setup callback handler
      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code_123&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      // Mock token exchange
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const authProvider = new MCPOAuthProvider();
      const result = await authProvider.authenticate(
        'test-server',
        configWithoutClientAndAuthorizationUrl,
        'https://api.example.com',
      );

      expect(result).toBeDefined();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://auth.example.com/register',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    it('should throw error when issuer is missing and dynamic registration is needed', async () => {
      const configWithoutIssuer: MCPOAuthConfig = {
        enabled: mockConfig.enabled,
        authorizationUrl: mockConfig.authorizationUrl,
        tokenUrl: mockConfig.tokenUrl,
        scopes: mockConfig.scopes,
        redirectUri: mockConfig.redirectUri,
        audiences: mockConfig.audiences,
      };

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
      });

      const authProvider = new MCPOAuthProvider();

      await expect(
        authProvider.authenticate('test-server', configWithoutIssuer),
      ).rejects.toThrow('Cannot perform dynamic registration without issuer');
    });

    it('should handle OAuth callback errors', async () => {
      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?error=access_denied&error_description=User%20denied%20access',
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      const authProvider = new MCPOAuthProvider();
      await expect(
        authProvider.authenticate('test-server', mockConfig),
      ).rejects.toThrow('OAuth error: access_denied');
    });

    it('should handle state mismatch in callback', async () => {
      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code_123&state=wrong_state',
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      const authProvider = new MCPOAuthProvider();
      await expect(
        authProvider.authenticate('test-server', mockConfig),
      ).rejects.toThrow('State mismatch - possible CSRF attack');
    });

    it('should handle token exchange failure', async () => {
      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code_123&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: false,
          status: 400,
          contentType: 'application/x-www-form-urlencoded',
          text: 'error=invalid_grant&error_description=Invalid grant',
        }),
      );

      const authProvider = new MCPOAuthProvider();
      await expect(
        authProvider.authenticate('test-server', mockConfig),
      ).rejects.toThrow('Token exchange failed: invalid_grant - Invalid grant');
    });

    it('should handle OAuth discovery failure', async () => {
      const configWithoutAuth: MCPOAuthConfig = { ...mockConfig };
      delete configWithoutAuth.authorizationUrl;
      delete configWithoutAuth.tokenUrl;

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: false,
          status: 404,
        }),
      );

      const authProvider = new MCPOAuthProvider();
      await expect(
        authProvider.authenticate(
          'test-server',
          configWithoutAuth,
          'https://api.example.com',
        ),
      ).rejects.toThrow(
        'Failed to discover OAuth configuration from MCP server',
      );
    });

    it('should handle authorization server metadata discovery failure', async () => {
      const configWithoutClient: MCPOAuthConfig = { ...mockConfig };
      delete configWithoutClient.clientId;

      mockFetch.mockResolvedValue(
        createMockResponse({
          ok: false,
          status: 404,
        }),
      );

      // Prevent callback server from hanging the test
      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
      });

      const authProvider = new MCPOAuthProvider();
      await expect(
        authProvider.authenticate('test-server', configWithoutClient),
      ).rejects.toThrow(
        'Failed to fetch authorization server metadata for client registration',
      );
    });

    it('should handle invalid callback request', async () => {
      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/invalid-path',
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 0);
      });

      const authProvider = new MCPOAuthProvider();
      // The test will timeout if the server does not handle the invalid request correctly.
      // We are testing that the server does not hang.
      await Promise.race([
        authProvider.authenticate('test-server', mockConfig),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    });

    it('should handle token exchange failure with non-json response', async () => {
      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code_123&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: false,
          status: 500,
          contentType: 'text/html',
          text: 'Internal Server Error',
        }),
      );

      const authProvider = new MCPOAuthProvider();
      await expect(
        authProvider.authenticate('test-server', mockConfig),
      ).rejects.toThrow('Token exchange failed: 500 - Internal Server Error');
    });

    it('should handle token exchange with unexpected content type', async () => {
      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code_123&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'text/plain',
          text: 'access_token=plain_text_token',
        }),
      );

      const authProvider = new MCPOAuthProvider();
      const result = await authProvider.authenticate('test-server', mockConfig);
      expect(result.accessToken).toBe('plain_text_token');
    });

    it('should handle refresh token failure with non-json response', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: false,
          status: 500,
          contentType: 'text/html',
          text: 'Internal Server Error',
        }),
      );

      const authProvider = new MCPOAuthProvider();
      await expect(
        authProvider.refreshAccessToken(
          mockConfig,
          'invalid_refresh_token',
          'https://auth.example.com/token',
        ),
      ).rejects.toThrow('Token refresh failed: 500 - Internal Server Error');
    });

    it('should handle refresh token with unexpected content type', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'text/plain',
          text: 'access_token=plain_text_token',
        }),
      );

      const authProvider = new MCPOAuthProvider();
      const result = await authProvider.refreshAccessToken(
        mockConfig,
        'refresh_token',
        'https://auth.example.com/token',
      );
      expect(result.access_token).toBe('plain_text_token');
    });

    it('should continue authentication when browser fails to open', async () => {
      mockOpenBrowserSecurely.mockRejectedValue(new Error('Browser not found'));

      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code_123&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const authProvider = new MCPOAuthProvider();
      const result = await authProvider.authenticate('test-server', mockConfig);
      expect(result).toBeDefined();
    });

    it('should return null when token is expired and no refresh token is available', async () => {
      const expiredCredentials = {
        serverName: 'test-server',
        token: {
          ...mockToken,
          refreshToken: undefined,
          expiresAt: Date.now() - 3600000,
        },
        clientId: 'test-client-id',
        tokenUrl: 'https://auth.example.com/token',
        updatedAt: Date.now(),
      };

      const tokenStorage = new MCPOAuthTokenStorage();
      vi.mocked(tokenStorage.getCredentials).mockResolvedValue(
        expiredCredentials,
      );
      vi.mocked(tokenStorage.isTokenExpired).mockReturnValue(true);

      const authProvider = new MCPOAuthProvider();
      const result = await authProvider.getValidToken(
        'test-server',
        mockConfig,
      );

      expect(result).toBeNull();
    });

    it('should handle callback timeout', async () => {
      vi.mocked(http.createServer).mockImplementation(
        () => mockHttpServer as unknown as http.Server,
      );

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        // Don't trigger callback - simulate timeout
      });

      // Mock setTimeout to trigger timeout immediately
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = vi.fn((callback, delay) => {
        if (delay === 5 * 60 * 1000) {
          // 5 minute timeout
          callback();
        }
        return originalSetTimeout(callback, 0);
      }) as unknown as typeof setTimeout;

      const authProvider = new MCPOAuthProvider();
      await expect(
        authProvider.authenticate('test-server', mockConfig),
      ).rejects.toThrow('OAuth callback timeout');

      global.setTimeout = originalSetTimeout;
    });

    it('should use port from redirectUri if provided', async () => {
      const configWithPort: MCPOAuthConfig = {
        ...mockConfig,
        redirectUri: 'http://localhost:12345/oauth/callback',
      };

      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code_123&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });
      mockHttpServer.address.mockReturnValue({
        port: 12345,
        address: '127.0.0.1',
        family: 'IPv4',
      });

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const authProvider = new MCPOAuthProvider();
      await authProvider.authenticate('test-server', configWithPort);

      expect(mockHttpServer.listen).toHaveBeenCalledWith(
        12345,
        expect.any(Function),
      );
    });

    it('should ignore invalid ports in redirectUri', async () => {
      const configWithInvalidPort: MCPOAuthConfig = {
        ...mockConfig,
        redirectUri: 'http://localhost:invalid/oauth/callback',
      };

      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code_123&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const authProvider = new MCPOAuthProvider();
      await authProvider.authenticate('test-server', configWithInvalidPort);

      // Should be called with 0 (OS assigned) because the port was invalid
      expect(mockHttpServer.listen).toHaveBeenCalledWith(
        0,
        expect.any(Function),
      );
    });

    it('should not default to privileged ports when redirectUri has no port', async () => {
      const configNoPort: MCPOAuthConfig = {
        ...mockConfig,
        redirectUri: 'http://localhost/oauth/callback',
      };

      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code_123&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const authProvider = new MCPOAuthProvider();
      await authProvider.authenticate('test-server', configNoPort);

      // Should be called with 0 (OS assigned), not 80
      expect(mockHttpServer.listen).toHaveBeenCalledWith(
        0,
        expect.any(Function),
      );
    });
    it('should include server name in the authentication message', async () => {
      // Mock HTTP server callback
      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        // Simulate OAuth callback
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code_123&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      // Mock token exchange
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const authProvider = new MCPOAuthProvider();

      await authProvider.authenticate(
        'production-server',
        mockConfig,
        undefined,
      );

      expect(getConsentForOauth).toHaveBeenCalledWith(
        expect.stringContaining('production-server'),
      );
    });

    it('should call openBrowserSecurely when consent is granted', async () => {
      vi.mocked(getConsentForOauth).mockResolvedValue(true);

      vi.mocked(http.createServer).mockImplementation((handler) => {
        setTimeout(() => {
          const req = {
            url: '/oauth/callback?code=code&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          } as http.IncomingMessage;
          const res = {
            writeHead: vi.fn(),
            end: vi.fn(),
          } as unknown as http.ServerResponse;
          (handler as http.RequestListener)(req, res);
        }, 0);
        return mockHttpServer as unknown as http.Server;
      });
      mockHttpServer.listen.mockImplementation((_port, callback) =>
        callback?.(),
      );
      mockFetch.mockResolvedValue(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const authProvider = new MCPOAuthProvider();
      await authProvider.authenticate('test-server', mockConfig);

      expect(mockOpenBrowserSecurely).toHaveBeenCalled();
    });

    it('uses setMcpOAuthBrowserOpener when registered', async () => {
      vi.mocked(getConsentForOauth).mockResolvedValue(true);

      vi.mocked(http.createServer).mockImplementation((handler) => {
        setTimeout(() => {
          const req = {
            url: '/oauth/callback?code=code&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          } as http.IncomingMessage;
          const res = {
            writeHead: vi.fn(),
            end: vi.fn(),
          } as unknown as http.ServerResponse;
          (handler as http.RequestListener)(req, res);
        }, 0);
        return mockHttpServer as unknown as http.Server;
      });
      mockHttpServer.listen.mockImplementation((_port, callback) =>
        callback?.(),
      );
      mockFetch.mockResolvedValue(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const opener = vi.fn().mockResolvedValue(undefined);
      const { setMcpOAuthBrowserOpener } = await import('./provider.js');
      setMcpOAuthBrowserOpener(opener);

      try {
        const authProvider = new MCPOAuthProvider();
        await authProvider.authenticate('test-server', mockConfig);

        // Custom opener gets the auth URL and server-scoped metadata.
        expect(opener).toHaveBeenCalledTimes(1);
        const [url, meta] = opener.mock.calls[0];
        expect(typeof url).toBe('string');
        expect(url).toMatch(/^https?:\/\//);
        expect(meta).toMatchObject({ serverName: 'test-server' });

        // Default browser launcher must NOT be called when the opener
        // succeeds — the host is driving the user-agent step.
        expect(mockOpenBrowserSecurely).not.toHaveBeenCalled();
      } finally {
        setMcpOAuthBrowserOpener(null);
      }
    });

    it('short-circuits callback server when opener returns { code, state }', async () => {
      vi.mocked(getConsentForOauth).mockResolvedValue(true);

      // The http.createServer mock simulates an incoming callback; here we
      // want to prove it is NOT what advances the flow. Arrange the mock so
      // the fake request only fires if something awaits — and still expect
      // the authenticate() call to complete via the opener-returned code.
      let callbackHandlerInvoked = false;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        setTimeout(() => {
          callbackHandlerInvoked = true;
          const req = {
            url: '/oauth/callback?code=SHOULD_NOT_BE_USED&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          } as http.IncomingMessage;
          const res = {
            writeHead: vi.fn(),
            end: vi.fn(),
          } as unknown as http.ServerResponse;
          (handler as http.RequestListener)(req, res);
        }, 50);
        return mockHttpServer as unknown as http.Server;
      });
      mockHttpServer.listen.mockImplementation((_port, callback) =>
        callback?.(),
      );
      mockFetch.mockResolvedValue(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const opener = vi.fn().mockResolvedValue({
        code: 'pasted-code-xyz',
        state: 'bW9ja19zdGF0ZV8xNl9ieXRlcw',
      });
      const { setMcpOAuthBrowserOpener } = await import('./provider.js');
      setMcpOAuthBrowserOpener(opener);

      try {
        const authProvider = new MCPOAuthProvider();
        await authProvider.authenticate('test-server', mockConfig);

        expect(opener).toHaveBeenCalledTimes(1);
        expect(mockOpenBrowserSecurely).not.toHaveBeenCalled();

        // Token exchange ran with the opener-provided code, NOT the one
        // the mock callback server would have produced.
        const fetchBody = mockFetch.mock.calls[0][1]?.body as string;
        expect(fetchBody).toContain('code=pasted-code-xyz');
        expect(fetchBody).not.toContain('SHOULD_NOT_BE_USED');

        // The server mock never got a chance to complete the flow, because
        // we closed it before its setTimeout fired — still fine if it did.
        void callbackHandlerInvoked;
      } finally {
        setMcpOAuthBrowserOpener(null);
      }
    });

    it('parses { callbackUrl } from opener and runs token exchange', async () => {
      vi.mocked(getConsentForOauth).mockResolvedValue(true);

      vi.mocked(http.createServer).mockImplementation(
        () => mockHttpServer as unknown as http.Server,
      );
      mockHttpServer.listen.mockImplementation((_port, callback) =>
        callback?.(),
      );
      mockFetch.mockResolvedValue(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const opener = vi.fn().mockResolvedValue({
        callbackUrl:
          'http://localhost:12345/oauth/callback?code=url-code&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
      });
      const { setMcpOAuthBrowserOpener } = await import('./provider.js');
      setMcpOAuthBrowserOpener(opener);

      try {
        const authProvider = new MCPOAuthProvider();
        await authProvider.authenticate('test-server', mockConfig);

        const fetchBody = mockFetch.mock.calls[0][1]?.body as string;
        expect(fetchBody).toContain('code=url-code');
      } finally {
        setMcpOAuthBrowserOpener(null);
      }
    });

    it('rejects opener callbackUrl with mismatched state', async () => {
      vi.mocked(getConsentForOauth).mockResolvedValue(true);

      vi.mocked(http.createServer).mockImplementation(
        () => mockHttpServer as unknown as http.Server,
      );
      mockHttpServer.listen.mockImplementation((_port, callback) =>
        callback?.(),
      );

      const opener = vi.fn().mockResolvedValue({
        callbackUrl:
          'http://localhost:12345/oauth/callback?code=c&state=WRONG_STATE',
      });
      const { setMcpOAuthBrowserOpener } = await import('./provider.js');
      setMcpOAuthBrowserOpener(opener);

      try {
        const authProvider = new MCPOAuthProvider();
        await expect(
          authProvider.authenticate('test-server', mockConfig),
        ).rejects.toThrow(/state mismatch/i);
        // Token exchange never happens on a state mismatch.
        expect(mockFetch).not.toHaveBeenCalled();
      } finally {
        setMcpOAuthBrowserOpener(null);
      }
    });

    it('saves token directly and skips exchange when opener returns { token }', async () => {
      vi.mocked(getConsentForOauth).mockResolvedValue(true);

      vi.mocked(http.createServer).mockImplementation(
        () => mockHttpServer as unknown as http.Server,
      );
      mockHttpServer.listen.mockImplementation((_port, callback) =>
        callback?.(),
      );

      const opener = vi.fn().mockResolvedValue({
        token: {
          accessToken: 'opener-provided-token',
          refreshToken: 'opener-refresh',
          tokenType: 'Bearer',
          expiresAt: 1900000000,
        },
      });
      const { setMcpOAuthBrowserOpener } = await import('./provider.js');
      setMcpOAuthBrowserOpener(opener);

      try {
        const tokenStorage = new MCPOAuthTokenStorage();
        const authProvider = new MCPOAuthProvider(tokenStorage);
        const returnedToken = await authProvider.authenticate(
          'test-server',
          mockConfig,
        );

        // Opener-provided token came back verbatim.
        expect(returnedToken.accessToken).toBe('opener-provided-token');

        // No token exchange happened — we skipped that entire path.
        expect(mockFetch).not.toHaveBeenCalled();

        // Token went to storage for future getValidToken() reads.
        expect(tokenStorage.saveToken).toHaveBeenCalledWith(
          'test-server',
          expect.objectContaining({ accessToken: 'opener-provided-token' }),
          expect.any(String),
          expect.any(String),
          undefined,
          undefined,
        );
      } finally {
        setMcpOAuthBrowserOpener(null);
      }
    });

    it('saves the resource the authorization used, so refresh reuses it', async () => {
      vi.mocked(getConsentForOauth).mockResolvedValue(true);

      vi.mocked(http.createServer).mockImplementation(
        () => mockHttpServer as unknown as http.Server,
      );
      mockHttpServer.listen.mockImplementation((_port, callback) =>
        callback?.(),
      );

      const opener = vi.fn().mockResolvedValue({
        token: { accessToken: 'opener-token', tokenType: 'Bearer' },
      });
      const { setMcpOAuthBrowserOpener } = await import('./provider.js');
      setMcpOAuthBrowserOpener(opener);

      try {
        const tokenStorage = new MCPOAuthTokenStorage();
        await new MCPOAuthProvider(tokenStorage).authenticate(
          'test-server',
          mockConfig,
          'https://api.example.com/mcp/',
        );

        // Refresh must reuse the resource spelling sent during authorization.
        expect(tokenStorage.saveToken).toHaveBeenCalledWith(
          'test-server',
          expect.objectContaining({ accessToken: 'opener-token' }),
          'test-client-id',
          'https://auth.example.com/token',
          'https://api.example.com/mcp/',
          'https://api.example.com/mcp/',
        );
      } finally {
        setMcpOAuthBrowserOpener(null);
      }
    });

    it('falls back to openBrowserSecurely when custom opener throws', async () => {
      vi.mocked(getConsentForOauth).mockResolvedValue(true);

      vi.mocked(http.createServer).mockImplementation((handler) => {
        setTimeout(() => {
          const req = {
            url: '/oauth/callback?code=code&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          } as http.IncomingMessage;
          const res = {
            writeHead: vi.fn(),
            end: vi.fn(),
          } as unknown as http.ServerResponse;
          (handler as http.RequestListener)(req, res);
        }, 0);
        return mockHttpServer as unknown as http.Server;
      });
      mockHttpServer.listen.mockImplementation((_port, callback) =>
        callback?.(),
      );
      mockFetch.mockResolvedValue(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const opener = vi
        .fn()
        .mockRejectedValue(new Error('host declined browser open'));
      const { setMcpOAuthBrowserOpener } = await import('./provider.js');
      setMcpOAuthBrowserOpener(opener);

      try {
        const authProvider = new MCPOAuthProvider();
        await authProvider.authenticate('test-server', mockConfig);

        expect(opener).toHaveBeenCalledTimes(1);
        // Fallback kicks in when the host opener fails.
        expect(mockOpenBrowserSecurely).toHaveBeenCalled();
      } finally {
        setMcpOAuthBrowserOpener(null);
      }
    });

    it('should throw FatalCancellationError when consent is denied', async () => {
      vi.mocked(getConsentForOauth).mockResolvedValue(false);
      mockHttpServer.listen.mockImplementation((_port, callback) =>
        callback?.(),
      );

      // Use fake timers to avoid hanging from the 5-minute timeout in startCallbackServer
      vi.useFakeTimers();

      const authProvider = new MCPOAuthProvider();
      await expect(
        authProvider.authenticate('test-server', mockConfig),
      ).rejects.toThrow(FatalCancellationError);

      expect(mockOpenBrowserSecurely).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('refresh lock', () => {
    it('keeps the stored credentials when a refreshed token cannot be saved', async () => {
      const tokenStorage = new MCPOAuthTokenStorage();
      vi.mocked(tokenStorage.getCredentials).mockResolvedValue({
        serverName: 'test-server',
        token: { ...mockToken, expiresAt: Date.now() - 1000 },
        clientId: 'test-client-id',
        tokenUrl: 'https://auth.example.com/token',
        updatedAt: Date.now(),
      });
      vi.mocked(tokenStorage.isTokenExpired).mockReturnValue(true);
      vi.mocked(tokenStorage.saveRefreshedToken).mockRejectedValueOnce(
        new Error('lock busy'),
      );
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify({ ...mockTokenResponse, access_token: 'refreshed' }),
          json: { ...mockTokenResponse, access_token: 'refreshed' },
        }),
      );

      await expect(
        new MCPOAuthProvider().getValidToken('test-server', mockConfig),
      ).resolves.toBe('refreshed');
      expect(tokenStorage.deleteCredentials).not.toHaveBeenCalled();
    });

    it('leaves the stored token alone when another process holds the refresh lock', async () => {
      const tokenStorage = new MCPOAuthTokenStorage();
      vi.mocked(tokenStorage.getCredentials).mockResolvedValue({
        serverName: 'test-server',
        token: { ...mockToken, expiresAt: Date.now() - 1000 },
        clientId: 'test-client-id',
        tokenUrl: 'https://auth.example.com/token',
        updatedAt: Date.now(),
      });
      vi.mocked(tokenStorage.isTokenExpired).mockReturnValue(true);
      refreshLock.busy = true;
      try {
        await expect(
          new MCPOAuthProvider().getValidToken('test-server', mockConfig),
        ).resolves.toBeNull();
      } finally {
        refreshLock.busy = false;
      }

      expect(tokenStorage.deleteCredentials).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('refreshAccessToken', () => {
    it('should refresh token successfully', async () => {
      const refreshResponse = {
        access_token: 'new_access_token',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'new_refresh_token',
      };

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(refreshResponse),
          json: refreshResponse,
        }),
      );

      const authProvider = new MCPOAuthProvider();
      const result = await authProvider.refreshAccessToken(
        mockConfig,
        'old_refresh_token',
        'https://auth.example.com/token',
      );

      expect(result).toEqual(refreshResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://auth.example.com/token',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json, application/x-www-form-urlencoded',
          },
          body: expect.stringContaining('grant_type=refresh_token'),
        }),
      );
    });

    it('should include client secret in refresh request when available', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const authProvider = new MCPOAuthProvider();
      await authProvider.refreshAccessToken(
        mockConfig,
        'refresh_token',
        'https://auth.example.com/token',
      );

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[1].body).toContain('client_secret=test-client-secret');
    });

    it('should handle refresh token failure', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: false,
          status: 400,
          contentType: 'application/x-www-form-urlencoded',
          text: 'error=invalid_request&error_description=Invalid refresh token',
        }),
      );

      const authProvider = new MCPOAuthProvider();
      await expect(
        authProvider.refreshAccessToken(
          mockConfig,
          'invalid_refresh_token',
          'https://auth.example.com/token',
        ),
      ).rejects.toThrow(
        'Token refresh failed: invalid_request - Invalid refresh token',
      );
    });
  });

  describe('getValidToken', () => {
    it('should return valid token when not expired', async () => {
      const validCredentials = {
        serverName: 'test-server',
        token: mockToken,
        clientId: 'test-client-id',
        tokenUrl: 'https://auth.example.com/token',
        updatedAt: Date.now(),
      };

      const tokenStorage = new MCPOAuthTokenStorage();
      vi.mocked(tokenStorage.getCredentials).mockResolvedValue(
        validCredentials,
      );
      vi.mocked(tokenStorage.isTokenExpired).mockReturnValue(false);

      const authProvider = new MCPOAuthProvider();
      const result = await authProvider.getValidToken(
        'test-server',
        mockConfig,
      );

      expect(result).toBe('access_token_123');
    });

    it('should refresh expired token and return new token', async () => {
      const expiredCredentials = {
        serverName: 'test-server',
        token: { ...mockToken, expiresAt: Date.now() - 3600000 },
        clientId: 'test-client-id',
        tokenUrl: 'https://auth.example.com/token',
        updatedAt: Date.now(),
      };

      const tokenStorage = new MCPOAuthTokenStorage();
      vi.mocked(tokenStorage.getCredentials).mockResolvedValue(
        expiredCredentials,
      );
      vi.mocked(tokenStorage.isTokenExpired).mockReturnValue(true);

      const refreshResponse = {
        access_token: 'new_access_token',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'new_refresh_token',
      };

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(refreshResponse),
          json: refreshResponse,
        }),
      );

      const authProvider = new MCPOAuthProvider();
      const result = await authProvider.getValidToken(
        'test-server',
        mockConfig,
      );

      expect(result).toBe('new_access_token');
      expect(tokenStorage.saveRefreshedToken).toHaveBeenCalledWith(
        'test-server',
        expiredCredentials.token,
        expect.objectContaining({ accessToken: 'new_access_token' }),
        'test-client-id',
        'https://auth.example.com/token',
        undefined,
        undefined,
      );
    });

    it('should return null when no credentials exist', async () => {
      const tokenStorage = new MCPOAuthTokenStorage();
      vi.mocked(tokenStorage.getCredentials).mockResolvedValue(null);

      const authProvider = new MCPOAuthProvider();
      const result = await authProvider.getValidToken(
        'test-server',
        mockConfig,
      );

      expect(result).toBeNull();
    });

    it('removes the token when the server rejects it as invalid', async () => {
      const expiredCredentials = {
        serverName: 'test-server',
        token: { ...mockToken, expiresAt: Date.now() - 3600000 },
        clientId: 'test-client-id',
        tokenUrl: 'https://auth.example.com/token',
        updatedAt: Date.now(),
      };

      const tokenStorage = new MCPOAuthTokenStorage();
      vi.mocked(tokenStorage.getCredentials).mockResolvedValue(
        expiredCredentials,
      );
      vi.mocked(tokenStorage.isTokenExpired).mockReturnValue(true);
      vi.mocked(tokenStorage.deleteInvalidToken).mockResolvedValue(true);

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: false,
          status: 400,
          contentType: 'application/json',
          // RFC 6749 §5.2 error bodies are JSON.
          text: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid refresh token' }),
        }),
      );

      const authProvider = new MCPOAuthProvider();
      const result = await authProvider.getValidToken(
        'test-server',
        mockConfig,
      );

      expect(result).toBeNull();
      expect(tokenStorage.deleteInvalidToken).toHaveBeenCalledWith(
        'test-server',
        expiredCredentials.token,
      );
      expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('Failed to refresh auth token'),
        expect.any(Error),
      );
    });

    it('removes the token when the client is rejected with a 401', async () => {
      const expiredCredentials = {
        serverName: 'test-server',
        token: { ...mockToken, expiresAt: Date.now() - 3600000 },
        clientId: 'test-client-id',
        tokenUrl: 'https://auth.example.com/token',
        updatedAt: Date.now(),
      };

      const tokenStorage = new MCPOAuthTokenStorage();
      vi.mocked(tokenStorage.getCredentials).mockResolvedValue(
        expiredCredentials,
      );
      vi.mocked(tokenStorage.isTokenExpired).mockReturnValue(true);
      vi.mocked(tokenStorage.deleteInvalidToken).mockResolvedValue(true);

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: false,
          status: 401,
          contentType: 'application/json',
          // RFC 6749 §5.2 error bodies are JSON.
          text: JSON.stringify({ error: 'invalid_client' }),
        }),
      );

      const authProvider = new MCPOAuthProvider();
      const result = await authProvider.getValidToken(
        'test-server',
        mockConfig,
      );

      expect(result).toBeNull();
      expect(tokenStorage.deleteInvalidToken).toHaveBeenCalledWith(
        'test-server',
        expiredCredentials.token,
      );
      expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('Failed to refresh auth token'),
        expect.any(Error),
      );
    });

    it('keeps the token when the refresh fails for another reason: server error', async () => {
      const expiredCredentials = {
        serverName: 'test-server',
        token: { ...mockToken, expiresAt: Date.now() - 3600000 },
        clientId: 'test-client-id',
        tokenUrl: 'https://auth.example.com/token',
        updatedAt: Date.now(),
      };

      const tokenStorage = new MCPOAuthTokenStorage();
      vi.mocked(tokenStorage.getCredentials).mockResolvedValue(
        expiredCredentials,
      );
      vi.mocked(tokenStorage.isTokenExpired).mockReturnValue(true);
      vi.mocked(tokenStorage.deleteInvalidToken).mockResolvedValue(true);

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: false,
          status: 503,
          contentType: 'text/plain',
          text: 'Service Unavailable',
        }),
      );

      const authProvider = new MCPOAuthProvider();
      const result = await authProvider.getValidToken(
        'test-server',
        mockConfig,
      );

      expect(result).toBeNull();
      expect(tokenStorage.deleteInvalidToken).not.toHaveBeenCalled();
      expect(tokenStorage.deleteCredentials).not.toHaveBeenCalled();
      expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('Failed to refresh auth token'),
        expect.any(Error),
      );
    });

    it('keeps the token when the refresh fails for another reason: a 5xx carrying invalid_grant', async () => {
      const expiredCredentials = {
        serverName: 'test-server',
        token: { ...mockToken, expiresAt: Date.now() - 3600000 },
        clientId: 'test-client-id',
        tokenUrl: 'https://auth.example.com/token',
        updatedAt: Date.now(),
      };

      const tokenStorage = new MCPOAuthTokenStorage();
      vi.mocked(tokenStorage.getCredentials).mockResolvedValue(
        expiredCredentials,
      );
      vi.mocked(tokenStorage.isTokenExpired).mockReturnValue(true);
      vi.mocked(tokenStorage.deleteInvalidToken).mockResolvedValue(true);

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: false,
          status: 503,
          contentType: 'application/json',
          text: JSON.stringify({ error: 'invalid_grant' }),
        }),
      );

      const authProvider = new MCPOAuthProvider();
      const result = await authProvider.getValidToken(
        'test-server',
        mockConfig,
      );

      expect(result).toBeNull();
      expect(tokenStorage.deleteInvalidToken).not.toHaveBeenCalled();
      expect(tokenStorage.deleteCredentials).not.toHaveBeenCalled();
      expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('Failed to refresh auth token'),
        expect.any(Error),
      );
    });

    it('keeps the token when the refresh fails for another reason: a 429 carrying invalid_grant', async () => {
      const expiredCredentials = {
        serverName: 'test-server',
        token: { ...mockToken, expiresAt: Date.now() - 3600000 },
        clientId: 'test-client-id',
        tokenUrl: 'https://auth.example.com/token',
        updatedAt: Date.now(),
      };

      const tokenStorage = new MCPOAuthTokenStorage();
      vi.mocked(tokenStorage.getCredentials).mockResolvedValue(
        expiredCredentials,
      );
      vi.mocked(tokenStorage.isTokenExpired).mockReturnValue(true);
      vi.mocked(tokenStorage.deleteInvalidToken).mockResolvedValue(true);

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: false,
          status: 429,
          contentType: 'application/json',
          text: JSON.stringify({ error: 'invalid_grant' }),
        }),
      );

      const authProvider = new MCPOAuthProvider();
      const result = await authProvider.getValidToken(
        'test-server',
        mockConfig,
      );

      expect(result).toBeNull();
      expect(tokenStorage.deleteInvalidToken).not.toHaveBeenCalled();
      expect(tokenStorage.deleteCredentials).not.toHaveBeenCalled();
      expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('Failed to refresh auth token'),
        expect.any(Error),
      );
    });

    it('keeps the token when the refresh fails for another reason: malformed request', async () => {
      const expiredCredentials = {
        serverName: 'test-server',
        token: { ...mockToken, expiresAt: Date.now() - 3600000 },
        clientId: 'test-client-id',
        tokenUrl: 'https://auth.example.com/token',
        updatedAt: Date.now(),
      };

      const tokenStorage = new MCPOAuthTokenStorage();
      vi.mocked(tokenStorage.getCredentials).mockResolvedValue(
        expiredCredentials,
      );
      vi.mocked(tokenStorage.isTokenExpired).mockReturnValue(true);
      vi.mocked(tokenStorage.deleteInvalidToken).mockResolvedValue(true);

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: false,
          status: 400,
          contentType: 'application/x-www-form-urlencoded',
          text: 'error=invalid_request',
        }),
      );

      const authProvider = new MCPOAuthProvider();
      const result = await authProvider.getValidToken(
        'test-server',
        mockConfig,
      );

      expect(result).toBeNull();
      expect(tokenStorage.deleteInvalidToken).not.toHaveBeenCalled();
      expect(tokenStorage.deleteCredentials).not.toHaveBeenCalled();
      expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('Failed to refresh auth token'),
        expect.any(Error),
      );
    });

    it('should return null for token without refresh capability', async () => {
      const tokenWithoutRefresh = {
        serverName: 'test-server',
        token: {
          ...mockToken,
          refreshToken: undefined,
          expiresAt: Date.now() - 3600000,
        },
        clientId: 'test-client-id',
        tokenUrl: 'https://auth.example.com/token',
        updatedAt: Date.now(),
      };

      const tokenStorage = new MCPOAuthTokenStorage();
      vi.mocked(tokenStorage.getCredentials).mockResolvedValue(
        tokenWithoutRefresh,
      );
      vi.mocked(tokenStorage.isTokenExpired).mockReturnValue(true);

      const authProvider = new MCPOAuthProvider();
      const result = await authProvider.getValidToken(
        'test-server',
        mockConfig,
      );

      expect(result).toBeNull();
    });
  });

  describe('PKCE parameter generation', () => {
    it('should generate valid PKCE parameters', async () => {
      // Test is implicit in the authenticate flow tests, but we can verify
      // the crypto mocks are called correctly
      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code_123&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const authProvider = new MCPOAuthProvider();
      await authProvider.authenticate('test-server', mockConfig);

      expect(crypto.randomBytes).toHaveBeenCalledWith(64); // code verifier
      expect(crypto.randomBytes).toHaveBeenCalledWith(16); // state
      expect(crypto.createHash).toHaveBeenCalledWith('sha256');
    });
  });

  describe('Authorization URL building', () => {
    it('should build correct authorization URL with all parameters', async () => {
      // Mock to capture the URL that would be opened
      let capturedUrl: string | undefined;
      mockOpenBrowserSecurely.mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve();
      });

      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code_123&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const authProvider = new MCPOAuthProvider();
      await authProvider.authenticate(
        'test-server',
        mockConfig,
        'https://auth.example.com',
      );

      expect(capturedUrl).toBeDefined();
      expect(capturedUrl!).toContain('response_type=code');
      expect(capturedUrl!).toContain('client_id=test-client-id');
      expect(capturedUrl!).toContain('code_challenge=code_challenge_mock');
      expect(capturedUrl!).toContain('code_challenge_method=S256');
      expect(capturedUrl!).toContain('scope=read+write');
      expect(capturedUrl!).toContain('resource=https%3A%2F%2Fauth.example.com');
      expect(capturedUrl!).toContain('audience=https%3A%2F%2Fapi.example.com');
    });

    it('should correctly append parameters to an authorization URL that already has query params', async () => {
      // Mock to capture the URL that would be opened
      let capturedUrl: string;
      mockOpenBrowserSecurely.mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve();
      });

      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code_123&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const configWithParamsInUrl = {
        ...mockConfig,
        authorizationUrl: 'https://auth.example.com/authorize?audience=1234',
      };

      const authProvider = new MCPOAuthProvider();
      await authProvider.authenticate('test-server', configWithParamsInUrl);

      const url = new URL(capturedUrl!);
      expect(url.searchParams.get('audience')).toBe('1234');
      expect(url.searchParams.get('client_id')).toBe('test-client-id');
      expect(url.search.startsWith('?audience=1234&')).toBe(true);
    });

    it('should correctly append parameters to a URL with a fragment', async () => {
      // Mock to capture the URL that would be opened
      let capturedUrl: string;
      mockOpenBrowserSecurely.mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve();
      });

      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code_123&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          };
          const mockRes = {
            writeHead: vi.fn(),
            end: vi.fn(),
          };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const configWithFragment = {
        ...mockConfig,
        authorizationUrl: 'https://auth.example.com/authorize#login',
      };

      const authProvider = new MCPOAuthProvider();
      await authProvider.authenticate('test-server', configWithFragment);

      const url = new URL(capturedUrl!);
      expect(url.searchParams.get('client_id')).toBe('test-client-id');
      expect(url.hash).toBe('#login');
      expect(url.pathname).toBe('/authorize');
    });

    it('should use user-configured scopes over discovered scopes', async () => {
      let capturedUrl: string | undefined;
      mockOpenBrowserSecurely.mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve();
      });

      const configWithUserScopes: MCPOAuthConfig = {
        ...mockConfig,
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        scopes: ['user-scope'],
      };
      delete configWithUserScopes.authorizationUrl;
      delete configWithUserScopes.tokenUrl;

      const mockResourceMetadata = {
        resource: 'https://api.example.com/',
        authorization_servers: ['https://discovered.auth.com'],
      };

      const mockAuthServerMetadata = {
        authorization_endpoint: 'https://discovered.auth.com/authorize',
        token_endpoint: 'https://discovered.auth.com/token',
        scopes_supported: ['discovered-scope'],
      };

      mockFetch
        .mockResolvedValueOnce(createMockResponse({ ok: true, status: 200 }));

      // SDK mocks for discovery
      mockSdkDiscoverPRM.mockResolvedValueOnce(mockResourceMetadata);
      mockSdkDiscoverAS.mockResolvedValueOnce({
        ...mockAuthServerMetadata,
        issuer: 'https://discovered.auth.com',
        response_types_supported: ['code'],
      });

      // Setup callback handler
      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          };
          const mockRes = { writeHead: vi.fn(), end: vi.fn() };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      // Mock token exchange
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const authProvider = new MCPOAuthProvider();
      await authProvider.authenticate(
        'test-server',
        configWithUserScopes,
        'https://api.example.com',
      );

      expect(capturedUrl).toBeDefined();
      const url = new URL(capturedUrl!);
      expect(url.searchParams.get('scope')).toBe('user-scope');
    });

    it('should use discovered scopes when no user-configured scopes are provided', async () => {
      let capturedUrl: string | undefined;
      mockOpenBrowserSecurely.mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve();
      });

      const configWithoutScopes: MCPOAuthConfig = {
        ...mockConfig,
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      };
      delete configWithoutScopes.scopes;
      delete configWithoutScopes.authorizationUrl;
      delete configWithoutScopes.tokenUrl;

      const mockResourceMetadata = {
        resource: 'https://api.example.com/',
        authorization_servers: ['https://discovered.auth.com'],
      };

      const mockAuthServerMetadata = {
        authorization_endpoint: 'https://discovered.auth.com/authorize',
        token_endpoint: 'https://discovered.auth.com/token',
        scopes_supported: ['discovered-scope-1', 'discovered-scope-2'],
      };

      mockFetch
        .mockResolvedValueOnce(createMockResponse({ ok: true, status: 200 }));

      // SDK mocks for discovery
      mockSdkDiscoverPRM.mockResolvedValueOnce(mockResourceMetadata);
      mockSdkDiscoverAS.mockResolvedValueOnce({
        ...mockAuthServerMetadata,
        issuer: 'https://discovered.auth.com',
        response_types_supported: ['code'],
      });

      // Setup callback handler
      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          };
          const mockRes = { writeHead: vi.fn(), end: vi.fn() };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      // Mock token exchange
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const authProvider = new MCPOAuthProvider();
      await authProvider.authenticate(
        'test-server',
        configWithoutScopes,
        'https://api.example.com',
      );

      expect(capturedUrl).toBeDefined();
      const url = new URL(capturedUrl!);
      expect(url.searchParams.get('scope')).toBe(
        'discovered-scope-1 discovered-scope-2',
      );
    });

    it('uses the client_id and scopes advertised by the resource instead of dynamic registration', async () => {
      let capturedUrl: string | undefined;
      mockOpenBrowserSecurely.mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve();
      });

      const configWithoutClient: MCPOAuthConfig = {
        enabled: true,
        redirectUri: 'http://localhost:7777/oauth/callback',
      };

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: false,
          status: 401,
          contentType: 'application/json',
          headers: {
            'www-authenticate':
              'Bearer realm="", authorization_uri="https://login.microsoftonline.com/common/oauth2/authorize", client_id="pre-registered-client", resource_metadata="https://workiq.example.com/.well-known/oauth-protected-resource/mcp"',
          },
        }),
      );

      mockSdkDiscoverPRM.mockResolvedValueOnce({
        resource: 'https://workiq.example.com/mcp',
        authorization_servers: [
          'https://login.microsoftonline.com/organizations/v2.0',
        ],
        scopes_supported: ['api://pre-registered-client/WorkIQAgent.Ask'],
      });
      mockSdkDiscoverAS.mockResolvedValueOnce({
        // Entra ID advertises a tenant-template issuer that is not fetchable.
        issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
        authorization_endpoint:
          'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
        token_endpoint:
          'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
        scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
        response_types_supported: ['code'],
      });

      let callbackHandler: unknown;
      vi.mocked(http.createServer).mockImplementation((handler) => {
        callbackHandler = handler;
        return mockHttpServer as unknown as http.Server;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        callback?.();
        setTimeout(() => {
          const mockReq = {
            url: '/oauth/callback?code=auth_code&state=bW9ja19zdGF0ZV8xNl9ieXRlcw',
          };
          const mockRes = { writeHead: vi.fn(), end: vi.fn() };
          (callbackHandler as (req: unknown, res: unknown) => void)(
            mockReq,
            mockRes,
          );
        }, 10);
      });

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          contentType: 'application/json',
          text: JSON.stringify(mockTokenResponse),
          json: mockTokenResponse,
        }),
      );

      const authProvider = new MCPOAuthProvider();
      await authProvider.authenticate(
        'workiq',
        configWithoutClient,
        'https://workiq.example.com/mcp',
      );

      expect(capturedUrl).toBeDefined();
      const url = new URL(capturedUrl!);
      expect(url.origin).toBe('https://login.microsoftonline.com');
      expect(url.pathname).toBe('/organizations/oauth2/v2.0/authorize');
      expect(url.searchParams.get('client_id')).toBe('pre-registered-client');
      expect(url.searchParams.get('scope')).toBe(
        'api://pre-registered-client/WorkIQAgent.Ask',
      );
      expect(url.searchParams.get('resource')).toBe(
        'https://workiq.example.com/mcp',
      );
      // Only the PRM-declared authorization server is discovered; the
      // templated issuer is never re-fetched for client registration.
      expect(mockSdkDiscoverAS).toHaveBeenCalledTimes(1);
      expect(mockSdkDiscoverAS).toHaveBeenCalledWith(
        'https://login.microsoftonline.com/organizations/v2.0',
      );
    });
  });

  describe('issuer discovery conformance', () => {
    const registrationMetadata: OAuthAuthorizationServerMetadata = {
      issuer: 'http://localhost:8888/realms/my-realm',
      authorization_endpoint:
        'http://localhost:8888/realms/my-realm/protocol/openid-connect/auth',
      token_endpoint:
        'http://localhost:8888/realms/my-realm/protocol/openid-connect/token',
      registration_endpoint:
        'http://localhost:8888/realms/my-realm/clients-registrations/openid-connect',
    };

    it('falls back to path-based issuer when origin discovery fails', async () => {
      const authProvider = new MCPOAuthProvider();
      const providerWithAccess = authProvider as unknown as {
        discoverAuthServerMetadataForRegistration: (
          authorizationUrl: string,
        ) => Promise<{
          issuerUrl: string;
          metadata: OAuthAuthorizationServerMetadata;
        }>;
      };

      vi.spyOn(
        OAuthUtils,
        'discoverAuthorizationServerMetadata',
      ).mockImplementation(async (issuer) => {
        if (issuer === 'http://localhost:8888/realms/my-realm') {
          return registrationMetadata;
        }
        return null;
      });

      const result =
        await providerWithAccess.discoverAuthServerMetadataForRegistration(
          'http://localhost:8888/realms/my-realm/protocol/openid-connect/auth',
        );

      expect(
        vi.mocked(OAuthUtils.discoverAuthorizationServerMetadata).mock.calls,
      ).toEqual([
        ['http://localhost:8888'],
        ['http://localhost:8888/realms/my-realm'],
      ]);
      expect(result.issuerUrl).toBe('http://localhost:8888/realms/my-realm');
      expect(result.metadata).toBe(registrationMetadata);
    });

    it('trims versioned segments from authorization endpoints', async () => {
      const authProvider = new MCPOAuthProvider();
      const providerWithAccess = authProvider as unknown as {
        discoverAuthServerMetadataForRegistration: (
          authorizationUrl: string,
        ) => Promise<{
          issuerUrl: string;
          metadata: OAuthAuthorizationServerMetadata;
        }>;
      };

      const oktaMetadata: OAuthAuthorizationServerMetadata = {
        issuer: 'https://auth.okta.local/oauth2/default',
        authorization_endpoint:
          'https://auth.okta.local/oauth2/default/v1/authorize',
        token_endpoint: 'https://auth.okta.local/oauth2/default/v1/token',
        registration_endpoint:
          'https://auth.okta.local/oauth2/default/v1/register',
      };

      const attempts: string[] = [];
      vi.spyOn(
        OAuthUtils,
        'discoverAuthorizationServerMetadata',
      ).mockImplementation(async (issuer) => {
        attempts.push(issuer);
        if (issuer === 'https://auth.okta.local/oauth2/default') {
          return oktaMetadata;
        }
        return null;
      });

      const result =
        await providerWithAccess.discoverAuthServerMetadataForRegistration(
          'https://auth.okta.local/oauth2/default/v1/authorize',
        );

      expect(attempts).toEqual([
        'https://auth.okta.local',
        'https://auth.okta.local/oauth2/default/v1',
        'https://auth.okta.local/oauth2/default',
      ]);
      expect(result.issuerUrl).toBe('https://auth.okta.local/oauth2/default');
      expect(result.metadata).toBe(oktaMetadata);
    });
  });
});
