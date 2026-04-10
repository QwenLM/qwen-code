/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * API Preconnect - 预热 API 连接以减少首次调用的 TCP+TLS 握手延迟
 *
 * 原理：在启动早期发起一个 fire-and-forget HEAD 请求，预热 TCP+TLS 连接。
 * 后续真正的 API 调用复用该连接，节省 100-200ms。
 */

import { createDebugLogger } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('PRECONNECT');

let preconnectFired = false;

/**
 * 默认的 API 基础 URL（按 AuthType 分类）
 */
const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com',
  'qwen-oauth': 'https://coding.dashscope.aliyuncs.com',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  'vertex-ai': 'https://us-central1-aiplatform.googleapis.com',
};

/**
 * 检查是否应该跳过 preconnect
 */
function shouldSkipPreconnect(settings: { baseUrl?: string }): boolean {
  // 1. 检查 proxy 环境变量
  // 注意：如果设置了 NO_PROXY 且目标 URL 在其中，则不需要跳过
  // 但简化处理：只要有 proxy 配置就跳过
  if (
    process.env['HTTPS_PROXY'] ||
    process.env['https_proxy'] ||
    process.env['HTTP_PROXY'] ||
    process.env['http_proxy']
  ) {
    debugLogger.debug('Skipping preconnect: proxy environment variable set');
    return true;
  }

  // 2. 检查自定义 CA 证书（可能使用企业 TLS 检查）
  if (process.env['NODE_EXTRA_CA_CERTS']) {
    debugLogger.debug('Skipping preconnect: custom CA certificate configured');
    return true;
  }

  // 3. 用户显式配置了自定义 baseUrl（可能使用 mTLS 或私有部署）
  if (settings.baseUrl && !isDefaultBaseUrl(settings.baseUrl)) {
    debugLogger.debug(
      'Skipping preconnect: custom baseUrl (may use mTLS or private deployment)',
    );
    return true;
  }

  return false;
}

/**
 * 检查是否在 sandbox 模式下运行
 * sandbox 模式下 preconnect 无效，因为进程会重启
 */
function isInSandboxMode(): boolean {
  return process.env['SANDBOX'] !== undefined;
}

/**
 * 检查是否为默认 baseUrl
 */
function isDefaultBaseUrl(baseUrl: string): boolean {
  const normalized = baseUrl.toLowerCase().replace(/\/+$/, '');
  return Object.values(DEFAULT_BASE_URLS).some((url) =>
    normalized.startsWith(url.toLowerCase()),
  );
}

/**
 * 获取预连接的目标 URL
 * 优先级：settingsBaseUrl > 环境变量 > 默认值
 *
 * 如果设置了自定义 baseUrl（非默认 URL），返回 undefined 表示应该跳过 preconnect
 */
function getPreconnectTargetUrl(
  authType: string | undefined,
  settingsBaseUrl: string | undefined,
): string | undefined {
  // 1. 从 settings 获取
  if (settingsBaseUrl) {
    // 如果是默认 URL，直接使用；否则应该跳过
    if (isDefaultBaseUrl(settingsBaseUrl)) {
      return settingsBaseUrl;
    }
    return undefined;
  }

  // 2. 从环境变量获取
  const envBaseUrl =
    process.env['OPENAI_BASE_URL'] ||
    process.env['ANTHROPIC_BASE_URL'] ||
    process.env['GEMINI_BASE_URL'];
  if (envBaseUrl) {
    // 如果是默认 URL，直接使用；否则应该跳过
    if (isDefaultBaseUrl(envBaseUrl)) {
      return envBaseUrl;
    }
    return undefined;
  }

  // 3. 使用默认值
  if (authType && DEFAULT_BASE_URLS[authType]) {
    return DEFAULT_BASE_URLS[authType];
  }

  return undefined;
}

/**
 * 执行 API 预连接
 * 使用 HEAD 请求建立 TCP+TLS 连接，不发送实际请求体
 *
 * @param authType - 认证类型（openai, qwen-oauth, anthropic 等）
 * @param options - 配置选项
 */
export function preconnectApi(
  authType: string | undefined,
  options: {
    settingsBaseUrl?: string;
  } = {},
): void {
  if (preconnectFired) {
    return;
  }
  preconnectFired = true;

  // 检查是否禁用
  if (process.env['QWEN_CODE_DISABLE_PRECONNECT'] === '1') {
    debugLogger.debug('Preconnect disabled by environment variable');
    return;
  }

  // 检查是否在 sandbox 模式下（进程会重启，preconnect 无效）
  if (isInSandboxMode()) {
    debugLogger.debug('Skipping preconnect: sandbox mode detected');
    return;
  }

  // 检查跳过条件
  if (
    shouldSkipPreconnect({
      baseUrl: options.settingsBaseUrl,
    })
  ) {
    return;
  }

  const targetUrl = getPreconnectTargetUrl(authType, options.settingsBaseUrl);

  if (!targetUrl) {
    debugLogger.debug('No target URL for preconnect');
    return;
  }

  debugLogger.debug(`Preconnecting to: ${targetUrl}`);

  // 使用 AbortSignal.timeout 防止长时间阻塞
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  // 发起 HEAD 请求预热连接（fire-and-forget）
  fetch(targetUrl, {
    method: 'HEAD',
    signal: controller.signal,
    // 不发送任何认证信息
    headers: {
      'User-Agent': 'QwenCode-Preconnect/1.0',
    },
  })
    .then(() => {
      clearTimeout(timeoutId);
      debugLogger.debug('Preconnect completed');
    })
    .catch((error) => {
      clearTimeout(timeoutId);
      // 预连接失败不影响主流程
      debugLogger.debug(`Preconnect failed (ignored): ${error}`);
    });
}

/**
 * 重置 preconnect 状态（仅用于测试）
 */
export function resetPreconnectState(): void {
  preconnectFired = false;
}
