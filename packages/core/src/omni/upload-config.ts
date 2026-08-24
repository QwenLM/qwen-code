/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { ContentGeneratorConfig } from '../core/contentGenerator.js';
import { AuthType } from '../core/contentGenerator.js';
import { DashScopeOpenAICompatibleProvider } from '../core/openaiContentGenerator/provider/dashscope.js';

const QWEN_OAUTH_PLACEHOLDER_API_KEY = 'QWEN_OAUTH_DYNAMIC_TOKEN';
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface OmniUploadConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface RawOmniUploadConfig {
  baseUrl?: string;
  apiKeyEnv?: string;
  model?: string;
}

export class OmniUploadConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OmniUploadConfigError';
  }
}

/**
 * Resolve an explicitly separated upload channel. All-or-nothing validation
 * prevents a typo from silently falling back to inference credentials.
 */
export function normalizeDedicatedOmniUploadConfig(
  raw: RawOmniUploadConfig,
  env: NodeJS.ProcessEnv = process.env,
): OmniUploadConfig | undefined {
  const configured =
    raw.baseUrl !== undefined ||
    raw.apiKeyEnv !== undefined ||
    raw.model !== undefined;
  if (!configured) return undefined;

  const baseUrl = raw.baseUrl?.trim();
  const apiKeyEnv = raw.apiKeyEnv?.trim();
  const model = raw.model?.trim();
  if (!baseUrl || !apiKeyEnv || !model) {
    throw new OmniUploadConfigError(
      'omni.delivery.upload.baseUrl, apiKeyEnv, and model must all be set when a dedicated upload channel is configured.',
    );
  }
  if (!ENV_VAR_NAME_PATTERN.test(apiKeyEnv)) {
    throw new OmniUploadConfigError(
      'omni.delivery.upload.apiKeyEnv must be a valid environment variable name.',
    );
  }
  if (
    !DashScopeOpenAICompatibleProvider.isDashScopeProvider({
      authType: AuthType.USE_OPENAI,
      baseUrl,
    } as ContentGeneratorConfig)
  ) {
    throw new OmniUploadConfigError(
      'omni.delivery.upload.baseUrl must be a DashScope-compatible endpoint.',
    );
  }
  const apiKey = env[apiKeyEnv]?.trim();
  if (!apiKey) {
    throw new OmniUploadConfigError(
      `omni.delivery.upload.apiKeyEnv names ${apiKeyEnv}, but that environment variable is not set or is empty.`,
    );
  }
  return { baseUrl, apiKey, model };
}

function resolveLegacyOmniUploadConfig(
  contentGeneratorConfig: ContentGeneratorConfig | undefined,
  model: string | undefined,
): OmniUploadConfig | undefined {
  if (
    !contentGeneratorConfig ||
    contentGeneratorConfig.authType === AuthType.QWEN_OAUTH ||
    !contentGeneratorConfig.apiKey ||
    contentGeneratorConfig.apiKey === QWEN_OAUTH_PLACEHOLDER_API_KEY ||
    !contentGeneratorConfig.baseUrl ||
    !model ||
    !DashScopeOpenAICompatibleProvider.isDashScopeProvider(
      contentGeneratorConfig,
    )
  ) {
    return undefined;
  }
  return {
    baseUrl: contentGeneratorConfig.baseUrl,
    apiKey: contentGeneratorConfig.apiKey,
    model,
  };
}

/** Dedicated upload settings take precedence; otherwise preserve the original
 * DashScope-inference-as-upload behavior. */
export function getEffectiveOmniUploadConfig(
  config: Config,
): OmniUploadConfig | undefined {
  const dedicated = config.getOmniUploadConfig?.();
  if (dedicated) return dedicated;
  return resolveLegacyOmniUploadConfig(
    config.getContentGeneratorConfig?.(),
    config.getModel?.(),
  );
}

export function requireEffectiveOmniUploadConfig(
  config: Config,
): OmniUploadConfig {
  const upload = getEffectiveOmniUploadConfig(config);
  if (!upload) {
    throw new OmniUploadConfigError(
      'Omni upload is not configured. Set all of omni.delivery.upload.baseUrl, apiKeyEnv, and model, or use a static DashScope inference configuration.',
    );
  }
  return upload;
}
