/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { OpenAIContentGenerator } from '../core/openaiContentGenerator.js';
import { IQwenOAuth2Client } from './qwenOAuth2.js';
import { SharedTokenManager } from './sharedTokenManager.js';
import { Config } from '../config/config.js';
import {
  GenerateContentParameters,
  GenerateContentResponse,
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
} from '@google/genai';
import { ContentGeneratorConfig } from '../core/contentGenerator.js';

// Default fallback base URL if no endpoint is provided
const DEFAULT_QWEN_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';

/**
 * Qwen Content Generator that uses Qwen OAuth tokens with automatic refresh
 */
export class QwenContentGenerator extends OpenAIContentGenerator {
  private qwenClient: IQwenOAuth2Client;
  private sharedManager: SharedTokenManager;
  private currentToken?: string;

  constructor(
    qwenClient: IQwenOAuth2Client,
    contentGeneratorConfig: ContentGeneratorConfig,
    config: Config,
  ) {
    // Initialize with empty API key, we'll override it dynamically
    super(contentGeneratorConfig, config);
    this.qwenClient = qwenClient;
    this.sharedManager = SharedTokenManager.getInstance();

    // Set default base URL, will be updated dynamically
    this.client.baseURL = DEFAULT_QWEN_BASE_URL;
  }

  /**
   * Get the current endpoint URL with proper protocol and /v1 suffix
   */
  private getCurrentEndpoint(resourceUrl?: string): string {
    const baseEndpoint = resourceUrl || DEFAULT_QWEN_BASE_URL;
    const suffix = '/v1';

    // Normalize the URL: add protocol if missing, ensure /v1 suffix
    const normalizedUrl = baseEndpoint.startsWith('http')
      ? baseEndpoint
      : `https://${baseEndpoint}`;

    return normalizedUrl.endsWith(suffix)
      ? normalizedUrl
      : `${normalizedUrl}${suffix}`;
  }

  /**
   * Override error logging behavior to suppress auth errors during token refresh
   */
  protected override shouldSuppressErrorLogging(
    error: unknown,
    _request: GenerateContentParameters,
  ): boolean {
    // Suppress logging for authentication errors that we handle with token refresh
    return this.isAuthError(error);
  }

  /**
   * Get valid token and endpoint using the shared token manager
   */
  private async getValidToken(): Promise<{ token: string; endpoint: string }> {
    try {
      // Use SharedTokenManager for consistent token/endpoint pairing and automatic refresh
      const credentials = await this.sharedManager.getValidCredentials(
        this.qwenClient,
      );

      if (!credentials.access_token) {
        throw new Error('No access token available');
      }

      return {
        token: credentials.access_token,
        endpoint: this.getCurrentEndpoint(credentials.resource_url),
      };
    } catch (error) {
      // Propagate auth errors as-is for retry logic
      if (this.isAuthError(error)) {
        throw error;
      }
      console.warn('Failed to get token from shared manager:', error);
      throw new Error(
        'Failed to obtain valid Qwen access token. Please re-authenticate.',
      );
    }
  }

  /**
   * Execute an operation with automatic credential management and retry logic.
   * This method handles:
   * - Dynamic token and endpoint retrieval
   * - Temporary client configuration updates
   * - Automatic restoration of original configuration
   * - Retry logic on authentication errors with token refresh
   *
   * @param operation - The operation to execute with updated client configuration
   * @param restoreOnCompletion - Whether to restore original config after operation completes
   * @returns The result of the operation
   */
  private async executeWithCredentialManagement<T>(
    operation: () => Promise<T>,
    restoreOnCompletion: boolean = true,
  ): Promise<T> {
    // Attempt the operation with credential management and retry logic
    const attemptOperation = async (): Promise<T> => {
      const { token, endpoint } = await this.getValidToken();

      // Store original configuration
      const originalApiKey = this.client.apiKey;
      const originalBaseURL = this.client.baseURL;

      // Apply dynamic configuration
      this.client.apiKey = token;
      this.client.baseURL = endpoint;

      try {
        const result = await operation();

        // For streaming operations, we may need to keep the configuration active
        if (restoreOnCompletion) {
          this.client.apiKey = originalApiKey;
          this.client.baseURL = originalBaseURL;
        }

        return result;
      } catch (error) {
        // Always restore on error
        this.client.apiKey = originalApiKey;
        this.client.baseURL = originalBaseURL;
        throw error;
      }
    };

    // Execute with retry logic for auth errors
    try {
      return await attemptOperation();
    } catch (error) {
      if (this.isAuthError(error)) {
        try {
          // Use SharedTokenManager to properly refresh and persist the token
          // This ensures the refreshed token is saved to oauth_creds.json
          await this.sharedManager.getValidCredentials(this.qwenClient, true);
          // Retry the operation once with fresh credentials
          return await attemptOperation();
        } catch (_refreshError) {
          throw new Error(
            'Failed to obtain valid Qwen access token. Please re-authenticate.',
          );
        }
      }
      throw error;
    }
  }

  /**
   * Override to use dynamic token and endpoint with automatic retry
   */
  override async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    return this.executeWithCredentialManagement(() =>
      super.generateContent(request, userPromptId),
    );
  }

  /**
   * Override to use dynamic token and endpoint with automatic retry.
   * Note: For streaming, the client configuration is not restored immediately
   * since the generator may continue to be used after this method returns.
   */
  override async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    return this.executeWithCredentialManagement(
      () => super.generateContentStream(request, userPromptId),
      false, // Don't restore immediately for streaming
    );
  }

  /**
   * Override to use dynamic token and endpoint with automatic retry
   */
  override async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    return this.executeWithCredentialManagement(() =>
      super.countTokens(request),
    );
  }

  /**
   * Override to use dynamic token and endpoint with automatic retry
   */
  override async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    return this.executeWithCredentialManagement(() =>
      super.embedContent(request),
    );
  }

  /**
   * Check if an error is related to authentication/authorization
   */
  private isAuthError(error: unknown): boolean {
    if (!error) return false;

    const errorMessage =
      error instanceof Error
        ? error.message.toLowerCase()
        : String(error).toLowerCase();

    // Define a type for errors that might have status or code properties
    const errorWithCode = error as {
      status?: number | string;
      code?: number | string;
    };
    const errorCode = errorWithCode?.status || errorWithCode?.code;

    return (
      errorCode === 401 ||
      errorCode === 403 ||
      errorCode === '401' ||
      errorCode === '403' ||
      errorMessage.includes('unauthorized') ||
      errorMessage.includes('forbidden') ||
      errorMessage.includes('invalid api key') ||
      errorMessage.includes('invalid access token') ||
      errorMessage.includes('token expired') ||
      errorMessage.includes('authentication') ||
      errorMessage.includes('access denied') ||
      (errorMessage.includes('token') && errorMessage.includes('expired'))
    );
  }

  /**
   * Get the current cached token (may be expired)
   */
  getCurrentToken(): string | null {
    // First check internal state for backwards compatibility with tests
    if (this.currentToken) {
      return this.currentToken;
    }
    // Fall back to SharedTokenManager
    const credentials = this.sharedManager.getCurrentCredentials();
    return credentials?.access_token || null;
  }

  /**
   * Clear the cached token
   */
  clearToken(): void {
    // Clear internal state for backwards compatibility with tests
    this.currentToken = undefined;
    // Also clear SharedTokenManager
    this.sharedManager.clearCache();
  }
}
