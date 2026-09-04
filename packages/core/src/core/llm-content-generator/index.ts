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
  const httpOptions = config.baseUrl
    ? {
        headers,
        baseUrl: config.baseUrl,
      }
    : { headers };

  const llmContentGenerator = new LlmContentGenerator(
    {
      apiKey: config.apiKey === '' ? undefined : config.apiKey,
      // Derive Vertex mode from the auth type rather than leaving it to the
      // GOOGLE_GENAI_USE_VERTEXAI side effect: only the CLI pre-flight check
      // writes that variable, and the session boot paths that skip it would
      // otherwise build a client pointed at the Gemini API endpoint. Left
      // undefined for the other auth types so the SDK keeps its own env
      // fallback for them.
      vertexai:
        config.vertexai ??
        (config.authType === AuthType.USE_VERTEX_AI ? true : undefined),
      httpOptions,
    },
    config,
  );

  return llmContentGenerator;
}
