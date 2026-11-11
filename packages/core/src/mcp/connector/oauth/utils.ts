/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MCPOAuthConfig } from './provider.js';
import { getErrorMessage } from '../../../utils/errors.js';
import { runLogger } from '../../../utils/runLogger.js';
import {
  discoverOAuthProtectedResourceMetadata as sdkDiscoverPRM,
  discoverAuthorizationServerMetadata as sdkDiscoverASMetadata,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import { BRAND_CLI_NAME } from '../../../config/brand.js';

/**
 * Build the OAuth client metadata used for MCP dynamic client registration.
 *
 * Both user-initiated OAuth and the SDK-driven auto-registration flow
 * share the same client_name shape so gateways see a single, server-aware
 * client identity (`<Brand> (<serverName>)`).
 */
export function buildMcpClientMetadata(
  serverName: string,
  overrides: Partial<OAuthClientMetadata> = {},
): OAuthClientMetadata {
  return {
    client_name: `${BRAND_CLI_NAME} (${serverName})`,
    redirect_uris: [],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...overrides,
  };
}

/**
 * Error thrown when the discovered resource metadata does not match the expected resource.
 */
export class ResourceMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceMismatchError';
  }
}

/**
 * OAuth authorization server metadata as per RFC 8414.
 */
export interface OAuthAuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  token_endpoint_auth_methods_supported?: string[];
  revocation_endpoint?: string;
  revocation_endpoint_auth_methods_supported?: string[];
  registration_endpoint?: string;
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
}

/**
 * OAuth protected resource metadata as per RFC 9728.
 */
export interface OAuthProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
  resource_documentation?: string;
  resource_signing_alg_values_supported?: string[];
  resource_encryption_alg_values_supported?: string[];
  resource_encryption_enc_values_supported?: string[];
}

/**
 * RFC 6570 URI template markers. Entra ID advertises a tenant-templated
 * issuer (e.g. `https://login.microsoftonline.com/{tenantid}/v2.0`) that
 * cannot be fetched as a discovery URL.
 */
const URI_TEMPLATE_PATTERN = /[{}]/;

/**
 * Pick an issuer that can actually be used as a discovery URL. When the
 * authorization server advertises a URI template, fall back to the URL that
 * served its metadata (the PRM `authorization_servers` entry).
 */
function resolveUsableIssuer(
  issuer: string | undefined,
  discoveryUrl: string | undefined,
): string | undefined {
  if (issuer && !URI_TEMPLATE_PATTERN.test(issuer)) {
    return issuer;
  }
  if (discoveryUrl && !URI_TEMPLATE_PATTERN.test(discoveryUrl)) {
    return discoveryUrl;
  }
  return issuer ?? discoveryUrl;
}

/**
 * Utility class for common OAuth operations.
 * Acts as an adapter layer over the MCP SDK's discovery functions.
 */
