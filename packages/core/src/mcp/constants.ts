/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OAuth client name used for MCP dynamic client registration.
 * This name must match the allowlist on MCP servers like Figma.
 */
export const MCP_OAUTH_CLIENT_NAME = 'Qwen Code MCP Client';

/**
 * OAuth client name for service account impersonation provider.
 */
export const MCP_SA_IMPERSONATION_CLIENT_NAME =
  'Qwen Code (Service Account Impersonation)';

/**
 * Port for OAuth redirect callback server.
 */
export const OAUTH_REDIRECT_PORT = 7777;

/**
 * Path for OAuth redirect callback.
 */
export const OAUTH_REDIRECT_PATH = '/oauth/callback';

/**
 * Build the default OAuth redirect URI.
 *
 * When running inside a DSW instance (dsw_baseUrl is set), the local
 * callback server is not directly reachable from the user's browser.
 * Instead, traffic arrives through the DSW reverse proxy, so the redirect
 * URI must point to the proxy path:
 *
 *   https://<dsw-base>/proxy/<OAUTH_REDIRECT_PORT><OAUTH_REDIRECT_PATH>
 *
 * dsw_baseUrl is already the DSW base URL, e.g.:
 *   https://dw.aliyun.com/dsw-380036
 *
 * When dsw_baseUrl is not set (local dev), fall back to localhost.
 */
export function getOAuthRedirectUri(): string {
  // 新版，走 bff 代理转发的逻辑
  const bffEndpoint = process.env['BFF_ENDPOINT'];
  const dataAgentInstanceId = process.env['DATA_AGENT_INSTANCE_ID'];
  if (bffEndpoint && dataAgentInstanceId) {
    const bffOAuthProxyPath = '/skwacb/kxuth/';
    return `${bffEndpoint}${bffOAuthProxyPath}${dataAgentInstanceId}${OAUTH_REDIRECT_PATH}`;
  }

  // 兼容旧版 DSW 实例
  const dswBaseUrl = process.env['dsw_baseUrl'];
  if (dswBaseUrl) {
    const base = dswBaseUrl.replace(/\/+$/, '');
    return `${base}/proxy/${OAUTH_REDIRECT_PORT}${OAUTH_REDIRECT_PATH}`;
  }
  return `http://localhost:${OAUTH_REDIRECT_PORT}${OAUTH_REDIRECT_PATH}`;
}
