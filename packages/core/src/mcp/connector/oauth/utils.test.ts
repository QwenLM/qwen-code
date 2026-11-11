/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OAuthUtils,
  ResourceMismatchError,
  type OAuthAuthorizationServerMetadata,
} from './utils.js';

const mockSdkDiscoverPRM = vi.hoisted(() => vi.fn());
const mockSdkDiscoverAS = vi.hoisted(() => vi.fn());
vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  discoverOAuthProtectedResourceMetadata: mockSdkDiscoverPRM,
  discoverAuthorizationServerMetadata: mockSdkDiscoverAS,
}));

vi.mock('@modelcontextprotocol/sdk/shared/auth-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/sdk/shared/auth-utils.js')>();
  return {
    ...actual,
    checkResourceAllowed: actual.checkResourceAllowed,
    resourceUrlFromServerUrl: actual.resourceUrlFromServerUrl,
  };
});

describe('OAuthUtils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('validateResourceMatch (via discoverOAuthConfig)', () => {
    it('should pass when root resource covers subpath (prefix match)', async () => {
      mockSdkDiscoverPRM.mockResolvedValueOnce({
        resource: 'https://example.com',
        authorization_servers: ['https://auth.example.com'],
      });
      mockSdkDiscoverAS.mockResolvedValueOnce({
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        response_types_supported: ['code'],
      });

      const config = await OAuthUtils.discoverOAuthConfig(
        'https://example.com/mcp',
      );
      expect(config).not.toBeNull();
      expect(config!.resource).toBe('https://example.com');
    });

    it('should pass when /api covers /api/v1', async () => {
      mockSdkDiscoverPRM.mockResolvedValueOnce({
        resource: 'https://a.com/api',
        authorization_servers: ['https://auth.a.com'],
      });
      mockSdkDiscoverAS.mockResolvedValueOnce({
        issuer: 'https://auth.a.com',
        authorization_endpoint: 'https://auth.a.com/authorize',
        token_endpoint: 'https://auth.a.com/token',
        response_types_supported: ['code'],
      });

      const config = await OAuthUtils.discoverOAuthConfig('https://a.com/api/v1');
      expect(config).not.toBeNull();
    });

    it('should reject when /api does not cover /api2 (trailing slash prevents false prefix)', async () => {
      mockSdkDiscoverPRM.mockResolvedValueOnce({
        resource: 'https://a.com/api',
        authorization_servers: ['https://auth.a.com'],
      });

      await expect(
        OAuthUtils.discoverOAuthConfig('https://a.com/api2'),
      ).rejects.toThrow(ResourceMismatchError);
    });

    it('should reject when origins differ', async () => {
      mockSdkDiscoverPRM.mockResolvedValueOnce({
        resource: 'https://malicious.com/mcp',
        authorization_servers: ['https://auth.example.com'],
      });

      await expect(
        OAuthUtils.discoverOAuthConfig('https://example.com/mcp'),
      ).rejects.toThrow(/does not match expected/);
    });
  });

  describe('discoverOAuthConfig', () => {
    it('should return null when PRM discovery fails (404/network)', async () => {
      mockSdkDiscoverPRM.mockRejectedValueOnce(
        new Error('Resource server does not implement OAuth 2.0 Protected Resource Metadata.'),
      );
      mockSdkDiscoverAS.mockResolvedValueOnce({
        issuer: 'https://example.com',
        authorization_endpoint: 'https://example.com/authorize',
        token_endpoint: 'https://example.com/token',
        response_types_supported: ['code'],
      });

      const config = await OAuthUtils.discoverOAuthConfig('https://example.com/mcp');
      expect(config).not.toBeNull();
      expect(config!.authorizationUrl).toBe('https://example.com/authorize');
    });

    it('should return null when PRM has AS but AS metadata fails', async () => {
      mockSdkDiscoverPRM.mockResolvedValueOnce({
        resource: 'https://example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
      });
      mockSdkDiscoverAS.mockResolvedValueOnce(undefined);

      const config = await OAuthUtils.discoverOAuthConfig('https://example.com/mcp');
      expect(config).toBeNull();
    });

    it('should return config with resource field from PRM', async () => {
      mockSdkDiscoverPRM.mockResolvedValueOnce({
        resource: 'https://example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
      });
      mockSdkDiscoverAS.mockResolvedValueOnce({
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        response_types_supported: ['code'],
        scopes_supported: ['read', 'write'],
      });

      const config = await OAuthUtils.discoverOAuthConfig('https://example.com/mcp');
      expect(config).toEqual({
        authorizationUrl: 'https://auth.example.com/authorize',
        issuer: 'https://auth.example.com',
        tokenUrl: 'https://auth.example.com/token',
        scopes: ['read', 'write'],
        registrationUrl: undefined,
        resource: 'https://example.com/mcp',
      });
    });
  });

  describe('metadataToOAuthConfig', () => {
    it('should convert metadata to OAuth config', () => {
      const metadata: OAuthAuthorizationServerMetadata = {
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        scopes_supported: ['read', 'write'],
      };

      const config = OAuthUtils.metadataToOAuthConfig(metadata);

      expect(config).toEqual({
        authorizationUrl: 'https://auth.example.com/authorize',
        issuer: 'https://auth.example.com',
        tokenUrl: 'https://auth.example.com/token',
        scopes: ['read', 'write'],
      });
    });

    it('should handle empty scopes', () => {
      const metadata: OAuthAuthorizationServerMetadata = {
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
      };

      const config = OAuthUtils.metadataToOAuthConfig(metadata);
      expect(config.scopes).toEqual([]);
    });
  });

  describe('parseWWWAuthenticateHeader', () => {
    it('should parse resource metadata URI from Bearer WWW-Authenticate header', () => {
      const header =
        'Bearer realm="example", resource_metadata="https://example.com/.well-known/oauth-protected-resource"';
      const result = OAuthUtils.parseWWWAuthenticateHeader(header);
      expect(result).toBe(
        'https://example.com/.well-known/oauth-protected-resource',
      );
    });

    it('should return null when no resource metadata URI is found', () => {
      const header = 'Bearer realm="example"';
      const result = OAuthUtils.parseWWWAuthenticateHeader(header);
      expect(result).toBeNull();
    });

    it('should return null for non-Bearer schemes', () => {
      const header = 'Basic realm="example", resource_metadata="https://example.com/prm"';
      expect(OAuthUtils.parseWWWAuthenticateHeader(header)).toBeNull();
    });

    it('should support unquoted resource_metadata values', () => {
      const header = 'Bearer resource_metadata=https://example.com/.well-known/oauth-protected-resource';
      const result = OAuthUtils.parseWWWAuthenticateHeader(header);
      expect(result).toBe('https://example.com/.well-known/oauth-protected-resource');
    });
  });

  describe('parseWWWAuthenticateClientId', () => {
    it('should parse a quoted client_id from a Bearer WWW-Authenticate header', () => {
      const header =
        'Bearer realm="", authorization_uri="https://login.microsoftonline.com/common/oauth2/authorize", client_id="fdcc1f02-0000-0000-0000-f668596af7f7", resource_metadata="https://example.com/.well-known/oauth-protected-resource"';
      expect(OAuthUtils.parseWWWAuthenticateClientId(header)).toBe(
        'fdcc1f02-0000-0000-0000-f668596af7f7',
      );
    });

    it('should return null when the header has no client_id', () => {
      const header =
        'Bearer realm="example", resource_metadata="https://example.com/.well-known/oauth-protected-resource"';
      expect(OAuthUtils.parseWWWAuthenticateClientId(header)).toBeNull();
    });

    it('should return null for non-Bearer schemes', () => {
      const header = 'Basic client_id="abc"';
      expect(OAuthUtils.parseWWWAuthenticateClientId(header)).toBeNull();
    });
  });

  describe('discoverOAuthFromWWWAuthenticate', () => {
    it('should pass resourceMetadataUrl override to SDK discovery', async () => {
      const prmUrl = 'https://example.com/.well-known/oauth-protected-resource';
      mockSdkDiscoverPRM.mockResolvedValueOnce({
        resource: 'https://example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
      });
      mockSdkDiscoverAS.mockResolvedValueOnce({
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        response_types_supported: ['code'],
      });

      await OAuthUtils.discoverOAuthFromWWWAuthenticate(
        `Bearer resource_metadata="${prmUrl}"`,
        'https://example.com/mcp',
      );

      expect(mockSdkDiscoverPRM).toHaveBeenCalledWith(
        'https://example.com/mcp',
        { resourceMetadataUrl: new URL(prmUrl) },
      );
    });

    it('should throw ResourceMismatchError when resource does not cover serverUrl', async () => {
      mockSdkDiscoverPRM.mockResolvedValueOnce({
        resource: 'https://malicious.com',
        authorization_servers: ['https://auth.example.com'],
      });

      await expect(
        OAuthUtils.discoverOAuthFromWWWAuthenticate(
          'Bearer resource_metadata="https://malicious.com/.well-known/oauth-protected-resource"',
          'https://example.com/mcp',
        ),
      ).rejects.toThrow(ResourceMismatchError);
    });

    it('should populate config.resource from PRM metadata', async () => {
      mockSdkDiscoverPRM.mockResolvedValueOnce({
        resource: 'https://example.com',
        authorization_servers: ['https://auth.example.com'],
      });
      mockSdkDiscoverAS.mockResolvedValueOnce({
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        response_types_supported: ['code'],
        scopes_supported: ['read'],
      });

      const config = await OAuthUtils.discoverOAuthFromWWWAuthenticate(
        'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
        'https://example.com/mcp',
      );

      expect(config).not.toBeNull();
      expect(config!.resource).toBe('https://example.com');
    });

    it('should adopt the WWW-Authenticate client_id, resource scopes and a usable issuer', async () => {
      mockSdkDiscoverPRM.mockResolvedValueOnce({
        resource: 'https://workiq.example.com/mcp',
        authorization_servers: [
          'https://login.microsoftonline.com/organizations/v2.0',
        ],
        scopes_supported: ['api://client-id/WorkIQAgent.Ask'],
      });
      mockSdkDiscoverAS.mockResolvedValueOnce({
        issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
        authorization_endpoint:
          'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
        token_endpoint:
          'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
        scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
        response_types_supported: ['code'],
      });

      const config = await OAuthUtils.discoverOAuthFromWWWAuthenticate(
        'Bearer realm="", authorization_uri="https://login.microsoftonline.com/common/oauth2/authorize", client_id="client-id", resource_metadata="https://workiq.example.com/.well-known/oauth-protected-resource/mcp"',
        'https://workiq.example.com/mcp',
      );

      expect(config).not.toBeNull();
      expect(config!.clientId).toBe('client-id');
      expect(config!.scopes).toEqual(['api://client-id/WorkIQAgent.Ask']);
      // The templated issuer cannot be fetched; keep the discovery URL.
      expect(config!.issuer).toBe(
        'https://login.microsoftonline.com/organizations/v2.0',
      );
      expect(config!.registrationUrl).toBeUndefined();
    });
  });

  describe('isSSEEndpoint', () => {
    it('should return true for SSE endpoints', () => {
      expect(OAuthUtils.isSSEEndpoint('https://example.com/sse')).toBe(true);
    });

    it('should return false for MCP endpoints', () => {
      expect(OAuthUtils.isSSEEndpoint('https://example.com/mcp')).toBe(false);
    });
  });

  describe('buildResourceParameter', () => {
    it('should build resource parameter from endpoint URL', () => {
      const result = OAuthUtils.buildResourceParameter(
        'https://example.com/oauth/token',
      );
      expect(result).toBe('https://example.com/oauth/token');
    });

    it('should preserve query parameters (SDK semantics)', () => {
      const result = OAuthUtils.buildResourceParameter(
        'https://example.com/api/v1/data?user=123&scope=read',
      );
      expect(result).toBe('https://example.com/api/v1/data?user=123&scope=read');
    });

    it('should strip URL fragments', () => {
      const result = OAuthUtils.buildResourceParameter(
        'https://example.com/api/v1/data#section-one',
      );
      expect(result).toBe('https://example.com/api/v1/data');
    });

    it('should throw an error for invalid URLs', () => {
      expect(() => OAuthUtils.buildResourceParameter('not-a-url')).toThrow();
    });
  });

  describe('parseTokenExpiry', () => {
    it('should return the expiry time in milliseconds for a valid token', () => {
      const expiry = 4102444800;
      const payload = { exp: expiry };
      const token = `header.${Buffer.from(JSON.stringify(payload)).toString('base64')}.signature`;
      const result = OAuthUtils.parseTokenExpiry(token);
      expect(result).toBe(expiry * 1000);
    });

    it('should return undefined for a token without an expiry time', () => {
      const payload = { iat: 1678886400 };
      const token = `header.${Buffer.from(JSON.stringify(payload)).toString('base64')}.signature`;
      const result = OAuthUtils.parseTokenExpiry(token);
      expect(result).toBeUndefined();
    });

    it('should return undefined for a malformed token', () => {
      const token = 'not-a-valid-token';
      const result = OAuthUtils.parseTokenExpiry(token);
      expect(result).toBeUndefined();
    });
  });
});
