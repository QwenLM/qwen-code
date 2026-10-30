/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  OAuthAuthorizationServerMetadata,
  OAuthProtectedResourceMetadata,
} from './oauth-utils.js';
import { OAuthUtils } from './oauth-utils.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

/** A successful fetch response whose JSON body is `body`. */
const okJson = (body: unknown) => ({
  ok: true,
  json: () => Promise.resolve(body),
});

const PRM_URL = 'https://example.com/.well-known/oauth-protected-resource';

const authServerMetadata: OAuthAuthorizationServerMetadata = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  scopes_supported: ['read', 'write'],
};

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

  describe('buildWellKnownUrls', () => {
    it.each([
      [
        'should build standard root-based URLs by default',
        'https://example.com/mcp',
        undefined,
        '',
      ],
      [
        'should build path-based URLs when includePathSuffix is true',
        'https://example.com/mcp',
        true,
        '/mcp',
      ],
      ['should handle root path correctly', 'https://example.com', true, ''],
      [
        'should handle trailing slash in path',
        'https://example.com/mcp/',
        true,
        '/mcp',
      ],
    ])('%s', (_title, url, includePathSuffix, suffix) => {
      const urls = OAuthUtils.buildWellKnownUrls(url, includePathSuffix);
      expect(urls.protectedResource).toBe(`${PRM_URL}${suffix}`);
      expect(urls.authorizationServer).toBe(
        `https://example.com/.well-known/oauth-authorization-server${suffix}`,
      );
    });
  });

  describe('fetchProtectedResourceMetadata', () => {
    const mockResourceMetadata: OAuthProtectedResourceMetadata = {
      resource: 'https://api.example.com',
      authorization_servers: ['https://auth.example.com'],
      bearer_methods_supported: ['header'],
    };

    it('should fetch protected resource metadata successfully', async () => {
      mockFetch.mockResolvedValueOnce(okJson(mockResourceMetadata));
      const result = await OAuthUtils.fetchProtectedResourceMetadata(PRM_URL);
      expect(result).toEqual(mockResourceMetadata);
    });

    it('should return null when fetch fails', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false });
      const result = await OAuthUtils.fetchProtectedResourceMetadata(PRM_URL);
      expect(result).toBeNull();
    });
  });

  describe('fetchAuthorizationServerMetadata', () => {
    const fetchMetadata = () =>
      OAuthUtils.fetchAuthorizationServerMetadata(
        'https://auth.example.com/.well-known/oauth-authorization-server',
      );

    it('should fetch authorization server metadata successfully', async () => {
      mockFetch.mockResolvedValueOnce(okJson(authServerMetadata));
      expect(await fetchMetadata()).toEqual(authServerMetadata);
    });

    it('should return null when fetch fails', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false });
      expect(await fetchMetadata()).toBeNull();
    });
  });

  describe('discoverAuthorizationServerMetadata', () => {
    it('should handle URLs without path components correctly', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce(okJson(authServerMetadata));

      const result = await OAuthUtils.discoverAuthorizationServerMetadata(
        'https://auth.example.com/',
      );

      expect(result).toEqual(authServerMetadata);
      expect(mockFetch).nthCalledWith(
        1,
        'https://auth.example.com/.well-known/oauth-authorization-server',
      );
      expect(mockFetch).nthCalledWith(
        2,
        'https://auth.example.com/.well-known/openid-configuration',
      );
    });

    it('should handle URLs with path components correctly', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce(okJson(authServerMetadata));

      const result = await OAuthUtils.discoverAuthorizationServerMetadata(
        'https://auth.example.com/mcp',
      );

      expect(result).toEqual(authServerMetadata);
      expect(mockFetch).nthCalledWith(
        1,
        'https://auth.example.com/.well-known/oauth-authorization-server/mcp',
      );
      expect(mockFetch).nthCalledWith(
        2,
        'https://auth.example.com/.well-known/openid-configuration/mcp',
      );
      expect(mockFetch).nthCalledWith(
        3,
        'https://auth.example.com/mcp/.well-known/openid-configuration',
      );
    });
  });

  describe('metadataToOAuthConfig', () => {
    it('should convert metadata to OAuth config', () => {
      expect(OAuthUtils.metadataToOAuthConfig(authServerMetadata)).toEqual({
        authorizationUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
        scopes: ['read', 'write'],
      });
    });

    it('should handle empty scopes', () => {
      const { scopes_supported: _, ...withoutScopes } = authServerMetadata;
      const config = OAuthUtils.metadataToOAuthConfig(withoutScopes);
      expect(config.scopes).toEqual([]);
    });
  });

  describe('parseWWWAuthenticateHeader', () => {
    const parse = (header: string) =>
      OAuthUtils.parseWWWAuthenticateHeader(header);

    it('should parse resource metadata URI from WWW-Authenticate header', () => {
      expect(
        parse(`Bearer realm="example", resource_metadata="${PRM_URL}"`),
      ).toBe(PRM_URL);
    });

    it('should parse resource metadata URI with optional whitespace around equals', () => {
      expect(
        parse(`Bearer realm="example", resource_metadata = "${PRM_URL}"`),
      ).toBe(PRM_URL);
    });

    it('should parse single-quoted resource metadata URI', () => {
      expect(
        parse(`Bearer realm="example", resource_metadata='${PRM_URL}'`),
      ).toBe(PRM_URL);
    });

    it('should preserve apostrophes inside double-quoted resource metadata URI', () => {
      expect(parse(`Bearer resource_metadata="${PRM_URL}?name=o'hara"`)).toBe(
        `${PRM_URL}?name=o'hara`,
      );
    });

    it('should ignore apostrophes in other auth params', () => {
      expect(parse(`Bearer ext=can't, resource_metadata="${PRM_URL}"`)).toBe(
        PRM_URL,
      );
    });

    it('should return null when no resource metadata URI is found', () => {
      expect(parse('Bearer realm="example"')).toBeNull();
    });

    it('should not parse malformed resource metadata values', () => {
      expect(parse(`Bearer resource_metadata=${PRM_URL}`)).toBeNull();
      expect(parse('Bearer resource_metadata=""')).toBeNull();
      expect(parse(`Bearer resource_metadata='${PRM_URL}"`)).toBeNull();
    });

    it('should only parse standalone resource metadata params', () => {
      expect(parse(`Bearer not_resource_metadata="${PRM_URL}"`)).toBeNull();
      expect(
        parse(
          `Bearer error_description="missing, resource_metadata='${PRM_URL}'"`,
        ),
      ).toBeNull();
    });
  });

  describe('extractBaseUrl', () => {
    it('should extract base URL from MCP server URL', () => {
      const result = OAuthUtils.extractBaseUrl('https://example.com/mcp/v1');
      expect(result).toBe('https://example.com');
    });

    it('should handle URLs with ports', () => {
      const result = OAuthUtils.extractBaseUrl(
        'https://example.com:8080/mcp/v1',
      );
      expect(result).toBe('https://example.com:8080');
    });
  });

  describe('isSSEEndpoint', () => {
    it('should return true for SSE endpoints', () => {
      expect(OAuthUtils.isSSEEndpoint('https://example.com/sse')).toBe(true);
      expect(OAuthUtils.isSSEEndpoint('https://example.com/api/v1/sse')).toBe(
        true,
      );
    });

    it('should return true for non-MCP endpoints', () => {
      expect(OAuthUtils.isSSEEndpoint('https://example.com/api')).toBe(true);
    });

    it('should return false for MCP endpoints', () => {
      expect(OAuthUtils.isSSEEndpoint('https://example.com/mcp')).toBe(false);
      expect(OAuthUtils.isSSEEndpoint('https://example.com/api/mcp/v1')).toBe(
        false,
      );
    });
  });

  describe('buildResourceParameter', () => {
    const resourceFor = (url: string) => OAuthUtils.buildResourceParameter(url);

    it('should return canonical URI with full path', () => {
      expect(resourceFor('https://example.com/oauth/token')).toBe(
        'https://example.com/oauth/token',
      );
    });

    it('should handle URLs with ports', () => {
      expect(resourceFor('https://example.com:8080/oauth/token')).toBe(
        'https://example.com:8080/oauth/token',
      );
    });

    it('should strip query and fragment per RFC 8707', () => {
      expect(resourceFor('https://example.com/mcp?foo=bar#frag')).toBe(
        'https://example.com/mcp',
      );
    });

    it('should remove trailing slash from paths', () => {
      expect(resourceFor('https://example.com/mcp/')).toBe(
        'https://example.com/mcp',
      );
    });

    it('should handle root URL consistently', () => {
      // With or without the trailing slash, the root has one canonical
      // form, without it.
      expect(resourceFor('https://example.com')).toBe('https://example.com');
      expect(resourceFor('https://example.com/')).toBe('https://example.com');
    });

    // Regression test for https://github.com/QwenLM/qwen-code/issues/1749
    // Per MCP spec, resource is the canonical URI including the path, so
    // multi-tenant servers can tell different MCP servers apart: it must
    // include the full path, not just the host.
    it('should preserve full path for multi-tenant MCP servers (issue #1749)', () => {
      expect(resourceFor('https://mcp.alibaba-inc.com/yuque/mcp')).toBe(
        'https://mcp.alibaba-inc.com/yuque/mcp',
      );
    });
  });

  describe('discoverOAuthConfig', () => {
    /** Serves resource metadata, then auth server metadata. */
    const serveMetadata = (
      resource: OAuthProtectedResourceMetadata,
      authServer: OAuthAuthorizationServerMetadata,
    ) =>
      mockFetch
        .mockResolvedValueOnce(okJson(resource))
        .mockResolvedValueOnce(okJson(authServer));

    it('should use scopes from protected resource metadata when available', async () => {
      // Guards the fix for scopes from protected resource metadata not
      // being used.
      serveMetadata(
        {
          resource: 'https://www.modelscope.cn/mcp-server',
          authorization_servers: ['https://www.modelscope.cn'],
          scopes_supported: [
            'openid',
            'profile',
            'list-operational-mcp',
            'manage-mcp-deployment',
          ],
        },
        {
          issuer: 'https://www.modelscope.cn',
          authorization_endpoint: 'https://www.modelscope.cn/oauth/authorize',
          token_endpoint: 'https://www.modelscope.cn/oauth/token',
          // Note: scopes_supported is NOT present in auth server metadata
        },
      );

      const result = await OAuthUtils.discoverOAuthConfig(
        'https://www.modelscope.cn/mcp-server',
      );

      expect(result).not.toBeNull();
      expect(result!.scopes).toEqual([
        'openid',
        'profile',
        'list-operational-mcp',
        'manage-mcp-deployment',
      ]);
    });

    it('should prefer protected resource scopes over auth server scopes', async () => {
      serveMetadata(
        {
          resource: 'https://example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
          scopes_supported: ['mcp-read', 'mcp-write'],
        },
        { ...authServerMetadata, scopes_supported: ['read', 'write', 'admin'] },
      );

      const result = await OAuthUtils.discoverOAuthConfig(
        'https://example.com/mcp',
      );

      expect(result).not.toBeNull();
      // Protected resource scopes win over the auth server's.
      expect(result!.scopes).toEqual(['mcp-read', 'mcp-write']);
    });
  });
});
