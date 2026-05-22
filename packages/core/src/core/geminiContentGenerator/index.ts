/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GeminiContentGenerator } from './geminiContentGenerator.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../contentGenerator.js';
import type { Config } from '../../config/config.js';
import { InstallationManager } from '../../utils/installationManager.js';
import { staticCorrelationHeaders } from '../../telemetry/llm-correlation-fetch.js';

export { GeminiContentGenerator } from './geminiContentGenerator.js';

/**
 * Create a Gemini content generator.
 */
export function createGeminiContentGenerator(
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
  // Merge the session-id correlation header. `@google/genai`'s HttpOptions
  // does not expose a `fetch` hook (unlike `openai` / `@anthropic-ai/sdk`),
  // so we can only inject a static header here — captured at construction.
  // Known limitation: after a `/clear`-triggered session reset, the Gemini
  // SDK's cached headers retain the OLD session id until the contentGenerator
  // is recreated. See design doc §8.6 + #4384 follow-up sub-issue tracking.
  //
  // Destination passed in is what the host-allowlist check uses. With the
  // default `DEFAULT_SESSION_ID_HEADER_HOSTS` (Alibaba/DashScope-only),
  // Google's default endpoint `generativelanguage.googleapis.com` is NOT
  // on the list, so the header is naturally omitted for vanilla Gemini API
  // calls — matching the "first-party only" scope. Operators who deliberately
  // want correlation against a Google endpoint can add it via
  // `telemetry.sessionIdHeaderHosts` in settings.
  const destinationUrl =
    config.baseUrl ?? 'https://generativelanguage.googleapis.com';
  headers = {
    ...headers,
    ...staticCorrelationHeaders(gcConfig, destinationUrl),
  };
  const httpOptions = config.baseUrl
    ? {
        headers,
        baseUrl: config.baseUrl,
      }
    : { headers };

  const geminiContentGenerator = new GeminiContentGenerator(
    {
      apiKey: config.apiKey === '' ? undefined : config.apiKey,
      vertexai: config.vertexai,
      httpOptions,
    },
    config,
  );

  return geminiContentGenerator;
}
