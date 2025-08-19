/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Azure-specific OpenAI content generator wrapper.
 * Delegates to OpenAIContentGenerator but configures the client with
 * Azure endpoint / deployment / api-version headers and token or key.
 */

import { Config } from '../config/config.js';
import { OpenAIContentGenerator } from './openaiContentGenerator.js';
import OpenAI from 'openai';

/**
 * Separate wrapper so core OpenAI implementation stays provider-agnostic.
 * Token provider support: if AZURE_OPENAI_BEARER_TOKEN is provided we use it
 * via defaultHeaders.Authorization, otherwise we fall back to API key flow.
 */
export class AzureOpenAIContentGenerator extends OpenAIContentGenerator {
  constructor(apiKey: string, model: string, config: Config) {
    // Resolve Azure envs – validated upstream.
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT as string;
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT as string;
    const apiVersion =
      process.env.AZURE_OPENAI_API_VERSION ?? '2024-05-01-preview';

    // If bearer token provided we pass empty apiKey to parent and populate
    // Authorization header later. Passing empty string keeps parent happy.
    const bearer = process.env.AZURE_OPENAI_BEARER_TOKEN;
    super(bearer ? '' : apiKey, model || deployment, config);

    // Override the underlying OpenAI client that super() created.
    // Re-instantiate with Azure-specific URL / headers.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore access protected
    const version = config.getCliVersion() || 'unknown';
    const userAgent = `QwenCode/${version} (${process.platform}; ${process.arch})`;

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore access protected
    this.client = new OpenAI({
      apiKey: bearer ? undefined : apiKey,
      baseURL: `${endpoint}/openai/deployments/${deployment}`,
      defaultQuery: { 'api-version': apiVersion },
      defaultHeaders: {
        'User-Agent': userAgent,
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      timeout: config.getContentGeneratorTimeout() ?? 120_000,
      maxRetries: config.getContentGeneratorMaxRetries() ?? 3,
    });

    // Ensure model equals deployment to satisfy OpenAI SDK requirement.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore model is private in parent but we need correct value
    this.model = deployment;
  }
}
