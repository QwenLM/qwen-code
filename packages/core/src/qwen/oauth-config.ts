/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const QWEN_SUBSCRIPTION_BASE_URL =
  'https://api.qwen.ai/compatible-mode/v1';
export const QWEN_SUBSCRIPTION_MODEL = 'qwen3.8-max';
export const QWEN_SUBSCRIPTION_WEB_SEARCH_URL =
  'https://api.qwen.ai/api/v1/mcp/web_search';
export const QWEN_SUBSCRIPTION_TOKEN_PLACEHOLDER =
  'QWEN_SUBSCRIPTION_DYNAMIC_TOKEN';

export function getQwenOAuthConfig(): {
  baseUrl: string;
  clientId: string;
  webOrigin: string;
} {
  return {
    baseUrl: 'https://auth.qwen.ai',
    clientId: 'qwen-code-cli',
    webOrigin: 'https://chat.qwen.ai',
  };
}

export type QwenChatClient = 'cli' | 'desktop' | 'plugin';

function formatQwenChatUrl(url: URL, client: QwenChatClient): string {
  url.searchParams.set('client', `qwen_code_${client}`);
  return url.toString();
}

export function withQwenChatClient(
  rawUrl: string,
  client: QwenChatClient,
): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (url.origin !== getQwenOAuthConfig().webOrigin) return rawUrl;
  return formatQwenChatUrl(url, client);
}

export function getQwenSubscriptionAuthorizationUrl(
  userCode: string,
  client: QwenChatClient,
): string {
  const url = new URL('/authorize', getQwenOAuthConfig().webOrigin);
  url.searchParams.set('user_code', userCode);
  return formatQwenChatUrl(url, client);
}

export function getQwenSubscriptionPlansUrl(client: QwenChatClient): string {
  const url = new URL('/', getQwenOAuthConfig().webOrigin);
  url.searchParams.set('memberPlan', 'qwen_code');
  return formatQwenChatUrl(url, client);
}
