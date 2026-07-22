/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type GenAiOperationName = 'chat' | 'generate_content';
export type GenAiOutputType = 'text' | 'json' | 'image' | 'speech';
export type GenAiAuthType =
  | 'openai'
  | 'qwen-oauth'
  | 'gemini'
  | 'vertex-ai'
  | 'anthropic';

interface ProviderConfig {
  authType?: GenAiAuthType;
  baseUrl?: string;
  apiKeyEnvKey?: string;
}

const PROVIDER_BY_ENV_KEY: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: 'anthropic',
  BAILIAN_CODING_PLAN_API_KEY: 'dashscope',
  BAILIAN_TOKEN_PLAN_API_KEY: 'dashscope',
  DASHSCOPE_API_KEY: 'dashscope',
  DEEPSEEK_API_KEY: 'deepseek',
  IDEALAB_API_KEY: 'dashscope',
  MINIMAX_API_KEY: 'minimax',
  MIMO_API_KEY: 'mimo',
  MISTRAL_API_KEY: 'mistral_ai',
  MODELSCOPE_API_KEY: 'modelscope',
  OPENAI_API_KEY: 'openai',
  OPENROUTER_API_KEY: 'openrouter',
  REQUESTY_API_KEY: 'requesty',
  XAI_API_KEY: 'x_ai',
  XIAOMI_MIMO_API_KEY: 'mimo',
  ZAI_API_KEY: 'z_ai',
};

function isHostOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function providerFromHostname(hostname: string): string | undefined {
  if (
    isHostOrSubdomain(hostname, 'dashscope.aliyuncs.com') ||
    isHostOrSubdomain(hostname, 'dashscope-intl.aliyuncs.com') ||
    isHostOrSubdomain(hostname, 'dashscope-us.aliyuncs.com') ||
    (hostname.startsWith('token-plan.') &&
      isHostOrSubdomain(hostname, 'maas.aliyuncs.com')) ||
    isHostOrSubdomain(hostname, 'idealab.alibaba-inc.com')
  ) {
    return 'dashscope';
  }
  if (isHostOrSubdomain(hostname, 'deepseek.com')) return 'deepseek';
  if (isHostOrSubdomain(hostname, 'x.ai')) return 'x_ai';
  if (isHostOrSubdomain(hostname, 'mistral.ai')) return 'mistral_ai';
  if (
    isHostOrSubdomain(hostname, 'minimax.io') ||
    isHostOrSubdomain(hostname, 'minimaxi.com')
  ) {
    return 'minimax';
  }
  if (
    isHostOrSubdomain(hostname, 'z.ai') ||
    isHostOrSubdomain(hostname, 'bigmodel.cn')
  ) {
    return 'z_ai';
  }
  if (isHostOrSubdomain(hostname, 'modelscope.cn')) return 'modelscope';
  if (isHostOrSubdomain(hostname, 'xiaomimimo.com')) return 'mimo';
  if (isHostOrSubdomain(hostname, 'openrouter.ai')) return 'openrouter';
  if (isHostOrSubdomain(hostname, 'requesty.ai')) return 'requesty';
  if (isHostOrSubdomain(hostname, 'anthropic.com')) return 'anthropic';
  if (isHostOrSubdomain(hostname, 'openai.com')) return 'openai';
  return undefined;
}

function parsedUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function normalizedEndpoint(value: string | undefined): string | undefined {
  const url = parsedUrl(value);
  if (!url) return undefined;
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  return `${url.protocol}//${url.host}${pathname}${url.search}`;
}

export function resolveGenAiProviderName(
  config: ProviderConfig,
  dashscopeProxyBaseUrl?: string,
): string {
  if (config.authType === 'qwen-oauth') return 'dashscope';

  const baseUrl = normalizedEndpoint(config.baseUrl);
  const proxyUrl = normalizedEndpoint(dashscopeProxyBaseUrl);
  if (baseUrl && proxyUrl && baseUrl === proxyUrl) return 'dashscope';

  const hostname = parsedUrl(config.baseUrl)?.hostname.toLowerCase();
  if (hostname) {
    const provider = providerFromHostname(hostname);
    if (provider) return provider;
  }

  const envProvider = config.apiKeyEnvKey
    ? PROVIDER_BY_ENV_KEY[config.apiKeyEnvKey.toUpperCase()]
    : undefined;
  if (envProvider) return envProvider;

  switch (config.authType) {
    case 'anthropic':
      return 'anthropic';
    case 'gemini':
      return 'gcp.gemini';
    case 'vertex-ai':
      return 'gcp.vertex_ai';
    default:
      return 'openai';
  }
}

export function resolveGenAiOperationName(
  authType: GenAiAuthType | undefined,
): GenAiOperationName {
  return authType === 'gemini' || authType === 'vertex-ai'
    ? 'generate_content'
    : 'chat';
}

export function resolveGenAiOutputType(
  authType: GenAiAuthType | undefined,
  config:
    | {
        responseMimeType?: string;
        responseModalities?: readonly unknown[];
      }
    | undefined,
): GenAiOutputType | undefined {
  if (authType !== 'gemini' && authType !== 'vertex-ai') return undefined;

  const mimeType = config?.responseMimeType
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (mimeType) {
    if (mimeType === 'application/json' || mimeType.endsWith('+json')) {
      return 'json';
    }
    if (mimeType.startsWith('text/')) return 'text';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'speech';
  }

  const modalities = config?.responseModalities;
  if (modalities?.length !== 1) return undefined;
  switch (String(modalities[0]).toUpperCase()) {
    case 'TEXT':
      return 'text';
    case 'IMAGE':
      return 'image';
    case 'AUDIO':
      return 'speech';
    default:
      return undefined;
  }
}
