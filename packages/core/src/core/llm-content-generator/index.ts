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
  const environment = gcConfig.getRuntimeEnvironment();
  const vertexai =
    config.vertexai ?? config.authType === AuthType.USE_VERTEX_AI;
  const usesAdc = vertexai && !config.apiKey;
  const project = usesAdc
    ? (environment['GOOGLE_CLOUD_PROJECT']?.trim() ?? '')
    : '';
  const location = usesAdc
    ? environment['GOOGLE_CLOUD_LOCATION']?.trim() || 'global'
    : '';
  const defaultBaseUrl = !vertexai
    ? 'https://generativelanguage.googleapis.com/'
    : !usesAdc || location === 'global'
      ? 'https://aiplatform.googleapis.com/'
      : location === 'us' || location === 'eu'
        ? `https://aiplatform.${location}.rep.googleapis.com/`
        : `https://${location}-aiplatform.googleapis.com/`;
  const baseUrl =
    config.baseUrl ||
    environment[
      vertexai ? 'GOOGLE_VERTEX_BASE_URL' : 'GOOGLE_GEMINI_BASE_URL'
    ]?.trim() ||
    defaultBaseUrl;

  const llmContentGenerator = new LlmContentGenerator(
    {
      // An explicit ADC project takes precedence over the SDK's ambient key.
      // Other modes use a resolved key and empty project/location values.
      apiKey: usesAdc ? undefined : config.apiKey || '',
      project,
      location,
      vertexai,
      ...(usesAdc
        ? {
            googleAuthOptions: {
              projectId: project,
              keyFilename: environment['GOOGLE_APPLICATION_CREDENTIALS'],
            },
          }
        : {}),
      httpOptions: { headers, baseUrl },
    },
    config,
    gcConfig,
  );

  return llmContentGenerator;
}
