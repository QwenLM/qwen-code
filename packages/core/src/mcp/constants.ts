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
 * The local callback server (localhost:<port>) is not always reachable from
 * the user's browser, so depending on the runtime the redirect URI must point
 * at a reverse proxy instead:
 *
 * 1. BFF proxy (newer Data Agent runtime) — when BFF_ENDPOINT and
 *    DATA_AGENT_INSTANCE_ID are set:
 *      <BFF_ENDPOINT>/skwacb/<segment>/<instanceId><OAUTH_REDIRECT_PATH>
 *    where <segment> is `bxkxuth` for ACS_SANDBOX instances
 *    (DA_RUNTIME_TYPE=ACS_SANDBOX) and `kxuth` otherwise.
 *
 * 2. DSW proxy (legacy) — when dsw_baseUrl is set, e.g.
 *    https://dw.aliyun.com/dsw-380036:
 *      <dsw_baseUrl>/proxy/<OAUTH_REDIRECT_PORT><OAUTH_REDIRECT_PATH>
 *
 * 3. Local dev — neither is set: fall back to localhost.
 */
export function getOAuthRedirectUri(): string {
  // 新版，走 bff 代理转发的逻辑
  const bffEndpoint = process.env['BFF_ENDPOINT'];
  const dataAgentInstanceId = process.env['DATA_AGENT_INSTANCE_ID'];
  if (bffEndpoint && dataAgentInstanceId) {
    // 新版 Data Agent 实例（DA_RUNTIME_TYPE=ACS_SANDBOX）使用 bxkxuth 代理段，
    // 旧实例仍使用 kxuth。
    const proxySegment =
      process.env['DA_RUNTIME_TYPE'] === 'ACS_SANDBOX' ? 'bxkxuth' : 'kxuth';
    const base = bffEndpoint.replace(/\/+$/, '');
    const bffOAuthProxyPath = `/skwacb/${proxySegment}/`;
    return `${base}${bffOAuthProxyPath}${dataAgentInstanceId}${OAUTH_REDIRECT_PATH}`;
  }

  // 兼容旧版 DSW 实例
  const dswBaseUrl = process.env['dsw_baseUrl'];
  if (dswBaseUrl) {
    const base = dswBaseUrl.replace(/\/+$/, '');
    return `${base}/proxy/${OAUTH_REDIRECT_PORT}${OAUTH_REDIRECT_PATH}`;
  }
  return `http://localhost:${OAUTH_REDIRECT_PORT}${OAUTH_REDIRECT_PATH}`;
}
