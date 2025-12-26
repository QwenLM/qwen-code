/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OAuth client name used for MCP dynamic client registration.
 * This name must match the allowlist on MCP servers like Figma.
 */
export const MCP_OAUTH_CLIENT_NAME = 'Gemini CLI MCP Client';

/**
 * OAuth client name for service account impersonation provider.
 */
export const MCP_SA_IMPERSONATION_CLIENT_NAME =
  'Gemini CLI (Service Account Impersonation)';

/**
 * Port for OAuth redirect callback server.
 */
export const OAUTH_REDIRECT_PORT = 7777;

/**
 * Path for OAuth redirect callback.
 */
export const OAUTH_REDIRECT_PATH = '/oauth/callback';
