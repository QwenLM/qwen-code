/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import type { Config } from '../config/config.js';
import { preloadRuntimeFetchModule } from '../utils/runtimeFetchOptions.js';
import { createCopilotTokenManager } from './copilot-auth.js';
import {
  wrapFetchWithCopilotAuth,
  COPILOT_SENTINEL_BASE_URL,
} from './copilot-fetch.js';
import { routeForModel } from './copilot-route.js';

/**
 * Create a Copilot-backed content generator by dispatching to the existing
 * Anthropic / OpenAI Responses / OpenAI Chat generator based on the model
 * slug. The real bearer token and Copilot endpoint are injected per-request
 * by the wrapped fetch (sentinel baseUrl + placeholder apiKey are rewritten
 * at fetch time), so the underlying generators can be reused unchanged.
 */
export async function createCopilotContentGenerator(
  genConfig: ContentGeneratorConfig,
  config: Config,
): Promise<ContentGenerator> {
  const tokenMgr = createCopilotTokenManager();
  const wrappedFetch = wrapFetchWithCopilotAuth(tokenMgr);
  const wire = routeForModel(genConfig.model ?? 'claude-opus-4.7');

  const subConfig: ContentGeneratorConfig = {
    ...genConfig,
    apiKey: 'copilot-capi-bearer-via-fetch',
    baseUrl: COPILOT_SENTINEL_BASE_URL,
    fetch: wrappedFetch,
  };

  // Provider constructors synchronously build undici-backed fetch options;
  // load undici here so it stays out of the eager startup closure
  // (issue #7264), mirroring createContentGenerator.
  await preloadRuntimeFetchModule();

  if (wire === 'messages') {
    const { createAnthropicContentGenerator } = await import(
      '../core/anthropicContentGenerator/index.js'
    );
    return createAnthropicContentGenerator(subConfig, config);
  }

  if (wire === 'responses') {
    const { createOpenAIResponsesContentGenerator } = await import(
      '../core/openaiResponsesContentGenerator/index.js'
    );
    return createOpenAIResponsesContentGenerator(subConfig, config);
  }

  const { createOpenAIContentGenerator } = await import(
    '../core/openaiContentGenerator/index.js'
  );
  return createOpenAIContentGenerator(subConfig, config);
}
