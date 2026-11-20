/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { LlmContentGenerator } from './llm-content-generator.js';
import { AuthType } from '../contentGenerator.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../contentGenerator.js';
import type { Config } from '../../config/config.js';
import { InstallationManager } from '../../config/installationManager.js';

export { LlmContentGenerator } from './llm-content-generator.js';

function isOfficialGeminiBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'generativelanguage.googleapis.com';
  } catch {
    return false;
  }
}

/**
 * Create the Google GenAI-backed LLM content generator.
 */
export function createLlmContentGenerator(
  config: ContentGeneratorConfig,
  gcConfig: Config,
): ContentGenerator {
  const version = process.env['CLI_VERSION'] || process.version;
  const userAgent =
    config.userAgent ||
    `QwenCode/${version} (${process.platform}; ${process.arch})`;
  const baseHeaders: Record<string, string> = {
    'User-Agent': userAgent,
  };

  let headers: Record<string, string> = { ...baseHeaders };
  if (gcConfig?.getUsageStatisticsEnabled()) {
    const installationManager = new InstallationManager();
    const installationId = installationManager.getInstallationId();
    headers = {
      ...headers,
      'x-gemini-api-privileged-user-id': `${installationId}`,
    };
  }
  const hasCustomAuthorization = Object.keys(config.customHeaders ?? {}).some(
    (name) => name.toLowerCase() === 'authorization',
  );
  if (
    config.authType === AuthType.USE_GEMINI &&
    config.apiKey &&
    config.baseUrl &&
    !isOfficialGeminiBaseUrl(config.baseUrl) &&
    !hasCustomAuthorization
  ) {
    // Third-party Gemini-compatible gateways commonly use the same key as
    // Bearer auth. Keep the SDK's x-goog-api-key as well for other proxies.
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }
  const httpOptions = config.baseUrl
    ? {
        headers,
        baseUrl: config.baseUrl,
      }
    : { headers };
  const useVertex = config.authType === AuthType.USE_VERTEX_AI;

  const llmContentGenerator = new LlmContentGenerator(
    {
      apiKey: config.apiKey === '' ? undefined : config.apiKey,
      // Ambient SDK settings and the parent's mode cannot select the protocol
      // of an isolated route. Other callers keep their existing overrides.
      vertexai: config.isolatedRoute
        ? useVertex
        : (config.vertexai ?? (useVertex || undefined)),
      httpOptions,
    },
    config,
    gcConfig,
  );

  return llmContentGenerator;
}
