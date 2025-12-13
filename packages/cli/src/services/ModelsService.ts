/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AvailableModel } from '../ui/models/availableModels.js';

/**
 * Response format from OpenAI-compatible /v1/models API endpoint
 */
interface OpenAIModelsResponse {
  object: string;
  data: Array<{
    id: string;
    object: string;
    created: number;
    owned_by: string;
  }>;
}

/**
 * Service for fetching available models from OpenAI-compatible API endpoints.
 * Supports any API that implements the OpenAI /v1/models endpoint standard.
 */
export class ModelsService {
  /**
   * Fetch available models from an OpenAI-compatible API endpoint.
   * @param baseUrl The base URL of the OpenAI-compatible API (e.g., http://localhost:8317)
   * @param apiKey The API key for authentication
   * @param timeout Request timeout in milliseconds (default: 5000)
   * @returns Array of available models
   * @throws Error if the request fails or API is unreachable
   */
  async fetchAvailableModels(
    baseUrl: string,
    apiKey: string,
    timeout: number = 5000,
  ): Promise<AvailableModel[]> {
    if (!baseUrl || !apiKey) {
      throw new Error('baseUrl and apiKey are required to fetch models');
    }

    // Normalize baseUrl - remove trailing slash
    const normalizedUrl = baseUrl.replace(/\/$/, '');

    // If baseUrl already ends with /v1, use it as-is, otherwise append /v1
    const modelsEndpoint = normalizedUrl.endsWith('/v1')
      ? `${normalizedUrl}/models`
      : `${normalizedUrl}/v1/models`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(modelsEndpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(
          `Failed to fetch models: ${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as OpenAIModelsResponse;

      if (!Array.isArray(data.data)) {
        throw new Error('Invalid response format: expected data array');
      }

      // Convert OpenAI API response to AvailableModel format
      return data.data.map((model) => ({
        id: model.id,
        label: model.id,
        description: `Model: ${model.id} (owned by ${model.owned_by})`,
      }));
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error(
            `Request timeout: Could not fetch models from ${modelsEndpoint}`,
          );
        }
        throw error;
      }
      throw new Error(`Unknown error while fetching models: ${error}`);
    }
  }

  /**
   * Validate that the provided base URL and API key can reach the models endpoint.
   * @param baseUrl The base URL of the OpenAI-compatible API
   * @param apiKey The API key for authentication
   * @returns true if the endpoint is reachable and valid, false otherwise
   */
  async validateConnection(baseUrl: string, apiKey: string): Promise<boolean> {
    try {
      await this.fetchAvailableModels(baseUrl, apiKey, 3000);
      return true;
    } catch {
      return false;
    }
  }
}