export class OAuthUtils {
  /**
   * Discover OAuth protected resource metadata via SDK.
   * Delegates to the SDK's discoverOAuthProtectedResourceMetadata which handles
   * well-known URL construction, path-based/root fallback, MCP-Protocol-Version
   * header, CORS retry, and Zod schema validation.
   */
  static async discoverProtectedResourceMetadata(
    serverUrl: string,
    resourceMetadataUrl?: string,
  ): Promise<OAuthProtectedResourceMetadata | null> {
    try {
      const result = await sdkDiscoverPRM(
        serverUrl,
        resourceMetadataUrl
          ? { resourceMetadataUrl: new URL(resourceMetadataUrl) }
          : undefined,
      );
      return result as OAuthProtectedResourceMetadata;
    } catch (error) {
      runLogger.debug(
        `PRM discovery failed for ${serverUrl}${resourceMetadataUrl ? ` (metadata URL: ${resourceMetadataUrl})` : ''}: ${getErrorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Discover authorization server metadata via SDK.
   * Delegates to the SDK which handles path-aware well-known URL enumeration,
   * OIDC discovery fallback, MCP-Protocol-Version header, and schema validation.
   */
  static async discoverAuthorizationServerMetadata(
    authServerUrl: string,
  ): Promise<OAuthAuthorizationServerMetadata | null> {
    try {
      const metadata = await sdkDiscoverASMetadata(authServerUrl);
      if (!metadata) return null;
      return metadata as OAuthAuthorizationServerMetadata;
    } catch (error) {
      runLogger.debug(
        `AS metadata discovery failed for ${authServerUrl}: ${getErrorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Convert authorization server metadata to OAuth configuration.
   *
   * @param discoveryUrl URL that actually served the metadata. Used as the
   *   issuer fallback when the advertised issuer is a URI template.
   */
  static metadataToOAuthConfig(
    metadata: OAuthAuthorizationServerMetadata,
    discoveryUrl?: string,
  ): MCPOAuthConfig {
    return {
      authorizationUrl: metadata.authorization_endpoint,
      issuer: resolveUsableIssuer(metadata.issuer, discoveryUrl),
      tokenUrl: metadata.token_endpoint,
      scopes: metadata.scopes_supported || [],
      registrationUrl: metadata.registration_endpoint,
    };
  }

  /**
   * Prefer scopes declared by the protected resource (RFC 9728). Entra ID
   * resources advertise API-specific scopes while the authorization server
   * only lists generic OIDC scopes, so the AS list alone yields a token that
   * cannot access the resource.
   */
  private static applyResourceScopes(
    config: MCPOAuthConfig,
    resourceMetadata: OAuthProtectedResourceMetadata | null,
  ): void {
    const scopes = resourceMetadata?.scopes_supported;
    if (scopes?.length) {
      config.scopes = scopes;
    }
  }

  /**
   * Discover OAuth configuration using the standard well-known endpoints.
   * Uses SDK discovery functions with proper resource validation.
   */
  static async discoverOAuthConfig(
    serverUrl: string,
  ): Promise<MCPOAuthConfig | null> {
    try {
      const resourceMetadata =
        await this.discoverProtectedResourceMetadata(serverUrl);

      if (resourceMetadata) {
        this.validateResourceMatch(resourceMetadata.resource, serverUrl);
      }

      let authServerMetadata: OAuthAuthorizationServerMetadata | null = null;
      const authServerDiscoveryUrl = resourceMetadata?.authorization_servers
        ?.length
        ? resourceMetadata.authorization_servers[0]
        : new URL(serverUrl).origin;

      if (resourceMetadata?.authorization_servers?.length) {
        authServerMetadata = await this.discoverAuthorizationServerMetadata(
          authServerDiscoveryUrl,
        );
        if (!authServerMetadata) {
          runLogger.debug(
            `PRM declared authorization_server but AS metadata discovery failed`,
          );
          return null;
        }
      } else {
        authServerMetadata =
          await this.discoverAuthorizationServerMetadata(
            authServerDiscoveryUrl,
          );
      }

      if (authServerMetadata) {
        const config = this.metadataToOAuthConfig(
          authServerMetadata,
          authServerDiscoveryUrl,
        );
        config.resource = resourceMetadata?.resource;
        this.applyResourceScopes(config, resourceMetadata);
        if (authServerMetadata.registration_endpoint) {
          runLogger.log(
            'Dynamic client registration is supported at:',
            authServerMetadata.registration_endpoint,
          );
        }
        return config;
      }

      return null;
    } catch (error) {
      if (error instanceof ResourceMismatchError) {
        throw error;
      }
      runLogger.debug(
        `Failed to discover OAuth configuration: ${getErrorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Extract a Bearer auth-param value from a WWW-Authenticate header.
   * Validates the scheme and supports quoted and unquoted values.
   */
  private static parseBearerParameter(
    header: string,
    name: 'resource_metadata' | 'client_id',
  ): string | null {
    const spaceIdx = header.indexOf(' ');
    if (spaceIdx === -1) return null;
    const scheme = header.slice(0, spaceIdx);
    if (scheme.toLowerCase() !== 'bearer') return null;
    const params = header.slice(spaceIdx + 1);
    const match = params.match(
      new RegExp(`${name}=(?:"([^"]+)"|([^\\s,]+))`),
    );
    return match ? (match[1] || match[2]) : null;
  }

  /**
   * Parse WWW-Authenticate header to extract resource_metadata URI.
   * Validates Bearer scheme and supports both quoted and unquoted values.
   */
  static parseWWWAuthenticateHeader(header: string): string | null {
    return this.parseBearerParameter(header, 'resource_metadata');
  }

  /**
   * Parse WWW-Authenticate header to extract a pre-registered client_id.
   * RFC 9728 resources (e.g. those protected by Entra ID) may advertise the
   * public client the CLI must use instead of relying on dynamic registration.
   */
  static parseWWWAuthenticateClientId(header: string): string | null {
    return this.parseBearerParameter(header, 'client_id');
  }

  /**
   * Discover OAuth configuration from WWW-Authenticate header.
   */
  static async discoverOAuthFromWWWAuthenticate(
    wwwAuthenticate: string,
    mcpServerUrl?: string,
  ): Promise<MCPOAuthConfig | null> {
    const resourceMetadataUri =
      this.parseWWWAuthenticateHeader(wwwAuthenticate);
    if (!resourceMetadataUri) {
      return null;
    }

    const resourceMetadata = await this.discoverProtectedResourceMetadata(
      mcpServerUrl ?? resourceMetadataUri,
      resourceMetadataUri,
    );

    if (resourceMetadata && mcpServerUrl) {
      this.validateResourceMatch(resourceMetadata.resource, mcpServerUrl);
    }

    if (!resourceMetadata?.authorization_servers?.length) {
      return null;
    }

    const authServerDiscoveryUrl = resourceMetadata.authorization_servers[0];
    const authServerMetadata =
      await this.discoverAuthorizationServerMetadata(authServerDiscoveryUrl);
    if (!authServerMetadata) return null;

    const config = this.metadataToOAuthConfig(
      authServerMetadata,
      authServerDiscoveryUrl,
    );
    config.resource = resourceMetadata.resource;
    this.applyResourceScopes(config, resourceMetadata);
    const headerClientId = this.parseWWWAuthenticateClientId(wwwAuthenticate);
    if (headerClientId) {
      config.clientId = headerClientId;
    }
    return config;
  }

  /**
   * Check if a URL is an SSE endpoint.
   */
  static isSSEEndpoint(url: string): boolean {
    return url.includes('/sse') || !url.includes('/mcp');
  }

  /**
   * Build a resource parameter for OAuth requests.
   * Aligned with SDK: preserves query, removes fragment.
   */
  static buildResourceParameter(endpointUrl: string): string {
    return resourceUrlFromServerUrl(endpointUrl).href;
  }

  /**
   * Validate that the discovered resource matches the expected server URL
   * using path-prefix matching (SDK semantics).
   */
  private static validateResourceMatch(
    discoveredResource: string,
    serverUrl: string,
  ): void {
    const requestedResource = resourceUrlFromServerUrl(serverUrl);
    if (
      !checkResourceAllowed({
        requestedResource,
        configuredResource: discoveredResource,
      })
    ) {
      throw new ResourceMismatchError(
        `Protected resource ${discoveredResource} does not match expected ${requestedResource.href}`,
      );
    }
  }

  /**
   * Parses a JWT string to extract its expiry time.
   * @param idToken The JWT ID token.
   * @returns The expiry time in **milliseconds**, or undefined if parsing fails.
   */
  static parseTokenExpiry(idToken: string): number | undefined {
    try {
      const payload = JSON.parse(
        Buffer.from(idToken.split('.')[1], 'base64').toString(),
      );

      if (payload && typeof payload.exp === 'number') {
        return payload.exp * 1000;
      }
    } catch (e) {
      runLogger.error(
        'Failed to parse ID token for expiry time with error:',
        e,
      );
    }

    return undefined;
  }
}
